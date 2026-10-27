/**
 * src/lib/parsers/excel.worker.ts — Off-main-thread Excel decoder
 *
 * SheetJS `XLSX.read()` + `sheet_to_json()` are fully synchronous. On a large
 * workbook (100K+ rows) that decode blocks the main thread for many seconds —
 * long enough that the UI never paints a frame and the page appears to hang on
 * "Parsing xlsx…". Deferring downstream work (profiling, summary) doesn't help
 * because the decode itself is the blocking call.
 *
 * This worker moves the entire parse (read → matrix → row objects → formula
 * extraction → cap) into a separate thread. The main thread stays responsive;
 * it receives a fully-materialized {@link Workbook} via postMessage and renders.
 *
 * Protocol:
 *   main → worker : { type: 'parse', id, fileName, buffer (ArrayBuffer, transferred) }
 *   worker → main : { type: 'progress', id, sheet, totalSheets }   (per sheet)
 *                   { type: 'done', id, workbook }
 *                   { type: 'error', id, message }
 *
 * `xlsx` is imported dynamically so it lands in the worker's own chunk and is
 * never pulled into the main bundle / CSV path.
 */

import type * as XLSX from 'xlsx';
import type { Workbook, Sheet } from '../data/workbook.js';
import { profileColumns } from '../pipeline/pipeline.js';
import { MAX_DISPLAY_ROWS } from '../config.js';



function generateColumnName(index: number): string {

	let label = '';
	let n = index;
	do {
		label = String.fromCharCode(65 + (n % 26)) + label;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return `Column ${label}`;
}

function cellToString(value: unknown): string {
	if (value === null || value === undefined) return '';
	return String(value);
}

function extractFormulas(
	xlsx: typeof XLSX,
	ws: XLSX.WorkSheet,
	headers: string[],
	dataRowCount: number
): Record<string, string>[] | undefined {
	const ref = ws['!ref'];
	if (!ref) return undefined;

	// No row limit: extraction iterates only populated cells via Object.keys(ws),
	// so cost is proportional to the number of formula/data cells, not the grid
	// size — and it runs in this worker, off the main thread.
	const range = xlsx.utils.decode_range(ref);

	const result: Record<string, string>[] = Array.from({ length: dataRowCount }, () => ({}));
	let found = false;

	for (const addr of Object.keys(ws)) {
		if (addr.charCodeAt(0) === 0x21 /* '!' */) continue;
		const cell = ws[addr] as XLSX.CellObject | undefined;
		if (!cell || !cell.f) continue;
		const { r, c } = xlsx.utils.decode_cell(addr);
		const dataRowIndex = r - (range.s.r + 1);
		if (dataRowIndex < 0 || dataRowIndex >= dataRowCount) continue;
		const colIndex = c - range.s.c;
		const header = headers[colIndex] ?? generateColumnName(colIndex);
		result[dataRowIndex][header] = cell.f;
		found = true;
	}

	return found ? result : undefined;
}

async function parse(
	id: string,
	fileName: string,
	buffer: ArrayBuffer
): Promise<void> {
	const XLSX = await import('xlsx');
	const data = new Uint8Array(buffer);
	const wb = XLSX.read(data, { type: 'array', cellFormula: true });

	const sheets: Sheet[] = [];

	for (let si = 0; si < wb.SheetNames.length; si++) {
		const sheetName = wb.SheetNames[si];
		(self as unknown as Worker).postMessage({
			type: 'progress',
			id,
			sheet: si + 1,
			totalSheets: wb.SheetNames.length
		});

		const ws = wb.Sheets[sheetName];
		const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
			header: 1,
			defval: '',
			blankrows: false
		});

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
		if (headers.length === 0) headers.push(generateColumnName(0));

		const trueRowCount = dataMatrix.length;
		// All rows materialized (no cap) — this runs off the main thread.
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

		// Profile over the FULL (uncapped) row set BEFORE capping the display
		// buffer, so column statistics reflect every row regardless of the cap.
		const fullProfile = profileColumns(rows);

		// Extract formulas over the full row set (matches the full-data semantics).
		const formulas = extractFormulas(XLSX, ws, headers, rows.length);

		// Cap the DISPLAY/query buffer to MAX_DISPLAY_ROWS. rowCount stays the
		// true count; isSampled flags the cap; fullProfile preserves full stats.
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

	const workbook: Workbook = {
		fileName,
		sheets,
		activeSheet: wb.SheetNames[0] ?? ''
	};

	(self as unknown as Worker).postMessage({ type: 'done', id, workbook });
}

self.onmessage = (event: MessageEvent) => {
	const msg = event.data;
	if (msg?.type !== 'parse') return;
	parse(msg.id, msg.fileName, msg.buffer).catch((err) => {
		(self as unknown as Worker).postMessage({
			type: 'error',
			id: msg.id,
			message: err instanceof Error ? err.message : String(err)
		});
	});
};
