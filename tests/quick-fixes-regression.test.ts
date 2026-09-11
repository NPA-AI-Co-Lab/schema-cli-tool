import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LLMClientFactory } from '../src/clients/llm-client-factory.js';
import { LLMRequestError } from '../src/clients/llm-errors.js';
import { analyzeDataWithDb } from '../src/analysis/pipeline-db.js';
import type { AppConfig } from '../src/utils/types.js';
import type {
  ILLMClient,
  LLMAnalysisRequest,
  LLMAnalysisResponse,
} from '../src/interfaces/llm-client.interface.js';

describe('qf-1/qf-2 regression tests', () => {
  let tempDir: string;
  let originalApiKey: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qf-test-'));
    originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(async () => {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('rules-only run without OPENAI_API_KEY should complete without calling LLMClientFactory.createFromEnv', async () => {
    const factorySpy = vi.spyOn(LLMClientFactory, 'createFromEnv');

    // Read the original rules and create a rules-only version
    const originalRulesPath = './config/sample_comments.rules.json';
    const originalRulesContent = JSON.parse(await fs.readFile(originalRulesPath, 'utf-8'));

    // Create rules with empty llm.fields (fully deterministic)
    const rulesOnlyVersion = {
      ...originalRulesContent,
      llm: {
        ...originalRulesContent.llm,
        fields: [],
      },
    };

    const rulesPath = path.join(tempDir, 'rules-only.json');
    await fs.writeFile(rulesPath, JSON.stringify(rulesOnlyVersion, null, 2));

    const outputPath = path.join(tempDir, 'output.jsonld');
    const config: AppConfig = {
      dataPaths: ['./examples/sample_comments.csv'],
      schemaPath: './examples/schema.jsonld',
      rulesPath,
      outputPath,
      enableLogging: false,
      hidePII: true,
      retriesNumber: 2,
      requiredFieldErrorsFailBatch: false,
      batchSize: 5,
      concurrencySize: 2,
      defaultModel: 'gpt-4.1',
      fallbackModel: 'gpt-4.1',
    };

    const summary = await analyzeDataWithDb(config, undefined, false);

    // Verify the run succeeded
    expect(summary.warningCount).toBe(0);
    expect(summary.failedBatchCount).toBe(0);

    // Verify LLMClientFactory.createFromEnv was never called
    expect(factorySpy).not.toHaveBeenCalled();

    // Verify output was generated with all rows
    const outputContent = JSON.parse(await fs.readFile(outputPath, 'utf-8'));
    const entries = outputContent.filter((entry: any) => entry['@type'] !== 'Dataset');
    expect(entries.length).toBeGreaterThan(0);

    factorySpy.mockRestore();
  });

  it('LLM-required run without OPENAI_API_KEY should reject with ConfigurationError naming the LLM fields', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outputPath = path.join(tempDir, 'output.jsonld');
    const config: AppConfig = {
      dataPaths: ['./examples/sample_comments.csv'],
      schemaPath: './examples/schema.jsonld',
      rulesPath: './config/sample_comments.rules.json', // Has LLM fields
      outputPath,
      enableLogging: false,
      hidePII: true,
      retriesNumber: 2,
      requiredFieldErrorsFailBatch: false,
      batchSize: 5,
      concurrencySize: 2,
      defaultModel: 'gpt-4.1',
      fallbackModel: 'gpt-4.1',
      failFast: true,
    };

    // Run should reject because no API key is set
    await expect(analyzeDataWithDb(config, undefined, false)).rejects.toThrow();

    // Error message should mention the LLM fields that are needed
    const errorMessages = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).toContain('person.engagementScore');

    errorSpy.mockRestore();
  });

  it('missing OPENAI_API_KEY aborts the whole run immediately even without failFast (no per-batch failure spam)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outputPath = path.join(tempDir, 'output.jsonld');
    const config: AppConfig = {
      dataPaths: ['./examples/sample_comments.csv'],
      schemaPath: './examples/schema.jsonld',
      rulesPath: './config/sample_comments.rules.json', // Has LLM fields
      outputPath,
      enableLogging: false,
      hidePII: true,
      retriesNumber: 2,
      requiredFieldErrorsFailBatch: false,
      batchSize: 5,
      concurrencySize: 2,
      defaultModel: 'gpt-4.1',
      fallbackModel: 'gpt-4.1',
      // failFast deliberately left at its default (false)
    };

    // A configuration error cannot be fixed by retrying other batches: the run must reject
    // with the ConfigurationError itself instead of resolving with N failed batches.
    await expect(analyzeDataWithDb(config, undefined, false)).rejects.toThrow(
      /OPENAI_API_KEY is not set/
    );

    const errorMessages = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    // Only the batches already in flight (≤ concurrencySize) may have logged a failure —
    // not one line per batch of the whole file.
    const perBatchLines = errorMessages.split('\n').filter((line) => line.includes('failed (rows'));
    expect(perBatchLines.length).toBeLessThanOrEqual(config.concurrencySize);
    expect(errorMessages).not.toContain('Re-run the same command to retry the failed batches');
    expect(errorMessages).toContain('Re-run the same command to resume');

    errorSpy.mockRestore();
  });

  it('a 401/403 from the provider aborts the whole run immediately (invalid or placeholder key)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.OPENAI_API_KEY = 'placeholder';

    class UnauthorizedClient implements ILLMClient {
      calls = 0;
      getDefaultModel(): string {
        return 'test-model';
      }
      getFallbackModel(): string {
        return 'test-model';
      }
      isConfigured(): boolean {
        return true;
      }
      async analyze(_request: LLMAnalysisRequest): Promise<LLMAnalysisResponse> {
        this.calls += 1;
        throw new LLMRequestError('401 Incorrect API key provided: placeholder', {
          status: 401,
          isRetryable: false,
        });
      }
    }

    const client = new UnauthorizedClient();
    const config: AppConfig = {
      dataPaths: ['./examples/sample_comments.csv'],
      schemaPath: './examples/schema.jsonld',
      rulesPath: './config/sample_comments.rules.json',
      outputPath: path.join(tempDir, 'output.jsonld'),
      enableLogging: false,
      hidePII: true,
      retriesNumber: 2,
      requiredFieldErrorsFailBatch: false,
      batchSize: 5,
      concurrencySize: 2,
      defaultModel: 'gpt-4.1',
      fallbackModel: 'gpt-4.1',
    };

    await expect(analyzeDataWithDb(config, client, false)).rejects.toThrow(/401/);
    // Only the batches already in flight were attempted — not all four.
    expect(client.calls).toBeLessThanOrEqual(config.concurrencySize);

    const errorMessages = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages).not.toContain('Re-run the same command to retry the failed batches');
    expect(errorMessages).toContain('Processing stopped');

    errorSpy.mockRestore();
  });

  it('finalize-on-failure: output file is written and stderr contains Re-run hint when non-retryable error occurs', async () => {
    class FailingClient implements ILLMClient {
      getDefaultModel(): string {
        return 'test-model';
      }

      getFallbackModel(): string {
        return 'test-fallback';
      }

      async analyze(_request: LLMAnalysisRequest): Promise<LLMAnalysisResponse> {
        const error = new Error('Permanent API failure (non-retryable)');
        (error as any).isRetryable = false;
        throw error;
      }
    }

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outputPath = path.join(tempDir, 'output.jsonld');
    const config: AppConfig = {
      dataPaths: ['./examples/sample_comments.csv'],
      schemaPath: './examples/schema.jsonld',
      rulesPath: './config/sample_comments.rules.json',
      outputPath,
      enableLogging: false,
      hidePII: true,
      retriesNumber: 1,
      requiredFieldErrorsFailBatch: false,
      batchSize: 2,
      concurrencySize: 1,
      defaultModel: 'gpt-4.1',
      fallbackModel: 'gpt-4.1',
      failFast: true,
    };

    const failingClient = new FailingClient();

    // Run should reject
    await expect(analyzeDataWithDb(config, failingClient, false)).rejects.toThrow();

    // Output file should exist and be valid JSON-LD (partial output after finalization)
    expect(await fs.stat(outputPath)).toBeDefined();
    const outputContent = JSON.parse(await fs.readFile(outputPath, 'utf-8'));
    expect(Array.isArray(outputContent)).toBe(true);

    // Stderr should contain a Re-run hint
    const errorMessages = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(errorMessages.toLowerCase()).toMatch(/re[- ]?run/i);

    errorSpy.mockRestore();
  });
});
