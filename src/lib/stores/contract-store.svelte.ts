/**
 * src/lib/stores/contract-store.svelte.ts — in-memory store for .cesvu
 * documents
 *
 * Thin, dependency-free CRUD wrapper around a single in-memory Map of
 * {@link CesvuDocument} records (see src/lib/schema.ts — "the schema is the
 * contract"). Lets a user upload a contract, mark clause boundaries, and see
 * the analysis within a single browser session.
 *
 * ⚠️  IN-MEMORY BY DESIGN — there is NO persistence at rest. Documents live in
 * a module-scope Map for the lifetime of the page; a refresh or tab close wipes
 * everything. To keep work, the user EXPORTS to a `_cesvu.zip` archive (the
 * only durable, portable form). NO IndexedDB, NO localStorage, NO sync, NO
 * migrations.
 *
 * NOTE: the `_cesvu.zip` export is a plain, standard zip with no
 * confidentiality — see cesvu-zip-export.ts's top doc comment.
 *
 * MEMORY NOTES:
 *   - The reactive `documentsStore` holds lightweight {@link DocumentSummary}
 *     objects, NOT full CesvuDocument records. This keeps large fields
 *     (base64 rawContent, full text, paragraphs, clauses, annotations,
 *     messages, profile) pinned only inside the Map — one copy each —
 *     instead of being duplicated into every Svelte subscriber's reactivity
 *     graph. Components that need the full record call {@link getDocument}.
 *   - Intermediates in import/export are explicitly nulled so the GC can
 *     reclaim decoded bytes / decoded strings / parsed objects during await
 *     gaps rather than keeping all four alive until function return.
 */

import {
	createCesvuDocument,
	CESVU_SCHEMA_VERSION,
	type CesvuDocument,
	type DocumentSummary,
	type SourceType,
	type DocumentParagraph,
	type DocumentSplits
} from '$lib/schema.js';

import {
	buildCesvuZip,
	parseCesvuZip,
	CesvuZipError,
	CESVU_MANIFEST_VERSION,
	SOURCE_DIR,
	type CesvuManifest
} from '$lib/export/cesvu-zip-export.js';


/**
 * Patch shape for {@link updateDocument}. Like Partial<CesvuDocument> but the
 * nested `splits` may itself be partial — updateDocument shallow-merges it, so
 * a caller can update just `manual`, just `auto`, or just `mode`.
 */
export type DocumentPatch = Partial<Omit<CesvuDocument, 'splits'>> & {
	splits?: Partial<DocumentSplits>;
};

// ── In-memory store ──────────────────────────────────────────────────────────

/**
 * The single source of truth. All data lives here for the browser session.
 * Full CesvuDocument records (including large base64 rawContent, text,
 * paragraphs, etc.) live ONLY in this Map — one copy each.
 */
const docs = new Map<string, CesvuDocument>();

/**
 * Reactive snapshot of every stored document as a lightweight
 * {@link DocumentSummary}, newest-updated first. Svelte components can
 * `import { documentsStore }` and iterate it directly; every mutation
 * (create/update/delete/import) refreshes it in place via {@link sync}, so
 * subscribers re-render automatically. Mutated in place (never reassigned) so
 * it stays exportable as `$state`.
 *
 * MEMORY: This holds ONLY summaries (id, name, sourceType, updatedAt,
 * clauseCount, analyzed, splitMode) — NOT full CesvuDocument objects. This
 * avoids duplicating large fields (base64 rawContent, full text, paragraphs,
 * clauses, annotations, messages, profile) into the reactivity graph of
 * every subscribing component. Components that need the full record call
 * {@link getDocument}.
 */
export const documentsStore = $state<DocumentSummary[]>([]);

/**
 * Refresh the reactive snapshot from the Map. Builds summaries directly from
 * the Map iterator (no throwaway full-doc array), sorts the small summary
 * objects in place, and splices into the store. In-place splice keeps
 * reactivity.
 */
function sync(): void {
	const summaries = Array.from(docs.values(), toSummary);
	summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	documentsStore.splice(0, documentsStore.length, ...summaries);
}

