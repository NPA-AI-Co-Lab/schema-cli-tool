import { ValidationError } from '../utils/index.js';
import { ValidateLengthArgs, ValidateZodSchemaArgs } from './types.js';

/**
 * Validate that output has expected length
 */
export async function validateLength(args: ValidateLengthArgs): Promise<void> {
  const { output, batchLength, index, csvLineStart, logValidationError } = args;

  const outputLength = output?.results?.length ?? 0;

  if (outputLength !== batchLength) {
    if (logValidationError) {
      const batchLengthError = {
        batchIndex: index,
        csvLineStart,
        csvLineEnd: csvLineStart + batchLength - 1,
        fieldPath: 'results',
        errorMessage: `Expected ${batchLength} results, got ${outputLength}`,
        expectedType: `array of length ${batchLength}`,
        actualValue: `array of length ${outputLength}`,
        csvRowIndex: csvLineStart,
      };

      await logValidationError(batchLengthError);
    }

    throw new ValidationError(
      `Batch ${index}: expected ${batchLength} results, got ${outputLength}`
    );
  }
}

/**
 * Validate output against Zod schema
 */
export async function validateZodSchema(
  args: ValidateZodSchemaArgs & { failOnSchemaError?: boolean }
): Promise<Record<string, string>[]> {
  const {
    output,
    zodSchema,
    logValidationError,
    parseZodError,
    index,
    csvLineStart,
    batchLength,
    csvRowIndexes,
  } = args;

  const check = zodSchema.safeParse(output);
  if (!check.success) {
    const shouldLogValidationErrors = logValidationError && parseZodError;

    if (shouldLogValidationErrors) {
      const csvLineEnd = csvLineStart + batchLength - 1;
      const validationErrors = parseZodError(
        check.error,
        index,
        csvLineStart,
        csvLineEnd,
        output,
        undefined,
        csvRowIndexes
      );
      for (const error of validationErrors) {
        await logValidationError(error);
      }
    }

    throw new ValidationError(`Batch ${index}: Zod validation failed: ${check.error.message}`);
  }

  return check.data.results;
}
