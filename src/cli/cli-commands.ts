import { analyzeDataWithDb } from '../analysis/pipeline-db.js';
import {
  AppConfig,
  bold,
  getAppParams,
  getAppParamsFromConfig,
  loadAppConfig,
  removeCliSigintHandler,
  restoreCliSigintHandler,
} from '../utils/index.js';
import { deriveDatabasePath } from '../database/index.js';
import { CliOptions, PackageInfo } from './cli-types.js';
import { shouldUseInteractiveMode, validateOptions } from './cli-config.js';

function parseFieldList(value?: string): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : undefined;
}

/**
 * Main CLI command handler
 */
export async function runAnalyzeCommand(options: CliOptions, pkg: PackageInfo) {
  try {
    if (shouldUseInteractiveMode(options)) {
      return await runInteractiveMode(options, pkg);
    }

    return await runCliMode(options, pkg);
  } catch (error) {
    console.error('❌ Analysis failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Run in interactive mode
 */
async function runInteractiveMode(options: CliOptions, pkg: PackageInfo) {
  // Automatically enable quiet mode when using stdout to avoid interfering with JSON output
  const quiet = options.quiet || options.stdout || false;

  if (!quiet) {
    console.error(`\n${bold(`Welcome to ${pkg.name} ${pkg.version}!`)}\n`);
  }

  const baseParams = options.config
    ? await getAppParamsFromConfig(options.config)
    : await getAppParams();

  const includeFields = parseFieldList(options.llmFields);
  const excludeFields = parseFieldList(options.noLlmFields);
  const llmFieldOverrides =
    includeFields || excludeFields
      ? {
          ...(includeFields ? { include: includeFields } : {}),
          ...(excludeFields ? { exclude: excludeFields } : {}),
        }
      : undefined;

  const appParams: AppConfig = {
    ...baseParams,
    batchSize: options.batchSize ? parseInt(options.batchSize, 10) : baseParams.batchSize,
    concurrencySize: options.concurrency
      ? parseInt(options.concurrency, 10)
      : baseParams.concurrencySize,
    retriesNumber: options.retries ? parseInt(options.retries, 10) : baseParams.retriesNumber,
    defaultModel: options.model || baseParams.defaultModel,
    fallbackModel: options.fallbackModel || baseParams.fallbackModel,
    enableLogging: options.logging ?? baseParams.enableLogging,
    hidePII: options.hidePii ?? baseParams.hidePII,
    requiredFieldErrorsFailBatch:
      options.requiredFieldsFailBatch ?? baseParams.requiredFieldErrorsFailBatch,
    uuidColumn: baseParams.uuidColumn,
    rulesPath: options.rules || baseParams.rulesPath,
    llmFieldOverrides,
  };

  if (options.stdout) {
    appParams.outputPath = '';

    if (!appParams.databasePath) {
      const baseOut = baseParams.outputPath || '';
      if (baseOut) {
        appParams.databasePath = deriveDatabasePath(baseOut);
      }
    }
  }

  removeCliSigintHandler();

  try {
    const summary = await analyzeDataWithDb(appParams, undefined, quiet);

    if (!quiet) {
      if (summary.warningCount > 0) {
        console.error(
          `Results saved to: ${appParams.outputPath}. Warning count: ${summary.warningCount}`
        );
      } else {
        console.error(`✅ Analysis completed! Results saved to: ${appParams.outputPath}`);
      }
    }

    process.exitCode = summary.warningCount > 0 ? 2 : 0;
  } catch (error) {
    restoreCliSigintHandler();
    throw error;
  }
}

/**
 * Run in CLI mode
 */
async function runCliMode(options: CliOptions, pkg: PackageInfo) {
  // Automatically enable quiet mode when using stdout to avoid interfering with JSON output
  const quiet = options.quiet || options.stdout || false;

  if (!quiet) {
    console.error(`\n${bold(`Welcome to ${pkg.name} ${pkg.version}!`)}\n`);
  }

  validateOptions(options);

  // Get base config and apply CLI overrides
  const baseConfig = options.config ? loadAppConfig(options.config) : loadAppConfig();

  const includeFields = parseFieldList(options.llmFields);
  const excludeFields = parseFieldList(options.noLlmFields);
  const llmFieldOverrides =
    includeFields || excludeFields
      ? {
          ...(includeFields ? { include: includeFields } : {}),
          ...(excludeFields ? { exclude: excludeFields } : {}),
        }
      : undefined;

  const appParams: AppConfig = {
    ...baseConfig,
    dataPaths: options.input ? [options.input] : baseConfig.dataPaths,
    schemaPath: options.schema || baseConfig.schemaPath,
    outputPath: options.output || baseConfig.outputPath,
    databasePath: baseConfig.databasePath,
    enableLogging: options.logging ?? baseConfig.enableLogging,
    hidePII: options.hidePii ?? baseConfig.hidePII,
    retriesNumber: options.retries ? parseInt(options.retries, 10) : baseConfig.retriesNumber,
    requiredFieldErrorsFailBatch:
      options.requiredFieldsFailBatch ?? baseConfig.requiredFieldErrorsFailBatch,
    batchSize: options.batchSize ? parseInt(options.batchSize, 10) : baseConfig.batchSize,
    concurrencySize: options.concurrency
      ? parseInt(options.concurrency, 10)
      : baseConfig.concurrencySize,
    defaultModel: options.model || baseConfig.defaultModel,
    fallbackModel: options.fallbackModel || baseConfig.fallbackModel,
    uuidColumn: baseConfig.uuidColumn,
    rulesPath: options.rules || baseConfig.rulesPath,
    llmFieldOverrides,
    resumeMode: baseConfig.resumeMode,
  };

  // If stdout mode requested, ensure outputPath signals stdout and set a database path
  if (options.stdout) {
    appParams.outputPath = '';

    if (!appParams.databasePath) {
      const baseOut = baseConfig.outputPath || '';
      if (baseOut) {
        appParams.databasePath = deriveDatabasePath(baseOut);
      }
    }
  }

  // Determine output mode: stdout vs file
  const outputToFile = !options.stdout && !!(options.output || baseConfig.outputPath);

  if (!quiet) {
    console.error(`- Output: ${outputToFile ? appParams.outputPath : 'stdout'}`);
    console.error(`- Logging: ${appParams.enableLogging ? 'enabled' : 'disabled'}`);
    console.error(`- PII protection: ${appParams.hidePII ? 'enabled' : 'disabled'}`);
    console.error(`- Retries set: ${appParams.retriesNumber}\n`);
  }

  removeCliSigintHandler();

  try {
    const summary = await analyzeDataWithDb(appParams, undefined, quiet);

    if (!quiet && outputToFile) {
      if (summary.warningCount > 0) {
        console.error(
          `Results saved to: ${appParams.outputPath}. Warning count: ${summary.warningCount}`
        );
      } else {
        console.error(`✅ Analysis completed! Results saved to: ${appParams.outputPath}`);
      }
    }

    process.exitCode = summary.warningCount > 0 ? 2 : 0;
  } catch (error) {
    restoreCliSigintHandler();
    throw error;
  }
}
