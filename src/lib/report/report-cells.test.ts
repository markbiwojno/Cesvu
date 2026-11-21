import { describe, it, expect } from 'vitest';
import { adaptExcelCell, adaptCsvCell, columnLooksLikeDate } from './report-cells.js';

describe('adaptExcelCell', () => {
	it('treats a missing/undefined cell as blank', () => {
		expect(adaptExcelCell(undefined)).toEqual({ numeric: null, display: '', isBlank: true, isError: false });
	});

	it('treats a cell with no value as blank, preferring .w if present', () => {
		expect(adaptExcelCell({ w: '' })).toMatchObject({ isBlank: true, isError: false });
	});

	it('flags an error cell (#DIV/0! etc.) as isError, not isBlank', () => {
		const r = adaptExcelCell({ t: 'e', v: 15, w: '#DIV/0!' });
		expect(r).toEqual({ numeric: null, display: '#DIV/0!', isBlank: false, isError: true });
	});

	it('converts a Date value (cellDates:true) to epoch ms, keeping the display text', () => {
		const d = new Date('2024-03-15T00:00:00.000Z');
		const r = adaptExcelCell({ t: 'n', v: d, w: '3/15/2024' });
		expect(r.numeric).toBe(d.getTime());
		expect(r.display).toBe('3/15/2024');
		expect(r.isBlank).toBe(false);
		expect(r.isError).toBe(false);
	});

	it('reads a plain numeric cell, preferring .w for display (preserves parens/percent formatting)', () => {
		expect(adaptExcelCell({ t: 'n', v: -1234.5, w: '(1,234.50)' })).toEqual({
			numeric: -1234.5,
			display: '(1,234.50)',
			isBlank: false,
			isError: false
		});
		expect(adaptExcelCell({ t: 'n', v: 0.26, w: '26%' })).toEqual({
			numeric: 0.26,
			display: '26%',
			isBlank: false,
			isError: false
		});
	});

	it('falls back to String(v) when .w is missing', () => {
		expect(adaptExcelCell({ t: 'n', v: 42 })).toEqual({
			numeric: 42,
			display: '42',
			isBlank: false,
			isError: false
		});
	});

	it('treats a string cell as non-numeric, non-blank content', () => {
		expect(adaptExcelCell({ t: 's', v: 'East', w: 'East' })).toEqual({
			numeric: null,
			display: 'East',
			isBlank: false,
			isError: false
		});
	});

	it('treats a whitespace-only string cell as blank', () => {
		expect(adaptExcelCell({ t: 's', v: '   ', w: '   ' }).isBlank).toBe(true);
	});
});

describe('adaptCsvCell', () => {
	it('treats undefined/null/empty/whitespace as blank', () => {
		expect(adaptCsvCell(undefined).isBlank).toBe(true);
		expect(adaptCsvCell(null).isBlank).toBe(true);
		expect(adaptCsvCell('').isBlank).toBe(true);
		expect(adaptCsvCell('   ').isBlank).toBe(true);
	});

	it('parses plain numbers', () => {
		expect(adaptCsvCell('42').numeric).toBe(42);
		expect(adaptCsvCell('-3.5').numeric).toBe(-3.5);
	});

	it('strips $, comma, and % before parsing, but keeps the original display', () => {
		const r = adaptCsvCell('$1,234.50');
		expect(r.numeric).toBe(1234.5);
		expect(r.display).toBe('$1,234.50');

		const pct = adaptCsvCell('26%');
		expect(pct.numeric).toBe(26);
		expect(pct.display).toBe('26%');
	});

	it('treats non-numeric text as non-numeric, non-blank', () => {
		const r = adaptCsvCell('East');
		expect(r.numeric).toBeNull();
		expect(r.isBlank).toBe(false);
		expect(r.display).toBe('East');
	});
});

describe('columnLooksLikeDate', () => {
	const isDateFormat = (z: string) => z === 'm/d/yyyy';

	it('returns true when a majority of non-blank cells carry a date format', () => {
		const cells = [
			{ v: 1, z: 'm/d/yyyy' },
			{ v: 2, z: 'm/d/yyyy' },
			{ v: 3, z: '0.00' }
		];
		expect(columnLooksLikeDate(cells, isDateFormat)).toBe(true);
	});

	it('returns false when the majority is NOT date-formatted', () => {
		const cells = [
			{ v: 1, z: '0.00' },
			{ v: 2, z: '0.00' },
			{ v: 3, z: 'm/d/yyyy' }
		];
		expect(columnLooksLikeDate(cells, isDateFormat)).toBe(false);
	});

	it('ignores blank cells when computing the majority', () => {
		const cells = [undefined, { v: 1, z: 'm/d/yyyy' }, { v: undefined }];
		expect(columnLooksLikeDate(cells, isDateFormat)).toBe(true);
	});

	it('returns false for an all-blank column', () => {
		expect(columnLooksLikeDate([undefined, { v: undefined }], isDateFormat)).toBe(false);
	});
});
