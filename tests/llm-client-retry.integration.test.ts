import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Ora } from 'ora';
import { OpenAILLMClient } from '../src/clients/openai-llm-client.js';
import { runWithRetries } from '../src/utils/retry.js';
import { processBatch } from '../src/analysis/processor.js';
import type { RetryAttemptDetails } from '../src/logging.js';

// End-to-end regression coverage for the retry path THROUGH the real
// OpenAILLMClient. Unlike tests/error-handling.test.ts (which injects
// `{ status: 429 }` errors straight into runWithRetries), this suite drives
// failures out of `client.responses.create()` itself, through
// OpenAILLMClient.analyze() -> normalizeLLMError() -> runWithRetries(), so a
// regression in how status/headers are (or aren't) preserved across that
// boundary would be caught here even if it stayed invisible to the
// lower-level unit tests.

vi.mock('../src/utils/config.js', () => ({
  loadGlobalConfig: () => ({
    FALLBACK_MODEL: 'gpt-3.5-turbo',
  }),
}));

vi.mock('../src/utils/ui.js', () => ({
  warn: vi.fn(),
}));

vi.mock('../src/utils/retry-context.js', () => ({
  setCurrentAttemptNumber: vi.fn(),
  clearCurrentAttemptNumber: vi.fn(),
}));

vi.mock('openai/helpers/zod', () => ({
  zodTextFormat: vi.fn(() => ({ type: 'json_schema' })),
}));

// Fake error classes with the same shape (status, headers, message, name) as
// the real `openai` SDK's error hierarchy, attached as static properties on
// the mocked OpenAI constructor exactly like the real module does. This lets
// llm-errors.ts's `isInstanceOfSafe(err, OpenAI.RateLimitError)` checks work
// against errors thrown by our fake `responses.create()`.
//
// Declared via vi.hoisted so they're available inside the vi.mock('openai', ...)
// factory below, which vitest hoists above these module-level declarations.
const { mockCreate, FakeAPIError, FakeRateLimitError } = vi.hoisted(() => {
  class FakeAPIError extends Error {
    status?: number;
    headers?: Headers;
    constructor(message: string, options: { status?: number; headers?: Headers } = {}) {
      super(message);
      this.name = 'APIError';
      this.status = options.status;
      this.headers = options.headers;
    }
  }

  class FakeRateLimitError extends FakeAPIError {
    constructor(message: string, options: { status?: number; headers?: Headers } = {}) {
      super(message, options);
      this.name = 'RateLimitError';
    }
  }

  class FakeAPIConnectionError extends FakeAPIError {}
  class FakeAPIConnectionTimeoutError extends FakeAPIConnectionError {}

  return {
    mockCreate: vi.fn(),
    FakeAPIError,
    FakeRateLimitError,
    FakeAPIConnectionError,
    FakeAPIConnectionTimeoutError,
  };
});

vi.mock('openai', () => {
  class MockOpenAI {
    apiKey: string;
    responses = { create: mockCreate };
    constructor(opts: { apiKey: string }) {
      this.apiKey = opts.apiKey;
    }
    static APIError = FakeAPIError;
    static RateLimitError = FakeRateLimitError;
  }

  return { default: MockOpenAI };
});

const resultsSchema = z.object({ results: z.array(z.object({ name: z.string() })) });

function makeSpinner(): Ora {
  return {
    text: '',
    isSpinning: false,
    start: vi.fn(),
    stop: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
  } as unknown as Ora;
}

function successResponse(names: string[]) {
  return {
    error: null,
    output_text: JSON.stringify({ results: names.map((name) => ({ name })) }),
  };
}

