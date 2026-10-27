/**
 * contract-store.roundtrip.test.ts
 *
 * Guards the forward-compat / version-skew behavior of the .cesvu import path:
 * a field this build does NOT model must survive a full export → import
 * round-trip instead of being silently dropped by normalizeCesvuDocument.
 *
 * This is the regression test for the "importer silently drops unknown fields"
 * bug: previously normalizeCesvuDocument rebuilt the record from a fixed
 * whitelist, so any field a newer peer wrote (or any field a future schema adds)
 * vanished the moment an older build re-imported and re-exported the document.
 *
 * The round-trip exercises the REAL crypto envelope (Argon2id + AES-256-GCM),
 * so it also incidentally proves encrypt/decrypt agree on the wire format.
 */

import { describe, it, expect } from 'vitest';
import {
	createDocument,
	updateDocument,
	exportAsCesvu,
	importFromCesvu,
	type DocumentPatch
} from './contract-store.svelte.js';

/** Wrap a Blob as a File the way the import UI does. */
function blobToFile(blob: Blob, name: string): File {
	return new File([blob], name, { type: blob.type });
}

describe('importFromCesvu — forward-compat field preservation', () => {
	it('preserves fields this build does not model across a round-trip', async () => {
		// 1. Create a document and stamp it with a field the schema/importer does
		//    NOT know about (simulating a newer-build peer or a future field).
		const doc = await createDocument({
			name: 'forward-compat.txt',
			sourceType: 'txt',
			text: 'hello round-trip'
		});

		const futurePatch = {
			futureField: 'keep-me',
			reviewState: { stage: 'counter', by: 'alice' }
		} as unknown as DocumentPatch;
		await updateDocument(doc.id, futurePatch);

		// 2. Export → encrypted .cesvu blob + the diceware words.
		const { words, blob } = await exportAsCesvu(doc.id);
		const file = blobToFile(blob, 'forward-compat.cesvu');

		// 3. Import it back with the same passphrase.
		const imported = await importFromCesvu(file, words.join(' '));

		// 4. The unknown fields must have survived verbatim.
		const round = imported as unknown as {
			futureField?: string;
			reviewState?: { stage: string; by: string };
		};
		expect(round.futureField).toBe('keep-me');
		expect(round.reviewState).toEqual({ stage: 'counter', by: 'alice' });

		// 5. Known fields still round-trip and stay well-formed.
		expect(imported.id).toBe(doc.id);
		expect(imported.text).toBe('hello round-trip');
		expect(imported.sourceType).toBe('txt');
		expect(Array.isArray(imported.clauses)).toBe(true);
		expect(Array.isArray(imported.annotations)).toBe(true);
	}, 20_000);

	it('rejects a payload missing required identity fields', async () => {
		// A document with the right magic/passphrase but a structurally invalid
		// body must still fail loudly (corruption guard intact).
		const doc = await createDocument({
			name: 'broken.txt',
			sourceType: 'txt',
			text: 'will be corrupted'
		});
		// Blank out a required field via an unchecked patch.
		await updateDocument(doc.id, { text: '' } as unknown as DocumentPatch);
		// text:'' is still a string (valid) — instead corrupt sourceType.
		await updateDocument(doc.id, { sourceType: 'bogus' } as unknown as DocumentPatch);

		const { words, blob } = await exportAsCesvu(doc.id);
		const file = blobToFile(blob, 'broken.cesvu');

		await expect(importFromCesvu(file, words.join(' '))).rejects.toThrow(
			/corrupted/i
		);
	}, 20_000);
});

