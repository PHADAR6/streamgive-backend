import { createHmac, randomUUID } from 'node:crypto';

import { prisma } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import { recordNotificationDelivery } from '../metrics.js';
import type { NotificationEvent } from './types.js';

const deliveredEventIds = new Set<string>();
const MAX_DELIVERED_EVENT_IDS = 10_000;
const MAX_WEBHOOK_ATTEMPTS = 5;
const WEBHOOK_RETRY_BASE_MS = 1_000;
const WEBHOOK_RETRY_MAX_MS = 5 * 60_000;
const WEBHOOK_DELIVERY_LOCK_MS = 60_000;
const WEBHOOK_DELIVERY_POLL_MS = 1_000;

export function _resetDeliveredEventIdsForTest(): void {
  deliveredEventIds.clear();
}

export function _deliveredEventIdCountForTest(): number {
  return deliveredEventIds.size;
}

export const _MAX_DELIVERED_EVENT_IDS_FOR_TEST = MAX_DELIVERED_EVENT_IDS;

/** Remembers a delivered event id, evicting the oldest ids past the cap. */
function rememberDelivered(eventId: string): void {
  deliveredEventIds.add(eventId);
  while (deliveredEventIds.size > MAX_DELIVERED_EVENT_IDS) {
    const oldest = deliveredEventIds.values().next().value;
    if (oldest === undefined) break;
    deliveredEventIds.delete(oldest);
  }
}

/**
 * Header carrying a versioned HMAC-SHA256 of the timestamp, delivery ID,
 * and request body, keyed with `NOTIFY_WEBHOOK_SECRET`. See the
 * "Notification events" section of the README for receiver verification.
 */
const SIGNATURE_HEADER = 'x-streamgive-signature';
const TIMESTAMP_HEADER = 'x-streamgive-timestamp';
const DELIVERY_HEADER = 'x-streamgive-delivery';
const DEFAULT_WEBHOOK_TIMEOUT_MS = 3_000;

type WebhookTarget = { url: string; secret?: string; channel: string };
type WebhookResult = { success: boolean; recordNoop: boolean };

function webhookLocation(target: WebhookTarget): string {
  if (target.channel === 'webhook') return target.url;
  try {
    return new URL(target.url).origin;
  } catch {
    return '[invalid-url]';
  }
}

function getWebhookTimeoutMs(): number {
  const configured = Number(process.env.NOTIFY_WEBHOOK_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 2_147_483_647)
    : DEFAULT_WEBHOOK_TIMEOUT_MS;
}

/** Posts one event to a configured destination. */
async function notifyWebhookTarget(
  event: NotificationEvent,
  target: WebhookTarget,
): Promise<boolean> {
  if (event.eventId) {
    try {
      const delivered = await prisma.notificationLog.findFirst({
        where: { eventId: event.eventId, channel: target.channel, success: true },
      });
      if (delivered) return true;
    } catch (error) {
      console.error('failed to check persisted endpoint delivery', error);
      return false;
    }
  }

  // Serialised once and reused as both the signed input and the request
  // body. Signing a second `JSON.stringify(event)` would work today but
  // couples the signature to key ordering staying identical between two
  // calls — the receiver verifies against the raw bytes it read off the
  // wire, so those bytes are what has to be signed.
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestDeliveryId = deliveryId ?? randomUUID();

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [TIMESTAMP_HEADER]: timestamp,
    [DELIVERY_HEADER]: requestDeliveryId,
  };

  // Read per call rather than at module load so deployments can rotate the
  // secret without a restart, and so tests can set it per case.
  const secret = target.secret;
  if (secret) {
    const signedPayload = `${timestamp}.${requestDeliveryId}.${body}`;
    headers[SIGNATURE_HEADER] =
      `v1=${createHmac('sha256', secret).update(signedPayload).digest('hex')}`;
  }

  let success = false;
  let error: string | undefined;

  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(getWebhookTimeoutMs()),
    });

    if (res.ok) {
      success = true;
    } else {
      error = `status ${res.status}`;
      console.error(
        `webhook notification failed with status ${res.status} for ${webhookLocation(target)}`,
      );
    }
  } catch (err) {
    error = err instanceof Error ? err.name : 'unknown_error';
    console.error('webhook notification failed');
  }

  recordNotificationDelivery(success ? 'success' : 'failure');

  try {
    const data = {
      eventId: event.eventId ?? null,
      eventType: event.type,
      channel: target.channel,
      success,
      error,
    };
    if (event.eventId) {
      await prisma.notificationLog.upsert({
        where: { eventId_channel: { eventId: event.eventId, channel: target.channel } },
        create: data,
        update: { success, error },
      });
    } else {
      await prisma.notificationLog.create({ data });
    }
  } catch (err) {
    console.error('failed to write notification log', err);
  }

  return success;
}

