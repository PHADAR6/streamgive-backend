import {
  Account,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { pathToFileURL } from 'node:url';
import { rpcServer } from '../stellar/rpc.js';
import { NGO_REGISTRY_CONTRACT_ID } from '../indexer/contracts.js';
import { prisma } from '../db.js';

const RPC_CONCURRENCY = 5;

export interface ReconciliationMismatch {
  ngoId: string;
  ownerAddress: string;
  dbVerified: boolean;
  onChainVerified: boolean;
}

export interface ReconciliationReport {
  checked: number;
  mismatches: ReconciliationMismatch[];
  fixed: number;
}

/**
 * Read an NGO's verified flag from the on-chain ngo-registry contract.
 * Returns null when the NGO is not registered on-chain.
 */
export async function readOnChainVerified(ownerAddress: string): Promise<boolean | null> {
  if (!NGO_REGISTRY_CONTRACT_ID) {
    throw new Error('NGO_REGISTRY_CONTRACT_ID is not configured');
  }

  const contract = new Contract(NGO_REGISTRY_CONTRACT_ID);
  const operation = contract.call('verified', nativeToScVal(ownerAddress, { type: 'address' }));
  const source = new Account(Keypair.random().publicKey(), '0');

  const transaction = new TransactionBuilder(
    source,
    {
      fee: '100',
      networkPassphrase:
        process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET,
    },
  )
    .addOperation(operation)
    .setTimeout(0)
    .build();

  const simulation = await rpcServer.simulateTransaction(transaction);
  if ('error' in simulation) {
    const error = String(simulation.error);
    if (error.includes('NotRegistered') || error.includes('NotFound')) {
      return null;
    }
    throw new Error(`Simulation failed for ${ownerAddress}: ${error}`);
  }

  const ret = 'result' in simulation ? simulation.result?.retval : undefined;
  if (!ret) {
    return null;
  }

  const verified = scValToNative(ret);
  if (typeof verified !== 'boolean') {
    throw new Error(`Unsupported verified return type for ${ownerAddress}: ${typeof verified}`);
  }
  return verified;
}

/**
 * Read every NGO's on-chain verified status and compare it to the DB.
 * When `fix` is true, mismatches are written back to the NGO table.
 */
export async function reconcileVerification(options: { fix?: boolean } = {}): Promise<ReconciliationReport> {
  const { fix = false } = options;
  const ngos = await prisma.ngo.findMany();

  const results = await mapWithConcurrency(ngos, RPC_CONCURRENCY, async (ngo) => {
    const onChainVerified = await readOnChainVerified(ngo.ownerAddress);
    if (onChainVerified === null) {
      return null;
    }
    if (onChainVerified === ngo.verified) {
      return null;
    }

    const mismatch = {
      ngoId: ngo.id,
      ownerAddress: ngo.ownerAddress,
      dbVerified: ngo.verified,
      onChainVerified,
    };

    if (fix) {
      await prisma.ngo.update({
        where: { id: ngo.id },
        data: { verified: onChainVerified },
      });
    }
    return mismatch;
  });

  const mismatches = results.filter(
    (mismatch): mismatch is ReconciliationMismatch => mismatch !== null,
  );

  return { checked: ngos.length, mismatches, fixed: fix ? mismatches.length : 0 };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  map: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await map(items[index]);
      }
    }),
  );

  return results;
}

async function main(): Promise<void> {
  const fix = process.argv.includes('--fix');
  const report = await reconcileVerification({ fix });

  console.log(`Checked ${report.checked} NGOs.`);
  if (report.mismatches.length === 0) {
    console.log('No verification mismatches found.');
    return;
  }

  for (const mismatch of report.mismatches) {
    console.log(
      `${mismatch.ngoId} (${mismatch.ownerAddress}): DB=${mismatch.dbVerified}, on-chain=${mismatch.onChainVerified}`,
    );
  }

  process.exitCode = 1;
  if (fix) {
    console.log(`Fixed ${report.fixed} mismatches.`);
  } else {
    console.log('Run with --fix to update the DB.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
