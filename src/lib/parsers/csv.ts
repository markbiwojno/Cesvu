/**
 * src/lib/parsers/csv.ts — CSV/TSV file parser with streaming infinite scroll
 *
 * Architecture:
 * - Column profiles built incrementally (Welford's algorithm, O(1) memory per column)
 * - ALL rows appended to a flat array as they stream in (capped at MAX_ALL_ROWS)
 * - DocumentPane binds to the reactive `CsvStreamHandle` and gets new rows automatically
 * - Virtual scroll renders only VIRTUAL_PAGE_SIZE rows in the DOM at once
 * - Progress reported via onProgress callback
 */

import type { ParsedFile, CsvData, ColumnProfile } from '$lib/types.js';
import type { Workbook } from '../data/workbook.js';
import { MAX_DISPLAY_ROWS } from '$lib/config.js';


// ============================================================
// Public types
// ============================================================

export interface ParsedCsvFile extends ParsedFile {
	type: 'csv';
	parsedData: CsvData;
	columnProfiles: ColumnProfile[];
	totalRowCount: number;
	/** True while the parser is still streaming rows */
	isStreaming: boolean;
	/** Whether rows were capped (totalRowCount > MAX_ALL_ROWS) */
	isSampled: boolean;
	/** Handle to get live row updates */
	streamHandle: CsvStreamHandle;
}

/**
 * Reactive handle — DocumentPane subscribes to this.
 * `rows` grows as the parser streams. `done` flips to true when complete.
 */
export interface CsvStreamHandle {
	rows: Record<string, unknown>[];
	totalScanned: number;
	done: boolean;
}

// ============================================================
// Limits
// ============================================================

/** Hard cap on rows kept in the display/query buffer (shared with the Excel
 *  path via $lib/config). Column stats are computed on ALL rows regardless. */
const MAX_ALL_ROWS = MAX_DISPLAY_ROWS;

/** Rows rendered in the DOM at any one time */
export const VIRTUAL_PAGE_SIZE = 200;
/** Report progress every N rows */
const PROGRESS_INTERVAL = 10_000;
/** Yield to browser every N chunks */
const YIELD_EVERY_N_CHUNKS = 3;

// ============================================================
// Column type detection
// ============================================================

const DATE_PATTERNS = [
	/^\d{4}-\d{2}-\d{2}$/,
	/^\d{2}\/\d{2}\/\d{4}$/,
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
	/^\w{3}\s+\d{1,2},?\s+\d{4}$/,
];

function isDateLike(value: string): boolean {
	return DATE_PATTERNS.some((p) => p.test(value.trim()));
}

function isNumeric(value: unknown): boolean {
	if (value === null || value === undefined || value === '') return false;
	if (typeof value === 'number') return !isNaN(value);
	if (typeof value === 'string') {
		const cleaned = value.replace(/[$,%]/g, '').trim();
		return cleaned !== '' && !isNaN(Number(cleaned));
	}
	return false;
}

type ColType = 'numeric' | 'categorical' | 'datetime' | 'text';

// ============================================================
// Incremental column accumulators
// ============================================================

interface NumericAcc {
	kind: 'numeric';
	count: number;
	nullCount: number;
	sum: number;
	min: number;
	max: number;
	m2: number;
	mean: number;
	reservoir: number[];
}

interface CategoricalAcc {
	kind: 'categorical' | 'datetime' | 'text';
	count: number;
	nullCount: number;
	freq: Map<string, number>;
	uniqueCount: number;
}

type ColAcc = NumericAcc | CategoricalAcc;

