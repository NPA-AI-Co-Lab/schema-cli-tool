import { ZodError, ZodTypeAny } from 'zod';
import { ValidationErrorDetails } from '../jsonld/types.js';

/**
 * Arguments for validating processed results against the schema.
 * This interface encompasses the complete validation process including
 * both length validation and Zod schema validation.
 */
export interface ValidateResultsArgs {
  /** The processed output data to validate */
  output: AnalysisResult;

  /** Zod schema to validate the output structure against */
  zodSchema: ZodTypeAny;

  /** Optional function to log validation errors for debugging */
  logValidationError?: (error: ValidationErrorDetails) => Promise<void>;

  /** Optional function to parse and format Zod validation errors */
  parseZodError?: (
    zodError: ZodError,
    batchIndex: number,
    csvLineStart: number,
    csvLineEnd: number,
    originalData?: AnalysisResult,
    originalBatch?: Record<string, string>[],
    csvRowIndexes?: number[]
  ) => ValidationErrorDetails[];

  /** Index of the current batch being processed */
  index: number;

  /** Starting line number in the CSV file for this batch */
  csvLineStart: number;

  /** Number of records in the current batch */
  batchLength: number;

  /** Optional explicit CSV row indexes for each result in the current batch */
  csvRowIndexes?: number[];

  /** Whether required field validation errors should fail the batch */
  requiredFieldErrorsFailBatch?: boolean;
}

/**
 * Arguments for validating that the output contains the expected number of results.
 * This validation ensures the LLM processed all records in the batch correctly.
 */
export interface ValidateLengthArgs {
  /** The output data to check for correct length */
  output: AnalysisResult;

  /** Expected number of results based on input batch size */
  batchLength: number;

  /** Index of the current batch being processed */
  index: number;

  /** Starting line number in the CSV file for this batch */
  csvLineStart: number;

  /** Optional function to log validation errors */
  logValidationError?: (error: ValidationErrorDetails) => Promise<void>;
}

/**
 * Arguments for validating output data against the Zod schema.
 * This performs detailed field-level validation of the processed results.
 */
export interface ValidateZodSchemaArgs {
  /** The output data to validate against the schema */
  output: AnalysisResult;

  /** Zod schema defining the expected structure and constraints */
  zodSchema: ZodTypeAny;

  /** Optional function to log detailed validation errors */
  logValidationError?: (error: ValidationErrorDetails) => Promise<void>;

  /** Optional function to parse Zod errors into readable format */
  parseZodError?: (
    zodError: ZodError,
    batchIndex: number,
    csvLineStart: number,
    csvLineEnd: number,
    originalData?: AnalysisResult,
    originalBatch?: Record<string, string>[],
    csvRowIndexes?: number[]
  ) => ValidationErrorDetails[];

  /** Index of the current batch being processed */
  index: number;

  /** Starting line number in the CSV file for this batch */
  csvLineStart: number;

  /** Number of records in the current batch */
  batchLength: number;

  /** Optional original batch data for error context */
  originalBatch?: Record<string, string>[];

  /** Optional explicit CSV row indexes for each result in the current batch */
  csvRowIndexes?: number[];
}
