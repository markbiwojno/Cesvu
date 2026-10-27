/**
 * src/lib/lenses/contract/extract-parties.test.ts
 *
 * Pins the user-visible contract of the party extractor — the data that lands
 * in ContractProfile.parties and (via the .cesvu envelope) gets shared. These
 * are the failure modes that previously surfaced noise as "parties":
 * regulatory references ("Regulation EU"), all-caps headings, product names,
 * and signature-field placeholders ("print", "[Company Name]").
 *
 * Only the deterministic (no-model) path is exercised: extractParties() is
 * called WITHOUT a runInference callback, so it uses the regex candidates and
 * never blocks on the LLM. That makes these tests fast and reproducible.
 *
 * Exported surface under test: isValidPartyName, similarity, extractParties.
 * (mergeParties is internal and is covered indirectly through extractParties.)
 */

import { describe, it, expect } from 'vitest';
import { isValidPartyName, similarity, extractParties } from './extract-parties.js';

describe('isValidPartyName', () => {
	it('accepts real organisation and person names', () => {
		expect(isValidPartyName('Acme Corporation')).toBe(true);
		expect(isValidPartyName('Jane Q. Smith')).toBe(true);
		// All-caps is fine WHEN it carries a legal-entity indicator.
		expect(isValidPartyName('ACME, INC.')).toBe(true);
	});

	it('rejects regulatory references', () => {
		// REGULATORY guard: these are citations, not signing parties.
		expect(isValidPartyName('Regulation EU')).toBe(false);
		expect(isValidPartyName('GDPR')).toBe(false);
	});

	it('rejects all-caps headings without an entity indicator, and product noise', () => {
		// All-caps + no Inc/LLC/Corp/etc. → heading/boilerplate, not a party.
		expect(isValidPartyName('CONFIDENTIAL')).toBe(false);
		expect(isValidPartyName('TERMS AND CONDITIONS')).toBe(false);
		// PRODUCT_NOISE guard.
		expect(isValidPartyName('the Platform')).toBe(false);
	});

	it('rejects placeholders, labels, and empties', () => {
		expect(isValidPartyName('[Company Name]')).toBe(false); // template bracket
		expect(isValidPartyName('______')).toBe(false); // underscore fill-in
		expect(isValidPartyName('print')).toBe(false); // signature-field label
		expect(isValidPartyName('')).toBe(false); // too short
		expect(isValidPartyName('a')).toBe(false); // < 2 chars
	});
});

describe('similarity', () => {
	it('scores identical, contained, and disjoint names as expected', () => {
		// Identical (after entity-suffix normalisation) → 1.
		expect(similarity('Acme Corporation', 'Acme Corporation')).toBe(1);
		// Containment shortcut: "Acme" ⊂ "Acme Industries" → 0.85.
		expect(similarity('Acme Industries', 'Acme')).toBeCloseTo(0.85, 5);
		// Unrelated names fall below the 0.6 merge threshold.
		expect(similarity('Acme', 'Globex')).toBeLessThan(0.6);
	});
});

describe('extractParties (deterministic / no-model path)', () => {
	const CONTRACT = `MASTER SERVICES AGREEMENT

This Master Services Agreement is made and entered into by and between Acme Corporation ("Company") and Globex LLC ("Client"), who hereby agree as follows.

This Agreement complies with Regulation (EU) 2016/679 and the GDPR.

1. Services. The Company shall provide services to the Client.

IN WITNESS WHEREOF, the parties have executed this Agreement.

ACME CORPORATION
By: Jane Q. Smith
Title: CEO

GLOBEX LLC
By: John Roe
Title: COO
`;

	it('returns an empty array for empty / whitespace input', async () => {
		expect(await extractParties('')).toEqual([]);
		expect(await extractParties('   \n  ')).toEqual([]);
	});

	it('extracts the signing parties and filters out regulatory noise', async () => {
		const parties = await extractParties(CONTRACT);

		// At least the two corporate signatories are found.
		expect(parties.length).toBeGreaterThanOrEqual(2);

		// Acme is present in some casing.
		expect(parties.some((p) => /acme/i.test(p.name))).toBe(true);

		// INVARIANT: every returned party passes the validator — no noise leaks.
		expect(parties.every((p) => isValidPartyName(p.name))).toBe(true);

		// Regulatory citations never become parties.
		expect(parties.every((p) => !/GDPR|Regulation/i.test(p.name))).toBe(true);

		// An organisation is detected (kind classification works).
		expect(parties.some((p) => p.kind === 'org')).toBe(true);

		// The preamble's defined term is merged onto the signature legal name.
		expect(parties.some((p) => p.definedTerm === 'Company')).toBe(true);
	});

	it('caps the result at 8 parties', async () => {
		// Build a preamble with many quoted-defined-term pairs; the cap holds.
		const many = Array.from(
			{ length: 12 },
			(_, i) => `Party${String.fromCharCode(65 + i)} LLC ("Term${i}")`
		).join(' and ');
		const text = `This Agreement is made by and between ${many}, who hereby agree.`;
		const parties = await extractParties(text);
		expect(parties.length).toBeLessThanOrEqual(8);
	});
});
