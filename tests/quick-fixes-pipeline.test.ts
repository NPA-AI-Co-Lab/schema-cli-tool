import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { processBatch, type ProcessBatchArgs } from '../src/analysis/processor.js';
import { analyzeDataWithDb } from '../src/analysis/pipeline-db.js';
import {
  createFixture,
  cleanupFixture,
  baseConfig,
  FakeLLMClient,
  scoreResponse,
  type FixturePaths,
} from './helpers/db-pipeline-fixture.js';

const passthroughDecodePII = (records: Record<string, unknown>) => records;

function baseBatchArgs(overrides: Partial<ProcessBatchArgs>): ProcessBatchArgs {
  return {
    instructions: 'instructions',
    zodSchema: z.object({}).passthrough(),
    batchLength: 1,
    index: 0,
    input: [],
    model: 'gpt-4.1',
    csvLineStart: 1,
    decodePII: passthroughDecodePII,
    encodingMap: {},
    ...overrides,
  };
}

describe('qf-1: lazy LLM client creation (processBatch unit tests)', () => {
  it('never calls getLlmClient for a fully deterministic batch', async () => {
    const getLlmClient = vi.fn();
    const prefills = [
      {
        mapped: { person: { score: 3 } },
        resolvedFields: new Set(['person.score']),
        pendingFields: new Set<string>(),
        missingRequired: new Set<string>(),
      },
    ];

    const result = await processBatch(baseBatchArgs({ getLlmClient, prefills }));

    expect(getLlmClient).not.toHaveBeenCalled();
    expect(result).toEqual([{ person: { score: 3 } }]);
  });

  it('surfaces the error from a lazy getLlmClient (with field names) for a batch with pending fields', async () => {
    const configError = new Error(
      'This run needs OpenAI for fields [person.score] but OPENAI_API_KEY is not set.'
    );
    const getLlmClient = vi.fn(() => {
      throw configError;
    });
    const prefills = [
      {
        mapped: {},
        resolvedFields: new Set<string>(),
        pendingFields: new Set<string>(['person.score']),
        missingRequired: new Set<string>(),
      },
    ];

    await expect(processBatch(baseBatchArgs({ getLlmClient, prefills }))).rejects.toThrow(
      'fields [person.score]'
    );
    expect(getLlmClient).toHaveBeenCalledTimes(1);
  });
});

