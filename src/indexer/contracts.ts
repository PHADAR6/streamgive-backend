/** Deployed contract IDs the indexer watches. Empty until set post-deploy. */
export const NGO_REGISTRY_CONTRACT_ID = process.env.NGO_REGISTRY_CONTRACT_ID ?? '';
export const DONATION_VAULT_CONTRACT_ID = process.env.DONATION_VAULT_CONTRACT_ID ?? '';

export const WATCHED_CONTRACT_IDS = [NGO_REGISTRY_CONTRACT_ID, DONATION_VAULT_CONTRACT_ID].filter(
  (id) => id.length > 0,
);

/**
 * Minimal read-only client surface used by the reconciliation script.
 * Implemented by the Soroban RPC wrapper; mocked in tests.
 */
export interface NgoRegistryReader {
  /** Returns the on-chain `verified` flag for the given NGO id. */
  isVerified(ngoId: string): Promise<boolean>;
}

/**
 * Reads the on-chain verified status for an NGO from the registry contract.
 *
 * Returns `null` when the contract id is not configured or the NGO is not
 * present on-chain, so callers can distinguish "unknown" from `false`.
 */
export async function readOnChainVerifiedStatus(
  reader: NgoRegistryReader,
  ngoId: string,
): Promise<boolean | null> {
  if (NGO_REGISTRY_CONTRACT_ID.length === 0) {
    return null;
  }

  try {
    return await reader.isVerified(ngoId);
  } catch {
    return null;
  }
}