/** Delivers to every enabled endpoint subscribed to the event. */
async function notifyWebhook(event: NotificationEvent): Promise<WebhookResult> {
  let endpoints: Awaited<ReturnType<typeof prisma.notificationEndpoint.findMany>>;
  try {
    endpoints = await prisma.notificationEndpoint.findMany({ where: { enabled: true } });
  } catch (error) {
    console.error('failed to load webhook endpoints', error);
    return { success: false, recordNoop: false };
  }

  const configured = endpoints.length > 0;
  const targets: WebhookTarget[] = endpoints
    .filter((endpoint) => endpoint.eventTypes.includes(event.type))
    .map((endpoint) => ({
      url: endpoint.url,
      secret: endpoint.secret,
      channel: `webhook:${endpoint.id}`,
    }));

  // Keep the original single-endpoint environment configuration working for
  // existing deployments until they migrate destinations into the table.
  if (!configured && process.env.NOTIFY_WEBHOOK_URL) {
    targets.push({
      url: process.env.NOTIFY_WEBHOOK_URL,
      secret: process.env.NOTIFY_WEBHOOK_SECRET,
      channel: 'webhook',
    });
  }

  if (targets.length === 0) {
    return { success: true, recordNoop: !configured };
  }

  const results = await Promise.all(targets.map((target) => notifyWebhookTarget(event, target)));
  return { success: results.every(Boolean), recordNoop: false };
}

/** Stub: no email provider wired up yet — picking one (SendGrid, Postmark,
 * Resend, ...) is a separate decision. `notify()` below is the only thing
 * the rest of the app calls, so swapping this out later touches no call
 * sites. */
async function notifyEmail(event: NotificationEvent): Promise<void> {
  console.log('[notify:email:stub]', event);

  try {
    await prisma.notificationLog.create({
      data: {
        eventType: event.type,
        channel: 'email',
        success: true,
      },
    });
  } catch (err) {
    console.error('failed to write email notification log', err);
  }
}

export async function notify(event: NotificationEvent): Promise<void> {
  if (event.eventId) {
    if (deliveredEventIds.has(event.eventId)) return;
  }

  const [webhookResult] = await Promise.all([notifyWebhook(event), notifyEmail(event)]);

  // Mark delivered only after successful delivery
  if (event.eventId && webhookResult.success) {
    rememberDelivered(event.eventId);

    if (webhookResult.recordNoop) {
      try {
        await prisma.notificationLog.create({
          data: {
            eventId: event.eventId,
            eventType: event.type,
            channel: 'webhook',
            success: true,
          },
        });
      } catch (err) {
        console.error('failed to persist delivery record', err);
      }
    }
  }
}

/**
 * Dispatches a notification asynchronously after transaction commit,
 * ensuring any errors are caught and do not propagate back into the handler
 * or block the indexer.
 */
export function dispatchNotification(event: NotificationEvent): void {
  notify(event).catch((err) => {
    console.error('asynchronous notification dispatch failed', err);
  });
}
