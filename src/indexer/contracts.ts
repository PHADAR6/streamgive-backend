/** Deployed contract IDs the indexer watches. Empty until set post-deploy. */
export const NGO_REGISTRY_CONTRACT_ID = process.env.NGO_REGISTRY_CONTRACT_ID ?? '';
export const DONATION_VAULT_CONTRACT_ID = process.env.DONATION_VAULT_CONTRACT_ID ?? '';

export const WATCHED_CONTRACT_IDS = [NGO_REGISTRY_CONTRACT_ID, DONATION_VAULT_CONTRACT_ID].filter(
  (id) => id.length > 0,
);
