/**
 * src/lib/crypto/cesvu-crypto.ts — Plain (unencrypted) export/import of a
 * {@link CesvuDocument} as a self-describing `.cesvu` binary file.
 *
 * ── Why this file no longer encrypts anything ───────────────────────────
 * The web app's `.cesvu` export used to be a zero-knowledge encrypted
 * envelope (Argon2id KDF + XChaCha20-Poly1305 secretstream, via
 * libsodium-wrappers-sumo). That has been intentionally removed from the
 * WEB APP ONLY — the Python CLI (`CLI/cesvu/`) and the Node.js package
 * (`NPM/`) are untouched and remain fully encrypted, mutually compatible
 * with each other, and conformant with `.cesvu SPEC/README.md`. A file
 * produced by THIS module is therefore NOT a conforming `.cesvu` v1
 * envelope and will not open in the CLI/NPM package (and vice versa) —
 * it is a distinct, plain container that happens to reuse the same
 * outer magic/extension for continuity with the rest of the product.
 *
 * ── What this format actually provides ──────────────────────────────────
 * NO confidentiality. Anyone who has the file can read its contents —
 * there is no passphrase, no key, no encryption of any kind. What IS
 * provided is INTEGRITY: a SHA-256 checksum over the payload lets a
 * reader detect accidental corruption or truncation (e.g. a bad
 * download, a flaky USB drive, a copy interrupted mid-transfer). It is
 * NOT a security boundary — a deliberate attacker can trivially edit the
 * payload and recompute a matching checksum, since nothing is keyed or
 * secret. Do not represent this format as tamper-evident against a
 * motivated adversary; it only guards against accidental bit-rot.
 *
 * ── Format ───────────────────────────────────────────────────────────────
 *   offset  size  field
 *   0       6     magic — '.CESVU' (kept for continuity with the prior
 *                 encrypted format's extension/branding; NOT the same
 *                 wire format — see the version field below to tell them
 *                 apart programmatically)
 *   6       2     version — uint16 BE. This plain format uses version 2
 *                 (version 1 was the encrypted envelope). A reader MUST
 *                 reject version 1 with UNSUPPORTED_VERSION rather than
 *                 attempt to parse it as plain — it is a different format
 *                 entirely, not an older revision of this one.
 *   8       2     metaLen — uint16 BE, length in bytes of the metadata
 *                 JSON that follows
 *   10      *     metadata — UTF-8 JSON, exactly `metaLen` bytes (see
 *                 {@link CesvuMetadata} / {@link CesvuMetadataSchema})
 *   10+N    32    checksum — SHA-256 digest (via Web Crypto's
 *                 `crypto.subtle.digest`) of the payload bytes that follow
 *   42+N    *     payload — the CFP1-framed document bytes (unchanged —
 *                 see contract-store.svelte.ts's buildExportPayload)
 *
 * Stack:
 *   - Web Crypto API (`crypto.subtle.digest('SHA-256', …)`) for the
 *     integrity checksum — no WASM, no third-party crypto dependency.
 *   - zod — envelope metadata validation (unchanged from the prior format).
 */

import { z } from 'zod';

// ── Reusable TextEncoder / TextDecoder ─────────────────────────────────

const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

// ── Public constants ──────────────────────────────────────────────────

/** Six ASCII bytes. Bytes 0–5 of every .cesvu file (plain or, historically,
 *  encrypted — see this file's top doc comment for why the magic is shared
 *  but the formats are not interchangeable). */
export const MAGIC = _encoder.encode('.CESVU');

/**
 * Current envelope version. Bytes 6–7 (uint16 BE).
 *
 * v1 was the removed encrypted envelope (XChaCha20-Poly1305 secretstream —
 * still used by the CLI/NPM package). v2 is this plain, checksummed
 * format. A reader encountering v1 here MUST reject it with
 * UNSUPPORTED_VERSION rather than parse it as plain.
 */
export const VERSION = 2 as const;

/**
 * Sanity cap on the metadata JSON length prefix.
 */
export const MAX_METADATA_JSON_LEN = 4096;

/** 6 (magic) + 2 (version) + 2 (metadata length). Fixed. */
export const FIXED_PREFIX = 10;

/** Length of the SHA-256 integrity checksum field. */
export const CHECKSUM_LEN = 32;

// ── Error type ────────────────────────────────────────────────────────

export type CesvuErrorCode =
	| 'TOO_SHORT'
	| 'BAD_MAGIC'
	| 'UNSUPPORTED_VERSION'
	| 'METADATA_CORRUPT'
	| 'METADATA_INCOMPLETE'
	| 'CORRUPTED';

export class CesvuError extends Error {
	constructor(
		public readonly code: CesvuErrorCode,
		message?: string
	) {
		super(message ?? code);
		this.name = 'CesvuError';
	}
}

const PRODUCER_NONCONFORMANT =
	' The file is non-conformant with this build\u2019s plain .cesvu format — the producer (the tool that generated this file) is responsible.';

// ── Envelope metadata (payload prefix) ──────────────────────────────────

/**
 * ⚠️ UNIT: Zod's `.max(n)` on a string counts **UTF-16 code units** (it is
 * `String.prototype.length`), NOT code points.
 */
export const CesvuMetadataSchema = z.object({
	filename: z.string().max(255),
	mimeType: z.string().max(127).default('text/plain'),
	createdAt: z.number().int().nonnegative(),
	template: z.string().max(63).optional()
});

export type CesvuMetadata = z.infer<typeof CesvuMetadataSchema>;

