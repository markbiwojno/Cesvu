/**
 * src/lib/parsers/index.ts — File parser router
 *
 * Auto-detects file type by extension + MIME type and delegates
 * to the appropriate parser. Returns a unified ParsedFile.
 *
 * Supported: .csv, .tsv, .xlsx, .xls, .txt, .md, .pdf, .docx
 *
 * Tabular sources (CSV + Excel) carry a unified `Workbook` on the returned
 * object's `workbook` field. CSV uses the NEW non-streaming `parseCsv()`
 * (lowercase) here; the streaming `parseCSV` (uppercase) and its consumers
 * (DocumentPane, etc.) remain untouched and are still exported below.
 */

import type { CsvData } from '$lib/types.js';
import { parseCsv, workbookToCsvData } from './csv.js';
import { parseTXT } from './txt.js';
import { parseMD } from './md.js';
import { parsePDF } from './pdf.js';
import { parseDOCX } from './docx.js';



export { parseCSV, parseCsv, workbookToCsvData } from './csv.js';
export { parseExcel } from './excel.js';
export { parseTXT } from './txt.js';
export { parseMD } from './md.js';
export { parsePDF, parsePDFBytes } from './pdf.js';
export { parseDOCX, parseDOCXBytes } from './docx.js';



// ============================================================
// File type detection
// ============================================================

type DetectedType = 'csv' | 'excel' | 'txt' | 'md' | 'pdf' | 'docx' | 'unknown';

const EXCEL_MIME_TYPES = new Set([
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
	'application/vnd.ms-excel' // .xls
]);

/** Detect a file's type by extension + MIME. Synchronous, fast. */
function detectType(file: File): DetectedType {
	const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
	const mime = file.type.toLowerCase();

	if (ext === 'xlsx' || ext === 'xls' || EXCEL_MIME_TYPES.has(mime)) return 'excel';
	if (ext === 'csv' || ext === 'tsv' || mime === 'text/csv') return 'csv';
	if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
	if (
		ext === 'docx' ||
		mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
	) return 'docx';
	if (ext === 'md' || mime === 'text/markdown') return 'md';
	if (ext === 'txt' || mime === 'text/plain') return 'txt';

	return 'unknown';
}


// ============================================================
// Router
// ============================================================

/**
 * Parse any supported file. Auto-detects type by extension + MIME.
 * Throws a descriptive error for unsupported types.
 *
 * For CSV and Excel the result carries a `workbook` field and `parsedData`
 * is set to the active sheet's legacy `CsvData` for backward compatibility.
 */
export async function parseFile(file: File): Promise<import('$lib/types.js').ParsedFile> {

	const type = detectType(file);

	switch (type) {
		case 'excel': {
			// Lazy-load the Excel parser so the SheetJS chunk is fetched only
			// when an Excel file is actually opened. CSV-only sessions never
			// touch this code path or download xlsx.
			const { parseExcel } = await import('./excel.js');
			// Preserve the ORIGINAL file bytes so a .cesvu export can embed the
			// real workbook (rawContent). Read our own copy — each file.arrayBuffer()
			// call returns an independent buffer, so the parser/worker reading its
			// own copy (and possibly transferring it) doesn't affect ours.
			const [workbook, rawContent] = await Promise.all([
				parseExcel(file),
				file.arrayBuffer()
			]);
			const csvData: CsvData = workbookToCsvData(workbook);
			return {
				type: 'excel',
				name: file.name,
				size: file.size,
				rawContent,
				parsedData: csvData,
				workbook
			};

		}
		case 'csv': {
			// Use the NEW non-streaming workbook parser for the router.
			// Preserve the ORIGINAL file bytes (rawContent) so a .cesvu export
			// can embed the real CSV for the recipient to reopen as a table.
			const [workbook, rawContent] = await Promise.all([
				parseCsv(file),
				file.arrayBuffer()
			]);
			const csvData: CsvData = workbookToCsvData(workbook);
			return {
				type: 'csv',
				name: file.name,
				size: file.size,
				rawContent,
				parsedData: csvData,
				workbook
			};
		}

		case 'pdf':
			return parsePDF(file);
		case 'docx':
			return parseDOCX(file);
		case 'md':
			return parseMD(file);
		case 'txt':
			return parseTXT(file);
		case 'unknown':
		default: {
			// Last resort: try reading as plain text
			try {
				return await parseTXT(file);
			} catch {
				throw new Error(
					`Unsupported file type: "${file.name}". ` +
					`Supported formats: CSV, TSV, XLSX, XLS, PDF, DOCX, TXT, MD`
				);
			}
		}
	}
}
