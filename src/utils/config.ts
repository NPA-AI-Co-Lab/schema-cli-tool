import dotenv from 'dotenv';
import { EnvConfig, AppConfig } from './types.js';
import { loadJSON } from './file-system.js';
import path from 'path';
import fs from 'fs';

dotenv.config({ quiet: true });

/**
 * Load and validate environment configuration
 */
export function loadEnvConfig(): EnvConfig {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
}

/**
 * Load application configuration from config.json
 */
export function loadAppConfig(configPath?: string): AppConfig {
  const configFile = configPath || path.resolve(process.cwd(), 'config.json');
  return loadJSON<AppConfig>(configFile);
}

/**
 * Built-in defaults used when no config file is given and ./config.json does not exist —
 * e.g. `analyze -i data.csv -s schema.jsonld -o out.jsonld` run from a dataset folder with
 * a globally installed package. Paths are intentionally empty: CLI flags must supply them.
 */
export function getDefaultAppConfig(): AppConfig {
  return {
    schemaPath: '',
    outputPath: '',
    enableLogging: false,
    hidePII: true,
    retriesNumber: 2,
    requiredFieldErrorsFailBatch: false,
    batchSize: 5,
    concurrencySize: 5,
    defaultModel: 'gpt-4.1-mini',
    fallbackModel: 'gpt-4.1-mini',
    temperature: 0,
    resumeMode: 'auto',
  };
}

/**
 * Base config for CLI mode: an explicit -c file, else ./config.json if present, else defaults.
 */
export function loadBaseAppConfig(configPath?: string): AppConfig {
  if (configPath) {
    return loadAppConfig(configPath);
  }
  const cwdConfig = path.resolve(process.cwd(), 'config.json');
  if (fs.existsSync(cwdConfig)) {
    return loadAppConfig(cwdConfig);
  }
  return getDefaultAppConfig();
}

/**
 * Load configuration values globally (similar to loadEnvConfig approach)
 * This makes config values available as constants throughout the app
 */
export function loadGlobalConfig(configPath?: string) {
  // Tolerate a missing ./config.json: the CLI must start (e.g. `--version`, or `-c` pointing
  // elsewhere) from any working directory, including a globally installed package.
  let config: Partial<AppConfig> = {};
  try {
    config = loadAppConfig(configPath);
  } catch {
    config = {};
  }
  return {
    BATCH_SIZE: config.batchSize ?? 5,
    CONC_SIZE: config.concurrencySize ?? 5,
    DEFAULT_MODEL: config.defaultModel ?? 'gpt-4.1-mini',
    FALLBACK_MODEL: config.fallbackModel ?? 'gpt-4.1',
  };
}

/**
 * Get batch size from configuration
 */
export function getBatchSize(config?: AppConfig): number {
  return config?.batchSize ?? 5;
}

/**
 * Get concurrency size from configuration
 */
export function getConcurrencySize(config?: AppConfig): number {
  return config?.concurrencySize ?? 5;
}

/**
 * Get default model from configuration
 */
export function getDefaultModel(config?: AppConfig): string {
  return config?.defaultModel ?? 'gpt-4.1-mini';
}

/**
 * Get fallback model from configuration
 */
export function getFallbackModel(config?: AppConfig): string {
  return config?.fallbackModel ?? 'gpt-4.1';
}

/**
 * Check if OpenAI API key is configured
 */
export function isOpenAIConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

/**
 * Get OpenAI API key or throw error
 */
export function getOpenAIAPIKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }
  return apiKey;
}
