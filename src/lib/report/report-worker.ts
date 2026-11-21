/**
 * src/lib/report/report-worker.ts — off-main-thread Summary Report builder.
 *
 * Mirrors excel.worker.ts's protocol shape. Takes the ORIGINAL file bytes
 * (not the possibly-capped MAX_DISPLAY_ROWS display buffer) and re-parses
 * them here with SheetJS (`cellNF: true, cellDates: true`) so totals cover
 * every row the source file actually has (req. #4) — this worker never
 * reads from the app's display buffer at all.
 *
 * Protocol:
 *   main → worker : { type: 'build', id, request: ReportBuildRequest }
 *   worker → main : { type: 'progress', id, stage, processed, total }
 *                   { type: 'done', id, pdfBytes, replacedCharacterCount, landscape, groupCount, warnings }
 *                   { type: 'error', id, message }
 *
 * `xlsx`, `pdf-lib`, and `@pdf-lib/fontkit` are all imported dynamically so
 * none of them land in the main bundle.
 */

import { buildSummaryReport, type SortOption, type ReportDetail, type ColumnAggSpec, type ParsedRow } from './summary-report.js';
import { adaptExcelCell, adaptCsvCell, columnLooksLikeDate, type Xlsxish } from './report-cells.js';
import { buildSettingsLines, buildKpiLines, buildGroupSummarySection, buildDetailSection, type FormatTotalFn } from './report-pdf-input.js';
import { buildReportPdf, type ReportPdfInput, type ReportTableSection } from './pdf-writer.js';

// Fonts are bundled static assets — resolved to their final hashed URL at
// build time via Vite's `?url` import, then fetched (works identically in
// dev and prod, and inside a module Worker).
// eslint-disable-next-line import/no-unresolved
import notoRegularUrl from './fonts/NotoSans-Regular.ttf?url';
// eslint-disable-next-line import/no-unresolved
import notoBoldUrl from './fonts/NotoSans-Bold.ttf?url';

export interface ReportBuildRequest {
	fileName: string;
	/** 'excel' re-parses with SheetJS; 'csv' re-parses with PapaParse. */
	sourceType: 'excel' | 'csv';
	/** Original, uncapped file bytes — see the module doc comment. */
	fileBytes: ArrayBuffer;
	/** Which worksheet tab to report on (ignored for CSV, which has one). */
	sheetName?: string;
	title: string;
	groupByColumn: string | null;
	columnAggregations: ColumnAggSpec[];
	sort: SortOption | null;
	sortDescription: string;
	detail: ReportDetail;
	pageSize: 'Letter' | 'A4';
	generatedAtDisplay: string;
}

export interface ReportBuildResult {
	pdfBytes: Uint8Array;
	replacedCharacterCount: number;
	landscape: boolean;
	groupCount: number;
	warnings: string[];
	sha256Full: string;
}

/** Build stage reported to the caller — drives the modal's progress UI. */
export type ReportBuildStage = 'reading' | 'preparing' | 'grouping' | 'drawing' | 'saving';

export interface ReportProgress {
	stage: ReportBuildStage;
	/** Items processed so far within this stage, when known. */
	processed: number;
	/** Total items in this stage, when known (0 if indeterminate). */
	total: number;
}

/** Yield to the event loop so a queued progress postMessage can flush. */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Rows processed between progress reports / yield points in buildRows(). */
const ROW_YIELD_INTERVAL = 2_000;

/** SHA-256 hex digest of the ORIGINAL file bytes (req. #5), lowercase. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function fetchFontBytes(url: string): Promise<ArrayBuffer> {
	const res = await fetch(url);
	return res.arrayBuffer();
}

interface ParsedSheet {
	headers: string[];
	/** Excel only: raw SheetJS cells per header, used for date detection + .w/.z. */
	xlsxCells?: Record<string, Xlsxish>[];
	/** CSV only: plain string cells per header. */
	csvCells?: Record<string, string>[];
}

