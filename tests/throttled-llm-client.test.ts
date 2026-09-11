import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ThrottledLLMClient } from '../src/clients/throttled-llm-client.js';
import { RateLimitGate } from '../src/utils/rate-limit-gate.js';
import type {
  ILLMClient,
  LLMAnalysisRequest,
  LLMAnalysisResponse,
} from '../src/interfaces/llm-client.interface.js';

vi.mock('openai/helpers/zod', () => ({
  zodTextFormat: vi.fn(() => ({ type: 'json_schema' })),
}));

function makeRequest(): LLMAnalysisRequest {
  return {
    instructions: 'do the thing',
    input: [{ role: 'user', content: '{}' }],
    model: 'gpt-4.1',
    zodSchema: {} as LLMAnalysisRequest['zodSchema'],
  };
}

function successResponse(): LLMAnalysisResponse {
  return { result: { ok: true }, rawText: '{"ok":true}', model: 'gpt-4.1' };
}

function rateLimitError(retryAfterSeconds: number) {
  return Object.assign(new Error('Rate limited'), {
    status: 429,
    headers: { 'retry-after': String(retryAfterSeconds) },
  });
}

function makeInner(): ILLMClient {
  return {
    analyze: vi.fn(),
    getDefaultModel: () => 'gpt-4.1',
    getFallbackModel: () => 'gpt-4.1-fallback',
    isConfigured: () => true,
  };
}

describe('ThrottledLLMClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delegates getDefaultModel/getFallbackModel/isConfigured to the inner client', () => {
    const inner = makeInner();
    const gate = new RateLimitGate();
    const client = new ThrottledLLMClient(inner, gate);

    expect(client.getDefaultModel()).toBe('gpt-4.1');
    expect(client.getFallbackModel()).toBe('gpt-4.1-fallback');
    expect(client.isConfigured()).toBe(true);
  });

  it('passes a successful call through and reports it to the gate via onSuccess', async () => {
    const inner = makeInner();
    (inner.analyze as ReturnType<typeof vi.fn>).mockResolvedValue(successResponse());
    const gate = new RateLimitGate();
    const client = new ThrottledLLMClient(inner, gate);

    const result = await client.analyze(makeRequest());

    expect(result).toEqual(successResponse());
    expect(gate.successStreak).toBe(1);
    expect(gate.consecutive429).toBe(0);
  });

  it('on a 429, pauses the gate and rethrows a normalized rate-limit error', async () => {
    const inner = makeInner();
    (inner.analyze as ReturnType<typeof vi.fn>).mockRejectedValueOnce(rateLimitError(10));
    const gate = new RateLimitGate();
    const client = new ThrottledLLMClient(inner, gate);

    await expect(client.analyze(makeRequest())).rejects.toMatchObject({
      name: 'LLMRequestError',
      isRateLimit: true,
      retryAfterMs: 10_000,
    });

    expect(gate.isPaused).toBe(true);
    expect(gate.pausedForMs).toBe(10_000);
    expect(gate.consecutive429).toBe(1);
  });

  it('holds other concurrent callers back after one call hits a 429, then meters them out one per Retry-After', async () => {
    const inner = makeInner();
    const analyzeMock = inner.analyze as ReturnType<typeof vi.fn>;
    analyzeMock.mockRejectedValueOnce(rateLimitError(10));

    const gate = new RateLimitGate();
    const client = new ThrottledLLMClient(inner, gate);

    // Batch A hits the rate limit and opens a 10s pause for everyone else.
    await expect(client.analyze(makeRequest())).rejects.toMatchObject({ isRateLimit: true });
    expect(analyzeMock).toHaveBeenCalledTimes(1);
    expect(gate.isPaused).toBe(true);

    // Two more callers start concurrently while the gate is paused.
    analyzeMock.mockResolvedValue(successResponse());
    let resolvedCount = 0;
    const b = client.analyze(makeRequest()).then((r) => {
      resolvedCount += 1;
      return r;
    });
    const c = client.analyze(makeRequest()).then((r) => {
      resolvedCount += 1;
      return r;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(analyzeMock).toHaveBeenCalledTimes(1); // still just A — B and C are held
    expect(resolvedCount).toBe(0);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(analyzeMock).toHaveBeenCalledTimes(1);
    expect(resolvedCount).toBe(0);

    // +10s: the pause ends and exactly ONE held caller is released; the other waits a
    // further Retry-After so it does not collide with the single refilled slot.
    await vi.advanceTimersByTimeAsync(1);
    expect(analyzeMock).toHaveBeenCalledTimes(2);
    expect(resolvedCount).toBe(1);
    expect(gate.isPaused).toBe(false);
    expect(gate.isMetering).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([b, c]);

    expect(analyzeMock).toHaveBeenCalledTimes(3);
    expect(resolvedCount).toBe(2);
    expect(gate.isMetering).toBe(false);
    expect(gate.successStreak).toBe(2);
  });

  it('rejects immediately, without calling the inner client, when the signal is already aborted', async () => {
    const inner = makeInner();
    const gate = new RateLimitGate();
    gate.onRateLimit(10_000);

    const controller = new AbortController();
    controller.abort();
    const client = new ThrottledLLMClient(inner, gate, { signal: controller.signal });

    await expect(client.analyze(makeRequest())).rejects.toThrow();
    expect(inner.analyze).not.toHaveBeenCalled();
  });

  it('rejects a pending call as soon as the signal aborts mid-pause', async () => {
    const inner = makeInner();
    const gate = new RateLimitGate();
    gate.onRateLimit(10_000);

    const controller = new AbortController();
    const client = new ThrottledLLMClient(inner, gate, { signal: controller.signal });

    const pending = client.analyze(makeRequest());
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(inner.analyze).not.toHaveBeenCalled();
  });
});
