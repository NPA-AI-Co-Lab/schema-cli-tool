import pRetry, { AbortError, FailedAttemptError } from 'p-retry';
import { Ora } from 'ora';
import { ValidationError } from './errors.js';
import { warn } from './ui.js';
import { setCurrentAttemptNumber, clearCurrentAttemptNumber } from './retry-context.js';
import { RetryAttemptDetails } from '../logging.js';

const DEFAULT_RATE_LIMIT_MAX_RETRIES = 6;
const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 90_000;
const RATE_LIMIT_JITTER_MS = 500;
const VALIDATION_RETRY_DELAY_MS = 500;

/**
 * Arguments for prompt/analysis functions
 */
export interface PromptArgs {
  input: Array<{ role: 'user' | 'system' | 'assistant'; content: string }>;
  model: string;
  index?: number;
  csvLineStart?: number;
  batchLength?: number;
  logRetryAttempt?: (details: RetryAttemptDetails) => Promise<void>;
  [key: string]: unknown;
}

/**
 * Options controlling the separate rate-limit retry budget.
 */
export interface RunWithRetriesOptions {
  /** Max retries dedicated to rate-limit/retryable-transport errors (default 6) */
  rateLimitMaxRetries?: number;
  /** Ceiling on how long a single rate-limit wait may be, in ms (default 90_000) */
  rateLimitMaxWaitMs?: number;
  /** Injectable sleep, primarily so tests can avoid real waits */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Model to switch to on validation-error retries. Comes from the run's config
   * (fallbackModel / --fallback-model); when omitted the model is left unchanged.
   */
  fallbackModel?: string;
}

/** Errors decorated with the optional fields LLMRequestError attaches */
interface RetryableError extends FailedAttemptError {
  isRetryable?: boolean;
  isRateLimit?: boolean;
  retryAfterMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine error type for logging
 */
function getErrorType(error: unknown): RetryAttemptDetails['errorType'] {
  if (error instanceof ValidationError) {
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('required field')) {
      return 'required_field_error';
    }
    return 'validation_error';
  }

  if (error && typeof error === 'object') {
    if ((error as { isRateLimit?: boolean }).isRateLimit) {
      return 'rate_limit_error';
    }

    if ('status' in error) {
      const status = (error as { status: number }).status as number;
      if (status === 429 || status >= 500) {
        return 'api_error';
      }
    }
  }

  return 'network_error';
}

/**
 * Check if error should be retried with argument changes
 */
function shouldRetryWithChange(error: unknown): boolean {
  return error instanceof ValidationError;
}

/**
 * Check if error should be retried without changes (rate limits, server errors)
 */
function shouldRetryWithoutChange(error: unknown): boolean {
  if (error && typeof error === 'object') {
    if ('isRetryable' in error) {
      return (error as { isRetryable?: boolean }).isRetryable === true;
    }

    if ('status' in error) {
      const status = (error as { status: number }).status as number;
      return status === 429 || status >= 500;
    }
  }

  return false;
}

/**
 * Update arguments for retry with error context
 */
function updateArgsForRetry(
  error: FailedAttemptError,
  args: PromptArgs,
  fallbackModel: string | undefined
) {
  args.input = [
    {
      role: 'system',
      content:
        'The following error occurred during previous analysis: ' +
        String(error) +
        ' Please retry with this context.',
    },
    ...args.input,
  ];
  if (fallbackModel) {
    args.model = fallbackModel;
  }
}

/**
 * Emit a retry_attempts log entry, if the batch context needed for it is present.
 */
async function logAttempt(
  args: PromptArgs,
  details: Omit<RetryAttemptDetails, 'batchIndex' | 'csvLineRange'>
): Promise<void> {
  if (
    !args.logRetryAttempt ||
    typeof args.index !== 'number' ||
    typeof args.csvLineStart !== 'number' ||
    typeof args.batchLength !== 'number'
  ) {
    return;
  }

  const csvLineEnd = args.csvLineStart + args.batchLength - 1;
  await args.logRetryAttempt({
    batchIndex: args.index,
    csvLineRange: `${args.csvLineStart}-${csvLineEnd}`,
    ...details,
  });
}

/**
 * Run function with retry logic.
 *
 * Validation errors are retried with changed args (error context prepended,
 * model switched to the fallback) and are bounded by `retriesNumber`.
 * Rate-limit/retryable-transport errors (isRateLimit / isRetryable) are
 * retried unchanged against a separate budget (`rateLimitMaxRetries`),
 * waiting for the provider's Retry-After hint (or an exponential backoff)
 * before each retry. All other errors abort immediately.
 */
