/**
 * Process-wide gate that lets any number of concurrent callers cooperatively pause when
 * the LLM provider signals a rate limit (HTTP 429), and ramps a success streak so callers
 * can tell when it is safe to grow concurrency back up.
 *
 * It holds a single `pausedUntil` timestamp and a list of pending resolvers, woken by one
 * shared timer (never a busy poll). `wait()` is the only thing callers need to call before
 * doing work; `onRateLimit`/`onSuccess` report outcomes.
 *
 * Metered release: when a pause ends, waiters are NOT all released at once. The provider's
 * Retry-After tells us how long until there is room for one more request, so waiters are let
 * through one at a time, spaced by that interval. Without this, N concurrent batches all fire
 * the moment the pause ends, one succeeds and N-1 collect a fresh 429 — burning their retry
 * budget on contention rather than on real waiting (observed in QA: concurrency 10 vs 3 RPM
 * exhausted 6 retries per batch and failed 7 of 16 batches). Spacing halves after every 3
 * consecutive successes so a single blip does not throttle a healthy account for long, and
 * resets to the new Retry-After on the next 429. Metering ends when the queue drains.
 *
 * See the comment at the top of `throttled-llm-client.ts` for how this gate divides
 * responsibility with the per-batch retry loop in `retry.ts`.
 */

const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 64_000;
const MAX_BACKOFF_EXPONENT = 6; // 1000 * 2^6 = 64_000
const MIN_SPACING_MS = 250;
const MAX_SPACING_MS = 60_000;
const SPACING_HALVING_STREAK = 3;

export interface RateLimitGateOptions {
  /** Injectable clock, primarily so tests can drive fake time. */
  now?: () => number;
  /** Injectable `setTimeout`, primarily so tests can drive fake timers. */
  setTimeoutFn?: typeof setTimeout;
  /** Injectable `clearTimeout`, paired with `setTimeoutFn`. */
  clearTimeoutFn?: typeof clearTimeout;
}

interface PendingWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/**
 * Coordinates process-wide backoff across concurrent LLM callers.
 */
export class RateLimitGate {
  private readonly now: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  private pausedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waiters: PendingWaiter[] = [];

  /** Interval between metered releases; 0 = no metering (no 429 seen yet). */
  private spacingMs = 0;
  private meterTimer: ReturnType<typeof setTimeout> | null = null;

  private consecutive429Count = 0;
  private successStreakCount = 0;

  constructor(opts: RateLimitGateOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn = opts.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout;
  }

  /** Whether the gate is currently holding callers back. */
  get isPaused(): boolean {
    return this.pausedUntil > this.now();
  }

