/**
 * src/lib/pipeline/valueMatch.ts — shared cell ⇄ query-value matching
 *
 * One source of truth for "does this cell value match what the user typed?"
 * Used by the CSV filter path (DocumentPane), the Excel filter path
 * (SpreadsheetViewer), and the chat match-count in analysis.ts so all three
 * agree exactly.
 *
 * The tricky case this solves: Excel date columns. SheetJS gives us the
 * *formatted* cell text (e.g. "1/5/2026"), but users frequently type the raw
 * Excel **date serial** (e.g. 46133) that they saw in the underlying data — or
 * vice-versa. A naive string compare ("1/5/2026" === "46133") never matches.
 * matchesValue() bridges the two representations: when the query value is an
 * Excel-range serial and the cell parses as a date (or the reverse), it
 * compares them on the same calendar day.
 */

// Excel's epoch is 1899-12-30 (the well-known 1900 leap-year bug offset).
// Serials in the ~20000–60000 range cover roughly 1954–2064 — the plausible
// window for "this integer is actually a date", not just a quantity.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;
const SERIAL_MIN = 20_000; // ~1954-09
const SERIAL_MAX = 60_000; // ~2064-03

/** Convert an Excel date serial to a Date (UTC midnight of that day). */
export function excelSerialToDate(serial: number): Date {
	return new Date(EXCEL_EPOCH_MS + serial * MS_PER_DAY);
}

/** True when n looks like an Excel date serial rather than a plain quantity. */
function looksLikeSerial(n: number): boolean {
	return Number.isFinite(n) && n >= SERIAL_MIN && n <= SERIAL_MAX && Number.isInteger(n);
}

/** Parse a cell value as a Date. Handles ISO, MM/DD/YYYY, and MM-DD-YYYY. */
export function parseCellDate(v: unknown): Date | null {
	if (v === null || v === undefined) return null;
	const s = String(v).trim();
	if (!s) return null;
	// Pure number → could be an Excel serial; let the caller decide. Not a date here.
	const d = new Date(s);
	if (!isNaN(d.getTime()) && /[\/\-:]/.test(s)) return d;
	const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
	if (m) {
		const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
		const d2 = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
		if (!isNaN(d2.getTime())) return d2;
	}
	// Fall back to a permissive parse (e.g. "January 5 2026")
	if (!isNaN(d.getTime())) return d;
	return null;
}

function sameDay(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

export type MatchOp = 'eq' | 'contains';

/**
 * Does `cell` match the user's `query` value under operator `op`?
 *
 * - 'contains' (default for free-text filters): case-insensitive substring.
 * - 'eq': exact (case-insensitive) string equality, numeric equality, OR
 *   Excel serial ⇄ date-string equivalence on the same calendar day.
 *
 * The date bridge runs for BOTH ops so that filtering a date column by a raw
 * serial (or a typed date) lights up the matching rows regardless of which
 * representation the cell holds.
 */
export function matchesValue(cell: unknown, query: string, op: MatchOp = 'contains'): boolean {
	if (cell === null || cell === undefined) return false;
	const cellStr = String(cell);
	// Coerce defensively: callers pass `string` per the type, but at runtime a
	// numeric leaf value can flow in. `.trim()` on a number throws
	// "query.trim is not a function" — String() makes it total.
	const q = String(query).trim();
	if (!q) return false;

	// 1. Plain string comparison.
	if (op === 'eq') {
		if (cellStr.toLowerCase() === q.toLowerCase()) return true;
	} else {
		if (cellStr.toLowerCase().includes(q.toLowerCase())) return true;
	}

	// 2. Numeric equality (handles "46133" === 46133.0, "$1,200" === "1200").
	const qNum = Number(q.replace(/[$,%\s]/g, ''));
	const cellNum = Number(cellStr.replace(/[$,%\s]/g, ''));
	if (Number.isFinite(qNum) && Number.isFinite(cellNum) && qNum === cellNum) return true;

	// 3. Excel date-serial ⇄ date-string equivalence (same calendar day).
	//    a) query is a serial, cell is a date string
	if (looksLikeSerial(qNum)) {
		const cellDate = parseCellDate(cellStr);
		if (cellDate && sameDay(cellDate, excelSerialToDate(qNum))) return true;
	}
	//    b) query is a date string, cell is a serial
	if (looksLikeSerial(cellNum)) {
		const qDate = parseCellDate(q);
		if (qDate && sameDay(qDate, excelSerialToDate(cellNum))) return true;
	}
	//    c) both are date strings in different formats
	if (op === 'eq') {
		const qDate = parseCellDate(q);
		const cellDate = parseCellDate(cellStr);
		if (qDate && cellDate && sameDay(qDate, cellDate)) return true;
	}

	return false;
}
