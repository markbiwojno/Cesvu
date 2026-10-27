/**
 * src/lib/parsers/md.ts — Markdown file parser
 *
 * Reads the file as UTF-8 text. Strips markdown formatting to produce
 * a plain-text rawContent for LLM consumption, while preserving the
 * original markdown in parsedData.markdown for rendering.
 */

import type { ParsedFile } from '$lib/types.js';

/**
 * Strip common markdown formatting to produce plain text.
 * Handles: headings, bold, italic, code blocks, inline code,
 * links, images, blockquotes, horizontal rules, lists.
 */
function stripMarkdown(md: string): string {
	return md
		// Fenced code blocks → keep content, remove fences
		.replace(/```[\w]*\n([\s\S]*?)```/g, '$1')
		// Inline code
		.replace(/`([^`]+)`/g, '$1')
		// ATX headings (# ## ### etc.)
		.replace(/^#{1,6}\s+(.+)$/gm, '$1')
		// Bold + italic ***text***
		.replace(/\*{3}(.+?)\*{3}/g, '$1')
		// Bold **text** or __text__
		.replace(/(\*{2}|_{2})(.+?)\1/g, '$2')
		// Italic *text* or _text_
		.replace(/(\*|_)(.+?)\1/g, '$2')
		// Strikethrough ~~text~~
		.replace(/~~(.+?)~~/g, '$1')
		// Images ![alt](url) → alt text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		// Links [text](url) → text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		// Reference links [text][ref] → text
		.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
		// Blockquotes
		.replace(/^>\s?/gm, '')
		// Horizontal rules
		.replace(/^[-*_]{3,}\s*$/gm, '')
		// Unordered list markers
		.replace(/^[\s]*[-*+]\s+/gm, '')
		// Ordered list markers
		.replace(/^[\s]*\d+\.\s+/gm, '')
		// HTML tags
		.replace(/<[^>]+>/g, '')
		// Multiple blank lines → single blank line
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export async function parseMD(file: File): Promise<ParsedFile & { markdown: string }> {
	if (file.size === 0) {
		throw new Error('File is empty');
	}

	const rawContent = await file.arrayBuffer();
	const markdown = new TextDecoder('utf-8').decode(rawContent);
	const plainText = stripMarkdown(markdown);

	return {
		type: 'md',
		name: file.name,
		size: file.size,
		rawContent,
		parsedData: plainText,
		markdown  // original markdown preserved for rendering
	};
}
