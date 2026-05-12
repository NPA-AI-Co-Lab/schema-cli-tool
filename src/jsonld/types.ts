/**
 * JSON-LD property definition
 */
export type JsonLdProperty = {
  type: string | string[];
  description?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  enumFromTaxonomy?: string;
  required?: boolean;
  items?: JsonLdProperty;
  properties?: Record<string, JsonLdProperty>;
};

/**
 * JSON-LD entity definition
 */
export type JsonLdEntity = {
  '@type': string;
  idProp?: string;
  properties: Record<string, JsonLdProperty>;
};

/**
 * Complete JSON-LD schema
 */
export type JsonLdSchema = {
  '@context': Record<string, string>;
  entities: Record<string, JsonLdEntity>;
};

/**
 * Wrapped required field for validation
 */
export type WrappedRequiredField = {
  value: unknown;
  present: boolean;
};

/**
 * JSON-LD file writer interface
 */
export interface JsonLDWriter {
  write: (results: Record<string, unknown>[]) => Promise<void>;
  finalize?: () => Promise<void>;
}

/** Details about a validation error encountered during processing.
 * This structure captures all relevant information for logging and debugging.
 */
export interface ValidationErrorDetails {
  /** Index of the batch containing the error */
  batchIndex: number;
  /** Starting line number in the CSV file for this batch */
  csvLineStart: number;
  /** Ending line number in the CSV file for this batch */
  csvLineEnd: number;
  /** Dot-separated path to the field that caused the error */
  fieldPath: string;
  /** Descriptive error message */
  errorMessage: string;
  /** Expected data type or constraint description, if applicable */
  expectedType?: string;
  /** The actual value that failed validation */
  actualValue: unknown;
  /** Specific CSV row index related to the error, if applicable */
  csvRowIndex?: number;
  /** Original source file path for the row, if available */
  filePath?: string;
  /** 1-based CSV line number within the original source file, if available */
  fileCsvLine?: number;
  /** Stable UUID assigned to the source row, if available */
  uuid?: string;
  /** Retry attempt number for this validation, if applicable (1-based) */
  attemptNumber?: number;
}

export type TaxonomyEntry = {
  notation: string;
  value: string;
};