export async function runWithRetries(
  fn: (args: PromptArgs) => Promise<unknown>,
  args: PromptArgs,
  spinner: Ora,
  retriesNumber: number,
  opts: RunWithRetriesOptions = {}
) {
  const {
    rateLimitMaxRetries = DEFAULT_RATE_LIMIT_MAX_RETRIES,
    rateLimitMaxWaitMs = DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
    sleep = defaultSleep,
    fallbackModel,
  } = opts;

  const batchIndex = 'index' in args ? (args.index as number) : -1;

  let validationAttempts = 0;
  let rateLimitAttempts = 0;

  const onFailedAttempt = async (error: FailedAttemptError) => {
    const errorType = getErrorType(error);

    if (shouldRetryWithoutChange(error)) {
      rateLimitAttempts += 1;

      const retryAfterMs = (error as RetryableError).retryAfterMs;
      const backoffMs = 1000 * 2 ** (rateLimitAttempts - 1);
      const wait =
        Math.min(rateLimitMaxWaitMs, Math.max(retryAfterMs ?? 0, backoffMs)) +
        Math.random() * RATE_LIMIT_JITTER_MS;

      if (rateLimitAttempts > rateLimitMaxRetries) {
        const message = `Rate limit retries exhausted after ${rateLimitAttempts} attempts (last wait ${Math.round(wait / 1000)}s)`;

        await logAttempt(args, {
          attemptNumber: error.attemptNumber,
          totalRetries: rateLimitMaxRetries,
          errorType,
          errorMessage: error.message,
          actionTaken: 'failed',
          waitMs: wait,
        });

        console.error(`❌ Skipping batch index ${args.index} due to LLM error:`, message);

        throw new AbortError(new Error(message, { cause: error }));
      }

      warn(
        `Rate limited by OpenAI — waiting ${Math.round(wait / 1000)}s (attempt ${rateLimitAttempts}/${rateLimitMaxRetries})`,
        spinner
      );

      await logAttempt(args, {
        attemptNumber: error.attemptNumber,
        totalRetries: rateLimitMaxRetries,
        errorType,
        errorMessage: error.message,
        actionTaken: 'retry_after_wait',
        waitMs: wait,
      });

      await sleep(wait);
      return;
    }

    if (shouldRetryWithChange(error)) {
      validationAttempts += 1;

      if (validationAttempts > retriesNumber) {
        await logAttempt(args, {
          attemptNumber: error.attemptNumber,
          totalRetries: retriesNumber,
          errorType,
          errorMessage: error.message,
          actionTaken: 'failed',
        });

        console.error(`❌ Skipping batch index ${args.index} due to LLM error:`, error.message);

        throw new AbortError(error instanceof Error ? error : String(error));
      }

      warn(
        `Retrying with changed args (${validationAttempts}/${retriesNumber})... - ${error.message}`,
        spinner
      );
      const modelBefore = args.model;
      updateArgsForRetry(error, args, fallbackModel);
      const actionTaken: RetryAttemptDetails['actionTaken'] =
        args.model !== modelBefore ? 'retry_with_fallback' : 'retry_with_context';

      await logAttempt(args, {
        attemptNumber: error.attemptNumber,
        totalRetries: retriesNumber,
        errorType,
        errorMessage: error.message,
        actionTaken,
        fallbackModel: actionTaken === 'retry_with_fallback' ? args.model : undefined,
      });

      await sleep(VALIDATION_RETRY_DELAY_MS);
      return;
    }

    await logAttempt(args, {
      attemptNumber: error.attemptNumber,
      totalRetries: retriesNumber,
      errorType,
      errorMessage: error.message,
      actionTaken: 'failed',
    });

    console.error(`❌ Skipping batch index ${args.index} due to LLM error:`, error.message);

    throw new AbortError(error instanceof Error ? error : String(error));
  };

  try {
    return await pRetry(
      async (attemptNumber) => {
        setCurrentAttemptNumber(batchIndex, attemptNumber);
        return await fn(args);
      },
      {
        retries: retriesNumber + rateLimitMaxRetries,
        minTimeout: 0,
        onFailedAttempt,
      }
    );
  } catch (error) {
    // p-retry unwraps an AbortError only when it is thrown by `fn` itself; one thrown from
    // onFailedAttempt (our case) is rejected as-is. Unwrap it here so callers see the real
    // error (with its class, status, isRateLimit, …) rather than a generic AbortError.
    if (error instanceof AbortError && error.originalError) {
      throw error.originalError;
    }
    throw error;
  } finally {
    clearCurrentAttemptNumber(batchIndex);
  }
}
