import { describe, it, expect } from 'vitest';
import { tokenizeHeader, looksLikeIdentifierColumn, suggestAggregation } from './column-heuristics.js';

describe('tokenizeHeader', () => {
	it('splits on spaces/underscores/hyphens', () => {
		expect(tokenizeHeader('Invoice Number')).toEqual(['invoice', 'number']);
		expect(tokenizeHeader('invoice_number')).toEqual(['invoice', 'number']);
		expect(tokenizeHeader('invoice-number')).toEqual(['invoice', 'number']);
	});

	it('splits camelCase', () => {
		expect(tokenizeHeader('ZipCode')).toEqual(['zip', 'code']);
		expect(tokenizeHeader('employeeId')).toEqual(['employee', 'id']);
	});

	it('keeps "#" as its own token', () => {
		expect(tokenizeHeader('Invoice#')).toEqual(['invoice', '#']);
		expect(tokenizeHeader('Invoice #')).toEqual(['invoice', '#']);
	});

	it('lowercases every token', () => {
		expect(tokenizeHeader('YEAR')).toEqual(['year']);
	});
});

describe('looksLikeIdentifierColumn', () => {
	it('matches whole-token identifier words', () => {
		expect(looksLikeIdentifierColumn('Invoice #')).toBe(true);
		expect(looksLikeIdentifierColumn('Invoice No')).toBe(true);
		expect(looksLikeIdentifierColumn('Employee ID')).toBe(true);
		expect(looksLikeIdentifierColumn('Zip Code')).toBe(true);
		expect(looksLikeIdentifierColumn('Postal Code')).toBe(true);
		expect(looksLikeIdentifierColumn('Year')).toBe(true);
		expect(looksLikeIdentifierColumn('Phone Number')).toBe(true);
		expect(looksLikeIdentifierColumn('Account Code')).toBe(true);
	});

	it('does NOT match a header that merely contains an id-like substring', () => {
		// "Amount Paid" must stay summable — no token equals an id-word.
		expect(looksLikeIdentifierColumn('Amount Paid')).toBe(false);
		// "Noodle Count" shares letters with "no" but no whole token is "no".
		expect(looksLikeIdentifierColumn('Noodle Count')).toBe(false);
		expect(looksLikeIdentifierColumn('Revenue')).toBe(false);
		expect(looksLikeIdentifierColumn('Total Sales')).toBe(false);
	});
});

describe('suggestAggregation', () => {
	it('suggests none for identifier-like headers', () => {
		expect(suggestAggregation('Invoice #')).toBe('none');
		expect(suggestAggregation('Zip Code')).toBe('none');
	});

	it('suggests sum for ordinary numeric headers', () => {
		expect(suggestAggregation('Amount Paid')).toBe('sum');
		expect(suggestAggregation('Revenue')).toBe('sum');
		expect(suggestAggregation('Total Sales')).toBe('sum');
	});
});
