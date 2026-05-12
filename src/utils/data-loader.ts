import { createReadStream, readFileSync } from 'fs';
import csv from 'csv-parser';
import path from 'path';

/**
 * Check if a CSV row is empty (all values are empty strings or null)
 */
function isRowEmpty(row: Record<string, string>): boolean {
  return Object.values(row).every((value) => !value || value.trim() === '');
}

/**
 * Load instructions file and replace placeholders
 */
export function loadInstructions(
  instructionsPath: string,
  schema: object,
  inputFileName?: string
): string {
  try {
    let instructions = readFileSync(instructionsPath, 'utf-8');
    instructions = instructions.replace('<<<SCHEMA>>>', JSON.stringify(schema, null, 2));

    if (inputFileName) {
      const filenameWithoutExtension = path.parse(inputFileName).name;
      const filenameContext = `\n\nInput file name: "${filenameWithoutExtension}"\nThis filename may provide context for fields like dataSource - you can infer appropriate values from it.`;
      instructions = instructions.replace(
        'Additional important rules:',
        `Additional important rules:${filenameContext}\n\n`
      );
    }

    return instructions;
  } catch (error) {
    throw new Error(`Failed to load instructions from ${instructionsPath}: ${error}`);
  }
}

/**
 * Load CSV data in batches
 */
export async function* loadData(
  filePath: string,
  batchSize: number,
  checkHeaderDuplicates: boolean = false
): AsyncGenerator<Record<string, string>[]> {
  let batch: Record<string, string>[] = [];
  let headerColumns: string[] = [];
  let rowNumber = 1;
  const stream = createReadStream(filePath).pipe(csv());

  stream.on('headers', (headers: string[]) => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    headerColumns = headers.filter((h) => {
      if (seen.has(h)) {
        duplicates.push(h);
        return false;
      }
      seen.add(h);
      return true;
    });
    if (duplicates.length > 0 && checkHeaderDuplicates) {
      console.warn(
        `️⚠️ WARNING: Duplicate column names detected in CSV header: ${duplicates.join(', ')}. Only the last occurrence of each will be used.`
      );
    }
  });

  for await (const row of stream) {
    if (isRowEmpty(row)) {
      rowNumber++;
      continue;
    }
    // Check for row validity
    if (headerColumns.length > 0 && checkHeaderDuplicates) {
      const rowKeys = Object.keys(row);
      if (rowKeys.length !== headerColumns.length) {
        throw new Error(
          `❌ Error: Row ${rowNumber} has ${rowKeys.length} elements, expected ${headerColumns.length}. Possible malformed row. Execution stopped.`
        );
      }
    }
    batch.push(row);
    if (batch.length === batchSize) {
      yield batch;
      batch = [];
    }
    rowNumber++;
  }
  if (batch.length > 0) {
    yield batch;
  }
}

/**
 * Count non-empty rows in a CSV file
 */
export async function countRows(filePath: string): Promise<number> {
  let rowCount = 0;
  const stream = createReadStream(filePath).pipe(csv());

  for await (const row of stream) {
    if (!isRowEmpty(row)) {
      rowCount++;
    }
  }

  return rowCount;
}

/**
 * Async generator that yields index and batch
 */
export async function* enumerateAsync<T>(
  asyncIterable: AsyncIterable<T>
): AsyncGenerator<{ index: number; batch: T }> {
  let index = 0;
  for await (const batch of asyncIterable) {
    yield { index, batch };
    index++;
  }
}
