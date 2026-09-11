/**
 * A fake `ILLMClient` that simulates a provider-side per-minute rate limit (like OpenAI's
 * requests-per-minute cap) using a sliding 60s window, so tests can drive the real pipeline
 * (`analyzeDataWithDb`) end-to-end against a client that actually throws 429s under load —
 * exercising `RateLimitGate` + `ThrottledLLMClient` + `runWithRetries` together instead of
 * unit-testing them in isolation.
 *
 * Time is read from an injectable `now()` (defaulting to `Date.now`) so tests using
 * `vi.useFakeTimers()` see this client's window line up with the gate's own faked clock.
 */
import { LLMRequestError } from '../../src/clients/llm-errors.js';
import type {
  ILLMClient,
  LLMAnalysisRequest,
  LLMAnalysisResponse,
} from '../../src/interfaces/llm-client.interface.js';

const WINDOW_MS = 60_000;

export interface ThrottledFakeLLMClientOptions {
  /** Max requests allowed in any trailing 60s window before a 429 is thrown. */
  requestsPerMinute: number;
  /** Injectable clock, primarily so tests can drive fake time. Defaults to `Date.now`. */
  now?: () => number;
  /** Produces the `result` payload (e.g. `{ results: [...] }`) for an admitted request. */
  respond: (
    request: LLMAnalysisRequest,
    callIndex: number
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * When true, a rate-limit throws a bare `Error` with none of the `status` / `isRateLimit` /
   * `isRetryable` / `retryAfterMs` fields `LLMRequestError` normally carries — simulating the
   * pre-fix world where a thrown 429 couldn't be told apart from any other failure. Used only
   * by the regression-proof scenario; real callers get a proper `LLMRequestError`.
   */
  stripRateLimitDiagnostics?: boolean;
  /**
   * Report this fixed Retry-After on every 429 instead of the exact time until the window has
   * room. This is what OpenAI actually does for RPM limits ("Please try again in 20s" for
   * 3 RPM, regardless of how far into the minute you are) and it is what makes concurrent
   * retries realign into the same wave.
   */
  fixedRetryAfterMs?: number;
}

/** One recorded call: `ok: false` marks a simulated 429. */
export interface RecordedCall {
  t: number;
  ok: boolean;
}

export class ThrottledFakeLLMClient implements ILLMClient {
  public calls: RecordedCall[] = [];

  private readonly now: () => number;
  private windowTimestamps: number[] = [];

  constructor(private readonly opts: ThrottledFakeLLMClientOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Count of recorded calls that were rejected with a simulated 429. */
  get rateLimitedCount(): number {
    return this.calls.filter((c) => !c.ok).length;
  }

  async analyze(request: LLMAnalysisRequest): Promise<LLMAnalysisResponse> {
    const now = this.now();
    this.windowTimestamps = this.windowTimestamps.filter((t) => now - t < WINDOW_MS);

    if (this.windowTimestamps.length >= this.opts.requestsPerMinute) {
      const oldest = this.windowTimestamps[0];
      const retryAfterMs =
        this.opts.fixedRetryAfterMs ?? Math.max(0, oldest + WINDOW_MS - now) + 50;
      this.calls.push({ t: now, ok: false });

      const message = `Rate limit reached for ${request.model} in organization on requests per min (RPM). Please try again in ${(retryAfterMs / 1000).toFixed(1)}s.`;

      if (this.opts.stripRateLimitDiagnostics) {
        // Pre-fix simulation: a plain Error, indistinguishable from any other failure.
        throw new Error(message);
      }

      throw new LLMRequestError(message, {
        status: 429,
        isRateLimit: true,
        isRetryable: true,
        retryAfterMs,
      });
    }

    this.windowTimestamps.push(now);
    this.calls.push({ t: now, ok: true });

    const callIndex = this.calls.length - 1;
    const result = await this.opts.respond(request, callIndex);

    return { result, rawText: JSON.stringify(result), model: request.model };
  }

  getDefaultModel(): string {
    return 'gpt-4.1';
  }

  getFallbackModel(): string {
    return 'gpt-4.1';
  }

  isConfigured(): boolean {
    return true;
  }
}
