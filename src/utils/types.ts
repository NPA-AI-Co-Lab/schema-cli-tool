/**
 * Environment configuration loaded from process.env.
 * Only contains sensitive credentials.
 */
export interface EnvConfig {
  /** OpenAI API key for authentication */
  OPENAI_API_KEY?: string;
}

/**
 * Configuration structure for the application
 */
export interface AppConfig {
  /** Single file path (legacy support) */
  dataPath?: string;
  /** Multiple file paths (new multi-file support) */
  dataPaths?: string[];
  schemaPath: string;
  outputPath: string;
  /** Database path for persistence (auto-derived if not specified) */
  databasePath?: string;
  enableLogging: boolean;
  hidePII: boolean;
  retriesNumber: number;
  requiredFieldErrorsFailBatch: boolean;
  /** Number of CSV records to process in each batch */
  batchSize: number;
  /** Number of concurrent batches to process simultaneously */
  concurrencySize: number;
  /** Primary LLM model to use for analysis */
  defaultModel: string;
  /** Fallback model to use when primary model fails */
  fallbackModel: string;
  /** Column name to use for UUID generation (defaults to email fields if not specified) */
  uuidColumn?: string;
  /** Optional path to deterministic rules configuration */
  rulesPath?: string;
  /** Runtime LLM field overrides (include/exclude specific fields from LLM) */
  llmFieldOverrides?: { include?: string[]; exclude?: string[] };
  /** Resume mode: 'auto' (default), 'fresh', or 'resume' */
  resumeMode?: 'auto' | 'fresh' | 'resume';
  /** If true, allow edited files to forcefully remove previously ingested records and re-ingest */
  forceReingestion?: boolean;
  /** LLM sampling temperature (0–2). Defaults to 0 for deterministic extraction. */
  temperature?: number;
  /** Extra retries reserved for rate-limit (429) and transient 5xx errors, separate from retriesNumber (default 6) */
  rateLimitMaxRetries?: number;
  /** Upper bound in ms for a single Retry-After wait (default 90000) */
  rateLimitMaxWaitMs?: number;
  /** OpenAI SDK built-in retry count (default 0 — the CLI's own retry layer already handles 429/5xx/connection errors and needs to see 429s promptly to pause other batches; max 5) */
  sdkMaxRetries?: number;
  /** Halve concurrency after repeated rate limits and ramp back on success (default true) */
  adaptiveConcurrency?: boolean;
  /** Abort the run on the first failed batch instead of continuing and reporting (default false) */
  failFast?: boolean;
}

/**
 * Configuration from file with optional output path
 */
export interface FileConfig {
  /** Single file path (legacy support) */
  dataPath?: string;
  /** Multiple file paths (new multi-file support) */
  dataPaths?: string[];
  schemaPath: string;
  configOutputPath: string;
  /** Database path for persistence (auto-derived if not specified) */
  databasePath?: string;
  enableLogging: boolean;
  hidePII: boolean;
  retriesNumber: number;
  requiredFieldErrorsFailBatch: boolean;
  /** Column name to use for UUID generation (defaults to email fields if not specified) */
  uuidColumn?: string;
  rulesPath?: string;
  /** If true, allow edited files to forcefully remove previously ingested records and re-ingest */
  forceReingestion?: boolean;
  /** Resume mode: 'auto' (default), 'fresh', or 'resume' */
  resumeMode?: 'auto' | 'fresh' | 'resume';
}

/**
 * Validation result type - can be true for success or string for error message
 */
export type ValidationResult = true | string;
