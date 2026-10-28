import {
  Account,
  Contract,
  Keypair,
  Networks,
  scValToNative,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import { Server } from '@stellar/stellar-sdk/rpc';

const SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org';

export const rpcServer = new Server(SOROBAN_RPC_URL);

/** Latest ledger sequence the configured RPC node has ingested. */
export async function getLatestLedgerSequence(): Promise<number> {
  const { sequence } = await rpcServer.getLatestLedger();
  return sequence;
}

/** Call a read-only Soroban contract function and return the decoded result. */
export async function callContract<T>(
  contractId: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<T> {
  const source = new Account(Keypair.random().publicKey(), '0');
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(source, {
    fee: '100',
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(0)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);

  if ('error' in sim) {
    throw new Error(`Soroban simulation failed: ${sim.error}`);
  }

  const retVal = 'result' in sim ? sim.result?.retval : undefined;
  if (!retVal) {
    throw new Error('Soroban simulation returned no return value');
  }

  return scValToNative(retVal) as T;
}
