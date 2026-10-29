/**
 * src/lib/export/cesvu-zip-export.ts — Export/import of a {@link CesvuDocument}
 * as a plain, inspectable `<name>_cesvu.zip` archive.
 *
 * ── What this format provides ─────────────────────────────────────────────
 * This replaces the old custom `.CESVU` binary container (magic/version/
 * preamble/checksum header, CFP1-framed payload) with a STANDARD ZIP FILE
 * that any zip tool can open. There is no confidentiality — anyone who has
 * the file can unzip it and read `manifest.json` directly. There is no
 * custom integrity checksum either: zip's own per-entry CRC-32 already
 * detects corruption/truncation, so layering a redundant SHA-256 on top
 * would only duplicate what the container format already guarantees.
 *
 * ── Archive layout ───────────────────────────────────────────────────────
 *   <name>_cesvu.zip
 *   ├── manifest.json        structured data — see {@link CesvuManifest}
 *   ├── README.txt           human-readable "what is this" explainer
 *   └── source/<filename>    the original source file (only if included)
 *
 * `manifest.json` carries the document's extracted text, paragraph
 * segmentation, clause marks, notes/annotations, contract profile (parties,
 * dates, risk summary), and split offsets — i.e. everything the old CFP1
 * JSON envelope carried, just laid out as a real, readable JSON file instead
 * of being buried inside a binary payload.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { z } from 'zod';

// ── Public constants ──────────────────────────────────────────────────

/** Current manifest schema version. Bump when the manifest shape changes
 *  in a way a reader must branch on. */
export const CESVU_MANIFEST_VERSION = 1 as const;

export const MANIFEST_ENTRY = 'manifest.json';
export const README_ENTRY = 'README.txt';
/** Directory prefix for the embedded original source file, if included. */
export const SOURCE_DIR = 'source/';

/**
 * Fixed timestamp used as every zip entry's mtime so repeated exports of the
 * same document produce byte-identical archives — see {@link buildCesvuZip}'s
 * call site for the full rationale.
 *
 * Deliberately NOT the zip format's exact 1980-01-01 DOS-date epoch: fflate
 * computes the DOS date from `Date#getFullYear()`/`getMonth()`/`getDate()` —
 * i.e. LOCAL time, not UTC — so a UTC midnight timestamp on that exact
 * boundary date rolls back to 1979 in any timezone behind UTC and fails
 * fflate's "date not in range 1980-2099" check. Mid-January leaves enough
 * margin that no timezone offset can push it outside the valid range.
 */
const FIXED_ZIP_MTIME = new Date(Date.UTC(1980, 0, 15));

const README_TEXT =
	'This is a Cesvu file (cesvu.com).\r\n\r\n' +
	"It's a plain, inspectable zip — not encrypted. Anyone who has it can \r\n" +
	'open manifest.json to see the document\u2019s text, notes, and contract \r\n' +
	'analysis. If this file\u2019s contents are sensitive, encrypt it yourself \r\n' +
	'before sending it.\r\n\r\n' +
	'- manifest.json  -> structured data (text, notes, clause marks, parties)\r\n' +
	'- source/        -> the original file, if the sender chose to include it\r\n\r\n' +
	'Open this file at https://cesvu.com to view it in the app, or just \r\n' +
	'unzip it to inspect the contents directly.\r\n';

// ── Error type ────────────────────────────────────────────────────────

export type CesvuZipErrorCode =
	| 'NOT_A_ZIP'
	| 'MISSING_MANIFEST'
	| 'MANIFEST_CORRUPT'
	| 'UNSUPPORTED_MANIFEST_VERSION';

export class CesvuZipError extends Error {
	constructor(
		public readonly code: CesvuZipErrorCode,
		message?: string
	) {
		super(message ?? code);
		this.name = 'CesvuZipError';
	}
}

// ── Manifest schema ───────────────────────────────────────────────────
//
// zod validates the DECODED JSON at the trust boundary (mirrors the old
// CesvuMetadataSchema's role for the binary format's header metadata).
// Unknown/future fields on `document.*` are NOT modeled individually here
// (see normalizeCesvuDocument in contract-store.svelte.ts, which still owns
// forward-compat field preservation for the document sub-object) — this
// schema only guards the manifest's own structural shape.

const SourceTypeSchema = z.enum(['csv', 'excel', 'pdf', 'docx', 'txt', 'md']);

const DocumentParagraphSchema = z.object({
	offset: z.number(),
	text: z.string()
});

const SplitsSchema = z.object({
	manual: z.array(z.number()),
	auto: z.array(z.number()),
	mode: z.enum(['manual', 'auto'])
});

const PersistedClauseSchema = z.object({
	id: z.string(),
	startOffset: z.number(),
	endOffset: z.number(),
	text: z.string(),
	color: z.string(),
	heading: z.string().nullable(),
	label: z.string().nullable(),
	risk: z.enum(['high', 'medium', 'low']).nullable(),
	status: z.enum(['pending', 'analyzing', 'analyzed', 'error']),
	confidence: z.enum(['high', 'medium', 'low', 'edited'])
});

const NoteAnchorSchema = z.union([
	z.object({ kind: z.literal('prose'), offset: z.number() }),
	z.object({
		kind: z.literal('cell'),
		sheet: z.string(),
		column: z.string(),
		rowIndex: z.number()
	})
]);

const NoteSchema = z.object({
	id: z.string(),
	anchorId: z.string(),
	anchor: NoteAnchorSchema.optional(),
	createdInLens: z.enum(['contract', 'document']).optional(),
	author: z.string(),
	body: z.string(),
	createdAt: z.number()
});