/** Generate a reasonably-unique id without extra deps. */
function newId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
	return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Project a full record down to the lightweight resume-list summary. */
function toSummary(r: CesvuDocument): DocumentSummary {
	const active = r.splits.mode === 'auto' ? r.splits.auto : r.splits.manual;
	return {
		id: r.id,
		name: r.name,
		sourceType: r.sourceType,
		updatedAt: r.updatedAt,
		clauseCount: active.length > 0 ? active.length + 1 : 0,
		analyzed: r.profile !== null,
		splitMode: r.splits.mode
	};
}

// ── CRUD API ─────────────────────────────────────────────────────────────────

/**
 * Store a NEW document. Accepts either a fully-built {@link CesvuDocument} or
 * the minimal "init" fields (id is generated when omitted), in which case the
 * reserved fields are initialized via {@link createCesvuDocument}. Returns the
 * stored document so the caller has its generated id.
 */
export async function createDocument(
	doc:
		| CesvuDocument
		| {
				name: string;
				sourceType: SourceType;
				text: string;
				paragraphs?: DocumentParagraph[];
				/** Original file bytes (csv | excel | pdf | docx). */
				rawContent?: string | Uint8Array | null;
		  }
): Promise<CesvuDocument> {
	const record: CesvuDocument =
		'version' in doc ? (doc as CesvuDocument) : createCesvuDocument({ id: newId(), ...doc });
	docs.set(record.id, record);
	sync();
	return record;
}

/** Retrieve a document by id. Returns null when not found. */
export async function getDocument(id: string): Promise<CesvuDocument | null> {
	return docs.get(id) ?? null;
}

/**
 * Merge `partial` into the stored document and re-save. `updatedAt` is always
 * refreshed; `id`/`version`/`createdAt` are preserved regardless of `partial`.
 * Nested `splits` is shallow-merged so a caller can update just `manual` or
 * just `mode`. No-op (returns null) if the record is gone.
 */
export async function updateDocument(
	id: string,
	partial: DocumentPatch
): Promise<CesvuDocument | null> {
	const rec = docs.get(id);
	if (!rec) return null;
	const merged: CesvuDocument = {
		...rec,
		...partial,
		id: rec.id,
		version: rec.version,
		createdAt: rec.createdAt,
		splits: partial.splits ? { ...rec.splits, ...partial.splits } : rec.splits,
		updatedAt: Date.now()
	};
	docs.set(id, merged);
	sync();
	return merged;
}

/**
 * List all stored documents as lightweight summaries (name + date + status),
 * newest-updated first, for the "resume where you left off" picker.
 */
export async function listDocuments(): Promise<DocumentSummary[]> {
	const summaries = Array.from(docs.values(), toSummary);
	summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	return summaries;
}

/** Remove a document by id. */
export async function deleteDocument(id: string): Promise<void> {
	docs.delete(id);
	sync();
}

// ── .cesvu export / import (file-based, local-first sharing) ────────────────
//
// A `.cesvu` share is a plain, standard `_cesvu.zip` archive — see
// cesvu-zip-export.ts's top doc comment. There is no custom binary framing
// here anymore (the old CFP1 payload format was retired along with the
// hand-rolled `.CESVU` binary container): the original source file, if
// included, rides as a real zip entry under `source/`, and every other field
// is plain JSON in `manifest.json`.

/** Best-effort MIME type for the embedded source file, by extension — purely
 *  informational (written into manifest.json for a human/tool inspecting the
 *  zip; never used to drive parsing on import, which always keys off
 *  `document.sourceType`). */
function guessSourceMimeType(sourceType: SourceType): string {
	switch (sourceType) {
		case 'pdf':
			return 'application/pdf';
		case 'docx':
			return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
		case 'csv':
			return 'text/csv';
		case 'excel':
			return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
		case 'txt':
			return 'text/plain';
		case 'md':
			return 'text/markdown';
	}
}

