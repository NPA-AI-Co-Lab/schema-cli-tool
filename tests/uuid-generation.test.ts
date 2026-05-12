import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { v5 as uuidv5 } from 'uuid';
import {
  assignUuidsToBatch,
  extractEmails,
  extractUuidValues,
  getUuidForPerson,
} from '../src/emailUuid.js';

// Mock file system utilities to prevent basePath issues during testing
vi.mock('../src/utils/file-system.js', () => ({
  basePath: '/mock/base/path',
  loadJSON: vi.fn(),
  pathExists: vi.fn(),
  isDirectoryWritable: vi.fn(),
  resolvePath: vi.fn((path: string) => path),
}));

// Mock config utilities to prevent configuration loading issues during testing
vi.mock('../src/utils/config.js', () => ({
  loadEnvConfig: vi.fn(() => ({})),
  loadAppConfig: vi.fn(() => ({
    batchSize: 100,
    concurrencySize: 5,
    defaultModel: 'test-model',
    fallbackModel: 'fallback-model',
  })),
  loadGlobalConfig: vi.fn(() => ({
    BATCH_SIZE: 100,
    CONC_SIZE: 5,
    DEFAULT_MODEL: 'test-model',
    FALLBACK_MODEL: 'fallback-model',
  })),
  getBatchSize: vi.fn(() => 100),
  getConcurrencySize: vi.fn(() => 5),
  getDefaultModel: vi.fn(() => 'test-model'),
  getFallbackModel: vi.fn(() => 'fallback-model'),
  isOpenAIConfigured: vi.fn(() => false),
  getOpenAIAPIKey: vi.fn(() => ''),
}));

// Mock jsonld module to prevent taxonomy loading issues during testing
vi.mock('../src/jsonld/index.js', () => ({
  getTaxonomy: vi.fn(() => []),
  handleTaxonomyEnum: vi.fn(),
  clearTaxonomyCache: vi.fn(),
  convertProperty: vi.fn(),
  convertEntityToJsonSchema: vi.fn(),
  jsonLdToJsonSchema: vi.fn(),
  getLLMSchema: vi.fn(),
  convertSingleEntityToJsonLd: vi.fn(),
  convertArrayEntitiesToJsonLd: vi.fn(),
  llmOutputToJsonLd: vi.fn(),
  createJsonLDWriter: vi.fn(),
  batchCleanupRequiredFields: vi.fn((results: any) => results),
  validateRequiredFields: vi.fn(),
  validateObjectRecursively: vi.fn(),
  isValidObject: vi.fn(),
  isWrappedRequiredField: vi.fn(),
  shouldSkipField: vi.fn(),
  buildArrayItemPath: vi.fn(),
  buildFieldPath: vi.fn(),
}));

const UUID_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function canonicalizeRowValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeRowValue(item));
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, canonicalizeRowValue(entryValue)]);

    return Object.fromEntries(entries);
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  return value;
}

function expectedDigestUuid(person: Record<string, unknown>): string {
  const digestSource = Object.fromEntries(
    Object.entries(person)
      .filter(([key, value]) => key !== 'userID' && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, canonicalizeRowValue(value)])
  );
  const digest = createHash('sha256').update(JSON.stringify(digestSource)).digest('hex');
  return uuidv5(digest, UUID_NAMESPACE);
}

function expectedUuidFromValue(value: string): string {
  return uuidv5(value, UUID_NAMESPACE);
}