describe('qf-1: analyzeDataWithDb lazy client (full pipeline)', () => {
  let fixture: FixturePaths;
  let originalApiKey: string | undefined;

  beforeEach(async () => {
    fixture = await createFixture([
      { userID: 'u1', name: 'Jane' },
      { userID: 'u2', name: 'John' },
    ]);
    originalApiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(async () => {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    await cleanupFixture(fixture);
  });

  it('completes a rules-only run without OPENAI_API_KEY and logs the rules-only phase message', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const config = baseConfig(fixture, { rulesPath: fixture.rulesFullPath });
    const summary = await analyzeDataWithDb(config, undefined, false);

    expect(summary.warningCount).toBe(0);

    const loggedRulesOnly = logSpy.mock.calls.some((call) =>
      String(call[0]).includes('rules-only, no LLM calls')
    );
    expect(loggedRulesOnly).toBe(true);

    const output = JSON.parse(
      await (await import('fs/promises')).readFile(fixture.outputPath, 'utf-8')
    );
    const entries = output.filter((entry: any) => entry['@type'] !== 'Dataset');
    expect(entries).toHaveLength(2);

    logSpy.mockRestore();
  });

  it('aborts the whole run with a ConfigurationError naming the pending fields when the LLM is needed but no key is configured', async () => {
    // A missing key cannot be fixed by retrying other batches, so — unlike an ordinary
    // failed batch under rl-4's partial-failure handling — it rejects the run immediately,
    // regardless of failFast (off by default here).
    const config = baseConfig(fixture, { rulesPath: fixture.rulesPartialPath });

    await expect(analyzeDataWithDb(config, undefined, true)).rejects.toThrow(
      /needs OpenAI for fields \[person\.score\]/
    );
  });

  it('rejects with a ConfigurationError when failFast is set and the LLM is needed but no key is configured', async () => {
    const config = baseConfig(fixture, {
      rulesPath: fixture.rulesPartialPath,
      failFast: true,
    });

    await expect(analyzeDataWithDb(config, undefined, true)).rejects.toThrow(
      /needs OpenAI for fields \[person\.score\]/
    );
  });

  it('never requires an LLM client for a deterministic run even when one would be needed for other configs', async () => {
    // Sanity check: passing an explicit fake client that would throw if used proves the
    // rules-only run never calls it.
    const fakeClient = new FakeLLMClient(() => {
      throw new Error('analyze() should not have been called');
    });
    const config = baseConfig(fixture, { rulesPath: fixture.rulesFullPath });

    const summary = await analyzeDataWithDb(config, fakeClient, true);

    expect(summary.warningCount).toBe(0);
    expect(fakeClient.calls).toHaveLength(0);
  });
});

describe('qf-2: finalize output and print a resume hint on mid-run failure', () => {
  let fixture: FixturePaths;

  beforeEach(async () => {
    fixture = await createFixture([
      { userID: 'u1', name: 'Jane' },
      { userID: 'u2', name: 'John' },
    ]);
  });

  afterEach(async () => {
    await cleanupFixture(fixture);
  });

  it('with failFast: writes the successfully processed entries and prints a resume hint when a later batch fails, then resumes to completion', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const failingClient = new FakeLLMClient((_request, callIndex) => {
      if (callIndex === 1) {
        throw new Error('simulated LLM outage');
      }
      return scoreResponse(1);
    });

    const config = baseConfig(fixture, {
      rulesPath: fixture.rulesPartialPath,
      concurrencySize: 1,
      batchSize: 1,
      // failFast reinstates the "abort the whole run" behaviour qf-2's finalize-on-error
      // path was built for; rl-4's default (failFast: false) is covered separately in
      // tests/partial-failure.test.ts.
      failFast: true,
    });

    await expect(analyzeDataWithDb(config, failingClient, false)).rejects.toThrow(
      'simulated LLM outage'
    );

    const stoppedMessage = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('Processing stopped'));
    expect(stoppedMessage).toContain('simulated LLM outage');

    const progressMessage = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('Progress saved to'));
    expect(progressMessage).toContain(fixture.databasePath);
    expect(progressMessage).toContain('1/2 rows');

    // Output was finalized even though the run rejected: it exists, parses as JSON-LD,
    // and contains the one entry that succeeded before the failure.
    const fs = await import('fs/promises');
    const firstRunOutput = JSON.parse(await fs.readFile(fixture.outputPath, 'utf-8'));
    const firstRunEntries = firstRunOutput.filter((entry: any) => entry['@type'] !== 'Dataset');
    expect(firstRunEntries).toHaveLength(1);

    errorSpy.mockRestore();

    // Second run with a fake client that now always succeeds: only the previously
    // failed row should be (re-)sent to the client, and the run completes.
    const resumingClient = new FakeLLMClient(() => scoreResponse(1));
    const resumeSummary = await analyzeDataWithDb(config, resumingClient, true);

    expect(resumeSummary.warningCount).toBe(0);
    expect(resumingClient.calls).toHaveLength(1);

    const secondRunOutput = JSON.parse(await fs.readFile(fixture.outputPath, 'utf-8'));
    const secondRunEntries = secondRunOutput.filter((entry: any) => entry['@type'] !== 'Dataset');
    expect(secondRunEntries).toHaveLength(2);
  });

  it('does not accumulate SIGINT/SIGTERM listeners across repeated in-process runs', async () => {
    const baselineSigint = process.listenerCount('SIGINT');
    const baselineSigterm = process.listenerCount('SIGTERM');

    const config = baseConfig(fixture, { rulesPath: fixture.rulesFullPath });

    await analyzeDataWithDb(config, undefined, true);
    expect(process.listenerCount('SIGINT')).toBe(baselineSigint);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm);

    await analyzeDataWithDb(config, undefined, true);
    expect(process.listenerCount('SIGINT')).toBe(baselineSigint);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm);
  });
});
