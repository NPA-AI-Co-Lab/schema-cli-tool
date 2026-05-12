/**
 * File ingestion module for multi-file CSV processing
 * Scans files, generates UUIDs, and stores raw rows in database
 */

import { DatabaseManager } from '../database/index.js';
import XXH from 'xxhashjs';
const { h64 } = XXH;
import { loadData } from '../utils/data-loader.js';
import { assignUuidsToBatch } from '../emailUuid.js';
import { calculateFileHash } from '../utils/config-normalizer.js';
import type { InsertRawRow, InsertUuid, DbFile } from '../database/types.js';
import type { UuidGenerationDetails } from '../logging.js';

const DB_INSERT_CHUNK_SIZE = 1000;

export interface FileIngestionResult {
  fileId: number;
  filePath: string;
  rowCount: number;
  uuidCount: number;
  skipped: boolean;
  reason?: string;
  reingested?: boolean; // True if file was deleted and re-ingested due to forceReingestion
}

type IngestPlan =
  | {
      action: 'skip';
      existing: Pick<DbFile, 'file_id' | 'file_path' | 'row_count'>;
      reason: string;
    }
  | { action: 'ingest' }
  | { action: 'reingest' }; // File will be deleted and re-ingested

export class FileIngestionManager {
  constructor(
    private db: DatabaseManager,
    private batchSize: number,
    private uuidColumn?: string,
    private logUuidGeneration?: (details: UuidGenerationDetails) => Promise<void>,
    private forceReingestion: boolean = false
  ) {}

  /**
   * Ingest a single CSV file into the database
   */
  async ingestFile(filePath: string, quiet: boolean = false): Promise<FileIngestionResult> {
    let createdFileId: number | null = null;
    let wasReingested = false;

    try {
      const fileHash = await calculateFileHash(filePath);
      const plan = this.resolveIngestPlan(filePath, fileHash, quiet);

      if (plan.action === 'skip') {
        if (!quiet) {
          console.log(`File already ingested: ${filePath} (matched by content hash)`);
        }
        return {
          fileId: plan.existing.file_id,
          filePath: plan.existing.file_path,
          rowCount: plan.existing.row_count,
          uuidCount: 0,
          skipped: true,
          reason: plan.reason,
          reingested: false,
        };
      }

      // Track if this is a re-ingestion
      if (plan.action === 'reingest') {
        wasReingested = true;
      }

      if (!quiet) {
        console.log(`Ingesting file: ${filePath}`);
      }

      const fileId = this.db.files.insertFile({
        file_path: filePath,
        file_hash: fileHash,
        row_count: 0,
        status: 'processing',
      });
      createdFileId = fileId;

      const sourceByUuid = new Map<string, string>();
      const nextGlobalIndex = this.db.rows.getNextGlobalRowIndex();
      let csvRowIndex = 0;
      let globalRowIndex = nextGlobalIndex;

      const rawRowsToInsert: InsertRawRow[] = [];
      let digestFallbackCountForFile = 0;
      let duplicateRowCountForFile = 0;

      for await (const batch of loadData(filePath, this.batchSize, true)) {
        const assigned = assignUuidsToBatch(batch, this.uuidColumn, this.logUuidGeneration);
        const batchWithUuids = Array.isArray(assigned) ? assigned : assigned.batch;
        const digestFallbackCount = Array.isArray(assigned) ? 0 : assigned.digestFallbackCount;
        digestFallbackCountForFile += digestFallbackCount;

        for (const record of batchWithUuids) {
          const rawData = { ...record };
          delete rawData.userID;
          const uuid = record.userID as string;

          if (!uuid) {
            console.warn(`Row ${csvRowIndex + 2} in ${filePath} has no UUID, skipping`);
            csvRowIndex++;
            continue;
          }

          const signature = JSON.stringify(rawData);
          // Include UUID in hash key so rows with different identities are not collapsed
          // when input only contains the UUID column.
          const dedupeKey = JSON.stringify({ uuid, rawData });
          const hash = h64(dedupeKey, 0xabcd).toString(16);

          if (!sourceByUuid.has(uuid)) {
            sourceByUuid.set(uuid, this.findSourceValue(record, this.uuidColumn));
          }

          rawRowsToInsert.push({
            file_id: fileId,
            file_row_index: csvRowIndex,
            global_row_index: globalRowIndex,
            uuid,
            raw_data: signature,
            row_hash: hash,
          });

          csvRowIndex++;
          globalRowIndex++;
          if (rawRowsToInsert.length < DB_INSERT_CHUNK_SIZE) {
            continue;
          }
          const { ignored } = this.db.rows.insertRowsBatch(rawRowsToInsert);
          duplicateRowCountForFile += ignored;
          rawRowsToInsert.length = 0;
        }
      }

      if (rawRowsToInsert.length > 0) {
        const { ignored } = this.db.rows.insertRowsBatch(rawRowsToInsert);
        duplicateRowCountForFile += ignored;
      }

      const uuidsToInsert = this.getInsertedUuidCountsForFile(fileId).map(
        ({ uuid, count }): InsertUuid => ({
          uuid,
          source_value: sourceByUuid.get(uuid) ?? '',
          record_count: count,
        })
      );

      const insertedRowCount = this.db.rows.getRowCountByFile(fileId);
      this.finalizeIngest(fileId, insertedRowCount, uuidsToInsert);
      this.db.uuids.syncUuidCounts(uuidsToInsert.map((u) => u.uuid));

      if (!quiet) {
        console.log(
          `Ingested ${insertedRowCount} rows with ${uuidsToInsert.length} unique UUIDs from ${filePath}`
        );
      }

      if (digestFallbackCountForFile > 0) {
        console.warn(
          `${digestFallbackCountForFile} row(s) in file '${filePath}' had UUIDs derived from a row-content digest because no stable UUID source was found.`
        );
      }

      if (duplicateRowCountForFile > 0) {
        console.warn(
          `${duplicateRowCountForFile} duplicate row(s) were skipped during ingestion of '${filePath}'.`
        );
      }

      return {
        fileId,
        filePath,
        rowCount: insertedRowCount,
        uuidCount: uuidsToInsert.length,
        skipped: false,
        reingested: wasReingested,
      };
    } catch (error) {
      const ingestionError = error as Error;

      if (createdFileId !== null) {
        this.db.files.markFileAsFailed(createdFileId, ingestionError.message);
      }

      throw error;
    }
  }

