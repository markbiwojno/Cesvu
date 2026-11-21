/**
 * src/lib/report/pdf-layout.ts — pure text-wrapping / column-width helpers
 * for the report PDF writer.
 *
 * Kept separate from pdf-writer.ts (which also does the actual pdf-lib
 * drawing) so the wrapping/width math — the part most worth unit-testing in
 * isolation — doesn't require a PDFFont/pdf-lib instance to exercise.
 */

/** Minimal surface of a pdf-lib PDFFont needed for measurement. */
export interface MeasurableFont {
	widthOfTextAtSize(text: string, size: number): number;
}

/**
 * Wrap `text` into lines that each fit within `maxWidth` at `size`, using
 * word-boundary breaks. A single "word" longer than `maxWidth` is hard-split
 * at the character level (never silently overflows or gets dropped).
 * Returns at least one line (possibly empty) for empty input.
 */
export function wrapText(
	text: string,
	font: MeasurableFont,
	size: number,
	maxWidth: number
): string[] {
	if (text === '') return [''];
	const lines: string[] = [];
	for (const paragraph of text.split('\n')) {
		lines.push(...wrapParagraph(paragraph, font, size, maxWidth));
	}
	return lines;
}

function wrapParagraph(
	paragraph: string,
	font: MeasurableFont,
	size: number,
	maxWidth: number
): string[] {
	if (paragraph === '') return [''];
	const lines: string[] = [];
	let current = '';

	// Settle `current` onto `lines` + return the leftover tail when it no
	// longer fits as a single piece (used both for "line is full" and for
	// "this one word alone is wider than the line").
	const flushOverflow = (text: string): string => {
		if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
		const pieces = hardSplit(text, font, size, maxWidth);
		lines.push(...pieces.slice(0, -1));
		return pieces[pieces.length - 1] ?? '';
	};

	for (const word of paragraph.split(' ')) {
		const candidate = current === '' ? word : `${current} ${word}`;
		if (current !== '' && font.widthOfTextAtSize(candidate, size) > maxWidth) {
			// Adding `word` would overflow the current line — flush it as-is,
			// then start a new line with `word` (hard-splitting if even the
			// lone word is too wide).
			lines.push(current);
			current = flushOverflow(word);
		} else {
			current = flushOverflow(candidate);
		}
	}
	lines.push(current);
	return lines;
}

/** Hard character-level split for a single token wider than maxWidth. */
function hardSplit(word: string, font: MeasurableFont, size: number, maxWidth: number): string[] {
	const pieces: string[] = [];
	let chunk = '';
	for (const ch of word) {
		const candidate = chunk + ch;
		if (chunk !== '' && font.widthOfTextAtSize(candidate, size) > maxWidth) {
			pieces.push(chunk);
			chunk = ch;
		} else {
			chunk = candidate;
		}
	}
	pieces.push(chunk);
	return pieces;
}

export interface ColumnWidthInput {
	header: string;
	/** A sample of cell display strings — capped by the caller for perf. */
	sampleValues: string[];
}

export interface ColumnWidthOptions {
	minWidth: number;
	maxWidth: number;
	headerFont: MeasurableFont;
	headerSize: number;
	cellFont: MeasurableFont;
	cellSize: number;
	padding: number;
}

/**
 * Compute a natural (pre-shrink) width per column from header + a sample of
 * cell text, clamped to [minWidth, maxWidth]. Does NOT guarantee the total
 * fits the page — see {@link shrinkColumnsToFit} for that pass.
 */
export function computeColumnWidths(
	columns: ColumnWidthInput[],
	opts: ColumnWidthOptions
): number[] {
	return columns.map(({ header, sampleValues }) => {
		let widest = opts.headerFont.widthOfTextAtSize(header, opts.headerSize);
		for (const v of sampleValues) {
			const w = opts.cellFont.widthOfTextAtSize(v, opts.cellSize);
			if (w > widest) widest = w;
		}
		const natural = widest + opts.padding * 2;
		return Math.min(opts.maxWidth, Math.max(opts.minWidth, natural));
	});
}

/**
 * If the sum of `widths` exceeds `availableWidth`, shrink every column
 * proportionally (never below `minWidth`) so the total fits. Columns that
 * would otherwise want less than minWidth stay at minWidth; the remaining
 * budget is distributed proportionally among the rest. Returns the widths
 * unchanged if they already fit.
 */
export function shrinkColumnsToFit(
	widths: number[],
	availableWidth: number,
	minWidth: number
): number[] {
	const total = widths.reduce((a, b) => a + b, 0);
	if (total <= availableWidth || widths.length === 0) return widths;

	// Everyone starts pinned at minWidth; distribute the remaining budget
	// proportionally to each column's "want" above the floor.
	const floorTotal = minWidth * widths.length;
	const budgetAboveFloor = Math.max(0, availableWidth - floorTotal);
	const wantAboveFloor = widths.map((w) => Math.max(0, w - minWidth));
	const wantTotal = wantAboveFloor.reduce((a, b) => a + b, 0);

	if (wantTotal === 0 || floorTotal >= availableWidth) {
		// Degenerate case (too many columns even at the floor) — fall back to
		// a flat equal share rather than violating the floor silently.
		const equal = availableWidth / widths.length;
		return widths.map(() => equal);
	}

	return widths.map((w, i) => minWidth + (wantAboveFloor[i] / wantTotal) * budgetAboveFloor);
}
