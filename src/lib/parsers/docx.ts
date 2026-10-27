/**
 * src/lib/parsers/docx.ts — DOCX parser (two independent outputs, zero heuristics)
 *
 * DOCX has semantic structure built in, so there's no need for canvas rendering
 * or heading-guessing. We use mammoth.js with two outputs:
 *
 *   1. DISPLAY pipeline — mammoth.convertToHtml() → styled HTML. Headings, bold,
 *      tables, and lists render natively as DOM. Text selection works without any
 *      text layer because it's just DOM text.
 *
 *   2. AI pipeline — mammoth.convertToMarkdown() → markdown. Preserves headings
 *      (#, ##), lists (-), tables (| |), and bold/italic. The model understands
 *      markdown natively.
 *
 * Stored on StructuredText as:
 *   - text: markdown (what the AI pipeline / compressFile consumes)
 *   - html: display HTML (what DocumentPane renders)
 *
 * Both outputs are passed through a single defensive sanitizer so that if either
 * is ever rendered as HTML (preview, export, etc.) it carries nothing executable
 * or embedded as inline base64.
 */

import type { ParsedFile, StructuredText } from '$lib/types.js';

/**
 * Defensive sanitizer — strips anything executable or heavyweight-embedded.
 * Runs over BOTH the HTML and the markdown so neither can smuggle a script,
 * an inline base64 blob, or an event-handler attribute into any later render.
 *
 * This is not a full HTML sanitizer (the input is the user's own local file and
 * mammoth already emits a constrained tag subset) — it's a belt-and-suspenders
 * pass for our local-first model.
 */
export function sanitize(input: string): string {
	return input
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // script blocks
		.replace(/<img[^>]*>/gi, '')                        // images (incl. base64)
		.replace(/\bon\w+\s*=\s*"[^"]*"/gi, '')             // event handlers (double-quoted)
		.replace(/\bon\w+\s*=\s*'[^']*'/gi, '')             // event handlers (single-quoted)
		.replace(/data:[^;]+;base64[^"'\s)]*/gi, '');       // inline base64 payloads
}

/**
 * Core DOCX parse, operating directly on an owned byte buffer.
 *
 * `rawContent` becomes the ParsedFile's stored bytes verbatim (no copy).
 * Mammoth is called twice (HTML + Markdown) — each call gets its OWN
 * `.slice(0)` copy since mammoth may consume/detach the ArrayBuffer it's
 * handed, and `rawContent` itself must stay intact for storage/display.
 */
async function parseDOCXCore(
	rawContent: ArrayBuffer,
	name: string,
	size: number
): Promise<ParsedFile> {
	if (size === 0) {
		throw new Error('File is empty');
	}

	const mammoth = await import('mammoth');

	// `convertToMarkdown` exists at runtime but is missing from mammoth's bundled
	// type declarations — narrow to the function we need without using `any`.
	const mammothMd = mammoth as unknown as {
		convertToMarkdown(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
	};

	// Two outputs from the same file. Slice the buffer per call because mammoth
	// may consume/detach the ArrayBuffer it's handed.
	const htmlResult = await mammoth.convertToHtml({ arrayBuffer: rawContent.slice(0) });
	const markdownResult = await mammothMd.convertToMarkdown({ arrayBuffer: rawContent.slice(0) });


	const html = sanitize(htmlResult.value.trim());
	const markdown = sanitize(markdownResult.value.trim());

	if (!markdown && !html) {
		throw new Error('No text content found in DOCX file');
	}

	const structuredText: StructuredText = {
		// `text` IS the markdown for DOCX — the AI pipeline reads this.
		text: markdown,
		// `html` is purely for display.
		html
	};

	return {
		type: 'docx',
		name,
		size,
		rawContent,
		parsedData: structuredText
	};
}

/**
 * Parse a DOCX from an already-owned, exclusive `Uint8Array` (e.g. bytes
 * just decrypted from a .cesvu import). Skips the `new File([bytes])` +
 * `file.arrayBuffer()` round-trip entirely — that round-trip makes TWO
 * extra full copies of the document (one into the Blob's internal storage,
 * one reading it back out) on top of mammoth's own two conversion-buffer
 * copies, which is exactly the kind of redundant allocation that can push a
 * large DOCX over mobile Safari's much tighter per-tab memory ceiling.
 */
export async function parseDOCXBytes(
	bytes: Uint8Array,
	name: string,
	size?: number
): Promise<ParsedFile> {
	const rawContent: ArrayBuffer =
		bytes.byteOffset === 0 &&
		bytes.byteLength === bytes.buffer.byteLength &&
		bytes.buffer instanceof ArrayBuffer
			? bytes.buffer
			: (bytes.slice().buffer as ArrayBuffer);
	return parseDOCXCore(rawContent, name, size ?? bytes.byteLength);
}

export async function parseDOCX(file: File): Promise<ParsedFile> {
	const rawContent = await file.arrayBuffer();
	return parseDOCXCore(rawContent, file.name, file.size);
}


