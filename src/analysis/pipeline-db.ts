/**
 * Database-backed analysis pipeline with multi-file CSV ingestion
 * Replaces checkpoint-based system with SQLite persistence
 */

import path from 'path';
import { existsSync } from 'fs';
import ora, { Ora } from 'ora';
import { convertJsonSchemaToZod } from 'zod-from-json-schema';
import { resolveRefs } from 'json-refs';
import pLimit from 'p-limit';
import { ZodError, ZodTypeAny } from 'zod';

import { ILLMClient } from '../interfaces/llm-client.interface.js';
import { LLMClientFactory } from '../clients/llm-client-factory.js';
import {
  basePath,
  createConfigHash,
  fixZodFromJsonSchema,
  getFilePaths,
  loadInstructions,
  loadJSON,
  normalizeConfig,
  runWithRetries,
  validateConfig,
} from '../utils/index.js';
import {
  createAppendingJsonLDWriter,
  createJsonLDWriter,
  getLLMSchema,
  JsonLdSchema,
} from '../jsonld/index.js';
import { createLogger } from '../logging.js';
import { ConfigurationError } from '../utils/errors.js';
import { createPIIHandlers } from '../pii_handling/pii_handling.js';
import type { RecordData } from '../pii_handling/types.js';
import { processBatch } from './processor.js';
import { buildPartialSchema } from './rules/partial-schema.js';
import type { DeterministicFieldResult, LoadedRules } from './rules/index.js';
import { loadRulesConfig, transformRow } from './rules/index.js';
import { DbStreamingProcessor } from './db-streaming-processor.js';
import { FileIngestionManager } from './file-ingestion.js';
import { DatabaseManager, deriveDatabasePath } from '../database/index.js';
import type { AppConfig } from '../utils/types.js';
import { setActiveSpinner, warn } from '../utils/ui.js';
import { RateLimitGate } from '../utils/rate-limit-gate.js';
import { adjustConcurrency as applyAdaptiveConcurrency } from '../utils/adaptive-concurrency.js';
import { ThrottledLLMClient } from '../clients/throttled-llm-client.js';
import type { ValidationErrorDetails } from '../jsonld/types.js';

type JsonSchema = Record<string, unknown>;
type DbMode = 'fresh' | 'resume';
type OutputMode = 'rewrite' | 'append';
type PackageManifest = { name?: string; version?: string };
export type AnalysisRunSummary = { warningCount: number; failedBatchCount: number };
type RowWarningContext = {
  filePath: string;
  fileCsvLine: number;
  uuid: string;
};

const INSTRUCTION_PATH = path.resolve(basePath, 'static', 'instructions.txt');
const PROVENANCE_CONTEXT = {
  toolName: 'urn:npa-ingest-insight-cli:toolName',
  configHash: 'urn:npa-ingest-insight-cli:configHash',
  defaultModel: 'urn:npa-ingest-insight-cli:defaultModel',
  fallbackModel: 'urn:npa-ingest-insight-cli:fallbackModel',
  schemaPath: 'urn:npa-ingest-insight-cli:schemaPath',
  rulesPath: 'urn:npa-ingest-insight-cli:rulesPath',
  uuidColumn: 'urn:npa-ingest-insight-cli:uuidColumn',
  sourceFiles: 'urn:npa-ingest-insight-cli:sourceFiles',
  outputPath: 'urn:npa-ingest-insight-cli:outputPath',
  databasePath: 'urn:npa-ingest-insight-cli:databasePath',
  batchSize: 'urn:npa-ingest-insight-cli:batchSize',
  concurrencySize: 'urn:npa-ingest-insight-cli:concurrencySize',
  retriesNumber: 'urn:npa-ingest-insight-cli:retriesNumber',
  enableLogging: 'urn:npa-ingest-insight-cli:enableLogging',
  hidePII: 'urn:npa-ingest-insight-cli:hidePII',
  requiredFieldErrorsFailBatch: 'urn:npa-ingest-insight-cli:requiredFieldErrorsFailBatch',
  resumeMode: 'urn:npa-ingest-insight-cli:resumeMode',
  forceReingestion: 'urn:npa-ingest-insight-cli:forceReingestion',
  softwareVersion: 'https://schema.org/softwareVersion',
  dateCreated: 'https://schema.org/dateCreated',
};

