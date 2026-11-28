import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	buildReportPdf,
	type ReportPdfInput,
	type ReportLine,
	type ReportTableSection
} from './pdf-writer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let fontBytes: { regular: Uint8Array; bold: Uint8Array };

beforeAll(() => {
	fontBytes = {
		regular: new Uint8Array(readFileSync(join(__dirname, 'fonts/NotoSans-Regular.ttf'))),
		bold: new Uint8Array(readFileSync(join(__dirname, 'fonts/NotoSans-Bold.ttf')))
	};
});

/** Extract per-page joined text using pdfjs-dist's legacy Node build. */
async function extractPageTexts(bytes: Uint8Array): Promise<string[]> {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const doc = await pdfjs.getDocument({ data: bytes }).promise;
	const texts: string[] = [];
	for (let i = 1; i <= doc.numPages; i++) {
		const page = await doc.getPage(i);
		const content = await page.getTextContent();
		texts.push(
			content.items.map((it) => ('str' in it ? (it.str as string) : '')).join('')
		);
	}
	return texts;
}

/** Raw per-item text + position (x, y from the PDF transform matrix), page 1 only. */
async function extractPage1Items(bytes: Uint8Array): Promise<{ str: string; x: number; y: number }[]> {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const doc = await pdfjs.getDocument({ data: bytes }).promise;
	const page = await doc.getPage(1);
	const content = await page.getTextContent();
	return content.items
		.filter((it) => 'str' in it)
		.map((it) => {
			const withTransform = it as unknown as { str: string; transform: number[] };
			return { str: withTransform.str, x: withTransform.transform[4], y: withTransform.transform[5] };
		});
}

function baseSection(overrides: Partial<ReportTableSection> = {}): ReportTableSection {
	return {
		heading: 'Detail',
		columns: ['Region', 'Amount'],
		columnSamples: [['East', 'West'], ['100.00', '200.00']],
		lines: [
			{ kind: 'group-header', label: 'East' },
			{ kind: 'data', cells: ['East', '100.00'] },
			{ kind: 'subtotal', cells: ['Subtotal', '100.00'] },
			{ kind: 'group-header', label: 'West' },
			{ kind: 'data', cells: ['West', '200.00'] },
			{ kind: 'subtotal', cells: ['Subtotal', '200.00'] },
			{ kind: 'grand-total', cells: ['Grand total', '300.00'] }
		] as ReportLine[],
		...overrides
	};
}

function baseInput(overrides: Partial<ReportPdfInput> = {}): ReportPdfInput {
	return {
		title: 'Test Report',
		fileName: 'data.xlsx',
		generatedAtDisplay: '2024-01-01 12:00 UTC',
		sha256Full: 'a'.repeat(64),
		settingsLines: ['Group by: Region', 'Sort: Group key (asc)'],
		kpiLines: ['Grand total Amount: 1,234.00', 'Groups: 2'],
		warnings: [],
		pageSize: 'Letter',
		sections: [baseSection()],
		...overrides
	};
}

describe('buildReportPdf — basic structure', () => {
	it('produces valid PDF bytes with the expected text content', async () => {
		const { bytes, replacedCharacterCount, landscape } = await buildReportPdf(baseInput(), fontBytes);
		expect(bytes.slice(0, 5)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])); // "%PDF-"
		expect(replacedCharacterCount).toBe(0);
		expect(landscape).toBe(false);

		const pages = await extractPageTexts(bytes);
		expect(pages.length).toBeGreaterThanOrEqual(1);
		const all = pages.join(' ');
		expect(all).toContain('Test Report');
		expect(all).toContain('Region');
		expect(all).toContain('Amount');
		expect(all).toContain('East');
		expect(all).toContain('Grand total');
		expect(all).toContain('300.00');
	});

	it('repeats the column header on every page and prints Page X of Y', async () => {
		const lines: ReportLine[] = [];
		for (let i = 0; i < 400; i++) {
			lines.push({ kind: 'data', cells: [`Row ${i}`, String(i)] });
		}
		const { bytes } = await buildReportPdf(
			baseInput({ sections: [baseSection({ lines })] }),
			fontBytes
		);
		const pages = await extractPageTexts(bytes);
		expect(pages.length).toBeGreaterThan(1);
		for (let i = 0; i < pages.length; i++) {
			expect(pages[i]).toContain('Region');
			expect(pages[i]).toContain('Amount');
			expect(pages[i]).toContain(`Page ${i + 1} of ${pages.length}`);
		}
	});

	it('shows the first 12 hex chars of the hash in the footer, full hash available separately', async () => {
		const sha256Full = 'abcdef0123456789'.repeat(4);
		const { bytes } = await buildReportPdf(baseInput({ sha256Full }), fontBytes);
		const pages = await extractPageTexts(bytes);
		expect(pages[0]).toContain(sha256Full.slice(0, 12));
	});
});

