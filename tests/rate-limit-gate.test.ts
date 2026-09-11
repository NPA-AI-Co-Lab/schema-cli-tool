import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimitGate } from '../src/utils/rate-limit-gate.js';
import { adjustConcurrency } from '../src/utils/adaptive-concurrency.js';

describe('RateLimitGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('wait() resolves immediately when not paused', async () => {
    const gate = new RateLimitGate();
    await expect(gate.wait()).resolves.toBeUndefined();
    expect(gate.isPaused).toBe(false);
  });

  it('holds concurrent waiters until the pause elapses, then meters them out one per Retry-After', async () => {
    const gate = new RateLimitGate();
    gate.onRateLimit(10_000);

    let resolvedCount = 0;
    const waiters = [gate.wait(), gate.wait(), gate.wait()];
    for (const w of waiters) {
      w.then(() => {
        resolvedCount += 1;
      });
    }

    await vi.advanceTimersByTimeAsync(0);
    expect(resolvedCount).toBe(0);
    expect(gate.isPaused).toBe(true);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(resolvedCount).toBe(0);

    // Pause ends: exactly one waiter goes through; the rest are spaced by the 10s hint so
    // they do not all collide with the provider's freshly refilled single slot.
    await vi.advanceTimersByTimeAsync(1);
    expect(resolvedCount).toBe(1);
    expect(gate.isPaused).toBe(false);
    expect(gate.isMetering).toBe(true);
    expect(gate.meterSpacingMs).toBe(10_000);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolvedCount).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(waiters);
    expect(resolvedCount).toBe(3);
    expect(gate.isMetering).toBe(false);

    // Queue drained: a fresh caller is not held.
    await expect(gate.wait()).resolves.toBeUndefined();
  });

  it('halves metering spacing after every 3 consecutive successes and resets it on the next 429', () => {
    const gate = new RateLimitGate();
    gate.onRateLimit(8_000);
    expect(gate.meterSpacingMs).toBe(8_000);

    gate.onSuccess();
    gate.onSuccess();
    expect(gate.meterSpacingMs).toBe(8_000);
    gate.onSuccess();
    expect(gate.meterSpacingMs).toBe(4_000);
    gate.onSuccess();
    gate.onSuccess();
    gate.onSuccess();
    expect(gate.meterSpacingMs).toBe(2_000);

    gate.onRateLimit(20_000);
    expect(gate.meterSpacingMs).toBe(20_000);
  });

  it('a 429 arriving mid-drain re-pauses and then resumes metering', async () => {
    const gate = new RateLimitGate();
    gate.onRateLimit(5_000);
    const order: string[] = [];
    const a = gate.wait().then(() => order.push('a'));
    const b = gate.wait().then(() => order.push('b'));
    const c = gate.wait().then(() => order.push('c'));

    await vi.advanceTimersByTimeAsync(5_000); // pause ends → a released, b/c metered
    expect(order).toEqual(['a']);

    gate.onRateLimit(5_000); // a got another 429 → everyone pauses again
    await vi.advanceTimersByTimeAsync(4_999);
    expect(order).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(1); // pause ends → b released, c metered 5s later
    expect(order).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([a, b, c]);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('pauseFor never shortens an existing pause', () => {
    const gate = new RateLimitGate();
    gate.pauseFor(10_000);
    const firstPausedFor = gate.pausedForMs;
    expect(firstPausedFor).toBeGreaterThan(0);

    gate.pauseFor(1_000);
    // Still paused for (approximately) the original, longer duration.
    expect(gate.pausedForMs).toBeGreaterThanOrEqual(9_000);

    gate.pauseFor(60_000);
    expect(gate.pausedForMs).toBeGreaterThanOrEqual(59_000);
  });

  it('onRateLimit without retryAfterMs backs off exponentially, capped at 64s', () => {
    const gate = new RateLimitGate();

    gate.onRateLimit();
    expect(gate.pausedForMs).toBe(2_000); // 1000 * 2^1 (consecutive429 is now 1)

    vi.advanceTimersByTime(2_000);
    gate.onRateLimit();
    expect(gate.pausedForMs).toBe(4_000); // 1000 * 2^2

    vi.advanceTimersByTime(4_000);
    gate.onRateLimit();
    expect(gate.pausedForMs).toBe(8_000); // 1000 * 2^3

    // Drive consecutive429 well past the cap exponent and confirm it never exceeds 64s.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(gate.pausedForMs);
      gate.onRateLimit();
      expect(gate.pausedForMs).toBeLessThanOrEqual(64_000);
    }
    expect(gate.pausedForMs).toBe(64_000);
  });

  it('onRateLimit honours an explicit retryAfterMs over the exponential backoff', () => {
    const gate = new RateLimitGate();
    gate.onRateLimit(30_000);
    expect(gate.pausedForMs).toBe(30_000);
  });

  it('rejects wait() immediately when aborted during a pause', async () => {
    const gate = new RateLimitGate();
    gate.onRateLimit(10_000);

    const controller = new AbortController();
    const waitPromise = gate.wait(controller.signal);

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(waitPromise).rejects.toThrow();
  });

  it('rejects wait() immediately when the signal is already aborted', async () => {
    const gate = new RateLimitGate();
    gate.onRateLimit(10_000);

    const controller = new AbortController();
    controller.abort();

    await expect(gate.wait(controller.signal)).rejects.toThrow();
  });

  it('onSuccess resets consecutive429 and grows the success streak', () => {
    const gate = new RateLimitGate();
    gate.onRateLimit(1000);
    expect(gate.consecutive429).toBe(1);

    gate.onSuccess();
    expect(gate.consecutive429).toBe(0);
    expect(gate.successStreak).toBe(1);

    gate.onSuccess();
    expect(gate.successStreak).toBe(2);
  });

  it('resetSuccessStreak zeroes the streak without affecting pause state', () => {
    const gate = new RateLimitGate();
    gate.onSuccess();
    gate.onSuccess();
    expect(gate.successStreak).toBe(2);

    gate.pauseFor(5000);
    gate.resetSuccessStreak();
    expect(gate.successStreak).toBe(0);
    expect(gate.pausedForMs).toBeGreaterThan(0);
  });
});

