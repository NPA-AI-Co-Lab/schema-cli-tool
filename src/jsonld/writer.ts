import { createWriteStream, WriteStream } from 'fs';
import { llmOutputToJsonLd } from './converter.js';
import { JsonLDWriter } from './types.js';

function serializeEntry(entry: Record<string, unknown>): string {
  return JSON.stringify(entry, null, 2);
}

/**
 * Create a JSON-LD file writer that streams results to a file or stdout
 */
export function createJsonLDWriter(
  outputPath: string,
  jsonLdSchemaPath: string,
  provenanceEntry?: Record<string, unknown>
): JsonLDWriter {
  let isFirst = true;
  const stream = outputPath ? createWriteStream(outputPath, { flags: 'w' }) : process.stdout;
  const writeChunk =
    stream === process.stdout
      ? (data: string) => process.stdout.write(data)
      : (data: string) => (stream as WriteStream).write(data);

  writeChunk('[\n');

  if (provenanceEntry) {
    writeChunk(serializeEntry(provenanceEntry));
    isFirst = false;
  }

  return {
    write: async (results: Record<string, unknown>[]) => {
      if (!Array.isArray(results) || results.length === 0) {
        return;
      }

      for (const result of results) {
        const jsonLdResult = llmOutputToJsonLd(jsonLdSchemaPath, result);
        if (!isFirst) {
          writeChunk(',\n');
        }
        const output = serializeEntry(jsonLdResult);
        writeChunk(output);
        isFirst = false;
      }
    },
    finalize: async () => {
      return new Promise<void>((resolve) => {
        if (stream !== process.stdout) {
          writeChunk('\n]\n');
          (stream as WriteStream).end(() => resolve());
        } else {
          writeChunk('\n]\n');
          resolve();
        }
      });
    },
  };
}

/**
 * Create a JSON-LD file writer that appends to existing file (for checkpoint resumption)
 */
export function createAppendingJsonLDWriter(
  outputPath: string,
  jsonLdSchemaPath: string,
  provenanceEntry?: Record<string, unknown>
): JsonLDWriter {
  if (!outputPath) {
    return createJsonLDWriter(outputPath, jsonLdSchemaPath, provenanceEntry);
  }

  const provenanceOutput = provenanceEntry ? serializeEntry(provenanceEntry) : null;
  const provenanceId =
    provenanceEntry && typeof provenanceEntry['@id'] === 'string' ? provenanceEntry['@id'] : null;
  let provenanceEnsured = false;

  async function ensureProvenanceEntry() {
    if (provenanceEnsured || !provenanceOutput || !provenanceId) {
      provenanceEnsured = true;
      return;
    }

    const fs = await import('fs/promises');
    let existingContent = '';

    try {
      existingContent = await fs.readFile(outputPath, 'utf-8');
    } catch (error) {
      const readError = error as NodeJS.ErrnoException;
      if (readError.code !== 'ENOENT') {
        throw error;
      }
    }

    if (existingContent.includes(`"${provenanceId}"`)) {
      provenanceEnsured = true;
      return;
    }

    const trimmedContent = existingContent.trim();
    const isEmptyArray = /^\[\s*\]$/.test(trimmedContent);
    const innerContent =
      trimmedContent.length === 0 || isEmptyArray
        ? ''
        : trimmedContent.replace(/^\[\s*/, '').replace(/\s*\]\s*$/, '');

    const updatedContent = innerContent
      ? '[\n' + provenanceOutput + ',\n' + innerContent + '\n]'
      : '[\n' + provenanceOutput + '\n]';

    await fs.writeFile(outputPath, updatedContent);
    provenanceEnsured = true;
  }

  // For resuming, we don't overwrite the file - we create a no-op writer
  // since completed UUIDs are already handled by the streaming processor
  return {
    write: async (results: Record<string, unknown>[]) => {
      // Do nothing - results are already written for completed UUIDs
      // This writer is only called for newly completed UUIDs during resume
      if (results.length > 0) {
        // If we get here, it means new UUIDs were completed during resume
        // We need to append them to the existing file properly
        const fs = await import('fs/promises');
        await ensureProvenanceEntry();

        try {
          // Read existing file to check if it has content
          const existingContent = await fs.readFile(outputPath, 'utf-8');
          const trimmedContent = existingContent.trim();
          const isEmptyArray = /^\[\s*\]$/.test(trimmedContent);
          const hasExistingContent = trimmedContent.length > 0 && !isEmptyArray;

          // Prepare new entries
          const newEntries = results.map((result) => {
            const jsonLdResult = llmOutputToJsonLd(jsonLdSchemaPath, result);
            return serializeEntry(jsonLdResult);
          });

          if (hasExistingContent) {
            // Remove closing bracket, add comma and new entries, then close
            const contentWithoutClosing = existingContent.replace(/\s*\]\s*$/, '');
            const updatedContent = contentWithoutClosing + ',\n' + newEntries.join(',\n') + '\n]';
            await fs.writeFile(outputPath, updatedContent);
          } else {
            // File is empty or only has [], write as new array
            const newContent = '[\n' + newEntries.join(',\n') + '\n]';
            await fs.writeFile(outputPath, newContent);
          }
        } catch (error) {
          console.error('Failed to append to JSON-LD file:', error);
          throw error;
        }
      }
    },
    finalize: async () => {
      await ensureProvenanceEntry();
    },
  };
}
