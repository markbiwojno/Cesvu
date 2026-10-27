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
 * everything. To keep work, the user EXPORTS to a `.cesvu` file (the only
 * durable, portable form). NO IndexedDB, NO localStorage, NO sync, NO
 * migrations.
 *
 * NOTE: the `.cesvu` export produced by this build is PLAIN (unencrypted) —
 * see cesvu-crypto.ts's top doc comment. It carries a SHA-256 integrity
 * checksum only, not confidentiality.
 *
 * MEMORY NOTES:
 *   - The reactive `documentsStore` holds lightweight {@link DocumentSummary}
 *     objects, NOT full CesvuDocument records. This keeps large fields
 *     (base64 rawContent, full text, paragraphs, clauses, annotations,
 *     messages, profile) pinned only inside the Map — one copy each —
 *     instead of being duplicated into every Svelte subscriber's reactivity
 *     graph. Components that need the full record call {@link getDocument}.
 *   - Intermediates in import/export are explicitly nulled so the GC can
 *     reclaim decrypted bytes / decoded strings / parsed objects during await
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
	buildCesvuFile,
	parseCesvuFile,
	CesvuError
} from '$lib/crypto/cesvu-crypto.js';


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

// ── .cesvu payload framing (CFP1) ─────────────────────────────────────────
//
// The bytes handed to buildCesvuFile() are framed so the original source
// file travels as a RAW BINARY section instead of base64-inside-JSON. Layout:
//   [0..3]           magic 'CFP1'
//   [4..7]           uint32 BE  docJson length
//   [8 .. 8+len)     docJson (UTF-8; the CesvuDocument WITHOUT rawContent)
//   [8+len .. end)   raw source bytes (implicit length = remainder of plaintext)
//
// This avoids the overhead of base64 (1.33x inflation) plus JSON.stringify
// duplicating a giant string.
const PAYLOAD_MAGIC = new Uint8Array([0x43, 0x46, 0x50, 0x31]); // 'CFP1'
const PAYLOAD_HEADER_LEN = 8; // magic(4) + uint32 docJsonLen(4)

