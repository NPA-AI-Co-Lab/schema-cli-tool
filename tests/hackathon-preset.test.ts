import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { normalizeConfig, validateConfig } from '../src/utils/config-normalizer.js';
import type { AppConfig } from '../src/utils/types.js';

/**
 * Guards the real preset file that hackathon teams will point the CLI at. It must load,
 * normalize and pass validateConfig on a fresh clone (all referenced paths exist in git,
 * including output/.gitkeep), and must keep the choices that make it safe on a new /
 * low-tier OpenAI account.
 */
describe('config/hackathon.config.json', () => {
  const presetPath = path.resolve(process.cwd(), 'config/hackathon.config.json');

  it('normalizes and validates on a fresh clone', () => {
    const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8')) as AppConfig & {
      _comment?: string;
    };
    expect(preset._comment).toBeTruthy();

    const normalized = normalizeConfig(preset);
    expect(() => validateConfig(normalized)).not.toThrow();
  });

  it('keeps the low-tier-account choices', () => {
    const normalized = normalizeConfig(JSON.parse(fs.readFileSync(presetPath, 'utf8')));

    expect(normalized.concurrencySize).toBe(2);
    expect(normalized.rateLimitMaxRetries).toBe(8);
    expect(normalized.rateLimitMaxWaitMs).toBe(120000);
    expect(normalized.adaptiveConcurrency).toBe(true);
    expect(normalized.failFast).toBe(false);
    expect(normalized.sdkMaxRetries).toBe(0);
    expect(normalized.defaultModel).toBe('gpt-4.1-mini');
    // No escalation to a bigger (lower-TPM) model on validation retries
    expect(normalized.fallbackModel).toBe(normalized.defaultModel);
  });
});
