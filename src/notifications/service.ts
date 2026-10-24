import { createHmac } from 'node:crypto';

import { prisma } from '../db.js';
import { recordNotificationDelivery } from '../metrics.js';
import type { NotificationEvent } from './types.js';

const deliveredEventIds = new Set<string>();
const MAX_DELIVERED_EVENT_IDS = 10_000;

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
 * Header carrying an HMAC-SHA256 of the request body, keyed with
 * `NOTIFY_WEBHOOK_SECRET`, so a receiver can tell a real notification from
 * one posted by anybody who happened to learn the webhook URL. Lower-case
 * hex, no prefix. See the "Notification events" section of the README for
 * the receiver-side verification recipe.
 */
const SIGNATURE_HEADER = 'x-streamgive-signature';
const DEFAULT_WEBHOOK_TIMEOUT_MS = 3_000;

function getWebhookTimeoutMs(): number {
  const configured = Number(process.env.NOTIFY_WEBHOOK_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured > 0
    ? Math.min(configured, 2_147_483_647)
    : DEFAULT_WEBHOOK_TIMEOUT_MS;
}

/** Real (if NOTIFY_WEBHOOK_URL is set): POSTs the event as JSON. Node's
 * built-in fetch means this needs no extra dependency. */
async function notifyWebhook(event: NotificationEvent): Promise<boolean> {
  // Deliberately read per call rather than captured at module load: hoisting
  // this to a module-level constant freezes the URL at import time, so a
  // value set (or rotated) later in the process lifetime would be ignored
  // until a restart. test/notifications/service.test.ts guards this.
  const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
  if (!webhookUrl) return true;

  // Serialised once and reused as both the signed input and the request
  // body. Signing a second `JSON.stringify(event)` would work today but
  // couples the signature to key ordering staying identical between two
  // calls — the receiver verifies against the raw bytes it read off the
  // wire, so those bytes are what has to be signed.
  const body = JSON.stringify(event);

  const headers: Record<string, string> = { 'content-type': 'application/json' };

  // Read per call rather than at module load so deployments can rotate the
  // secret without a restart, and so tests can set it per case.
  const secret = process.env.NOTIFY_WEBHOOK_SECRET;
  if (secret) {
    headers[SIGNATURE_HEADER] = createHmac('sha256', secret).update(body).digest('hex');
  }

  let success = false;
  let error: string | undefined;

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(getWebhookTimeoutMs()),
    });

    if (res.ok) {
      success = true;
    } else {
      error = `status ${res.status}`;
      console.error(`webhook notification failed with status ${res.status} for ${webhookUrl}`);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error('webhook notification failed', err);
  }

  recordNotificationDelivery(success ? 'success' : 'failure');

  try {
    await prisma.notificationLog.create({
      data: {
        eventId: success ? event.eventId : null,
        eventType: event.type,
        channel: 'webhook',
        success,
        error,
      },
    });
  } catch (err) {
    console.error('failed to write notification log', err);
  }

  return success;
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

    try {
      const persisted = await prisma.notificationLog.findFirst({
        where: { eventId: event.eventId, success: true },
      });
      if (persisted) {
        rememberDelivered(event.eventId);
        return;
      }
    } catch (err) {
      console.error('failed to check persisted notification delivery', err);
    }
  }

  const [webhookSuccess] = await Promise.all([notifyWebhook(event), notifyEmail(event)]);

  // Mark delivered only after successful delivery
  if (event.eventId && webhookSuccess) {
    rememberDelivered(event.eventId);

    if (!process.env.NOTIFY_WEBHOOK_URL) {
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
