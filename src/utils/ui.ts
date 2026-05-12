import { Ora } from 'ora';
import { countRows } from './data-loader.js';

let activeSpinner: Ora | null = null;
let stderrWriteQueue: Promise<void> = Promise.resolve();

export function setActiveSpinner(spinner: Ora | null) {
  activeSpinner = spinner;
}

export function writeStderrLine(message: string, spinner?: Ora) {
  const targetSpinner = spinner ?? activeSpinner;

  stderrWriteQueue = stderrWriteQueue
    .then(
      () =>
        new Promise<void>((resolve) => {
          const wasSpinning = Boolean(targetSpinner?.isSpinning);
          if (wasSpinning) {
            targetSpinner?.stop();
          }

          process.stderr.write(`${message}\n`, () => {
            if (wasSpinning) {
              targetSpinner?.start();
            }
            resolve();
          });
        })
    )
    .catch(() => {
      // Ignore queue failures so subsequent warnings can still be written.
    });
}

/**
 * Display warning message with spinner
 */
export function warn(msg: string, spinner: Ora) {
  writeStderrLine(`WARNING: ${msg}`, spinner);
}

/**
 * Make text bold for terminal output
 */
export function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

/**
 * Calculate processing speed
 */
function calculateSpeed(startTime: number, processedRows: number): string {
  const elapsedSeconds = (Date.now() - startTime) / 1000;
  const speed = (processedRows / elapsedSeconds).toFixed(2);
  return `${speed} rows/second`;
}

/**
 * Generate spinner text with progress information
 */
function parseSpinnerText(processedRows: number, totalRows: number, startTime: number): string {
  if (processedRows > 0) {
    const percentage = ((processedRows / totalRows) * 100).toFixed(2);
    const speed = calculateSpeed(startTime, processedRows);
    return `Processed ${processedRows} of ${totalRows} rows (${percentage}%) - Speed: ${speed}`;
  }
  return `Starting analysis...`;
}

/**
 * Start a spinner with progress tracking
 */
export async function startSpinnerProgress(
  spinner: Ora,
  getProgress: () => number,
  filePath: string,
  intervalMs: number = 1000
): Promise<() => void> {
  const startTime = Date.now();
  const totalRows = await countRows(filePath);

  const handle = setInterval(() => {
    const processedRows = getProgress();
    spinner.text = parseSpinnerText(processedRows, totalRows, startTime);
  }, intervalMs);

  return () => clearInterval(handle);
}