describe('importFromCesvu — field normalization & default-secure export', () => {
	it('preserves a populated profile (parties) across a round-trip', async () => {
		const doc = await createDocument({
			name: 'with-profile.txt',
			sourceType: 'txt',
			text: 'Agreement between Acme and Globex.'
		});
		// A ContractProfile-shaped object — normalize() casts profile through
		// untouched, so the exact shape only needs to be JSON-serializable.
		const profile = {
			parties: [
				{ name: 'Acme Corporation', kind: 'org', definedTerm: 'Company', source: 'auto-signature' },
				{ name: 'Globex LLC', kind: 'org', definedTerm: 'Client', source: 'auto-preamble' }
			],
			keyDates: [],
			risks: []
		};
		await updateDocument(doc.id, { profile } as unknown as DocumentPatch);

		const { words, blob } = await exportAsCesvu(doc.id);
		const imported = await importFromCesvu(blobToFile(blob, 'p.cesvu'), words.join(' '));

		// The parties (and the rest of the profile) survive the envelope intact.
		expect(imported.profile).toEqual(profile);
	}, 20_000);

	it('preserves a csv sourceType (regression: csv/excel were wrongly rejected)', async () => {
		const doc = await createDocument({
			name: 'data.csv',
			sourceType: 'csv',
			text: 'a,b\n1,2'
		});
		const createdAt = doc.createdAt;

		const { words, blob } = await exportAsCesvu(doc.id);
		const imported = await importFromCesvu(blobToFile(blob, 'd.cesvu'), words.join(' '));

		expect(imported.sourceType).toBe('csv');
		// createdAt is an immutable identity field and must survive verbatim.
		expect(imported.createdAt).toBe(createdAt);
	}, 20_000);

	it('round-trips rawContent when the sender opts in (includeSource: true)', async () => {
		const rawContent = btoa('original file bytes');
		const doc = await createDocument({
			name: 'src.pdf',
			sourceType: 'pdf',
			text: 'extracted text',
			rawContent
		});

		const { words, blob } = await exportAsCesvu(doc.id, { includeSource: true });
		const imported = await importFromCesvu(blobToFile(blob, 's.cesvu'), words.join(' '));

		// The .cesvu v2 CFP1 framing carries the source bytes as a raw
		// Uint8Array appended after the JSON envelope (see
		// contract-store.svelte.ts), NOT re-encoded back to base64 — a large
		// (multi-hundred-MB) source file re-encoded to a base64 STRING can
		// blow past `RangeError: Invalid string length`, even when the
		// underlying byte array fits in memory fine. `importFromCesvu`
		// therefore hands back a Uint8Array VIEW over the decrypted
		// plaintext, not a string. Decode both sides to bytes to compare.
		expect(imported.rawContent).toBeInstanceOf(Uint8Array);
		const importedBytes = imported.rawContent as Uint8Array;
		const originalBytes = Uint8Array.from(atob(rawContent), (c) => c.charCodeAt(0));
		expect(new Uint8Array(importedBytes)).toEqual(originalBytes);
	}, 20_000);


	it('strips rawContent from the envelope by default (default-secure)', async () => {
		const doc = await createDocument({
			name: 'src.pdf',
			sourceType: 'pdf',
			text: 'extracted text',
			rawContent: btoa('original file bytes')
		});

		// No options → includeSource defaults to false → source bytes omitted.
		const { words, blob } = await exportAsCesvu(doc.id);
		const imported = await importFromCesvu(blobToFile(blob, 's.cesvu'), words.join(' '));

		expect(imported.rawContent).toBeNull();
	}, 20_000);

	it('coerces an invalid splits.mode to "manual" and defaults missing arrays', async () => {
		const doc = await createDocument({
			name: 'splits.txt',
			sourceType: 'txt',
			text: 'one. two. three.'
		});
		await updateDocument(doc.id, {
			splits: { mode: 'bogus', manual: [3, 7] }
		} as unknown as DocumentPatch);

		const { words, blob } = await exportAsCesvu(doc.id);
		const imported = await importFromCesvu(blobToFile(blob, 'sp.cesvu'), words.join(' '));

		expect(imported.splits.mode).toBe('manual'); // unknown mode → 'manual'
		expect(imported.splits.manual).toEqual([3, 7]); // valid array preserved
		expect(imported.splits.auto).toEqual([]); // missing array → []
	}, 20_000);

	it('rejects a non-string text body as corrupted', async () => {
		const doc = await createDocument({
			name: 'bad-text.txt',
			sourceType: 'txt',
			text: 'fine for now'
		});
		// Corrupt `text` to a non-string via an unchecked patch.
		await updateDocument(doc.id, { text: 123 } as unknown as DocumentPatch);

		const { words, blob } = await exportAsCesvu(doc.id);
		const file = blobToFile(blob, 'bad.cesvu');

		await expect(importFromCesvu(file, words.join(' '))).rejects.toThrow(/corrupted/i);
	}, 20_000);
});