  /** Milliseconds remaining in the current pause (0 when not paused). */
  get pausedForMs(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  get consecutive429(): number {
    return this.consecutive429Count;
  }

  get successStreak(): number {
    return this.successStreakCount;
  }

  /** Whether waiters are currently being let through one at a time. */
  get isMetering(): boolean {
    return this.meterTimer !== null;
  }

  /** Current spacing between metered releases (0 when not metering). */
  get meterSpacingMs(): number {
    return this.spacingMs;
  }

  /**
   * Resolves immediately if the gate isn't paused; otherwise resolves once the current
   * pause elapses. Rejects immediately if `signal` is already aborted, and rejects as soon
   * as it aborts while waiting.
   */
  wait(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(this.abortError());
    }

    if (!this.isPaused && !this.isMetering) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: PendingWaiter = { resolve, reject, signal };

      if (signal) {
        const onAbort = () => {
          this.removeWaiter(waiter);
          reject(this.abortError());
        };
        waiter.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.waiters.push(waiter);
      if (!this.timer && !this.meterTimer) {
        this.scheduleTimer();
      }
    });
  }

  /**
   * Extends the pause so it ends no sooner than `ms` from now. Idempotent: never shortens
   * an existing pause that already ends later.
   */
  pauseFor(ms: number): void {
    const candidate = this.now() + Math.max(0, ms);
    if (candidate > this.pausedUntil) {
      this.pausedUntil = candidate;
      this.scheduleTimer();
    }
  }

  /**
   * Records a rate-limit response: bumps the consecutive-429 count, resets the success
   * streak, and pauses for the provider's Retry-After hint (when given) or an exponential
   * backoff (1s, 2s, 4s, ... capped at 64s) keyed off the consecutive-429 count.
   */
  onRateLimit(retryAfterMs?: number): void {
    this.consecutive429Count += 1;
    this.successStreakCount = 0;

    const backoffMs =
      retryAfterMs !== undefined && retryAfterMs > 0
        ? retryAfterMs
        : DEFAULT_BACKOFF_BASE_MS * 2 ** Math.min(this.consecutive429Count, MAX_BACKOFF_EXPONENT);

    const pauseMs = Math.min(backoffMs, DEFAULT_BACKOFF_CAP_MS);
    // The provider's hint is our best estimate of its refill rate: one request per pauseMs.
    this.spacingMs = Math.min(MAX_SPACING_MS, Math.max(MIN_SPACING_MS, pauseMs));
    this.pauseFor(pauseMs);
  }

  /**
   * Records a successful call: clears the consecutive-429 count and grows the streak. Every
   * SPACING_HALVING_STREAK consecutive successes halve the metering spacing so the queue
   * drains faster once the provider is clearly accepting requests again.
   */
  onSuccess(): void {
    this.consecutive429Count = 0;
    this.successStreakCount += 1;
    if (this.spacingMs > 0 && this.successStreakCount % SPACING_HALVING_STREAK === 0) {
      this.spacingMs = Math.max(MIN_SPACING_MS, Math.floor(this.spacingMs / 2));
    }
  }

  /**
   * Zeroes the success streak without touching pause state. Not part of the core
   * wait/pauseFor/onRateLimit/onSuccess contract — added so a caller (pipeline-db's
   * adaptive-concurrency step) can consume a streak once it has acted on it, otherwise a
   * streak that has already crossed the ramp-up threshold would keep re-triggering a
   * concurrency increase on every subsequent success instead of requiring a fresh streak.
   */
  resetSuccessStreak(): void {
    this.successStreakCount = 0;
  }

  private removeWaiter(waiter: PendingWaiter): void {
    const idx = this.waiters.indexOf(waiter);
    if (idx !== -1) {
      this.waiters.splice(idx, 1);
    }
  }

  private abortError(): Error {
    return new Error('Aborted while waiting for rate-limit gate');
  }

  /** (Re)schedules the single shared timer to fire when the current pause elapses. */
  private scheduleTimer(): void {
    if (!this.isPaused) {
      if (!this.meterTimer) {
        this.releaseWaiters();
      }
      return;
    }

    if (this.timer) {
      this.clearTimeoutFn(this.timer);
    }

    const delay = this.pausedForMs;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.scheduleTimer();
    }, delay);
  }

  /**
   * Called once the pause has elapsed. Releases one waiter now and, if spacing is known,
   * meters the rest one per `spacingMs`; without a spacing hint releases everyone.
   */
  private releaseWaiters(): void {
    if (this.spacingMs <= 0) {
      const toRelease = this.waiters;
      this.waiters = [];
      for (const waiter of toRelease) {
        this.resolveWaiter(waiter);
      }
      return;
    }

    this.releaseOneMetered();
  }

  private releaseOneMetered(): void {
    this.meterTimer = null;

    if (this.isPaused) {
      // A new 429 arrived mid-drain: defer to the pause timer, which resumes metering after.
      this.scheduleTimer();
      return;
    }

    const next = this.waiters.shift();
    if (!next) {
      return; // queue drained — metering ends, full speed until the next 429
    }
    this.resolveWaiter(next);

    if (this.waiters.length > 0) {
      this.meterTimer = this.setTimeoutFn(() => this.releaseOneMetered(), this.spacingMs);
    }
  }

  private resolveWaiter(waiter: PendingWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    waiter.resolve();
  }
}
