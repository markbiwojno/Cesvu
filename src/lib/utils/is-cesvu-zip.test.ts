import { describe, it, expect } from 'vitest';
import { isCesvuZip, hasZipMagic, hasZipExtension } from './is-cesvu-zip.js';

const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);

function fileOf(name: string, bytes: Uint8Array | string): File {
	return new File([bytes as BlobPart], name);
}

describe('hasZipMagic / hasZipExtension', () => {
	it('recognizes the PK\\x03\\x04 header', () => {
		expect(hasZipMagic(ZIP_BYTES)).toBe(true);
		expect(hasZipMagic(new Uint8Array([1, 2, 3, 4]))).toBe(false);
		expect(hasZipMagic(new Uint8Array([0x50, 0x4b]))).toBe(false);
	});

	it('matches .zip case-insensitively', () => {
		expect(hasZipExtension('a.ZIP')).toBe(true);
		expect(hasZipExtension('a.docx')).toBe(false);
	});
});

describe('isCesvuZip', () => {
	it('accepts the canonical export name', async () => {
		expect(await isCesvuZip(fileOf('cesvu-document_cesvu.zip', ZIP_BYTES))).toBe(true);
	});

	it('accepts browser-renamed copies like "(1)" (regression: garbled text)', async () => {
		expect(await isCesvuZip(fileOf('cesvu-document_cesvu (1).zip', ZIP_BYTES))).toBe(true);
		expect(await isCesvuZip(fileOf('renamed.zip', ZIP_BYTES))).toBe(true);
	});

	it('rejects office files, which are zips with a different extension', async () => {
		expect(await isCesvuZip(fileOf('report.docx', ZIP_BYTES))).toBe(false);
		expect(await isCesvuZip(fileOf('sheet.xlsx', ZIP_BYTES))).toBe(false);
	});

	it('rejects a .zip name whose content is not a zip', async () => {
		expect(await isCesvuZip(fileOf('fake.zip', 'just text'))).toBe(false);
	});
});
