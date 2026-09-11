import OpenAI from 'openai';

/**
 * Maximum retry-after delay we will ever honour, to guard against
 * malformed/huge header values (10 minutes).
 */
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000;

/**
 * Optional context passed to {@link normalizeLLMError} for future diagnostics.
 */
export interface LLMErrorContext {
  model?: string;
}

export interface LLMRequestErrorOptions {
  status?: number;
  code?: string;
  retryAfterMs?: number;
  isRateLimit?: boolean;
  isRetryable?: boolean;
  cause?: unknown;
  model?: string;
}

/**
 * Normalized error thrown by LLM client implementations. Preserves the
 * HTTP status, rate-limit hint (Retry-After) and retryability of the
 * original provider error so downstream retry logic can act on it.
 */
export class LLMRequestError extends Error {
  status?: number;
  code?: string;
  retryAfterMs?: number;
  isRateLimit: boolean;
  isRetryable: boolean;
  model?: string;
  override cause?: unknown;

  constructor(message: string, options: LLMRequestErrorOptions = {}) {
    super(message);
    this.name = 'LLMRequestError';
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    this.isRateLimit = options.isRateLimit ?? false;
    this.isRetryable = options.isRetryable ?? false;
    this.model = options.model;
    this.cause = options.cause;
  }
}

function getHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (typeof (headers as Headers).get === 'function') {
    const value = (headers as Headers).get(name);
    return value ?? undefined;
  }

  if (typeof headers === 'object') {
    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (key.toLowerCase() === lowerName && value != null) {
        return String(value);
      }
    }
  }

  return undefined;
}

/**
 * `instanceof` guard that tolerates a mocked/partial `openai` module (e.g.
 * in tests) where the referenced error class may not be a constructor.
 */
function isInstanceOfSafe(err: unknown, ctor: unknown): boolean {
  return typeof ctor === 'function' && err instanceof ctor;
}

function clampRetryAfterMs(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/**
 * Parse a Retry-After hint out of response headers or, failing that, an
 * error message such as "Rate limit reached ... Please try again in 1.2s.".
 * Returns the delay in milliseconds, or undefined if nothing could be parsed.
 */
export function parseRetryAfterMs(headers: unknown, message?: string): number | undefined {
  const retryAfterMsHeader = getHeaderValue(headers, 'retry-after-ms');
  if (retryAfterMsHeader !== undefined) {
    const ms = Number(retryAfterMsHeader);
    if (!Number.isNaN(ms)) {
      return clampRetryAfterMs(ms);
    }
  }

  const retryAfterHeader = getHeaderValue(headers, 'retry-after');
  if (retryAfterHeader !== undefined) {
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds)) {
      return clampRetryAfterMs(seconds * 1000);
    }

    const dateMs = Date.parse(retryAfterHeader);
    if (!Number.isNaN(dateMs)) {
      return clampRetryAfterMs(dateMs - Date.now());
    }
  }

  if (message) {
    const match = message.match(/try again in (\d+(?:\.\d+)?)\s*(ms|s|m)/i);
    if (match) {
      const value = Number(match[1]);
      const unit = match[2].toLowerCase();
      const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : 60_000;
      return clampRetryAfterMs(value * multiplier);
    }
  }

  return undefined;
}

/**
 * Normalize an unknown error thrown by an LLM SDK call into an
 * {@link LLMRequestError}, preserving status/headers-derived retry
 * information that a naive `new Error(...)` wrapper would otherwise drop.
 */
export function normalizeLLMError(err: unknown, ctx: LLMErrorContext = {}): LLMRequestError {
  if (err instanceof LLMRequestError) {
    return err;
  }

  const errObj = (err ?? {}) as Record<string, unknown>;
  const status = typeof errObj.status === 'number' ? errObj.status : undefined;
  const code = typeof errObj.code === 'string' ? errObj.code : undefined;
  const errName = typeof errObj.name === 'string' ? errObj.name : undefined;

  const isRateLimit =
    status === 429 ||
    isInstanceOfSafe(err, OpenAI.RateLimitError) ||
    code === 'rate_limit_exceeded';

  const isConnectionIssue =
    isInstanceOfSafe(err, OpenAI.APIConnectionError) ||
    isInstanceOfSafe(err, OpenAI.APIConnectionTimeoutError) ||
    errName === 'APIConnectionError' ||
    errName === 'APIConnectionTimeoutError';

  const isRetryable =
    isRateLimit ||
    isConnectionIssue ||
    (typeof status === 'number' && (status >= 500 || status === 408));

  const message = typeof errObj.message === 'string' ? errObj.message : String(err);
  const retryAfterMs = parseRetryAfterMs(errObj.headers, message);

  return new LLMRequestError(message, {
    status,
    code,
    retryAfterMs,
    isRateLimit,
    isRetryable,
    cause: err,
    model: ctx.model,
  });
}
