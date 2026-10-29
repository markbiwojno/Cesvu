/**
 * contract-store.roundtrip.test.ts
 *
 * Guards the forward-compat behavior of the `_cesvu.zip` import path: a
 * field this build does NOT model must survive a full export → import
 * round-trip instead of being silently dropped by documentFromManifest.
 *
 * This is the regression test for the "importer silently drops unknown fields"
 * bug: previously normalizeCesvuDocument rebuilt the record from a fixed
 * whitelist, so any field a newer peer wrote (or any field a future schema adds)
 * vanished the moment an older build re-imported and re-exported the document.
 *
 * The round-trip exercises the REAL `_cesvu.zip` archive (see
 * cesvu-zip-export.ts), so it also incidentally proves build/parse agree on
 * the manifest shape.
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

		// 2. Export → plain `_cesvu.zip` blob.
		const { blob } = await exportAsCesvu(doc.id);
		const file = blobToFile(blob, 'forward-compat_cesvu.zip');

		// 3. Import it back.
		const imported = await importFromCesvu(file);

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

	it('fails fast on export when sourceType was corrupted to an invalid value', async () => {
		// The manifest's zod schema validates at BUILD time (inside
		// exportAsCesvu/buildCesvuZip), so a structurally invalid field is
		// rejected before a broken archive can ever be produced — rather than
		// silently shipping a corrupt file that only fails later on import.
		const doc = await createDocument({
			name: 'broken.txt',
			sourceType: 'txt',
			text: 'will be corrupted'
		});
		await updateDocument(doc.id, { sourceType: 'bogus' } as unknown as DocumentPatch);

		await expect(exportAsCesvu(doc.id)).rejects.toThrow();
	}, 20_000);

	it('rejects a non-zip file as not-a-zip', async () => {
		const bogus = new Blob(['not a zip at all'], { type: 'text/plain' });
		const file = blobToFile(bogus, 'broken_cesvu.zip');

		await expect(importFromCesvu(file)).rejects.toThrow(/not a \.zip file/i);
	}, 20_000);
});

describe('importFromCesvu — field normalization & default-secure export', () => {
	it('preserves a populated profile (parties) across a round-trip', async () => {
		const doc = await createDocument({
			name: 'with-profile.txt',
			sourceType: 'txt',
			text: 'Agreement between Acme and Globex.'
		});
		// A ContractProfile-shaped object — the manifest's ProfileSchema is a
		// loose record passthrough, so the exact shape only needs to be
		// JSON-serializable.
		const profile = {
			parties: [
				{ name: 'Acme Corporation', kind: 'org', definedTerm: 'Company', source: 'auto-signature' },
				{ name: 'Globex LLC', kind: 'org', definedTerm: 'Client', source: 'auto-preamble' }
			],
			keyDates: [],
			risks: []
		};
		await updateDocument(doc.id, { profile } as unknown as DocumentPatch);

		const { blob } = await exportAsCesvu(doc.id);
		const imported = await importFromCesvu(blobToFile(blob, 'p_cesvu.zip'));

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

		const { blob } = await exportAsCesvu(doc.id);
		const imported = await importFromCesvu(blobToFile(blob, 'd_cesvu.zip'));

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

		const { blob } = await exportAsCesvu(doc.id, { includeSource: true });
		const imported = await importFromCesvu(blobToFile(blob, 's_cesvu.zip'));

		// The source file rides as a real zip entry under source/ (see
		// cesvu-zip-export.ts), NOT re-encoded back to base64 — a large
		// (multi-hundred-MB) source file re-encoded to a base64 STRING can
		// blow past `RangeError: Invalid string length`, even when the
		// underlying byte array fits in memory fine. `importFromCesvu`
		// therefore hands back a Uint8Array VIEW over the unzipped entry, not
		// a string. Decode both sides to bytes to compare.
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
		const { blob } = await exportAsCesvu(doc.id);
		const imported = await importFromCesvu(blobToFile(blob, 's_cesvu.zip'));

		expect(imported.rawContent).toBeNull();
	}, 20_000);

	it('round-trips split offsets and the active mode exactly', async () => {
		const doc = await createDocument({
			name: 'splits.txt',
			sourceType: 'txt',
			text: 'one. two. three.'
		});
		await updateDocument(doc.id, {
			splits: { mode: 'manual', manual: [3, 7], auto: [] }
		} as unknown as DocumentPatch);

		const { blob } = await exportAsCesvu(doc.id);
		const imported = await importFromCesvu(blobToFile(blob, 'sp_cesvu.zip'));

		expect(imported.splits.mode).toBe('manual');
		expect(imported.splits.manual).toEqual([3, 7]);
		expect(imported.splits.auto).toEqual([]);
	}, 20_000);

	it('fails fast on export when splits.mode is corrupted to an invalid value', async () => {
		// Same build-time validation as sourceType above: the manifest schema
		// rejects an invalid enum value before a broken archive can be built.
		const doc = await createDocument({
			name: 'splits.txt',
			sourceType: 'txt',
			text: 'one. two. three.'
		});
		await updateDocument(doc.id, {
			splits: { mode: 'bogus', manual: [3, 7] }
		} as unknown as DocumentPatch);

		await expect(exportAsCesvu(doc.id)).rejects.toThrow();
	}, 20_000);

	it('fails fast on export when text is corrupted to a non-string', async () => {
		const doc = await createDocument({
			name: 'bad-text.txt',
			sourceType: 'txt',
			text: 'fine for now'
		});
		// Corrupt `text` to a non-string via an unchecked patch.
		await updateDocument(doc.id, { text: 123 } as unknown as DocumentPatch);

		await expect(exportAsCesvu(doc.id)).rejects.toThrow();
	}, 20_000);
});
