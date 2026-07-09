import { recoverTypedDataAddress, type Hex } from 'viem';
import { eip712TypedData, type ZoneMessage } from '../messages.js';

/**
 * Verify an EIP-712 signature over a zone message (spec §2.3: EVM signs typed
 * data only). Returns the recovered address so callers can also bind it.
 */
export async function recoverEvmZoneSigner(
  message: ZoneMessage,
  chainId: number,
  signature: Hex,
): Promise<string> {
  const typed = eip712TypedData(message, chainId);
  return recoverTypedDataAddress({
    domain: typed.domain,
    types: typed.types as Record<string, { name: string; type: string }[]>,
    primaryType: typed.primaryType,
    message: message as unknown as Record<string, unknown>,
    signature,
  });
}

export async function verifyEvmZoneSignature(
  message: ZoneMessage,
  chainId: number,
  signature: Hex,
  expectedAddress: string,
): Promise<boolean> {
  try {
    const recovered = await recoverEvmZoneSigner(message, chainId, signature);
    return recovered.toLowerCase() === expectedAddress.toLowerCase();
  } catch {
    return false;
  }
}