  /**
   * Ingest multiple files
   */
  async ingestFiles(filePaths: string[], quiet: boolean = false): Promise<FileIngestionResult[]> {
    const results: FileIngestionResult[] = [];

    for (const filePath of filePaths) {
      const result = await this.ingestFile(filePath, quiet);
      results.push(result);
    }

    return results;
  }

  /**
   * Find the source value used for UUID generation
   */
  private findSourceValue(record: Record<string, unknown>, uuidColumn?: string): string {
    if (uuidColumn && record[uuidColumn]) {
      return String(record[uuidColumn]);
    }

    const emailFields = ['email', 'primaryEmail', 'primaryemail', 'Email', 'EMAIL'];
    for (const field of emailFields) {
      if (record[field]) {
        return String(record[field]);
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (key !== 'userID' && value) {
        return String(value);
      }
    }

    return 'unknown';
  }

  /**
   * Get ingestion summary
   */
  getIngestionSummary(): {
    totalFiles: number;
    totalRows: number;
    totalUuids: number;
    fileDetails: Array<{ filePath: string; rowCount: number; status: string }>;
  } {
    const files = this.db.files.getAllFiles();
    const totalRows = this.db.rows.getTotalRowCount();
    const uuidSummary = this.db.uuids.getUuidStatusSummary();

    return {
      totalFiles: files.length,
      totalRows,
      totalUuids: uuidSummary.total,
      fileDetails: files.map((f) => ({
        filePath: f.file_path,
        rowCount: f.row_count,
        status: f.status,
      })),
    };
  }

  private resolveIngestPlan(filePath: string, fileHash: string, quiet: boolean): IngestPlan {
    const sameHashFile = this.db.files.getFileByHash(fileHash);
    const prevByPath = this.db.files.getFileByPath(filePath);

    if (sameHashFile && sameHashFile.status === 'completed') {
      return {
        action: 'skip',
        existing: {
          file_id: sameHashFile.file_id,
          file_path: sameHashFile.file_path,
          row_count: sameHashFile.row_count,
        },
        reason: 'Already exists with same content',
      };
    }

    if (sameHashFile && sameHashFile.status !== 'completed') {
      if (!quiet) {
        console.log(
          `Found previous ingest for same content with status='${sameHashFile.status}', removing old record to re-ingest: ${filePath}`
        );
      }
      this.deleteFileOrThrow(sameHashFile.file_id);
    }

    if (prevByPath && prevByPath.file_hash !== fileHash) {
      const msg = `Detected a previous ingest for the same filepath but different content (file_id=${prevByPath.file_id}). File appears edited since the previous run.`;
      if (!this.forceReingestion) {
        const guidance = [
          msg,
          'By default we will not automatically remove partial ingest data to avoid accidental data loss.',
          'Options:',
          '- Rename the file and run ingest again.',
          "- Set 'forceReingestion: true' in your config to delete the previous records and re-ingest.",
          "- Run the CLI with a fresh database (set 'resumeMode' to 'fresh') to start over.",
        ].join('\n');
        throw new Error(msg + '\n\n' + guidance);
      }

      if (!quiet) {
        console.log(
          `forceReingestion enabled: removing previous file record (file_id=${prevByPath.file_id}) and continuing`
        );
      }
      this.deleteFileOrThrow(prevByPath.file_id);
      return { action: 'reingest' };
    }

    return { action: 'ingest' };
  }

  private deleteFileOrThrow(fileId: number): void {
    try {
      this.db.files.deleteFile(fileId);
    } catch (error) {
      const e = error as Error;
      console.error(`Failed to remove previous file record (file_id=${fileId}): ${e.message}`);
      console.error(
        'Suggestion: rename the file and try ingesting again, or remove the previous file record and its rows via the CLI/admin tools before re-running the ingest.'
      );
      throw new Error(`Failed to remove previous file record: ${e.message}`);
    }
  }

  private getInsertedUuidCountsForFile(fileId: number): Array<{ uuid: string; count: number }> {
    return this.db
      .getConnection()
      .getDb()
      .prepare('SELECT uuid, COUNT(*) as count FROM raw_rows WHERE file_id = ? GROUP BY uuid')
      .all(fileId) as Array<{ uuid: string; count: number }>;
  }

  private finalizeIngest(fileId: number, rowCount: number, uuidsToInsert: InsertUuid[]): void {
    this.db.transaction(() => {
      for (const uuidData of uuidsToInsert) {
        this.db.uuids.upsertUuid(uuidData);
      }

      this.db
        .getConnection()
        .getDb()
        .prepare(
          'UPDATE files SET row_count = ?, status = ?, completed_at = ?, error_message = NULL WHERE file_id = ?'
        )
        .run(rowCount, 'completed', new Date().toISOString(), fileId);
    });
  }
}
