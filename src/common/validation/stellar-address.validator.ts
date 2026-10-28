import { z } from 'zod';
import { StrKey } from '@stellar/stellar-sdk';

export const stellarAddressSchema = z
  .string()
  .min(1, { message: 'Stellar address is required' })
  .refine(
    (val) => {
      try {
        return StrKey.isValidEd25519PublicKey(val);
      } catch {
        return false;
      }
    },
    { message: 'Invalid Stellar public key or bad checksum' }
  );