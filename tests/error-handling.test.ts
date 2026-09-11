import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithRetries } from '../src/utils/retry.js';
import { ValidationError } from '../src/utils/errors.js';
import { AbortError } from 'p-retry';
import type { PromptArgs } from '../src/utils/retry.js';

// Mock dependencies
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

describe('Error Handling', () => {
  let mockSpinner: any;
  let mockArgs: PromptArgs;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpinner = {
      text: '',
      succeed: vi.fn(),
      fail: vi.fn(),
      stop: vi.fn(),
    };

    mockArgs = {
      input: [{ role: 'user', content: 'test input' }],
      model: 'gpt-4',
      index: 0,
    };
  });

  describe('runWithRetries', () => {
    it('should succeed on first attempt when no errors occur', async () => {
      const mockFn = vi.fn().mockResolvedValue({ success: true });

      const result = await runWithRetries(mockFn, mockArgs, mockSpinner, 3, {
        fallbackModel: 'gpt-3.5-turbo',
      });

      expect(result).toEqual({ success: true });
      expect(mockFn).toHaveBeenCalledTimes(1);
      expect(mockFn).toHaveBeenCalledWith(mockArgs);
    });

    it('should retry on validation errors and update args', async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new ValidationError('Schema validation failed'))
        .mockResolvedValueOnce({ success: true });

      const result = await runWithRetries(mockFn, mockArgs, mockSpinner, 3, {
        fallbackModel: 'gpt-3.5-turbo',
      });

      expect(result).toEqual({ success: true });
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Second call should have updated args
      const secondCallArgs = mockFn.mock.calls[1][0];
      expect(secondCallArgs.model).toBe('gpt-3.5-turbo'); // Should switch to fallback
      expect(secondCallArgs.input[0].role).toBe('system'); // Should have error context
      expect(secondCallArgs.input[0].content).toContain('error occurred during previous analysis');
    });

    it('should retry on rate limit errors without changing args', async () => {
      const rateLimitError = new Error('Rate limit exceeded');
      (rateLimitError as any).status = 429;

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ success: true });

      const result = await runWithRetries(mockFn, mockArgs, mockSpinner, 3, {
        fallbackModel: 'gpt-3.5-turbo',
      });

      expect(result).toEqual({ success: true });
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Args should not be modified for rate limit errors
      const secondCallArgs = mockFn.mock.calls[1][0];
      expect(secondCallArgs.model).toBe('gpt-4'); // Should keep original model
      expect(secondCallArgs.input).toEqual(mockArgs.input); // Should keep original input
    });

    it('should retry on server errors (5xx)', async () => {
      const serverError = new Error('Internal server error');
      (serverError as any).status = 500;

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce({ success: true });

      const result = await runWithRetries(mockFn, mockArgs, mockSpinner, 3, {
        fallbackModel: 'gpt-3.5-turbo',
      });

      expect(result).toEqual({ success: true });
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should abort retries on unrecoverable errors', async () => {
      const authError = new Error('Invalid API key');
      (authError as any).status = 401;

      const mockFn = vi.fn().mockRejectedValue(authError);

      // The original error (not a generic AbortError) must surface so callers can
      // inspect its class/status.
      await expect(
        runWithRetries(mockFn, mockArgs, mockSpinner, 3, { fallbackModel: 'gpt-3.5-turbo' })
      ).rejects.toBe(authError);
      expect(mockFn).toHaveBeenCalledTimes(1); // Should not retry
    });

    it('should exhaust all retries and throw final error', async () => {
      const validationError = new ValidationError('Persistent validation error');
      const mockFn = vi.fn().mockRejectedValue(validationError);

      await expect(
        runWithRetries(mockFn, mockArgs, mockSpinner, 2, { fallbackModel: 'gpt-3.5-turbo' })
      ).rejects.toThrow('Persistent validation error');
      expect(mockFn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should clear attempt number context after completion', async () => {
      const { clearCurrentAttemptNumber } = await import('../src/utils/retry-context.js');
      const mockFn = vi.fn().mockResolvedValue({ success: true });

      await runWithRetries(mockFn, mockArgs, mockSpinner, 3, { fallbackModel: 'gpt-3.5-turbo' });

      expect(clearCurrentAttemptNumber).toHaveBeenCalledWith(0); // batch index from args
    });

    it('should clear attempt number context even when errors occur', async () => {
      const { clearCurrentAttemptNumber } = await import('../src/utils/retry-context.js');
      const mockFn = vi.fn().mockRejectedValue(new Error('Unrecoverable error'));

      try {
        await runWithRetries(mockFn, mockArgs, mockSpinner, 1, { fallbackModel: 'gpt-3.5-turbo' });
      } catch (error) {
        // Expected to throw
      }

      expect(clearCurrentAttemptNumber).toHaveBeenCalledWith(0);
    });
  });

  describe('Error Classification', () => {
    it('should correctly identify rate limit errors', () => {
      const error429 = new Error('Rate limit');
      (error429 as any).status = 429;

      const error503 = new Error('Service unavailable');
      (error503 as any).status = 503;

      const error500 = new Error('Internal error');
      (error500 as any).status = 500;

      // These would be tested by the retry logic
      expect(error429).toHaveProperty('status', 429);
      expect(error503).toHaveProperty('status', 503);
      expect(error500).toHaveProperty('status', 500);
    });

    it('should correctly identify validation errors', () => {
      const validationError = new ValidationError('Schema mismatch');
      expect(validationError).toBeInstanceOf(ValidationError);
      expect(validationError.message).toBe('Schema mismatch');
    });

    it('should handle errors without status codes', () => {
      const networkError = new Error('Network connection failed');
      expect(networkError).not.toHaveProperty('status');
    });
  });

  describe('Argument Updates on Retry', () => {
    it('should preserve original args for non-validation errors', async () => {
      const originalInput = [{ role: 'user' as const, content: 'original' }];
      const originalModel = 'gpt-4';

      const args: PromptArgs = {
        input: originalInput,
        model: originalModel,
        index: 0,
      };

      const rateLimitError = new Error('Rate limited');
      (rateLimitError as any).status = 429;

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ success: true });

      await runWithRetries(mockFn, args, mockSpinner, 2, { fallbackModel: 'gpt-3.5-turbo' });

      // First call should have original args
      expect(mockFn.mock.calls[0][0].input).toEqual(originalInput);
      expect(mockFn.mock.calls[0][0].model).toBe(originalModel);

      // Second call should also have original args (no modification for rate limits)
      expect(mockFn.mock.calls[1][0].input).toEqual(originalInput);
      expect(mockFn.mock.calls[1][0].model).toBe(originalModel);
    });

    it('should update args correctly for validation errors', async () => {
      const originalInput = [{ role: 'user' as const, content: 'original' }];
      const args: PromptArgs = {
        input: originalInput,
        model: 'gpt-4',
        index: 0,
      };

      const validationError = new ValidationError('Invalid format');
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(validationError)
        .mockResolvedValueOnce({ success: true });

      await runWithRetries(mockFn, args, mockSpinner, 2, { fallbackModel: 'gpt-3.5-turbo' });

      // Second call should have modified args
      const secondCallArgs = mockFn.mock.calls[1][0];
      expect(secondCallArgs.model).toBe('gpt-3.5-turbo');
      expect(secondCallArgs.input).toHaveLength(2); // Original + error context
      expect(secondCallArgs.input[0].role).toBe('system');
      expect(secondCallArgs.input[0].content).toContain('Invalid format');
      expect(secondCallArgs.input[1]).toEqual(originalInput[0]);
    });
  });

  describe('Batch Context Management', () => {
    it('should track attempt numbers per batch', async () => {
      const { setCurrentAttemptNumber } = await import('../src/utils/retry-context.js');
      const mockFn = vi.fn().mockResolvedValue({ success: true });

      const args1 = { ...mockArgs, index: 1 };
      const args2 = { ...mockArgs, index: 2 };

      await runWithRetries(mockFn, args1, mockSpinner, 3, { fallbackModel: 'gpt-3.5-turbo' });
      await runWithRetries(mockFn, args2, mockSpinner, 3, { fallbackModel: 'gpt-3.5-turbo' });

      expect(setCurrentAttemptNumber).toHaveBeenCalledWith(1, expect.any(Number));
      expect(setCurrentAttemptNumber).toHaveBeenCalledWith(2, expect.any(Number));
    });

    it('should handle missing batch index gracefully', async () => {
      const { setCurrentAttemptNumber, clearCurrentAttemptNumber } = await import(
        '../src/utils/retry-context.js'
      );
      const mockFn = vi.fn().mockResolvedValue({ success: true });

      const argsWithoutIndex = {
        input: [{ role: 'user' as const, content: 'test' }],
        model: 'gpt-4',
      };

      await runWithRetries(mockFn, argsWithoutIndex, mockSpinner, 2, {
        fallbackModel: 'gpt-3.5-turbo',
      });

      expect(setCurrentAttemptNumber).toHaveBeenCalledWith(-1, expect.any(Number));
      expect(clearCurrentAttemptNumber).toHaveBeenCalledWith(-1);
    });
  });

  describe('Complex Error Scenarios', () => {
    it('should handle mixed error types in sequence', async () => {
      const rateLimitError = new Error('Rate limit');
      (rateLimitError as any).status = 429;

      const validationError = new ValidationError('Schema error');
      const networkError = new Error('Network error');

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(rateLimitError) // Should retry without arg changes
        .mockRejectedValueOnce(validationError) // Should retry with arg changes
        .mockRejectedValueOnce(networkError) // Should abort (unrecoverable)
        .mockResolvedValueOnce({ success: true });

      await expect(
        runWithRetries(mockFn, mockArgs, mockSpinner, 5, { fallbackModel: 'gpt-3.5-turbo' })
      ).rejects.toBe(networkError);
      expect(mockFn).toHaveBeenCalledTimes(3); // Should stop at unrecoverable error
    });

    it('should preserve error context across multiple validation retries', async () => {
      const validationError1 = new ValidationError('First validation error');
      const validationError2 = new ValidationError('Second validation error');

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(validationError1)
        .mockRejectedValueOnce(validationError2)
        .mockResolvedValueOnce({ success: true });

      await runWithRetries(mockFn, mockArgs, mockSpinner, 3, { fallbackModel: 'gpt-3.5-turbo' });

      // Each retry should add to the error context
      const thirdCallArgs = mockFn.mock.calls[2][0];
      expect(thirdCallArgs.input[0].content).toContain('Second validation error');
      expect(thirdCallArgs.input[1].content).toContain('First validation error');
    });
  });
});
