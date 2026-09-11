/**
 * Shared fixture builder for tests that drive the real `analyzeDataWithDb` pipeline
 * end-to-end (real CSV ingestion, real rules loading, real schema/zod validation) with
 * only the LLM client faked out.
 *
 * The schema/rules are intentionally minimal (a single `person` entity with one required
 * field and one optional LLM-only field) so tests stay fast and easy to reason about,
 * while still exercising the genuine pipeline code paths.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { AppConfig } from '../../src/utils/types.js';
import type {
  ILLMClient,
  LLMAnalysisRequest,
  LLMAnalysisResponse,
} from '../../src/interfaces/llm-client.interface.js';

export interface FixtureRow {
  userID: string;
  name: string;
}

export interface FixturePaths {
  dir: string;
  csvPath: string;
  schemaPath: string;
  rulesFullPath: string;
  rulesPartialPath: string;
  outputPath: string;
  databasePath: string;
}

const SCHEMA_JSON = {
  '@context': {
    '@vocab': 'https://schema.org/',
    userID: 'identifier',
  },
  entities: {
    person: {
      '@type': 'Person',
      idProp: 'userID',
      properties: {
        userID: { type: 'string', description: 'Global user ID', required: true },
        name: { type: 'string', description: 'Name' },
        score: { type: 'number', description: 'LLM-derived score' },
      },
    },
  },
};

/** Fully deterministic: every field (including `score`) is resolved by rules. */
function rulesFullJson() {
  return {
    schema: 'schema.jsonld',
    llm: { default: false },
    fields: {
      'person.userID': { source: 'userID', transforms: ['trim'] },
      'person.name': { source: 'name', transforms: ['trim'] },
      'person.score': { literal: 3 },
    },
  };
}

/** `person.score` is left for the LLM; everything else is deterministic. */
function rulesPartialJson() {
  return {
    schema: 'schema.jsonld',
    llm: { default: false, fields: ['person.score'] },
    fields: {
      'person.userID': { source: 'userID', transforms: ['trim'] },
      'person.name': { source: 'name', transforms: ['trim'] },
    },
  };
}

function toCsv(rows: FixtureRow[]): string {
  const header = 'userID,name';
  const lines = rows.map((row) => `${row.userID},${row.name}`);
  return [header, ...lines].join('\n') + '\n';
}

export async function createFixture(rows: FixtureRow[]): Promise<FixturePaths> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'npa-pipeline-test-'));

  const csvPath = path.join(dir, 'data.csv');
  const schemaPath = path.join(dir, 'schema.jsonld');
  const rulesFullPath = path.join(dir, 'rules-full.json');
  const rulesPartialPath = path.join(dir, 'rules-partial.json');
  const outputPath = path.join(dir, 'output.jsonld');
  const databasePath = path.join(dir, 'pipeline.db');

  await fs.writeFile(csvPath, toCsv(rows), 'utf-8');
  await fs.writeFile(schemaPath, JSON.stringify(SCHEMA_JSON, null, 2), 'utf-8');
  await fs.writeFile(rulesFullPath, JSON.stringify(rulesFullJson(), null, 2), 'utf-8');
  await fs.writeFile(rulesPartialPath, JSON.stringify(rulesPartialJson(), null, 2), 'utf-8');

  return { dir, csvPath, schemaPath, rulesFullPath, rulesPartialPath, outputPath, databasePath };
}

export async function cleanupFixture(paths: FixturePaths): Promise<void> {
  await fs.rm(paths.dir, { recursive: true, force: true });
}

export function baseConfig(paths: FixturePaths, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dataPaths: [paths.csvPath],
    schemaPath: paths.schemaPath,
    outputPath: paths.outputPath,
    databasePath: paths.databasePath,
    enableLogging: false,
    hidePII: false,
    retriesNumber: 0,
    requiredFieldErrorsFailBatch: false,
    batchSize: 1,
    concurrencySize: 1,
    defaultModel: 'gpt-4.1',
    fallbackModel: 'gpt-4.1',
    uuidColumn: 'userID',
    resumeMode: 'auto',
    ...overrides,
  };
}

/** A fake ILLMClient whose `analyze` behaviour is fully controlled by the test. */
export class FakeLLMClient implements ILLMClient {
  public calls: LLMAnalysisRequest[] = [];

  constructor(
    private readonly handler: (
      request: LLMAnalysisRequest,
      callIndex: number
    ) => LLMAnalysisResponse | Promise<LLMAnalysisResponse>
  ) {}

  async analyze(request: LLMAnalysisRequest): Promise<LLMAnalysisResponse> {
    const callIndex = this.calls.length;
    this.calls.push(request);
    return this.handler(request, callIndex);
  }

  getDefaultModel(): string {
    return 'gpt-4.1';
  }

  getFallbackModel(): string {
    return 'gpt-4.1';
  }

  isConfigured(): boolean {
    return true;
  }
}

/** Builds a `{ results: [...] }` payload with `person.score` set for each input row. */
export function scoreResponse(batchLength: number, score: number | null = 7): LLMAnalysisResponse {
  return {
    result: {
      results: Array.from({ length: batchLength }, () => ({ person: { score } })),
    },
    rawText: '',
    model: 'gpt-4.1',
  };
}

export function nonRetryableError(message: string): Error {
  return Object.assign(new Error(message), { status: 400, isRetryable: false });
}
