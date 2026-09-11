import { ILLMClient } from '../interfaces/llm-client.interface.js';
import { OpenAILLMClient } from './openai-llm-client.js';

export interface LLMClientConfig {
  provider: string;
  apiKey: string;
  defaultModel?: string;
  fallbackModel?: string;
  maxRetries?: number;
}

/**
 * Factory for creating LLM client instances
 */
export class LLMClientFactory {
  private static warnedAboutClamp = false;
  private static warnedAboutPlaceholderKey = false;

  static create(config: LLMClientConfig): ILLMClient {
    switch (config.provider) {
      case 'openai': {
        const maxRetries = config.maxRetries ?? 0;
        const clampedMaxRetries = LLMClientFactory.clampMaxRetries(maxRetries);
        return new OpenAILLMClient(config.apiKey, config.defaultModel, config.fallbackModel, {
          maxRetries: clampedMaxRetries,
        });
      }
      default:
        throw new Error(`Unsupported LLM provider: ${config.provider}`);
    }
  }

  static createFromEnv(overrides?: { maxRetries?: number }): ILLMClient {
    const provider = process.env.LLM_PROVIDER || 'openai';
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }

    LLMClientFactory.warnAboutPlaceholderKey(apiKey);

    const envMaxRetries = process.env.OPENAI_MAX_RETRIES
      ? parseInt(process.env.OPENAI_MAX_RETRIES, 10)
      : undefined;
    const maxRetries = overrides?.maxRetries ?? envMaxRetries;

    return LLMClientFactory.create({
      provider,
      apiKey,
      defaultModel: process.env.DEFAULT_MODEL || 'gpt-4.1',
      fallbackModel: process.env.FALLBACK_MODEL || 'gpt-4.1',
      maxRetries,
    });
  }

  private static warnAboutPlaceholderKey(apiKey: string): void {
    if (!this.warnedAboutPlaceholderKey) {
      if (!apiKey.startsWith('sk-') || apiKey.length < 20) {
        console.warn(
          'OPENAI_API_KEY does not look like a real OpenAI key. The AI path will fail with 401 if this is a placeholder.'
        );
        this.warnedAboutPlaceholderKey = true;
      }
    }
  }

  private static clampMaxRetries(maxRetries: number): number {
    if (maxRetries < 0 || maxRetries > 5) {
      if (!this.warnedAboutClamp) {
        console.warn(`OpenAI SDK maxRetries clamped to [0, 5] range from ${maxRetries}`);
        this.warnedAboutClamp = true;
      }
      return Math.max(0, Math.min(5, maxRetries));
    }
    return maxRetries;
  }
}