/** Re-parse the ORIGINAL file bytes (never the app's capped display buffer). */
async function reparseSource(request: ReportBuildRequest): Promise<ParsedSheet> {
	if (request.sourceType === 'csv') {
		const Papa = (await import('papaparse')).default;
		const text = new TextDecoder('utf-8').decode(request.fileBytes);
		const result = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
		const headers = result.meta.fields ?? [];
		return { headers, csvCells: result.data };
	}

	const XLSX = (await import('xlsx')).default;
	const wb = XLSX.read(new Uint8Array(request.fileBytes), {
		type: 'array',
		cellNF: true,
		cellDates: true
	});
	const sheetName = request.sheetName && wb.SheetNames.includes(request.sheetName)
		? request.sheetName
		: wb.SheetNames[0];
	const ws = wb.Sheets[sheetName];
	const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false });
	const headerRow = (matrix[0] as unknown[]) ?? [];
	const headers = headerRow.map((h, i) => {
		const s = h === null || h === undefined ? '' : String(h).trim();
		return s !== '' ? s : `Column ${i + 1}`;
	});

	const range = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null;
	const dataRowCount = matrix.length - 1;
	const xlsxCells: Record<string, Xlsxish>[] = Array.from({ length: dataRowCount }, () => ({}));
	if (range) {
		for (const addr of Object.keys(ws)) {
			if (addr.charCodeAt(0) === 0x21 /* '!' */) continue;
			const { r, c } = XLSX.utils.decode_cell(addr);
			const dataRowIndex = r - (range.s.r + 1);
			if (dataRowIndex < 0 || dataRowIndex >= dataRowCount) continue;
			const colIndex = c - range.s.c;
			const header = headers[colIndex];
			if (header === undefined) continue;
			xlsxCells[dataRowIndex][header] = ws[addr] as Xlsxish;
		}
	}

	return { headers, xlsxCells };
}

/**
 * Build one ParsedRow per data row, keyed by header.
 *
 * Async + yields every ROW_YIELD_INTERVAL rows so a large sheet (tens of
 * thousands of rows) doesn't run as one uninterrupted synchronous loop —
 * without the yield, any 'preparing' progress message queued here would sit
 * unflushed until the WHOLE loop finished, same issue as the PDF draw loop.
 */
async function buildRows(
	sheet: ParsedSheet,
	onProgress?: (processed: number, total: number) => void
): Promise<ParsedRow[]> {
	const isCsv = Boolean(sheet.csvCells);
	const cells = (sheet.csvCells ?? sheet.xlsxCells ?? []) as (Record<string, Xlsxish | string>)[];
	const total = cells.length;
	const rows: ParsedRow[] = new Array(total);

	for (let i = 0; i < total; i++) {
		const raw = cells[i];
		const row: ParsedRow = {};
		for (const h of sheet.headers) {
			row[h] = isCsv ? adaptCsvCell(raw[h] as string | undefined) : adaptExcelCell(raw[h] as Xlsxish | undefined);
		}
		rows[i] = row;

		if ((i + 1) % ROW_YIELD_INTERVAL === 0) {
			onProgress?.(i + 1, total);
			await yieldToEventLoop();
		}
	}
	onProgress?.(total, total);
	return rows;
}

/** Column-by-column date detection (Excel only — CSV has no format codes). */
async function detectDateColumns(sheet: ParsedSheet): Promise<string[]> {
	if (!sheet.xlsxCells) return [];
	const XLSX = (await import('xlsx')).default;
	const isDateFormat = (z: string) => XLSX.SSF.is_date(z);
	return sheet.headers.filter((h) =>
		columnLooksLikeDate(sheet.xlsxCells!.map((row) => row[h]), isDateFormat)
	);
}

/** Format a raw total using the column's most common SheetJS format (Excel), or toLocaleString (CSV). */
function makeFormatTotal(sheet: ParsedSheet, XLSX: typeof import('xlsx') | null): FormatTotalFn {
	const formatByColumn = new Map<string, string>();
	if (sheet.xlsxCells && XLSX) {
		for (const h of sheet.headers) {
			const freq = new Map<string, number>();
			for (const row of sheet.xlsxCells) {
				const z = row[h]?.z;
				if (z) freq.set(z, (freq.get(z) ?? 0) + 1);
			}
			const best = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
			if (best) formatByColumn.set(h, best[0]);
		}
	}
	return (column, value) => {
		const z = formatByColumn.get(column);
		if (z && XLSX) {
			try {
				return XLSX.SSF.format(z, value);
			} catch {
				// Fall through to the locale fallback below on any format-string error.
			}
		}
		return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
	};
}

/**
 * The full build pipeline, callable directly by tests without a Worker.
 *
 * `fontBytesOverride` lets tests supply font bytes read from disk (`fetch()`
 * can't resolve Vite's `?url`-emitted paths outside a browser/Worker) —
 * production code never passes it, so the real build always goes through
 * `fetch()` against the bundled, hashed font URLs.
 */
