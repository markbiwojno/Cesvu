/**
 * src/lib/pipeline/pipeline.ts — Data compression pipeline
 *
 * Transforms a ParsedFile into a CompressedSummary suitable for LLM
 * consumption (~2000 chars / ~500-800 tokens). The LLM never sees raw
 * data — only this compressed summary.
 *
 * Runs entirely client-side. No network calls.
 */

import type { ParsedFile, CompressedSummary, ColumnProfile, CsvData, StructuredText } from '$lib/types.js';
import type { ParsedCsvFile } from '$lib/parsers/csv.js';
import type { Workbook, Sheet, WorkbookProfile, SheetProfile } from '$lib/data/workbook.js';

// ============================================================
// Column profiling (for CSV files without pre-computed profiles)
// ============================================================

function isNumericValue(v: unknown): boolean {
	if (v === null || v === undefined || v === '') return false;
	if (typeof v === 'number') return !isNaN(v);
	if (typeof v === 'string') {
		const cleaned = v.replace(/[$,%]/g, '').trim();
		return cleaned !== '' && !isNaN(Number(cleaned));
	}
	return false;
}

const DATE_RE = [
	/^\d{4}-\d{2}-\d{2}$/,
	/^\d{2}\/\d{2}\/\d{4}$/,
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/,
];

function isDateValue(v: unknown): boolean {
	if (typeof v !== 'string') return false;
	return DATE_RE.some((r) => r.test(v.trim()));
}

function profileColumn(name: string, values: unknown[]): ColumnProfile {
	const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== '');
	const nullCount = values.length - nonEmpty.length;
	const uniqueCount = new Set(nonEmpty.map(String)).size;

	// Datetime check
	const strVals = nonEmpty.filter((v) => typeof v === 'string') as string[];
	if (strVals.length > 0 && strVals.filter(isDateValue).length / strVals.length > 0.7) {
		const freq = new Map<string, number>();
		for (const v of nonEmpty) freq.set(String(v), (freq.get(String(v)) ?? 0) + 1);
		return {
			name, type: 'datetime', count: values.length, uniqueCount, nullCount,
			topValues: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([value, count]) => ({ value, count }))
		};
	}

	// Numeric check
	const numFraction = nonEmpty.filter(isNumericValue).length / Math.max(nonEmpty.length, 1);
	if (numFraction > 0.8) {
		const nums = nonEmpty
			.map((v) => typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,%]/g, '')))
			.filter((n) => !isNaN(n));
		const sorted = [...nums].sort((a, b) => a - b);
		const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
		return {
			name, type: 'numeric', count: values.length, uniqueCount, nullCount,
			min: sorted[0], max: sorted[sorted.length - 1],
			mean: Math.round(mean * 100) / 100,
			median: sorted[Math.floor(sorted.length / 2)]
		};
	}

	// Categorical check
	const isSmall = nonEmpty.length < 10;
	const ratio = uniqueCount / Math.max(nonEmpty.length, 1);
	if (uniqueCount <= 20 && (isSmall || ratio <= 0.5)) {
		const freq = new Map<string, number>();
		for (const v of nonEmpty) freq.set(String(v), (freq.get(String(v)) ?? 0) + 1);
		return {
			name, type: 'categorical', count: values.length, uniqueCount, nullCount,
			topValues: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count }))
		};
	}

	// Free-text column (high cardinality). Still attach the 8 most frequent
	// distinct values + counts as a SAMPLE (not an exhaustive distribution) so
	// the chat prompt can ground the LLM in real values — e.g. "DOCK RANDALL (3)"
	// tells the model the value recurs, which is a real pattern, not a guess.
	const freq = new Map<string, number>();
	for (const v of nonEmpty) freq.set(String(v), (freq.get(String(v)) ?? 0) + 1);
	const sampleValues = [...freq.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8)
		.map(([value, count]) => ({ value, count }));
	return { name, type: 'text', count: values.length, uniqueCount, nullCount, sampleValues };
}


// ============================================================
// Main: compressFile
// ============================================================

/**
 * Compress a ParsedFile into a CompressedSummary for LLM consumption.
 *
 * For CSV: compute ColumnProfile for each column.
 * For text (txt/md/pdf/docx): extract first 500 chars as textPreview.
 */
