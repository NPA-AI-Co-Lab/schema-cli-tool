import { ILLMClient, LLMAnalysisRequest } from '../interfaces/llm-client.interface.js';
import { ZodError, ZodTypeAny } from 'zod';
import { ValidateResultsArgs } from './types.js';
import {
  validateRequiredFields,
  ValidationErrorDetails,
  ValidationErrorDetails as JsonLdValidationErrorDetails,
} from '../jsonld/index.js';
import { validateLength, validateZodSchema } from './validation.js';
import { DeterministicFieldResult } from './rules/types.js';
import { RetryAttemptDetails } from '../logging.js';

/**
 * Arguments for result decoding
 */
export interface DecodeResultsArgs {
  rawOutput: Record<string, unknown>;
  decodePII: (
    encodedRecords: Record<string, unknown>,
    encodingMap: EncodingMap
  ) => Record<string, unknown>;
  encodingMap: EncodingMap;
}

/**
 * Arguments for analysis processing
 */
export interface ProcessBatchArgs {
  llmClient?: ILLMClient;
  instructions: string;
  zodSchema: ZodTypeAny;
  batchLength: number;
  index: number;
  input: Array<{ role: 'user' | 'system' | 'assistant'; content: string }>;
  model: string;
  logValidationError?: (error: ValidationErrorDetails) => Promise<void>;
  parseZodError?: (
    error: ZodError,
    batchIndex: number,
    csvLineStart: number,
    csvLineEnd: number,
    originalData?: Record<string, unknown>,
    originalBatch?: Record<string, string>[],
    csvRowIndexes?: number[]
  ) => ValidationErrorDetails[];
  logRetryAttempt?: (details: RetryAttemptDetails) => Promise<void>;
  csvLineStart: number;
  decodePII: (
    encodedRecords: Record<string, unknown>,
    encodingMap: EncodingMap
  ) => Record<string, unknown>;
  encodingMap: EncodingMap;
  requiredFieldErrorsFailBatch?: boolean;
  prefills?: DeterministicFieldResult[];
  temperature?: number;
  csvRowIndexes?: number[];
}

/**
 * Adapt ValidationErrorDetails from JsonLD format to Analysis format
 */
function adaptValidationError(
  jsonldError: JsonLdValidationErrorDetails,
  csvLineStart: number,
  batchSize: number
): ValidationErrorDetails {
  return {
    batchIndex: jsonldError.batchIndex,
    csvLineStart: csvLineStart,
    csvLineEnd: csvLineStart + batchSize - 1,
    fieldPath: jsonldError.fieldPath,
    errorMessage: jsonldError.errorMessage,
    expectedType: jsonldError.expectedType,
    actualValue: jsonldError.actualValue,
    csvRowIndex: jsonldError.csvRowIndex,
  };
}

function mergeDeep(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = value;
      continue;
    }

    if (value !== null && typeof value === 'object') {
      const existing = result[key];
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        result[key] = mergeDeep(
          existing as Record<string, unknown>,
          value as Record<string, unknown>
        );
      } else {
        result[key] = mergeDeep({}, value as Record<string, unknown>);
      }
      continue;
    }

    result[key] = value;
  }

  return result;
}

function canSkipLLM(
  prefills: DeterministicFieldResult[] | undefined,
  batchLength: number
): boolean {
  if (!prefills || prefills.length !== batchLength) {
    return false;
  }

  return prefills.every((prefill) => prefill.pendingFields.size === 0);
}

function buildDeterministicOutput(prefills: DeterministicFieldResult[]): Record<string, unknown> {
  const results = prefills.map((prefill) => prefill.mapped);
  return { results };
}

function mergeDeterministicResults(
  results: Record<string, unknown>[] | undefined,
  prefills: DeterministicFieldResult[] | undefined
): Record<string, unknown>[] {
  if (!results || !prefills || prefills.length !== results.length) {
    return results ?? [];
  }

  return results.map((result, index) => {
    const deterministic = prefills[index];
    if (!deterministic) {
      return result;
    }
    return mergeDeep(result ?? {}, deterministic.mapped);
  });
}

/**
 * Fetch analysis results using the LLM client
 */