function attachWarningRowContext(
  error: ValidationErrorDetails,
  rowContextByCsvRowIndex: Map<number, RowWarningContext>
): ValidationErrorDetails {
  if (error.csvRowIndex === undefined) {
    return error;
  }

  const rowContext = rowContextByCsvRowIndex.get(error.csvRowIndex);
  if (!rowContext) {
    return error;
  }

  return {
    ...error,
    filePath: rowContext.filePath,
    fileCsvLine: rowContext.fileCsvLine,
    uuid: rowContext.uuid,
  };
}

function buildOutputProvenanceEntry(
  rawJsonLdSchema: JsonLdSchema,
  normalizedConfig: AppConfig,
  filePaths: string[],
  configHash: string,
  dbPath: string
): Record<string, unknown> {
  const packageManifest = loadJSON<PackageManifest>(path.resolve(basePath, 'package.json'));
  const toolName = packageManifest.name || 'npa-ingest-insight-cli';
  const toolVersion = packageManifest.version || 'unknown';
  const generatedAt = new Date().toISOString();

  return {
    '@context': {
      ...rawJsonLdSchema['@context'],
      ...PROVENANCE_CONTEXT,
    },
    '@id': `urn:npa-ingest-insight-cli:output-metadata:${configHash}`,
    '@type': 'Dataset',
    name: `${toolName} output metadata`,
    toolName,
    softwareVersion: toolVersion,
    dateCreated: generatedAt,
    configHash,
    defaultModel: normalizedConfig.defaultModel,
    fallbackModel: normalizedConfig.fallbackModel,
    schemaPath: normalizedConfig.schemaPath,
    rulesPath: normalizedConfig.rulesPath || null,
    uuidColumn: normalizedConfig.uuidColumn || null,
    sourceFiles: filePaths,
    outputPath: normalizedConfig.outputPath || 'stdout',
    databasePath: dbPath,
    batchSize: normalizedConfig.batchSize,
    concurrencySize: normalizedConfig.concurrencySize,
    retriesNumber: normalizedConfig.retriesNumber,
    enableLogging: normalizedConfig.enableLogging,
    hidePII: normalizedConfig.hidePII,
    requiredFieldErrorsFailBatch: normalizedConfig.requiredFieldErrorsFailBatch,
    resumeMode: normalizedConfig.resumeMode || 'auto',
    forceReingestion: Boolean(normalizedConfig.forceReingestion),
  };
}

/**
 * Main database-backed analysis function for multi-file CSV processing
 */
