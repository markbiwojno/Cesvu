/**
 * src/lib/export/cesvu-zip-export.test.ts
 *
 * Round-trip and validation tests for the `_cesvu.zip` container built by
 * buildCesvuZip() / parsed by parseCesvuZip().
 */

import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import {
	buildCesvuZip,
	parseCesvuZip,
	CesvuZipError,
	CESVU_MANIFEST_VERSION,
	MANIFEST_ENTRY,
	README_ENTRY,
	SOURCE_DIR,
	type CesvuManifest
} from './cesvu-zip-export.js';

function sampleManifest(overrides: Partial<CesvuManifest> = {}): CesvuManifest {
	return {
		cesvuManifestVersion: CESVU_MANIFEST_VERSION,
		exportedAt: new Date().toISOString(),
		document: {
			id: 'doc-1',
			version: 4,
			name: 'notes.txt',
			sourceType: 'txt',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			text: 'hello world',
			paragraphs: []
		},
		sourceFile: { included: false, path: null, mimeType: null },
		splits: { manual: [], auto: [], mode: 'manual' },
		clauses: [],
		notes: [],
		profile: null,
		messages: [],
		...overrides
	};
}

describe('buildCesvuZip / parseCesvuZip', () => {
	it('round-trips a manifest with no source file', () => {
		const manifest = sampleManifest();
		const zip = buildCesvuZip(manifest, null);
		const { manifest: parsed, sourceBytes } = parseCesvuZip(zip);

		expect(parsed.document.text).toBe('hello world');
		expect(parsed.document.id).toBe('doc-1');
		expect(sourceBytes).toBeNull();
	});

	it('round-trips a manifest WITH an embedded source file', () => {
		const sourceBytes = new TextEncoder().encode('original file bytes');
		const manifest = sampleManifest({
			document: {
				id: 'doc-2',
				version: 4,
				name: 'report.pdf',
				sourceType: 'pdf',
				createdAt: Date.now(),
				updatedAt: Date.now(),
				text: 'extracted text',
				paragraphs: []
			},
			sourceFile: { included: true, path: `${SOURCE_DIR}report.pdf`, mimeType: 'application/pdf' }
		});

		const zip = buildCesvuZip(manifest, { bytes: sourceBytes, filename: 'report.pdf' });
		const { manifest: parsed, sourceBytes: parsedSource } = parseCesvuZip(zip);

		expect(parsed.sourceFile.included).toBe(true);
		expect(parsedSource).toEqual(sourceBytes);
	});

	it('writes a real, standard zip containing manifest.json and README.txt', () => {
		const zip = buildCesvuZip(sampleManifest(), null);
		const entries = unzipSync(zip);

		expect(Object.keys(entries)).toContain(MANIFEST_ENTRY);
		expect(Object.keys(entries)).toContain(README_ENTRY);

		const manifestJson = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]));
		expect(manifestJson.cesvuManifestVersion).toBe(CESVU_MANIFEST_VERSION);

		const readme = strFromU8(entries[README_ENTRY]);
		expect(readme).toContain('This is a Cesvu file');
		expect(readme).toContain('not encrypted');
	});

	it('places the source file under source/ as a real zip entry', () => {
		const sourceBytes = new Uint8Array([1, 2, 3, 4]);
		const manifest = sampleManifest({
			sourceFile: { included: true, path: `${SOURCE_DIR}data.bin`, mimeType: null }
		});
		const zip = buildCesvuZip(manifest, { bytes: sourceBytes, filename: 'data.bin' });
		const entries = unzipSync(zip);

		expect(entries[`${SOURCE_DIR}data.bin`]).toEqual(sourceBytes);
	});

	it('rejects a file that is not a valid zip', () => {
		const notAZip = new Uint8Array([1, 2, 3, 4, 5]);
		expect(() => parseCesvuZip(notAZip)).toThrow(CesvuZipError);
		try {
			parseCesvuZip(notAZip);
		} catch (e) {
			expect((e as CesvuZipError).code).toBe('NOT_A_ZIP');
		}
	});

	it('rejects a zip with no manifest.json', () => {
		// A real, valid zip that simply doesn't carry a manifest.json entry.
		const notACesvuZip = zipSync({ [README_ENTRY]: strToU8('just a readme') });
		expect(() => parseCesvuZip(notACesvuZip)).toThrow(CesvuZipError);
		try {
			parseCesvuZip(notACesvuZip);
		} catch (e) {
			expect((e as CesvuZipError).code).toBe('MISSING_MANIFEST');
		}
	});

	it('rejects manifest.json with an unsupported manifest version', () => {
		const zip = buildCesvuZip(sampleManifest(), null);
		const entries = unzipSync(zip);
		const bumped = JSON.parse(strFromU8(entries[MANIFEST_ENTRY]));
		bumped.cesvuManifestVersion = 999;
		entries[MANIFEST_ENTRY] = strToU8(JSON.stringify(bumped));
		const rebuilt = zipSync(entries);

		expect(() => parseCesvuZip(rebuilt)).toThrow(CesvuZipError);
		try {
			parseCesvuZip(rebuilt);
		} catch (e) {
			expect((e as CesvuZipError).code).toBe('UNSUPPORTED_MANIFEST_VERSION');
		}
	});

	it('rejects a corrupted manifest.json (invalid JSON)', () => {
		const zip = buildCesvuZip(sampleManifest(), null);
		const entries = unzipSync(zip);
		entries[MANIFEST_ENTRY] = strToU8('{not valid json');
		const rebuilt = zipSync(entries);

		expect(() => parseCesvuZip(rebuilt)).toThrow(CesvuZipError);
		try {
			parseCesvuZip(rebuilt);
		} catch (e) {
			expect((e as CesvuZipError).code).toBe('MANIFEST_CORRUPT');
		}
	});

	it('preserves extras (forward-compat fields) through a round-trip', () => {
		const manifest = sampleManifest({
			extras: { futureField: 'keep-me' }
		});
		const zip = buildCesvuZip(manifest, null);
		const { manifest: parsed } = parseCesvuZip(zip);

		expect(parsed.extras).toEqual({ futureField: 'keep-me' });
	});
});
