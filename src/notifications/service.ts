import type { NotificationEvent } from './types.js';

const deliveredEventIds = new Set<string>();
const MAX_DELIVERED_EVENT_IDS = 10_000;

/** Real (if NOTIFY_WEBHOOK_URL is set): POSTs the event as JSON. Node's
 * built-in fetch means this needs no extra dependency. */
async function notifyWebhook(event: NotificationEvent): Promise<void> {
  // Deliberately read per call rather than captured at module load: hoisting
  // this to a module-level constant freezes the URL at import time, so a
  // value set (or rotated) later in the process lifetime would be ignored
  // until a restart. test/notifications/service.test.ts guards this.
  const webhookUrl = process.env.NOTIFY_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      console.error(`webhook notification failed with status ${response.status} for ${webhookUrl}`);
    }
  } catch (err) {
    console.error('webhook notification failed', err);
  }
}

/** Stub: no email provider wired up yet — picking one (SendGrid, Postmark,
 * Resend, ...) is a separate decision. `notify()` below is the only thing
 * the rest of the app calls, so swapping this out later touches no call
 * sites. */
async function notifyEmail(event: NotificationEvent): Promise<void> {
  console.log('[notify:email:stub]', event);
}

export async function notify(event: NotificationEvent): Promise<void> {
  if (event.eventId && deliveredEventIds.has(event.eventId)) return;
  if (event.eventId) {
    deliveredEventIds.add(event.eventId);
    if (deliveredEventIds.size > MAX_DELIVERED_EVENT_IDS) {
      const oldest = deliveredEventIds.values().next().value;
      if (oldest) deliveredEventIds.delete(oldest);
    }
  }
  await Promise.all([notifyWebhook(event), notifyEmail(event)]);
}