export async function analyzeDataWithDb(
  config: AppConfig,
  llmClient?: ILLMClient,
  quiet: boolean = false
): Promise<AnalysisRunSummary> {
  // Normalize and validate configuration
  const normalizedConfig = normalizeConfig(config);
  validateConfig(normalizedConfig);

  const {
    schemaPath,
    outputPath,
    databasePath,
    enableLogging,
    hidePII: enablePiiProcessing,
    retriesNumber,
    rateLimitMaxRetries,
    rateLimitMaxWaitMs,
    requiredFieldErrorsFailBatch,
    batchSize,
    concurrencySize,
    defaultModel,
    fallbackModel,
    uuidColumn,
    rulesPath,
    llmFieldOverrides,
    resumeMode,
    forceReingestion,
    temperature,
    failFast = false,
    adaptiveConcurrency,
    sdkMaxRetries,
  } = normalizedConfig;

  const filePaths = getFilePaths(normalizedConfig);
  const dbPath = databasePath || deriveDatabasePath(outputPath);

  if (!quiet) {
    console.log(`\n🗄️  Database: ${dbPath}`);
    console.log(`📁 Processing ${filePaths.length} file(s)`);
    for (const fp of filePaths) {
      console.log(`   - ${path.basename(fp)}`);
    }
  }

  // Initialize database
  const db = new DatabaseManager(dbPath);
  db.connect();

  // Hoisted above the try block so the outer catch/finally (below) can reach them
  // regardless of where inside the run a failure occurs.
  let streamingProcessor: DbStreamingProcessor | undefined;
  let spinner: Ora | null = null;
  let stopSpinnerUpdate: NodeJS.Timeout | null = null;
  let handleShutdown: (() => Promise<void>) | undefined;
  let flushLogsRef: (() => Promise<void>) | undefined;
  let finalized = false;
  const finalizeOnce = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    if (streamingProcessor) {
      await streamingProcessor.finalize();
    }
  };

  try {
    // Check resume mode
    const existingConfigHash = db.state.getConfigHash();
    const currentConfigHash = createConfigHash(normalizedConfig);
    const isResume = existingConfigHash !== null;
    let dbMode: DbMode = 'fresh';

    if (isResume) {
      if (resumeMode === 'fresh') {
        if (!quiet) {
          console.log('🔄 Fresh mode: Clearing existing database');
        }
        db.clearAllData();
        dbMode = 'fresh';
      } else if (resumeMode === 'resume' || resumeMode === 'auto') {
        // Validate config hasn't changed
        if (existingConfigHash !== currentConfigHash) {
          if (resumeMode === 'resume') {
            throw new Error(
              'Configuration has changed since last run. Use --resume-mode=fresh to start over.'
            );
          } else {
            if (!quiet) {
              console.log('⚠️  Configuration changed. Starting fresh.');
            }
            db.clearAllData();
            dbMode = 'fresh';
          }
        } else {
          dbMode = 'resume';
          if (!quiet) {
            const progress = db.state.getProcessingProgress();
            console.log(
              `📁 Resuming from database (${progress.processed_rows}/${progress.total_rows} rows, ${progress.completed_uuids}/${progress.total_uuids} UUIDs)`
            );
          }
        }
      }
    }

    // Decide output handling separately from DB resume behavior.
    const previousOutputPath = db.state.getConfig('output_path');
    const outputPathChanged = previousOutputPath !== null && previousOutputPath !== outputPath;
    const outputFileExists = !outputPath || existsSync(outputPath);

    // Save configuration
    db.state.saveConfigHash(currentConfigHash);
    // Persist current output path for future runs
    db.state.setConfig('output_path', outputPath);

    // Append only on stable resume + same path + existing output file.
    const configUnchanged = existingConfigHash !== null && existingConfigHash === currentConfigHash;
    let outputMode: OutputMode =
      dbMode === 'resume' && configUnchanged && !outputPathChanged && outputFileExists
        ? 'append'
        : 'rewrite';

    if (outputMode === 'rewrite') {
      if (!quiet) {
        if (outputPathChanged) {
          console.log(
            `Output path changed from '${previousOutputPath}' to '${outputPath}': rewriting output from database.`
          );
        } else if (!outputFileExists && outputPath) {
          console.log(`Output file '${outputPath}' not found: rewriting output from database.`);
        } else {
          console.log('Writing output in rewrite mode from current database state.');
        }
      }

      db.getConnection()
        .getDb()
        .prepare('UPDATE merged_output SET written_to_file = 0, written_at = NULL')
        .run();
    } else {
      if (!quiet) console.log('Resuming analysis in append mode');
    }
    db.state.markProcessingStarted();

    // Load schema and setup
    const schema = getLLMSchema(schemaPath);
    const rawJsonLdSchema = loadJSON<JsonLdSchema>(schemaPath);
    const provenanceEntry = buildOutputProvenanceEntry(
      rawJsonLdSchema,
      normalizedConfig,
      filePaths,
      currentConfigHash,
      dbPath
    );
    const { resolved } = await resolveRefs(schema);
    const resolvedSchema = resolved as JsonSchema;
    const zodSchema = fixZodFromJsonSchema(resolvedSchema, convertJsonSchemaToZod(resolvedSchema));

    // Setup logging
    const {
      log,
      logValidationError,
      parseZodError,
      flushLogs,
      logUuidGeneration,
      logRetryAttempt,
      logBatchOutcome,
      getWarningCount,
    } = createLogger(enableLogging, batchSize);
    flushLogsRef = flushLogs;

    const { encodePII, decodePII } = createPIIHandlers(enablePiiProcessing);

    const rulesContext: LoadedRules | null = loadRulesConfig({
      rulesPath,
      schemaPath,
      overrides: llmFieldOverrides,
    });

    const partialSchemaCache = new Map<string, { instructions: string; zodSchema: ZodTypeAny }>();

    // Phase 1: File Ingestion
    if (!quiet) {
      console.log('\n📥 Phase 1: File Ingestion');
    }

    const ingestionManager = new FileIngestionManager(
      db,
      batchSize,
      uuidColumn,
      logUuidGeneration,
      Boolean(forceReingestion)
    );
    const ingestionResults = await ingestionManager.ingestFiles(filePaths, quiet);

    // Check if any file was re-ingested due to forceReingestion
    const anyReingested = ingestionResults.some((r) => r.reingested);

    if (anyReingested) {
      if (!quiet) {
        console.log(
          '⚠️  File re-ingestion detected: Invalidating all merged outputs to regenerate fresh output'
        );
      }
      // Clear all written flags so everything gets written fresh
      db.results.resetAllToUnwritten();
      // Force fresh writer (not append) by overriding outputMode
      outputMode = 'rewrite';
    }

    const newFiles = ingestionResults.filter((r) => !r.skipped);
    if (!quiet && newFiles.length > 0) {
      console.log(`✅ Ingested ${newFiles.length} new file(s)`);
    }

    const summary = ingestionManager.getIngestionSummary();
    if (!quiet) {
      console.log(`📊 Total: ${summary.totalRows} rows, ${summary.totalUuids} unique UUIDs`);
    }

    // Phase 2: LLM Processing
    const unprocessedRows = db.rows.getUnprocessedRows();

    if (unprocessedRows.length === 0) {
      if (!quiet) {
        console.log('\n✅ All rows already processed!');
      }

      // Still need to finalize output
      const writerEarly =
        outputMode === 'append'
          ? createAppendingJsonLDWriter(outputPath, schemaPath, provenanceEntry)
          : createJsonLDWriter(outputPath, schemaPath, provenanceEntry);

      streamingProcessor = new DbStreamingProcessor(writerEarly, rawJsonLdSchema, schema, db);
      await streamingProcessor.restoreFromDatabase();
      await finalizeOnce();

      db.state.markProcessingCompleted();
      db.close();
      return { warningCount: getWarningCount(), failedBatchCount: 0 };
    }

    // A rules-only run resolves every schema field deterministically, so no batch will
    // ever need the LLM (loadRulesConfig already refused to load if any required field
    // lacked deterministic or LLM coverage, so this check is safe).
    const isRulesOnlyRun = rulesContext !== null && rulesContext.llmFields.size === 0;

    if (!quiet) {
      if (isRulesOnlyRun) {
        console.log(`\n⚙️  Phase 2: Processing (rules-only, no LLM calls)`);
      } else {
        console.log(`\n⚙️  Phase 2: LLM Processing (${unprocessedRows.length} rows to process)`);
      }
    }

    const writer =
      outputMode === 'append'
        ? createAppendingJsonLDWriter(outputPath, schemaPath, provenanceEntry)
        : createJsonLDWriter(outputPath, schemaPath, provenanceEntry);

    streamingProcessor = new DbStreamingProcessor(writer, rawJsonLdSchema, schema, db);

    // Restore any unwritten merged outputs (this will write entries with written_to_file = 0)
    await streamingProcessor.restoreFromDatabase();
    // Non-null from here on: assigned unconditionally above. Capturing it in a
    // `const` lets it be used from inside the batch closures below without a
    // per-use null check.
    const processor: DbStreamingProcessor = streamingProcessor;

    // Abort signal shared by graceful shutdown, the rate-limit gate (so a Ctrl-C during a
    // long pause exits immediately instead of waiting it out), and (when failFast is set)
    // the first batch failure. Batch tasks check it at the start and skip starting new
    // work once it is set. Declared before the LLM client below so `getClient` can hand
    // the signal to `ThrottledLLMClient`.
    const abortController = new AbortController();

    // Process-wide rate-limit gate for this run: every batch's LLM call goes through it,
    // so a 429 on one batch pauses every other in-flight/new batch too. See the comment
    // at the top of throttled-llm-client.ts for how this cooperates with retry.ts.
    const rateLimitGate = new RateLimitGate();

    // Setup LLM client. An explicitly-provided client (tests / programmatic callers) is
    // used as-is; otherwise the client is created lazily from the environment, memoised
    // across batches, and only when a batch actually needs it — so runs where every row
    // is resolved deterministically never require OPENAI_API_KEY to be set. Either way,
    // the client handed to batches is wrapped in a ThrottledLLMClient bound to this run's
    // gate, memoised alongside it so the wrap only happens once.
    let client = llmClient;
    let throttledClient: ILLMClient | undefined;
    const getClient = (fieldListForBatch: string[]): ILLMClient => {
      if (!client) {
        if (!process.env.OPENAI_API_KEY) {
          throw new ConfigurationError(
            `This run needs OpenAI for fields [${fieldListForBatch.join(', ')}] but OPENAI_API_KEY is not set. ` +
              'Set the key, or keep these fields deterministic via rules / --no-llm-fields.'
          );
        }
        client = LLMClientFactory.createFromEnv({ maxRetries: sdkMaxRetries });
      }
      if (!throttledClient) {
        throttledClient = new ThrottledLLMClient(client, rateLimitGate, {
          signal: abortController.signal,
        });
      }
      return throttledClient;
    };

    // Progress tracking
    let processedRowCount = db.results.getTotalProcessedCount();
    const totalRowCount = db.rows.getTotalRowCount();

    spinner = ora({ stream: process.stderr, isEnabled: !quiet });

    if (!quiet) {
      spinner = ora('Processing batches...').start();
      spinner.color = 'yellow';
      setActiveSpinner(spinner);
      stopSpinnerUpdate = setInterval(() => {
        const progress = db.state.getProcessingProgress();
        const pauseSuffix = rateLimitGate.isPaused
          ? ` · paused for rate limit (${Math.ceil(rateLimitGate.pausedForMs / 1000)}s)`
          : '';
        spinner!.text = `Processing: ${progress.processed_rows}/${progress.total_rows} rows, ${progress.completed_uuids}/${progress.total_uuids} UUIDs completed${pauseSuffix}`;
      }, 500);
    }
    // Non-null from here on: assigned unconditionally above.
    const activeSpinner: Ora = spinner;

    // Setup graceful shutdown
    let hasError = false;
    handleShutdown = async () => {
      if (hasError) return;
      hasError = true;
      abortController.abort();

      if (stopSpinnerUpdate) {
        clearInterval(stopSpinnerUpdate);
      }
      setActiveSpinner(null);

      try {
        await finalizeOnce();
      } catch (error) {
        console.error('Error finalizing during shutdown:', error);
      }

      db.close();

      if (!quiet) {
        console.log('\n⚠️  Processing interrupted. Progress saved to database.');
        console.log('   Run again to resume from where you left off.');
      }

      process.exit(0);
    };

    process.on('SIGINT', handleShutdown);
    process.on('SIGTERM', handleShutdown);

    // Process rows in batches
    const limit = pLimit(concurrencySize);
    const persistLimit = pLimit(1);
    const batchPromises: Promise<void>[] = [];
    const failedBatches: Array<{ batchIndex: number; csvLineRange: string; message: string }> = [];
    // A configuration or authentication problem (missing key, 401/403 from the provider)
    // cannot be fixed by retrying other batches, so it aborts the whole run immediately —
    // regardless of failFast — instead of producing one failure line per batch.
    let fatalError: Error | undefined;
    const isFatalBatchError = (err: Error): boolean => {
      if (err instanceof ConfigurationError) return true;
      const status = (err as { status?: number }).status;
      return status === 401 || status === 403;
    };

    // Adapts `limit.concurrency` to the rate-limit gate's recent history. Runs after every
    // batch settles (success or failure). Halving on repeated 429s reacts fast; ramping
    // back up requires a sustained run of clean successes so a lone lucky call doesn't
    // immediately undo the backoff. No-op when adaptiveConcurrency is disabled — the gate
    // itself still pauses batches regardless of this setting. The actual halve/ramp
    // algorithm lives in adaptive-concurrency.ts so it can be unit tested on its own.
    const adjustConcurrency = (): void => {
      if (adaptiveConcurrency === false) {
        return;
      }

      applyAdaptiveConcurrency(rateLimitGate, limit, concurrencySize, (next) => {
        warn(`Reducing concurrency to ${next} after repeated rate limits`, activeSpinner);
      });
    };

    // Group unprocessed rows into batches
    const batches: (typeof unprocessedRows)[] = [];
    for (let i = 0; i < unprocessedRows.length; i += batchSize) {
      batches.push(unprocessedRows.slice(i, i + batchSize));
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batchRows = batches[batchIndex];

      batchPromises.push(
        limit(async () => {
          if (abortController.signal.aborted) {
            return;
          }

          const csvLineStart = batchRows[0].global_row_index + 1;
          const csvLineEnd = batchRows[batchRows.length - 1].global_row_index + 1;
          const csvLineRange = `${csvLineStart}-${csvLineEnd}`;
          const csvRowIndexes = batchRows.map((row) => row.global_row_index + 1);
          const filePathById = new Map<number, string>();
          const rowContextByCsvRowIndex = new Map<
            number,
            { filePath: string; fileCsvLine: number; uuid: string }
          >();

          try {
            for (const row of batchRows) {
              let filePathForRow = filePathById.get(row.file_id);
              if (!filePathForRow) {
                filePathForRow =
                  db.files.getFileById(row.file_id)?.file_path ?? `file_id=${row.file_id}`;
                filePathById.set(row.file_id, filePathForRow);
              }

              rowContextByCsvRowIndex.set(row.global_row_index + 1, {
                filePath: filePathForRow,
                fileCsvLine: row.file_row_index + 2,
                uuid: row.uuid,
              });
            }

            // Parse raw data for batch and restore userID from database
            const batchData: RecordData[] = batchRows.map((row) => {
              const data = JSON.parse(row.raw_data);
              // Add userID back to row data (it was removed during ingestion)
              data.userID = row.uuid;
              return data;
            });
            const rowIds = batchRows.map((row) => row.row_id);

            // Apply deterministic transformations if rules exist
            let transformedBatch: RecordData[] = batchData;
            let deterministicPrefills: DeterministicFieldResult[] | undefined = undefined;

            if (rulesContext) {
              deterministicPrefills = batchData.map((row) => transformRow(row, rulesContext));
              // Note: p.mapped may have unknown values, but encodePII expects RecordData
              // Cast is safe because transformRow output is compatible with RecordData structure
              transformedBatch = deterministicPrefills.map((p) => p.mapped as RecordData);
            }

            // Encode PII
            const { processedBatch: encodedBatch, encodingMap } = encodePII(transformedBatch);

            // Log LLM input for debugging
            log(batchIndex, encodedBatch).catch((err) => {
              const logError = err as Error;
              console.error(
                `Failed to log LLM input for batch ${batchIndex} (rows ${csvLineRange}): ${logError.message}. Processing will continue.`
              );
            });

            // Union of LLM fields this batch still needs (empty when fully deterministic).
            // Computed up front so it can also drive lazy LLM client creation below.
            const pendingFields = new Set<string>();
            if (deterministicPrefills) {
              for (const prefill of deterministicPrefills) {
                for (const field of prefill.pendingFields) {
                  pendingFields.add(field);
                }
              }
            }
            const fieldList = Array.from(pendingFields).sort();

            // Determine which schema/instructions to use
            let currentInstructions: string;
            let currentZodSchema: ZodTypeAny;

            // Check if we need partial schema (only LLM fields)
            if (deterministicPrefills) {
              if (fieldList.length > 0) {
                const cacheKey = fieldList.join('|');
                let cached = partialSchemaCache.get(cacheKey);

                if (!cached) {
                  const partialSchema = buildPartialSchema(resolvedSchema, fieldList);
                  const partialZodSchema = fixZodFromJsonSchema(
                    partialSchema,
                    convertJsonSchemaToZod(partialSchema)
                  );
                  const inputFileName = 'data.csv';
                  const partialInstructions = loadInstructions(
                    INSTRUCTION_PATH,
                    partialSchema,
                    inputFileName
                  );
                  cached = { instructions: partialInstructions, zodSchema: partialZodSchema };
                  partialSchemaCache.set(cacheKey, cached);
                }

                currentInstructions = cached.instructions;
                currentZodSchema = cached.zodSchema;
              } else {
                const inputFileName = 'data.csv';
                currentInstructions = loadInstructions(INSTRUCTION_PATH, schema, inputFileName);
                currentZodSchema = zodSchema;
              }
            } else {
              const inputFileName = 'data.csv';
              currentInstructions = loadInstructions(INSTRUCTION_PATH, schema, inputFileName);
              currentZodSchema = zodSchema;
            }

            // Build input for LLM
            const input = [
              { role: 'system' as const, content: currentInstructions },
              { role: 'user' as const, content: JSON.stringify(encodedBatch) },
            ];

            // Process batch args. `llmClient` is intentionally left unset here (rather
            // than passing the raw `client` reference) so processor.ts always resolves via
            // `getLlmClient()`, which is what returns this run's ThrottledLLMClient —
            // passing the raw client would let it bypass the rate-limit gate entirely.
            const batchArgs = {
              getLlmClient: () => getClient(fieldList),
              instructions: currentInstructions,
              zodSchema: currentZodSchema,
              batchLength: batchData.length,
              index: batchIndex,
              input,
              model: defaultModel,
              logValidationError: async (error: ValidationErrorDetails) => {
                await logValidationError(attachWarningRowContext(error, rowContextByCsvRowIndex));
              },
              parseZodError: (
                zodError: ZodError,
                batchIndexParam: number,
                csvLineStartParam: number,
                csvLineEndParam: number,
                originalData?: Record<string, unknown>
              ) =>
                parseZodError(
                  zodError,
                  batchIndexParam,
                  csvLineStartParam,
                  csvLineEndParam,
                  originalData,
                  undefined,
                  csvRowIndexes
                ).map((error) => attachWarningRowContext(error, rowContextByCsvRowIndex)),
              logRetryAttempt,
              csvLineStart: csvLineStart,
              csvRowIndexes,
              decodePII,
              encodingMap,
              requiredFieldErrorsFailBatch,
              prefills: deterministicPrefills,
              temperature,
            };

            // Process batch with retry logic and timing
            const processWithRetries = async () => {
              const startTime = Date.now();
              const result = await processBatch(batchArgs);
              const processingTimeMs = Date.now() - startTime;

              // Log successful batch outcome
              await logBatchOutcome({
                batchIndex: batchIndex,
                csvLineRange: csvLineRange,
                status: 'success',
                totalAttempts: 1,
                processingTimeMs,
              });

              return result;
            };

            const results = (await runWithRetries(
              processWithRetries,
              batchArgs,
              activeSpinner,
              retriesNumber,
              { rateLimitMaxRetries, rateLimitMaxWaitMs, fallbackModel }
            )) as Record<string, unknown>[];

            // Serialize DB/output writes to avoid race conditions across concurrent LLM batches.
            await persistLimit(async () => {
              await processor.addBatchResults(results, rowIds);
              processedRowCount += batchData.length;
              db.state.updateLastActivity();
            });
          } catch (error) {
            const batchError = error as Error;

            // Log failed batch outcome
            await logBatchOutcome({
              batchIndex: batchIndex,
              csvLineRange: csvLineRange,
              status: 'failed',
              totalAttempts: retriesNumber + 1,
              processingTimeMs: 0,
              finalErrorMessage: batchError.message,
            });

            console.error(
              `❌ Batch ${batchIndex} failed (rows ${csvLineRange}): ${batchError.message}`
            );
            failedBatches.push({ batchIndex, csvLineRange, message: batchError.message });

            if (isFatalBatchError(batchError)) {
              fatalError ??= batchError;
              abortController.abort();
            } else if (failFast) {
              // Stop new batches from starting; already in-flight ones (up to
              // concurrencySize) are left to settle rather than cancelled here.
              abortController.abort();
            }

            throw error;
          } finally {
            // Runs whether the batch succeeded or failed, so a streak of 429s and the
            // occasional intervening success are both reflected promptly.
            adjustConcurrency();
          }
        })
      );
    }

    // A single failed batch must not tear down batches still in flight: allSettled lets
    // every batch reach persistence (success or failure) before we finalize and report.
    const settledBatches = await Promise.allSettled(batchPromises);

    if (stopSpinnerUpdate) {
      clearInterval(stopSpinnerUpdate);
    }
    setActiveSpinner(null);

    // Finalize output and flush logs regardless of outcome, wrapped so a failure here
    // never masks the real result of the run.
    try {
      await finalizeOnce();
    } catch (finalizeError) {
      console.error('Error finalizing output:', finalizeError);
    }
    try {
      await flushLogs();
    } catch (flushError) {
      console.error('Error flushing logs:', flushError);
    }

    const finalProgress = db.state.getProcessingProgress();
    const warningCount = getWarningCount();
    const failedBatchCount = failedBatches.length;

    if (fatalError) {
      throw fatalError;
    }

    if (failFast && failedBatchCount > 0) {
      const firstRejection = settledBatches.find(
        (settled): settled is PromiseRejectedResult => settled.status === 'rejected'
      );
      throw firstRejection ? firstRejection.reason : new Error('A batch failed (failFast)');
    }

    if (failedBatchCount > 0) {
      if (!quiet) {
        console.error(`❌ ${failedBatchCount} of ${batches.length} batches failed:`);
        const shown = failedBatches.slice(0, 20);
        for (const failure of shown) {
          console.error(
            `   • batch ${failure.batchIndex} (rows ${failure.csvLineRange}): ${failure.message}`
          );
        }
        if (failedBatches.length > shown.length) {
          console.error(
            `   ... and ${failedBatches.length - shown.length} more — see the error log`
          );
        }
        console.error(
          `   Progress saved to ${dbPath}. Re-run the same command to retry the failed batches.`
        );
      }

      return { warningCount, failedBatchCount };
    }

    if (!quiet) {
      if (warningCount > 0) {
        activeSpinner.warn(
          `Analysis completed with warnings! ${finalProgress.processed_rows} rows processed, ${finalProgress.completed_uuids} UUIDs completed, ${warningCount} warning(s)`
        );
      } else {
        activeSpinner.succeed(
          `Analysis complete! ${finalProgress.processed_rows} rows processed, ${finalProgress.completed_uuids} UUIDs completed`
        );
      }
      console.log(`📝 Output written to: ${outputPath}`);
    }

    // Mark as completed
    db.state.markProcessingCompleted();
    return { warningCount, failedBatchCount: 0 };
  } catch (error) {
    // A run-level failure (failFast rethrow above, or anything earlier in the pipeline
    // throwing) must still finalize whatever the SQLite DB already holds, so a crash never
    // leaves the JSON-LD output unwritten.
    if (stopSpinnerUpdate) {
      clearInterval(stopSpinnerUpdate);
    }
    setActiveSpinner(null);

    try {
      await finalizeOnce();
    } catch (finalizeError) {
      console.error('Error finalizing output after failure:', finalizeError);
    }
    try {
      await flushLogsRef?.();
    } catch (flushError) {
      console.error('Error flushing logs after failure:', flushError);
    }

    if (!quiet) {
      const originalMessage = error instanceof Error ? error.message : String(error);
      const progress = db.state.getProcessingProgress();
      console.error(`⚠️  Processing stopped: ${originalMessage}`);
      console.error(
        `   Progress saved to ${dbPath} (${progress.processed_rows}/${progress.total_rows} rows). Re-run the same command to resume.`
      );
    }

    throw error;
  } finally {
    if (handleShutdown) {
      process.off('SIGINT', handleShutdown);
      process.off('SIGTERM', handleShutdown);
    }
    setActiveSpinner(null);
    db.close();
  }
}
