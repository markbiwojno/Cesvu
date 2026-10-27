/**
 * src/lib/parsers/pdf.ts — PDF text extraction (flat, reading-order)
 *
 * Production-style approach (how ChatGPT, Claude, and most PDF tools do it):
 *   - Render is handled separately by the viewer (canvas + invisible text layer).
 *   - Here we only extract FLAT text per page: sort items by Y then X, join with
 *     spaces. No paragraph detection, no heading heuristics, no column detection.
 *     Just the words in reading order.
 *
 * Output (StructuredText):
 *   - pages:     PdfPageText[]  — { pageNumber, text } per page
 *   - text:      all pages joined for downstream pipeline/LLM
 *   - pageCount: total pages
 *
 * The canvas/visual pipeline lives in the viewer (PdfViewer.svelte) and reads the
 * raw bytes (`rawContent`) directly — display and AI text are two separate pipelines.
 */

import type { ParsedFile, StructuredText, PdfPageText } from '$lib/types.js';

interface RawTextItem {
	str: string;
	transform: number[];
	/** pdf.js sets this true at soft line ends */
	hasEOL?: boolean;
}

/**
 * Sort one page's text items into reading order (top→bottom, then left→right)
 * and join into a single flat string.
 *
 * pdf.js gives a 6-element transform [a, b, c, d, e, f] where e = x (left) and
 * f = y (baseline, origin bottom-left). Larger y = higher on the page.
 */
export function pageItemsToText(items: RawTextItem[]): string {
	const positioned = items
		.filter((it) => typeof it.str === 'string' && it.str.length > 0)
		.map((it) => ({
			str: it.str,
			x: it.transform?.[4] ?? 0,
			y: it.transform?.[5] ?? 0
		}));

	if (positioned.length === 0) return '';

	// Group into lines by Y (small tolerance), then order lines top→bottom and
	// fragments within a line left→right.
	const Y_TOLERANCE = 2; // points
	positioned.sort((a, b) => (Math.abs(a.y - b.y) > Y_TOLERANCE ? b.y - a.y : a.x - b.x));

	const lines: string[] = [];
	let currentY = positioned[0].y;
	let current: { str: string; x: number }[] = [];

	const flush = () => {
		if (current.length === 0) return;
		current.sort((a, b) => a.x - b.x);
		lines.push(current.map((c) => c.str).join(' ').replace(/\s+/g, ' ').trim());
		current = [];
	};

	for (const item of positioned) {
		if (current.length === 0 || Math.abs(item.y - currentY) <= Y_TOLERANCE) {
			current.push({ str: item.str, x: item.x });
			if (current.length === 1) currentY = item.y;
		} else {
			flush();
			current = [{ str: item.str, x: item.x }];
			currentY = item.y;
		}
	}
	flush();

	return lines.filter((l) => l.length > 0).join('\n').trim();
}

/**
 * Join per-page texts into a single AI-context string with page references:
 *   Page 1:\n[text]\n\nPage 2:\n[text]...
 * The model can then cite page numbers in its responses.
 */
export function buildPdfAiContext(pages: PdfPageText[]): string {
	return pages
		.map((p) => `Page ${p.pageNumber}:\n${p.text}`)
		.join('\n\n')
		.trim();
}

/**
 * Core PDF parse, operating directly on an owned byte buffer.
 *
 * `rawContent` becomes the ParsedFile's stored bytes verbatim (no copy) —
 * callers that already own an exclusive buffer (e.g. bytes just decrypted
 * from a .cesvu import) should call this directly instead of round-tripping
 * through a `File` (which would copy the bytes at least twice: once into the
 * Blob's internal storage, once again via `file.arrayBuffer()`).
 *
 * unpdf/pdf.js may detach the ArrayBuffer it's handed, so we still make ONE
 * defensive copy (`rawContent.slice(0)`) for pdf.js's own consumption —
 * `rawContent` itself stays intact for storage/display.
 */
async function parsePDFCore(
	rawContent: ArrayBuffer,
	name: string,
	size: number
): Promise<ParsedFile> {
	if (size === 0) {
		throw new Error('File is empty');
	}

	// unpdf bundles its own pdf.js build and resolves the worker internally.
	const { getDocumentProxy } = await import('unpdf');

	// unpdf/pdf.js may detach the buffer — hand it a copy, not the original.
	const pdf = await getDocumentProxy(new Uint8Array(rawContent.slice(0)));

	const numPages: number = pdf.numPages;
	const pages: PdfPageText[] = [];

	for (let pageNum = 1; pageNum <= numPages; pageNum++) {
		const page = await pdf.getPage(pageNum);
		const content = await page.getTextContent();
		const items = (content.items as unknown[]).filter(
			(it): it is RawTextItem => !!it && typeof (it as { str?: unknown }).str === 'string'
		);
		pages.push({ pageNumber: pageNum, text: pageItemsToText(items) });
	}

	const fullText = buildPdfAiContext(pages);

	if (!fullText) {
		throw new Error(
			'No extractable text found in PDF (it may be scanned images — OCR is not supported in v1)'
		);
	}

	const structuredText: StructuredText = {
		text: fullText,
		pageCount: numPages,
		pages
	};

	return {
		type: 'pdf',
		name,
		size,
		rawContent,
		parsedData: structuredText
	};
}

/**
 * Parse a PDF from an already-owned, exclusive `Uint8Array`/`ArrayBuffer`
 * (e.g. bytes just decrypted from a .cesvu import). Skips the
 * `new File([bytes])` + `file.arrayBuffer()` round-trip entirely — that
 * round-trip makes TWO extra full copies of the PDF (one into the Blob's
 * internal storage, one reading it back out), which is exactly the kind of
 * redundant allocation that can push a large PDF over mobile Safari's much
 * tighter per-tab memory ceiling.
 */
export async function parsePDFBytes(
	bytes: Uint8Array,
	name: string,
	size?: number
): Promise<ParsedFile> {
	// Normalize to a plain ArrayBuffer view starting at byte 0 — subarray()
	// views (e.g. from a .cesvu import's decoded payload) may have a
	// non-zero byteOffset or not span the whole underlying buffer.
	const rawContent: ArrayBuffer =
		bytes.byteOffset === 0 &&
		bytes.byteLength === bytes.buffer.byteLength &&
		bytes.buffer instanceof ArrayBuffer
			? bytes.buffer
			: (bytes.slice().buffer as ArrayBuffer);
	return parsePDFCore(rawContent, name, size ?? bytes.byteLength);
}

export async function parsePDF(file: File): Promise<ParsedFile> {
	const rawContent = await file.arrayBuffer();
	return parsePDFCore(rawContent, file.name, file.size);
}


