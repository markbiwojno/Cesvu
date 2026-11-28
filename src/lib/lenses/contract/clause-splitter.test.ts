import { describe, it, expect } from 'vitest';
import { clausesFromOffsets } from './clause-splitter.js';

describe('clausesFromOffsets — startOffset/endOffset propagation', () => {
	it('reports exact offset ranges (into the ORIGINAL text) for each clause', () => {
		const text = 'Preamble text here.\n\nFirst clause body.\n\nSecond clause body.';
		const firstSplit = text.indexOf('First clause');
		const secondSplit = text.indexOf('Second clause');
		const clauses = clausesFromOffsets(text, [firstSplit, secondSplit]);

		// Preamble (number 0) + 2 clauses.
		expect(clauses).toHaveLength(3);
		for (const c of clauses) {
			expect(c.startOffset).toBeDefined();
			expect(c.endOffset).toBeDefined();
			expect(c.endOffset!).toBeGreaterThan(c.startOffset!);
			// Slicing the ORIGINAL text at the reported offsets reproduces
			// exactly the clause's own (trimmed) text — the whole point of
			// carrying offsets at all (note-to-clause matching depends on it).
			expect(text.slice(c.startOffset!, c.endOffset!)).toBe(c.text);
		}
	});

	it('produces a single clause spanning the whole text when there are no splits', () => {
		const text = 'Just one clause, no boundaries.';
		const clauses = clausesFromOffsets(text, []);
		expect(clauses).toHaveLength(1);
		expect(clauses[0].startOffset).toBe(0);
		expect(clauses[0].endOffset).toBe(text.length);
	});

	it('offsets correctly skip leading whitespace trimmed off a segment', () => {
		const text = 'A.\n\n   \tB clause with leading whitespace.\n\nC.';
		const splitAt = text.indexOf('   \tB');
		const clauses = clausesFromOffsets(text, [splitAt]);
		const bClause = clauses.find((c) => c.text.startsWith('B clause'));
		expect(bClause).toBeDefined();
		// startOffset should point at the FIRST non-whitespace char, not the
		// raw segment boundary (which includes the leading spaces/tab).
		expect(text[bClause!.startOffset!]).toBe('B');
	});
});