// ── Metadata pack/unpack ─────────────────────────────────────────────────

export function packMetadata(meta: CesvuMetadata): Uint8Array {
	const validated = CesvuMetadataSchema.parse(meta);
	return _encoder.encode(JSON.stringify(validated));
}

export function unpackMetadata(bytes: Uint8Array): CesvuMetadata {
	let json: unknown;
	try {
		json = JSON.parse(_decoder.decode(bytes));
	} catch {
		throw new CesvuError(
			'METADATA_CORRUPT',
			`This .cesvu file's metadata section is not valid JSON.${PRODUCER_NONCONFORMANT}`
		);
	}
	const result = CesvuMetadataSchema.safeParse(json);
	if (!result.success) {
		throw new CesvuError(
			'METADATA_CORRUPT',
			`This .cesvu file's metadata JSON doesn't match the expected schema.${PRODUCER_NONCONFORMANT}`
		);
	}
	return result.data;
}

// ── Checksum helper ───────────────────────────────────────────────────

/** SHA-256 digest of `bytes`, via Web Crypto. */
async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	// crypto.subtle.digest wants a BufferSource; slice to a fresh buffer
	// defensively when `bytes` is a subarray view over a larger backing
	// buffer, so the digest only ever covers the intended range.
	const view =
		bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
			? bytes
			: bytes.slice();
	const digest = await crypto.subtle.digest('SHA-256', view as BufferSource);
	return new Uint8Array(digest);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

// ── Build / parse a plain .cesvu file ───────────────────────────────────

/**
 * Build a plain, checksummed `.cesvu` file from an already-framed
 * `payload` (the caller is responsible for CFP1 framing — see
 * contract-store.svelte.ts's `buildExportPayload`) and its `metadata`.
 */
export async function buildCesvuFile(
	payload: Uint8Array,
	metadata: CesvuMetadata
): Promise<Uint8Array> {
	const metaBytes = packMetadata(metadata);
	if (metaBytes.byteLength > MAX_METADATA_JSON_LEN) {
		throw new CesvuError(
			'METADATA_CORRUPT',
			`Metadata JSON is ${metaBytes.byteLength} bytes, exceeding the ${MAX_METADATA_JSON_LEN}-byte cap.`
		);
	}
	const checksum = await sha256(payload);

	const out = new Uint8Array(
		FIXED_PREFIX + metaBytes.byteLength + CHECKSUM_LEN + payload.byteLength
	);
	const dv = new DataView(out.buffer);
	out.set(MAGIC, 0);
	dv.setUint16(6, VERSION, false);
	dv.setUint16(8, metaBytes.byteLength, false);
	out.set(metaBytes, FIXED_PREFIX);
	out.set(checksum, FIXED_PREFIX + metaBytes.byteLength);
	out.set(payload, FIXED_PREFIX + metaBytes.byteLength + CHECKSUM_LEN);
	return out;
}

export interface ParsedCesvuFile {
	metadata: CesvuMetadata;
	/** The CFP1-framed payload — pass to the same parser that previously
	 *  consumed `decryptCesvu`'s `plaintext`. */
	payload: Uint8Array;
}

/**
 * Parse + integrity-check a plain `.cesvu` file built by
 * {@link buildCesvuFile}. Throws {@link CesvuError} on any structural
 * problem or checksum mismatch — the caller (contract-store.svelte.ts's
 * `importFromCesvu`) maps this to a user-facing message.
 */
export async function parseCesvuFile(bytes: Uint8Array): Promise<ParsedCesvuFile> {
	if (bytes.length < FIXED_PREFIX) {
		throw new CesvuError('TOO_SHORT', 'This file is too short to be a .cesvu file.');
	}
	for (let i = 0; i < MAGIC.length; i++) {
		if (bytes[i] !== MAGIC[i]) {
			throw new CesvuError('BAD_MAGIC', 'This is not a .cesvu file.');
		}
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint16(6, false);
	if (version !== VERSION) {
		throw new CesvuError(
			'UNSUPPORTED_VERSION',
			version === 1
				? 'This .cesvu file is encrypted (v1). This build only opens plain (unencrypted) .cesvu files — use the CLI or NPM package to decrypt it instead.'
				: 'This file needs a newer version of Cesvu.'
		);
	}
	const metaLen = dv.getUint16(8, false);
	if (metaLen === 0 || metaLen > MAX_METADATA_JSON_LEN) {
		throw new CesvuError(
			'METADATA_CORRUPT',
			`This .cesvu file's metadata length prefix (${metaLen}) is out of range.${PRODUCER_NONCONFORMANT}`
		);
	}
	const metaStart = FIXED_PREFIX;
	const metaEnd = metaStart + metaLen;
	const checksumStart = metaEnd;
	const checksumEnd = checksumStart + CHECKSUM_LEN;
	if (bytes.length < checksumEnd) {
		throw new CesvuError(
			'METADATA_INCOMPLETE',
			`This .cesvu file's header hasn't fully arrived yet.${PRODUCER_NONCONFORMANT}`
		);
	}
	const metadata = unpackMetadata(bytes.subarray(metaStart, metaEnd));
	const expectedChecksum = bytes.subarray(checksumStart, checksumEnd);
	const payload = bytes.subarray(checksumEnd);

	const actualChecksum = await sha256(payload);
	if (!constantTimeEqual(actualChecksum, expectedChecksum)) {
		throw new CesvuError(
			'CORRUPTED',
			'This file appears to be corrupted \u2014 its contents don\u2019t match the stored checksum.'
		);
	}

	return { metadata, payload };
}