export function compressFile(parsedFile: ParsedFile): CompressedSummary {
	const base = {
		fileType: parsedFile.type,
		fileName: parsedFile.name
	};

	if (parsedFile.type === 'csv') {
		const csvFile = parsedFile as ParsedCsvFile;
		const data = parsedFile.parsedData as CsvData;
		const rows = data.rows;
		const columns = data.columns;

		// Use pre-computed profiles if available (from parseCSV), else compute now
		const columnProfiles: ColumnProfile[] = csvFile.columnProfiles?.length
			? csvFile.columnProfiles
			: columns.map((col) => profileColumn(col, rows.map((r) => r[col])));

		// Use totalRowCount (all scanned rows) not rows.length (display buffer, capped at 100K).
		// For a 200K-row CSV, rows.length may be only the first chunk (~800 rows) if called
		// before streaming completes. totalRowCount is updated incrementally by the parser.
		const trueRowCount = csvFile.totalRowCount > 0 ? csvFile.totalRowCount : rows.length;

		return {
			...base,
			rowCount: trueRowCount,
			columnCount: columns.length,
			columnProfiles,
			structureNotes: buildCsvStructureNotes(columnProfiles, trueRowCount)
		};
	}

	if (parsedFile.type === 'excel') {
		// Excel files carry a unified Workbook. Profile every sheet, surface the
		// active sheet's column profiles for the table/chart components, and use
		// the multi-sheet-aware buildCompressedSummary() for the LLM structure
		// notes. parsedData is a CsvData object (active sheet) — NOT a string,
		// so it must never fall through to the txt/md tail below.
		const wb = (parsedFile as ParsedFile & { workbook?: Workbook }).workbook;
		if (wb && wb.sheets.length) {
			const profile = profileWorkbook(wb);
			const activeName = wb.activeSheet || wb.sheets[0].name;
			const activeProfile =
				profile.sheets.find((s) => s.name === activeName) ?? profile.sheets[0];
			return {
				...base,
				rowCount: activeProfile.rowCount,
				columnCount: activeProfile.columns.length,
				columnProfiles: activeProfile.columns,
				structureNotes: buildCompressedSummary(profile)
			};
		}
		// Fallback: derive profiles from the active-sheet CsvData directly.
		const data = parsedFile.parsedData as CsvData;
		const columnProfiles = data.columns.map((col) =>
			profileColumn(col, data.rows.map((r) => r[col]))
		);
		return {
			...base,
			rowCount: data.rows.length,
			columnCount: data.columns.length,
			columnProfiles,
			structureNotes: buildCsvStructureNotes(columnProfiles, data.rows.length)
		};
	}

	if (parsedFile.type === 'pdf' || parsedFile.type === 'docx') {
		const data = parsedFile.parsedData as StructuredText;
		const preview = data.text.slice(0, 500);
		const wordCount = data.text.split(/\s+/).filter(Boolean).length;
		const readingTimeMin = Math.ceil(wordCount / 200);

		// DOCX still derives section headings; PDFs are now flat per-page text
		// (no heading reconstruction), so headings come from sections when present.
		const headings = (data.sections ?? []).map((s) => s.heading).filter((h) => h.length > 0);


		return {
			...base,
			pageCount: data.pageCount,
			wordCount,
			textPreview: preview,
			structureNotes: [
				`${data.pageCount ?? 0} pages/sections`,
				`~${wordCount.toLocaleString()} words`,
				`~${readingTimeMin} min read`,
				headings.length
					? `Headings: ${headings.slice(0, 5).join(', ')}${headings.length > 5 ? '…' : ''}`
					: ''
			].filter(Boolean).join(' · ')
		};
	}

	// txt / md
	const text = parsedFile.parsedData as string;
	const wordCount = text.split(/\s+/).filter(Boolean).length;

	return {
		...base,
		wordCount,
		textPreview: text.slice(0, 500),
		structureNotes: `~${wordCount.toLocaleString()} words · ${parsedFile.type.toUpperCase()} document`
	};
}


// ============================================================
// Helpers
// ============================================================

export function buildCsvStructureNotes(profiles: ColumnProfile[], rowCount: number): string {
	const numeric = profiles.filter((p) => p.type === 'numeric').map((p) => p.name);
	const categorical = profiles.filter((p) => p.type === 'categorical').map((p) => p.name);
	const datetime = profiles.filter((p) => p.type === 'datetime').map((p) => p.name);

	const parts: string[] = [
		`${rowCount.toLocaleString()} rows · ${profiles.length} columns`
	];
	if (numeric.length) parts.push(`Numeric: ${numeric.join(', ')}`);
	if (categorical.length) parts.push(`Categorical: ${categorical.join(', ')}`);
	if (datetime.length) parts.push(`Dates: ${datetime.join(', ')}`);

	return parts.join(' · ');
}

