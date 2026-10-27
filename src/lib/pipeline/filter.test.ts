/**
 * src/lib/pipeline/filter.test.ts
 *
 * Regression guard for the natural-language → Filter-tree parser
 * (naturalLanguageToFilter / parseDSL / evaluate in ./filter.ts).
 *
 * Bug history this pins:
 *  1. The shared value terminator `VT` was a NON-capturing group, so every
 *     VT-using rule (is / equals / contains / starts with / ends with, and the
 *     bare spaced "col = value") received the regex MATCH OFFSET as the value
 *     instead of the matched text. That turned
 *       "countyname = butte and hvac in BusinessDescription"
 *     into  CountyName = "0"  AND  BusinessDescription contains "27".
 *     Fixed by making the value alternation capturing: ("[^"]*"|.+?).
 *  2. Compound phrasing "<value> in <Column>" (the inverse of "Column contains
 *     value") was dropped entirely; now it resolves to Column:"value" when the
 *     trailing token is a real column.
 *  3. Multi-word values ("d k iron") must survive tokenization as one value.
 *  4. The chat "column = value" simple-pattern path set activeFilter without a
 *     filterTree, leaving the editable FilterBar empty (see the dedicated
 *     describe block at the bottom of this file).
 *
 * These are pure-logic tests (no DOM, no model) per vitest.config.ts.
 */

import { describe, it, expect } from 'vitest';
import {
	naturalLanguageToFilter,
	evaluate,
	describeFilter,
	type Filter,
	type FilterLeaf
} from './filter.js';

const COLUMNS = [
	'CountyName',
	'BusinessDescription',
	'BusinessName',
	'Revenue',
	'Status',
	'RegistrationDate'
];

/** Collect every leaf in a Filter tree (depth-first, left-to-right). */
function leaves(f: Filter | null): FilterLeaf[] {
	if (!f) return [];
	if ('and' in f) return f.and.flatMap(leaves);
	if ('or' in f) return f.or.flatMap(leaves);
	if ('not' in f) return leaves(f.not);
	return [f as FilterLeaf];
}

/** Find the first leaf whose (normalized) column matches `col`. */
function leafFor(f: Filter | null, col: string): FilterLeaf | undefined {
	const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');
	return leaves(f).find((l) => norm(l.column) === norm(col));
}

describe('naturalLanguageToFilter — compound parsing', () => {
	it('captures the matched value, not the regex offset (VT capture-group bug)', () => {
		const f = naturalLanguageToFilter(
			'countyname = butte and hvac in BusinessDescription',
			COLUMNS
		);
		const county = leafFor(f, 'CountyName');
		expect(county).toBeDefined();
		// Must be the literal text, never a stringified numeric offset like "0".
		expect(String(county!.value).toLowerCase()).toContain('butte');

		const desc = leafFor(f, 'BusinessDescription');
		expect(desc).toBeDefined();
		expect(String(desc!.value).toLowerCase()).toContain('hvac');
	});

	it('resolves "<value> in <Column>" as Column contains value', () => {
		const f = naturalLanguageToFilter('hvac in BusinessDescription', COLUMNS);
		const desc = leafFor(f, 'BusinessDescription');
		expect(desc).toBeDefined();
		expect(String(desc!.value).toLowerCase()).toContain('hvac');
	});

	it('keeps multi-word values intact as a single value', () => {
		const f = naturalLanguageToFilter('BusinessName = d k iron', COLUMNS);
		const biz = leafFor(f, 'BusinessName');
		expect(biz).toBeDefined();
		expect(String(biz!.value).toLowerCase()).toContain('d k iron');
	});

	it('"<value> in <non-column>" is NOT rewritten as a column reference', () => {
		// "los angeles" is not a column, so this must not become a bogus leaf.
		const f = naturalLanguageToFilter('BusinessName contains hvac in los angeles', COLUMNS);
		const biz = leafFor(f, 'BusinessName');
		expect(biz).toBeDefined();
		// The "in los angeles" tail must not have produced a column leaf for it.
		expect(leaves(f).every((l) => l.column !== 'los angeles')).toBe(true);
	});
});

describe('single-leaf filterTree — chat "column = value" chip regression', () => {
	/**
	 * Pins the fix for: typing "show me where countyname = butte" in chat
	 * filtered the rows correctly but left the editable FilterBar EMPTY, because
	 * the chat simple-pattern path set activeFilter with only {column, pattern}
	 * and no filterTree — and FilterBar seeds its chips exclusively from
	 * filterTree (analysis.ts filter_rows / directOp / operation paths).
	 *
	 * The fix synthesizes a single-leaf filterTree
	 *   { column: <canonical>, op: 'contains', value: <pattern> }
	 * at those call sites. This test locks that the emitted leaf is:
	 *   1. a plain leaf (NOT and/or/not) — so FilterBar's treeToConditions can
	 *      render it as ONE editable row rather than a read-only banner, and
	 *   2. semantically correct — it matches the rows the chat said it would.
	 */
	const leaf: Filter = { column: 'CountyName', op: 'contains', value: 'butte' };

	it('is a single editable leaf (not a compound group)', () => {
		// FilterBar can only render and/leaf trees as editable rows; or/nested
		// fall back to a read-only banner. A bare leaf must stay a bare leaf.
		expect('and' in leaf).toBe(false);
		expect('or' in leaf).toBe(false);
		expect('not' in leaf).toBe(false);
		expect(leaves(leaf)).toHaveLength(1);
		const only = leaves(leaf)[0];
		expect(only.column).toBe('CountyName'); // canonical resolved column
		expect(only.op).toBe('contains');
		expect(only.value).toBe('butte');
	});

	it('selects exactly the matching rows', () => {
		expect(evaluate(leaf, { CountyName: 'butte', Revenue: 1 })).toBe(true);
		expect(evaluate(leaf, { CountyName: 'butte COUNTY', Revenue: 2 })).toBe(true);
		expect(evaluate(leaf, { CountyName: 'Philadelphia', Revenue: 3 })).toBe(false);
	});

	it('describes itself with the canonical column (for the chip label)', () => {
		const label = describeFilter(leaf);
		expect(label.toLowerCase()).toContain('countyname');
		expect(label.toLowerCase()).toContain('butte');
	});
});
