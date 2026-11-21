/**
 * src/lib/report/pdf-writer.ts — renders a {@link ReportPdfInput} into real,
 * selectable-text PDF bytes using pdf-lib + a bundled Noto Sans font.
 *
 * Deliberately knows NOTHING about xlsx, SheetJS cell formats, or the
 * Summary-report grouping math — report-worker.ts does all of that and
 * hands this module plain strings to lay out. This keeps pdf-writer.ts
 * reusable for the future Batch/Data-Review report types (req. #8).
 *
 * FONT: embeds Noto Sans (Latin/Greek/Cyrillic/Vietnamese coverage; NOT
 * CJK/Arabic — see font-coverage.ts) with `subset: false` and a fixed
 * `customName`, per the "never use StandardFonts, no subset:true" decision —
 * pdf-lib does not subset by default, and `subset: true` has known silent
 * glyph-loss bugs in some versions. Any character the font can't render is
 * replaced with '?' via sanitizeForFont() rather than letting pdf-lib throw.
 *
 * DETERMINISM: PDF metadata (creation/modification dates) are pinned to a
 * fixed constant, not `new Date()`, so two runs over the same input produce
 * metadata-identical PDFs even though the visible footer timestamp (which
 * IS real, per requirement) differs run to run.
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { buildCoverageSet, sanitizeForFont } from './font-coverage.js';
import { wrapText, computeColumnWidths, shrinkColumnsToFit } from './pdf-layout.js';

// Fixed PDF metadata dates (deterministic across runs). Arbitrary fixed
// instant — NOT "now" — chosen as the app's own epoch-ish reference point.
const FIXED_METADATA_DATE = new Date('2024-01-01T00:00:00.000Z');

export const PAGE_SIZES = {
	Letter: [612, 792] as [number, number],
	A4: [595.28, 841.89] as [number, number]
};

const MARGIN = 36; // 0.5in
const TITLE_SIZE = 16;
const SECTION_SIZE = 10;
const BODY_SIZE = 9;
const FOOTER_SIZE = 7;
const LINE_GAP = 3;
const CELL_PADDING = 4;
const MIN_COL_WIDTH = 40;
const MAX_COL_WIDTH = 220;

export type ReportLine =
	| { kind: 'group-header'; label: string }
	| { kind: 'data'; cells: string[] }
	| { kind: 'subtotal'; cells: string[] }
	| { kind: 'grand-total'; cells: string[] };

/**
 * One table within the report, with its own repeating column header. The
 * Summary report ships up to two: a "Group summary" table (one row per
 * group, per req. #7) and a "Detail" table (every row) — "Summary only"
 * mode omits the second. Starts on a fresh page from the previous section.
 */
export interface ReportTableSection {
	/** Drawn as a bold heading above the table, e.g. "Group summary". */
	heading?: string;
	columns: string[];
	/** Sample display values per column, used only to size columns. */
	columnSamples: string[][];
	lines: ReportLine[];
}

export interface ReportPdfInput {
	title: string;
	fileName: string;
	generatedAtDisplay: string;
	/** Full lowercase hex SHA-256 of the ORIGINAL file bytes. */
	sha256Full: string;
	settingsLines: string[];
	kpiLines: string[];
	warnings: string[];
	pageSize: 'Letter' | 'A4';
	sections: ReportTableSection[];
}

export interface ReportPdfResult {
	bytes: Uint8Array;
	/** Count of characters the embedded font couldn't render (req. #2). */
	replacedCharacterCount: number;
	/** True if auto-landscape kicked in because columns were too wide. */
	landscape: boolean;
}

interface EmbeddedFonts {
	regular: PDFFont;
	bold: PDFFont;
	coverage: Set<number>;
}

async function embedReportFonts(
	doc: PDFDocument,
	regularBytes: ArrayBuffer | Uint8Array,
	boldBytes: ArrayBuffer | Uint8Array
): Promise<EmbeddedFonts> {
	doc.registerFontkit(fontkit);
	const regular = await doc.embedFont(regularBytes, { subset: false, customName: 'NotoSans' });
	const bold = await doc.embedFont(boldBytes, { subset: false, customName: 'NotoSans-Bold' });
	const coverage = buildCoverageSet({ characterSet: regular.getCharacterSet() });
	return { regular, bold, coverage };
}

