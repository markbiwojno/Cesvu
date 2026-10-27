/**
 * src/lib/utils/parsed-file-to-document.ts — turn a freshly-parsed
 * {@link ParsedFile} (the output of `parseFile()`) into the init fields
 * {@link createDocument} expects.
 *
 * Extracted from Workspace.svelte's private `fileText()` / `fileSourceType()`
 * / `rawContentBytes()` helpers (used by `openExport()`'s `beginContract()`
 * call) so any OTHER call site that needs to turn a re-parsed file into a
 * CesvuDocument — e.g. ImportModal.svelte's "Choose a file to send back",
 * which re-parses a viewer-supported file the user picks so the REPLY can be
 * document-framed (CFP1) and therefore reopen in the viewer, instead of
 * falling back to the raw/unframed vault path meant for viewer-unsupported
 * types — shares the exact same mapping instead of re-deriving it.
 */

import type { ParsedFile } from '$lib/types.js';
import type { SourceType } from '$lib/schema.js';

/** Extract the plain-text body a CesvuDocument's `text` field expects.
 *  csv/excel have no plain-text body — the envelope still carries the name
 *  and, separately, the raw bytes for a full round-trip. */
function fileText(f: ParsedFile): string {
	if (f.type === 'txt' || f.type === 'md') return (f.parsedData as string) ?? '';
	if (f.type === 'pdf' || f.type === 'docx') return (f.parsedData as { text?: string }).text ?? '';
	return '';
}

/** Map the parser's file type onto the CesvuDocument sourceType — the two
 *  enums share the same six values by design (see schema.ts). */
function fileSourceType(f: ParsedFile): SourceType {
	return f.type;
}

/**
 * Hand back the original file bytes as a direct Uint8Array VIEW so they ride
 * inside the exported .cesvu. Returns null for txt/md, where `text` already
 * IS the full content and a byte round-trip would just bloat the record.
 *
 * Deliberately a Uint8Array (not base64) — see Workspace.svelte's
 * `rawContentBytes()` doc comment for why: base64-encoding a large file can
 * blow past the JS engine's max string length, and CesvuDocument.rawContent
 * accepts a Uint8Array directly (contract-store's exportAsCesvu/sendBackAsCesvu
 * frame raw bytes straight into the encrypted plaintext via CFP1 framing).
 */
function rawContentBytes(f: ParsedFile): Uint8Array | null {
	if (f.type === 'txt' || f.type === 'md') return null;
	return new Uint8Array(f.rawContent);
}

/**
 * Build the `{ text, sourceType, rawContent }` init fields `createDocument`
 * (see contract-store.svelte.ts) needs from a freshly-parsed file. Single
 * source of truth shared by Workspace.svelte's `openExport()` and
 * ImportModal.svelte's send-back-a-viewer-supported-file path.
 */
export function parsedFileToDocumentInit(f: ParsedFile): {
	text: string;
	sourceType: SourceType;
	rawContent: Uint8Array | null;
} {
	return {
		text: fileText(f),
		sourceType: fileSourceType(f),
		rawContent: rawContentBytes(f)
	};
}
