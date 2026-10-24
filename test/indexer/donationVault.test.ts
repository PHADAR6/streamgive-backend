import { xdr } from '@stellar/stellar-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/notifications/service.js', () => ({ dispatchNotification: vi.fn() }));

import { prisma } from '../../src/db.js';
import { handleDonationVaultEvent } from '../../src/indexer/handlers/donationVault.js';
import { handleNgoRegistryEvent } from '../../src/indexer/handlers/ngoRegistry.js';
import { logger } from '../../src/logger.js';
import { dispatchNotification } from '../../src/notifications/service.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import {
  addressScVal,
  i128ScVal,
  makeEvent,
  stringScVal,
  symbolScVal,
  u64ScVal,
} from '../helpers/events.js';

describe('handleDonationVaultEvent', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(dispatchNotification).mockClear();
    await resetDb();
  });

  it('creates a stream (and placeholder donor/ngo rows) on a created event', async () => {
    const donor = fakeAddress('A');
    const ngo = fakeAddress('B');
    const token = fakeAddress('C');

    const closedAt = '2024-01-15T12:00:00.000Z';
    const txHash = 'b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4';
    const event = makeEvent(
      [symbolScVal('created'), u64ScVal(1n)],
      xdr.ScVal.scvVec([
        addressScVal(donor),
        addressScVal(ngo),
        addressScVal(token),
        i128ScVal(1000n),
        i128ScVal(10n),
      ]),
      { ledgerClosedAt: closedAt, txHash },
    );

    await handleDonationVaultEvent(event);

    const stream = await prisma.stream.findUnique({ where: { onChainId: 1n } });
    expect(stream?.balance).toBe('1000');
    expect(stream?.rate).toBe('10');
    expect(stream?.withdrawn).toBe('0');
    expect(stream?.status).toBe('ACTIVE');
    expect(stream?.createdAt.toISOString()).toBe(new Date(closedAt).toISOString());
    expect(stream?.createdTxHash).toBe(txHash);

    expect(await prisma.donor.findUnique({ where: { address: donor } })).not.toBeNull();

    // Never went through ngo-registry — placeholder, unverified.
    const ngoRow = await prisma.ngo.findUniqueOrThrow({ where: { ownerAddress: ngo } });
    expect(ngoRow?.verified).toBe(false);
    expect(dispatchNotification).toHaveBeenCalledWith({
      type: 'stream_created',
      eventId: event.id,
      streamId: '1',
      donorAddress: donor,
      ngoId: ngoRow.id,
    });

    // A StreamEvent row must be written atomically with the stream upsert.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'created' } });
    expect(streamEvent).not.toBeNull();
    expect(streamEvent?.streamId).toBe(1n);
    expect(streamEvent?.ledger).toBe(100);
    expect(streamEvent?.txHash).toBe(txHash);
    expect(streamEvent?.payload).toMatchObject({
      deposit: '1000',
      rate: '10',
    });
  });

  it('preserves a registered and verified NGO name on a created event', async () => {
    const donor = fakeAddress('M');
    const ngo = fakeAddress('N');
    const token = fakeAddress('O');
    const registeredName = 'Doctors Without Borders';

    await handleNgoRegistryEvent(
      makeEvent([symbolScVal('register'), addressScVal(ngo)], stringScVal(registeredName)),
    );
    await handleNgoRegistryEvent(
      makeEvent([symbolScVal('approved'), addressScVal(ngo)], stringScVal('')),
    );

    await handleDonationVaultEvent(
      makeEvent(
        [symbolScVal('created'), u64ScVal(5n)],
        xdr.ScVal.scvVec([
          addressScVal(donor),
          addressScVal(ngo),
          addressScVal(token),
          i128ScVal(1000n),
          i128ScVal(10n),
        ]),
      ),
    );

    const ngoRow = await prisma.ngo.findUnique({ where: { ownerAddress: ngo } });
    expect(ngoRow?.name).toBe(registeredName);
    expect(ngoRow?.verified).toBe(true);
  });

  it('applies a withdraw event as a balance/withdrawn delta', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('D') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('E'), name: 'NGO E' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 2n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('F'),
        rate: '10',
        balance: '1000',
        withdrawn: '0',
      },
    });

    await handleDonationVaultEvent(
      makeEvent([symbolScVal('withdraw'), u64ScVal(2n)], i128ScVal(500n)),
    );

    const stream = await prisma.stream.findUnique({ where: { onChainId: 2n } });
    expect(stream?.balance).toBe('500');
    expect(stream?.withdrawn).toBe('500');

    // A StreamEvent row must be written atomically with the stream update.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'withdraw' } });
    expect(streamEvent).not.toBeNull();
    expect(streamEvent?.streamId).toBe(2n);
    expect(streamEvent?.ledger).toBe(100);
    expect(streamEvent?.payload).toMatchObject({ accrued: '500' });
  });

  it('sets updatedAt from the on-chain ledger close time on a withdraw event', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('D2') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('E2'), name: 'NGO E2' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 20n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('F2'),
        rate: '10',
        balance: '1000',
        withdrawn: '0',
      },
    });

    const onChainTime = '2024-03-10T08:00:00.000Z';
    const event = makeEvent([symbolScVal('withdraw'), u64ScVal(20n)], i128ScVal(200n), {
      ledgerClosedAt: onChainTime,
    });
    await handleDonationVaultEvent(event);

    const stream = await prisma.stream.findUnique({ where: { onChainId: 20n } });
    expect(stream?.updatedAt.toISOString()).toBe(new Date(onChainTime).toISOString());
  });

  it('clamps the balance to zero when accrued exceeds the recorded balance', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('M') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('N'), name: 'NGO N' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 5n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('O'),
        rate: '10',
        balance: '400',
        withdrawn: '100',
      },
    });

    await handleDonationVaultEvent(
      makeEvent([symbolScVal('withdraw'), u64ScVal(5n)], i128ScVal(500n)),
    );

    const stream = await prisma.stream.findUnique({ where: { onChainId: 5n } });
    expect(stream?.balance).toBe('0');
    expect(stream?.withdrawn).toBe('600');
    expect(warn).toHaveBeenCalledWith(
      { onChainId: '5', balance: '400', accrued: '500' },
      'withdraw exceeds recorded stream balance',
    );
  });

  it('applies a cancel event: settles accrued, zeroes balance/rate, marks cancelled', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('G') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('H'), name: 'NGO H' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 3n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('I'),
        rate: '10',
        balance: '1000',
        withdrawn: '200',
      },
    });

    const event = makeEvent(
      [symbolScVal('cancel'), u64ScVal(3n)],
      xdr.ScVal.scvVec([i128ScVal(300n), i128ScVal(700n)]),
    );
    await handleDonationVaultEvent(event);

    const stream = await prisma.stream.findUnique({ where: { onChainId: 3n } });
    expect(stream?.balance).toBe('0');
    expect(stream?.rate).toBe('0');
    expect(stream?.lastRate).toBe('10'); // original rate preserved from before cancel
    expect(stream?.withdrawn).toBe('500'); // 200 already withdrawn + 300 settled on cancel
    expect(stream?.status).toBe('CANCELLED');

    // A StreamEvent row must be written atomically with the stream update.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'cancel' } });
    expect(streamEvent).not.toBeNull();
    expect(streamEvent?.streamId).toBe(3n);
    expect(streamEvent?.ledger).toBe(100);
    expect(streamEvent?.payload).toMatchObject({ accrued: '300', refund: '700' });
  });

  it('sets updatedAt from the on-chain ledger close time on a cancel event', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('G2') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('H2'), name: 'NGO H2' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 30n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('I2'),
        rate: '10',
        balance: '1000',
        withdrawn: '200',
      },
    });

    const onChainTime = '2024-06-20T15:30:00.000Z';
    const event = makeEvent(
      [symbolScVal('cancel'), u64ScVal(30n)],
      xdr.ScVal.scvVec([i128ScVal(300n), i128ScVal(700n)]),
      { ledgerClosedAt: onChainTime },
    );
    await handleDonationVaultEvent(event);

    const stream = await prisma.stream.findUnique({ where: { onChainId: 30n } });
    expect(stream?.updatedAt.toISOString()).toBe(new Date(onChainTime).toISOString());
  });

  it('ignores a topup event rather than corrupting balance (documented gap)', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('J') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('K'), name: 'NGO K' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 4n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('L'),
        rate: '10',
        balance: '1000',
        withdrawn: '0',
      },
    });

    await handleDonationVaultEvent(
      makeEvent([symbolScVal('topup'), u64ScVal(4n)], i128ScVal(500n)),
    );

    const stream = await prisma.stream.findUnique({ where: { onChainId: 4n } });
    expect(stream?.balance).toBe('1000'); // unchanged — see the handler's comment

    // topup is intentionally unhandled — no StreamEvent row should be written.
    const streamEvent = await prisma.streamEvent.findFirst({ where: { type: 'topup' } });
    expect(streamEvent).toBeNull();
  });

  it('is idempotent when the same created event is replayed', async () => {
    const donor = fakeAddress('AA');
    const ngo = fakeAddress('AB');
    const token = fakeAddress('AC');

    const event = makeEvent(
      [symbolScVal('created'), u64ScVal(7n)],
      xdr.ScVal.scvVec([
        addressScVal(donor),
        addressScVal(ngo),
        addressScVal(token),
        i128ScVal(1000n),
        i128ScVal(10n),
      ]),
    );

    // Process the exact same event twice — the second pass is a replay
    // (e.g. indexer restarted after a crash between handler and checkpoint).
    await handleDonationVaultEvent(event);
    await handleDonationVaultEvent(event);

    // Exactly one row of each, not two.
    expect(await prisma.donor.count({ where: { address: donor } })).toBe(1);
    expect(await prisma.ngo.count({ where: { ownerAddress: ngo } })).toBe(1);
    expect(await prisma.stream.count({ where: { onChainId: 7n } })).toBe(1);

    // And the single stream row has the original values — the replay didn't
    // touch balance/rate/status.
    const stream = await prisma.stream.findUnique({ where: { onChainId: 7n } });
    expect(stream?.balance).toBe('1000');
    expect(stream?.rate).toBe('10');
    expect(stream?.withdrawn).toBe('0');
    expect(stream?.status).toBe('ACTIVE');
  });

  it('warns and records a dead letter when a withdraw event is received for an unknown stream', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const unknownOnChainId = 999n;
    const event = makeEvent([symbolScVal('withdraw'), u64ScVal(unknownOnChainId)], i128ScVal(500n));

    await expect(handleDonationVaultEvent(event)).resolves.not.toThrow();

    const stream = await prisma.stream.findUnique({ where: { onChainId: unknownOnChainId } });
    expect(stream).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { eventId: event.id, streamId: unknownOnChainId.toString() },
      'withdraw event received for unknown stream',
    );

    const deadLetter = await prisma.indexerDeadLetter.findUnique({
      where: { eventId: event.id },
    });
    expect(deadLetter).not.toBeNull();
    expect(deadLetter?.error).toContain(`unknown stream: ${unknownOnChainId}`);
  });

  it('warns and records a dead letter when a cancel event is received for an unknown stream', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const unknownOnChainId = 999n;
    const event = makeEvent(
      [symbolScVal('cancel'), u64ScVal(unknownOnChainId)],
      xdr.ScVal.scvVec([i128ScVal(300n), i128ScVal(700n)]),
    );

    await expect(handleDonationVaultEvent(event)).resolves.not.toThrow();

    const stream = await prisma.stream.findUnique({ where: { onChainId: unknownOnChainId } });
    expect(stream).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      { eventId: event.id, streamId: unknownOnChainId.toString() },
      'cancel event received for unknown stream',
    );

    const deadLetter = await prisma.indexerDeadLetter.findUnique({
      where: { eventId: event.id },
    });
    expect(deadLetter).not.toBeNull();
    expect(deadLetter?.error).toContain(`unknown stream: ${unknownOnChainId}`);
  });

  it('leaves a stream untouched on a ratemod event (documented gap)', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('M') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('N'), name: 'NGO N' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 5n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('O'),
        rate: '10',
        balance: '1000',
        withdrawn: '300',
        status: 'ACTIVE',
      },
    });

    // ratemod carries the stream's new rate. 25 is deliberately different
    // from the stored 10, so if the handler ever starts applying it the
    // assertions below fail instead of passing by coincidence. Unlike a
    // fresh stream, this one already has `withdrawn` accrued — that field
    // isn't in the payload either, so it must survive the event verbatim.
    await handleDonationVaultEvent(
      makeEvent([symbolScVal('ratemod'), u64ScVal(5n)], i128ScVal(25n)),
    );

    const stream = await prisma.stream.findUnique({ where: { onChainId: 5n } });
    expect(stream?.rate).toBe('10');
    expect(stream?.balance).toBe('1000');
    expect(stream?.withdrawn).toBe('300');
  });

  it('does not re-apply accrued to withdrawn on a duplicated cancel event (#266)', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('P') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('Q'), name: 'NGO Q' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 40n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('R'),
        rate: '10',
        balance: '1000',
        withdrawn: '0',
        status: 'ACTIVE',
      },
    });

    const cancelEvent = makeEvent(
      [symbolScVal('cancel'), u64ScVal(40n)],
      xdr.ScVal.scvVec([i128ScVal(300n), i128ScVal(700n)]),
    );

    // First cancel event applies
    await handleDonationVaultEvent(cancelEvent);

    let stream = await prisma.stream.findUnique({ where: { onChainId: 40n } });
    expect(stream?.status).toBe('CANCELLED');
    expect(stream?.balance).toBe('0');
    expect(stream?.rate).toBe('0');
    expect(stream?.withdrawn).toBe('300');

    // Duplicate cancel event should be ignored
    await handleDonationVaultEvent(cancelEvent);

    stream = await prisma.stream.findUnique({ where: { onChainId: 40n } });
    expect(stream?.status).toBe('CANCELLED');
    expect(stream?.balance).toBe('0');
    expect(stream?.rate).toBe('0');
    expect(stream?.withdrawn).toBe('300');

    const cancelEvents = await prisma.streamEvent.findMany({
      where: { streamId: 40n, type: 'cancel' },
    });
    expect(cancelEvents).toHaveLength(1);
  });

  it('ignores a withdraw event received after stream is cancelled (#266)', async () => {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('S') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('T'), name: 'NGO T' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 50n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('U'),
        rate: '10',
        balance: '1000',
        withdrawn: '0',
        status: 'ACTIVE',
      },
    });

    // First cancel stream
    await handleDonationVaultEvent(
      makeEvent(
        [symbolScVal('cancel'), u64ScVal(50n)],
        xdr.ScVal.scvVec([i128ScVal(400n), i128ScVal(600n)]),
      ),
    );

    let stream = await prisma.stream.findUnique({ where: { onChainId: 50n } });
    expect(stream?.status).toBe('CANCELLED');
    expect(stream?.withdrawn).toBe('400');
    expect(stream?.balance).toBe('0');

    // Withdraw arriving after cancel should be ignored
    await handleDonationVaultEvent(
      makeEvent([symbolScVal('withdraw'), u64ScVal(50n)], i128ScVal(100n)),
    );

    stream = await prisma.stream.findUnique({ where: { onChainId: 50n } });
    expect(stream?.status).toBe('CANCELLED');
    expect(stream?.withdrawn).toBe('400');
    expect(stream?.balance).toBe('0');

    const withdrawEvents = await prisma.streamEvent.findMany({
      where: { streamId: 50n, type: 'withdraw' },
    });
    expect(withdrawEvents).toHaveLength(0);
  });

  it('does not fail handler or dead-letter when notification log write fails (#269)', async () => {
    vi.spyOn(prisma.notificationLog, 'create').mockRejectedValue(
      new Error('database error in notificationLog.create'),
    );

    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('V') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('W'), name: 'NGO W' },
    });
    await prisma.stream.create({
      data: {
        onChainId: 60n,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('X'),
        rate: '10',
        balance: '1000',
        withdrawn: '0',
        status: 'ACTIVE',
      },
    });

    const event = makeEvent([symbolScVal('withdraw'), u64ScVal(60n)], i128ScVal(250n));

    await expect(handleDonationVaultEvent(event)).resolves.not.toThrow();

    const stream = await prisma.stream.findUnique({ where: { onChainId: 60n } });
    expect(stream?.balance).toBe('750');
    expect(stream?.withdrawn).toBe('250');

    const deadLetter = await prisma.indexerDeadLetter.findUnique({
      where: { eventId: event.id },
    });
    expect(deadLetter).toBeNull();
  });
});

