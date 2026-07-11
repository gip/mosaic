export class UnsupportedChainError extends Error {
  readonly code = 'UNSUPPORTED_CHAIN' as const;

  constructor(
    readonly chain: string,
    message = `DEX order books are not supported on chain '${chain}'`,
  ) {
    super(message);
    this.name = 'UnsupportedChainError';
  }
}
