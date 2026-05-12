/**
 * Configuration normalization and validation utilities
 */

import path from 'path';
import fs, { existsSync } from 'fs';
import crypto from 'crypto';
import { AppConfig } from './types.js';
import { deriveDatabasePath } from '../database/index.js';

/**
 * Normalize configuration to use dataPaths array
 * Converts legacy single dataPath to dataPaths array
 */
export function normalizeConfig(config: AppConfig): AppConfig {
  const normalized = { ...config };

  // Convert single dataPath to dataPaths array
  if (config.dataPath && !config.dataPaths) {
    normalized.dataPaths = [config.dataPath];
    delete normalized.dataPath;
  } else if (!config.dataPaths && !config.dataPath) {
    throw new Error('Configuration must specify either dataPath or dataPaths');
  }

  // Ensure dataPaths is always an array
  if (normalized.dataPaths && !Array.isArray(normalized.dataPaths)) {
    throw new Error('dataPaths must be an array of file paths');
  }

  // Derive database path if not specified and an output path is provided.
  if (!normalized.databasePath && normalized.outputPath) {
    normalized.databasePath = deriveDatabasePath(normalized.outputPath);
  }

  // Set default resume mode
  if (!normalized.resumeMode) {
    normalized.resumeMode = 'auto';
  }

  return normalized;
}

/**
 * Validate configuration
 */
export function validateConfig(config: AppConfig): void {
  const errors: string[] = [];

  // Validate dataPaths
  if (!config.dataPaths || config.dataPaths.length === 0) {
    errors.push('At least one data file path must be specified');
  } else {
    // Check that all files exist
    for (const filePath of config.dataPaths) {
      if (!existsSync(filePath)) {
        errors.push(`Data file not found: ${filePath}`);
      }

      // Check extension is .csv
      const ext = path.extname(filePath).toLowerCase();
      if (ext !== '.csv') {
        errors.push(`Invalid file extension for ${filePath}. Expected .csv, got ${ext}`);
      }
    }
  }

  // Validate schema path
  if (!config.schemaPath) {
    errors.push('schemaPath is required');
  } else if (!existsSync(config.schemaPath)) {
    errors.push(`Schema file not found: ${config.schemaPath}`);
  }

  // Validate output path. Allow falsy outputPath to indicate stdout mode.
  if (config.outputPath) {
    const outputDir = path.dirname(config.outputPath);
    if (!existsSync(outputDir)) {
      errors.push(`Output directory does not exist: ${outputDir}`);
    }
  }

  // Validate batch size
  if (config.batchSize <= 0) {
    errors.push('batchSize must be greater than 0');
  } else if (config.batchSize > 100) {
    errors.push('batchSize should not exceed 100 for optimal performance');
  }

  // Validate concurrency size
  if (config.concurrencySize <= 0) {
    errors.push('concurrencySize must be greater than 0');
  } else if (config.concurrencySize > 20) {
    errors.push('concurrencySize should not exceed 20 to avoid rate limits');
  }

  // Validate retries
  if (config.retriesNumber < 0) {
    errors.push('retriesNumber must be non-negative');
  }

  // Validate rules path if specified
  if (config.rulesPath && !existsSync(config.rulesPath)) {
    errors.push(`Rules file not found: ${config.rulesPath}`);
  }

  // Validate resume mode
  if (config.resumeMode && !['auto', 'fresh', 'resume'].includes(config.resumeMode)) {
    errors.push('resumeMode must be one of: auto, fresh, resume');
  }

  // Validate temperature
  if (config.temperature !== undefined && (config.temperature < 0 || config.temperature > 2)) {
    errors.push(`temperature must be between 0 and 2, got ${config.temperature}`);
  }

  if (errors.length > 0) {
    throw new Error(
      `Configuration validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`
    );
  }
}

/**
 * Get file paths array from configuration
 */
export function getFilePaths(config: AppConfig): string[] {
  if (config.dataPaths) {
    return config.dataPaths;
  } else if (config.dataPath) {
    return [config.dataPath];
  } else {
    throw new Error('No data file paths specified in configuration');
  }
}

/**
 * Create a configuration hash for change detection
 */
export function createConfigHash(config: AppConfig): string {
  // use imported `crypto`

  // Include only fields that affect processing
  const relevantConfig = {
    filePaths: getFilePaths(config),
    schemaPath: config.schemaPath,
    batchSize: config.batchSize,
    uuidColumn: config.uuidColumn || '',
    rulesPath: config.rulesPath || '',
    hidePII: config.hidePII,
    requiredFieldErrorsFailBatch: config.requiredFieldErrorsFailBatch,
  };

  const configString = JSON.stringify(relevantConfig, Object.keys(relevantConfig).sort());
  return crypto.createHash('md5').update(configString).digest('hex');
}

/**
 * Calculate total file hashes for content change detection
 */
export async function calculateFileHash(filePath: string): Promise<string> {
  // use imported `crypto` and `fs`

  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk: Buffer | string) => {
      if (typeof chunk === 'string') {
        hash.update(chunk, 'utf8');
      } else {
        hash.update(chunk);
      }
    });
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
