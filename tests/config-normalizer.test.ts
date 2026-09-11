import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { normalizeConfig, validateConfig } from '../src/utils/config-normalizer.js';
import { AppConfig } from '../src/utils/types.js';

// Mock the database module
vi.mock('../src/database/index.js', () => ({
  deriveDatabasePath: vi.fn((outputPath: string) => outputPath.replace(/\.[^.]+$/, '.db')),
}));

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn((filePath: string) => {
      // Allow the base config paths to pass
      if (
        filePath === 'test.csv' ||
        filePath === 'schema.jsonld' ||
        filePath === 'output.jsonld' ||
        filePath === '.'
      ) {
        return true;
      }
      return false;
    }),
  },
  existsSync: vi.fn((filePath: string) => {
    // Allow the base config paths to pass
    if (
      filePath === 'test.csv' ||
      filePath === 'schema.jsonld' ||
      filePath === 'output.jsonld' ||
      filePath === '.'
    ) {
      return true;
    }
    return false;
  }),
}));

describe('Config Normalizer - Rate Limit Handling', () => {
  const baseConfig: AppConfig = {
    dataPaths: ['test.csv'],
    schemaPath: 'schema.jsonld',
    outputPath: 'output.jsonld',
    enableLogging: false,
    hidePII: false,
    retriesNumber: 2,
    requiredFieldErrorsFailBatch: false,
    batchSize: 5,
    concurrencySize: 5,
    defaultModel: 'gpt-4',
    fallbackModel: 'gpt-3.5-turbo',
  };

  describe('normalizeConfig - defaults applied', () => {
    it('should apply default rateLimitMaxRetries (6)', () => {
      const config = { ...baseConfig };
      const normalized = normalizeConfig(config);
      expect(normalized.rateLimitMaxRetries).toBe(6);
    });

    it('should apply default rateLimitMaxWaitMs (90000)', () => {
      const config = { ...baseConfig };
      const normalized = normalizeConfig(config);
      expect(normalized.rateLimitMaxWaitMs).toBe(90000);
    });

    it('should apply default sdkMaxRetries (0)', () => {
      const config = { ...baseConfig };
      const normalized = normalizeConfig(config);
      expect(normalized.sdkMaxRetries).toBe(0);
    });

    it('should apply default adaptiveConcurrency (true)', () => {
      const config = { ...baseConfig };
      const normalized = normalizeConfig(config);
      expect(normalized.adaptiveConcurrency).toBe(true);
    });

    it('should apply default failFast (false)', () => {
      const config = { ...baseConfig };
      const normalized = normalizeConfig(config);
      expect(normalized.failFast).toBe(false);
    });

    it('should preserve user-provided values', () => {
      const config: AppConfig = {
        ...baseConfig,
        rateLimitMaxRetries: 10,
        rateLimitMaxWaitMs: 60000,
        sdkMaxRetries: 4,
        adaptiveConcurrency: false,
        failFast: true,
      };
      const normalized = normalizeConfig(config);
      expect(normalized.rateLimitMaxRetries).toBe(10);
      expect(normalized.rateLimitMaxWaitMs).toBe(60000);
      expect(normalized.sdkMaxRetries).toBe(4);
      expect(normalized.adaptiveConcurrency).toBe(false);
      expect(normalized.failFast).toBe(true);
    });
  });

  describe('validateConfig - range validation', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should reject rateLimitMaxRetries < 0', () => {
      const config: AppConfig = {
        ...baseConfig,
        rateLimitMaxRetries: -1,
      };
      expect(() => validateConfig(config)).toThrow('rateLimitMaxRetries must be between 0 and 20');
    });

    it('should reject rateLimitMaxRetries > 20', () => {
      const config: AppConfig = {
        ...baseConfig,
        rateLimitMaxRetries: 21,
      };
      expect(() => validateConfig(config)).toThrow('rateLimitMaxRetries must be between 0 and 20');
    });

    it('should accept rateLimitMaxRetries in valid range', () => {
      const config: AppConfig = {
        ...baseConfig,
        rateLimitMaxRetries: 10,
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should reject rateLimitMaxWaitMs < 1000', () => {
      const config: AppConfig = {
        ...baseConfig,
        rateLimitMaxWaitMs: 999,
      };
      expect(() => validateConfig(config)).toThrow(
        'rateLimitMaxWaitMs must be between 1000 and 600000'
      );
    });

    it('should reject rateLimitMaxWaitMs > 600000', () => {
      const config: AppConfig = {
        ...baseConfig,
        rateLimitMaxWaitMs: 600001,
      };
      expect(() => validateConfig(config)).toThrow(
        'rateLimitMaxWaitMs must be between 1000 and 600000'
      );
    });

    it('should accept rateLimitMaxWaitMs in valid range', () => {
      const config: AppConfig = {
        ...baseConfig,
        rateLimitMaxWaitMs: 60000,
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should reject sdkMaxRetries < 0', () => {
      const config: AppConfig = {
        ...baseConfig,
        sdkMaxRetries: -1,
      };
      expect(() => validateConfig(config)).toThrow('sdkMaxRetries must be between 0 and 5');
    });

    it('should reject sdkMaxRetries > 5', () => {
      const config: AppConfig = {
        ...baseConfig,
        sdkMaxRetries: 6,
      };
      expect(() => validateConfig(config)).toThrow('sdkMaxRetries must be between 0 and 5');
    });

    it('should accept sdkMaxRetries in valid range', () => {
      const config: AppConfig = {
        ...baseConfig,
        sdkMaxRetries: 4,
      };
      expect(() => validateConfig(config)).not.toThrow();
    });

    it('should accept boundary values', () => {
      const config: AppConfig = {
        ...baseConfig,
        rateLimitMaxRetries: 0,
        rateLimitMaxWaitMs: 1000,
        sdkMaxRetries: 5,
      };
      expect(() => validateConfig(config)).not.toThrow();
    });
  });
});
