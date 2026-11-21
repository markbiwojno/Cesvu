/**
 * src/lib/report/duplication-report.ts — pure duplicate-row detection math
 * for the "Data Duplication Report" Generate Report option.
 *
 * Deliberately format/source-agnostic, same pattern as summary-report.ts:
 * operates on the neutral {@link ParsedRow} shape (built by report-cells.ts's
 * adaptExcelCell/adaptCsvCell), so it's unit-testable without pulling in the
 * `xlsx` package or a Worker, and report-worker.ts can feed it the exact same
 * re-parsed rows it already builds for the Summary Report.
 *
 * Match semantics: rows are duplicates of each other when ALL selected key
 * columns are equal after normalization (case/whitespace, per options). This
 * is a composite-key exact/normalized match — NOT fuzzy/edit-distance
 * matching (reserved for a future iteration).
 */

import type { ParsedRow } from './summary-report.js';
import type { ReportTableSection, ReportLine } from './pdf-writer.js';

export interface DuplicationMatchOptions {
	/** Default true — "John" and "JOHN" are treated as equal. */
	caseInsensitive: boolean;
	/** Default true — "John  Smith" and "John Smith" are treated as equal
	 *  (collapses runs of internal whitespace, trims leading/trailing). */
	trimWhitespace: boolean;
}

export interface DuplicateGroup {
	/** The normalized composite key (internal — not shown to the user). */
	key: string;
	/** Display value of each key column for this group (first occurrence's raw display text). */
	keyValues: Record<string, string>;
	rowCount: number;
	/** 1-based row numbers of every row in this group, in original order. */
	rowNumbers: number[];
	rows: ParsedRow[];
}

/** Collapse whitespace/case per options — the normalization used to build
 *  the composite match key. Does NOT affect `display` (what's shown). */
function normalize(value: string, options: DuplicationMatchOptions): string {
	let v = value;
	if (options.trimWhitespace) v = v.trim().replace(/\s+/g, ' ');
	if (options.caseInsensitive) v = v.toLowerCase();
	return v;
}

/**
 * Group rows by a composite key over `keyColumns`, keeping only groups with
 * 2+ members (actual duplicates), sorted by cluster size descending (the
 * biggest/most-actionable duplicate clusters first).
 */
export function findDuplicateGroups(
	rows: ParsedRow[],
	keyColumns: string[],
	options: DuplicationMatchOptions
): DuplicateGroup[] {
	if (keyColumns.length === 0) return [];

	const byKey = new Map<string, { rows: ParsedRow[]; rowNumbers: number[] }>();
	rows.forEach((row, i) => {
		const key = keyColumns
			.map((col) => normalize(row[col]?.display ?? '', options))
			.join('\u0001'); // unit-separator-ish join, unlikely to collide with real data
		const bucket = byKey.get(key);
		if (bucket) {
			bucket.rows.push(row);
			bucket.rowNumbers.push(i + 1);
		} else {
			byKey.set(key, { rows: [row], rowNumbers: [i + 1] });
		}
	});

	const groups: DuplicateGroup[] = [];
	for (const [key, { rows: groupRows, rowNumbers }] of byKey) {
		if (groupRows.length < 2) continue;
		const keyValues: Record<string, string> = {};
		for (const col of keyColumns) keyValues[col] = groupRows[0][col]?.display ?? '';
		groups.push({ key, keyValues, rowCount: groupRows.length, rowNumbers, rows: groupRows });
	}

	groups.sort((a, b) => b.rowCount - a.rowCount);
	return groups;
}

export type DuplicationDetail = 'compact' | 'full';

/**
 * Build the single table section pdf-writer.ts draws. Mirrors
 * report-pdf-input.ts's buildGroupSummarySection()/buildDetailSection()
 * split:
 *
 *   'compact' (default): one row per duplicate group — key column values,
 *   row count, and the list of row numbers. No other column data shown.
 *
 *   'full': one group-header per cluster + one data line per member row,
 *   with every column from the sheet (mirrors the Summary Report's
 *   "Summary + detail" mode) — for when the user wants to actually inspect
 *   the duplicated rows' full content, not just know where they are.
 */
export function buildDuplicationSection(
	groups: DuplicateGroup[],
	keyColumns: string[],
	allHeaders: string[],
	detail: DuplicationDetail
): ReportTableSection {
	if (detail === 'compact') {
		const columns = [...keyColumns, 'Row count', 'Row numbers'];
		const lines: ReportLine[] = groups.map((g) => ({
			kind: 'data',
			cells: [
				...keyColumns.map((c) => g.keyValues[c] || '(blank)'),
				String(g.rowCount),
				g.rowNumbers.join(', ')
			]
		}));
		const columnSamples = columns.map((_, i) =>
			lines.slice(0, 20).map((l) => (l.kind === 'group-header' ? l.label : (l.cells[i] ?? '')))
		);
		return { heading: 'Duplicate groups', columns, columnSamples, lines };
	}

	// 'full' — group-header + every member row's full cell content.
	const lines: ReportLine[] = [];
	for (const g of groups) {
		const label = keyColumns.map((c) => `${c}: ${g.keyValues[c] || '(blank)'}`).join(' · ');
		lines.push({ kind: 'group-header', label: `${label} (${g.rowCount} rows)` });
		for (const row of g.rows) {
			lines.push({ kind: 'data', cells: allHeaders.map((h) => row[h]?.display ?? '') });
		}
	}
	const sampleRows = groups.flatMap((g) => g.rows).slice(0, 50);
	const columnSamples = allHeaders.map((h) => sampleRows.map((r) => r[h]?.display ?? ''));
	return { heading: 'Duplicate groups (full detail)', columns: allHeaders, columnSamples, lines };
}