// ============================================================
// Workbook profiling (multi-sheet support — Excel + CSV)
//
// These additions are independent of the streaming `parseCSV` pipeline and
// its consumers (DocumentPane, etc.), which remain untouched. They operate on
// the unified `Workbook` model (src/lib/data/workbook.ts) where a CSV is a
// single-sheet workbook and an Excel file maps each tab onto a sheet.
// ============================================================

/**
 * Profile every column of a set of rows.
 *
 * Thin wrapper over the existing per-column `profileColumn()` — header names
 * are derived from the union of keys across rows (preserving first-seen order).
 * `profileColumn()` itself is left unchanged.
 */
export function profileColumns(rows: Record<string, unknown>[]): ColumnProfile[] {
	if (!rows.length) return [];
	const headers: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (!seen.has(key)) {
				seen.add(key);
				headers.push(key);
			}
		}
	}
	return headers.map((col) => profileColumn(col, rows.map((r) => r[col])));
}

/**
 * Profile an entire workbook, sheet by sheet.
 *
 * Iterates `wb.sheets`, runs `profileColumns()` on each sheet's rows, and
 * aggregates per-sheet `SheetProfile`s plus workbook-wide totals.
 */
export function profileWorkbook(wb: Workbook): WorkbookProfile {
	const sheets: SheetProfile[] = wb.sheets.map((sheet) => {
		// Prefer the pre-computed full-row profile (Excel worker computes this
		// over ALL rows before the display buffer is capped). Falls back to
		// profiling the (possibly capped) rows for CSV-derived/legacy sheets.
		const columns = sheet.fullProfile ?? profileColumns(sheet.rows);
		return {

			name: sheet.name,
			rowCount: sheet.rowCount,
			columns,
			hasFormulas: Boolean(sheet.formulas && sheet.formulas.length > 0)
		};
	});

	return {
		fileName: wb.fileName,
		totalRows: sheets.reduce((sum, s) => sum + s.rowCount, 0),
		totalColumns: sheets.reduce((sum, s) => sum + s.columns.length, 0),
		sheets
	};
}

// ============================================================
// Workbook → compressed summary (what the LLM receives)
// ============================================================

const SUMMARY_CHAR_CAP = 2500;

/** Render a single column's profile as a compact one-liner. */
function describeColumn(col: ColumnProfile): string {
	switch (col.type) {
		case 'numeric':
			return `  - ${col.name} (numeric): min ${col.min}, max ${col.max}, mean ${col.mean}, median ${col.median}, ${col.nullCount} empty`;
		case 'datetime': {
			const top = col.topValues?.slice(0, 3).map((t) => t.value).join(', ') ?? '';
			return `  - ${col.name} (date): ${col.uniqueCount} distinct${top ? `, e.g. ${top}` : ''}`;
		}
		case 'categorical': {
			const top = col.topValues?.slice(0, 5).map((t) => `${t.value} (${t.count})`).join(', ') ?? '';
			return `  - ${col.name} (categorical): ${col.uniqueCount} distinct${top ? `; top: ${top}` : ''}`;
		}
		default:
			return `  - ${col.name} (text): ${col.uniqueCount} distinct, ${col.nullCount} empty`;
	}
}

/**
 * Build the compressed text summary the LLM receives from a `WorkbookProfile`.
 *
 * - Single sheet  → clean format with no sheet prefix (matches the existing
 *   CSV summary shape).
 * - Multi-sheet   → one markdown section per sheet, with a header block.
 *
 * Total output is capped at {@link SUMMARY_CHAR_CAP} (2500) characters; the
 * per-sheet budget is distributed proportionally by row count so larger sheets
 * get more of the space.
 *
 * NOTE: sample rows must be supplied separately (the profile carries stats,
 * not raw rows). Use {@link buildWorkbookSummaryWithSamples} when you have the
 * source workbook and want 3-5 sample rows per sheet embedded.
 */
