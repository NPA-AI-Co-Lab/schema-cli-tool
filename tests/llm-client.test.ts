import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAILLMClient } from '../src/clients/openai-llm-client.js';
import { LLMClientFactory } from '../src/clients/llm-client-factory.js';
import { LLMRequestError } from '../src/clients/llm-errors.js';
import type { LLMAnalysisRequest } from '../src/interfaces/llm-client.interface.js';
import { z } from 'zod';

// Mock OpenAI module
vi.mock('openai', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      responses: {
        create: vi.fn(),
      },
    })),
  };
});

vi.mock('openai/helpers/zod', () => ({
  zodTextFormat: vi.fn(() => ({ type: 'json_schema' })),
}));

describe('LLM Client', () => {
  describe('OpenAILLMClient', () => {
    let client: OpenAILLMClient;
    let mockOpenAI: any;

    beforeEach(async () => {
      const OpenAI = await import('openai');
      mockOpenAI = {
        responses: {
          create: vi.fn(),
        },
      };
      vi.mocked(OpenAI.default).mockReturnValue(mockOpenAI);

      client = new OpenAILLMClient('test-api-key', 'gpt-4', 'gpt-3.5-turbo');
    });

    it('should throw error when API key is missing', () => {
      expect(() => new OpenAILLMClient('')).toThrow('OpenAI API key is required');
    });

    it('should return correct default and fallback models', () => {
      expect(client.getDefaultModel()).toBe('gpt-4');
      expect(client.getFallbackModel()).toBe('gpt-3.5-turbo');
    });

    it('should pass maxRetries to OpenAI constructor', async () => {
      const OpenAI = await import('openai');
      const mockOpenAIConstructor = vi.mocked(OpenAI.default);

      // Create client with custom maxRetries
      const clientWithRetries = new OpenAILLMClient('test-api-key', 'gpt-4', 'gpt-3.5-turbo', {
        maxRetries: 4,
      });

      // Verify constructor was called with maxRetries
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 4,
        })
      );
    });

    it('should use default maxRetries of 0 when not specified', async () => {
      const OpenAI = await import('openai');
      const mockOpenAIConstructor = vi.mocked(OpenAI.default);

      // Clear previous calls
      mockOpenAIConstructor.mockClear();

      // Create client without maxRetries
      const clientDefault = new OpenAILLMClient('test-api-key', 'gpt-4', 'gpt-3.5-turbo');

      // Verify constructor was called with default maxRetries of 0
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 0,
        })
      );
    });

    it('should pass timeoutMs to OpenAI constructor', async () => {
      const OpenAI = await import('openai');
      const mockOpenAIConstructor = vi.mocked(OpenAI.default);

      // Clear previous calls
      mockOpenAIConstructor.mockClear();

      // Create client with custom timeout
      const clientWithTimeout = new OpenAILLMClient('test-api-key', 'gpt-4', 'gpt-3.5-turbo', {
        timeoutMs: 200_000,
      });

      // Verify constructor was called with timeout
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 200_000,
        })
      );
    });

    it('should use default timeout of 150000ms when not specified', async () => {
      const OpenAI = await import('openai');
      const mockOpenAIConstructor = vi.mocked(OpenAI.default);

      // Clear previous calls
      mockOpenAIConstructor.mockClear();

      // Create client without timeout option
      const clientDefaultTimeout = new OpenAILLMClient('test-api-key', 'gpt-4', 'gpt-3.5-turbo');

      // Verify constructor was called with default timeout
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: 150_000,
        })
      );
    });

    it('should successfully analyze data with valid response', async () => {
      const mockResponse = {
        output_text: JSON.stringify({ entities: [{ name: 'John Doe' }] }),
        error: null,
      };
      mockOpenAI.responses.create.mockResolvedValue(mockResponse);

      const request: LLMAnalysisRequest = {
        model: 'gpt-4',
        instructions: 'Extract entities',
        input: [{ role: 'user', content: 'Test data' }],
        zodSchema: z.object({ entities: z.array(z.object({ name: z.string() })) }),
      };

      const result = await client.analyze(request);

      expect(result.result).toEqual({ entities: [{ name: 'John Doe' }] });
      expect(result.rawText).toBe(mockResponse.output_text);
      expect(result.model).toBe('gpt-4');
      expect(mockOpenAI.responses.create).toHaveBeenCalledWith({
        model: 'gpt-4',
        instructions: 'Extract entities',
        input: [{ role: 'user', content: 'Test data' }],
        temperature: 0,
        text: { format: { type: 'json_schema' } },
      });
    });

    it('should handle OpenAI API errors', async () => {
      const mockResponse = {
        error: {
          message: 'Rate limit exceeded',
          code: 'rate_limit_exceeded',
        },
      };
      mockOpenAI.responses.create.mockResolvedValue(mockResponse);

      const request: LLMAnalysisRequest = {
        model: 'gpt-4',
        instructions: 'Extract entities',
        input: [{ role: 'user', content: 'Test data' }],
        zodSchema: z.object({}),
      };

      try {
        await client.analyze(request);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(LLMRequestError);
        const llmError = error as LLMRequestError;
        expect(llmError.message).toBe('OpenAI API error: Rate limit exceeded');
        expect(llmError.code).toBe('rate_limit_exceeded');
        expect(llmError.isRateLimit).toBe(true);
        expect(llmError.isRetryable).toBe(true);
      }
    });

    it('should handle network errors', async () => {
      mockOpenAI.responses.create.mockRejectedValue(new Error('Network error'));

      const request: LLMAnalysisRequest = {
        model: 'gpt-4',
        instructions: 'Extract entities',
        input: [{ role: 'user', content: 'Test data' }],
        zodSchema: z.object({}),
      };

      await expect(client.analyze(request)).rejects.toThrow('Network error');

      try {
        await client.analyze(request);
      } catch (error) {
        expect(error).toBeInstanceOf(LLMRequestError);
        const llmError = error as LLMRequestError;
        expect(llmError.isRetryable).toBe(false);
      }
    });

    it('should preserve status/headers on a raw 429 rejection (regression for rl-1)', async () => {
      mockOpenAI.responses.create.mockRejectedValue({
        status: 429,
        headers: new Headers({ 'retry-after-ms': '1200' }),
        message: 'Rate limit reached',
      });

      const request: LLMAnalysisRequest = {
        model: 'gpt-4',
        instructions: 'Extract entities',
        input: [{ role: 'user', content: 'Test data' }],
        zodSchema: z.object({}),
      };

      try {
        await client.analyze(request);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).toBeInstanceOf(LLMRequestError);
        const llmError = error as LLMRequestError;
        expect(llmError.status).toBe(429);
        expect(llmError.isRateLimit).toBe(true);
        expect(llmError.isRetryable).toBe(true);
        expect(llmError.retryAfterMs).toBe(1200);
      }
    });

    it('should handle invalid JSON response', async () => {
      const mockResponse = {
        output_text: 'invalid json {',
        error: null,
      };
      mockOpenAI.responses.create.mockResolvedValue(mockResponse);

      const request: LLMAnalysisRequest = {
        model: 'gpt-4',
        instructions: 'Extract entities',
        input: [{ role: 'user', content: 'Test data' }],
        zodSchema: z.object({}),
      };

      await expect(client.analyze(request)).rejects.toThrow();
    });
  });

  describe('LLMClientFactory', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      delete process.env.OPENAI_API_KEY;
      delete process.env.LLM_PROVIDER;
    });

    it('should create OpenAI client from environment variables', () => {
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.LLM_PROVIDER = 'openai';

      const client = LLMClientFactory.createFromEnv();

      expect(client).toBeInstanceOf(OpenAILLMClient);
    });

    it('should default to OpenAI when no provider specified', () => {
      process.env.OPENAI_API_KEY = 'test-key';

      const client = LLMClientFactory.createFromEnv();

      expect(client).toBeInstanceOf(OpenAILLMClient);
    });

    it('should throw error when API key is missing', () => {
      delete process.env.OPENAI_API_KEY;

      expect(() => LLMClientFactory.createFromEnv()).toThrow();
    });

    it('should accept maxRetries override in createFromEnv', () => {
      process.env.OPENAI_API_KEY = 'test-key';

      const client = LLMClientFactory.createFromEnv({ maxRetries: 4 });

      expect(client).toBeInstanceOf(OpenAILLMClient);
    });

    it('should read OPENAI_MAX_RETRIES from environment', () => {
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.OPENAI_MAX_RETRIES = '2';

      const client = LLMClientFactory.createFromEnv();

      expect(client).toBeInstanceOf(OpenAILLMClient);
    });

    it('should prefer override maxRetries over environment variable', () => {
      process.env.OPENAI_API_KEY = 'test-key';
      process.env.OPENAI_MAX_RETRIES = '2';

      const client = LLMClientFactory.createFromEnv({ maxRetries: 4 });

      expect(client).toBeInstanceOf(OpenAILLMClient);
    });

    it('should support provider swapping', () => {
      process.env.OPENAI_API_KEY = 'test-key';

      // Test OpenAI
      process.env.LLM_PROVIDER = 'openai';
      const openaiClient = LLMClientFactory.createFromEnv();
      expect(openaiClient).toBeInstanceOf(OpenAILLMClient);

      // Factory should be extensible for other providers
      expect(() => {
        process.env.LLM_PROVIDER = 'anthropic';
        LLMClientFactory.createFromEnv();
      }).toThrow('Unsupported LLM provider');
    });

    it('should warn when OPENAI_API_KEY looks like a placeholder', async () => {
      vi.resetModules();
      const { LLMClientFactory: Factory1 } = await import('../src/clients/llm-client-factory.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      process.env.OPENAI_API_KEY = 'placeholder-key';

      Factory1.createFromEnv();

      expect(warnSpy).toHaveBeenCalledWith(
        'OPENAI_API_KEY does not look like a real OpenAI key. The AI path will fail with 401 if this is a placeholder.'
      );

      warnSpy.mockRestore();
    });

    it('should not warn when OPENAI_API_KEY looks like a real OpenAI key', async () => {
      vi.resetModules();
      const { LLMClientFactory: Factory2 } = await import('../src/clients/llm-client-factory.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      process.env.OPENAI_API_KEY = 'sk-' + 'a'.repeat(50);

      Factory2.createFromEnv();

      const placeholderWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('does not look like a real OpenAI key')
      );
      expect(placeholderWarnings).toHaveLength(0);

      warnSpy.mockRestore();
    });

    it('should warn only once per process for placeholder key', async () => {
      vi.resetModules();
      const { LLMClientFactory: Factory3 } = await import('../src/clients/llm-client-factory.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      process.env.OPENAI_API_KEY = 'invalid-key';

      Factory3.createFromEnv();
      Factory3.createFromEnv();

      const placeholderWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes('does not look like a real OpenAI key')
      );
      expect(placeholderWarnings).toHaveLength(1);

      warnSpy.mockRestore();
    });
  });

  describe('LLM Provider Interface Compliance', () => {
    it('should ensure all providers implement the same interface', async () => {
      const client = new OpenAILLMClient('test-key');

      // Verify interface methods exist
      expect(typeof client.analyze).toBe('function');
      expect(typeof client.getDefaultModel).toBe('function');
      expect(typeof client.getFallbackModel).toBe('function');

      // Verify method signatures
      const request: LLMAnalysisRequest = {
        model: 'gpt-4',
        instructions: 'test',
        input: [],
        zodSchema: z.object({}),
      };

      // Should not throw type errors
      expect(client.analyze).toBeDefined();
      expect(client.getDefaultModel()).toBe('gpt-4.1'); // default value
      expect(client.getFallbackModel()).toBe('gpt-4.1'); // default value
    });
  });
});