/** Decoded byte length of a standard (no-whitespace) base64 string. */
function base64DecodedLength(b64: string): number {
	const len = b64.length;
	if (len === 0) return 0;
	let padding = 0;
	if (b64.charCodeAt(len - 1) === 61) padding++; // '='
	if (len > 1 && b64.charCodeAt(len - 2) === 61) padding++;
	return (len >>> 2) * 3 - padding;
}

/**
 * Decode standard base64 straight into a fresh Uint8Array, in chunks, so we
 * never materialize a giant binary string at once. CHUNK is a multiple of 4
 * so no base64 quantum (hence no '=' padding) is ever split across a chunk
 * boundary.
 */
function decodeBase64(b64: string): Uint8Array {
	const CHUNK = 1 << 20; // 1,048,576 chars (÷4 = clean quantum boundary)
	const out = new Uint8Array(base64DecodedLength(b64));
	let pos = 0;
	for (let i = 0; i < b64.length; i += CHUNK) {
		const bin = atob(b64.slice(i, i + CHUNK));
		for (let j = 0; j < bin.length; j++) out[pos++] = bin.charCodeAt(j);
	}
	return out;
}

/**
 * Build a {@link CesvuManifest} from a stored document. Known fields map
 * 1:1 onto the manifest's structured sections; any field this build doesn't
 * model lands in `extras` so a round-trip through an older/different build
 * never silently drops data (mirrors normalizeCesvuDocument's forward-compat
 * passthrough on the way back in).
 */
function buildManifest(doc: CesvuDocument, includeSource: boolean): {
	manifest: CesvuManifest;
	source: { bytes: Uint8Array; filename: string } | null;
} {
	const knownKeys = new Set<string>([
		'id',
		'version',
		'name',
		'sourceType',
		'createdAt',
		'updatedAt',
		'text',
		'paragraphs',
		'rawContent',
		'splits',
		'profile',
		'clauses',
		'annotations',
		'messages'
	]);
	const extras: Record<string, unknown> = {};
	for (const key in doc) {
		if (!knownKeys.has(key)) extras[key] = (doc as unknown as Record<string, unknown>)[key];
	}

	let source: { bytes: Uint8Array; filename: string } | null = null;
	if (includeSource) {
		if (doc.rawContent instanceof Uint8Array && doc.rawContent.length > 0) {
			source = { bytes: doc.rawContent, filename: doc.name || 'source' };
		} else if (typeof doc.rawContent === 'string' && doc.rawContent.length > 0) {
			source = { bytes: decodeBase64(doc.rawContent), filename: doc.name || 'source' };
		}
	}

	const manifest: CesvuManifest = {
		cesvuManifestVersion: CESVU_MANIFEST_VERSION,
		exportedAt: new Date().toISOString(),
		document: {
			id: doc.id,
			version: doc.version,
			name: doc.name,
			sourceType: doc.sourceType,
			createdAt: doc.createdAt,
			updatedAt: doc.updatedAt,
			text: doc.text,
			paragraphs: doc.paragraphs
		},
		sourceFile: {
			included: source !== null,
			path: source ? `${SOURCE_DIR}${source.filename}` : null,
			mimeType: source ? guessSourceMimeType(doc.sourceType) : null
		},
		splits: doc.splits,
		clauses: doc.clauses,
		notes: doc.annotations,
		profile: doc.profile as CesvuManifest['profile'],
		messages: doc.messages,
		extras: Object.keys(extras).length > 0 ? extras : undefined
	};

	return { manifest, source };
}

/**
 * Export a stored document as a portable `<name>_cesvu.zip` archive. See
 * cesvu-zip-export.ts's top doc comment: this is a plain, inspectable zip
 * with no confidentiality — anyone who has it can read manifest.json.
 *
 * `options.includeSource` controls whether the original file bytes
 * (`rawContent`) are written into the archive under `source/`. It DEFAULTS
 * TO FALSE — the export carries only the extracted text + analysis (notes,
 * clauses, profile, splits) unless the sender explicitly opts in. (CSV/XLSX
 * callers pass `includeSource: true` because their viewers reconstruct the
 * interactive table from the raw bytes.)
 *
 * Throws a plain Error if the document id is unknown.
 */
