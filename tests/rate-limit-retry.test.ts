import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithRetries } from '../src/utils/retry.js';
import { ValidationError } from '../src/utils/errors.js';
import type { PromptArgs } from '../src/utils/retry.js';

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

function rateLimitError(retryAfterMs?: number): Error {
  const error = new Error('Rate limited') as Error & {
    isRateLimit: boolean;
    isRetryable: boolean;
    retryAfterMs?: number;
  };
  error.isRateLimit = true;
  error.isRetryable = true;
  error.retryAfterMs = retryAfterMs;
  return error;
}

describe('runWithRetries rate-limit budget', () => {
  let mockSpinner: any;
  let mockArgs: PromptArgs;
  let sleep: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpinner = { text: '', succeed: vi.fn(), fail: vi.fn(), stop: vi.fn() };
    mockArgs = {
      input: [{ role: 'user', content: 'original' }],
      model: 'gpt-4',
      index: 0,
    };
    sleep = vi.fn().mockResolvedValue(undefined);
  });

  it('honours Retry-After and does not change args', async () => {
    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError(30_000))
      .mockResolvedValueOnce({ success: true });

    const result = await runWithRetries(mockFn, mockArgs, mockSpinner, 3, { sleep });

    expect(result).toEqual({ success: true });
    expect(mockFn).toHaveBeenCalledTimes(2);

    expect(sleep).toHaveBeenCalledTimes(1);
    const waitMs = sleep.mock.calls[0][0];
    expect(waitMs).toBeGreaterThanOrEqual(30_000);
    expect(waitMs).toBeLessThanOrEqual(30_500);

    const secondCallArgs = mockFn.mock.calls[1][0];
    expect(secondCallArgs.model).toBe('gpt-4');
    expect(secondCallArgs.input).toEqual(mockArgs.input);
  });

  it('backs off exponentially (1s, 2s, 4s) when no Retry-After is present', async () => {
    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError())
      .mockRejectedValueOnce(rateLimitError())
      .mockRejectedValueOnce(rateLimitError())
      .mockResolvedValueOnce({ success: true });

    await runWithRetries(mockFn, mockArgs, mockSpinner, 3, { sleep });

    expect(sleep).toHaveBeenCalledTimes(3);
    const waits = sleep.mock.calls.map((call) => call[0] as number);

    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThanOrEqual(1500);
    expect(waits[1]).toBeGreaterThanOrEqual(2000);
    expect(waits[1]).toBeLessThanOrEqual(2500);
    expect(waits[2]).toBeGreaterThanOrEqual(4000);
    expect(waits[2]).toBeLessThanOrEqual(4500);
  });

  it('gives up after rateLimitMaxRetries and mentions exhaustion', async () => {
    const mockFn = vi.fn().mockRejectedValue(rateLimitError(10));

    await expect(
      runWithRetries(mockFn, mockArgs, mockSpinner, 3, { sleep, rateLimitMaxRetries: 4 })
    ).rejects.toThrow(/exhausted/i);

    expect(mockFn).toHaveBeenCalledTimes(5); // rateLimitMaxRetries + 1
  });

  it('keeps validation-retry and rate-limit-retry counters independent', async () => {
    const mockFn = vi
      .fn()
      .mockRejectedValueOnce(new ValidationError('Schema error'))
      .mockRejectedValueOnce(rateLimitError(10))
      .mockResolvedValueOnce({ success: true });

    const result = await runWithRetries(mockFn, mockArgs, mockSpinner, 3, {
      sleep,
      fallbackModel: 'gpt-3.5-turbo',
    });

    expect(result).toEqual({ success: true });
    expect(mockFn).toHaveBeenCalledTimes(3);

    // Validation retry switched to the fallback model + prepended context.
    const secondCallArgs = mockFn.mock.calls[1][0];
    expect(secondCallArgs.model).toBe('gpt-3.5-turbo');
    expect(secondCallArgs.input[0].role).toBe('system');

    // Rate-limit retry does not touch args any further (model stays on fallback).
    const thirdCallArgs = mockFn.mock.calls[2][0];
    expect(thirdCallArgs.model).toBe('gpt-3.5-turbo');
    expect(thirdCallArgs.input).toEqual(secondCallArgs.input);
  });
});

describe('runWithRetries fallback model source', () => {
  it('leaves the model unchanged on validation retries when no fallbackModel is passed', async () => {
    const { ValidationError } = await import('../src/utils/errors.js');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ValidationError('schema mismatch'))
      .mockResolvedValueOnce({ ok: true });
    const args = { input: [], model: 'gpt-4.1-mini', index: 0 };
    const spinner = { text: '', warn: vi.fn() } as never;

    await runWithRetries(fn, args, spinner, 2, { sleep: async () => {} });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(args.model).toBe('gpt-4.1-mini');
  });

  it('switches to the fallbackModel given in opts (from the run config), not from ./config.json', async () => {
    const { ValidationError } = await import('../src/utils/errors.js');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ValidationError('schema mismatch'))
      .mockResolvedValueOnce({ ok: true });
    const args = { input: [], model: 'gpt-4.1-mini', index: 0 };
    const spinner = { text: '', warn: vi.fn() } as never;

    await runWithRetries(fn, args, spinner, 2, {
      sleep: async () => {},
      fallbackModel: 'gpt-4.1-mini',
    });

    expect(args.model).toBe('gpt-4.1-mini');
  });
});
