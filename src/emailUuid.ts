import { createHash } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { splitValues, checkNotEmpty, checkPropertyExists } from './utils/index.js';
import type { UuidGenerationDetails } from './logging.js';

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

function normalizeFieldName(field: string): string {
  return field.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

const EMAIL_FIELD_NAMES = ['email', 'primaryemail', 'mainemail', 'useremail', 'emailaddress'];
const ADDITIONAL_EMAILS_NAMES = ['additionalemails', 'otheremails', 'emails', 'emailaddresses'];

function isEmailField(key: string): boolean {
  return EMAIL_FIELD_NAMES.includes(normalizeFieldName(key));
}
function isAdditionalEmailsField(key: string): boolean {
  return ADDITIONAL_EMAILS_NAMES.includes(normalizeFieldName(key));
}

const VALUE_TO_UUID: Map<string, string> = new Map();

type Person = {
  userID?: string;
  [key: string]: unknown;
};

type UuidResult = {
  uuid: string;
  usedDigestFallback: boolean;
};

function validateValue(value: string): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateEmail(email: string): boolean {
  return typeof email === 'string' && email.trim().length > 0;
}

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

function getDigestFallbackSource(person: RecordData): string {
  const digestSource = Object.fromEntries(
    Object.entries(person)
      .filter(([key, value]) => key !== 'userID' && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, canonicalizeRowValue(value)])
  );

  return JSON.stringify(digestSource);
}

function getUuidFromRowDigest(person: RecordData): string {
  const digest = createHash('sha256').update(getDigestFallbackSource(person)).digest('hex');
  return uuidv5(digest, NAMESPACE);
}

export function extractEmails(person: RecordData): string[] {
  const emails: string[] = [];
  for (const key of Object.keys(person)) {
    if (isEmailField(key) && validateEmail(person[key])) {
      emails.push(person[key].trim().toLowerCase());
    }
    if (isAdditionalEmailsField(key) && typeof person[key] === 'string') {
      emails.push(...splitValues(person[key]).map((email) => email.trim().toLowerCase()));
    }
  }
  return emails;
}

export function extractUuidValues(
  person: RecordData,
  uuidColumn?: string,
  logUuidGeneration?: (details: UuidGenerationDetails) => Promise<void>
): string[] {
  if (!uuidColumn) {
    return extractEmails(person);
  }

  const values: string[] = [];
  if (person[uuidColumn] && validateValue(person[uuidColumn])) {
    const value = person[uuidColumn].trim().toLowerCase();
    // Handle comma-separated values
    if (value.includes(',')) {
      values.push(...splitValues(value).map((v) => v.trim().toLowerCase()));
    } else {
      values.push(value);
    }
  }

  // If no values found in the specified column, fall back to email
  if (values.length === 0) {
    const columnExists = uuidColumn in person;
    const fallbackEmails = extractEmails(person);

    if (logUuidGeneration) {
      logUuidGeneration({
        eventType: columnExists ? 'column_empty' : 'column_missing',
        uuidColumn,
        inputValues: fallbackEmails,
        generatedUuid: '', // Will be filled later
        fallbackReason: columnExists
          ? `UUID column '${uuidColumn}' is empty or invalid, falling back to email`
          : `UUID column '${uuidColumn}' not found in record, falling back to email`,
      });
    }

    return fallbackEmails;
  }

  return values;
}

export function getUuidForPerson(
  person: RecordData,
  uuidColumn?: string,
  logUuidGeneration?: (details: UuidGenerationDetails) => Promise<void>
): UuidResult {
  const values = extractUuidValues(person, uuidColumn, logUuidGeneration);
  if (values.length > 0) {
    const uuid = uuidv5(values[0], NAMESPACE);
    if (logUuidGeneration) {
      logUuidGeneration({
        eventType: 'generated',
        uuidColumn,
        inputValues: values,
        generatedUuid: uuid,
      });
    }
    return { uuid, usedDigestFallback: false };
  }

  const uuid = getUuidFromRowDigest(person);
  if (logUuidGeneration) {
    logUuidGeneration({
      eventType: 'fallback_to_row_digest',
      uuidColumn,
      inputValues: [],
      generatedUuid: uuid,
      fallbackReason: `No valid UUID values found (no email or ${uuidColumn ? `'${uuidColumn}' column` : 'email columns'}), generating deterministic UUID from row digest`,
    });
  }
  return { uuid, usedDigestFallback: true };
}