describe('adjustConcurrency (adaptive concurrency helper)', () => {
  it('halves concurrency after 2 consecutive 429s, halves again after 2 more, then ramps back up after 20 successes', () => {
    const gate = new RateLimitGate();
    const limiter = { concurrency: 5 };
    const reduced: number[] = [];
    const onReduce = (n: number) => reduced.push(n);

    // One 429 alone is not "repeated" yet.
    gate.onRateLimit(1000);
    adjustConcurrency(gate, limiter, 5, onReduce);
    expect(limiter.concurrency).toBe(5);

    // Second consecutive 429 crosses the threshold: 5 -> 2 (floor(5/2)).
    gate.onRateLimit(1000);
    adjustConcurrency(gate, limiter, 5, onReduce);
    expect(limiter.concurrency).toBe(2);
    expect(reduced).toEqual([2]);

    // Two more consecutive 429s: still >= 2 consecutive, halve again: 2 -> 1.
    gate.onRateLimit(1000);
    adjustConcurrency(gate, limiter, 5, onReduce);
    gate.onRateLimit(1000);
    adjustConcurrency(gate, limiter, 5, onReduce);
    expect(limiter.concurrency).toBe(1);
    expect(reduced).toEqual([2, 1]);

    // Never reduces below 1, even while consecutive429 keeps climbing.
    gate.onRateLimit(1000);
    adjustConcurrency(gate, limiter, 5, onReduce);
    expect(limiter.concurrency).toBe(1);
    expect(reduced).toEqual([2, 1]);

    // 20 consecutive clean successes ramp concurrency back up by 1 and consume the streak.
    for (let i = 0; i < 19; i++) {
      gate.onSuccess();
      adjustConcurrency(gate, limiter, 5, onReduce);
      expect(limiter.concurrency).toBe(1);
    }
    gate.onSuccess();
    expect(gate.successStreak).toBe(20);
    adjustConcurrency(gate, limiter, 5, onReduce);
    expect(limiter.concurrency).toBe(2);
    expect(gate.successStreak).toBe(0);
  });

  it('is a no-op the caller can skip entirely, matching adaptiveConcurrency: false — the gate still pauses', () => {
    const gate = new RateLimitGate();
    const limiter = { concurrency: 5 };

    gate.onRateLimit(1000);
    gate.onRateLimit(1000);
    // Simulates pipeline-db.ts's `if (adaptiveConcurrency === false) return;` guard: the
    // caller simply never invokes adjustConcurrency, so the limiter is untouched even
    // though the gate has recorded repeated 429s and is paused.
    expect(gate.consecutive429).toBe(2);
    expect(gate.isPaused).toBe(true);
    expect(limiter.concurrency).toBe(5);
  });

  it('does not ramp concurrency above configuredConcurrency', () => {
    const gate = new RateLimitGate();
    const limiter = { concurrency: 5 };

    for (let i = 0; i < 25; i++) {
      gate.onSuccess();
      adjustConcurrency(gate, limiter, 5, () => {});
    }
    expect(limiter.concurrency).toBe(5);
  });
});
