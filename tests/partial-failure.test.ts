import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { analyzeDataWithDb } from '../src/analysis/pipeline-db.js';
import { DatabaseManager } from '../src/database/index.js';
import {
  createFixture,
  cleanupFixture,
  baseConfig,
  FakeLLMClient,
  scoreResponse,
  nonRetryableError,
  type FixturePaths,
} from './helpers/db-pipeline-fixture.js';

describe('rl-4: a single failed batch does not abort the whole run', () => {
  let fixture: FixturePaths;

  beforeEach(async () => {
    fixture = await createFixture([
      { userID: 'u1', name: 'Jane' },
      { userID: 'u2', name: 'John' },
      { userID: 'u3', name: 'Mary' },
      { userID: 'u4', name: 'Alex' },
    ]);
  });

  afterEach(async () => {
    await cleanupFixture(fixture);
  });

  function configFor(overrides: Record<string, unknown> = {}) {
    return baseConfig(fixture, {
      rulesPath: fixture.rulesPartialPath,
      batchSize: 1,
      concurrencySize: 2,
      ...overrides,
    });
  }

  it("a) resolves with failedBatchCount 1, keeps the other batches' output, and reports the csv range", async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const client = new FakeLLMClient((request) => {
      const body = JSON.stringify(request.input);
      if (body.includes('John')) {
        throw nonRetryableError('boom for John');
      }
      return scoreResponse(1);
    });

    const summary = await analyzeDataWithDb(configFor(), client, false);

    expect(summary.failedBatchCount).toBe(1);

    // The 3 unaffected rows made it into the output.
    const output = JSON.parse(await fs.readFile(fixture.outputPath, 'utf-8'));
    const entries = output.filter((entry: any) => entry['@type'] !== 'Dataset');
    expect(entries).toHaveLength(3);

    // The failed row's batch (rows 2-2, since batchSize=1 and it's the 2nd row) is
    // still unprocessed in the DB.
    const db = new DatabaseManager(fixture.databasePath);
    db.connect();
    const unprocessed = db.rows.getUnprocessedRows();
    expect(unprocessed).toHaveLength(1);
    const progress = db.state.getProcessingProgress();
    expect(progress.processed_rows).toBe(3);
    db.close();

    const summaryLines = errorSpy.mock.calls.map((call) => String(call[0]));
    expect(summaryLines.some((line) => line.includes('1 of 4 batches failed'))).toBe(true);
    expect(summaryLines.some((line) => line.includes('rows 2-2'))).toBe(true);
    expect(summaryLines.some((line) => line.includes('Re-run the same command to retry'))).toBe(
      true
    );

    errorSpy.mockRestore();
  });

  it('b) resuming re-queues only the failed row and completes the run', async () => {
    const client = new FakeLLMClient((request) => {
      const body = JSON.stringify(request.input);
      if (body.includes('John')) {
        throw nonRetryableError('boom for John');
      }
      return scoreResponse(1);
    });

    const firstSummary = await analyzeDataWithDb(configFor(), client, true);
    expect(firstSummary.failedBatchCount).toBe(1);

    const resumingClient = new FakeLLMClient(() => scoreResponse(1));
    const secondSummary = await analyzeDataWithDb(configFor(), resumingClient, true);

    expect(secondSummary.failedBatchCount).toBe(0);
    expect(secondSummary.warningCount).toBe(0);

    // Only the previously-failed row's batch was sent to the client this time.
    expect(resumingClient.calls).toHaveLength(1);
    expect(JSON.stringify(resumingClient.calls[0].input)).toContain('John');

    const db = new DatabaseManager(fixture.databasePath);
    db.connect();
    expect(db.state.isProcessing()).toBe(false);
    const progress = db.state.getProcessingProgress();
    expect(progress.processed_rows).toBe(4);
    db.close();

    const output = JSON.parse(await fs.readFile(fixture.outputPath, 'utf-8'));
    const entries = output.filter((entry: any) => entry['@type'] !== 'Dataset');
    expect(entries).toHaveLength(4);
  });

  it('c) failFast rejects on the first failure and starts at most concurrencySize batches', async () => {
    const client = new FakeLLMClient(() => {
      throw nonRetryableError('always fails');
    });

    await expect(analyzeDataWithDb(configFor({ failFast: true }), client, true)).rejects.toThrow(
      'always fails'
    );

    expect(client.calls.length).toBeLessThanOrEqual(2);

    const db = new DatabaseManager(fixture.databasePath);
    db.connect();
    expect(db.state.isProcessing()).toBe(true);
    db.close();
  });
});