describe('handleDonationVaultEvent handler branches (#316)', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(dispatchNotification).mockClear();
    await resetDb();
  });

  async function seedStream(onChainId: bigint, balance: string, withdrawn = '0') {
    const donorRow = await prisma.donor.create({ data: { address: fakeAddress('D') } });
    const ngoRow = await prisma.ngo.create({
      data: { ownerAddress: fakeAddress('E'), name: 'NGO E' },
    });
    await prisma.stream.create({
      data: {
        onChainId,
        donorId: donorRow.id,
        ngoId: ngoRow.id,
        tokenAddress: fakeAddress('F'),
        rate: '10',
        balance,
        withdrawn,
      },
    });
  }

  const clampWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.filter(([, message]) => message === 'withdraw exceeds recorded stream balance');

  describe('withdraw clamp', () => {
    it('does not warn on an ordinary withdraw that leaves a positive balance', async () => {
      const warn = vi.spyOn(logger, 'warn');
      await seedStream(70n, '1000');

      await handleDonationVaultEvent(
        makeEvent([symbolScVal('withdraw'), u64ScVal(70n)], i128ScVal(400n)),
      );

      expect(clampWarnings(warn)).toHaveLength(0);
      const stream = await prisma.stream.findUnique({ where: { onChainId: 70n } });
      expect(stream?.balance).toBe('600');
    });

    it('does not warn when a withdraw drains the balance to exactly zero', async () => {
      const warn = vi.spyOn(logger, 'warn');
      await seedStream(71n, '500');

      await handleDonationVaultEvent(
        makeEvent([symbolScVal('withdraw'), u64ScVal(71n)], i128ScVal(500n)),
      );

      expect(clampWarnings(warn)).toHaveLength(0);
      const stream = await prisma.stream.findUnique({ where: { onChainId: 71n } });
      expect(stream?.balance).toBe('0');
      expect(stream?.withdrawn).toBe('500');
    });

    it('warns once on a clamp and still records the event and notification with the raw amount', async () => {
      const warn = vi.spyOn(logger, 'warn');
      await seedStream(72n, '400', '100');
      const event = makeEvent([symbolScVal('withdraw'), u64ScVal(72n)], i128ScVal(500n));

      await handleDonationVaultEvent(event);

      expect(clampWarnings(warn)).toEqual([
        [
          { onChainId: '72', balance: '400', accrued: '500' },
          'withdraw exceeds recorded stream balance',
        ],
      ]);

      // The clamp only floors the balance; the audit trail keeps the real amount.
      const streamEvent = await prisma.streamEvent.findFirst({ where: { streamId: 72n } });
      expect(streamEvent?.type).toBe('withdraw');
      expect(streamEvent?.payload).toMatchObject({ accrued: '500' });
      expect(dispatchNotification).toHaveBeenCalledWith({
        type: 'stream_withdrawn',
        eventId: event.id,
        streamId: '72',
        amount: '500',
      });
    });
  });

  describe('cancel for an NGO that never registered', () => {
    const createdEvent = (onChainId: bigint, donor: string, ngo: string) =>
      makeEvent(
        [symbolScVal('created'), u64ScVal(onChainId)],
        xdr.ScVal.scvVec([
          addressScVal(donor),
          addressScVal(ngo),
          addressScVal(fakeAddress('T')),
          i128ScVal(1000n),
          i128ScVal(10n),
        ]),
      );

    it('keeps the placeholder NGO (empty name, unverified) when its stream is cancelled', async () => {
      const donor = fakeAddress('P');
      const ngo = fakeAddress('Q');
      await handleDonationVaultEvent(createdEvent(80n, donor, ngo));

      const before = await prisma.ngo.findUniqueOrThrow({ where: { ownerAddress: ngo } });
      expect(before.name).toBe('');
      expect(before.verified).toBe(false);

      const cancel = makeEvent(
        [symbolScVal('cancel'), u64ScVal(80n)],
        xdr.ScVal.scvVec([i128ScVal(300n), i128ScVal(700n)]),
      );
      await handleDonationVaultEvent(cancel);

      const stream = await prisma.stream.findUniqueOrThrow({ where: { onChainId: 80n } });
      expect(stream.status).toBe('CANCELLED');
      expect(stream.ngoId).toBe(before.id);

      const after = await prisma.ngo.findUniqueOrThrow({ where: { ownerAddress: ngo } });
      expect(after.id).toBe(before.id);
      expect(after.name).toBe('');
      expect(after.verified).toBe(false);
      expect(await prisma.ngo.count()).toBe(1);

      expect(dispatchNotification).toHaveBeenCalledWith({
        type: 'stream_cancelled',
        eventId: cancel.id,
        streamId: '80',
        settledToNgo: '300',
        refundToDonor: '700',
      });
    });

    it('does not invent an NGO or donor when the cancelled stream is unknown', async () => {
      const event = makeEvent(
        [symbolScVal('cancel'), u64ScVal(81n)],
        xdr.ScVal.scvVec([i128ScVal(300n), i128ScVal(700n)]),
      );

      await handleDonationVaultEvent(event);

      expect(await prisma.ngo.count()).toBe(0);
      expect(await prisma.donor.count()).toBe(0);
      expect(dispatchNotification).not.toHaveBeenCalled();
    });
  });
});
