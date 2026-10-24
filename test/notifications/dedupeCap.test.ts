import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Prisma is mocked so this runs in the unit project: no database needed to
// fill the de-duplication set past its cap.
const findFirst = vi.fn();
const create = vi.fn();
vi.mock('../../src/db.js', () => ({
  prisma: { notificationLog: { findFirst, create } },
}));

const {
  _MAX_DELIVERED_EVENT_IDS_FOR_TEST: CAP,
  _deliveredEventIdCountForTest: deliveredCount,
  _resetDeliveredEventIdsForTest,
  notify,
} = await import('../../src/notifications/service.js');

import type { NotificationEvent } from '../../src/notifications/types.js';

const eventWithId = (n: number): NotificationEvent => ({
  type: 'ngo_approved',
  ownerAddress: 'GOWNER',
  ngoId: 'NGO1',
  eventId: `evt-${n}`,
});

describe('notify de-duplication cap', () => {
  const originalUrl = process.env.NOTIFY_WEBHOOK_URL;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetDeliveredEventIdsForTest();
    findFirst.mockReset().mockResolvedValue(null);
    create.mockReset().mockResolvedValue({});
    process.env.NOTIFY_WEBHOOK_URL = 'http://example.com/webhook';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.NOTIFY_WEBHOOK_URL;
    else process.env.NOTIFY_WEBHOOK_URL = originalUrl;
  });

  const fill = async (count: number) => {
    for (let i = 0; i < count; i += 1) await notify(eventWithId(i));
  };

  it('stays bounded at the cap when more ids are delivered than it holds', async () => {
    await fill(CAP + 50);

    expect(deliveredCount()).toBe(CAP);
  });

  it('evicts the oldest ids first and keeps the newest', async () => {
    await fill(CAP + 1); // evt-0 is evicted
    fetchSpy.mockClear();

    await notify(eventWithId(CAP)); // newest: still remembered, not resent
    expect(fetchSpy).not.toHaveBeenCalled();

    await notify(eventWithId(0)); // oldest: forgotten, delivered again
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still delivers the event that triggers an eviction', async () => {
    await fill(CAP);
    fetchSpy.mockClear();

    await expect(notify(eventWithId(CAP))).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(deliveredCount()).toBe(CAP);
  });

  it('keeps delivering after many evictions without throwing', async () => {
    await expect(fill(CAP + 200)).resolves.toBeUndefined();
    fetchSpy.mockClear();

    await notify(eventWithId(CAP + 200));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('stays bounded when ids are recovered from the persisted delivery log', async () => {
    await fill(CAP);
    findFirst.mockResolvedValue({ id: 1 }); // every later id was delivered before a restart

    for (let i = CAP; i < CAP + 25; i += 1) await notify(eventWithId(i));

    expect(deliveredCount()).toBe(CAP);
  });
});
