/**
 * src/lib/parsers/excel.ts — Excel (.xlsx/.xls) parser (client-side only)
 *
 * Parses an Excel workbook into the application's unified {@link Workbook}
 * data model. Each worksheet tab becomes a {@link Sheet}. Formulas are
 * preserved per-cell where present.
 *
 * All parsing happens in the browser via SheetJS — no server upload.
 */

// NOTE: `xlsx` (SheetJS) is a large dependency (~900KB). It is imported
// DYNAMICALLY inside parseExcel() so it lands in its own Vite chunk and is
// only fetched when a user actually opens an Excel file. CSV/PDF/DOCX/TXT
// users never download it.
//
// The `import type { XLSX } ...` below is ERASED at build time (type-only) —
// it carries ZERO runtime cost and pulls nothing into the bundle. The actual
// runtime module is loaded via `await import('xlsx')`.
import type * as XLSX from 'xlsx';
import type { Workbook, Sheet } from '../data/workbook.js';
import { profileColumns } from '../pipeline/pipeline.js';
import { MAX_DISPLAY_ROWS } from '../config.js';
import { newId } from '../utils/id.js';


/**

 * Generate a spreadsheet-style column label for a zero-based index.
 * 0 → "Column A", 1 → "Column B", … 26 → "Column AA", etc.
 */
function generateColumnName(index: number): string {
	let label = '';
	let n = index;
	do {
		label = String.fromCharCode(65 + (n % 26)) + label;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return `Column ${label}`;
}

/**
 * Normalize an arbitrary cell value to a string.
 * null/undefined become an empty string.
 */
function cellToString(value: unknown): string {
	if (value === null || value === undefined) return '';
	return String(value);
}

/**
 * Parse an Excel file into a {@link Workbook}.
 *
 * - Reads with `cellFormula: true` so formula strings are available on `cell.f`.
 * - Iterates `workbook.SheetNames` to extract each sheet in tab order.
 * - The first row of each sheet is treated as headers; remaining rows are data.
 * - Sheets with no headers get generated names ("Column A", "Column B", …).
 * - Empty sheets (no data rows) are returned with headers and an empty `rows`.
 * - `activeSheet` is set to the first sheet.
 *
 * @param file The .xlsx/.xls File to parse.
 * @returns A populated Workbook.
 */
export async function parseExcel(
	file: File,
	onProgress?: (sheet: number, totalSheets: number) => void
): Promise<Workbook> {
	// PRIMARY PATH: decode in a Web Worker so SheetJS's synchronous
	// XLSX.read()/sheet_to_json() never block the main thread. On a 100K+ row
	// workbook that decode takes many seconds; on the main thread it froze the
	// tab on "Parsing xlsx…" before a single frame could paint. The worker
	// returns a fully-materialized (capped + formula-extracted) Workbook.
	if (typeof Worker !== 'undefined') {
		try {
			return await parseExcelInWorker(file, onProgress);
		} catch (err) {
			// Fall through to the synchronous path on any worker failure
			// (e.g. environment without module-worker support). Logged, not fatal.
			console.warn('[parseExcel] Worker path failed, falling back to main thread:', err);
		}
	}

	// FALLBACK PATH: synchronous decode on the calling thread. Used only when
	// Workers are unavailable or the worker errored.
	const XLSX = await import('xlsx');

	const buffer = await file.arrayBuffer();
	const data = new Uint8Array(buffer);

	const wb = XLSX.read(data, { type: 'array', cellFormula: true });


	const sheets: Sheet[] = [];

	for (const sheetName of wb.SheetNames) {
		const ws = wb.Sheets[sheetName];

		// Raw matrix of rows: each row is an array of cell values (header: 1).
		const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
			header: 1,
			defval: '',
			blankrows: false
		});

		// First row → headers. Determine the max column count across all rows
		// so we can backfill generated headers for any unlabeled columns.
		const headerRow = (matrix[0] as unknown[]) ?? [];
		const dataMatrix = matrix.slice(1);

		// Plain loop — NOT Math.max(...spread). Spreading 100K+ row lengths as
		// function arguments overflows the call stack ("Maximum call stack size
		// exceeded") on large sheets.
		let maxCols = headerRow.length;
		for (const r of dataMatrix) {
			const len = Array.isArray(r) ? r.length : 0;
			if (len > maxCols) maxCols = len;
		}


		const headers: string[] = [];
		for (let c = 0; c < maxCols; c++) {
			const raw = cellToString(headerRow[c]).trim();
			headers.push(raw !== '' ? raw : generateColumnName(c));
		}

		// Fully-empty sheet (no headers AND no data rows → maxCols === 0):
		// synthesize a single empty column so downstream consumers (viewer,
		// profiler, operation engine) always see at least one column and never
		// have to special-case a zero-column sheet.
		if (headers.length === 0) {
			headers.push(generateColumnName(0)); // "Column A"
		}


		const trueRowCount = dataMatrix.length;

		// Build row objects keyed by header name — ALL rows (no cap). Heavy
		// decode runs in the worker (off the main thread); the virtualized table
		// only ever renders ~200 rows at a time regardless of total count.
		const rows: Record<string, string>[] = new Array(trueRowCount);
		for (let i = 0; i < trueRowCount; i++) {
			const r = dataMatrix[i];
			const rowArr = Array.isArray(r) ? r : [];
			const obj: Record<string, string> = {};
			for (let c = 0; c < headers.length; c++) {
				obj[headers[c]] = cellToString(rowArr[c]);
			}
			rows[i] = obj;
		}


		// Profile the FULL (uncapped) row set before capping the display buffer,
		// so column stats reflect every row. Mirrors the worker path.
		const fullProfile = profileColumns(rows);

		// Extract formula strings per data row, keyed by header name.
		// Only populated when at least one formula exists in the sheet.
		// Pass the lazily-loaded module so extractFormulas needs no static import.
		const formulas = extractFormulas(XLSX, ws, headers, rows.length);

		// Cap the DISPLAY/query buffer. rowCount stays the true count; isSampled
		// flags the cap; fullProfile preserves full-file stats.
		const isSampled = rows.length > MAX_DISPLAY_ROWS;
		const displayRows = isSampled ? rows.slice(0, MAX_DISPLAY_ROWS) : rows;
		const displayFormulas =
			formulas && isSampled ? formulas.slice(0, MAX_DISPLAY_ROWS) : formulas;

		const sheet: Sheet = {
			name: sheetName,
			headers,
			rows: displayRows,
			rowCount: trueRowCount,
			fullProfile
		};

		if (isSampled) sheet.isSampled = true;
		if (displayFormulas) sheet.formulas = displayFormulas;


		sheets.push(sheet);

	}

	return {
		fileName: file.name,
		sheets,
		activeSheet: wb.SheetNames[0] ?? ''
	};
}