export function buildCompressedSummary(profile: WorkbookProfile): string {
	// Single sheet → clean, prefix-free format.
	if (profile.sheets.length === 1) {
		const sheet = profile.sheets[0];
		const lines = [
			`File: ${profile.fileName}`,
			`${sheet.rowCount.toLocaleString()} rows · ${sheet.columns.length} columns`,
			'Columns:',
			...sheet.columns.map(describeColumn)
		];
		return clampToCap(lines.join('\n'), SUMMARY_CHAR_CAP);
	}

	// Multi-sheet → per-sheet markdown sections with proportional budget.
	const header = [
		`File: ${profile.fileName}`,
		`Sheets: ${profile.sheets.length}`,
		''
	].join('\n');

	const remaining = Math.max(0, SUMMARY_CHAR_CAP - header.length);
	const totalRows = Math.max(1, profile.totalRows);

	const sections = profile.sheets.map((sheet) => {
		const share = sheet.rowCount / totalRows;
		const budget = Math.max(120, Math.floor(remaining * share));
		const sectionLines = [
			`## Sheet: ${sheet.name} (${sheet.rowCount.toLocaleString()} rows)`,
			'Columns:',
			...sheet.columns.map(describeColumn)
		];
		return clampToCap(sectionLines.join('\n'), budget);
	});

	return clampToCap(header + sections.join('\n\n'), SUMMARY_CHAR_CAP);
}

/**
 * Like {@link buildCompressedSummary} but embeds 3-5 sample rows per sheet,
 * pulled from the source `Workbook`. Same single/multi-sheet formatting and
 * the same 2500-char cap with proportional per-sheet budgeting.
 */
export function buildWorkbookSummaryWithSamples(wb: Workbook, profile: WorkbookProfile): string {
	const sheetByName = new Map(wb.sheets.map((s) => [s.name, s]));

	const renderSamples = (sheet: Sheet, limit: number): string => {
		const sample = pickSampleRows(sheet.rows, limit);
		if (!sample.length) return '';
		const lines = sample.map(
			(r) => '    ' + sheet.headers.map((h) => `${h}=${r[h] ?? ''}`).join(', ')
		);
		return ['Sample rows:', ...lines].join('\n');
	};

	if (profile.sheets.length === 1) {
		const sp = profile.sheets[0];
		const src = sheetByName.get(sp.name);
		const lines = [
			`File: ${profile.fileName}`,
			`${sp.rowCount.toLocaleString()} rows · ${sp.columns.length} columns`,
			'Columns:',
			...sp.columns.map(describeColumn)
		];
		if (src) {
			const s = renderSamples(src, 5);
			if (s) lines.push(s);
		}
		return clampToCap(lines.join('\n'), SUMMARY_CHAR_CAP);
	}

	const header = [
		`File: ${profile.fileName}`,
		`Sheets: ${profile.sheets.length}`,
		''
	].join('\n');

	const remaining = Math.max(0, SUMMARY_CHAR_CAP - header.length);
	const totalRows = Math.max(1, profile.totalRows);

	const sections = profile.sheets.map((sp) => {
		const share = sp.rowCount / totalRows;
		const budget = Math.max(150, Math.floor(remaining * share));
		const src = sheetByName.get(sp.name);
		const sectionLines = [
			`## Sheet: ${sp.name} (${sp.rowCount.toLocaleString()} rows)`,
			'Columns:',
			...sp.columns.map(describeColumn)
		];
		if (src) {
			const s = renderSamples(src, 3);
			if (s) sectionLines.push(s);
		}
		return clampToCap(sectionLines.join('\n'), budget);
	});

	return clampToCap(header + sections.join('\n\n'), SUMMARY_CHAR_CAP);
}

/** Evenly spaced sample of up to `limit` rows (deterministic, includes ends). */
function pickSampleRows<T>(rows: T[], limit: number): T[] {
	if (rows.length <= limit) return rows.slice();
	const out: T[] = [];
	const step = (rows.length - 1) / (limit - 1);
	for (let i = 0; i < limit; i++) {
		out.push(rows[Math.round(i * step)]);
	}
	return out;
}

/** Hard char cap that trims on a line boundary where possible. */
function clampToCap(text: string, cap: number): string {
	if (text.length <= cap) return text;
	const slice = text.slice(0, cap);
	const lastNewline = slice.lastIndexOf('\n');
	return (lastNewline > cap * 0.6 ? slice.slice(0, lastNewline) : slice).trimEnd() + '\n…';
}
