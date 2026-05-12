import path from 'path';
import { loadJSON } from '../../utils/index.js';
import { JsonLdSchema } from '../../jsonld/types.js';
import { extractSchemaFields } from './schema-fields.js';
import {
  ConditionConfig,
  FieldRuleConfig,
  LlmFieldOverrides,
  LoadedRules,
  NormalizedFieldRule,
  RulesConfig,
  RulesLLMConfig,
  SchemaFieldMeta,
  TransformStepConfig,
} from './types.js';

type TransformType = TransformStepConfig['type'];

const SUPPORTED_TRANSFORMS = new Set<TransformType>([
  'trim',
  'lowercase',
  'uppercase',
  'split',
  'map',
  'toNumber',
  'secondsToDuration',
  'filterEmpty',
  'unique',
]);

function normalizeTransformStep(step: string | TransformStepConfig): TransformStepConfig {
  if (typeof step === 'string') {
    if (!SUPPORTED_TRANSFORMS.has(step as TransformType)) {
      throw new Error(`Unsupported transform type: ${step}`);
    }
    return { type: step as TransformType } as TransformStepConfig;
  }

  if (!SUPPORTED_TRANSFORMS.has(step.type)) {
    throw new Error(`Unsupported transform type: ${step.type}`);
  }

  return step;
}

function normalizeTransforms(
  transforms?: Array<string | TransformStepConfig>
): TransformStepConfig[] {
  if (!transforms || transforms.length === 0) {
    return [];
  }

  return transforms.map((step) => normalizeTransformStep(step));
}

function normalizeConditions(conditions?: ConditionConfig[]): ConditionConfig[] {
  if (!conditions) {
    return [];
  }

  return conditions.map((condition) => {
    if (!condition.column) {
      throw new Error("Condition missing required 'column' property");
    }
    return condition;
  });
}

function normaliseFieldRule(rule: FieldRuleConfig): NormalizedFieldRule {
  if (!rule.source && rule.literal === undefined && !rule.custom) {
    throw new Error("Field rule must define either 'source', 'literal', or 'custom'");
  }

  return {
    source: rule.source,
    literal: rule.literal,
    transforms: normalizeTransforms(rule.transforms),
    taxonomy: rule.taxonomy,
    fallback: rule.fallback,
    when: normalizeConditions(rule.when),
    custom: rule.custom,
  };
}

function deriveInitialLlmFieldSet(
  llmConfig: RulesLLMConfig | undefined,
  schemaFields: SchemaFieldMeta[]
): Set<string> {
  const defaultBehaviour = llmConfig?.default ?? true;
  const configuredFields = new Set(llmConfig?.fields ?? []);
  const schemaFieldSet = new Set(schemaFields.map((field) => field.path));
  const result = new Set<string>();

  if (defaultBehaviour) {
    for (const field of schemaFieldSet) {
      result.add(field);
    }
    for (const field of configuredFields) {
      if (schemaFieldSet.has(field)) {
        result.delete(field);
      }
    }
  } else {
    for (const field of configuredFields) {
      if (schemaFieldSet.has(field)) {
        result.add(field);
      }
    }
  }

  return result;
}

function applyOverrides(
  llmFields: Set<string>,
  overrides: LlmFieldOverrides | undefined,
  schemaFields: SchemaFieldMeta[]
): void {
  if (!overrides) {
    return;
  }

  const schemaFieldSet = new Set(schemaFields.map((field) => field.path));

  if (overrides.include) {
    for (const field of overrides.include) {
      if (!schemaFieldSet.has(field)) {
        console.warn(`⚠️ Unknown field in --llm-fields override: ${field}`);
        continue;
      }
      llmFields.add(field);
    }
  }

  if (overrides.exclude) {
    for (const field of overrides.exclude) {
      if (!schemaFieldSet.has(field)) {
        console.warn(`⚠️ Unknown field in --no-llm-fields override: ${field}`);
        continue;
      }
      llmFields.delete(field);
    }
  }
}

