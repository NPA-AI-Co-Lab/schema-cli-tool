import { ZodTypeAny } from 'zod';

/**
 * Input message for LLM requests
 */
export interface LLMPromptInput {
  role: 'user' | 'system' | 'assistant';
  content: string;
}

/**
 * Arguments for LLM analysis requests
 */
export interface LLMAnalysisRequest {
  /** Instructions/prompt text for the LLM */
  instructions: string;

  /** Input messages for the conversation */
  input: LLMPromptInput[];

  /** Model name to use */
  model: string;

  /** Zod schema for response validation */
  zodSchema: ZodTypeAny;

  /** Sampling temperature (0–2). Defaults to 0 when omitted. */
  temperature?: number;
}

/**
 * Response from LLM analysis
 */
export interface LLMAnalysisResponse {
  /** Parsed and validated output */
  result: Record<string, unknown>;

  /** Raw response text */
  rawText: string;

  /** Model used for the request */
  model: string;
}

/**
 * Error from LLM API
 */
export interface LLMError extends Error {
  code?: string;
  type?: string;
  /** HTTP status code from the provider, when available */
  status?: number;
  /** Milliseconds to wait before retrying, derived from a Retry-After hint */
  retryAfterMs?: number;
  /** Whether the error represents a rate-limit response (HTTP 429) */
  isRateLimit?: boolean;
  /** Whether the error is safe to retry without changing the request */
  isRetryable?: boolean;
}

/**
 * Interface for LLM client implementations
 * This abstraction allows swapping between different AI providers
 */
export interface ILLMClient {
  /**
   * Perform analysis using the configured LLM
   */
  analyze(request: LLMAnalysisRequest): Promise<LLMAnalysisResponse>;

  /**
   * Get the default model name
   */
  getDefaultModel(): string;

  /**
   * Get the fallback model name
   */
  getFallbackModel(): string;

  /**
   * Check if the client is properly configured
   */
  isConfigured(): boolean;
}
