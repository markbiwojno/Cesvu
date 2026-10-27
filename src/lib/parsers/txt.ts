/**
 * src/lib/parsers/txt.ts — Plain text file parser
 *
 * Reads the file as UTF-8 text using the native File API.
 * No external dependencies.
 */

import type { ParsedFile } from '$lib/types.js';

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
