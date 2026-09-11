import { AppConfig } from '../utils/types.js';

/**
 * CLI-specific types and interfaces
 */

export interface CliOptions {
  // Input/Output
  input?: string;
  schema?: string;
  output?: string;
  config?: string;
  rules?: string;
  llmFields?: string;
  noLlmFields?: string;

  // Processing options
  batchSize?: string;
  concurrency?: string;
  retries?: string;
  model?: string;
  fallbackModel?: string;

  // Behavioral flags
  logging?: boolean;
  hidePii?: boolean;
  requiredFieldsFailBatch?: boolean;
  stdout?: boolean;
  quiet?: boolean;

  // Rate-limit options
  rateLimitRetries?: string;
  rateLimitMaxWait?: string;
  sdkRetries?: string;
  noAdaptiveConcurrency?: boolean;
  failFast?: boolean;
}

export interface ConfigBuildResult {
  appConfig: AppConfig;
  outputToFile: boolean;
}

export interface PackageInfo {
  name: string;
  version: string;
  description?: string;
}
