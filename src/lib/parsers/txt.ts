/**
 * src/lib/parsers/txt.ts — Plain text file parser
 *
 * Reads the file as UTF-8 text using the native File API.
 * No external dependencies.
 */

import type { ParsedFile } from '$lib/types.js';

/**
 * Heuristic: does this decoded text look like binary data that was
 * mis-decoded as UTF-8? Real text never contains NUL bytes, and invalid
 * UTF-8 sequences decode to U+FFFD. Used by parseFile()'s last-resort
 * "unknown type → read as text" branch so an unsupported binary file (e.g. a
 * zip) is rejected with a clear error instead of rendering garbled text.
 */
export function looksBinary(text: string): boolean {
	if (text.length === 0) return false;
	const sample = text.length > 8192 ? text.slice(0, 8192) : text;
	if (sample.includes('\u0000')) return true;
	let replacement = 0;
	for (let i = 0; i < sample.length; i++) {
		if (sample.charCodeAt(i) === 0xfffd) replacement++;
	}
	return replacement / sample.length > 0.02;
}

export async function parseTXT(file: File): Promise<ParsedFile> {
	if (file.size === 0) {
		throw new Error('File is empty');
	}

	const rawContent = await file.arrayBuffer();
	const text = new TextDecoder('utf-8').decode(rawContent).trim();

	return {
		type: 'txt',
		name: file.name,
		size: file.size,
		rawContent,
		parsedData: text
	};
}
