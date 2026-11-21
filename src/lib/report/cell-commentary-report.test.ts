import { describe, it, expect } from 'vitest';
import {
	buildCellCommentaryRows,
	sheetsWithCellNotes,
	formatCellContent,
	formatRowNumber,
	buildCellCommentarySection,
	type CellCommentaryRow
} from './cell-commentary-report.js';
import type { Note } from '$lib/stores/notesStore.svelte.js';
import type { Sheet } from '$lib/data/workbook.js';

function cellNote(overrides: Partial<Note> = {}): Note {
	return {
		id: 'note-1',
		anchor: { kind: 'cell', sheet: 'Sheet1', column: 'Name', rowIndex: 0 },
		author: 'You',
		body: 'Looks off',
		createdAt: 1000,
		...overrides
	};
}

function proseNote(overrides: Partial<Note> = {}): Note {
	return {
		id: 'note-prose',
		anchor: { kind: 'prose', offset: 42 },
		author: 'You',
		body: 'A prose note',
		createdAt: 500,
		...overrides
	};
}

const sheet: Sheet = {
	name: 'Sheet1',
	headers: ['Name', 'Amount'],
	rows: [
		{ Name: 'Alice', Amount: '100' },
		{ Name: 'Bob', Amount: '200' }
	],
	rowCount: 2
};

describe('buildCellCommentaryRows', () => {
	it('resolves cell content and 1-based row number for a row-anchored note', () => {
		const notes = [cellNote({ anchor: { kind: 'cell', sheet: 'Sheet1', column: 'Name', rowIndex: 0 } })];
		const rows = buildCellCommentaryRows(notes, [sheet], null);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			sheet: 'Sheet1',
			column: 'Name',
			rowIndex: 0,
			rowNumber: 1,
			cellContent: 'Alice',
			noteBody: 'Looks off'
		});
	});

	it('includes column-level notes (rowIndex -1) with null row/cell content', () => {
		const notes = [cellNote({ anchor: { kind: 'cell', sheet: 'Sheet1', column: 'Amount', rowIndex: -1 } })];
		const rows = buildCellCommentaryRows(notes, [sheet], null);
		expect(rows).toHaveLength(1);
		expect(rows[0].rowNumber).toBeNull();
		expect(rows[0].cellContent).toBeNull();
	});

	it('excludes prose notes entirely', () => {
		const notes = [proseNote(), cellNote()];
		const rows = buildCellCommentaryRows(notes, [sheet], null);
		expect(rows).toHaveLength(1);
	});

	it('filters to a single sheet when sheetFilter is set', () => {
		const notes = [
			cellNote({ id: 'a', anchor: { kind: 'cell', sheet: 'Sheet1', column: 'Name', rowIndex: 0 } }),
			cellNote({ id: 'b', anchor: { kind: 'cell', sheet: 'Sheet2', column: 'X', rowIndex: 0 } })
		];
		const rows = buildCellCommentaryRows(notes, [sheet], 'Sheet1');
		expect(rows).toHaveLength(1);
		expect(rows[0].sheet).toBe('Sheet1');
	});

	it('sorts newest first regardless of input order', () => {
		const notes = [
			cellNote({ id: 'old', createdAt: 100, body: 'old note' }),
			cellNote({ id: 'new', createdAt: 999, body: 'new note' }),
			cellNote({ id: 'mid', createdAt: 500, body: 'mid note' })
		];
		const rows = buildCellCommentaryRows(notes, [sheet], null);
		expect(rows.map((r) => r.noteBody)).toEqual(['new note', 'mid note', 'old note']);
	});

	it('handles an unresolvable sheet/row gracefully (null cell content)', () => {
		const notes = [cellNote({ anchor: { kind: 'cell', sheet: 'Missing', column: 'X', rowIndex: 5 } })];
		const rows = buildCellCommentaryRows(notes, [sheet], null);
		expect(rows[0].cellContent).toBeNull();
	});
});

describe('sheetsWithCellNotes', () => {
	it('returns distinct sheet names from cell-anchored notes only', () => {
		const notes = [
			cellNote({ anchor: { kind: 'cell', sheet: 'Sheet1', column: 'A', rowIndex: 0 } }),
			cellNote({ anchor: { kind: 'cell', sheet: 'Sheet2', column: 'B', rowIndex: 0 } }),
			cellNote({ anchor: { kind: 'cell', sheet: 'Sheet1', column: 'C', rowIndex: 1 } }),
			proseNote()
		];
		expect(sheetsWithCellNotes(notes)).toEqual(['Sheet1', 'Sheet2']);
	});
});

describe('formatCellContent / formatRowNumber', () => {
	it('formats a row-anchored note normally', () => {
		const row: CellCommentaryRow = {
			sheet: 'S', column: 'C', rowIndex: 0, rowNumber: 1,
			cellContent: 'Alice', noteBody: 'x', author: 'You', createdAt: 0
		};
		expect(formatCellContent(row)).toBe('Alice');
		expect(formatRowNumber(row)).toBe('1');
	});

	it('formats a column-level note as "(whole column)" / "—"', () => {
		const row: CellCommentaryRow = {
			sheet: 'S', column: 'C', rowIndex: -1, rowNumber: null,
			cellContent: null, noteBody: 'x', author: 'You', createdAt: 0
		};
		expect(formatCellContent(row)).toBe('(whole column)');
		expect(formatRowNumber(row)).toBe('—');
	});

	it('formats an empty/blank cell value as "(blank)"', () => {
		const row: CellCommentaryRow = {
			sheet: 'S', column: 'C', rowIndex: 0, rowNumber: 1,
			cellContent: '', noteBody: 'x', author: 'You', createdAt: 0
		};
		expect(formatCellContent(row)).toBe('(blank)');
	});
});

describe('buildCellCommentarySection', () => {
	it('builds a table section with the expected columns and cell values', () => {
		const rows: CellCommentaryRow[] = [
			{
				sheet: 'Sheet1', column: 'Name', rowIndex: 0, rowNumber: 1,
				cellContent: 'Alice', noteBody: 'Check this', author: 'You', createdAt: 1
			}
		];
		const section = buildCellCommentarySection(rows);
		expect(section.heading).toBe('Cell Commentary');
		expect(section.columns).toEqual(['Sheet', 'Column', 'Row', 'Cell Content', 'Note']);
		expect(section.lines).toEqual([
			{ kind: 'data', cells: ['Sheet1', 'Name', '1', 'Alice', 'Check this'] }
		]);
	});

	it('falls back to "(empty note)" for a note with no body text', () => {
		const rows: CellCommentaryRow[] = [
			{
				sheet: 'Sheet1', column: 'Name', rowIndex: 0, rowNumber: 1,
				cellContent: 'Alice', noteBody: '', author: 'You', createdAt: 1
			}
		];
		const section = buildCellCommentarySection(rows);
		expect(section.lines[0]).toEqual({
			kind: 'data',
			cells: ['Sheet1', 'Name', '1', 'Alice', '(empty note)']
		});
	});
});