export async function fetchAnalysis(
  llmClient: ILLMClient,
  instructions: string,
  input: Array<{ role: 'user' | 'system' | 'assistant'; content: string }>,
  model: string,
  zodSchema: ZodTypeAny,
  temperature?: number
): Promise<Record<string, unknown>> {
  const request: LLMAnalysisRequest = {
    instructions,
    input: input.map((msg) => ({
      role: msg.role as 'user' | 'system' | 'assistant',
      content: msg.content,
    })),
    model,
    zodSchema,
    temperature,
  };

  const response = await llmClient.analyze(request);
  return response.result;
}

/**
 * Decode PII-protected results
 */
export function decodeResults(args: DecodeResultsArgs): Record<string, unknown> {
  const { rawOutput, decodePII, encodingMap } = args;
  return decodePII(rawOutput, encodingMap);
}

/**
 * Validate analysis results
 */
export async function validateResults(
  args: ValidateResultsArgs
): Promise<Record<string, string>[]> {
  const {
    output,
    zodSchema,
    logValidationError,
    parseZodError,
    index,
    csvLineStart,
    batchLength,
    requiredFieldErrorsFailBatch = false,
    csvRowIndexes,
  } = args;

  await validateLength({
    output,
    batchLength,
    index,
    csvLineStart,
    logValidationError,
  });

  const canValidate = logValidationError && output.results && Array.isArray(output.results);
  if (canValidate) {
    const adaptedLogValidationError = async (jsonldError: JsonLdValidationErrorDetails) => {
      const analysisError = adaptValidationError(jsonldError, csvLineStart, batchLength);
      await logValidationError!(analysisError);
    };

    await validateRequiredFields(
      output.results as Record<string, unknown>[],
      index,
      csvLineStart,
      adaptedLogValidationError,
      requiredFieldErrorsFailBatch,
      csvRowIndexes
    );
  }

  const validatedResults = await validateZodSchema({
    output,
    zodSchema,
    logValidationError,
    parseZodError,
    index,
    csvLineStart,
    batchLength,
    csvRowIndexes,
  });

  return validatedResults;
}

/**
 * Process a single batch of data
 */
export async function processBatch(args: ProcessBatchArgs): Promise<Record<string, unknown>[]> {
  const {
    llmClient,
    instructions,
    zodSchema,
    batchLength,
    index,
    input,
    model,
    logValidationError,
    parseZodError,
    csvLineStart,
    decodePII,
    encodingMap,
    requiredFieldErrorsFailBatch,
    prefills,
    temperature,
    csvRowIndexes,
  } = args;

  const useDeterministicOnly = canSkipLLM(prefills, batchLength);

  let rawOutput: Record<string, unknown>;

  if (useDeterministicOnly && prefills) {
    rawOutput = buildDeterministicOutput(prefills);
  } else {
    if (!llmClient) {
      throw new Error('LLM client is not configured');
    }
    rawOutput = await fetchAnalysis(llmClient, instructions, input, model, zodSchema, temperature);
  }

  // Decode PII if needed
  const output = decodeResults({
    rawOutput,
    decodePII,
    encodingMap,
  });

  if (useDeterministicOnly && prefills) {
    // Decode deterministic results before returning
    const deterministicResults = prefills.map((prefill) => prefill.mapped);
    const decoded = deterministicResults.map((result) => decodePII(result, encodingMap));
    return decoded;
  }

  const validateArgs: ValidateResultsArgs & { failOnSchemaError?: boolean } = {
    output,
    zodSchema,
    logValidationError,
    parseZodError,
    index,
    csvLineStart,
    batchLength,
    csvRowIndexes,
    requiredFieldErrorsFailBatch,
    failOnSchemaError: !!requiredFieldErrorsFailBatch,
  };

  const validated = await validateResults(validateArgs);

  // NOW merge deterministic results after validation
  if (prefills) {
    // Decode deterministic prefills before merging
    const decodedPrefills = prefills.map((prefill) => ({
      ...prefill,
      mapped: decodePII(prefill.mapped, encodingMap),
    }));
    const merged = mergeDeterministicResults(validated, decodedPrefills);
    return merged;
  }

  return validated;
}