export interface LoadRulesArgs {
  rulesPath?: string;
  schemaPath: string;
  overrides?: LlmFieldOverrides;
}

export function loadRulesConfig({
  rulesPath,
  schemaPath,
  overrides,
}: LoadRulesArgs): LoadedRules | null {
  if (!rulesPath) {
    return null;
  }

  const resolvedRulesPath = path.resolve(rulesPath);
  const config = loadJSON<RulesConfig>(resolvedRulesPath);

  const resolvedSchemaFromConfig = path.resolve(path.dirname(resolvedRulesPath), config.schema);
  const resolvedSchemaPath = path.resolve(schemaPath);

  if (resolvedSchemaFromConfig !== resolvedSchemaPath) {
    console.warn(
      `⚠️ Rules schema mismatch. Expected ${resolvedSchemaPath} but rules file references ${resolvedSchemaFromConfig}`
    );
  }

  const schema = loadJSON<JsonLdSchema>(resolvedSchemaPath);
  const schemaFields = extractSchemaFields(schema);
  const schemaFieldSet = new Set(schemaFields.map((field) => field.path));

  const fieldRules = new Map<string, NormalizedFieldRule>();
  for (const [fieldPath, ruleConfig] of Object.entries(config.fields || {})) {
    if (!schemaFieldSet.has(fieldPath)) {
      console.warn(`⚠️ Rule defined for unknown schema field '${fieldPath}'. Skipping.`);
      continue;
    }

    try {
      fieldRules.set(fieldPath, normaliseFieldRule(ruleConfig));
    } catch (error) {
      console.error(
        `❌ Failed to load rule for field '${fieldPath}': ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  const requiredFields = new Set(
    schemaFields.filter((field) => field.required).map((field) => field.path)
  );

  const llmFields = deriveInitialLlmFieldSet(config.llm, schemaFields);
  applyOverrides(llmFields, overrides, schemaFields);

  validateRulesCoverage(schemaFields, fieldRules, llmFields, requiredFields);

  return {
    rulesPath: resolvedRulesPath,
    schemaPath: resolvedSchemaPath,
    llmFields,
    fieldRules,
    schemaFields,
    requiredFields,
    schema,
  };
}

export function validateRulesCoverage(
  schemaFields: SchemaFieldMeta[],
  fieldRules: Map<string, NormalizedFieldRule>,
  llmFields: Set<string>,
  requiredFields: Set<string>
): void {
  const uncoveredOptional: string[] = [];
  const uncoveredRequired: string[] = [];
  const requiredCoveredOnlyByLlm: string[] = [];

  for (const field of schemaFields) {
    const hasDeterministicRule = fieldRules.has(field.path);
    const coveredByLlm = llmFields.has(field.path);

    if (hasDeterministicRule) {
      continue;
    }

    if (requiredFields.has(field.path) && coveredByLlm) {
      requiredCoveredOnlyByLlm.push(field.path);
      continue;
    }

    if (!coveredByLlm) {
      if (requiredFields.has(field.path)) {
        uncoveredRequired.push(field.path);
      } else {
        uncoveredOptional.push(field.path);
      }
    }
  }

  if (requiredCoveredOnlyByLlm.length > 0) {
    process.stderr.write(
      `⚠️ Required schema fields are covered only by LLM (no deterministic rule):\n  ${requiredCoveredOnlyByLlm.join('\n  ')}\n`
    );
  }

  if (uncoveredOptional.length > 0) {
    process.stderr.write(
      `⚠️ Optional schema fields are not covered by any deterministic rule or LLM:\n  ${uncoveredOptional.join('\n  ')}\n`
    );
  }

  if (uncoveredRequired.length > 0) {
    throw new Error(
      `❌ Required schema fields have no rule or LLM coverage:\n  ${uncoveredRequired.join('\n  ')}`
    );
  }
}
