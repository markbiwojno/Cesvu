/**
 * src/lib/crypto/cesvu-crypto.test.ts
 *
 * Round-trip and corruption-detection tests for the plain (unencrypted,
 * SHA-256-checksummed) `.cesvu` v2 container built by buildCesvuFile() /
 * parsed by parseCesvuFile().
 */

import { describe, it, expect } from 'vitest';
import {
	buildCesvuFile,
	parseCesvuFile,
	CesvuError,
	MAGIC,
	VERSION,
	type CesvuMetadata
} from './cesvu-crypto.js';

function sampleMetadata(overrides: Partial<CesvuMetadata> = {}): CesvuMetadata {
	return {
		filename: 'document',
		mimeType: 'application/json',
		createdAt: Date.now(),
		...overrides
	};
}

describe('buildCesvuFile / parseCesvuFile', () => {
	it('round-trips a payload and its metadata', async () => {
		const payload = new TextEncoder().encode('CFP1-framed-payload-bytes');
		const metadata = sampleMetadata({ filename: 'notes.txt' });

		const file = await buildCesvuFile(payload, metadata);
		const { payload: parsedPayload, metadata: parsedMetadata } = await parseCesvuFile(file);

		expect(new Uint8Array(parsedPayload)).toEqual(payload);
		expect(parsedMetadata.filename).toBe('notes.txt');
	});

	it('writes the expected magic and version', async () => {
		const file = await buildCesvuFile(new Uint8Array([1, 2, 3]), sampleMetadata());
		expect(file.slice(0, MAGIC.length)).toEqual(MAGIC);
		const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
		expect(dv.getUint16(6, false)).toBe(VERSION);
	});

	it('rejects a file with the wrong magic', async () => {
		const file = await buildCesvuFile(new Uint8Array([1, 2, 3]), sampleMetadata());
		file[0] = 0x00;
		await expect(parseCesvuFile(file)).rejects.toMatchObject({ code: 'BAD_MAGIC' });
	});

	it('rejects a truncated/too-short file', async () => {
		const tooShort = new Uint8Array([1, 2, 3]);
		await expect(parseCesvuFile(tooShort)).rejects.toMatchObject({ code: 'TOO_SHORT' });
	});

	it('rejects a v1 (formerly encrypted) file as UNSUPPORTED_VERSION', async () => {
		const file = await buildCesvuFile(new Uint8Array([1, 2, 3]), sampleMetadata());
		const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
		dv.setUint16(6, 1, false);
		await expect(parseCesvuFile(file)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
	});

	it('detects a corrupted payload via the SHA-256 checksum', async () => {
		const payload = new TextEncoder().encode('original payload bytes');
		const file = await buildCesvuFile(payload, sampleMetadata());
		// Flip a byte well inside the payload section.
		file[file.length - 1] ^= 0xff;
		await expect(parseCesvuFile(file)).rejects.toMatchObject({ code: 'CORRUPTED' });
	});

	it('detects corrupted metadata JSON', async () => {
		const file = await buildCesvuFile(new Uint8Array([9, 9, 9]), sampleMetadata());
		// Corrupt a byte inside the metadata JSON region (right after the
		// fixed 10-byte header).
		file[10] = 0x00;
		await expect(parseCesvuFile(file)).rejects.toThrow(CesvuError);
	});
});
