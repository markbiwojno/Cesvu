import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildColumnVisualPdf, type ColumnVisualPdfInput, type ColumnVisualInput } from './pdf-writer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let fontBytes: { regular: Uint8Array; bold: Uint8Array };

beforeAll(() => {
	fontBytes = {
		regular: new Uint8Array(readFileSync(join(__dirname, 'fonts/NotoSans-Regular.ttf'))),
		bold: new Uint8Array(readFileSync(join(__dirname, 'fonts/NotoSans-Bold.ttf')))
	};
});

async function extractPageTexts(bytes: Uint8Array): Promise<string[]> {
	const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const doc = await pdfjs.getDocument({ data: bytes }).promise;
	const texts: string[] = [];
	for (let i = 1; i <= doc.numPages; i++) {
		const page = await doc.getPage(i);
		const content = await page.getTextContent();
		texts.push(content.items.map((it) => ('str' in it ? (it.str as string) : '')).join(''));
	}
	return texts;
}

/** A tiny valid 1x1 red PNG (base64-decoded), used as a stand-in chart image. */
const TINY_PNG = Uint8Array.from(
	atob(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
	),
	(c) => c.charCodeAt(0)
);

function column(name: string, overrides: Partial<ColumnVisualInput> = {}): ColumnVisualInput {
	return {
		column: name,
		title: name,
		chartPng: TINY_PNG,
		chartWidth: 640,
		chartHeight: 300,
		statSummary: `stats for ${name}`,
		...overrides
	};
}

function baseInput(overrides: Partial<ColumnVisualPdfInput> = {}): ColumnVisualPdfInput {
	return {
		title: 'Test Column Visual Analysis',
		fileName: 'data.xlsx',
		generatedAtDisplay: '2024-01-01 12:00 UTC',
		sha256Full: 'b'.repeat(64),
		pageSize: 'Letter',
		columns: [column('A'), column('B'), column('C')],
		...overrides
	};
}

describe('buildColumnVisualPdf', () => {
	it('produces valid PDF bytes with every column title + stat summary present', async () => {
		const { bytes, landscape } = await buildColumnVisualPdf(baseInput(), fontBytes);
		expect(bytes.slice(0, 5)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
		expect(landscape).toBe(false);
		const pages = await extractPageTexts(bytes);
		const all = pages.join(' ');
		expect(all).toContain('Test Column Visual Analysis');
		expect(all).toContain('A');
		expect(all).toContain('stats for A');
		expect(all).toContain('stats for C');
	});

	it('packs exactly 3 charts per page, spilling extras onto new pages', async () => {
		const columns = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((n) => column(n));
		const { bytes } = await buildColumnVisualPdf(baseInput({ columns }), fontBytes);
		const pages = await extractPageTexts(bytes);
		// 7 columns / 3 per page = pages for A-C, D-F, G → 3 pages.
		expect(pages).toHaveLength(3);
		expect(pages[0]).toContain('A');
		expect(pages[0]).toContain('B');
		expect(pages[0]).toContain('C');
		expect(pages[1]).toContain('D');
		expect(pages[1]).toContain('E');
		expect(pages[1]).toContain('F');
		expect(pages[2]).toContain('G');
		expect(pages[0]).not.toContain('D');
	});

	it('falls back to a placeholder message when a column has no chart image', async () => {
		const columns = [column('A', { chartPng: null, chartWidth: 0, chartHeight: 0 })];
		const { bytes } = await buildColumnVisualPdf(baseInput({ columns }), fontBytes);
		const pages = await extractPageTexts(bytes);
		expect(pages.join(' ')).toContain('No chart available for this column.');
	});

	it('reports progress once per column drawn', async () => {
		const columns = ['A', 'B', 'C', 'D'].map((n) => column(n));
		const calls: Array<[number, number]> = [];
		await buildColumnVisualPdf(baseInput({ columns }), fontBytes, (drawn, total) => {
			calls.push([drawn, total]);
		});
		expect(calls).toEqual([
			[1, 4],
			[2, 4],
			[3, 4],
			[4, 4]
		]);
	});

	it('prints the footer (filename, hash, page X of Y) on every page', async () => {
		const columns = ['A', 'B', 'C', 'D'].map((n) => column(n));
		const { bytes } = await buildColumnVisualPdf(baseInput({ columns }), fontBytes);
		const pages = await extractPageTexts(bytes);
		expect(pages).toHaveLength(2);
		for (const p of pages) {
			expect(p).toContain('data.xlsx');
			expect(p).toContain('SHA-256');
		}
		expect(pages[0]).toContain('Page 1 of 2');
		expect(pages[1]).toContain('Page 2 of 2');
	});
});
