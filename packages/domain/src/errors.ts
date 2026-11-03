/** Stable error codes shared by API, SDK, CLI and services. */
export type PfErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'VALIDATION_FAILED'
  | 'NETWORK_MISMATCH'
  | 'RPC_UNREACHABLE'
  | 'RPC_METHOD_MISSING'
  | 'RPC_ERROR'
  | 'NOT_SUPPORTED'
  | 'NOT_CONFIGURED'
  | 'POLICY_DENIED'
  | 'BUDGET_EXCEEDED'
  | 'UNSAFE_TARGET'
  | 'VERIFICATION_FAILED'
  | 'INTERNAL';

export class PfError extends Error {
  readonly code: PfErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: PfErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PfError';
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export const httpStatusFor = (code: PfErrorCode): number =>
  ({
    BAD_REQUEST: 400,
    VALIDATION_FAILED: 400,
    UNAUTHENTICATED: 401,
    FORBIDDEN: 403,
    POLICY_DENIED: 403,
    UNSAFE_TARGET: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    PAYLOAD_TOO_LARGE: 413,
    RATE_LIMITED: 429,
    NOT_SUPPORTED: 501,
    NOT_CONFIGURED: 503,
    RPC_UNREACHABLE: 502,
    RPC_METHOD_MISSING: 502,
    RPC_ERROR: 502,
    NETWORK_MISMATCH: 409,
    BUDGET_EXCEEDED: 409,
    VERIFICATION_FAILED: 422,
    INTERNAL: 500,
  })[code];

export const isPfError = (e: unknown): e is PfError => e instanceof PfError;