/** Sanitize + count replacements across every string this input carries. */
function sanitizeInput(
	input: ReportPdfInput,
	coverage: Set<number>
): { input: ReportPdfInput; replacedCount: number } {
	let replacedCount = 0;
	const s = (text: string): string => {
		const r = sanitizeForFont(text, coverage);
		replacedCount += r.replacedCount;
		return r.text;
	};
	const sArr = (arr: string[]): string[] => arr.map(s);
	const sanitized: ReportPdfInput = {
		...input,
		title: s(input.title),
		fileName: s(input.fileName),
		generatedAtDisplay: s(input.generatedAtDisplay),
		settingsLines: sArr(input.settingsLines),
		kpiLines: sArr(input.kpiLines),
		warnings: sArr(input.warnings),
		sections: input.sections.map((section) => ({
			heading: section.heading !== undefined ? s(section.heading) : undefined,
			columns: sArr(section.columns),
			columnSamples: section.columnSamples.map(sArr),
			lines: section.lines.map((line) =>
				line.kind === 'group-header'
					? { kind: 'group-header' as const, label: s(line.label) }
					: { kind: line.kind, cells: sArr(line.cells) }
			)
		}))
	};
	return { input: sanitized, replacedCount };
}

/** Decide portrait vs. landscape from the natural (pre-shrink) column widths. */
function decideOrientation(
	naturalWidths: number[],
	pageSize: [number, number]
): { landscape: boolean; contentWidth: number; pageWidth: number; pageHeight: number } {
	const [pw, ph] = pageSize;
	const portraitContentWidth = pw - MARGIN * 2;
	const total = naturalWidths.reduce((a, b) => a + b, 0);
	if (total <= portraitContentWidth) {
		return { landscape: false, contentWidth: portraitContentWidth, pageWidth: pw, pageHeight: ph };
	}
	// Landscape: swap dimensions.
	const landscapeContentWidth = ph - MARGIN * 2;
	return { landscape: true, contentWidth: landscapeContentWidth, pageWidth: ph, pageHeight: pw };
}

interface RowDraw {
	cellLines: string[][]; // per column, wrapped lines
	bold: boolean;
	/** Thin top rule — used above subtotal/grand-total rows. */
	ruleAbove: boolean;
}

/** Build the per-column wrapped-line representation for one ReportLine. */
function layoutRow(
	cells: string[],
	colWidths: number[],
	font: PDFFont,
	boldFont: PDFFont,
	bold: boolean,
	ruleAbove: boolean
): RowDraw {
	const useFont = bold ? boldFont : font;
	const cellLines = cells.map((text, i) =>
		wrapText(text, useFont, BODY_SIZE, colWidths[i] - CELL_PADDING * 2)
	);
	return { cellLines, bold, ruleAbove };
}

function rowHeight(row: RowDraw): number {
	const maxLines = Math.max(1, ...row.cellLines.map((l) => l.length));
	return maxLines * (BODY_SIZE + LINE_GAP) + CELL_PADDING * 2;
}

/** A page under construction — tracks the pdf-lib page + the next free Y. */
class PageCursor {
	page: PDFPage;
	y: number;
	readonly top: number;
	readonly bottom: number;
	readonly left: number;

	constructor(page: PDFPage, pageHeight: number) {
		this.page = page;
		this.top = pageHeight - MARGIN;
		this.bottom = MARGIN + 40; // reserve space for the footer
		this.left = MARGIN;
		this.y = this.top;
	}

	hasRoom(height: number): boolean {
		return this.y - height >= this.bottom;
	}
}

function drawTextLine(
	page: PDFPage,
	text: string,
	x: number,
	y: number,
	size: number,
	font: PDFFont,
	color = rgb(0.1, 0.1, 0.1)
) {
	if (text === '') return;
	page.drawText(text, { x, y, size, font, color });
}

/**
 * Draw the repeating column-header row at `y`; returns the new y (below it).
 *
 * Headers are wrapped to their column's width (same `wrapText()` used for
 * data-row cells) instead of drawn as one unbroken line — with many narrow
 * columns (e.g. a 13-column Detail table) `shrinkColumnsToFit()` can squeeze
 * a column narrower than its own header label, and an unwrapped header then
 * overflows past the column boundary and visually runs into the next
 * header's text (the "RegistrationNBusinessName" mangling reported).
 */
