/**
 * `ILLMClient` decorator that makes every caller cooperate through a shared
 * {@link RateLimitGate} instead of hammering the provider independently.
 *
 * Division of labour with `src/utils/retry.ts` (rl-2), so a 429 is never waited out twice:
 *
 *   1. `analyze()` calls `gate.wait(signal)` *before* issuing the request. If the gate is
 *      currently paused (because some other in-flight batch just got rate-limited), this
 *      call — and therefore this batch — blocks here until the pause elapses.
 *   2. The request goes to the inner client. On a 429, `gate.onRateLimit(retryAfterMs)`
 *      opens (or extends) the shared pause for every *other* batch, and the normalized
 *      error is rethrown unchanged.
 *   3. `runWithRetries` (rl-2) catches that rethrown error and does its own
 *      Retry-After sleep — but only for *this* batch, the one that actually hit the limit.
 *      It is not blocked by the gate a second time, because the gate only blocks calls to
 *      `analyze()`, and this batch isn't calling `analyze()` again until its own sleep in
 *      retry.ts finishes.
 *   4. By the time the retrying batch calls `analyze()` again, the gate's pause (opened in
 *      step 2, roughly the same Retry-After) has typically just elapsed too, so `wait()`
 *      resolves immediately and the retry proceeds. Meanwhile every *other* batch that
 *      called `wait()` during the pause was held back the whole time — the gate's actual
 *      job, since retry.ts only protects the batch that failed, not its siblings.
 *
 * On success, `gate.onSuccess()` resets the consecutive-429 counter and grows the success
 * streak, which `pipeline-db.ts` uses to decide when to ramp concurrency back up.
 */
import type {
  ILLMClient,
  LLMAnalysisRequest,
  LLMAnalysisResponse,
} from '../interfaces/llm-client.interface.js';
import { normalizeLLMError } from './llm-errors.js';
import type { RateLimitGate } from '../utils/rate-limit-gate.js';

export interface ThrottledLLMClientOptions {
  /** Aborts a pending `gate.wait()` (e.g. on Ctrl-C) so shutdown is immediate. */
  signal?: AbortSignal;
}

export class ThrottledLLMClient implements ILLMClient {
  constructor(
    private readonly inner: ILLMClient,
    private readonly gate: RateLimitGate,
    private readonly opts: ThrottledLLMClientOptions = {}
  ) {}

  async analyze(request: LLMAnalysisRequest): Promise<LLMAnalysisResponse> {
    await this.gate.wait(this.opts.signal);

    try {
      const result = await this.inner.analyze(request);
      this.gate.onSuccess();
      return result;
    } catch (err) {
      const normalized = normalizeLLMError(err, { model: request.model });
      if (normalized.isRateLimit) {
        this.gate.onRateLimit(normalized.retryAfterMs);
      }
      throw normalized;
    }
  }

  getDefaultModel(): string {
    return this.inner.getDefaultModel();
  }

  getFallbackModel(): string {
    return this.inner.getFallbackModel();
  }

  isConfigured(): boolean {
    return this.inner.isConfigured();
  }
}
