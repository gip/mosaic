import { UnsupportedChainError } from '../errors.js';
import type { DexAdapter } from '../types.js';

/** EVM DEX order books are not supported yet. */
export function createAdapter(): DexAdapter {
  throw new UnsupportedChainError('evm');
}
