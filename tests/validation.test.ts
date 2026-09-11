import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ValidationError } from '../src/utils/errors.js';
import { validateLength, validateZodSchema } from '../src/analysis/validation.js';
import { validateRequiredFields } from '../src/jsonld/validation-orchestrator.js';
import { z } from 'zod';
import type { ValidationErrorDetails } from '../src/jsonld/types.js';

// Mock the utils/index.js module to avoid basePath issues
vi.mock('../src/utils/index.js', async () => {
  const actual = await vi.importActual('../src/utils/index.js');
  return {
    ...actual,
    basePath: '/mock/path',
    loadJSON: vi.fn(() => ({})),
  };
});

// Mock the file system module
vi.mock('../src/utils/file-system.js', () => ({
  basePath: '/mock/path',
  loadJSON: vi.fn(() => ({})),
}));

// Mock the jsonld modules that depend on basePath
vi.mock('../src/jsonld/taxonomy.js', () => ({
  getTaxonomy: vi.fn(() => []),
  validateWithTaxonomy: vi.fn(() => true),
}));

describe('Validation', () => {
  describe('validateLength', () => {
    let logValidationError: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      logValidationError = vi.fn();
    });

    it('should pass when output length matches expected batch length', async () => {
      const args = {
        output: { results: [{ id: 1 }, { id: 2 }, { id: 3 }] },
        batchLength: 3,
        index: 0,
        csvLineStart: 1,
        logValidationError,
      };

      await expect(validateLength(args)).resolves.toBeUndefined();
      expect(logValidationError).not.toHaveBeenCalled();
    });

    it('should throw ValidationError when lengths do not match', async () => {
      const args = {
        output: { results: [{ id: 1 }, { id: 2 }] },
        batchLength: 3,
        index: 0,
        csvLineStart: 1,
        logValidationError,
      };

      await expect(validateLength(args)).rejects.toThrow(ValidationError);
      await expect(validateLength(args)).rejects.toThrow('Batch 0: expected 3 results, got 2');
    });

    it('should log validation error when logging is enabled', async () => {
      const args = {
        output: { results: [{ id: 1 }] },
        batchLength: 2,
        index: 1,
        csvLineStart: 10,
        logValidationError,
      };

      try {
        await validateLength(args);
      } catch (error) {
        // Expected to throw
      }

      expect(logValidationError).toHaveBeenCalledWith({
        batchIndex: 1,
        csvLineStart: 10,
        csvLineEnd: 11,
        fieldPath: 'results',
        errorMessage: 'Expected 2 results, got 1',
        expectedType: 'array of length 2',
        actualValue: 'array of length 1',
        csvRowIndex: 10,
      });
    });

    it('should handle missing results array', async () => {
      const args = {
        output: {},
        batchLength: 2,
        index: 0,
        csvLineStart: 1,
        logValidationError,
      };

      await expect(validateLength(args)).rejects.toThrow('expected 2 results, got 0');
    });

    it('should handle null output', async () => {
      const args = {
        output: null as any,
        batchLength: 1,
        index: 0,
        csvLineStart: 1,
        logValidationError,
      };

      await expect(validateLength(args)).rejects.toThrow('expected 1 results, got 0');
    });
  });

  describe('validateZodSchema', () => {
    let logValidationError: ReturnType<typeof vi.fn>;
    let parseZodError: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      logValidationError = vi.fn();
      parseZodError = vi.fn().mockReturnValue([
        {
          batchIndex: 0,
          csvLineStart: 1,
          csvLineEnd: 3,
          fieldPath: 'results.0.name',
          errorMessage: 'Expected string, received number',
          expectedType: 'string',
          actualValue: 123,
          csvRowIndex: 1,
        },
      ]);
    });

    it('should return data when validation passes', async () => {
      const schema = z.object({
        results: z.array(
          z.object({
            name: z.string(),
            age: z.number(),
          })
        ),
      });

      const validOutput = {
        results: [
          { name: 'John Doe', age: 30 },
          { name: 'Jane Smith', age: 25 },
        ],
      };

      const args = {
        output: validOutput,
        zodSchema: schema,
        logValidationError,
        parseZodError,
        index: 0,
        csvLineStart: 1,
        batchLength: 2,
      };

      const result = await validateZodSchema(args);
      expect(result).toEqual(validOutput.results);
      expect(logValidationError).not.toHaveBeenCalled();
      expect(parseZodError).not.toHaveBeenCalled();
    });

    it('should throw ValidationError when schema validation fails', async () => {
      const schema = z.object({
        results: z.array(
          z.object({
            name: z.string(),
            age: z.number(),
          })
        ),
      });

      const invalidOutput = {
        results: [
          { name: 123, age: 'thirty' }, // Wrong types
        ],
      };

      const args = {
        output: invalidOutput,
        zodSchema: schema,
        logValidationError,
        parseZodError,
        index: 0,
        csvLineStart: 1,
        batchLength: 1,
      };

      await expect(validateZodSchema(args)).rejects.toThrow(ValidationError);
      await expect(validateZodSchema(args)).rejects.toThrow('Batch 0: Zod validation failed');
    });

    it('should log validation errors when logging is enabled', async () => {
      const schema = z.object({
        results: z.array(
          z.object({
            name: z.string(),
          })
        ),
      });

      const invalidOutput = {
        results: [{ name: 123 }],
      };

      const args = {
        output: invalidOutput,
        zodSchema: schema,
        logValidationError,
        parseZodError,
        index: 1,
        csvLineStart: 5,
        batchLength: 1,
        csvRowIndexes: undefined,
      };

      try {
        await validateZodSchema(args);
      } catch (error) {
        // Expected to throw
      }

      expect(parseZodError).toHaveBeenCalledWith(
        expect.any(Object), // ZodError
        1, // index
        5, // csvLineStart
        5, // csvLineEnd (csvLineStart + batchLength - 1)
        invalidOutput,
        undefined, // extra argument
        undefined // csvRowIndexes
      );
      expect(logValidationError).toHaveBeenCalledWith(
        expect.objectContaining({
          batchIndex: 0,
          fieldPath: 'results.0.name',
          errorMessage: 'Expected string, received number',
        })
      );
    });

    it('should not log when logging is disabled', async () => {
      const schema = z.object({
        results: z.array(z.object({ name: z.string() })),
      });

      const args = {
        output: { results: [{ name: 123 }] },
        zodSchema: schema,
        logValidationError: undefined, // No logging
        parseZodError,
        index: 0,
        csvLineStart: 1,
        batchLength: 1,
      };

      try {
        await validateZodSchema(args);
      } catch (error) {
        // Expected to throw
      }

      expect(parseZodError).not.toHaveBeenCalled();
    });
  });

  describe('validateRequiredFields', () => {
    let logValidationError: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      logValidationError = vi.fn();
    });

    it('should not throw when shouldFailBatch is false', async () => {
      const results = [
        {
          Person: {
            name: { value: null, present: false }, // Missing required field
            email: { value: 'john@example.com', present: true },
          },
        },
      ];

      await expect(
        validateRequiredFields(results, 0, 1, logValidationError, false)
      ).resolves.toBeUndefined();

      // Should still log the error
      expect(logValidationError).toHaveBeenCalled();
    });

    it('should throw ValidationError when shouldFailBatch is true and errors exist', async () => {
      const results = [
        {
          Person: {
            name: { value: null, present: false }, // Missing required field
            email: { value: 'john@example.com', present: true },
          },
        },
      ];

      await expect(validateRequiredFields(results, 0, 1, logValidationError, true)).rejects.toThrow(
        ValidationError
      );

      await expect(validateRequiredFields(results, 0, 1, logValidationError, true)).rejects.toThrow(
        'required field validation errors found'
      );
    });

    it('should pass when all required fields are present', async () => {
      const results = [
        {
          Person: {
            name: { value: 'John Doe', present: true },
            email: { value: 'john@example.com', present: true },
          },
        },
      ];

      await expect(
        validateRequiredFields(results, 0, 1, logValidationError, true)
      ).resolves.toBeUndefined();

      expect(logValidationError).not.toHaveBeenCalled();
    });

    it('should handle multiple results with mixed validation states', async () => {
      const results = [
        {
          Person: {
            name: { value: 'John Doe', present: true },
            email: { value: 'john@example.com', present: true },
          },
        },
        {
          Person: {
            name: { value: null, present: false }, // Missing required field
            email: { value: 'jane@example.com', present: true },
          },
        },
      ];

      // Should log error for second result but not fail batch
      await expect(
        validateRequiredFields(results, 0, 1, logValidationError, false)
      ).resolves.toBeUndefined();

      expect(logValidationError).toHaveBeenCalledTimes(1);
    });

    it('should handle empty results array', async () => {
      await expect(
        validateRequiredFields([], 0, 1, logValidationError, true)
      ).resolves.toBeUndefined();

      expect(logValidationError).not.toHaveBeenCalled();
    });
  });

  describe('Validation Error Details', () => {
    it('should create properly structured validation error details', () => {
      const error: ValidationErrorDetails = {
        batchIndex: 1,
        csvLineStart: 10,
        csvLineEnd: 12,
        fieldPath: 'Person.name',
        errorMessage: 'Required field is missing',
        expectedType: 'string',
        actualValue: null,
        csvRowIndex: 11,
        attemptNumber: 2,
      };

      expect(error.batchIndex).toBe(1);
      expect(error.csvLineStart).toBe(10);
      expect(error.csvLineEnd).toBe(12);
      expect(error.fieldPath).toBe('Person.name');
      expect(error.errorMessage).toBe('Required field is missing');
      expect(error.expectedType).toBe('string');
      expect(error.actualValue).toBeNull();
      expect(error.csvRowIndex).toBe(11);
      expect(error.attemptNumber).toBe(2);
    });
  });

  describe('Error Handling Edge Cases', () => {
    it('should handle malformed output gracefully', async () => {
      const args = {
        output: { results: 'not an array' as any },
        batchLength: 1,
        index: 0,
        csvLineStart: 1,
        logValidationError: vi.fn(),
      };

      await expect(validateLength(args)).rejects.toThrow(ValidationError);
    });

    it('should handle undefined output', async () => {
      const args = {
        output: undefined as any,
        batchLength: 1,
        index: 0,
        csvLineStart: 1,
        logValidationError: vi.fn(),
      };

      await expect(validateLength(args)).rejects.toThrow(ValidationError);
    });

    it('should handle complex nested validation failures', async () => {
      const schema = z.object({
        results: z.array(
          z.object({
            person: z.object({
              name: z.string(),
              contacts: z.array(
                z.object({
                  email: z.string().email(),
                })
              ),
            }),
          })
        ),
      });

      const invalidOutput = {
        results: [
          {
            person: {
              name: 123, // Invalid
              contacts: [
                { email: 'invalid-email' }, // Invalid email
                { email: 'valid@example.com' },
              ],
            },
          },
        ],
      };

      const args = {
        output: invalidOutput,
        zodSchema: schema,
        logValidationError: vi.fn(),
        parseZodError: vi.fn().mockReturnValue([]),
        index: 0,
        csvLineStart: 1,
        batchLength: 1,
      };

      await expect(validateZodSchema(args)).rejects.toThrow(ValidationError);
    });
  });
});
