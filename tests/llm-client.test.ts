import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAILLMClient } from '../src/clients/openai-llm-client.js';
import { LLMClientFactory } from '../src/clients/llm-client-factory.js';
import type { LLMAnalysisRequest, LLMError } from '../src/interfaces/llm-client.interface.js';
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
        const llmError = error as LLMError;
        expect(llmError.message).toBe('LLM analysis failed: OpenAI API error: Rate limit exceeded');
        expect(llmError.code).toBe('ANALYSIS_FAILED');
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

      await expect(client.analyze(request)).rejects.toThrow('LLM analysis failed: Network error');

      try {
        await client.analyze(request);
      } catch (error) {
        const llmError = error as LLMError;
        expect(llmError.code).toBe('ANALYSIS_FAILED');
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