describe('retry path through the real OpenAILLMClient (test-1)', () => {
  let spinner: Ora;
  let sleep: ReturnType<typeof vi.fn>;
  let logRetryAttempt: ReturnType<typeof vi.fn<(details: RetryAttemptDetails) => Promise<void>>>;
  let client: OpenAILLMClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockReset();
    spinner = makeSpinner();
    sleep = vi.fn().mockResolvedValue(undefined);
    logRetryAttempt = vi.fn().mockResolvedValue(undefined);
    client = new OpenAILLMClient('test-api-key', 'gpt-4.1', 'gpt-4.1');
  });

  function buildBatchArgs(model: string) {
    return {
      llmClient: client,
      instructions: 'Extract entities',
      zodSchema: resultsSchema,
      batchLength: 1,
      index: 0,
      input: [{ role: 'user' as const, content: 'Row data' }],
      model,
      csvLineStart: 1,
      logRetryAttempt,
      decodePII: (records: Record<string, unknown>) => records,
      encodingMap: {},
    };
  }

  it('Case A: 429 with Retry-After: 2 header, then success — sleeps ~2s, model unchanged, logged as rate_limit_error/retry_after_wait', async () => {
    mockCreate
      .mockRejectedValueOnce(
        new FakeRateLimitError('Rate limit reached', {
          status: 429,
          headers: new Headers({ 'retry-after': '2' }),
        })
      )
      .mockResolvedValueOnce(successResponse(['Alice']));

    const batchArgs = buildBatchArgs('gpt-4.1');

    const result = await runWithRetries(
      (args) => processBatch({ ...batchArgs, model: args.model, input: args.input }),
      batchArgs,
      spinner,
      3,
      { sleep }
    );

    expect(result).toEqual([{ name: 'Alice' }]);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    expect(sleep).toHaveBeenCalledTimes(1);
    const waitMs = sleep.mock.calls[0][0] as number;
    expect(waitMs).toBeGreaterThanOrEqual(2000);
    expect(waitMs).toBeLessThanOrEqual(2500);

    // Model/input must be unchanged for a rate-limit retry.
    expect(mockCreate.mock.calls[1][0].model).toBe('gpt-4.1');

    expect(logRetryAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        errorType: 'rate_limit_error',
        actionTaken: 'retry_after_wait',
      })
    );
  });

  it('Case B: 429 with no headers, "try again in 1200ms" message — sleeps ~1200-1700ms', async () => {
    mockCreate
      .mockRejectedValueOnce(
        new FakeRateLimitError('Rate limit reached. Please try again in 1200ms.', { status: 429 })
      )
      .mockResolvedValueOnce(successResponse(['Bob']));

    const batchArgs = buildBatchArgs('gpt-4.1');

    const result = await runWithRetries(
      (args) => processBatch({ ...batchArgs, model: args.model, input: args.input }),
      batchArgs,
      spinner,
      3,
      { sleep }
    );

    expect(result).toEqual([{ name: 'Bob' }]);
    expect(mockCreate).toHaveBeenCalledTimes(2);

    expect(sleep).toHaveBeenCalledTimes(1);
    const waitMs = sleep.mock.calls[0][0] as number;
    // retry.ts floors the wait at the exponential backoff for the attempt
    // number (1000ms on the first rate-limit retry), so the parsed
    // Retry-After hint from the message (1200ms) must exceed that floor for
    // this assertion to isolate message-parsing specifically, distinct from
    // the header-parsing path exercised in Case A.
    expect(waitMs).toBeGreaterThanOrEqual(1200);
    expect(waitMs).toBeLessThanOrEqual(1700);
  });

  it('Case C: 401 invalid API key — no retry, rejects immediately, error mentions 401', async () => {
    mockCreate.mockRejectedValueOnce(
      new FakeAPIError('401 Incorrect API key provided', { status: 401 })
    );

    const batchArgs = buildBatchArgs('gpt-4.1');

    await expect(
      runWithRetries(
        (args) => processBatch({ ...batchArgs, model: args.model, input: args.input }),
        batchArgs,
        spinner,
        3,
        { sleep }
      )
    ).rejects.toThrow(/401/);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('Case D: 500 then success — one retry, no model switch', async () => {
    mockCreate
      .mockRejectedValueOnce(new FakeAPIError('Internal server error', { status: 500 }))
      .mockResolvedValueOnce(successResponse(['Carol']));

    const batchArgs = buildBatchArgs('gpt-4.1');

    const result = await runWithRetries(
      (args) => processBatch({ ...batchArgs, model: args.model, input: args.input }),
      batchArgs,
      spinner,
      3,
      { sleep }
    );

    expect(result).toEqual([{ name: 'Carol' }]);
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[1][0].model).toBe('gpt-4.1');
  });
});
