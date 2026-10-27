import { describe, it, expect } from 'vitest';
import { buildCesvuDownloadName, DEFAULT_CESVU_DOWNLOAD_NAME } from './cesvu-filename.js';

describe('DEFAULT_CESVU_DOWNLOAD_NAME', () => {
	// ExportModal.svelte returns this constant DIRECTLY as the download name
	// for every viewer export, so its value is user-visible behavior, not an
	// implementation detail. Pinned here because it has regressed once
	// already: commit d0cdb49 replaced the hardcoded 'cesvu-document.cesvu'
	// with a name derived from the source document, which leaked the
	// document's subject matter via the unencrypted outer filename.
	it('is the generic, non-identifying name', () => {
		expect(DEFAULT_CESVU_DOWNLOAD_NAME).toBe('cesvu-document.cesvu');
	});

	it('is what buildCesvuDownloadName falls back to', () => {
		expect(buildCesvuDownloadName(null)).toBe(DEFAULT_CESVU_DOWNLOAD_NAME);
	});
});

describe('buildCesvuDownloadName', () => {
	it('strips a single trailing extension and appends .cesvu', () => {
		expect(buildCesvuDownloadName('quarterly-report.pdf')).toBe('quarterly-report.cesvu');
	});

	it('never produces the old doubled-extension form', () => {
		expect(buildCesvuDownloadName('passport-scan.jpg')).not.toBe('passport-scan.jpg.cesvu');
	});

	it('strips exactly one suffix for multi-dot names', () => {
		expect(buildCesvuDownloadName('archive.tar.gz')).toBe('archive.tar.cesvu');
	});

	it('leaves a dotfile with no other content fully intact', () => {
		expect(buildCesvuDownloadName('.gitignore')).toBe('.gitignore.cesvu');
	});

	it('handles a name with no extension at all', () => {
		expect(buildCesvuDownloadName('README')).toBe('README.cesvu');
	});

	it('strips path-like components, keeping only the last segment', () => {
		expect(buildCesvuDownloadName('folder/subfolder/report.pdf')).toBe('report.cesvu');
		expect(buildCesvuDownloadName('C:\\Users\\me\\report.pdf')).toBe('report.cesvu');
	});

	it('falls back to the default generic name when input is missing/empty', () => {
		expect(buildCesvuDownloadName(null)).toBe('cesvu-document.cesvu');
		expect(buildCesvuDownloadName(undefined)).toBe('cesvu-document.cesvu');
		expect(buildCesvuDownloadName('')).toBe('cesvu-document.cesvu');
	});

	it('supports a custom fallback', () => {
		expect(buildCesvuDownloadName(null, 'vault.cesvu')).toBe('vault.cesvu');
	});

	it('sanitizes unsafe characters', () => {
		expect(buildCesvuDownloadName('weird:name?.txt')).toBe('weird_name_.cesvu');
	});

	it('falls back when nothing safe remains after sanitizing', () => {
		// Trailing path separators leave an empty last segment once split.
		expect(buildCesvuDownloadName('////')).toBe('cesvu-document.cesvu');
	});

});
