import { randomUUID } from 'node:crypto';

export type MosaicMcpErrorCode =
  | 'AUTH_EXPIRED'
  | 'AUTH_INVALID'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'XAMAN_UNAVAILABLE'
  | 'LEDGER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'UNAVAILABLE'
  | 'INTERNAL';

const STATUS: Record<MosaicMcpErrorCode, number> = {
  AUTH_EXPIRED: 401,
  AUTH_INVALID: 401,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  XAMAN_UNAVAILABLE: 503,
  LEDGER_UNAVAILABLE: 503,
  TIMEOUT: 504,
  UNAVAILABLE: 503,
  INTERNAL: 500,
};

const RETRYABLE = new Set<MosaicMcpErrorCode>([
  'RATE_LIMITED',
  'XAMAN_UNAVAILABLE',
  'LEDGER_UNAVAILABLE',
  'TIMEOUT',
  'UNAVAILABLE',
]);

export interface MosaicMcpErrorBody {
  code: MosaicMcpErrorCode;
  message: string;
  retryable: boolean;
  status: number;
  details?: unknown;
  correlation_id: string;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class MosaicMcpError extends Error {
  readonly code: MosaicMcpErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly details?: unknown;
  readonly correlationId: string;

  constructor(
    code: MosaicMcpErrorCode,
    message: string,
    opts: { retryable?: boolean; status?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'MosaicMcpError';
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.status = opts.status ?? STATUS[code];
    this.details = opts.details;
    this.correlationId = randomUUID();
  }

  body(): MosaicMcpErrorBody {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      status: this.status,
      ...(this.details === undefined ? {} : { details: this.details }),
      correlation_id: this.correlationId,
    };
  }
}

export function classifyMcpError(error: unknown): MosaicMcpError {
  if (error instanceof MosaicMcpError) return error;
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  if (lower.includes('invalid or expired session')) return new MosaicMcpError('AUTH_EXPIRED', message, { cause: error });
  if (lower.includes('signature') || lower.includes('challenge')) return new MosaicMcpError('AUTH_INVALID', message, { cause: error });
  if (lower.includes('not found')) return new MosaicMcpError('NOT_FOUND', message, { cause: error });
  if (lower.includes('duplicate key') || lower.includes('conflict') || lower.includes('already exists')) {
    return new MosaicMcpError('CONFLICT', message, { cause: error });
  }
  if (lower.includes('timed out') || lower.includes('timeout')) return new MosaicMcpError('TIMEOUT', message, { cause: error });
  return new MosaicMcpError('INTERNAL', message, { cause: error });
}

export function mcpErrorContent(error: unknown): { error: MosaicMcpErrorBody } {
  return { error: classifyMcpError(error).body() };
}
