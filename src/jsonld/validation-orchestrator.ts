import { ValidationError } from '../utils/errors.js';
import { ValidationErrorDetails } from './types.js';
import { validateObjectRecursively } from './validation-traversal.js';

/**
 * Validate required fields in batch results
 */
export async function validateRequiredFields(
  results: Record<string, unknown>[],
  batchIndex: number,
  csvLineStart: number,
  logValidationError: (error: ValidationErrorDetails) => Promise<void>,
  shouldFailBatch: boolean = false,
  csvRowIndexes?: number[]
): Promise<void> {
  const errorCount = await countRequiredFieldErrors(
    results,
    batchIndex,
    csvLineStart,
    logValidationError,
    csvRowIndexes
  );

  if (shouldFailBatch && errorCount > 0) {
    throwValidationError(batchIndex, errorCount);
  }
}

/**
 * Count required field errors in results
 */
async function countRequiredFieldErrors(
  results: Record<string, unknown>[],
  batchIndex: number,
  csvLineStart: number,
  logValidationError: (error: ValidationErrorDetails) => Promise<void>,
  csvRowIndexes?: number[]
): Promise<number> {
  let totalErrors = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const csvRowIndex = csvRowIndexes?.[i] ?? csvLineStart + i;
    const errorsInResult = await validateSingleResult(
      result,
      batchIndex,
      csvRowIndex,
      logValidationError
    );
    totalErrors += errorsInResult;
  }

  return totalErrors;
}

/**
 * Validate single result object
 */
async function validateSingleResult(
  result: Record<string, unknown>,
  batchIndex: number,
  csvRowIndex: number,
  logValidationError: (error: ValidationErrorDetails) => Promise<void>
): Promise<number> {
  return await validateObjectRecursively(result, batchIndex, csvRowIndex, '', logValidationError);
}

/**
 * Throw validation error for batch
 */
function throwValidationError(batchIndex: number, errorCount: number): never {
  throw new ValidationError(
    `Batch ${batchIndex}: ${errorCount} required field validation errors found`
  );
}
