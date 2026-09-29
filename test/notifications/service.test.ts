import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notify } from '../../src/notifications/service.js';
import type { NotificationEvent } from '../../src/notifications/types.js';

describe('notify', () => {
  const originalEnv = process.env.NOTIFY_WEBHOOK_URL;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env.NOTIFY_WEBHOOK_URL = originalEnv;
  });

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
});
