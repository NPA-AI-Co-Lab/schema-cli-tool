/**
 * Adapts a p-limit-style concurrency limiter to a {@link RateLimitGate}'s recent history.
 * Factored out of `pipeline-db.ts` so the halve-on-repeated-429s / ramp-up-on-a-clean-
 * streak algorithm can be unit tested without driving the full analysis pipeline.
 */
import type { RateLimitGate } from './rate-limit-gate.js';

const RAMP_UP_SUCCESS_STREAK = 20;
const REDUCE_AFTER_CONSECUTIVE_429 = 2;

/** The subset of p-limit's `LimitFunction` this helper needs — a writable `concurrency`. */
export interface ConcurrencyLimiter {
  concurrency: number;
}

/**
 * Call after every batch settles (success or failure). Halves `limiter.concurrency`
 * (never below 1) once two 429s have landed back-to-back, invoking `onReduce` with the
 * new value so the caller can log it. Once a run of 20 clean successes has accumulated,
 * grows `limiter.concurrency` by 1 (up to `configuredConcurrency`) and resets the streak
 * so a further increase needs another full run of successes.
 */
export function adjustConcurrency(
  gate: RateLimitGate,
  limiter: ConcurrencyLimiter,
  configuredConcurrency: number,
  onReduce?: (newConcurrency: number) => void
): void {
  if (gate.consecutive429 >= REDUCE_AFTER_CONSECUTIVE_429 && limiter.concurrency > 1) {
    const next = Math.max(1, Math.floor(limiter.concurrency / 2));
    if (next !== limiter.concurrency) {
      limiter.concurrency = next;
      onReduce?.(next);
    }
    return;
  }

  if (gate.successStreak >= RAMP_UP_SUCCESS_STREAK && limiter.concurrency < configuredConcurrency) {
    limiter.concurrency += 1;
    gate.resetSuccessStreak();
  }
}
