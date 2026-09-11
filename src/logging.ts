import { appendFile, mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { basePath, getCurrentAttemptNumber } from './utils/index.js';
import pLimit from 'p-limit';
import { ZodError } from 'zod';
import { ValidationErrorDetails } from './jsonld/index.js';
import { writeStderrLine } from './utils/ui.js';

const LOG_DIR = path.join(basePath, 'logging');
const VALIDATION_LOG_DIR = path.join(LOG_DIR, 'validation_errors');
const LLM_INPUT_LOG_DIR = path.join(LOG_DIR, 'llm_input');
const RETRY_LOG_DIR = path.join(LOG_DIR, 'retry_attempts');
const BATCH_OUTCOME_LOG_DIR = path.join(LOG_DIR, 'batch_outcomes');
const UUID_LOG_DIR = path.join(LOG_DIR, 'uuid_generation');
const WRITE_LIMIT = pLimit(1);

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = path.join(LLM_INPUT_LOG_DIR, `llm_input_${timestamp}.log`);
const validationLogFile = path.join(VALIDATION_LOG_DIR, `validation_errors_${timestamp}.log`);
const retryLogFile = path.join(RETRY_LOG_DIR, `retry_attempts_${timestamp}.log`);
const batchOutcomeLogFile = path.join(BATCH_OUTCOME_LOG_DIR, `batch_outcomes_${timestamp}.log`);
const uuidLogFile = path.join(UUID_LOG_DIR, `uuid_generation_${timestamp}.log`);

const pendingWrites: Promise<void>[] = [];

async function initLogFile() {
  await mkdir(LLM_INPUT_LOG_DIR, { recursive: true });
  await mkdir(VALIDATION_LOG_DIR, { recursive: true });
  await mkdir(RETRY_LOG_DIR, { recursive: true });
  await mkdir(BATCH_OUTCOME_LOG_DIR, { recursive: true });
  await mkdir(UUID_LOG_DIR, { recursive: true });
  await writeFile(logFile, '');
  await writeFile(validationLogFile, '');
  await writeFile(retryLogFile, '');
  await writeFile(batchOutcomeLogFile, '');
  await writeFile(uuidLogFile, '');
}

await initLogFile();

function asyncAppendFile(filePath: string, data: string) {
  const writePromise = WRITE_LIMIT(() => appendFile(filePath, data));
  pendingWrites.push(writePromise);

  writePromise.finally(() => {
    const index = pendingWrites.indexOf(writePromise);
    if (index !== -1) pendingWrites.splice(index, 1);
  });

  return writePromise;
}

function log(batchIndex: number, records: Record<string, string>[], batchSize: number) {
  const startLine = batchIndex * batchSize;
  const endLine = startLine + records.length - 1;

  const logEntry = {
    batchIndex,
    lineRange: [startLine, endLine],
    records,
  };

  return asyncAppendFile(logFile, JSON.stringify(logEntry, null, 2) + '\n');
}

function getMeaningfulFieldPath(fieldPath: string): string {
  const pathParts = fieldPath.split('.');
  const isResultsArrayPath =
    pathParts.length >= 3 && pathParts[0] === 'results' && !isNaN(Number(pathParts[1]));

  if (isResultsArrayPath) {
    return pathParts.slice(2).join('.');
  }

  return fieldPath;
}

function emitValidationWarning(errorDetails: ValidationErrorDetails) {
  const meaningfulPath = getMeaningfulFieldPath(errorDetails.fieldPath);
  const attemptNumber =
    errorDetails.attemptNumber || getCurrentAttemptNumber(errorDetails.batchIndex);
  const location =
    errorDetails.filePath && errorDetails.fileCsvLine !== undefined
      ? `file ${errorDetails.filePath}, line ${errorDetails.fileCsvLine}`
      : errorDetails.csvRowIndex !== undefined
        ? `line ${errorDetails.csvRowIndex}`
        : `lines ${errorDetails.csvLineStart}-${errorDetails.csvLineEnd}`;
  const attemptSuffix = attemptNumber ? `, attempt ${attemptNumber}` : '';
  const uuidSuffix = errorDetails.uuid ? `, uuid ${errorDetails.uuid}` : '';

  writeStderrLine(
    `WARNING: ${location}${uuidSuffix}, batch ${errorDetails.batchIndex}${attemptSuffix}, field ${meaningfulPath}: ${errorDetails.errorMessage}`
  );
}

function logValidationError(errorDetails: ValidationErrorDetails) {
  const meaningfulPath = getMeaningfulFieldPath(errorDetails.fieldPath);
  const attemptNumber =
    errorDetails.attemptNumber || getCurrentAttemptNumber(errorDetails.batchIndex);

  emitValidationWarning(errorDetails);

  const readableLogEntry = {
    timestamp: new Date().toISOString(),
    error_summary: `${meaningfulPath}: ${errorDetails.errorMessage}`,
    batch_info: {
      batchIndex: errorDetails.batchIndex,
      csvLineRange: `${errorDetails.csvLineStart}-${errorDetails.csvLineEnd}`,
      specificCsvLine: errorDetails.csvRowIndex,
      ...(attemptNumber && { attemptNumber }),
      filePath: errorDetails.filePath,
      fileCsvLine: errorDetails.fileCsvLine,
      uuid: errorDetails.uuid,
    },
    field_details: {
      expectedType: errorDetails.expectedType,
      actualValue: errorDetails.actualValue,
      errorMessage: errorDetails.errorMessage,
    },
    errorMessage: errorDetails.errorMessage,
  };

  return asyncAppendFile(validationLogFile, JSON.stringify(readableLogEntry, null, 2) + '\n');
}

function parseZodError(
  zodError: ZodError,
  batchIndex: number,
  csvLineStart: number,
  csvLineEnd: number,
  originalData?: AnalysisResult,
  _originalBatch?: Record<string, string>[],
  csvRowIndexes?: number[]
): ValidationErrorDetails[] {
  const errors: ValidationErrorDetails[] = [];
  const attemptNumber = getCurrentAttemptNumber(batchIndex);

  for (const issue of zodError.issues) {
    const fieldPath = issue.path.join('.');
    let csvRowIndex: number | undefined;

    const canGetRowIndex =
      issue.path.length >= 2 && issue.path[0] === 'results' && typeof issue.path[1] === 'number';
    if (canGetRowIndex) {
      const resultIndex = issue.path[1] as number;
      csvRowIndex = csvRowIndexes?.[resultIndex] ?? csvLineStart + resultIndex;
    }

    errors.push({
      batchIndex,
      csvLineStart,
      csvLineEnd,
      fieldPath,
      errorMessage: issue.message,
      expectedType: issue.code === 'invalid_type' ? issue.expected : undefined,
      actualValue:
        originalData && issue.path.length > 0 ? getValueAtPath(issue.path, originalData) : 'N/A',
      csvRowIndex,
      ...(attemptNumber && { attemptNumber }),
    });
  }

  return errors;
}

function getValueAtPath(path: (string | number)[], obj: unknown): unknown {
  let current: unknown = obj;
  for (const segment of path) {
    if (current == null) return undefined;

    const isValidObject = typeof current === 'object' && current !== null;
    if (isValidObject) {
      current = (current as Record<string | number, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export interface RetryAttemptDetails {
  batchIndex: number;
  csvLineRange: string;
  attemptNumber: number;
  totalRetries: number;
  errorType:
    | 'api_error'
    | 'validation_error'
    | 'required_field_error'
    | 'network_error'
    | 'rate_limit_error';
  errorMessage: string;
  actionTaken:
    | 'retry_same'
    | 'retry_with_fallback'
    | 'retry_with_context'
    | 'retry_after_wait'
    | 'failed';
  fallbackModel?: string;
  /** Milliseconds waited before this retry (rate-limit retries only) */
  waitMs?: number;
}

export interface BatchOutcomeDetails {
  batchIndex: number;
  csvLineRange: string;
  status: 'success' | 'failed' | 'partial_success';
  totalAttempts: number;
  finalErrorMessage?: string;
  processingTimeMs?: number;
  requiredFieldErrorCount?: number;
}

function logRetryAttempt(details: RetryAttemptDetails) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    batch_info: {
      batchIndex: details.batchIndex,
      csvLineRange: details.csvLineRange,
    },
    retry_info: {
      attempt: `${details.attemptNumber}/${details.totalRetries}`,
      errorType: details.errorType,
      actionTaken: details.actionTaken,
      fallbackModel: details.fallbackModel,
      waitMs: details.waitMs,
    },
    error_summary: details.errorMessage,
  };

  return asyncAppendFile(retryLogFile, JSON.stringify(logEntry, null, 2) + '\n');
}

function logBatchOutcome(details: BatchOutcomeDetails) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    batch_info: {
      batchIndex: details.batchIndex,
      csvLineRange: details.csvLineRange,
    },
    outcome: {
      status: details.status,
      totalAttempts: details.totalAttempts,
      processingTimeMs: details.processingTimeMs,
      requiredFieldErrorCount: details.requiredFieldErrorCount,
    },
    ...(details.finalErrorMessage && {
      final_error: details.finalErrorMessage,
    }),
  };

  return asyncAppendFile(batchOutcomeLogFile, JSON.stringify(logEntry, null, 2) + '\n');
}

export interface UuidGenerationDetails {
  timestamp?: string;
  batchIndex?: number;
  csvRowIndex?: number;
  recordId?: string;
  uuidColumn?: string;
  eventType:
    | 'generated'
    | 'cached'
    | 'fallback_to_email'
    | 'fallback_to_row_digest'
    | 'column_missing'
    | 'column_empty';
  inputValues: string[];
  generatedUuid: string;
  cacheSize?: number;
  fallbackReason?: string;
}

function logUuidGeneration(details: UuidGenerationDetails) {
  const logEntry = {
    timestamp: details.timestamp || new Date().toISOString(),
    event_type: details.eventType,
    uuid_info: {
      column: details.uuidColumn || 'email',
      inputValues: details.inputValues,
      generatedUuid: details.generatedUuid,
      cacheSize: details.cacheSize,
    },
    context: {
      batchIndex: details.batchIndex,
      csvRowIndex: details.csvRowIndex,
      recordId: details.recordId,
    },
    ...(details.fallbackReason && {
      fallback_info: {
        reason: details.fallbackReason,
      },
    }),
  };

  return asyncAppendFile(uuidLogFile, JSON.stringify(logEntry, null, 2) + '\n');
}

async function flushLogs() {
  await Promise.all(pendingWrites);
}

export function createLogger(enableLogging: boolean, batchSize = 5) {
  let warningCount = 0;

  const countedLogValidationError = async (
    errorDetails: ValidationErrorDetails,
    persistToFile: boolean
  ) => {
    warningCount++;
    if (persistToFile) {
      await logValidationError(errorDetails);
    } else {
      emitValidationWarning(errorDetails);
    }
  };

  return enableLogging
    ? {
        log: (batchIndex: number, records: Record<string, string>[]) =>
          log(batchIndex, records, batchSize),
        logValidationError: async (errorDetails: ValidationErrorDetails) =>
          countedLogValidationError(errorDetails, true),
        parseZodError,
        logUuidGeneration,
        logRetryAttempt,
        logBatchOutcome,
        flushLogs,
        getWarningCount: () => warningCount,
      }
    : {
        log: async () => {},
        logValidationError: async (errorDetails: ValidationErrorDetails) =>
          countedLogValidationError(errorDetails, false),
        parseZodError: () => [],
        logUuidGeneration: async () => {},
        logRetryAttempt: async () => {},
        logBatchOutcome: async () => {},
        flushLogs: async () => {},
        getWarningCount: () => warningCount,
      };
}
