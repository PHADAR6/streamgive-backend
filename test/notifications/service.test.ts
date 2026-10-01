import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notify } from '../../src/notifications/service.js';
import type { NotificationEvent } from '../../src/notifications/types.js';

describe('notify', () => {
  const originalEnv = process.env.NOTIFY_WEBHOOK_URL;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.NOTIFY_WEBHOOK_URL;
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
  });

  const okResponse = () => new Response(null, { status: 200 });

  it('logs status code and URL when webhook returns a non-2xx response (500)', async () => {
    const webhookUrl = 'http://example.com/webhook';
    process.env.NOTIFY_WEBHOOK_URL = webhookUrl;

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500, statusText: 'Internal Server Error' }),
    );

    const event: NotificationEvent = {
      type: 'stream_created',
      streamId: '1',
      donorAddress: 'GDONOR',
      ngoId: 'NGO1',
    };

    await notify(event);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringMatching(/500.*http:\/\/example\.com\/webhook/),
    );
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
});
