import { describe, it, expect } from 'vitest';
import { loadGlobalConfig } from '../src/utils/config.js';

/**
 * The CLI used to read ./config.json at module-load time (retry.ts, logging.ts) and crash on
 * startup — even for `--version` — when run from a directory without one, e.g. a globally
 * installed package run from a dataset folder. Module-level reads are gone; the helper itself
 * must also tolerate a missing file for any remaining callers.
 */
describe('loadGlobalConfig', () => {
  it('returns defaults instead of throwing when the config file does not exist', () => {
    const cfg = loadGlobalConfig('/definitely/not/here/config.json');
    expect(cfg).toEqual({
      BATCH_SIZE: 5,
      CONC_SIZE: 5,
      DEFAULT_MODEL: 'gpt-4.1-mini',
      FALLBACK_MODEL: 'gpt-4.1',
    });
  });
});