describe('UUID Generation', () => {
  beforeEach(() => {
    // Clear any cached UUIDs between tests
    vi.clearAllMocks();
  });

  describe('extractEmails', () => {
    it('should extract emails from standard email fields', () => {
      const person = {
        email: 'test@example.com',
        primaryEmail: 'primary@example.com',
        name: 'John Doe',
      };

      const emails = extractEmails(person);

      expect(emails).toEqual(['test@example.com', 'primary@example.com']);
    });

    it('should extract multiple emails from additionalEmails field', () => {
      const person = {
        email: 'test@example.com',
        additionalEmails: 'alt1@example.com, alt2@example.com',
        name: 'John Doe',
      };

      const emails = extractEmails(person);

      expect(emails).toEqual(['test@example.com', 'alt1@example.com', 'alt2@example.com']);
    });

    it('should handle empty and invalid email fields', () => {
      const person = {
        email: '',
        primaryEmail: '   ',
        invalidField: 'not-an-email',
        name: 'John Doe',
      };

      const emails = extractEmails(person);

      expect(emails).toEqual([]);
    });

    it('should normalize email case', () => {
      const person = {
        email: 'TEST@EXAMPLE.COM',
        primaryEmail: 'Primary@Example.Com',
      };

      const emails = extractEmails(person);

      expect(emails).toEqual(['test@example.com', 'primary@example.com']);
    });
  });

  describe('extractUuidValues', () => {
    it('should fall back to email extraction when no uuidColumn is specified', () => {
      const person = {
        email: 'test@example.com',
        userID: 'user123',
        name: 'John Doe',
      };

      const values = extractUuidValues(person);

      expect(values).toEqual(['test@example.com']);
    });

    it('should extract value from specified uuid column', () => {
      const person = {
        email: 'test@example.com',
        userID: 'user123',
        name: 'John Doe',
      };

      const values = extractUuidValues(person, 'userID');

      expect(values).toEqual(['user123']);
    });

    it('should handle comma-separated values in uuid column', () => {
      const person = {
        email: 'test@example.com',
        tags: 'tag1, tag2, tag3',
        name: 'John Doe',
      };

      const values = extractUuidValues(person, 'tags');

      expect(values).toEqual(['tag1', 'tag2', 'tag3']);
    });

    it('should normalize values to lowercase', () => {
      const person = {
        category: 'PREMIUM,SUBSCRIBER',
        name: 'John Doe',
      };

      const values = extractUuidValues(person, 'category');

      expect(values).toEqual(['premium', 'subscriber']);
    });

    it('should fall back to email for non-existent column', () => {
      const person = {
        email: 'test@example.com',
        name: 'John Doe',
      };

      const values = extractUuidValues(person, 'nonExistent');

      expect(values).toEqual(['test@example.com']);
    });

    it('should fall back to email for empty uuid column value', () => {
      const person = {
        email: 'test@example.com',
        userID: '',
        name: 'John Doe',
      };

      const values = extractUuidValues(person, 'userID');

      expect(values).toEqual(['test@example.com']);
    });

    it('should return empty array when no uuid column and no email available', () => {
      const person = {
        name: 'John Doe',
        userID: '',
      };

      const values = extractUuidValues(person, 'userID');

      expect(values).toEqual([]);
    });
  });

  describe('getUuidForPerson', () => {
    it('should generate UUID from email when no uuidColumn specified', () => {
      const person = {
        email: 'test@example.com',
        name: 'John Doe',
      };

      const result = getUuidForPerson(person);

      expect(result.uuid).toBe(expectedUuidFromValue('test@example.com'));
      expect(result.usedDigestFallback).toBe(false);
    });

    it('should generate UUID from specified column', () => {
      const person = {
        email: 'test@example.com',
        userID: 'user123',
        name: 'John Doe',
      };

      const result = getUuidForPerson(person, 'userID');

      expect(result.uuid).toBe(expectedUuidFromValue('user123'));
      expect(result.usedDigestFallback).toBe(false);
    });

    it('should generate deterministic UUID from row digest when no values available', () => {
      const person = {
        name: 'John Doe',
      };

      const result = getUuidForPerson(person);

      expect(result.uuid).toBe(expectedDigestUuid(person));
      expect(result.usedDigestFallback).toBe(true);
    });

    it('should use first value when multiple values available', () => {
      const person = {
        tags: 'tag1, tag2, tag3',
        name: 'John Doe',
      };

      const result = getUuidForPerson(person, 'tags');

      expect(result.uuid).toBe(expectedUuidFromValue('tag1'));
      expect(result.usedDigestFallback).toBe(false);
    });
  });

  describe('assignUuidsToBatch', () => {
    it('should assign UUIDs based on email when no uuidColumn specified', () => {
      const batch = [
        { email: 'user1@example.com', name: 'User 1' },
        { email: 'user2@example.com', name: 'User 2' },
      ];

      const { batch: result, digestFallbackCount } = assignUuidsToBatch(batch);

      expect(result[0].userID).toBe(expectedUuidFromValue('user1@example.com'));
      expect(result[1].userID).toBe(expectedUuidFromValue('user2@example.com'));
      expect(digestFallbackCount).toBe(0);
    });

    it('should assign UUIDs based on specified column', () => {
      const batch = [
        { email: 'user1@example.com', userID: 'u001', name: 'User 1' },
        { email: 'user2@example.com', userID: 'u002', name: 'User 2' },
      ];

      const { batch: result, digestFallbackCount } = assignUuidsToBatch(batch, 'userID');

      expect(result[0].userID).toBe(expectedUuidFromValue('u001'));
      expect(result[1].userID).toBe(expectedUuidFromValue('u002'));
      expect(digestFallbackCount).toBe(0);
    });

    it('should reuse UUIDs for identical values', () => {
      const batch = [
        { email: 'same@example.com', name: 'User 1' },
        { email: 'same@example.com', name: 'User 2' },
        { email: 'different@example.com', name: 'User 3' },
      ];

      const { batch: result, digestFallbackCount } = assignUuidsToBatch(batch);

      // First two should have same UUID, third should be different
      expect(result[0].userID).toBe(result[1].userID);
      expect(result[0].userID).not.toBe(result[2].userID);
      expect(result[0].userID).toBe(expectedUuidFromValue('same@example.com'));
      expect(result[2].userID).toBe(expectedUuidFromValue('different@example.com'));
      expect(digestFallbackCount).toBe(0);
    });

    it('should handle mixed scenarios with digest fallback when no values exist', () => {
      const batch = [
        { email: 'user1@example.com', name: 'User 1', userID: '' },
        { name: 'User 2', userID: '', email: '' }, // No email, empty uuid column
        { userID: 'u003', name: 'User 3', email: '' },
      ];

      const { batch: result, digestFallbackCount } = assignUuidsToBatch(batch, 'userID');

      expect(result[0].userID).toBe(expectedUuidFromValue('user1@example.com')); // Has email, uses that
      expect(result[1].userID).toBe(expectedDigestUuid(batch[1])); // Empty userID and email, falls back to row digest
      expect(result[2].userID).toBe(expectedUuidFromValue('u003')); // Has userID
      expect(digestFallbackCount).toBe(1); // One digest-based UUID generated
    });

    it('should handle null/undefined records gracefully', () => {
      const batch = [
        { email: 'user1@example.com', name: 'User 1' },
        null as any,
        undefined as any,
        { email: 'user2@example.com', name: 'User 2' },
      ];

      const { batch: result, digestFallbackCount } = assignUuidsToBatch(batch);

      expect(result[0].userID).toBe(expectedUuidFromValue('user1@example.com'));
      expect(result[1]).toBeNull();
      expect(result[2]).toBeUndefined();
      expect(result[3].userID).toBe(expectedUuidFromValue('user2@example.com'));
      expect(digestFallbackCount).toBe(0);
    });

    it('should preserve existing record properties', () => {
      const batch = [
        {
          email: 'user1@example.com',
          name: 'User 1',
          age: '30',
          active: 'true',
        },
      ];

      const { batch: result, digestFallbackCount } = assignUuidsToBatch(batch);

      expect(result[0]).toEqual({
        email: 'user1@example.com',
        name: 'User 1',
        age: '30',
        active: 'true',
        userID: expectedUuidFromValue('user1@example.com'),
      });
      expect(digestFallbackCount).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle whitespace in values', () => {
      const person = {
        userID: '  user123  ',
        name: 'John Doe',
      };

      const values = extractUuidValues(person, 'userID');
      expect(values).toEqual(['user123']);

      const result = getUuidForPerson(person, 'userID');
      expect(result.uuid).toBe(expectedUuidFromValue('user123'));
      expect(result.usedDigestFallback).toBe(false);
    });

    it('should handle special characters in uuid values', () => {
      const person = {
        userID: 'user@123#special',
        name: 'John Doe',
      };

      const result = getUuidForPerson(person, 'userID');
      expect(result.uuid).toBe(expectedUuidFromValue('user@123#special'));
      expect(result.usedDigestFallback).toBe(false);
    });

    it('should handle mixed case in column names (case insensitive email detection)', () => {
      const person = {
        EMAIL: 'test@example.com',
        Name: 'John Doe',
      };

      const emails = extractEmails(person);
      expect(emails).toEqual(['test@example.com']);
    });
  });
});
