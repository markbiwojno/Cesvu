import { describe, it, expect } from 'vitest';
import {
	findDuplicateGroups,
	buildDuplicationSection,
	type DuplicationMatchOptions
} from './duplication-report.js';
import type { ParsedRow } from './summary-report.js';

const DEFAULT_OPTS: DuplicationMatchOptions = { caseInsensitive: true, trimWhitespace: true };

function cell(display: string) {
	return { numeric: null, display, isBlank: display.trim() === '', isError: false };
}

function row(values: Record<string, string>): ParsedRow {
	const r: ParsedRow = {};
	for (const [k, v] of Object.entries(values)) r[k] = cell(v);
	return r;
}

describe('findDuplicateGroups', () => {
	it('groups exact-match rows on a single key column and excludes singletons', () => {
		const rows = [
			row({ Name: 'Alice' }),
			row({ Name: 'Bob' }),
			row({ Name: 'Alice' })
		];
		const groups = findDuplicateGroups(rows, ['Name'], DEFAULT_OPTS);
		expect(groups).toHaveLength(1);
		expect(groups[0].rowCount).toBe(2);
		expect(groups[0].rowNumbers).toEqual([1, 3]);
		expect(groups[0].keyValues).toEqual({ Name: 'Alice' });
	});

	it('treats case differences as equal when caseInsensitive is true', () => {
		const rows = [row({ Name: 'Alice' }), row({ Name: 'ALICE' })];
		const groups = findDuplicateGroups(rows, ['Name'], { caseInsensitive: true, trimWhitespace: true });
		expect(groups).toHaveLength(1);
	});

	it('treats case differences as distinct when caseInsensitive is false', () => {
		const rows = [row({ Name: 'Alice' }), row({ Name: 'ALICE' })];
		const groups = findDuplicateGroups(rows, ['Name'], { caseInsensitive: false, trimWhitespace: true });
		expect(groups).toHaveLength(0);
	});

	it('collapses internal/leading/trailing whitespace when trimWhitespace is true', () => {
		const rows = [row({ Name: 'John  Smith' }), row({ Name: ' John Smith ' })];
		const groups = findDuplicateGroups(rows, ['Name'], { caseInsensitive: false, trimWhitespace: true });
		expect(groups).toHaveLength(1);
	});

	it('treats whitespace differences as distinct when trimWhitespace is false', () => {
		const rows = [row({ Name: 'John  Smith' }), row({ Name: 'John Smith' })];
		const groups = findDuplicateGroups(rows, ['Name'], { caseInsensitive: false, trimWhitespace: false });
		expect(groups).toHaveLength(0);
	});

	it('requires ALL key columns to match for a composite key', () => {
		const rows = [
			row({ Name: 'Alice', DOB: '1990-01-01' }),
			row({ Name: 'Alice', DOB: '1991-01-01' }), // same name, different DOB
			row({ Name: 'Alice', DOB: '1990-01-01' }) // matches the first
		];
		const groups = findDuplicateGroups(rows, ['Name', 'DOB'], DEFAULT_OPTS);
		expect(groups).toHaveLength(1);
		expect(groups[0].rowCount).toBe(2);
		expect(groups[0].rowNumbers).toEqual([1, 3]);
	});

	it('sorts groups by cluster size descending (largest first)', () => {
		const rows = [
			row({ Name: 'A' }), row({ Name: 'A' }), // cluster of 2
			row({ Name: 'B' }), row({ Name: 'B' }), row({ Name: 'B' }) // cluster of 3
		];
		const groups = findDuplicateGroups(rows, ['Name'], DEFAULT_OPTS);
		expect(groups.map((g) => g.rowCount)).toEqual([3, 2]);
	});

	it('returns an empty array when no key columns are selected', () => {
		const rows = [row({ Name: 'Alice' }), row({ Name: 'Alice' })];
		expect(findDuplicateGroups(rows, [], DEFAULT_OPTS)).toEqual([]);
	});

	it('returns an empty array for an empty row set', () => {
		expect(findDuplicateGroups([], ['Name'], DEFAULT_OPTS)).toEqual([]);
	});

	it('treats a missing/blank key column value as its own group (blank matches blank)', () => {
		const rows = [row({ Name: '' }), row({ Name: '' }), row({ Name: 'Alice' })];
		const groups = findDuplicateGroups(rows, ['Name'], DEFAULT_OPTS);
		expect(groups).toHaveLength(1);
		expect(groups[0].rowCount).toBe(2);
	});
});

describe('buildDuplicationSection', () => {
	const groups = findDuplicateGroups(
		[
			row({ Name: 'Alice', City: 'NYC' }),
			row({ Name: 'Bob', City: 'LA' }),
			row({ Name: 'Alice', City: 'NYC' })
		],
		['Name'],
		DEFAULT_OPTS
	);

	it('compact mode: one data line per group with key values, row count, and row numbers', () => {
		const section = buildDuplicationSection(groups, ['Name'], ['Name', 'City'], 'compact');
		expect(section.heading).toBe('Duplicate groups');
		expect(section.columns).toEqual(['Name', 'Row count', 'Row numbers']);
		expect(section.lines).toEqual([
			{ kind: 'data', cells: ['Alice', '2', '1, 3'] }
		]);
	});

	it('full mode: one group-header + one data line per member row, across all headers', () => {
		const section = buildDuplicationSection(groups, ['Name'], ['Name', 'City'], 'full');
		expect(section.heading).toBe('Duplicate groups (full detail)');
		expect(section.columns).toEqual(['Name', 'City']);
		expect(section.lines).toEqual([
			{ kind: 'group-header', label: 'Name: Alice (2 rows)' },
			{ kind: 'data', cells: ['Alice', 'NYC'] },
			{ kind: 'data', cells: ['Alice', 'NYC'] }
		]);
	});

	it('compact mode shows "(blank)" for an empty key column value', () => {
		const blankGroups = findDuplicateGroups(
			[row({ Name: '' }), row({ Name: '' })],
			['Name'],
			DEFAULT_OPTS
		);
		const section = buildDuplicationSection(blankGroups, ['Name'], ['Name'], 'compact');
		expect(section.lines[0]).toEqual({ kind: 'data', cells: ['(blank)', '2', '1, 2'] });
	});

	it('compact mode lists every row number verbatim at exactly the 50-entry cap', () => {
		const rows = Array.from({ length: 50 }, () => row({ Name: 'Dup' }));
		const bigGroups = findDuplicateGroups(rows, ['Name'], DEFAULT_OPTS);
		const section = buildDuplicationSection(bigGroups, ['Name'], ['Name'], 'compact');
		const expected = Array.from({ length: 50 }, (_, i) => i + 1).join(', ');
		expect(section.lines[0]).toEqual({ kind: 'data', cells: ['Dup', '50', expected] });
	});

	it('compact mode truncates the row-numbers list past 50 entries with an "and N more" suffix', () => {
		const rows = Array.from({ length: 2279 }, () => row({ Name: 'Dup' }));
		const bigGroups = findDuplicateGroups(rows, ['Name'], DEFAULT_OPTS);
		const section = buildDuplicationSection(bigGroups, ['Name'], ['Name'], 'compact');
		const first50 = Array.from({ length: 50 }, (_, i) => i + 1).join(', ');
		expect(section.lines[0]).toEqual({
			kind: 'data',
			cells: ['Dup', '2279', `${first50}, … and 2229 more`]
		});
	});
});