/**
 * Decode an Excel file in a dedicated Web Worker (see excel.worker.ts).
 *
 * Transfers the file's ArrayBuffer into the worker (zero-copy) so the heavy
 * synchronous SheetJS decode runs off the main thread. Resolves with the
 * fully-materialized Workbook the worker posts back, or rejects on worker error.
 * The worker is single-use: created per call and terminated when done.
 */
function parseExcelInWorker(
	file: File,
	onProgress?: (sheet: number, totalSheets: number) => void
): Promise<Workbook> {
	return new Promise<Workbook>((resolve, reject) => {
		// Vite resolves this URL + ?module worker at build time into its own chunk.
		const worker = new Worker(new URL('./excel.worker.ts', import.meta.url), {
			type: 'module'
		});
		const id = newId('xlsx');

		const cleanup = () => worker.terminate();

		worker.onmessage = (event: MessageEvent) => {
			const msg = event.data;
			if (!msg || msg.id !== id) return;
			switch (msg.type) {
				case 'progress':
					onProgress?.(msg.sheet, msg.totalSheets);
					break;
				case 'done':
					cleanup();
					resolve(msg.workbook as Workbook);
					break;
				case 'error':
					cleanup();
					reject(new Error(msg.message ?? 'Excel worker error'));
					break;
			}
		};

		worker.onerror = (e) => {
			cleanup();
			reject(new Error(e.message ?? 'Excel worker crashed'));
		};

		file
			.arrayBuffer()
			.then((buffer) => {
				// Transfer the buffer (zero-copy) — `file` is no longer needed here.
				worker.postMessage({ type: 'parse', id, fileName: file.name, buffer }, [buffer]);
			})
			.catch((err) => {
				cleanup();
				reject(err instanceof Error ? err : new Error(String(err)));
			});
	});
}

/**
 * Collect formula strings (`cell.f`) into a per-data-row map keyed by header
 * name. Row 0 is the header row and is skipped. Returns `undefined` if the
 * sheet contains no formulas.
 *
 * NO ROW LIMIT: formulas are extracted regardless of sheet size. This is cheap
 * because we iterate ONLY the cell addresses that actually exist on the
 * worksheet object via `Object.keys(ws)` — cost is proportional to populated
 * cells, not the grid rectangle — and because the whole parse runs in a Web
 * Worker, off the main thread. (Previously capped at 20K rows when this ran
 * synchronously on the main thread.)
 *
 * PERF: walking the full `decode_range` rectangle cell-by-cell with
 * `encode_cell()` would be O(rows × cols) string-encodes + lookups (millions of
 * ops on a 100K-row sheet, even with zero formulas). Iterating `Object.keys(ws)`
 * instead lets a no-formula sheet fall through to `undefined` almost immediately.
 */
function extractFormulas(
	xlsx: typeof XLSX,
	ws: XLSX.WorkSheet,
	headers: string[],
	dataRowCount: number
): Record<string, string>[] | undefined {
	const ref = ws['!ref'];
	if (!ref) return undefined;

	const range = xlsx.utils.decode_range(ref);

	const result: Record<string, string>[] = Array.from(
		{ length: dataRowCount },
		() => ({})
	);
	let found = false;

	// Iterate only the cells present on the sheet object. Keys that aren't cell
	// addresses (e.g. "!ref", "!cols", "!merges") start with "!" and are skipped.
	for (const addr of Object.keys(ws)) {
		if (addr.charCodeAt(0) === 0x21 /* '!' */) continue;
		const cell = ws[addr] as XLSX.CellObject | undefined;
		if (!cell || !cell.f) continue;

		const { r, c } = xlsx.utils.decode_cell(addr);
		// Skip the header row and anything outside the data range.
		const dataRowIndex = r - (range.s.r + 1);
		if (dataRowIndex < 0 || dataRowIndex >= dataRowCount) continue;

		const colIndex = c - range.s.c;
		const header = headers[colIndex] ?? generateColumnName(colIndex);
		result[dataRowIndex][header] = cell.f;
		found = true;
	}

	return found ? result : undefined;
}