function detectTypeFromSample(values: unknown[]): ColType {
	const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== '');
	if (nonEmpty.length === 0) return 'text';
	const strValues = nonEmpty.filter((v) => typeof v === 'string') as string[];
	if (strValues.length > 0) {
		const dateFraction = strValues.filter(isDateLike).length / strValues.length;
		if (dateFraction > 0.7) return 'datetime';
	}
	const numericFraction = nonEmpty.filter(isNumeric).length / nonEmpty.length;
	if (numericFraction > 0.8) return 'numeric';
	const unique = new Set(nonEmpty.map(String));
	const cardinalityRatio = unique.size / nonEmpty.length;
	if (unique.size <= 20 && (nonEmpty.length < 10 || cardinalityRatio <= 0.5)) return 'categorical';
	return 'text';
}

function makeAcc(type: ColType): ColAcc {
	if (type === 'numeric') {
		return { kind: 'numeric', count: 0, nullCount: 0, sum: 0, min: Infinity, max: -Infinity, m2: 0, mean: 0, reservoir: [] };
	}
	return { kind: type as 'categorical' | 'datetime' | 'text', count: 0, nullCount: 0, freq: new Map(), uniqueCount: 0 };
}

function updateAcc(acc: ColAcc, value: unknown): void {
	if (value === null || value === undefined || value === '') {
		acc.nullCount++;
		return;
	}
	acc.count++;
	if (acc.kind === 'numeric') {
		const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[$,%]/g, ''));
		if (isNaN(n)) { acc.nullCount++; acc.count--; return; }
		if (n < acc.min) acc.min = n;
		if (n > acc.max) acc.max = n;
		acc.sum += n;
		const delta = n - acc.mean;
		acc.mean += delta / acc.count;
		acc.m2 += delta * (n - acc.mean);
		if (acc.reservoir.length < 10_000) {
			acc.reservoir.push(n);
		} else {
			const j = Math.floor(Math.random() * acc.count);
			if (j < 10_000) acc.reservoir[j] = n;
		}
	} else {
		const key = String(value);
		const prev = acc.freq.get(key) ?? 0;
		if (prev === 0) acc.uniqueCount++;
		if (acc.uniqueCount <= 500) {
			acc.freq.set(key, prev + 1);
		}
	}
}

function finalizeAcc(name: string, acc: ColAcc): ColumnProfile {
	const total = acc.count + acc.nullCount;
	if (acc.kind === 'numeric') {
		const sorted = [...acc.reservoir].sort((a, b) => a - b);
		const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
		const stdDev = acc.count > 1 ? Math.sqrt(acc.m2 / (acc.count - 1)) : 0;
		return {
			name, type: 'numeric', count: total,
			uniqueCount: acc.reservoir.length,
			nullCount: acc.nullCount,
			min: acc.min === Infinity ? 0 : acc.min,
			max: acc.max === -Infinity ? 0 : acc.max,
			mean: Math.round(acc.mean * 100) / 100,
			median,
			stdDev: Math.round(stdDev * 100) / 100
		} as ColumnProfile;
	} else {
		const topValues = [...acc.freq.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([value, count]) => ({ value, count }));
		return {
			name, type: acc.kind, count: total,
			uniqueCount: acc.uniqueCount,
			nullCount: acc.nullCount,
			topValues
		} as ColumnProfile;
	}
}

// ============================================================
// Parser options
// ============================================================

export interface CsvParseOptions {
	onProgress?: (rowsRead: number) => void;
	/** Called on every chunk with current total scanned and the live row buffer */
	onChunk?: (totalScanned: number, rows: Record<string, unknown>[]) => void;
	/** Called when streaming is complete with final total, live row buffer, and final column profiles */
	onComplete?: (totalScanned: number, rows: Record<string, unknown>[], finalProfiles: ColumnProfile[]) => void;
}