export function assignUuidsToBatch(
  batch: RecordData[],
  uuidColumn?: string,
  logUuidGeneration?: (details: UuidGenerationDetails) => Promise<void>
): { batch: RecordData[]; digestFallbackCount: number } {
  let digestFallbackCount = 0;
  const mapped = batch.map((row) => {
    if (!row) return row;
    const values = extractUuidValues(row, uuidColumn, logUuidGeneration);
    let assignedUuid: string | undefined;
    for (const value of values) {
      const uuid = VALUE_TO_UUID.get(value);
      if (uuid) {
        assignedUuid = uuid;
        if (logUuidGeneration) {
          logUuidGeneration({
            eventType: 'cached',
            uuidColumn,
            inputValues: values,
            generatedUuid: uuid,
            cacheSize: VALUE_TO_UUID.size,
          });
        }
        break;
      }
    }
    if (!assignedUuid) {
      const res = getUuidForPerson(row, uuidColumn, logUuidGeneration);
      assignedUuid = res.uuid;
      if (res.usedDigestFallback) digestFallbackCount++;
    }
    for (const value of values) {
      VALUE_TO_UUID.set(value, assignedUuid);
    }
    row.userID = assignedUuid;
    return row;
  });

  return { batch: mapped, digestFallbackCount };
}

function getUuidRecordMap(allResults: AnalysisResult[]): Map<string, Person[]> {
  const uuidMap = new Map<string, Person[]>();
  for (const result of allResults) {
    const person = result.person as Person;
    if (!person || !person.userID) continue;
    const uuid = person.userID;
    if (!uuidMap.has(uuid)) uuidMap.set(uuid, []);
    uuidMap.get(uuid)!.push(result);
  }

  return uuidMap;
}

function arraysAreEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function pushUnique(target: unknown[], item: unknown) {
  const exists = target.some((entry) =>
    typeof entry === 'object' || typeof item === 'object'
      ? arraysAreEqual(entry, item)
      : entry === item
  );
  if (!exists) {
    target.push(item);
  }
}

function mergeArrayValue(existing: unknown[] | undefined, incoming: unknown[]): unknown[] {
  const result: unknown[] = Array.isArray(existing) ? [...existing] : [];

  for (const item of incoming) {
    if (Array.isArray(item)) {
      for (const nested of item) {
        pushUnique(result, nested);
      }
    } else {
      pushUnique(result, item);
    }
  }

  return result;
}

function mergePerson(mergePerson: Person, person: Person) {
  for (const key of Object.keys(person)) {
    const value = person[key];
    if (Array.isArray(value)) {
      mergePerson[key] = mergeArrayValue(
        Array.isArray(mergePerson[key]) ? (mergePerson[key] as unknown[]) : undefined,
        value
      );
    } else if (checkNotEmpty(value)) {
      const noExistingValue =
        !checkPropertyExists(mergePerson, key) || !checkNotEmpty(mergePerson[key]);
      if (noExistingValue) {
        mergePerson[key] = value;
      }
    }
  }
}

function mergeGroup(uuid: string, group: AnalysisResult[]): AnalysisResult {
  const mergedPerson: Person = {} as Person;
  const objects: unknown[] = [];
  const actions: unknown[] = [];
  for (const result of group) {
    const person = result.person as Person;
    if (!person) continue;
    mergePerson(mergedPerson, person);
    if (result.object) objects.push(result.object);
    if (result.action) actions.push(result.action);
  }
  mergedPerson['userID'] = uuid;
  mergedPerson['@id'] = uuid;
  return {
    person: mergedPerson,
    object: objects.length > 0 ? objects : null,
    action: actions.length > 0 ? actions : null,
  };
}

export function mergeRecordsByUuidMap(
  allResults: AnalysisResult[],
  schema: JsonSchema
): AnalysisResult[] {
  const uuidMap = getUuidRecordMap(allResults);
  const mergedOutput: AnalysisResult[] = [];
  for (const [uuid, group] of uuidMap.entries()) {
    if (group.length === 1) {
      mergedOutput.push(group[0]);
      continue;
    }
    const mergedGroup = mergeGroup(uuid, group);
    mergedOutput.push({
      ...mergedGroup,
      '@context': schema['@context'] || {},
    });
  }
  return mergedOutput;
}

export function getUuidCache(): Record<string, string> {
  return Object.fromEntries(VALUE_TO_UUID);
}

export function setUuidCache(cache: Record<string, string>): void {
  VALUE_TO_UUID.clear();
  for (const [value, uuid] of Object.entries(cache)) {
    VALUE_TO_UUID.set(value, uuid);
  }
}