export async function buildReport(
	request: ReportBuildRequest,
	fontBytesOverride?: { regular: ArrayBuffer; bold: ArrayBuffer },
	onProgress?: (progress: ReportProgress) => void
): Promise<ReportBuildResult> {
	onProgress?.({ stage: 'reading', processed: 0, total: 0 });
	const [sheet, sha256Full] = await Promise.all([
		reparseSource(request),
		sha256Hex(request.fileBytes)
	]);
	onProgress?.({ stage: 'reading', processed: 1, total: 1 });

	const rows = await buildRows(sheet, (processed, total) =>
		onProgress?.({ stage: 'preparing', processed, total })
	);
	const dateColumns = await detectDateColumns(sheet);
	// Date columns are never aggregated (req. #5) — strip them from whatever
	// the caller sent, even if the UI pre-filled a (now-stale) choice.
	const columnAggregations = request.columnAggregations.filter(
		(spec) => !dateColumns.includes(spec.column)
	);

	onProgress?.({ stage: 'grouping', processed: 0, total: 0 });
	const report = buildSummaryReport({
		headers: sheet.headers,
		rows,
		groupByColumn: request.groupByColumn,
		columnAggregations,
		dateColumns,
		sort: request.sort,
		detail: request.detail
	});

	const XLSX = sheet.xlsxCells ? (await import('xlsx')).default : null;
	const formatTotal = makeFormatTotal(sheet, XLSX);
	const aggregatedColumns = columnAggregations
		.filter((s) => s.aggregation !== 'none')
		.map((s) => s.column);

	const settingsLines = buildSettingsLines({
		sheetName: request.sheetName,
		groupByColumn: request.groupByColumn,
		columnAggregations,
		sortDescription: request.sortDescription,
		detail: request.detail,
		pageSize: request.pageSize,
		groupCount: report.groupCount,
		sha256Full
	});
	const kpiLines = buildKpiLines(report, formatTotal, (ms) => new Date(ms).toLocaleDateString());

	const sections: ReportTableSection[] = [
		buildGroupSummarySection(report, aggregatedColumns, formatTotal)
	];
	if (request.detail === 'summary-and-detail') {
		const cellsForRow = (row: ParsedRow) => sheet.headers.map((h) => row[h]?.display ?? '');
		sections.push(
			buildDetailSection(
				report,
				sheet.headers,
				aggregatedColumns,
				formatTotal,
				cellsForRow,
				request.groupByColumn !== null
			)
		);
	}

	const { regular: regularBytes, bold: boldBytes } =
		fontBytesOverride ??
		(await (async () => {
			const [regular, bold] = await Promise.all([
				fetchFontBytes(notoRegularUrl),
				fetchFontBytes(notoBoldUrl)
			]);
			return { regular, bold };
		})());

	const pdfInput: ReportPdfInput = {
		title: request.title,
		fileName: request.fileName,
		generatedAtDisplay: request.generatedAtDisplay,
		sha256Full,
		settingsLines,
		kpiLines,
		warnings: report.warnings,
		pageSize: request.pageSize,
		sections
	};

	const { bytes, replacedCharacterCount, landscape } = await buildReportPdf(
		pdfInput,
		{ regular: regularBytes, bold: boldBytes },
		(drawn, total) => {
			// The final drawing callback (drawn === total) fires right before
			// pdf-writer.ts calls doc.save() internally — report the 'saving'
			// stage THEN, rather than after buildReportPdf already resolved
			// (which would mean reporting "saving" once saving is finished).
			if (drawn >= total) onProgress?.({ stage: 'saving', processed: 0, total: 0 });
			else onProgress?.({ stage: 'drawing', processed: drawn, total });
		}
	);

	return {
		pdfBytes: bytes,
		replacedCharacterCount,
		landscape,
		groupCount: report.groupCount,
		warnings: report.warnings,
		sha256Full
	};
}

// ============================================================
// Worker protocol — only wired up when actually running as a Worker.
// Guarded so this module can also be imported directly in tests/Node.
// ============================================================
if (typeof self !== 'undefined' && typeof (self as unknown as { postMessage?: unknown }).postMessage === 'function') {
	self.onmessage = (event: MessageEvent) => {
		const msg = event.data as { type: string; id: string; request?: ReportBuildRequest };
		if (msg?.type !== 'build' || !msg.request) return;
		buildReport(msg.request, undefined, (progress) => {
			(self as unknown as Worker).postMessage({ type: 'progress', id: msg.id, ...progress });
		})
			.then((result) => {
				(self as unknown as Worker).postMessage(
					{ type: 'done', id: msg.id, ...result },
					[result.pdfBytes.buffer]
				);
			})
			.catch((err) => {
				(self as unknown as Worker).postMessage({
					type: 'error',
					id: msg.id,
					message: err instanceof Error ? err.message : String(err)
				});
			});
	};
}