function yieldToMain(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// ============================================================
// Main export — returns immediately with first rows, streams rest
// ============================================================

export async function parseCSV(file: File, options: CsvParseOptions = {}): Promise<ParsedFile> {
	if (file.size === 0) throw new Error('File is empty');

	const Papa = (await import('papaparse')).default;

	// Snapshot the ORIGINAL file bytes so a .cesvu export can embed the real CSV
	// (rawContent). Read our own independent copy — Papa.parse(file) streams the
	// same blob separately, so this doesn't interfere with parsing.
	const rawContent = await file.arrayBuffer();


	let columns: string[] = [];
	let colTypes: ColType[] = [];
	let accs: ColAcc[] = [];

	// The live row buffer — grows as streaming continues
	const allRows: Record<string, unknown>[] = [];

	// Reactive handle — DocumentPane reads this directly
	const handle: CsvStreamHandle = {
		rows: allRows,
		totalScanned: 0,
		done: false
	};

	let totalRowCount = 0;
	let lastProgressAt = 0;
	let chunkCount = 0;
	let capped = false;
	let resolved = false; // tracks whether the promise has been resolved

	return new Promise((resolve, reject) => {
		Papa.parse(file, {
			header: true,
			skipEmptyLines: true,
			dynamicTyping: true,
			chunkSize: 256 * 1024,

			chunk(
				results: { data: Record<string, unknown>[]; meta: { fields?: string[] } },
				p: { pause: () => void; resume: () => void }
			) {
				const chunkRows = results.data as Record<string, unknown>[];
				if (chunkRows.length === 0) return;

				// Init columns from first chunk
				if (columns.length === 0 && results.meta.fields) {
					columns = results.meta.fields;
					colTypes = columns.map((col) => {
						const sample = chunkRows.slice(0, 20).map((r) => r[col]);
						return detectTypeFromSample(sample);
					});
					accs = colTypes.map(makeAcc);
				}

				for (const row of chunkRows) {
					totalRowCount++;

					// Stable row identity for spreadsheet annotations.
					// This is the original 0-based data-row position after Papa Parse has
					// applied header parsing and skipEmptyLines. Viewers must not use the
					// current display index (which changes under sort/filter) as the note
					// anchor. Stamping here guarantees even the first chunk is tagged before
					// parseCSV resolves and before a user can add notes.
					row.__rowIdx__ = totalRowCount - 1;

					// Always update column stats (all rows)
					for (let c = 0; c < columns.length; c++) {
						updateAcc(accs[c], row[columns[c]]);
					}

					// Append to display buffer up to cap
					if (!capped) {
						allRows.push(row);
						if (allRows.length >= MAX_ALL_ROWS) {
							capped = true;
						}
					}
				}

				handle.totalScanned = totalRowCount;
				chunkCount++;

				// Throttled progress — only before early resolve
				if (!resolved && options.onProgress && totalRowCount - lastProgressAt >= PROGRESS_INTERVAL) {
					lastProgressAt = totalRowCount;
					options.onProgress(totalRowCount);
				}

				// Resolve after the first chunk so the table appears immediately
				if (columns.length > 0 && !resolved) {
					resolved = true;
					const columnProfiles: ColumnProfile[] = columns.map((col, i) => finalizeAcc(col, accs[i]));
					const csvData: CsvData = { columns, rows: allRows };
					const result: ParsedCsvFile = {
						type: 'csv',
						name: file.name,
						size: file.size,
						rawContent,
						parsedData: csvData,
						columnProfiles,
						totalRowCount,
						isStreaming: true,
						isSampled: false,
						streamHandle: handle
					};

					resolve(result);
					// Don't return — keep streaming in background
				} else if (resolved) {
					// Shallow copy so the store gets a new array reference each chunk
					options.onChunk?.(totalRowCount, allRows.slice());
				}

				// Yield every N chunks
				if (chunkCount % YIELD_EVERY_N_CHUNKS === 0) {
					p.pause();
					yieldToMain().then(() => p.resume());
				}
			},

			complete() {
				handle.totalScanned = totalRowCount;
				handle.done = true;
				// Re-finalize column profiles from ALL accumulated rows.
				// The accumulators (accs) have processed every row — this gives
				// accurate stats for the full dataset, not just the first chunk.
				const finalProfiles: ColumnProfile[] = columns.map((col, i) => finalizeAcc(col, accs[i]));
				// Pass a shallow copy so the store gets a new array reference
				// (same reference as before would not trigger $derived re-run)
				options.onComplete?.(totalRowCount, allRows.slice(), finalProfiles);

				if (columns.length === 0) {
					reject(new Error('No columns detected in CSV'));
					return;
				}

				// If file was tiny (resolved on first chunk = same as complete), resolve now
				if (!resolved) {
					resolved = true;
					const columnProfiles: ColumnProfile[] = columns.map((col, i) => finalizeAcc(col, accs[i]));
					const csvData: CsvData = { columns, rows: allRows };
					const result: ParsedCsvFile = {
						type: 'csv',
						name: file.name,
						size: file.size,
						rawContent,
						parsedData: csvData,
						columnProfiles,
						totalRowCount,
						isStreaming: false,
						isSampled: capped,

						streamHandle: handle
					};
					resolve(result);
				}
			},

			error(err: { message: string }) {
				reject(new Error(`CSV parse error: ${err.message}`));
			}
		});
	});
}

// ============================================================
// Workbook bridge — non-streaming parse + legacy conversion
// ============================================================

/**
 * Parse a CSV/TSV file into a single-sheet {@link Workbook}.
 *
 * Unlike {@link parseCSV} (the streaming infinite-scroll parser used by the
 * document viewer), this is a simple, non-streaming parse intended for the
 * unified Workbook data model. A CSV has no concept of tabs, so the result
 * always contains exactly one `Sheet` named "Sheet1", and `activeSheet` points
 * at it. CSVs never carry formulas, so `formulas` is left `undefined`.
 *
 * All values are normalized to strings to match the `Sheet.rows` shape.
 *
 * @param file The CSV/TSV File to parse.
 * @returns A single-sheet Workbook.
 */
export async function parseCsv(file: File): Promise<Workbook> {
	if (file.size === 0) throw new Error('File is empty');

	const Papa = (await import('papaparse')).default;

	return new Promise<Workbook>((resolve, reject) => {
		Papa.parse<Record<string, unknown>>(file, {
			header: true,
			skipEmptyLines: true,
			complete(results: {
				data: Record<string, unknown>[];
				meta: { fields?: string[] };
			}) {
				const headers = results.meta.fields ?? [];
				if (headers.length === 0) {
					reject(new Error('No columns detected in CSV'));
					return;
				}

				const rows: Record<string, string>[] = results.data.map((row) => {
					const obj: Record<string, string> = {};
					for (const h of headers) {
						const v = row[h];
						obj[h] = v === null || v === undefined ? '' : String(v);
					}
					return obj;
				});

				const workbook: Workbook = {
					fileName: file.name,
					activeSheet: 'Sheet1',
					sheets: [
						{
							name: 'Sheet1',
							headers,
							rows,
							rowCount: rows.length,
							formulas: undefined
						}
					]
				};
				resolve(workbook);
			},
			error(err: { message: string }) {
				reject(new Error(`CSV parse error: ${err.message}`));
			}
		});
	});
}

/**
 * Extract the active sheet (falling back to the first sheet) of a
 * {@link Workbook} into the legacy {@link CsvData} shape `{ columns, rows }`.
 *
 * This is a bridge for code that still consumes the older `CsvData` interface.
 * If the workbook has no sheets, returns an empty `{ columns: [], rows: [] }`.
 *
 * @param wb The workbook to extract from.
 * @returns Legacy CsvData for the active (or first) sheet.
 */
export function workbookToCsvData(wb: Workbook): CsvData {
	const sheet =
		wb.sheets.find((s) => s.name === wb.activeSheet) ?? wb.sheets[0];
	if (!sheet) return { columns: [], rows: [] };
	return {
		columns: sheet.headers,
		rows: sheet.rows as Record<string, unknown>[]
	};
}