function drawColumnHeader(
	page: PDFPage,
	columns: string[],
	colWidths: number[],
	left: number,
	y: number,
	boldFont: PDFFont
): number {
	const perColumnLines = columns.map((header, i) =>
		wrapText(header, boldFont, SECTION_SIZE, colWidths[i] - CELL_PADDING * 2)
	);
	const maxLines = Math.max(1, ...perColumnLines.map((lines) => lines.length));

	let x = left;
	for (let i = 0; i < columns.length; i++) {
		let ly = y - SECTION_SIZE;
		for (const line of perColumnLines[i]) {
			drawTextLine(page, line, x + CELL_PADDING, ly, SECTION_SIZE, boldFont, rgb(0, 0, 0));
			ly -= SECTION_SIZE + LINE_GAP;
		}
		x += colWidths[i];
	}
	const headerBottom = y - (SECTION_SIZE + LINE_GAP) * maxLines - 4 + LINE_GAP;
	page.drawLine({
		start: { x: left, y: headerBottom },
		end: { x: left + colWidths.reduce((a, b) => a + b, 0), y: headerBottom },
		thickness: 0.75,
		color: rgb(0.3, 0.3, 0.3)
	});
	return headerBottom - 8;
}

function drawRow(
	page: PDFPage,
	row: RowDraw,
	colWidths: number[],
	left: number,
	y: number,
	font: PDFFont,
	boldFont: PDFFont
): number {
	const h = rowHeight(row);
	if (row.ruleAbove) {
		page.drawLine({
			start: { x: left, y: y + 2 },
			end: { x: left + colWidths.reduce((a, b) => a + b, 0), y: y + 2 },
			thickness: 0.5,
			color: rgb(0.6, 0.6, 0.6)
		});
	}
	let x = left;
	const useFont = row.bold ? boldFont : font;
	for (let i = 0; i < row.cellLines.length; i++) {
		let ly = y - CELL_PADDING - BODY_SIZE;
		for (const line of row.cellLines[i]) {
			drawTextLine(page, line, x + CELL_PADDING, ly, BODY_SIZE, useFont);
			ly -= BODY_SIZE + LINE_GAP;
		}
		x += colWidths[i] ?? 0;
	}
	return y - h;
}

/** Number of lines drawn between progress reports / yield points. */
const DRAW_YIELD_INTERVAL = 500;

/** Yield to the event loop so queued postMessage calls actually flush. */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Render a complete report PDF.
 *
 * On a large sheet (tens of thousands of rows) the row-drawing loop below is
 * the dominant cost — ~8-10s for 50K rows in testing — and is otherwise a
 * single uninterrupted synchronous loop. When running inside a Worker that
 * still blocks the worker's own message queue, so without a yield point no
 * `progress` postMessage can flush until the WHOLE loop finishes, making a
 * long build look frozen even off the main thread. `onProgress` is called
 * and the loop yields via `yieldToEventLoop()` every DRAW_YIELD_INTERVAL
 * lines so report-worker.ts can report real progress as it happens.
 */
