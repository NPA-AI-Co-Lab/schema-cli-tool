/**
 * e2e proof that the rate-limit stack (RateLimitGate + ThrottledLLMClient + runWithRetries,
 * rl-1..rl-6) lets `analyzeDataWithDb` complete a run under a simulated per-minute provider
 * rate limit, instead of the pre-fix behaviour where a 429 just failed the batch.
 *
 * Uses fake timers (`vi.useFakeTimers()`, which also fakes `Date`) so `RateLimitGate`'s and
 * `ThrottledFakeLLMClient`'s default clocks line up, and drives the run forward with an
 * advancing `vi.advanceTimersByTimeAsync` loop so minutes of simulated backoff cost no real
 * wall-clock time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import { analyzeDataWithDb } from '../src/analysis/pipeline-db.js';
import {
  createFixture,
  cleanupFixture,
  baseConfig,
  scoreResponse,
  type FixturePaths,
  type FixtureRow,
} from './helpers/db-pipeline-fixture.js';
import { ThrottledFakeLLMClient } from './fixtures/throttled-llm-client.js';

/** N synthetic rows, enough to spread across many batches under low concurrency. */
function generateRows(n: number): FixtureRow[] {
  return Array.from({ length: n }, (_, i) => ({ userID: `u${i}`, name: `Person ${i}` }));
}

/** Drives a run to completion under fake timers without letting virtual time run away. */
// Virtual-time budget. Metered release serialises retries at the provider's Retry-After
// pace, so a 3 RPM scenario legitimately needs several hundred virtual seconds; the jitter in
// retry.ts (0-500 ms per wait) makes the exact figure vary between runs. Virtual seconds are
// free, so the budget is generous — this guards against hangs, not against slowness.
async function runToCompletion<T>(promise: Promise<T>, maxIterations = 3000): Promise<T> {
  let settled = false;
  let result: T;
  let failure: unknown;
  promise.then(
    (r) => {
      result = r;
      settled = true;
    },
    (e) => {
      failure = e;
      settled = true;
    }
  );

  for (let i = 0; i < maxIterations && !settled; i++) {
    await vi.advanceTimersByTimeAsync(1000);
  }

  if (!settled) {
    throw new Error(`runToCompletion: run did not settle within ${maxIterations}s of virtual time`);
  }
  if (failure !== undefined) {
    throw failure;
  }
  return result!;
}

