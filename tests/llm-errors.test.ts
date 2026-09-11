import { describe, it, expect, vi } from 'vitest';
import {
  LLMRequestError,
  normalizeLLMError,
  parseRetryAfterMs,
} from '../src/clients/llm-errors.js';

vi.mock('openai/helpers/zod', () => ({
  zodTextFormat: vi.fn(() => ({ type: 'json_schema' })),
}));

describe('llm-errors', () => {
  describe('parseRetryAfterMs', () => {
    it('reads retry-after-ms from a fetch Headers instance', () => {
      const headers = new Headers({ 'retry-after-ms': '1200' });
      expect(parseRetryAfterMs(headers)).toBe(1200);
    });

    it('reads Retry-After (seconds) from a plain object, case-insensitively', () => {
      expect(parseRetryAfterMs({ 'Retry-After': '30' })).toBe(30_000);
    });

    it('reads an HTTP-date Retry-After roughly N seconds in the future', () => {
      const future = new Date(Date.now() + 5000).toUTCString();
      const ms = parseRetryAfterMs({ 'retry-after': future });
      expect(ms).toBeGreaterThanOrEqual(3500);
      expect(ms).toBeLessThanOrEqual(6500);
    });

    it('falls back to parsing the message when there are no headers', () => {
      const ms = parseRetryAfterMs(undefined, 'Rate limit reached ... Please try again in 1.2s.');
      expect(ms).toBe(1200);
    });

    it('returns undefined when nothing can be parsed', () => {
      expect(parseRetryAfterMs(undefined, 'Something went wrong')).toBeUndefined();
    });
  });

  describe('normalizeLLMError', () => {
    it('marks a 500 as retryable but not a rate limit', () => {
      const normalized = normalizeLLMError({ status: 500, message: 'Internal server error' });
      expect(normalized.isRetryable).toBe(true);
      expect(normalized.isRateLimit).toBe(false);
    });

    it('marks a 400 as neither retryable nor a rate limit', () => {
      const normalized = normalizeLLMError({ status: 400, message: 'Bad request' });
      expect(normalized.isRetryable).toBe(false);
      expect(normalized.isRateLimit).toBe(false);
    });

    it('returns an already-normalized LLMRequestError unchanged', () => {
      const original = new LLMRequestError('already normalized', { status: 429 });
      expect(normalizeLLMError(original)).toBe(original);
    });

    it('derives isRateLimit/retryAfterMs for a 429 with headers', () => {
      const headers = new Headers({ 'retry-after-ms': '1200' });
      const normalized = normalizeLLMError({ status: 429, headers, message: 'Rate limited' });
      expect(normalized.isRateLimit).toBe(true);
      expect(normalized.isRetryable).toBe(true);
      expect(normalized.retryAfterMs).toBe(1200);
      expect(normalized.status).toBe(429);
    });
  });
});