const MessageSchema = z.object({
	id: z.string(),
	role: z.enum(['user', 'assistant']),
	content: z.string(),
	createdAt: z.number()
});

/** Loosely-typed passthrough — the contract profile shape is owned by
 *  src/lib/lenses/contract/types.ts; the manifest just carries it as opaque
 *  structured JSON rather than re-declaring every nested field here. */
const ProfileSchema = z.record(z.string(), z.unknown()).nullable();

export const CesvuManifestSchema = z.object({
	cesvuManifestVersion: z.literal(CESVU_MANIFEST_VERSION),
	exportedAt: z.string(),
	document: z.object({
		id: z.string(),
		version: z.number(),
		name: z.string(),
		sourceType: SourceTypeSchema,
		createdAt: z.number(),
		updatedAt: z.number(),
		text: z.string(),
		paragraphs: z.array(DocumentParagraphSchema)
	}),
	sourceFile: z.object({
		included: z.boolean(),
		path: z.string().nullable(),
		mimeType: z.string().nullable()
	}),
	splits: SplitsSchema,
	clauses: z.array(PersistedClauseSchema),
	notes: z.array(NoteSchema),
	profile: ProfileSchema,
	messages: z.array(MessageSchema),
	/** Forward-compat: fields this build doesn't model, preserved verbatim
	 *  (see normalizeCesvuDocument's equivalent passthrough for the old
	 *  format). Populated by contract-store.svelte.ts from any unknown keys
	 *  on the live CesvuDocument. */
	extras: z.record(z.string(), z.unknown()).optional()
});

export type CesvuManifest = z.infer<typeof CesvuManifestSchema>;

// ── Build ─────────────────────────────────────────────────────────────

/**
 * Build a `<name>_cesvu.zip` archive from an already-assembled
 * {@link CesvuManifest} and, optionally, the original source file bytes.
 *
 * The caller (contract-store.svelte.ts's `exportAsCesvu`) owns translating
 * a live `CesvuDocument` into the manifest shape; this function only owns
 * the zip container itself — manifest.json + README.txt + the optional
 * source/ entry — so the archive format stays decoupled from the in-memory
 * document schema.
 */
export function buildCesvuZip(
	manifest: CesvuManifest,
	source: { bytes: Uint8Array; filename: string } | null
): Uint8Array {
	const validated = CesvuManifestSchema.parse(manifest);
	const files: Record<string, Uint8Array> = {
		[MANIFEST_ENTRY]: strToU8(JSON.stringify(validated, null, 2)),
		[README_ENTRY]: strToU8(README_TEXT)
	};
	if (source) {
		files[`${SOURCE_DIR}${source.filename}`] = source.bytes;
	}
	// A fixed, valid mtime keeps the archive byte-identical across repeated
	// exports of the same document (no embedded wall-clock timestamp noise),
	// which is both a nicer diff experience and avoids leaking the export
	// time via zip entry metadata beyond what manifest.json's `exportedAt`
	// already discloses deliberately. Zip's DOS date field only supports
	// 1980-01-01 through 2099-12-31 — fflate throws on anything outside
	// that range (including the Unix epoch, 1970), so this uses the
	// earliest valid date rather than 0.
	return zipSync(files, { mtime: FIXED_ZIP_MTIME });
}

export interface ParsedCesvuZip {
	manifest: CesvuManifest;
	/** The embedded original source file's bytes, or null if none was
	 *  included (manifest.sourceFile.included === false). */
	sourceBytes: Uint8Array | null;
}

/**
 * Parse + validate a `_cesvu.zip` archive built by {@link buildCesvuZip}.
 * Throws {@link CesvuZipError} on any structural problem — the caller
 * (contract-store.svelte.ts's `importFromCesvu`) maps this to a
 * user-facing message.
 */
export function parseCesvuZip(bytes: Uint8Array): ParsedCesvuZip {
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(bytes);
	} catch {
		throw new CesvuZipError('NOT_A_ZIP', 'This is not a valid .zip file.');
	}

	const manifestBytes = entries[MANIFEST_ENTRY];
	if (!manifestBytes) {
		throw new CesvuZipError(
			'MISSING_MANIFEST',
			'This .zip file is missing its manifest.json — it isn\u2019t a Cesvu export.'
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(strFromU8(manifestBytes));
	} catch {
		throw new CesvuZipError('MANIFEST_CORRUPT', 'manifest.json is not valid JSON.');
	}

	// Check the version gate BEFORE full schema validation so a genuinely
	// newer manifest shape (which would otherwise fail schema validation on
	// fields this build doesn't know about) gets the clear "unsupported
	// version" message instead of a confusing generic parse error.
	if (
		typeof parsed === 'object' &&
		parsed !== null &&
		'cesvuManifestVersion' in parsed &&
		(parsed as { cesvuManifestVersion: unknown }).cesvuManifestVersion !== CESVU_MANIFEST_VERSION
	) {
		const v = (parsed as { cesvuManifestVersion: unknown }).cesvuManifestVersion;
		throw new CesvuZipError(
			'UNSUPPORTED_MANIFEST_VERSION',
			`This file's manifest is v${v}. Use another build of Cesvu that supports v${v} manifests.`
		);
	}

	const result = CesvuManifestSchema.safeParse(parsed);
	if (!result.success) {
		throw new CesvuZipError(
			'MANIFEST_CORRUPT',
			"manifest.json doesn't match the expected schema."
		);
	}
	const manifest = result.data;

	let sourceBytes: Uint8Array | null = null;
	if (manifest.sourceFile.included && manifest.sourceFile.path) {
		sourceBytes = entries[manifest.sourceFile.path] ?? null;
	}

	return { manifest, sourceBytes };
}