describe('e2e: pipeline completes under a simulated per-minute rate limit', () => {
  let fixture: FixturePaths;
  const ROW_COUNT = 20;

  beforeEach(async () => {
    vi.useFakeTimers();
    fixture = await createFixture(generateRows(ROW_COUNT));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupFixture(fixture);
  });

  function respond(request: { input: Array<{ content: string }> }) {
    const rows = JSON.parse(request.input[1].content as string) as unknown[];
    return scoreResponse(rows.length).result;
  }

  it('A) concurrency 5 / RPM 3: completes with no failed batches, every row in the output, and some 429s recorded', async () => {
    const client = new ThrottledFakeLLMClient({ requestsPerMinute: 3, respond });

    const config = baseConfig(fixture, {
      rulesPath: fixture.rulesPartialPath,
      batchSize: 2,
      concurrencySize: 5,
    });

    const summary = await runToCompletion(analyzeDataWithDb(config, client, true));

    expect(summary.failedBatchCount).toBe(0);
    expect(client.rateLimitedCount).toBeGreaterThan(0);

    const output = JSON.parse(await fs.readFile(fixture.outputPath, 'utf-8'));
    const entries = output.filter((entry: { '@type'?: string }) => entry['@type'] !== 'Dataset');
    expect(entries).toHaveLength(ROW_COUNT);

    console.log(
      `[scenario A] batches=${Math.ceil(ROW_COUNT / 2)} calls=${client.calls.length} 429s=${client.rateLimitedCount}`
    );
  });

  it('B) hackathon preset (concurrency 2, batchSize 5, rateLimitMaxRetries 8): completes with fewer 429s than A', async () => {
    // Scenario A's own 429 count, from a client with the identical row/RPM setup.
    const clientA = new ThrottledFakeLLMClient({ requestsPerMinute: 3, respond });
    const configA = baseConfig(fixture, {
      rulesPath: fixture.rulesPartialPath,
      batchSize: 2,
      concurrencySize: 5,
    });
    await runToCompletion(analyzeDataWithDb(configA, clientA, true));

    // Hackathon preset (config/hackathon.config.json), applied to this fixture: low
    // concurrency, patient rate-limit handling.
    const fixtureB = await createFixture(generateRows(ROW_COUNT));
    try {
      const clientB = new ThrottledFakeLLMClient({ requestsPerMinute: 3, respond });
      const configB = baseConfig(fixtureB, {
        rulesPath: fixtureB.rulesPartialPath,
        batchSize: 5, // hackathon.config.json
        concurrencySize: 2, // hackathon.config.json
        rateLimitMaxRetries: 8, // hackathon.config.json
        rateLimitMaxWaitMs: 120_000, // hackathon.config.json
        adaptiveConcurrency: true, // hackathon.config.json
      });

      const summaryB = await runToCompletion(analyzeDataWithDb(configB, clientB, true));

      expect(summaryB.failedBatchCount).toBe(0);
      const outputB = JSON.parse(await fs.readFile(fixtureB.outputPath, 'utf-8'));
      const entriesB = outputB.filter(
        (entry: { '@type'?: string }) => entry['@type'] !== 'Dataset'
      );
      expect(entriesB).toHaveLength(ROW_COUNT);

      expect(clientB.rateLimitedCount).toBeLessThan(clientA.rateLimitedCount);

      console.log(
        `[scenario B] 429s=${clientB.rateLimitedCount} (A had ${clientA.rateLimitedCount})`
      );
    } finally {
      await cleanupFixture(fixtureB);
    }
  });

  it('D) QA stress: concurrency 10 / batchSize 1 / RPM 3 — contention after a pause must not burn the retry budget', async () => {
    // Observed in QA on a real 3 RPM project: after every pause all 10 batches fired at once,
    // one succeeded and nine collected a fresh 429; with 6 retries x 20s per batch, 7 of 16
    // batches exhausted their budget. Metered release in RateLimitGate fixes this.
    const STRESS_ROWS = 16;
    const stressFixture = await createFixture(generateRows(STRESS_ROWS));
    try {
      // fixedRetryAfterMs mirrors OpenAI: every 429 says "try again in 20s" (60s / 3 RPM).
      const client = new ThrottledFakeLLMClient({
        requestsPerMinute: 3,
        respond,
        fixedRetryAfterMs: 20_000,
      });
      const config = baseConfig(stressFixture, {
        rulesPath: stressFixture.rulesPartialPath,
        batchSize: 1,
        concurrencySize: 10,
        rateLimitMaxRetries: 6, // default
      });

      const summary = await runToCompletion(analyzeDataWithDb(config, client, true));

      expect(summary.failedBatchCount).toBe(0);
      const output = JSON.parse(await fs.readFile(stressFixture.outputPath, 'utf-8'));
      const entries = output.filter((entry: { '@type'?: string }) => entry['@type'] !== 'Dataset');
      expect(entries).toHaveLength(STRESS_ROWS);

      // Metering keeps wasted 429s well below "one per batch per pause".
      expect(client.rateLimitedCount).toBeLessThan(STRESS_ROWS * 2);
      console.log(
        `[scenario D] batches=${STRESS_ROWS} calls=${client.calls.length} 429s=${client.rateLimitedCount}`
      );
    } finally {
      await cleanupFixture(stressFixture);
    }
  });

  it('C) regression proof: a client whose errors lack rate-limit diagnostics reports failed batches', async () => {
    const client = new ThrottledFakeLLMClient({
      requestsPerMinute: 3,
      respond,
      stripRateLimitDiagnostics: true, // simulates the pre-fix wrapper
    });

    const config = baseConfig(fixture, {
      rulesPath: fixture.rulesPartialPath,
      batchSize: 2,
      concurrencySize: 5,
    });

    const summary = await runToCompletion(analyzeDataWithDb(config, client, true));

    expect(client.rateLimitedCount).toBeGreaterThan(0);
    expect(summary.failedBatchCount).toBeGreaterThan(0);
  });
});