export async function buildReportPdf(
	rawInput: ReportPdfInput,
	fontBytes: { regular: ArrayBuffer | Uint8Array; bold: ArrayBuffer | Uint8Array },
	onProgress?: (drawn: number, total: number) => void
): Promise<ReportPdfResult> {
	const doc = await PDFDocument.create();
	const { regular, bold, coverage } = await embedReportFonts(doc, fontBytes.regular, fontBytes.bold);
	const { input, replacedCount } = sanitizeInput(rawInput, coverage);

	doc.setTitle(input.title);
	doc.setAuthor('Cesvu');
	doc.setCreator('Cesvu');
	doc.setProducer('Cesvu Report Generator');
	doc.setCreationDate(FIXED_METADATA_DATE);
	doc.setModificationDate(FIXED_METADATA_DATE);

	const measureOpts = {
		minWidth: MIN_COL_WIDTH,
		maxWidth: MAX_COL_WIDTH,
		headerFont: bold,
		headerSize: SECTION_SIZE,
		cellFont: regular,
		cellSize: BODY_SIZE,
		padding: CELL_PADDING
	};
	// Each section gets its OWN column widths (different sections can have
	// entirely different column sets — e.g. the group-summary table vs. the
	// detail table). Orientation is decided from the WIDEST section so the
	// whole document uses one consistent page size.
	const perSectionNaturalWidths = input.sections.map((section) =>
		computeColumnWidths(
			section.columns.map((header, i) => ({ header, sampleValues: section.columnSamples[i] ?? [] })),
			measureOpts
		)
	);
	const widestSectionTotal = Math.max(
		0,
		...perSectionNaturalWidths.map((w) => w.reduce((a, b) => a + b, 0))
	);
	const basePageSize = PAGE_SIZES[input.pageSize];
	const { landscape, contentWidth, pageWidth, pageHeight } = decideOrientation(
		[widestSectionTotal],
		basePageSize
	);
	const perSectionColWidths = perSectionNaturalWidths.map((widths) =>
		shrinkColumnsToFit(widths, contentWidth, MIN_COL_WIDTH)
	);

	const pages: PageCursor[] = [];
	const newPage = (): PageCursor => {
		const p = doc.addPage([pageWidth, pageHeight]);
		const cursor = new PageCursor(p, pageHeight);
		pages.push(cursor);
		return cursor;
	};

	let cursor = newPage();

	// ── Page 1: title + compact settings block + KPI header + warnings ──────
	drawTextLine(cursor.page, input.title, cursor.left, cursor.y - TITLE_SIZE, TITLE_SIZE, bold, rgb(0, 0, 0));
	cursor.y -= TITLE_SIZE + 14;

	const drawParagraphBlock = (heading: string, lines: string[], size = BODY_SIZE) => {
		if (lines.length === 0) return;
		drawTextLine(cursor.page, heading, cursor.left, cursor.y - SECTION_SIZE, SECTION_SIZE, bold);
		cursor.y -= SECTION_SIZE + 4;
		for (const line of lines) {
			for (const wrapped of wrapText(line, regular, size, contentWidth)) {
				drawTextLine(cursor.page, wrapped, cursor.left, cursor.y - size, size, regular);
				cursor.y -= size + LINE_GAP;
			}
		}
		cursor.y -= 8;
	};

	drawParagraphBlock('Settings', input.settingsLines);
	drawParagraphBlock('Summary', input.kpiLines);
	if (input.warnings.length > 0) {
		drawParagraphBlock('Warnings', input.warnings.map((w) => `⚠ ${w}`));
	}

	// ── One or more table sections (e.g. "Group summary" then "Detail") ────
	// Each section starts on a FRESH page (except the very first, which
	// continues straight on from the settings/KPI block above) and owns its
	// own column set + repeating header.
	const totalLines = input.sections.reduce((sum, s) => sum + s.lines.length, 0);
	let linesDrawn = 0;

	for (let sectionIdx = 0; sectionIdx < input.sections.length; sectionIdx++) {
		const section = input.sections[sectionIdx];
		const colWidths = perSectionColWidths[sectionIdx];
		if (sectionIdx > 0) {
			cursor = newPage();
		}
		if (section.heading) {
			drawTextLine(cursor.page, section.heading, cursor.left, cursor.y - SECTION_SIZE, SECTION_SIZE, bold);
			cursor.y -= SECTION_SIZE + 10;
		}
		cursor.y = drawColumnHeader(cursor.page, section.columns, colWidths, cursor.left, cursor.y, bold);

		for (const line of section.lines) {
			const bold_ = line.kind === 'grand-total' || line.kind === 'subtotal';
			const ruleAbove = bold_;
			const cells = line.kind === 'group-header' ? [line.label] : line.cells;
			const widths = line.kind === 'group-header' ? [contentWidth] : colWidths;
			const row = layoutRow(cells, widths, regular, bold, bold_ || line.kind === 'group-header', ruleAbove);
			const h = rowHeight(row);

			if (!cursor.hasRoom(h)) {
				cursor = newPage();
				cursor.y = drawColumnHeader(cursor.page, section.columns, colWidths, cursor.left, cursor.y, bold);
			}
			cursor.y = drawRow(cursor.page, row, widths, cursor.left, cursor.y, regular, bold);

			linesDrawn++;
			// Every DRAW_YIELD_INTERVAL lines: report progress AND actually
			// yield to the event loop (not just call a callback) — a
			// Worker's message queue only flushes between synchronous turns,
			// so without the `await` below, every progress message queued by
			// a long draw loop would still arrive in one burst at the end.
			if (linesDrawn % DRAW_YIELD_INTERVAL === 0) {
				onProgress?.(linesDrawn, totalLines);
				await yieldToEventLoop();
			}
		}
	}
	onProgress?.(linesDrawn, totalLines);

	// ── Footer + "Page X of Y" on every page ─────────────────────────────
	const shortHash = input.sha256Full.slice(0, 12);
	const total = pages.length;
	pages.forEach((p, idx) => {
		const footerY = MARGIN;
		drawTextLine(
			p.page,
			`${input.fileName} · SHA-256 ${shortHash} · Generated ${input.generatedAtDisplay}`,
			MARGIN,
			footerY + 12,
			FOOTER_SIZE,
			regular,
			rgb(0.4, 0.4, 0.4)
		);
		const pageLabel = `Page ${idx + 1} of ${total}`;
		const labelWidth = regular.widthOfTextAtSize(pageLabel, FOOTER_SIZE);
		drawTextLine(
			p.page,
			pageLabel,
			p.page.getWidth() - MARGIN - labelWidth,
			footerY + 12,
			FOOTER_SIZE,
			regular,
			rgb(0.4, 0.4, 0.4)
		);
	});

	const bytes = await doc.save();
	return { bytes, replacedCharacterCount: replacedCount, landscape };
}