export async function exportAsCesvu(
	documentId: string,
	options: { includeSource?: boolean } = {}
): Promise<{ blob: Blob }> {
	const doc = await getDocument(documentId);
	if (!doc) throw new Error('Document not found');

	const includeSource = options.includeSource ?? false;
	const { manifest, source } = buildManifest(doc, includeSource);

	const zipBytes = buildCesvuZip(manifest, source);
	const blob = new Blob([zipBytes as BlobPart], { type: 'application/zip' });
	return { blob };
}

/**
 * Map a low-level {@link CesvuZipError} to a short, user-facing message.
 * Anything that isn't a recognized error becomes the generic fallback so we
 * never leak internals into the UI.
 */
function describeImportError(err: unknown): string {
	if (err instanceof CesvuZipError) {
		switch (err.code) {
			case 'NOT_A_ZIP':
				return 'This is not a .zip file.';
			case 'MISSING_MANIFEST':
				return 'This .zip file isn\u2019t a Cesvu export \u2014 it has no manifest.json.';
			case 'UNSUPPORTED_MANIFEST_VERSION':
				return err.message || 'This file needs a newer version of Cesvu.';
			case 'MANIFEST_CORRUPT':
				return 'This file appears to be corrupted.';
			default:
				return 'Unable to import this file.';
		}
	}
	return 'Unable to import this file.';
}

/**
 * Map an export-time failure to a short, user-facing message. Mirrors
 * {@link describeImportError} so {@link ExportModal} can surface a friendly
 * string instead of a raw internal message.
 */
export function describeExportError(err: unknown): string {
	return `Unable to prepare this file: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Rebuild a {@link CesvuDocument} from an already-validated {@link
 * CesvuManifest} (zod has already checked its structural shape in
 * parseCesvuZip) plus the embedded source bytes, if any.
 *
 * FORWARD-COMPAT: fields this build does not model are PRESERVED via
 * `manifest.extras`, the same passthrough the old binary format's importer
 * provided — see {@link buildManifest}'s matching extraction on the way out.
 */
function documentFromManifest(
	manifest: CesvuManifest,
	sourceBytes: Uint8Array | null
): CesvuDocument {
	const extras = manifest.extras ?? {};

	const known: CesvuDocument = {
		id: manifest.document.id,
		version:
			typeof manifest.document.version === 'number'
				? manifest.document.version
				: CESVU_SCHEMA_VERSION,
		name: manifest.document.name,
		sourceType: manifest.document.sourceType,
		createdAt: manifest.document.createdAt,
		updatedAt: Date.now(),
		text: manifest.document.text,
		paragraphs: manifest.document.paragraphs as DocumentParagraph[],
		rawContent: sourceBytes,
		splits: manifest.splits as DocumentSplits,
		profile: (manifest.profile ?? null) as CesvuDocument['profile'],
		clauses: manifest.clauses as CesvuDocument['clauses'],
		annotations: manifest.notes as CesvuDocument['annotations'],
		messages: manifest.messages as CesvuDocument['messages']
	};

	return { ...extras, ...known } as CesvuDocument;
}

/**
 * Import a `_cesvu.zip` archive: unzip it, validate manifest.json, rebuild
 * the {@link CesvuDocument}, store it in the in-memory map, and return it.
 *
 * Throws an Error whose message is already user-facing (see
 * {@link describeImportError}) — the caller can surface `err.message` directly.
 */
export async function importFromCesvu(file: File): Promise<CesvuDocument> {
	let manifest: CesvuManifest;
	let sourceBytes: Uint8Array | null;
	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		({ manifest, sourceBytes } = parseCesvuZip(bytes));
	} catch (err) {
		throw new Error(describeImportError(err));
	}

	const doc = documentFromManifest(manifest, sourceBytes);
	docs.set(doc.id, doc);
	sync();
	return doc;
}


