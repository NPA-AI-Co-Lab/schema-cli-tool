import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  ILLMClient,
  LLMAnalysisRequest,
  LLMAnalysisResponse,
  LLMError,
} from '../interfaces/llm-client.interface.js';
import { normalizeLLMError } from './llm-errors.js';

/**
 * OpenAI implementation of the LLM client interface
 */
export class OpenAILLMClient implements ILLMClient {
  private client: OpenAI;
  private defaultModel: string;
  private fallbackModel: string;

  constructor(
    apiKey: string,
    defaultModel: string = 'gpt-4.1',
    fallbackModel: string = 'gpt-4.1',
    options?: { maxRetries?: number; timeoutMs?: number }
  ) {
    if (!apiKey) {
      throw new Error('OpenAI API key is required');
    }

    this.client = new OpenAI({
      apiKey,
      timeout: options?.timeoutMs ?? 150_000,
      maxRetries: options?.maxRetries ?? 0,
    });
    this.defaultModel = defaultModel;
    this.fallbackModel = fallbackModel;
  }

  async analyze(request: LLMAnalysisRequest): Promise<LLMAnalysisResponse> {
    try {
      const response = await this.client.responses.create({
        model: request.model,
        instructions: request.instructions,
        input: request.input,
        temperature: request.temperature ?? 0,
        text: {
          format: zodTextFormat(request.zodSchema, 'entities'),
        },
      });

      if (response.error) {
        const error = new Error(`OpenAI API error: ${response.error.message}`) as LLMError;
        error.code = response.error.code || 'OPENAI_ERROR';
        error.type = 'openai_error';
        throw error;
      }

      const result = JSON.parse(response.output_text);

      return {
        result,
        rawText: response.output_text,
        model: request.model,
      };
    } catch (error) {
      throw normalizeLLMError(error, { model: request.model });
    }
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  getFallbackModel(): string {
    return this.fallbackModel;
  }

  isConfigured(): boolean {
    try {
      // Try to access the API key through the client
      return !!this.client.apiKey;
    } catch {
      return false;
    }
  }
}