// ============================================================
// "Column Visual Analysis" report — a compact image grid, 3 charts/page
// ============================================================

/** One column's ready-to-draw entry for the visual-analysis report. */
export interface ColumnVisualInput {
	column: string;
	title: string;
	/** PNG bytes from column-chart-renderer.ts, or null if nothing was plottable. */
	chartPng: Uint8Array | null;
	/** Native pixel dimensions of chartPng (ignored when chartPng is null). */
	chartWidth: number;
	chartHeight: number;
	statSummary: string;
}

export interface ColumnVisualPdfInput {
	title: string;
	fileName: string;
	generatedAtDisplay: string;
	sha256Full: string;
	pageSize: 'Letter' | 'A4';
	columns: ColumnVisualInput[];
}

/** Charts packed per page — "most compact design possible" per requirement. */
const CHARTS_PER_PAGE = 3;

/**
 * Render the "Column Visual Analysis" report: a title, then every
 * configured column's chart image + one-line stat summary, packed 3-per-page
 * in a single-column stack (the most compact layout that still keeps each
 * chart legibly sized on a Letter/A4 page). Page 1 reserves room for the
 * report title above its 3 bands; later pages use the full content height.
 */
export async function buildColumnVisualPdf(
	rawInput: ColumnVisualPdfInput,
	fontBytes: { regular: ArrayBuffer | Uint8Array; bold: ArrayBuffer | Uint8Array },
	onProgress?: (drawn: number, total: number) => void
): Promise<ReportPdfResult> {
	const doc = await PDFDocument.create();
	const { regular, bold, coverage } = await embedReportFonts(doc, fontBytes.regular, fontBytes.bold);
	const { input, replacedCount } = sanitizeVisualInput(rawInput, coverage);

	doc.setTitle(input.title);
	doc.setAuthor('Cesvu');
	doc.setCreator('Cesvu');
	doc.setProducer('Cesvu Report Generator');
	doc.setCreationDate(FIXED_METADATA_DATE);
	doc.setModificationDate(FIXED_METADATA_DATE);

	const [pageWidth, pageHeight] = PAGE_SIZES[input.pageSize];
	const contentWidth = pageWidth - MARGIN * 2;

	const pages: PageCursor[] = [];
	const newPage = (): PageCursor => {
		const p = doc.addPage([pageWidth, pageHeight]);
		const cursor = new PageCursor(p, pageHeight);
		pages.push(cursor);
		return cursor;
	};

	let cursor = newPage();
	drawTextLine(cursor.page, input.title, cursor.left, cursor.y - TITLE_SIZE, TITLE_SIZE, bold, rgb(0, 0, 0));
	cursor.y -= TITLE_SIZE + 14;

	const embeddedImages = await Promise.all(
		input.columns.map((c) => (c.chartPng ? doc.embedPng(c.chartPng) : null))
	);

	const bandGap = 10;
	const headerSize = 10;
	const headerBlock = headerSize + 11 + 6; // title line + stat line + gap before chart

	let drawnOnPage = 0;
	let pageBandCount = Math.min(CHARTS_PER_PAGE, input.columns.length);
	let pageUsableHeight = cursor.y - cursor.bottom;
	let bandHeight = (pageUsableHeight - bandGap * (pageBandCount - 1)) / pageBandCount;

	for (let i = 0; i < input.columns.length; i++) {
		const col = input.columns[i];
		const img = embeddedImages[i];

		if (drawnOnPage === CHARTS_PER_PAGE) {
			cursor = newPage();
			drawnOnPage = 0;
			pageBandCount = Math.min(CHARTS_PER_PAGE, input.columns.length - i);
			pageUsableHeight = cursor.y - cursor.bottom;
			bandHeight = (pageUsableHeight - bandGap * (pageBandCount - 1)) / pageBandCount;
		}

		drawTextLine(cursor.page, col.title, cursor.left, cursor.y - headerSize, headerSize, bold, rgb(0, 0, 0));
		const statY = cursor.y - headerSize - 11;
		drawTextLine(cursor.page, col.statSummary, cursor.left, statY, FOOTER_SIZE + 1, regular, rgb(0.35, 0.35, 0.35));

		const chartTop = statY - 6;
		const chartMaxHeight = bandHeight - headerBlock;
		if (img) {
			const scale = Math.min(contentWidth / col.chartWidth, chartMaxHeight / col.chartHeight);
			const w = col.chartWidth * scale;
			const h = col.chartHeight * scale;
			cursor.page.drawImage(img, {
				x: cursor.left + (contentWidth - w) / 2,
				y: chartTop - h,
				width: w,
				height: h
			});
		} else {
			drawTextLine(
				cursor.page,
				'No chart available for this column.',
				cursor.left,
				chartTop - chartMaxHeight / 2,
				BODY_SIZE,
				regular,
				rgb(0.5, 0.5, 0.5)
			);
		}

		cursor.y -= bandHeight + bandGap;
		drawnOnPage++;
		onProgress?.(i + 1, input.columns.length);
	}

	const shortHash = input.sha256Full.slice(0, 12);
	const total = pages.length;
	pages.forEach((p, idx) => {
		const footerY = MARGIN;
		drawTextLine(
			p.page,
			`${input.fileName} · SHA-256 ${shortHash} · Generated ${input.generatedAtDisplay}`,
			MARGIN,
			footerY + 12,
			FOOTER_SIZE,
			regular,
			rgb(0.4, 0.4, 0.4)
		);
		const pageLabel = `Page ${idx + 1} of ${total}`;
		const labelWidth = regular.widthOfTextAtSize(pageLabel, FOOTER_SIZE);
		drawTextLine(
			p.page,
			pageLabel,
			p.page.getWidth() - MARGIN - labelWidth,
			footerY + 12,
			FOOTER_SIZE,
			regular,
			rgb(0.4, 0.4, 0.4)
		);
	});

	const bytes = await doc.save();
	return { bytes, replacedCharacterCount: replacedCount, landscape: false };
}

/** Sanitize every string this input carries (title/stat summaries/etc.). */
function sanitizeVisualInput(
	input: ColumnVisualPdfInput,
	coverage: Set<number>
): { input: ColumnVisualPdfInput; replacedCount: number } {
	let replacedCount = 0;
	const s = (text: string): string => {
		const r = sanitizeForFont(text, coverage);
		replacedCount += r.replacedCount;
		return r.text;
	};
	return {
		input: {
			...input,
			title: s(input.title),
			fileName: s(input.fileName),
			generatedAtDisplay: s(input.generatedAtDisplay),
			columns: input.columns.map((c) => ({ ...c, title: s(c.title), statSummary: s(c.statSummary) }))
		},
		replacedCount
	};
}
