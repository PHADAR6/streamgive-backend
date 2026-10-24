import { Keypair } from '@stellar/stellar-sdk';
import { afterAll, describe, expect, it } from 'vitest';

import { sep53Hash } from '../../src/middleware/adminAuth.js';
import { buildServer } from '../../src/server.js';
import { signAdminRequest } from '../helpers/adminAuth.js';

// Three independent keypairs: one for the legacy single-key var, one that
// only ever appears in the list, and one configured nowhere. Keeping the
// third one lets the "rejected" case be a genuine allow-list miss rather
// than a signature that happened to fail verification, which a 401 alone
// can't tell apart.
const legacyAdmin = Keypair.random();
const listedAdmin = Keypair.random();
const unlistedAdmin = Keypair.random();

const originalAdminAddress = process.env.ADMIN_ADDRESS;
const originalAdminAddresses = process.env.ADMIN_ADDRESSES;

/** Sets the admin config for one test. The middleware reads env per-request,
 * so this works whether it runs before or after the server is built. */
function configureAdmins(single?: string, list?: string): void {
  if (single === undefined) delete process.env.ADMIN_ADDRESS;
  else process.env.ADMIN_ADDRESS = single;

  if (list === undefined) delete process.env.ADMIN_ADDRESSES;
  else process.env.ADMIN_ADDRESSES = list;
}

afterAll(() => {
  configureAdmins(originalAdminAddress, originalAdminAddresses);
});

/** Signs for and calls the admin-only application list as `keypair`, and
 * returns the status/body so each test can assert exactly what it cares
 * about. A fresh server per call means each gets its own rate-limit bucket. */
async function listApplicationsAs(keypair: Keypair) {
  const app = buildServer();
  const response = await app.inject({
    method: 'GET',
    url: '/v1/ngo-applications',
    headers: signAdminRequest(keypair, 'GET', '/v1/ngo-applications'),
  });
  const result = {
    statusCode: response.statusCode,
    body: response.json() as { error?: string },
  };
  await app.close();
  return result;
}

describe('requireAdminSignature', () => {
  it('accepts the single admin configured via ADMIN_ADDRESS', async () => {
    configureAdmins(legacyAdmin.publicKey());

    await expect(listApplicationsAs(legacyAdmin)).resolves.toMatchObject({ statusCode: 200 });
  });

  it('accepts every address in a comma-separated ADMIN_ADDRESSES list', async () => {
    configureAdmins(undefined, [legacyAdmin.publicKey(), listedAdmin.publicKey()].join(','));

    const legacy = await listApplicationsAs(legacyAdmin);
    const listed = await listApplicationsAs(listedAdmin);

    expect(legacy.statusCode).toBe(200);
    expect(listed.statusCode).toBe(200);
  });

  it('accepts both a legacy ADMIN_ADDRESS and an ADMIN_ADDRESSES list at once', async () => {
    configureAdmins(legacyAdmin.publicKey(), listedAdmin.publicKey());

    const legacy = await listApplicationsAs(legacyAdmin);
    const listed = await listApplicationsAs(listedAdmin);

    expect(legacy.statusCode).toBe(200);
    expect(listed.statusCode).toBe(200);
  });

  it('tolerates spaces and blank entries in ADMIN_ADDRESSES', async () => {
    // The kind of list a human actually pastes.
    configureAdmins(undefined, ` ${listedAdmin.publicKey()} , ,`);

    const listed = await listApplicationsAs(listedAdmin);

    expect(listed.statusCode).toBe(200);
  });

  it('rejects a self-signed request from an address that is not an admin', async () => {
    configureAdmins(legacyAdmin.publicKey(), listedAdmin.publicKey());

    const response = await listApplicationsAs(unlistedAdmin);

    // The signature is valid for unlistedAdmin's own key -- it still isn't
    // an admin, so the allow-list check has to be what rejects it.
    expect(response.statusCode).toBe(401);
    expect(response.body.error).toBe('unauthorized');
  });

  it('503s when neither ADMIN_ADDRESS nor ADMIN_ADDRESSES is configured', async () => {
    configureAdmins();

    const response = await listApplicationsAs(legacyAdmin);

    expect(response.statusCode).toBe(503);
    expect(response.body.error).toBe('admin_auth_not_configured');
  });

  it('rejects non-numeric timestamps', async () => {
    configureAdmins(legacyAdmin.publicKey());

    const app = buildServer();
    const headers = signAdminRequest(legacyAdmin, 'GET', '/v1/ngo-applications');
    headers['x-admin-timestamp'] = 'abc';

    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngo-applications',
      headers,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('stale_signature');

    await app.close();
  });

  it('rejects malformed admin addresses', async () => {
    configureAdmins(legacyAdmin.publicKey());

    const app = buildServer();
    const headers = signAdminRequest(legacyAdmin, 'GET', '/v1/ngo-applications');
    headers['x-admin-address'] = 'not-a-stellar-address';

    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngo-applications',
      headers,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('unauthorized');

    await app.close();
  });

  it('accepts hex-encoded signatures', async () => {
    configureAdmins(legacyAdmin.publicKey());

    const app = buildServer();
    const timestamp = Date.now().toString();
    const payload = `GET:/v1/ngo-applications:${timestamp}`;
    const signatureHex = Buffer.from(legacyAdmin.sign(sep53Hash(payload))).toString('hex');

    const response = await app.inject({
      method: 'GET',
      url: '/v1/ngo-applications',
      headers: {
        'x-admin-address': legacyAdmin.publicKey(),
        'x-admin-signature': signatureHex,
        'x-admin-timestamp': timestamp,
      },
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });
});
