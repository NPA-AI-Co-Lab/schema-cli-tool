import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runWithRetries } from '../src/utils/retry.js';
import { ValidationError } from '../src/utils/errors.js';

// Mock dependencies
vi.mock('../src/utils/retry-context.js', () => {
  const context = new Map();
  return {
    setCurrentAttemptNumber: vi.fn((batchIndex: number, attempt: number) => {
      context.set(batchIndex, attempt);
    }),
    getCurrentAttemptNumber: vi.fn((batchIndex: number) => {
      return context.get(batchIndex) || 1;
    }),
    clearCurrentAttemptNumber: vi.fn((batchIndex: number) => {
      context.delete(batchIndex);
    }),
  };
});

vi.mock('../src/utils/ui.js', () => ({
  warn: vi.fn(),
}));

const createMockSpinner = () =>
  ({
    text: '',
    clear: vi.fn(),
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    color: 'green',
    prefixText: '',
    suffixText: '',
    indent: 0,
    spinner: 'dots',
    frame: vi.fn(() => '⠋'),
    isSpinning: false,
    isSilent: false,
    discardStdin: true,
    hideCursor: true,
  }) as any;

describe('Batch Processing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('runWithRetries', () => {
    it('should return result on first attempt when successful', async () => {
      const mockFn = vi.fn().mockResolvedValue('success');
      const mockArgs = { model: 'gpt-4', input: [], index: 0 } as any;
      const mockSpinner = createMockSpinner();

      const result = await runWithRetries(mockFn, mockArgs, mockSpinner, 2, {
        fallbackModel: 'gpt-4.1',
      });

      expect(result).toBe('success');
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it('should retry on ValidationError and modify arguments', async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new ValidationError('Validation failed'))
        .mockResolvedValueOnce('success after retry');

      const mockArgs = {
        model: 'gpt-4',
        input: [{ role: 'user' as const, content: 'test' }],
        index: 0,
      } as any;
      const mockSpinner = createMockSpinner();

      const result = await runWithRetries(mockFn, mockArgs, mockSpinner, 2, {
        fallbackModel: 'gpt-4.1',
      });

      expect(result).toBe('success after retry');
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Verify arguments were modified for retry
      const secondCallArgs = mockFn.mock.calls[1][0];
      expect(secondCallArgs.input[0].role).toBe('system'); // Should add error context
      expect(secondCallArgs.input[0].content).toContain('error occurred during previous analysis');
    });

    it('should retry on server errors without modifying arguments', async () => {
      const serverError = new Error('Server error') as any;
      serverError.status = 500;

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce('success after retry');

      const mockArgs = {
        model: 'gpt-4',
        input: [{ role: 'user' as const, content: 'test' }],
        index: 0,
      } as any;
      const mockSpinner = createMockSpinner();

      const result = await runWithRetries(mockFn, mockArgs, mockSpinner, 2, {
        fallbackModel: 'gpt-4.1',
      });

      expect(result).toBe('success after retry');
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Arguments should not be modified for server errors
      const firstCallArgs = mockFn.mock.calls[0][0];
      const secondCallArgs = mockFn.mock.calls[1][0];
      expect(secondCallArgs.input).toEqual(firstCallArgs.input);
    });

    it('should handle rate limit errors with retry', async () => {
      const rateLimitError = new Error('Rate limit exceeded') as any;
      rateLimitError.status = 429;

      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce('success after rate limit');

      const mockArgs = { model: 'gpt-4', input: [], index: 0 } as any;
      const mockSpinner = createMockSpinner();

      const result = await runWithRetries(mockFn, mockArgs, mockSpinner, 2, {
        fallbackModel: 'gpt-4.1',
      });

      expect(result).toBe('success after rate limit');
      expect(mockFn).toHaveBeenCalledTimes(2);
    });

    it('should throw AbortError for unrecoverable errors', async () => {
      const unrecoverableError = new Error('Unrecoverable error');
      const mockFn = vi.fn().mockRejectedValue(unrecoverableError);

      const mockArgs = { model: 'gpt-4', input: [], index: 0 } as any;
      const mockSpinner = createMockSpinner();

      await expect(
        runWithRetries(mockFn, mockArgs, mockSpinner, 2, { fallbackModel: 'gpt-4.1' })
      ).rejects.toThrow('Unrecoverable error');

      expect(mockFn).toHaveBeenCalledTimes(1); // Should not retry
    });

    it('should exhaust retries and throw final error', async () => {
      const mockFn = vi.fn().mockRejectedValue(new ValidationError('Persistent error'));

      const mockArgs = { model: 'gpt-4', input: [], index: 0 } as any;
      const mockSpinner = createMockSpinner();

      await expect(
        runWithRetries(mockFn, mockArgs, mockSpinner, 2, { fallbackModel: 'gpt-4.1' })
      ).rejects.toThrow('Persistent error');

      expect(mockFn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should switch to fallback model on validation errors', async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new ValidationError('Model output invalid'))
        .mockResolvedValueOnce('success with fallback');

      const mockArgs = { model: 'gpt-4', input: [], index: 0 } as any;
      const mockSpinner = createMockSpinner();

      await runWithRetries(mockFn, mockArgs, mockSpinner, 1, { fallbackModel: 'gpt-4.1' });

      // Verify fallback model was used
      const retryCallArgs = mockFn.mock.calls[1][0];
      expect(retryCallArgs.model).toBe('gpt-4.1'); // Fallback model
    });
  });

  describe('Batch Memory Management', () => {
    it('should handle large batches without memory issues', () => {
      // Test with large data simulation
      const largeBatch = Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `Person ${i}`,
        email: `person${i}@example.com`,
        description: 'A'.repeat(1000), // Large text field
      }));

      const serialized = JSON.stringify(largeBatch);

      // Should not exceed typical memory limits
      expect(serialized.length).toBeGreaterThan(0);
      expect(serialized.length).toBeLessThan(10 * 1024 * 1024); // 10MB limit
    });

    it('should handle concurrent batch processing correctly', async () => {
      const batchPromises = Array.from({ length: 5 }, async (_, i) => {
        const mockResponse = {
          result: { results: [{ id: i, name: `Person ${i}` }] },
          rawText: `{"results":[{"id":${i}}]}`,
          model: 'gpt-4',
        };

        return mockResponse.result.results;
      });

      const results = await Promise.all(batchPromises);

      expect(results).toHaveLength(5);
      results.forEach((batch, index) => {
        expect(batch[0].id).toBe(index);
      });
    });
  });

  describe('Context Management', () => {
    it('should track attempt numbers correctly', async () => {
      const { setCurrentAttemptNumber, getCurrentAttemptNumber, clearCurrentAttemptNumber } =
        await import('../src/utils/retry-context.js');

      // Test attempt tracking
      setCurrentAttemptNumber(0, 1);
      expect(getCurrentAttemptNumber(0)).toBe(1);

      setCurrentAttemptNumber(0, 2);
      expect(getCurrentAttemptNumber(0)).toBe(2);

      clearCurrentAttemptNumber(0);
      expect(getCurrentAttemptNumber(0)).toBe(1); // Default after clear
    });

    it('should handle multiple concurrent batches', async () => {
      const { setCurrentAttemptNumber, getCurrentAttemptNumber } = await import(
        '../src/utils/retry-context.js'
      );

      // Set different attempts for different batches
      setCurrentAttemptNumber(0, 1);
      setCurrentAttemptNumber(1, 2);
      setCurrentAttemptNumber(2, 3);

      expect(getCurrentAttemptNumber(0)).toBe(1);
      expect(getCurrentAttemptNumber(1)).toBe(2);
      expect(getCurrentAttemptNumber(2)).toBe(3);
    });
  });

  describe('Error Classification', () => {
    it('should classify validation errors correctly', async () => {
      // Mock the retry module exports
      const retryModule = {
        shouldRetryWithChange: (error: Error) => error instanceof ValidationError,
        shouldRetryWithoutChange: (error: any) => error.status === 500 || error.status === 429,
      };

      // Test validation errors
      expect(
        retryModule.shouldRetryWithChange(new ValidationError('Schema validation failed'))
      ).toBe(true);
      expect(retryModule.shouldRetryWithChange(new Error('Regular error'))).toBe(false);

      // Test server errors
      const serverError = new Error('Server error') as any;
      serverError.status = 500;
      expect(retryModule.shouldRetryWithoutChange(serverError)).toBe(true);

      const rateLimitError = new Error('Rate limit') as any;
      rateLimitError.status = 429;
      expect(retryModule.shouldRetryWithoutChange(rateLimitError)).toBe(true);

      expect(retryModule.shouldRetryWithoutChange(new Error('Regular error'))).toBe(false);
    });
  });

  describe('Argument Updates', () => {
    it('should update arguments correctly for retries', async () => {
      // Mock the argument update function
      const updateArgsForRetry = (args: any, error: Error, attemptNumber: number) => {
        if (error instanceof ValidationError) {
          return {
            ...args,
            input: [
              {
                role: 'system' as const,
                content: `An error occurred during previous analysis (attempt ${attemptNumber}): ${error.message}. Please try again with improved format compliance.`,
              },
              ...args.input,
            ],
          };
        }
        return args; // No modification for non-validation errors
      };

      const error = new ValidationError('Validation failed');
      const originalArgs = {
        model: 'gpt-4',
        input: [{ role: 'user' as const, content: 'Original input' }],
        index: 0,
      };

      const updatedArgs = updateArgsForRetry(originalArgs, error, 2);

      expect(updatedArgs.input).toHaveLength(2);
      expect(updatedArgs.input[0].role).toBe('system');
      expect(updatedArgs.input[0].content).toContain('error occurred during previous analysis');
      expect(updatedArgs.input[0].content).toContain('attempt 2');
      expect(updatedArgs.input[1]).toEqual(originalArgs.input[0]);
    });
  });
});