/** True if `buf` begins with the CFP1 payload magic. */
function hasPayloadMagic(buf: Uint8Array): boolean {
	return (
		buf.length >= PAYLOAD_HEADER_LEN &&
		buf[0] === PAYLOAD_MAGIC[0] &&
		buf[1] === PAYLOAD_MAGIC[1] &&
		buf[2] === PAYLOAD_MAGIC[2] &&
		buf[3] === PAYLOAD_MAGIC[3]
	);
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
 * Decode standard base64 straight into `target` at `offset`, in chunks, so we
 * never materialize a full-size intermediate byte array or a giant binary
 * string at once. CHUNK is a multiple of 4 so no base64 quantum (hence no '='
 * padding) is ever split across a chunk boundary.
 */
function decodeBase64Into(b64: string, target: Uint8Array, offset: number): void {
	const CHUNK = 1 << 20; // 1,048,576 chars (÷4 = clean quantum boundary)
	let out = offset;
	for (let i = 0; i < b64.length; i += CHUNK) {
		const bin = atob(b64.slice(i, i + CHUNK));
		for (let j = 0; j < bin.length; j++) target[out++] = bin.charCodeAt(j);
	}
}

/**
 * Build the CFP1-framed plaintext payload for a stored document: the
 * document's own JSON (with `rawContent` stripped, since the source bytes
 * ride as a separate raw section) followed by the original source bytes
 * (when `includeSource` is true and the record actually carries any).
 * Used by {@link exportAsCesvu}.
 *
 * Throws a plain Error if the document id is unknown.
 */
async function buildExportPayload(
	documentId: string,
	includeSource: boolean
): Promise<{ doc: CesvuDocument; plaintext: Uint8Array }> {
	const doc = await getDocument(documentId);
	if (!doc) throw new Error('Document not found');

	let sourceBytes: Uint8Array | null = null;
	let sourceB64 = '';
	if (includeSource) {
		if (doc.rawContent instanceof Uint8Array) {
			sourceBytes = doc.rawContent;
		} else if (typeof doc.rawContent === 'string' && doc.rawContent.length > 0) {
			sourceB64 = doc.rawContent;
		}
	}
	const exportDoc: CesvuDocument = {
		...doc,
		rawContent: null
	};

	const docJson = new TextEncoder().encode(JSON.stringify(exportDoc));
	const rawLen = sourceBytes ? sourceBytes.length : base64DecodedLength(sourceB64);
	const plaintext = new Uint8Array(PAYLOAD_HEADER_LEN + docJson.length + rawLen);
	plaintext.set(PAYLOAD_MAGIC, 0);
	new DataView(plaintext.buffer).setUint32(4, docJson.length, false);
	plaintext.set(docJson, PAYLOAD_HEADER_LEN);
	if (sourceBytes) {
		plaintext.set(sourceBytes, PAYLOAD_HEADER_LEN + docJson.length);
	} else if (rawLen > 0) {
		decodeBase64Into(sourceB64, plaintext, PAYLOAD_HEADER_LEN + docJson.length);
	}

	return { doc, plaintext };
}

/**
 * Export a stored document as a portable, plain (unencrypted) `.cesvu`
 * file. See cesvu-crypto.ts's top doc comment: this carries a SHA-256
 * integrity checksum only, not confidentiality.
 *
 * `options.includeSource` controls whether the original file bytes
 * (`rawContent`, base64 of the source PDF/DOCX/CSV/XLSX) are written into
 * the file. It DEFAULTS TO FALSE — the `.cesvu` carries only the extracted
 * text + analysis (notes, clauses, profile, splits) unless the sender
 * explicitly opts in. (CSV/XLSX callers pass `includeSource: true` because
 * their viewers reconstruct the interactive table from the raw bytes.)
 *
 * Throws a plain Error if the document id is unknown.
 */
export async function exportAsCesvu(
	documentId: string,
	options: { includeSource?: boolean } = {}
): Promise<{ blob: Blob }> {
	const includeSource = options.includeSource ?? false;
	const { doc, plaintext } = await buildExportPayload(documentId, includeSource);

	const metadata = {
		filename: doc.name || 'document',
		mimeType: 'application/json',
		createdAt: Date.now()
	};

	const file = await buildCesvuFile(plaintext, metadata);
	const blob = new Blob([file as BlobPart], { type: 'application/octet-stream' });
	return { blob };
}

/**
 * Map a low-level {@link CesvuError} to a short, user-facing message. Anything
 * that isn't a recognized error becomes the generic fallback so we never
 * leak internals into the UI.
 */
function describeImportError(err: unknown): string {

	if (err instanceof CesvuError) {
		switch (err.code) {
			case 'BAD_MAGIC':
				return 'This is not a .cesvu file.';
			case 'UNSUPPORTED_VERSION':
				return err.message || 'This file needs a newer version of Cesvu.';
			case 'METADATA_CORRUPT':
			case 'METADATA_INCOMPLETE':
			case 'TOO_SHORT':
				return 'This file appears to be corrupted.';
			case 'CORRUPTED':
				return 'This file appears to be corrupted \u2014 its contents don\u2019t match the stored checksum.';
			default:
				return 'Unable to import this file.';

		}
	}
	return 'Unable to import this file.';
}

/**
 * Map an export-time failure to a short, user-facing message. Mirrors
 * {@link describeImportError} for the encrypt path so {@link ExportModal} can
 * surface a friendly string instead of a raw crypto message.
 */
export function describeExportError(err: unknown): string {
	if (err instanceof CesvuError) {
		return `Unable to prepare this file: ${err instanceof Error ? err.message : String(err)}`;
	}
	return `Unable to prepare this file: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Structurally validate + normalize a decoded object into a {@link
 * CesvuDocument}.
 * (The persisted shape is declared in src/lib/schema.ts as TS interfaces, so this
 * is the runtime guard at the trust boundary.) Returns null when the required
 * identity/content fields are missing or the wrong type; reserved fields are
 * defaulted so an older/partial export still round-trips cleanly.
 *
 * FORWARD-COMPAT: fields this build does not model are PRESERVED (not dropped)
 * — see the return below.
 */
function normalizeCesvuDocument(value: unknown): CesvuDocument | null {
	if (typeof value !== 'object' || value === null) return null;
	const v = value as Record<string, unknown>;

	const validSource =
		v.sourceType === 'pdf' ||
		v.sourceType === 'docx' ||
		v.sourceType === 'txt' ||
		v.sourceType === 'md' ||
		v.sourceType === 'csv' ||
		v.sourceType === 'excel';

	if (
		typeof v.id !== 'string' ||
		typeof v.name !== 'string' ||
		typeof v.text !== 'string' ||
		!validSource
	) {
		return null;
	}

	const rawContent: string | Uint8Array | null =
		typeof v.rawContent === 'string'
			? v.rawContent
			: v.rawContent instanceof Uint8Array
				? v.rawContent
				: null;

	const rawSplits =
		typeof v.splits === 'object' && v.splits !== null
			? (v.splits as Record<string, unknown>)
			: null;
	const splits: DocumentSplits = {
		manual: Array.isArray(rawSplits?.manual) ? (rawSplits!.manual as number[]) : [],
		auto: Array.isArray(rawSplits?.auto) ? (rawSplits!.auto as number[]) : [],
		mode: rawSplits?.mode === 'auto' ? 'auto' : 'manual'
	};

	const now = Date.now();

	const known: CesvuDocument = {
		id: v.id,
		version: typeof v.version === 'number' ? v.version : CESVU_SCHEMA_VERSION,
		name: v.name,
		sourceType: v.sourceType as SourceType,
		createdAt: typeof v.createdAt === 'number' ? v.createdAt : now,
		updatedAt: now,
		text: v.text,
		paragraphs: Array.isArray(v.paragraphs) ? (v.paragraphs as DocumentParagraph[]) : [],
		rawContent,
		splits,
		profile: (v.profile ?? null) as CesvuDocument['profile'],
		clauses: Array.isArray(v.clauses) ? (v.clauses as CesvuDocument['clauses']) : [],
		annotations: Array.isArray(v.annotations)
			? (v.annotations as CesvuDocument['annotations'])
			: [],
		messages: Array.isArray(v.messages) ? (v.messages as CesvuDocument['messages']) : []
	};

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
	for (const key in v) {
		if (!knownKeys.has(key)) extras[key] = v[key];
	}

	return { ...extras, ...known } as CesvuDocument;
}

/**
 * Import a plain (unencrypted) `.cesvu` file: verify its integrity
 * checksum, validate the decoded document, store it in the in-memory map,
 * and return it.
 *
 * Throws an Error whose message is already user-facing (see
 * {@link describeImportError}) — the caller can surface `err.message` directly.
 */
export async function importFromCesvu(file: File): Promise<CesvuDocument> {

	let plaintext: Uint8Array;
	try {
		const bytes = new Uint8Array(await file.arrayBuffer());
		({ payload: plaintext } = await parseCesvuFile(bytes));
	} catch (err) {
		throw new Error(describeImportError(err));
	}

	if (!hasPayloadMagic(plaintext)) {
		throw new Error('This file appears to be corrupted.');
	}

	let parsed: unknown;
	try {
		const dv = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
		const docJsonLen = dv.getUint32(4, false);
		const jsonEnd = PAYLOAD_HEADER_LEN + docJsonLen;
		const json = new TextDecoder().decode(plaintext.subarray(PAYLOAD_HEADER_LEN, jsonEnd));
		parsed = JSON.parse(json);
		if (jsonEnd < plaintext.length && parsed !== null && typeof parsed === 'object') {
			(parsed as Record<string, unknown>).rawContent = plaintext.subarray(jsonEnd);
		}
	} catch {
		throw new Error('This file appears to be corrupted.');
	}

	const doc = normalizeCesvuDocument(parsed);
	parsed = null;

	if (!doc) throw new Error('This file appears to be corrupted.');

	docs.set(doc.id, doc);
	sync();
	return doc;
}


