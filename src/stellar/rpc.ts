import { Server } from '@stellar/stellar-sdk/rpc';

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

export const rpcServer = new Server(SOROBAN_RPC_URL);

/** Latest ledger sequence the configured RPC node has ingested. */
export async function getLatestLedgerSequence(): Promise<number> {
  const { sequence } = await rpcServer.getLatestLedger();
  return sequence;
}