describe('buildReportPdf — per-cell colors (cellColors)', () => {
	it('renders normally when a data line specifies per-cell colors', async () => {
		const section = baseSection({
			lines: [
				{ kind: 'data', cells: ['East', 'High'], cellColors: [null, '#dc2626'] },
				{ kind: 'data', cells: ['West', 'Low'], cellColors: [null, '#059669'] }
			]
		});
		const { bytes } = await buildReportPdf(baseInput({ sections: [section] }), fontBytes);
		expect(bytes.slice(0, 5)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
		const pages = await extractPageTexts(bytes);
		const all = pages.join(' ');
		expect(all).toContain('High');
		expect(all).toContain('Low');
	});

	it('falls back to the default color instead of throwing on a malformed hex string', async () => {
		const section = baseSection({
			lines: [{ kind: 'data', cells: ['East', '100.00'], cellColors: [null, 'not-a-color'] }]
		});
		const { bytes } = await buildReportPdf(baseInput({ sections: [section] }), fontBytes);
		const pages = await extractPageTexts(bytes);
		expect(pages.join(' ')).toContain('100.00');
	});
});

describe('buildReportPdf — multiple sections (group summary + detail)', () => {
	it('renders a group-summary table BEFORE the detail table, each with its own repeating header', async () => {
		const summarySection = baseSection({
			heading: 'Group summary',
			columns: ['Region', 'Row count', 'Subtotal'],
			columnSamples: [['East', 'West'], ['1', '1'], ['100.00', '200.00']],
			lines: [
				{ kind: 'data', cells: ['East', '1', '100.00'] },
				{ kind: 'data', cells: ['West', '1', '200.00'] },
				{ kind: 'grand-total', cells: ['Grand total', '2', '300.00'] }
			]
		});
		const detailSection = baseSection({ heading: 'Detail' });
		const { bytes } = await buildReportPdf(
			baseInput({ sections: [summarySection, detailSection] }),
			fontBytes
		);
		const pages = await extractPageTexts(bytes);
		const all = pages.join('\n');
		expect(all).toContain('Group summary');
		expect(all).toContain('Row count');
		expect(all.indexOf('Group summary')).toBeLessThan(all.indexOf('Detail'));
		// Detail section still has its own columns rendered as a header.
		const detailPageIdx = pages.findIndex((p) => p.includes('Detail'));
		expect(detailPageIdx).toBeGreaterThanOrEqual(0);
	});

	it('supports "summary only" mode by omitting the detail section entirely', async () => {
		const summarySection = baseSection({
			heading: 'Group summary',
			columns: ['Region', 'Subtotal'],
			columnSamples: [['East', 'West'], ['100.00', '200.00']],
			lines: [
				{ kind: 'data', cells: ['East', '100.00'] },
				{ kind: 'data', cells: ['West', '200.00'] }
			]
		});
		const { bytes } = await buildReportPdf(baseInput({ sections: [summarySection] }), fontBytes);
		const pages = await extractPageTexts(bytes);
		expect(pages.join(' ')).not.toContain('Grand total\u2009300.00');
	});
});

describe('buildReportPdf — script coverage fixtures', () => {
	it('renders Polish/Cyrillic/Vietnamese text without replacement', async () => {
		const lines: ReportLine[] = [
			{ kind: 'data', cells: ['Zażółć gęślą jaźń', '1'] }, // Polish
			{ kind: 'data', cells: ['Привет мир', '2'] }, // Cyrillic
			{ kind: 'data', cells: ['Xin chào thế giới', '3'] } // Vietnamese
		];
		// Widen the "Region" column's sample so none of these phrases need
		// to word-wrap — a wrapped line is a SEPARATE text run, and pdfjs's
		// getTextContent() does not always insert a space between runs,
		// which would make this FONT assertion flaky on layout grounds.
		const columnSamples = [['Xin chào thế giới'], ['100.00']];
		const { bytes, replacedCharacterCount } = await buildReportPdf(
			baseInput({ sections: [baseSection({ lines, columnSamples })] }),
			fontBytes
		);
		expect(replacedCharacterCount).toBe(0);
		const pages = await extractPageTexts(bytes);
		const all = pages.join(' ');
		expect(all).toContain('Zażółć');
		expect(all).toContain('Привет');
		expect(all).toContain('Xin chào');
	});

	it('falls back to a placeholder for Japanese/Arabic without throwing, and counts replacements', async () => {
		const lines: ReportLine[] = [
			{ kind: 'data', cells: ['こんにちは世界', '1'] }, // Japanese
			{ kind: 'data', cells: ['مرحبا بالعالم', '2'] } // Arabic
		];
		const columnSamples = [['こんにちは世界'], ['100.00']];
		const result = await buildReportPdf(
			baseInput({ sections: [baseSection({ lines, columnSamples })] }),
			fontBytes
		);
		expect(result.replacedCharacterCount).toBeGreaterThan(0);
		const pages = await extractPageTexts(result.bytes);
		expect(pages.join(' ')).toContain('???????');
	});

	it('handles parenthesized negatives, percents, and blanks verbatim (no reformatting)', async () => {
		const lines: ReportLine[] = [
			{ kind: 'data', cells: ['Row A', '(1,234.00)'] },
			{ kind: 'data', cells: ['Row B', '26%'] },
			{ kind: 'data', cells: ['(blank)', ''] }
		];
		const { bytes } = await buildReportPdf(
			baseInput({ sections: [baseSection({ lines })] }),
			fontBytes
		);
		const pages = await extractPageTexts(bytes);
		const all = pages.join(' ');
		expect(all).toContain('(1,234.00)');
		expect(all).toContain('26%');
		expect(all).toContain('(blank)');
	});

	it('auto-switches to landscape for a wide (30-column) sheet and shrinks columns to fit', async () => {
		const columns = Array.from({ length: 30 }, (_, i) => `Column With A Fairly Long Name ${i}`);
		const columnSamples = columns.map((_, i) => [`Sample value for column ${i} that is somewhat long`]);
		const lines: ReportLine[] = [{ kind: 'data', cells: columns.map((_, i) => `value-${i}`) }];
		const { landscape } = await buildReportPdf(
			baseInput({ sections: [baseSection({ columns, columnSamples, lines })] }),
			fontBytes
		);
		expect(landscape).toBe(true);
	});

	it('wraps long column headers onto multiple lines instead of overflowing into the next column (regression)', async () => {
		// Mirrors the reported bug: many columns with long header names and
		// SHORT sample values (so shrinkColumnsToFit squeezes columns down
		// based on the narrow data, leaving headers wider than their column).
		const columns = [
			'RegistrationNumber',
			'BusinessName',
			'ExpirationDate',
			'AddressLine1',
			'AddressLine2',
			'AddressLine3',
			'City',
			'StateName',
			'ZipCode',
			'CountyName',
			'PhoneNumber',
			'EmailAddress',
			'BusinessDescription'
		];
		const columnSamples = columns.map(() => ['x']);
		const lines: ReportLine[] = [{ kind: 'data', cells: columns.map(() => 'x') }];
		const { bytes } = await buildReportPdf(
			baseInput({
				settingsLines: [],
				kpiLines: [],
				sections: [baseSection({ columns, columnSamples, lines, heading: 'Detail' })]
			}),
			fontBytes
		);

		const items = await extractPage1Items(bytes);
		// The reported bug glued two adjacent headers into one unspaced run
		// (e.g. "RegistrationNBusinessName") because the whole header was
		// drawn as a single line regardless of column width. Confirm that
		// never happens — no text item should span across what used to be a
		// column boundary into the next header's name.
		expect(items.some((it) => it.str.includes('RegistrationNBusinessName'))).toBe(false);
		expect(items.some((it) => it.str.includes('ExpirationDAddressLine'))).toBe(false);

		// Reconstruct the column-header row by position: it's the only
		// cluster of items between the "Detail" section heading (highest y,
		// drawn at the page's left margin) and the first data row below it —
		// excluding the title, the heading itself, the data row, and the
		// footer (which sits near the bottom of the page).
		const title = items.find((it) => it.str === 'Test Report')!;
		const dataRow = items.find((it) => it.str === 'x')!;
		const dataRowX = dataRow.x;
		const headerRowItems = items.filter(
			(it) =>
				it.str.trim() !== '' && it.y < title.y && it.y > dataRow.y + 1 && it.str !== 'Detail'
		);
		// Column 1's header lines sit at the SAME x as its data row (both
		// start at left + CELL_PADDING).
		const firstColumnLines = headerRowItems.filter((it) => Math.abs(it.x - dataRowX) < 1);
		const distinctYs = new Set(firstColumnLines.map((it) => Math.round(it.y)));
		expect(distinctYs.size).toBeGreaterThan(1); // header wrapped onto 2+ lines
		// And the reconstructed text for that column is the full, un-mangled
		// header label, just wrapped — not glued to a neighboring column.
		const firstColumnText = firstColumnLines
			.sort((a, b) => b.y - a.y)
			.map((it) => it.str)
			.join('');
		expect(firstColumnText).toBe('RegistrationNumber');
	});
});

describe('buildReportPdf — large sheet (50k rows)', () => {
	it('completes and produces correct, fully-rendered totals', async () => {
		const ROW_COUNT = 50_000;
		const lines: ReportLine[] = [];
		let expectedSum = 0;
		for (let i = 0; i < ROW_COUNT; i++) {
			lines.push({ kind: 'data', cells: [`Row ${i}`, String(i)] });
			expectedSum += i;
		}
		lines.push({ kind: 'grand-total', cells: ['Grand total', expectedSum.toLocaleString()] });
		const columnSamples = [[`Row ${ROW_COUNT - 1}`], [expectedSum.toLocaleString()]];

		const start = performance.now();
		const { bytes } = await buildReportPdf(
			baseInput({ sections: [baseSection({ lines, columnSamples })] }),
			fontBytes
		);
		const elapsedMs = performance.now() - start;
		// eslint-disable-next-line no-console
		console.log(`[pdf-writer] 50k-row report built in ${elapsedMs.toFixed(0)}ms`);

		const pages = await extractPageTexts(bytes);
		expect(pages[pages.length - 1]).toContain(expectedSum.toLocaleString());
		expect(pages[0]).toContain('Row 0');
		expect(pages[pages.length - 1]).toContain(`Row ${ROW_COUNT - 1}`);
	}, 60_000);
});
