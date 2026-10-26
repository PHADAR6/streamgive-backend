import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import {
  _resetDeliveredEventIdsForTest,
  notify,
  processPendingWebhookDeliveries,
} from '../../src/notifications/service.js';
import type { NotificationEvent } from '../../src/notifications/types.js';
import { resetDb } from '../helpers/db.js';

const event: NotificationEvent = {
  type: 'stream_created',
  streamId: '1',
  donorAddress: 'GDONOR',
  ngoId: 'NGO1',
};

describe('notify', () => {
  const originalEnv = process.env.NOTIFY_WEBHOOK_URL;
  const originalSecret = process.env.NOTIFY_WEBHOOK_SECRET;
  const originalTimeout = process.env.NOTIFY_WEBHOOK_TIMEOUT_MS;

  beforeEach(async () => {
    vi.restoreAllMocks();
    _resetDeliveredEventIdsForTest();
    await resetDb();
    delete process.env.NOTIFY_WEBHOOK_URL;
    delete process.env.NOTIFY_WEBHOOK_TIMEOUT_MS;
    // Unset by default so the signing cases opt in explicitly and a stray
    // value in the developer's own .env can't make them pass for free.
    delete process.env.NOTIFY_WEBHOOK_SECRET;
  });

  afterEach(() => {
    // Assigning `undefined` to a process.env key stores the string
    // "undefined" rather than unsetting it, so delete instead when the var
    // was originally absent.
    if (originalEnv === undefined) {
      delete process.env.NOTIFY_WEBHOOK_URL;
    } else {
      process.env.NOTIFY_WEBHOOK_URL = originalEnv;
    }

    if (originalSecret === undefined) {
      delete process.env.NOTIFY_WEBHOOK_SECRET;
    } else {
      process.env.NOTIFY_WEBHOOK_SECRET = originalSecret;
    }

    if (originalTimeout === undefined) {
      delete process.env.NOTIFY_WEBHOOK_TIMEOUT_MS;
    } else {
      process.env.NOTIFY_WEBHOOK_TIMEOUT_MS = originalTimeout;
    }
  });

  const okResponse = () => new Response(null, { status: 200 });

  it('logs status code and URL when webhook returns a non-2xx response (500)', async () => {
    const webhookUrl = 'http://example.com/webhook';
    process.env.NOTIFY_WEBHOOK_URL = webhookUrl;

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    );

    await notify(event);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/500.*http:\/\/example\.com\/webhook/),
    );
  });

  it('does not throw or block notify when the webhook request rejects', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'https://example.com/webhook';

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failedEvent: NotificationEvent = {
      type: 'ngo_revoked',
      ownerAddress: 'G1234567890',
      ngoId: 'ngo-123',
    };

    await expect(notify(failedEvent)).resolves.not.toThrow();
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('writes a failure record when webhook returns non-2xx', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    );

    await notify(event);

    const log = await prisma.notificationLog.findFirst({
      where: { channel: 'webhook', success: false },
    });
    expect(log).not.toBeNull();
    expect(log?.eventType).toBe('stream_created');
    expect(log?.error).toMatch(/500/);
  });

  it('writes a success record when webhook returns 2xx', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

    await notify(event);

    const log = await prisma.notificationLog.findFirst({
      where: { channel: 'webhook', success: true },
    });
    expect(log).not.toBeNull();
    expect(log?.eventType).toBe('stream_created');
  });

  it('aborts a webhook that does not respond within the configured timeout', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
    process.env.NOTIFY_WEBHOOK_TIMEOUT_MS = '5';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('expected webhook request to have an abort signal'));
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

    await expect(notify(event)).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://example.com/webhook',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const [, request] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(request.signal?.aborted).toBe(true);
  });

  it('writes an email record on every notify call', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await notify(event);

    const log = await prisma.notificationLog.findFirst({ where: { channel: 'email' } });
    expect(log).not.toBeNull();
    expect(log?.success).toBe(true);
  });

  it('fires the webhook at a URL set after the module was imported', async () => {
    // Regression guard: NOTIFY_WEBHOOK_URL used to be read into a module-level
    // constant, so a value set after import was ignored for the process
    // lifetime. The import at the top of this file has already run by now.
    const webhookUrl = 'http://example.com/set-after-import';
    process.env.NOTIFY_WEBHOOK_URL = webhookUrl;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());

    const event: NotificationEvent = {
      type: 'stream_created',
      streamId: '1',
      donorAddress: 'GDONOR',
      ngoId: 'NGO1',
    };

    await notify(event);

    expect(fetchSpy).toHaveBeenCalledWith(
      webhookUrl,
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      }),
    );
  });

  it('fans an event out only to enabled endpoints subscribed to its type', async () => {
    await prisma.notificationEndpoint.createMany({
      data: [
        {
          url: 'https://one.example/webhook',
          secret: 'one-secret',
          eventTypes: ['stream_created'],
        },
        {
          url: 'https://two.example/webhook',
          secret: 'two-secret',
          eventTypes: ['ngo_approved'],
        },
        {
          url: 'https://disabled.example/webhook',
          secret: 'unused-secret',
          eventTypes: ['stream_created'],
          enabled: false,
        },
      ],
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());

    await notify({ ...event, eventId: 'fanout-event-1' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://one.example/webhook',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ ...event, eventId: 'fanout-event-1' }) }),
    );
    const log = await prisma.notificationLog.findFirst({
      where: { eventId: 'fanout-event-1', channel: { startsWith: 'webhook:' }, success: true },
    });
    expect(log).not.toBeNull();
  });

  it('picks up a rotated NOTIFY_WEBHOOK_URL on the next call', async () => {
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/first';

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());

    const event: NotificationEvent = {
      type: 'stream_withdrawn',
      streamId: '1',
      amount: '10',
    };

    await notify(event);
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/second';
    await notify(event);

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      'http://example.com/first',
      'http://example.com/second',
    ]);
  });

  it('skips the webhook when NOTIFY_WEBHOOK_URL is unset', async () => {
    delete process.env.NOTIFY_WEBHOOK_URL;

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse());

    await notify({
      type: 'stream_cancelled',
      streamId: '1',
      settledToNgo: '5',
      refundToDonor: '5',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('delivery deduplication and retry (#270)', () => {
    it('retries delivery when a previous send attempt failed', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // First call fails with 500 error
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));

      const retryEvent: NotificationEvent = {
        type: 'stream_created',
        streamId: '1',
        donorAddress: 'GDONOR',
        ngoId: 'NGO1',
        eventId: 'event-retry-123',
      };

      await notify(retryEvent);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // On retry, it should try sending again because the first attempt failed
      await notify(retryEvent);
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // On duplicate call after successful delivery, it should not send again
      await notify(retryEvent);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('persists delivery across process restarts so already-delivered events are not resent', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 200 }));

      const restartEvent: NotificationEvent = {
        type: 'stream_created',
        streamId: '2',
        donorAddress: 'GDONOR2',
        ngoId: 'NGO2',
        eventId: 'event-restart-456',
      };

      // Successfully delivers on first try
      await notify(restartEvent);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Verify delivery record was persisted in database
      const log = await prisma.notificationLog.findFirst({
        where: { eventId: restartEvent.eventId, success: true },
      });
      expect(log).not.toBeNull();

      // Simulate process restart by clearing the in-memory deduplication set
      _resetDeliveredEventIdsForTest();

      // On re-delivery attempt after restart, it checks persisted database log and skips
      await notify(restartEvent);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('persisted webhook retry outbox', () => {
    async function makeDeliveryDue(eventId: string): Promise<void> {
      await prisma.webhookDelivery.update({
        where: { eventId },
        data: { nextAttemptAt: new Date(0) },
      });
    }

    it('retries a receiver that fails twice and then succeeds', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      const retryEvent = { ...event, eventId: 'event-outbox-retry' };

      await notify(retryEvent);
      await makeDeliveryDue(retryEvent.eventId);
      await processPendingWebhookDeliveries();
      await makeDeliveryDue(retryEvent.eventId);
      await processPendingWebhookDeliveries();

      const delivery = await prisma.webhookDelivery.findUnique({
        where: { eventId: retryEvent.eventId },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(delivery).toMatchObject({ attempts: 3, status: 'DELIVERED', lastError: null });
    });

    it('marks a delivery failed after the maximum number of attempts', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 500 }));
      const retryEvent = { ...event, eventId: 'event-outbox-give-up' };

      await notify(retryEvent);
      for (let attempt = 1; attempt < 5; attempt += 1) {
        await makeDeliveryDue(retryEvent.eventId);
        await processPendingWebhookDeliveries();
      }

      const delivery = await prisma.webhookDelivery.findUnique({
        where: { eventId: retryEvent.eventId },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(5);
      expect(delivery).toMatchObject({ attempts: 5, status: 'FAILED' });

      await processPendingWebhookDeliveries();
      expect(fetchSpy).toHaveBeenCalledTimes(5);
    });
  });

  describe('webhook signature', () => {
    const event: NotificationEvent = {
      type: 'stream_created',
      streamId: '1',
      donorAddress: 'GDONOR',
      ngoId: 'NGO1',
    };

    /** Captures the single fetch the webhook notifier makes. */
    function captureWebhookRequest() {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status: 204 }));
      vi.spyOn(console, 'log').mockImplementation(() => {});
      return fetchSpy;
    }

    it('signs the timestamp, delivery ID, and body with a versioned HMAC-SHA256', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      process.env.NOTIFY_WEBHOOK_SECRET = 'a-shared-secret';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const body = init.body as string;

      // Recomputed here from the secret and the bytes actually sent, rather
      // than compared against a hard-coded digest — that way the assertion
      // stays true if the payload shape changes, and still fails if the
      // service ever signs something other than what it transmits.
      const timestamp = headers['x-streamgive-timestamp'];
      const deliveryId = headers['x-streamgive-delivery'];
      const expected = `v1=${createHmac('sha256', 'a-shared-secret')
        .update(`${timestamp}.${deliveryId}.${body}`)
        .digest('hex')}`;

      expect(timestamp).toMatch(/^\d+$/);
      expect(deliveryId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(headers['x-streamgive-signature']).toBe(expected);
    });

    it('signs the exact bytes sent as the body, not a re-serialisation', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      process.env.NOTIFY_WEBHOOK_SECRET = 'a-shared-secret';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const signature = headers['x-streamgive-signature'];

      // A receiver only ever has the raw body — this is that verification,
      // done the way the README tells integrators to do it.
      const verified = `v1=${createHmac('sha256', 'a-shared-secret')
        .update(
          `${headers['x-streamgive-timestamp']}.${headers['x-streamgive-delivery']}.${Buffer.from(
            init.body as string,
            'utf8',
          ).toString('utf8')}`,
        )
        .digest('hex')}`;

      expect(signature).toBe(verified);
      expect(JSON.parse(init.body as string)).toEqual(event);
    });

    it('rejects a tampered body: the signature no longer matches', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
      process.env.NOTIFY_WEBHOOK_SECRET = 'a-shared-secret';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;

      const forged = JSON.stringify({ ...event, ngoId: 'ATTACKER-NGO' });
      const forgedDigest = `v1=${createHmac('sha256', 'a-shared-secret')
        .update(
          `${headers['x-streamgive-timestamp']}.${headers['x-streamgive-delivery']}.${forged}`,
        )
        .digest('hex')}`;

      expect(forgedDigest).not.toBe(headers['x-streamgive-signature']);
    });

    it('omits the signature header when no secret is configured', async () => {
      process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';

      const fetchSpy = captureWebhookRequest();

      await notify(event);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;

      expect(headers['x-streamgive-signature']).toBeUndefined();
      expect(headers['content-type']).toBe('application/json');
      expect(headers['x-streamgive-timestamp']).toMatch(/^\d+$/);
      expect(headers['x-streamgive-delivery']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });
  });
});
