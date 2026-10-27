/**
 * src/lib/crypto/cesvu-crypto.ts — Zero-knowledge export/import of a
 * {@link CesvuDocument} as a self-describing .cesvu binary file.
 *
 * One file owns all the offsets: {@link buildHeader} writes the
 * entire header; {@link parseHeader} reads it. Encrypt and decrypt paths
 * MUST stay in lockstep — half-written offsets silently corrupt data.
 *
 * Stack (libsodium-wrappers-sumo):
 *   - `crypto_pwhash`  — Argon2id13 KDF. time_cost (opsLimit) and memory_cost
 *                        (KiB) are both stored literally in the header and
 *                        range-checked before any Argon2id run.

 *   - `crypto_secretstream_xchacha20poly1305_*` — streaming AEAD. Each chunk
 *                        is `ciphertext || 17-byte MAC`; the 32-byte stream
 *                        header is written once after our file header.
 *   - The FULL FILE HEADER is passed as `ad` on chunk 1, binding magic,
 *     version, KDF params, salt, passProfile and streamHeader into the
 *     first chunk's MAC.
 *   - Web Crypto API — `crypto.getRandomValues` for the CSPRNG.
 *   - zod — envelope metadata validation.
 *
 * ── THREAT-MODEL NOTES (read before reusing this module) ──────────────
 *
 * 1. STREAMING DECRYPT IS PREFIX-AUTHENTICATED, NOT WHOLE-FILE ATOMIC.
 *    `decryptCesvuStream` yields each chunk as soon as ITS OWN MAC
 *    verifies, and only discovers a missing TAG_FINAL after the last chunk.
 *    Chunk contents therefore cannot be forged, but a valid file TRUNCATED
 *    after any TAG_MESSAGE will yield a genuine prefix (and fire
 *    `onMetadata`) before the generator throws. Consumers MUST treat
 *    yielded bytes and metadata as PROVISIONAL and commit only after the
 *    generator completes normally — write to a temp sink and rename, or
 *    buffer. You cannot stream unboundedly AND retract already-consumed
 *    output when final authentication fails; pick one per call site.
 *
 * 2. ARGON2 PARAMS ARE ATTACKER-CONTROLLED AND USED PRE-AUTHENTICATION.
 *    The header can't be authenticated until the key is derived, so a
 *    hostile file can demand up to KDF_MEMORY_KIB_MAX (256 MiB) at
 *    KDF_TIME_COST_MAX (10) per attempt. Range checks reject absurd values
 *    but cannot remove this cost. That is acceptable ONLY because every
 *    current call site is a local, user-initiated browser operation where
 *    attacker and victim are the same person. If this module is ever run
 *    server-side, in a worker pool, or over uploaded files, it MUST gain:
 *    bounded Argon2 concurrency, per-caller rate limiting (including on
 *    `verifyPassphrase`, which is equally expensive), and a stricter local
 *    acceptance policy than the protocol maximum. Do NOT derive keys just
 *    to inspect a file's metadata.
 */


import _sodium from 'libsodium-wrappers-sumo';
import type * as SodiumNS from 'libsodium-wrappers-sumo';
import { z } from 'zod';



// ── libsodium readiness (one-time WASM load) ───────────────────────────

let _ready: Promise<typeof _sodium> | null = null;

export function sodiumReady(): Promise<typeof _sodium> {
	if (_ready) return _ready;
	const p = _sodium.ready.then(() => _sodium);
	_ready = p;
	return p;
}

// ── Reusable TextEncoder / TextDecoder ─────────────────────────────────


const _encoder = new TextEncoder();
const _decoder = new TextDecoder();

// ── Public constants ──────────────────────────────────────────────────

/** Six ASCII bytes. Bytes 0–5 of every .cesvu file. */
export const MAGIC = _encoder.encode('.CESVU');

/**
 * Current envelope version. Bytes 6–7 (uint16 BE).
 *
 * v1 is XChaCha20-Poly1305 secretstream
 */
export const VERSION = 1 as const;

/** Canonical EFF large wordlist length. Used by diceware sampling. */
export const EFF_WORDLIST_LEN = 7776;

/**
 * Largest preamble we'll read or write, in UTF-8 encoded bytes. Bytes 8–9
 * (the `preambleLen` uint16 field) can address up to 65535, but this is a
 * deliberate app-level sanity ceiling — same "narrow the theoretical range
 * down to a sane, product-specific window" pattern used for the KDF params
 * and chunk size below.
 *
 * Raised from 1024 → 4096 historically to give producer-side preamble text
 * room for a full short document rather than just a single short paragraph.
 * This is purely a wire-format ceiling on the `preambleLen` field this
 * package reads/writes when parsing/building any conformant .cesvu header —
 * this package itself always writes exactly {@link DEFAULT_PREAMBLE} on
 * encrypt and never inspects preamble content on decrypt (see parseHeader).
 * Does NOT affect on-disk size for a shorter preamble — `buildHeader` always
 * writes exactly `preambleBytes.length` bytes (never padded to the cap).
 *
 */
export const MAX_PREAMBLE_LEN = 4096;


/**
 * Sanity cap on the metadata JSON length prefix.
 */
export const MAX_METADATA_JSON_LEN = 4096;


/** 6 (magic) + 2 (version) + 2 (preamble length). Fixed. */
export const FIXED_PREFIX = 10;

/**
 * 1 (cipherMode) + 4 (KDF mem KiB, uint32 BE) + 1 (KDF time cost, uint8) +
 * 1 (passProfile) + 32 (salt slot) + 2 (chunkShift) + 32 (streamHeader slot)
 * + 32 (keyCheck). 
 */
export const POST_PREAMBLE_FIXED = 105;




/**
 * Length of the {@link buildHeader} `keyCheck` field: a 32-byte keyed
 * BLAKE2b tag over {@link KEYCHECK_CONTEXT}, keyed by the Argon2id-derived
 * stream key. It lets the UX detect a wrong passphrase with a single KDF
 * run and a constant-time compare — BEFORE any ciphertext chunk is pulled
 * (so we never have to stream/decrypt a huge file just to discover the
 * password was wrong). Publishing it leaks nothing about the key (one-way
 * keyed hash of a constant), and because the full header is bound as `ad`
 * on chunk 1 the field is also tamper-evident.
 */
export const KEYCHECK_LEN = 32;


/**
 * Argon2id `memory_cost`, in KiB, is stored LITERALLY in the header as a
 * uint32 BE (see {@link buildHeader}/{@link parseHeader}) and
 * range-checked against [KDF_MEMORY_KIB_MIN, KDF_MEMORY_KIB_MAX] BEFORE
 * any Argon2id run. A uint32 KiB-field addresses up to ~4 TiB of memory
 * (2^32 KiB), comfortably beyond any realistic Argon2id memory-cost
 * policy — KDF_MEMORY_KIB_MAX is nowhere near overflowing this.
 *
 * SECURITY (memory-exhaustion DoS): the KDF memory parameter is fully
 * attacker-controlled and is consumed BEFORE the header can be
 * authenticated (the chunk-1 MAC can only be verified once the key has
 * already been derived). Values outside this range are rejected with
 * `KDF_PARAMS_OUT_OF_RANGE` before Argon2id is invoked. libsodium's
 * `memLimit` wants BYTES, so the JS call site multiplies by 1024 once.
 */
export const KDF_MEMORY_KIB_MIN = 65536;   // 64 MiB
export const KDF_MEMORY_KIB_MAX = 262144;  // 256 MiB
export const KDF_MEMORY_KIB_DEFAULT = 65536; // 64 MiB (libsodium MODERATE-class)

/**
 * Argon2id `time_cost` (libsodium `opsLimit`), stored per-file in the
 * header as a single `uint8` byte and range-checked against
 * [KDF_TIME_COST_MIN, KDF_TIME_COST_MAX] BEFORE any Argon2id run — the
 * exact same fail-closed pattern already used for `memoryKiB`. The
 * default (3) matches libsodium `OPSLIMIT_MODERATE` and `argon2-cffi`'s
 * `time_cost=3`, preserving prior behavior for callers that don't
 * override it. libsodium's own valid range is [OPSLIMIT_MIN=1,
 * OPSLIMIT_MAX=4294967295], but realistic values never exceed single/low
 * double digits (RFC 9106 / OWASP guidance), so this protocol narrows the
 * allowed range to [1, 10] — the same "narrow libsodium's theoretical
 * range down to a sane, product-specific window" approach already used
 * for `memoryKiB`.
 */
export const KDF_TIME_COST_MIN = 1;
export const KDF_TIME_COST_MAX = 10;
export const KDF_TIME_COST_DEFAULT = 3;


/**
 * passProfile (1-byte header field): which normalization the decrypt side
 * applies to the passphrase before feeding it to the KDF. Strict — the
 * header byte selects EXACTLY ONE normalizer (single Argon2id derivation,
 * no try-both fallback). Any other value is rejected with
 * `KDF_PARAMS_OUT_OF_RANGE` before Argon2id runs.
 *
 *   1 = TEXT  → normalizeDicewarePassphrase (NFKC + trim + collapse ws + lowercase)
 *   2 = EMOJI → normalizeEmojiPassphrase   (NFC + delete variation-selectors/ZWJ/bidi + delete CANONICAL_WHITESPACE)
 *   3 = RAW   → normalizeRawPassphrase     (IDENTITY — no transformation whatsoever)
 */
export const PASS_PROFILE_TEXT = 1 as const;
export const PASS_PROFILE_EMOJI = 2 as const;
export const PASS_PROFILE_RAW = 3 as const;

export type PassProfile =
	| typeof PASS_PROFILE_TEXT
	| typeof PASS_PROFILE_EMOJI
	| typeof PASS_PROFILE_RAW;

/** The passphraseType string the encrypt API accepts. */
export type PassphraseType = 'diceware' | 'emoji' | 'raw';

/**
 * App-level max length for a PASS_PROFILE_RAW (arbitrary user-chosen)
 * password, measured in **UTF-8 BYTES**. NOT a cryptographic necessity —
 * libsodium's Argon2id accepts inputs up to `crypto_pwhash_PASSWD_MAX`
 * (~4 GiB) with no meaningful performance difference by password length.
 * This cap exists purely as app-level hygiene (reject obviously-pathological
 * input, e.g. an accidental clipboard paste of an entire file) and MUST be
 * enforced identically by the Python CLI — see .cesvu SPEC/README.md
 * § "passProfile normalization".
 *
 * BYTES, not characters. `String.prototype.length` counts UTF-16 code units
 * and Python's `len()` counts code points; the two disagree for astral
 * characters, so neither is a portable measure and the old
 * `passphrase.length` check made the two tools reject different passwords.
 *
 * WHY 512 AND NOT MORE — this bound is not arbitrary and must not be raised
 * in isolation. The web app's decrypt entry points (SecureOpenModal,
 * ImportModal) refuse to submit a RAW passphrase longer than this, using
 * {@link rawPassphraseByteLength} so they measure the SAME quantity this
 * constant is expressed in. Raise this without raising the UI's gate and
 * the CLI becomes able to create files whose passphrase cannot be entered
 * in the web app at all — permanently unopenable there, in violation of the
 * format spec's requirement that the web decrypt path accept any
 * passProfile = 3 file. Invariant to preserve:
 *
 *     RAW_PASSPHRASE_MAX_BYTES <= the web app's RAW passphrase gate
 *
 * The UI enforces this as a disabled submit button, NOT an <input
 * maxlength>. That is deliberate: `maxlength` silently truncates a pasted
 * password, which would hand the user a *different* passphrase than the one
 * they pasted and fail with "wrong passphrase" — or, worse on an encrypt
 * path, encrypt under a password they never saw. A disabled button with a
 * visible counter tells them what is wrong instead.
 */
export const RAW_PASSPHRASE_MAX_BYTES = 512;

/**
 * Length of `passphrase` in UTF-8 BYTES — the unit
 * {@link RAW_PASSPHRASE_MAX_BYTES} is expressed in, and therefore the only
 * correct thing for a UI to count against it.
 *
 * Exists because `String.prototype.length` (UTF-16 code units) is the
 * obvious-looking substitute and is wrong in both directions:
 *
 *   - It OVER-counts astral characters: 256 emoji is 512 units, so a
 *     "512 characters" gate blocks a 256-character password at half the
 *     real limit while displaying a count the user cannot reconcile with
 *     what they typed.
 *   - It UNDER-counts everything above ASCII: 512 CJK characters is 512
 *     units but 1536 bytes, so a units-based gate enables submit on a
 *     passphrase the crypto layer then rejects with PASSPHRASE_TOO_LONG.
 *
 * Counting bytes removes both. Callers should use this for the counter they
 * display AND the condition they gate on, so the number on screen is the
 * number being enforced.
 */
export function rawPassphraseByteLength(passphrase: string): number {
	return _encoder.encode(passphrase).length;
}




/**
 * Default chunk shift: `chunkSize = 1 << CHUNK_SHIFT_DEFAULT = 1 MiB`.
 */
export const CHUNK_SHIFT_DEFAULT = 20;

/** Allowed range for chunkShift (64 KiB … 16 MiB). */
export const CHUNK_SHIFT_MIN = 16;
export const CHUNK_SHIFT_MAX = 24;

// ── Cipher mode enum (1-byte header field) ─────────────────────────────

export const CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305 = 1 as const;

export const CIPHER_MODE_AEAD_CHACHA20POLY1305_IETF = 2 as const;

export const CIPHER_MODE_NAMES = {
	[CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305]: 'secretstream_xchacha20poly1305',
	[CIPHER_MODE_AEAD_CHACHA20POLY1305_IETF]: 'aead_chacha20poly1305_ietf'
} as const satisfies Record<number, string>;

export type CipherModeName = (typeof CIPHER_MODE_NAMES)[keyof typeof CIPHER_MODE_NAMES];

const IMPLEMENTED_CIPHER_MODES: ReadonlySet<number> = new Set([
	CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305
]);


/** libsodium constants (cached at module scope after WASM load). */
let _secretstreamHeaderBytes = 0;
let _secretstreamABytes = 0;
let _pwhashSaltBytes = 0;
let _memzero: ((buf: Uint8Array) => void) | null = null;
let _constantsReady = false;

async function loadSodiumConstants(): Promise<void> {
  if (_constantsReady) return;
  const s = await sodiumReady();
  _secretstreamHeaderBytes = s.crypto_secretstream_xchacha20poly1305_HEADERBYTES;
  _secretstreamABytes = s.crypto_secretstream_xchacha20poly1305_ABYTES;
  _pwhashSaltBytes = s.crypto_pwhash_SALTBYTES;
  _memzero =
    typeof s.memzero === 'function'
      ? (buf) => {
          s.memzero(buf);
        }
      : (buf) => {
          buf.fill(0);
        };
  if (
    _secretstreamHeaderBytes === undefined ||
    _secretstreamABytes === undefined ||
    _pwhashSaltBytes === undefined ||
    typeof s.crypto_pwhash !== 'function' ||
    typeof s.crypto_secretstream_xchacha20poly1305_ABYTES !== 'number'
  ) {
    throw new Error(
      'libsodium-wrappers-sumo failed to load required constants. ' +
      'This is almost certainly the broken ESM build (libsodium-wrappers-sumo 0.7.x). ' +
      'Fix: pin libsodium-wrappers-sumo to a working version (0.7.13 has a working ESM build).'
    );
  }
  _constantsReady = true;
}

/**
 * Volatile zeroization. Uses libsodium's `sodium.memzero` when available
 * and falls back to `fill(0)`. Applied to key material and chunks we
 * allocated ourselves — NEVER to buffers the caller passed in.
 */
function secureZero(buf: Uint8Array): void {
	if (_memzero) {
		_memzero(buf);
	} else {
		buf.fill(0);
	}
}

/**
 * The canonical preamble. Always written on encrypt — matches the web app's
 * DEFAULT_PREAMBLE exactly (src/lib/crypto/cesvu-crypto.ts). There is no
 * longer a caller-supplied override; see the removed `EncryptOptions.preamble`
 * field below.
 */
export const DEFAULT_PREAMBLE =
	'\r\n' +
	'This is an encrypted .cesvu file. Decrypt it free at https://cesvu.com with the sender\'s passcode.\r\n' +
	'Need to send them an encrypted reply with the same passcode? https://cesvu.com\r\n' +
	'Do not edit this file! Modifications will cause data loss.\r\n';


// ── Error type ────────────────────────────────────────────────────────

export type CesvuErrorCode =
	| 'TOO_SHORT'
	| 'BAD_MAGIC'
	| 'UNSUPPORTED_VERSION'
	| 'UNSUPPORTED_CIPHER_MODE'
	| 'BAD_PREAMBLE_LENGTH'
	| 'KDF_PARAMS_OUT_OF_RANGE'
	| 'CHUNK_SIZE_OUT_OF_RANGE'
	| 'STREAM_HEADER_INVALID'
	| 'DECRYPT_FAILED'
	| 'METADATA_CORRUPT'
	| 'METADATA_INCOMPLETE'
	// ── Caller-input codes ───────────────────────────────────────────
	//
	// These describe the PASSPHRASE THE CALLER SUPPLIED, not the file, and
	// are raised before Argon2id runs on both encrypt and decrypt. They
	// leak nothing: a conforming producer cannot have written a file whose
	// passphrase violates them, so rejecting on decrypt can never refuse a
	// legitimate file — it only replaces a mystifying
	// WRONG_PASSPHRASE_OR_HEADER_TAMPER with something actionable.
	| 'PASSPHRASE_TOO_LONG'
	| 'PASSPHRASE_INVALID_ENCODING'
	// ── Post-authentication failure codes ────────────────────────────
	//
	// Everything above can occur BEFORE we know the passphrase is right.
	// The codes below are reachable ONLY after the header's keyCheck AND
	// the first ciphertext segment's Poly1305 MAC have both verified —
	// i.e. the passphrase is already cryptographically proven correct.
	//
	// They exist because collapsing these into DECRYPT_FAILED ("Wrong
	// passphrase") is not merely unhelpful, it is FALSE: it tells the
	// user to retry a 256 MiB / time-cost-10 Argon2id derivation that
	// cannot possibly succeed, since the derivation already succeeded.
	// The file is damaged, not the password.
	//
	// No oracle concern: reaching any of these requires already holding
	// the correct passphrase, so they reveal nothing to an attacker who
	// does not have it.
	| 'CIPHERTEXT_CORRUPT'
	| 'METADATA_CORRUPT_POST_AUTH'
	| 'TRUNCATED'
	| 'TRAILING_DATA'
	// Pre-authentication. Deliberately ambiguous: a failed keyCheck or
	// first-segment MAC is indistinguishable from a tampered header, and
	// must stay that way so the error can't be used to confirm which of
	// the two occurred.
	| 'WRONG_PASSPHRASE_OR_HEADER_TAMPER';





export class CesvuError extends Error {
	constructor(
		public readonly code: CesvuErrorCode,
		message?: string
	) {
		super(message ?? code);
		this.name = 'CesvuError';
	}
}

const PRODUCER_NONCONFORMANT = ' The file is non-conformant with the .cesvu v1 spec — the producer (the tool that generated this file) is responsible.';

// ── KDF params Zod schema (used for the envelope body AND at write time)

/**
 * v1 KDF schema. `memoryKiB` is bounded to [KDF_MEMORY_KIB_MIN,
 * KDF_MEMORY_KIB_MAX]; `timeCost` to [KDF_TIME_COST_MIN, KDF_TIME_COST_MAX];
 * `chunkShift` to [CHUNK_SHIFT_MIN, CHUNK_SHIFT_MAX].
 */
const KDFParamsSchema = z.object({
	memoryKiB: z.number().int().min(KDF_MEMORY_KIB_MIN).max(KDF_MEMORY_KIB_MAX),
	timeCost: z.number().int().min(KDF_TIME_COST_MIN).max(KDF_TIME_COST_MAX),
	chunkShift: z.number().int().min(CHUNK_SHIFT_MIN).max(CHUNK_SHIFT_MAX)
});


// ── Envelope metadata (encrypted payload prefix) ─────────────────────

/**
 * ⚠️ UNIT: Zod's `.max(n)` on a string counts **UTF-16 code units** (it is
 * `String.prototype.length`), NOT code points. The Python mirror's `len()`
 * counts code points. See "Metadata field length limits" in
 * .cesvu SPEC/README.md — the unit is normative, not incidental.
 *
 * Because code points <= UTF-16 units for every string, this schema is the
 * STRICTER of the two, which is why it needs no extra check:
 *
 *   - As a WRITER (packMetadata / encryptCesvu), anything that passes here
 *     is automatically within Python's code-point limit, so this side can
 *     never emit metadata the CLI refuses to read.
 *   - As a READER (unpackMetadata), this rejects astral-heavy values the
 *     Python reader accepts — e.g. a 200-emoji filename is 200 code points
 *     but 400 UTF-16 units. That gap was closed on the PYTHON WRITER, which
 *     now enforces both measures, rather than by loosening this reader.
 *
 * Do NOT "fix" the asymmetry by switching these to a code-point measure
 * (e.g. `[...s].length`): that would widen this reader AND this writer,
 * letting the web app produce files the CLI cannot read — reintroducing the
 * bug in the opposite direction. Change either side only alongside the
 * format doc and CLI/cesvu/tests/test_metadata_length_units.py.
 */
export const CesvuMetadataSchema = z.object({
	filename: z.string().max(255),
	mimeType: z.string().max(127).default('text/plain'),
	createdAt: z.number().int().nonnegative(),
	template: z.string().max(63).optional()
});

export type CesvuMetadata = z.infer<typeof CesvuMetadataSchema>;

// ── CSPRNG ─────────────────────────────────────────────────────────────

export function randomBytes(n: number): Uint8Array {
  if (n == null) {
    throw new RangeError(
      'randomBytes: n is null/undefined — the caller must pass an explicit ' +
      'byte count. This is a bug in the call site, not a libsodium/WASM ' +
      'loading issue.'
    );
  	}

	if (n === 0) return new Uint8Array(0);
	if (n > 65536) {
		throw new RangeError(`randomBytes: n=${n} exceeds 65536-byte single-call cap`);
	}
	if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.getRandomValues !== 'function') {
		throw new Error('randomBytes: no CSPRNG available (Web Crypto missing)');
	}
	const out = new Uint8Array(n);
	globalThis.crypto.getRandomValues(out);
	return out;
}

// ── Chunk splitter (security review: P0 — multi-chunk decrypt) ───────

function* splitCipherChunks(
        cipherBody: Uint8Array,
        chunkSize: number,
        abBytes: number,
        from = 0
): Generator<Uint8Array, void, undefined> {
        const segmentSize = chunkSize + abBytes;
        for (let off = from; off < cipherBody.length; off += segmentSize) {
                const end = Math.min(off + segmentSize, cipherBody.length);
                yield cipherBody.subarray(off, end);
        }
}

/** Concatenate two Uint8Arrays into a freshly-allocated buffer. */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}


// ── EFF large wordlist (bundled, lazy-loaded) ─────────────────────────

let _wordlistCache: string[] | null = null;
let _wordlistPromise: Promise<string[]> | null = null;

async function loadEffWordlist(): Promise<string[]> {
	if (_wordlistCache) return _wordlistCache;
	if (_wordlistPromise) return _wordlistPromise;
	_wordlistPromise = (async () => {
		const mod = await import('./wordlists/eff-wordlist.js');
		const raw = mod.default;
		if (!Array.isArray(raw) || raw.length !== EFF_WORDLIST_LEN) {
			throw new CesvuError(
				'TOO_SHORT',
				`eff-wordlist.json: expected ${EFF_WORDLIST_LEN} strings, got ${Array.isArray(raw) ? raw.length : 'non-array'}`
			);
		}
		_wordlistCache = raw as string[];
		return _wordlistCache;
	})();
	return _wordlistPromise;
}

let _wordSetCache: Set<string> | null = null;
let _wordSetPromise: Promise<Set<string>> | null = null;

async function loadEffWordSet(): Promise<Set<string>> {
	if (_wordSetCache) return _wordSetCache;
	if (_wordSetPromise) return _wordSetPromise;
	_wordSetPromise = loadEffWordlist().then((list) => {
		_wordSetCache = new Set(list);
		return _wordSetCache;
	});
	return _wordSetPromise;
}

export async function isDicewareWord(word: string): Promise<boolean> {
	const trimmed = word.trim().toLowerCase();
	if (trimmed.length === 0) return false;
	const set = await loadEffWordSet();
	return set.has(trimmed);
}

// ── Diceware passphrase generation ─────────────────────────────────────

const LIMIT = 65536 - (65536 % EFF_WORDLIST_LEN); // 62208

export async function generateDicewarePassphrase(wordCount: number = 6): Promise<string[]> {
	const normalizedCount = Math.min(24, Math.max(6, wordCount));
	const wordlist = await loadEffWordlist();
	const out: string[] = new Array(normalizedCount);

	const BATCH_BYTES = 64;
	let batch = randomBytes(BATCH_BYTES);
	let batchPos = 0;

	for (let i = 0; i < normalizedCount; i++) {
		let value: number;

		do {
			if (batchPos >= batch.length) {
				batch = randomBytes(BATCH_BYTES);
				batchPos = 0;
			}
			value = (batch[batchPos] << 8) | batch[batchPos + 1];
			batchPos += 2;
		} while (value >= LIMIT);

		out[i] = wordlist[value % EFF_WORDLIST_LEN];
	}

	return out;
}

// ── Passphrase normalization ──────────────────────────────────────────
//
// ⚠️ NOTHING IN THIS SECTION MAY USE `\s`, `trim()`, `toLowerCase()`, OR
// `normalize('NFKC')`. Normalization is KEY-DETERMINING: if this file and
// CLI/cesvu/src/cesvu/cesvu_crypto.py disagree by even one code point,
// the same typed passphrase derives two different Argon2id keys and the
// file fails to open with no useful diagnostic.
//
// Every one of those built-ins is defined differently per language AND per
// Unicode version. Measured, Python 3.13 (Unicode 15) vs Node 24
// (Unicode 16):
//
//   U+001C–U+001F, U+0085 : Python's \s matches, JavaScript's does NOT
//   U+FEFF                : JavaScript's \s matches, Python's does NOT
//   NFKC                  : differs on 37 code points
//   case mapping          : differs on 55 code points
//   NFC                   : differs on 0  ← why NFC is the one we keep
//
// Only the explicit tables below are portable. See .cesvu SPEC/README.md
// § "passProfile normalization (must match exactly)", and the shared
// vectors in shared/passphrase-vectors.json which both test suites run.

/**
 * The 30 code points treated as whitespace by this format — the UNION of
 * the Python and JavaScript whitespace sets, so that neither implementation
 * depends on its own runtime's notion of whitespace. Exactly these, no
 * others. Do not add to this set without changing the format spec and the
 * shared vectors: adding a code point silently changes derived keys for
 * every passphrase containing it.
 */
export const CANONICAL_WHITESPACE: ReadonlySet<number> = new Set([
	0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x001c, 0x001d, 0x001e, 0x001f,
	0x0020, 0x0085, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
	0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
	0x205f, 0x3000, 0xfeff
]);

/**
 * Deleted outright by profile 2, in addition to CANONICAL_WHITESPACE:
 * variation selectors, zero-width joiners/non-joiners/space, BOM, and the
 * bidi embedding/override/isolate controls.
 */
const EMOJI_DELETE: ReadonlySet<number> = new Set([
	0xfe0e, 0xfe0f,
	0x200b, 0x200c, 0x200d,
	0xfeff,
	0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
	0x2066, 0x2067, 0x2068, 0x2069
]);

/**
 * Iterate a string by CODE POINT (not UTF-16 code unit), so that astral
 * characters are handled as single units and a well-formed surrogate pair
 * is never mistaken for two lone surrogates.
 */
function* codePoints(s: string): Generator<number, void, undefined> {
	for (const ch of s) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) {
			// Unreachable: `for...of` over a string always yields a
			// non-empty code point (a single UTF-16 unit or a valid
			// surrogate pair), so `codePointAt(0)` can never be undefined
			// here. Checked explicitly rather than asserted so a violation
			// of that invariant fails loudly instead of poisoning a
			// passphrase derivation with NaN.
			throw new Error('unreachable: codePointAt(0) returned undefined for a for-of character');
		}
		yield cp;
	}
}

/**
 * Canonicalize a diceware passphrase before it is fed to the KDF
 * (profile 1 — also the DEFAULT profile, so it must be well-defined for
 * arbitrary input, not merely for wordlist input).
 *
 * Idempotent; safe to call on already-normalized input.
 *
 *   1. every CANONICAL_WHITESPACE code point → U+0020
 *   2. collapse runs of U+0020; drop leading/trailing U+0020
 *   3. NFC (never NFKC)
 *   4. lowercase ASCII A–Z ONLY; no other code point is altered
 */
export function normalizeDicewarePassphrase(passphrase: string): string {
	// 1 + 2: replace, collapse, trim — all driven by the explicit table.
	const words: string[] = [];
	let current = '';
	for (const cp of codePoints(passphrase)) {
		if (CANONICAL_WHITESPACE.has(cp)) {
			if (current.length > 0) {
				words.push(current);
				current = '';
			}
		} else {
			current += String.fromCodePoint(cp);
		}
	}
	if (current.length > 0) words.push(current);

	// 3: NFC, not NFKC.
	const nfc = words.join(' ').normalize('NFC');

	// 4: ASCII-only lowercase. Deliberately NOT toLowerCase(), which is
	// Unicode-wide, locale-sensitive in some engines, and version-skewed.
	let out = '';
	for (let i = 0; i < nfc.length; i++) {
		const c = nfc.charCodeAt(i);
		out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 32) : nfc[i];
	}
	return out;
}

// ── Emoji passphrase generation ────────────────────────────────────────

export const EMOJI_WORDLIST_LEN = 800;

let _emojiWordlistCache: string[] | null = null;
let _emojiWordlistPromise: Promise<string[]> | null = null;

async function loadEmojiWordlist(): Promise<string[]> {
	if (_emojiWordlistCache) return _emojiWordlistCache;
	if (_emojiWordlistPromise) return _emojiWordlistPromise;
	_emojiWordlistPromise = (async () => {
		const mod = await import('./wordlists/emoji-wordlist.js');
		const raw = mod.default;
		if (!Array.isArray(raw) || raw.length !== EMOJI_WORDLIST_LEN) {
			throw new CesvuError(
				'TOO_SHORT',
				`emoji-wordlist.json: expected ${EMOJI_WORDLIST_LEN} strings, got ${Array.isArray(raw) ? raw.length : 'non-array'}`
			);
		}
		_emojiWordlistCache = raw as string[];
		return _emojiWordlistCache;
	})();
	return _emojiWordlistPromise;
}

const EMOJI_LIMIT = 65536 - (65536 % EMOJI_WORDLIST_LEN);

export async function generateEmojiPassphrase(emojiCount: number = 8): Promise<string[]> {
	const normalizedCount = Math.min(100, Math.max(8, emojiCount));
	const wordlist = await loadEmojiWordlist();
	const out: string[] = new Array(normalizedCount);

	const BATCH_BYTES = 64;
	let batch = randomBytes(BATCH_BYTES);
	let batchPos = 0;

	for (let i = 0; i < normalizedCount; i++) {
		let value: number;

		do {
			if (batchPos >= batch.length) {
				batch = randomBytes(BATCH_BYTES);
				batchPos = 0;
			}
			value = (batch[batchPos] << 8) | batch[batchPos + 1];
			batchPos += 2;
		} while (value >= EMOJI_LIMIT);

		out[i] = wordlist[value % EMOJI_WORDLIST_LEN];
	}

	return out;
}

/**
 * Canonicalize an emoji passphrase (profile 2).
 *
 *   1. NFC
 *   2. delete EMOJI_DELETE (variation selectors, ZWSP/ZWNJ/ZWJ/BOM, bidi)
 *   3. delete every CANONICAL_WHITESPACE code point
 */
export function normalizeEmojiPassphrase(passphrase: string): string {
	const nfc = passphrase.normalize('NFC');
	let out = '';
	for (const cp of codePoints(nfc)) {
		if (EMOJI_DELETE.has(cp) || CANONICAL_WHITESPACE.has(cp)) continue;
		out += String.fromCodePoint(cp);
	}
	return out;
}

/**
 * Canonicalize an ARBITRARY user password (PASS_PROFILE_RAW) before the KDF.
 *
 * IDENTITY. No normalization, trimming, lowercasing, whitespace collapsing,
 * or any other transformation. Every code point, including U+0020, is
 * significant.
 *
 * NFC was applied here previously and was REMOVED deliberately. Profile 3
 * accepts arbitrary input, so it applies zero transformation.
 *
 * ⚠️ CONSEQUENCE, BY DESIGN: a password containing accented or composed
 * characters is device-dependent. "café" typed on macOS is often NFD
 * (`e` + U+0301) while the same password typed on Windows is NFC (U+00E9).
 * They render identically in every font but are DIFFERENT passwords and
 * derive different keys, with no diagnostic available to the user. The
 * format spec says user-facing custom-password entry points SHOULD warn
 * that non-ASCII characters may not transfer between devices — that
 * warning belongs in the Svelte entry point, not here.
 */
export function normalizeRawPassphrase(passphrase: string): string {
	return passphrase;
}

/** Apply the normalizer selected by a passProfile byte. */
export function normalizeForProfile(passphrase: string, profile: PassProfile): string {
	switch (profile) {
		case PASS_PROFILE_EMOJI:
			return normalizeEmojiPassphrase(passphrase);
		case PASS_PROFILE_RAW:
			return normalizeRawPassphrase(passphrase);
		case PASS_PROFILE_TEXT:
		default:
			return normalizeDicewarePassphrase(passphrase);
	}
}

/**
 * THE passphrase gate. Every entry point that is about to derive a key MUST
 * go through this and pass the resulting bytes to
 * {@link deriveKeyFromPassphrase} — that is why the derive function takes
 * `Uint8Array` and not `string`, so a call site physically cannot skip the
 * checks below.
 *
 * Applies, in the order the format spec mandates:
 *   1. reject surrogates (BEFORE encoding — see below)
 *   2. normalize per profile
 *   3. encode UTF-8
 *   4. reject empty
 *   5. reject over {@link RAW_PASSPHRASE_MAX_BYTES} — profile 3 ONLY
 *
 * ⚠️ WHY STEP 1 CANNOT BE DELEGATED TO THE ENCODER. This is the check that
 * cost real divergence. Given the input "ab\uD800cd":
 *
 *     Python  s.encode('utf-8')           raises UnicodeEncodeError
 *     JS      new TextEncoder().encode()  returns 6162 EFBFBD 6364 — no throw
 *
 * WHATWG *requires* TextEncoder to substitute U+FFFD and never throw, so
 * without this explicit scan JavaScript would silently derive a key from
 * bytes the user never typed while Python refused outright — the same typed
 * passphrase, two different outcomes. The scan iterates CODE POINTS, so a
 * well-formed surrogate pair (a normal astral character like an emoji) is
 * accepted; only LONE surrogates are rejected.
 */
export function preparePassphrase(passphrase: string, profile: PassProfile): Uint8Array {
	// 1. Lone surrogates, before any normalization or encoding.
	for (const cp of codePoints(passphrase)) {
		if (cp >= 0xd800 && cp <= 0xdfff) {
			throw new CesvuError(
				'PASSPHRASE_INVALID_ENCODING',
				'This passphrase contains an unpaired surrogate character (U+D800–U+DFFF), ' +
					'which cannot be encoded as UTF-8. This usually means the text was ' +
					'corrupted in transit — for example emoji pasted through a console or ' +
					'editor that split a character in half. Retype or re-paste it.'
			);
		}
	}

	// 2 + 3.
	const encoded = _encoder.encode(normalizeForProfile(passphrase, profile));

	// 4. Empty after normalization (e.g. a profile-1 passphrase of nothing
	// but whitespace, or a profile-2 one of nothing but joiners).
	if (encoded.length === 0) {
		throw new Error('preparePassphrase: passphrase is empty after normalization');
	}

	// 5. Byte cap, profile 3 only. Profiles 1 and 2 have no upper limit.
	if (profile === PASS_PROFILE_RAW && encoded.length > RAW_PASSPHRASE_MAX_BYTES) {
		throw new CesvuError(
			'PASSPHRASE_TOO_LONG',
			`This password is ${encoded.length} bytes when encoded as UTF-8, which exceeds the ${RAW_PASSPHRASE_MAX_BYTES}-byte limit. ` +
				'Note the limit is in bytes, not characters: accented, CJK and emoji ' +
				'characters each take 2–4 bytes, so a password can exceed it well ' +
				'before it reaches 512 visible characters.'
		);
	}

	return encoded;
}

/** Map the encrypt API's passphraseType string to the header's passProfile byte. */
export function passphraseTypeToProfile(t: PassphraseType | undefined): PassProfile {
	switch (t) {
		case 'emoji':
			return PASS_PROFILE_EMOJI;
		case 'raw':
			return PASS_PROFILE_RAW;
		case 'diceware':
		default:
			return PASS_PROFILE_TEXT;
	}
}

let _emojiSetCache: Set<string> | null = null;
let _emojiSetPromise: Promise<Set<string>> | null = null;

async function loadEmojiSet(): Promise<Set<string>> {
	if (_emojiSetCache) return _emojiSetCache;
	if (_emojiSetPromise) return _emojiSetPromise;
	_emojiSetPromise = loadEmojiWordlist().then((list) => {
		_emojiSetCache = new Set(list);
		return _emojiSetCache;
	});
	return _emojiSetPromise;
}

export async function isCuratedEmoji(emoji: string): Promise<boolean> {
	if (emoji.length === 0) return false;
	const set = await loadEmojiSet();
	return set.has(emoji);
}

// ── KDF (libsodium crypto_pwhash / Argon2id13) ────────────────────────

/**
 * Domain-separation context for the post-Argon2id key-derivation step (see
 * {@link deriveKeyFromPassphrase}). A fixed, versioned ASCII label so the
 * 32-byte secretstream key can never collide with a raw Argon2id output
 * used by any other application/protocol, even if that other use somehow
 * shared the same passphrase + salt + Argon2id parameters (see security
 * review: "No Domain Separation in KDF").
 */
const STREAM_KEY_CONTEXT = _encoder.encode('cesvu.com/v1/stream-key');

/**
 * Derive a 32-byte stream key from a passphrase using libsodium's
 * Argon2id13 (`ALG_ARGON2ID13`), followed by a domain-separation step.
 *
 * Both Argon2id `time_cost` (`kdf.timeCost`) and `memory_cost`
 * (`kdf.memoryKiB`) are range-checked here, BEFORE Argon2id runs, so an
 * untrusted header can never force an absurdly slow derivation or a giant
 * allocation.

 *
 * SECURITY (domain separation): the raw Argon2id output is NEVER used
 * directly as the secretstream key. Instead it is fed as the KEY to a
 * keyed BLAKE2b hash (`crypto_generichash`) of the fixed, app-specific
 * context string {@link STREAM_KEY_CONTEXT}, and THAT 32-byte output is
 * the actual stream key. This guarantees the derived key can never be
 * reused as-is by another application/protocol that happens to run
 * Argon2id with the same passphrase, salt, and parameters — the raw
 * Argon2id key is discarded and zeroized immediately after this step.
 *
 * Throws:
 *   - `TypeError` if `salt.length !== crypto_pwhash_SALTBYTES` (16 with
 *     standard libsodium — NOT 32; the header's 32-byte salt SLOT holds a
 *     SALTBYTES salt plus reserved bytes, see {@link buildHeader}).

 *   - `CesvuError('CHUNK_SIZE_OUT_OF_RANGE')` if chunkShift is out of range.
 *   - `CesvuError('KDF_PARAMS_OUT_OF_RANGE')` if memoryKiB is out of range.
 */
export async function deriveKeyFromPassphrase(

  // Uint8Array, NOT string, ON PURPOSE: the only supported way to produce
  // these bytes is preparePassphrase(), so no call site can reach Argon2id
  // while skipping the surrogate / normalization / length gate.
  passphraseBytes: Uint8Array,
  salt: Uint8Array,
  kdf: { memoryKiB: number; timeCost?: number; chunkShift: number }
): Promise<Uint8Array> {

  await loadSodiumConstants();
  if (salt.length !== _pwhashSaltBytes) {
    if (typeof _pwhashSaltBytes !== 'number' || _pwhashSaltBytes === 0) {
      throw new Error(
        'deriveKeyFromPassphrase: libsodium constants were not loaded before deriveKeyFromPassphrase was called. ' +
        'This is a bug in the encryption call path — a missing await on loadSodiumConstants() or a failed libsodium WASM init.'
      );
    }
    throw new TypeError(
      `deriveKeyFromPassphrase: salt must be ${_pwhashSaltBytes} bytes, got ${salt.length}`
    );
  }
	// Check chunkShift FIRST so out-of-range chunkShift is reported as
	// `CHUNK_SIZE_OUT_OF_RANGE`, not `KDF_PARAMS_OUT_OF_RANGE`.
	if (kdf.chunkShift < CHUNK_SHIFT_MIN || kdf.chunkShift > CHUNK_SHIFT_MAX) {
		throw new CesvuError(
			'CHUNK_SIZE_OUT_OF_RANGE',
			`The chunk size encoded as chunkShift=${kdf.chunkShift} is outside the cesvu v1 spec's allowed range (${CHUNK_SHIFT_MIN}..${CHUNK_SHIFT_MAX}, i.e. ${1 << CHUNK_SHIFT_MIN} bytes..${1 << CHUNK_SHIFT_MAX} bytes per chunk).${PRODUCER_NONCONFORMANT}`
		);
	}
	// SECURITY (memory-exhaustion DoS): range-check the attacker-controlled
	// Argon2id memory parameter BEFORE calling crypto_pwhash. The header
	// cannot be authenticated until AFTER the key is derived, so this
	// allocation happens on untrusted input — reject (fail-closed), never
	// clamp.
	if (
		!Number.isInteger(kdf.memoryKiB) ||
		kdf.memoryKiB < KDF_MEMORY_KIB_MIN ||
		kdf.memoryKiB > KDF_MEMORY_KIB_MAX
	) {
		throw new CesvuError(
			'KDF_PARAMS_OUT_OF_RANGE',
			`This file's KDF memory parameter (${kdf.memoryKiB} KiB) is outside the allowed range (${KDF_MEMORY_KIB_MIN}..${KDF_MEMORY_KIB_MAX} KiB).${PRODUCER_NONCONFORMANT}`
		);
	}
	// SECURITY: range-check the attacker-controlled Argon2id time_cost
	// parameter BEFORE calling crypto_pwhash — same fail-closed pattern as
	// memoryKiB above.
	const timeCost = kdf.timeCost ?? KDF_TIME_COST_DEFAULT;
	if (
		!Number.isInteger(timeCost) ||
		timeCost < KDF_TIME_COST_MIN ||
		timeCost > KDF_TIME_COST_MAX
	) {
		throw new CesvuError(
			'KDF_PARAMS_OUT_OF_RANGE',
			`This file's KDF time cost parameter (${timeCost}) is outside the allowed range (${KDF_TIME_COST_MIN}..${KDF_TIME_COST_MAX}).${PRODUCER_NONCONFORMANT}`
		);
	}
	const s = await sodiumReady();
	const opsLimit = timeCost;
	// libsodium's memLimit is in BYTES; the header stores KiB.
	const memLimit = kdf.memoryKiB * 1024;


	const pwBytes = passphraseBytes;
	let rawKey: Uint8Array | null = null;
	try {
		rawKey = s.crypto_pwhash(32, pwBytes, salt, opsLimit, memLimit, s.crypto_pwhash_ALG_ARGON2ID13);
		// SECURITY (domain separation): never return the raw Argon2id output.
		// Run it through a keyed BLAKE2b hash of a fixed, app-specific context
		// string so the actual stream key can never collide with a raw
		// Argon2id key derived by any other application/protocol using the
		// same passphrase, salt, and parameters.
		const streamKey = s.crypto_generichash(32, STREAM_KEY_CONTEXT, rawKey);
		return streamKey;
	} finally {
		secureZero(pwBytes);
		if (rawKey) secureZero(rawKey);
	}
}


// ── keyCheck (fast wrong-passphrase detection) ────────────────────────

/**
 * Domain-separation context for the {@link computeKeyCheck} keyed hash.
 * A fixed, versioned ASCII label so the keyCheck tag can never collide
 * with any other use of the stream key.
 */
const KEYCHECK_CONTEXT = _encoder.encode('cesvu/keycheck/v1');

/**
 * Derive the header's {@link KEYCHECK_LEN}-byte `keyCheck` tag from the
 * Argon2id-derived stream `key`.
 *
 * `keyCheck = BLAKE2b(message = KEYCHECK_CONTEXT, key = key, out = 32)`.
 *
 * This is a one-way keyed hash of a constant, so exposing it in the (public)
 * header reveals nothing about the key or passphrase, yet anyone holding the
 * correct passphrase can recompute it and compare — letting the UX reject a
 * wrong passphrase after a SINGLE Argon2id run, before pulling any ciphertext
 * chunk.
 */
export async function computeKeyCheck(key: Uint8Array): Promise<Uint8Array> {
	const s = await sodiumReady();
	return s.crypto_generichash(KEYCHECK_LEN, KEYCHECK_CONTEXT, key);
}

/**
 * Constant-time equality for two byte arrays. Uses libsodium's `memcmp`
 * when available (branch-free), else a constant-time XOR-accumulate fallback.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	// Prefer libsodium's branch-free memcmp when the module is loaded.
	if (typeof _sodium.memcmp === 'function') {
		try {
			return _sodium.memcmp(a, b);
		} catch {
			// fall through to manual path
		}
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

/**
 * Check a passphrase against ONLY the header's unauthenticated `keyCheck`
 * tag.
 *
 * ⚠️ SECURITY — THIS IS NOT PROOF THAT THE PASSPHRASE WILL DECRYPT THE FILE.
 *
 * `keyCheck` lives in the PUBLIC, UNAUTHENTICATED header. Nothing in this
 * function consults a single byte of ciphertext, so nothing here verifies a
 * secretstream MAC. An attacker who can modify the file can rewrite the
 * `salt`, KDF params, `passProfile`, `streamHeader` and `keyCheck` fields
 * together as a consistent set, making this function return `true` for a
 * passphrase of the ATTACKER'S choosing. The original ciphertext will then
 * fail to decrypt.
 *
 * (During a real decrypt the full header IS bound as `ad` into chunk 1's
 * MAC, so tampering is caught there — but that binding is verified by
 * pulling ciphertext, which this function never does.)
 *
 * Use this ONLY as a latency optimization for interactive UX (e.g. greying
 * out an "Unlock" button). NEVER use it for authorization, an access-control
 * decision, or as confirmation that a file will open. For those, use
 * {@link verifyPassphrase}, which authenticates against real ciphertext.
 *
 * `bytes` need only contain the file header (the leading
 * `FIXED_PREFIX + preambleLen + POST_PREAMBLE_FIXED` bytes); passing the
 * whole file is fine too. Returns `true`/`false` and never throws on a wrong
 * passphrase — it only throws if the header itself is malformed (the same
 * `CesvuError`s {@link parseHeader} raises) or the passphrase is empty.
 */
export async function matchesUnauthenticatedHeaderKeyCheck(
	bytes: Uint8Array,
	passphrase: string
): Promise<boolean> {
	const { salt, kdf, passProfile, keyCheck } = await parseHeader(bytes);
	const pwBytes = preparePassphrase(passphrase, passProfile);
	const key = await deriveKeyFromPassphrase(pwBytes, salt, {
		memoryKiB: kdf.memoryKiB,
		timeCost: kdf.timeCost,
		chunkShift: kdf.chunkShift
	});
	try {
		const computed = await computeKeyCheck(key);
		return constantTimeEqual(computed, keyCheck);
	} finally {
		secureZero(key);
	}
}

/**
 * Verify a passphrase against a .cesvu v1 file by AUTHENTICATING it against
 * the file's FIRST CIPHERTEXT SEGMENT — without decrypting the whole body.
 *
 * This is the trustworthy passphrase check. It:
 *   1. parses the header,
 *   2. runs Argon2id ONCE with the header's salt/params and the normalizer
 *      selected by the header's `passProfile`,
 *   3. compares the header's `keyCheck` tag as a cheap early reject (an
 *      OPTIMIZATION only — never treated as proof), and
 *   4. runs `crypto_secretstream_..._pull` over the first ciphertext segment
 *      with the FULL HEADER as `ad`.
 *
 * Step 4 is what makes the answer meaningful: that MAC covers both the
 * ciphertext and every header field (magic, version, KDF params, salt,
 * passProfile, streamHeader and keyCheck itself), so a header rewritten to
 * match an attacker-chosen password cannot produce a `true` result.
 *
 * Because it must see real ciphertext, `bytes` MUST contain the header plus
 * at least the first encrypted segment. Passing the whole file is fine and is
 * the normal case; only the first segment is ever examined, so this stays
 * cheap on huge files. Throws `CesvuError('TOO_SHORT')` if the ciphertext is
 * absent or shorter than one secretstream MAC — a header alone can never be
 * authenticated, so this reports that rather than guessing.
 *
 * Returns `true`/`false` and never throws on a merely wrong passphrase.
 *
 * SCOPE OF A `true` RESULT — read before relying on it. `true` means
 * exactly: "this passphrase derives a key that authenticates this file's
 * header and its FIRST ciphertext segment." It does NOT mean:
 *   - that the REST of the file is intact (later segments are never read),
 *   - that the file is complete (a missing TAG_FINAL cannot be seen here),
 *   - that the file will decrypt end-to-end without error.
 *
 * A file truncated or corrupted after segment 1 will still return `true`
 * here and then fail later in {@link decryptCesvu} /
 * {@link decryptCesvuStream} with `TRUNCATED` or `CIPHERTEXT_CORRUPT`.
 * That is the intended division of labour — this answers "is the
 * passphrase right?", not "is the file whole?" — but callers must not
 * conflate the two, and must not treat a `true` here as an integrity
 * guarantee for the file as a whole.
 */
export async function verifyPassphrase(bytes: Uint8Array, passphrase: string): Promise<boolean> {

	await loadSodiumConstants();
	const s = await sodiumReady();
	const { salt, kdf, passProfile, streamHeader, keyCheck, ciphertextOffset } =
		await parseHeader(bytes);

	const headerBytes = bytes.subarray(0, ciphertextOffset);
	const cipherBody = bytes.subarray(ciphertextOffset);
	// Fail closed: with no ciphertext there is no MAC to authenticate
	// against, and silently degrading to a keyCheck-only comparison is
	// exactly the unauthenticated behavior this function exists to avoid.
	if (cipherBody.length < _secretstreamABytes) {
		throw new CesvuError(
			'TOO_SHORT',
			`verifyPassphrase needs the header plus at least the first ciphertext segment (got ${cipherBody.length} ciphertext bytes, need at least ${_secretstreamABytes}). Pass the whole file. To check only the unauthenticated header keyCheck, call matchesUnauthenticatedHeaderKeyCheck() — but read its security warning first.`
		);
	}

	// Gate the caller's passphrase before spending an Argon2id run on it.
	const pwBytes = preparePassphrase(passphrase, passProfile);

	// Only the first segment is needed; a short final segment is fine.
	const segmentSize = (1 << kdf.chunkShift) + _secretstreamABytes;
	const firstSeg = cipherBody.subarray(0, Math.min(cipherBody.length, segmentSize));

	const key = await deriveKeyFromPassphrase(pwBytes, salt, {
		memoryKiB: kdf.memoryKiB,
		timeCost: kdf.timeCost,
		chunkShift: kdf.chunkShift
	});
	try {
		// Cheap early reject on the SAME derived key (no second Argon2id
		// run). This is a latency optimization: a mismatch is conclusive
		// proof of failure, but a match proves nothing on its own, so a
		// match still falls through to the real MAC check below.
		const computed = await computeKeyCheck(key);
		if (!constantTimeEqual(computed, keyCheck)) return false;

		// The authoritative check: authenticate the first segment with the
		// full header bound as associated data.
		const result = (s.crypto_secretstream_xchacha20poly1305_pull as unknown as (
			state: SodiumNS.StateAddress,
			cipher: Uint8Array,
			ad: Uint8Array | null
		) => { message: Uint8Array; tag: number } | false | undefined)(
			s.crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, key),
			firstSeg,
			headerBytes
		);
		return result ? true : false;
	} catch {
		// A tampered streamHeader can make init_pull/pull throw rather than
		// return false. Either way the passphrase does not authenticate.
		return false;
	} finally {
		secureZero(key);
	}
}




// ── Payload metadata (length-prefixed JSON, inside the ciphertext) ───

export function packMetadata(meta: CesvuMetadata): Uint8Array {
	const validated = CesvuMetadataSchema.parse(meta);
	const json = _encoder.encode(JSON.stringify(validated));
	const out = new Uint8Array(2 + json.byteLength);
	new DataView(out.buffer).setUint16(0, json.byteLength, false);
	out.set(json, 2);
	return out;
}

export interface UnpackedMetadata {
	meta: CesvuMetadata;
	/** Total bytes consumed: 2 (uint16 prefix) + JSON byte length. */
	byteLen: number;
}

export function unpackMetadata(bytes: Uint8Array): UnpackedMetadata {
	if (bytes.length < 2) {
		throw new CesvuError(
			'METADATA_INCOMPLETE',
			`This .cesvu file's decrypted payload is too short to contain metadata yet (got ${bytes.length} bytes, need at least 2).`
		);
	}
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const len = dv.getUint16(0, false);
	if (len === 0 || len > MAX_METADATA_JSON_LEN) {
		throw new CesvuError(
			'METADATA_CORRUPT',
			`This .cesvu file's metadata length prefix (${len}) is out of range (must be 1..${MAX_METADATA_JSON_LEN}).${PRODUCER_NONCONFORMANT}`
		);
	}
	if (len > bytes.length - 2) {
		throw new CesvuError(
			'METADATA_INCOMPLETE',
			`This .cesvu file's metadata (${len} bytes) hasn't fully arrived yet (have ${bytes.length - 2} bytes so far).`
		);
	}
	const jsonBytes = bytes.subarray(2, 2 + len);

	let json: unknown;
	try {
		json = JSON.parse(_decoder.decode(jsonBytes));
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
			`This .cesvu file's metadata JSON doesn't match the cesvu v1 schema.${PRODUCER_NONCONFORMANT}`
		);
	}
	return { meta: result.data, byteLen: 2 + len };
}

// ── Header construction (SINGLE SOURCE OF TRUTH for write offsets) ──

/** What the header writer needs. */
export interface HeaderParts {
	preamble: string;
	salt: Uint8Array;
	kdf: { memoryKiB: number; timeCost: number; chunkShift: number };

	/** Which passphrase normalization the decrypt side must apply (default TEXT). */
	passProfile?: PassProfile;
	streamHeader: Uint8Array;
	/**
	 * 32-byte {@link computeKeyCheck} tag for fast wrong-passphrase
	 * detection. MUST be `computeKeyCheck(key)` for the same key used to
	 * init the secretstream.
	 */
	keyCheck: Uint8Array;
	/**
	 * Cipher mode byte to write (see {@link CIPHER_MODE_NAMES}). Defaults
	 * to {@link CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305}.
	 */
	cipherMode?: number;
}



/**
 * Build the ENTIRE .cesvu v1 header. One function owns all write offsets.
 *
 * Header layout (v1):
 *    0        6   magic '.CESVU'
 *    6        2   version (uint16 BE) = 1
 *    8        2   preamble length (uint16 BE, 0..MAX_PREAMBLE_LEN = 4096)

 *    10       PL  preamble (UTF-8)
 *  Post-preamble (base = 10 + PL):
 *    base+0   1   cipherMode
 *    base+1   4   KDF memory KiB (uint32 BE; 65536..262144)
 *    base+5   1   KDF time cost (uint8, 1..10)
 *    base+6   1   passProfile (1=text, 2=emoji, 3=raw)
 *    base+7   32  salt SLOT — the first `crypto_pwhash_SALTBYTES` bytes are
 *                 the random salt; the remainder is RESERVED and MUST be
 *                 zero. libsodium's SALTBYTES is 16, so in practice this is
 *                 a 16-byte salt followed by 16 zero bytes. The SLOT is
 *                 fixed at 32 bytes so every following offset is stable
 *                 regardless of SALTBYTES. 128 bits of salt is ample; do
 *                 NOT "fix" this by widening the salt, which would break
 *                 the format. Matches .cesvu SPEC/README.md exactly.
 *    base+39  2   chunkShift (uint16 BE, 16..24)

 *    base+41  32  libsodium secretstream streamHeader
 *    base+73  32  keyCheck (keyed BLAKE2b tag; fast wrong-passphrase detect)
 *
 *  Total header size: FIXED_PREFIX (10) + PL + POST_PREAMBLE_FIXED (105).
 */


export async function buildHeader(parts: HeaderParts): Promise<Uint8Array> {
	await loadSodiumConstants();
	if (parts.streamHeader.length !== _secretstreamHeaderBytes) {
		throw new CesvuError(
			'STREAM_HEADER_INVALID',
			`buildHeader: streamHeader must be ${_secretstreamHeaderBytes} bytes, got ${parts.streamHeader.length}`
		);
	}
	if (parts.keyCheck.length !== KEYCHECK_LEN) {
		throw new TypeError(
			`buildHeader: keyCheck must be ${KEYCHECK_LEN} bytes, got ${parts.keyCheck.length}`
		);
	}
	// Check chunkShift FIRST (matches parseHeader's behavior).
	if (
		parts.kdf.chunkShift < CHUNK_SHIFT_MIN ||
		parts.kdf.chunkShift > CHUNK_SHIFT_MAX
	) {
		throw new CesvuError(
			'CHUNK_SIZE_OUT_OF_RANGE',
			`The chunk size encoded as chunkShift=${parts.kdf.chunkShift} is outside the cesvu v1 spec's allowed range (${CHUNK_SHIFT_MIN}..${CHUNK_SHIFT_MAX}, i.e. ${1 << CHUNK_SHIFT_MIN} bytes..${1 << CHUNK_SHIFT_MAX} bytes per chunk).${PRODUCER_NONCONFORMANT}`
		);
	}
	const preambleBytes = _encoder.encode(parts.preamble);
	if (preambleBytes.length > MAX_PREAMBLE_LEN) {
		throw new RangeError(
			`buildHeader: preamble length ${preambleBytes.length} > MAX_PREAMBLE_LEN ${MAX_PREAMBLE_LEN}`
		);
	}
	if (parts.salt.length !== _pwhashSaltBytes) {
		throw new TypeError(
			`buildHeader: salt must be ${_pwhashSaltBytes} bytes, got ${parts.salt.length}`
		);
	}
	try {
		KDFParamsSchema.parse(parts.kdf);
	} catch (e) {
		if (e instanceof z.ZodError) {
			throw new CesvuError(
				'KDF_PARAMS_OUT_OF_RANGE',
				`The KDF parameters are outside the cesvu v1 spec's allowed range.${PRODUCER_NONCONFORMANT}`
			);
		}
		throw e;
	}

	const cipherMode = parts.cipherMode ?? CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305;
	if (!IMPLEMENTED_CIPHER_MODES.has(cipherMode)) {
		throw new CesvuError(
			'UNSUPPORTED_CIPHER_MODE',
			`buildHeader: cipherMode ${cipherMode}${
				CIPHER_MODE_NAMES[cipherMode as keyof typeof CIPHER_MODE_NAMES]
					? ` (${CIPHER_MODE_NAMES[cipherMode as keyof typeof CIPHER_MODE_NAMES]})`
					: ''
			} is not implemented by this build.`
		);
	}

	const passProfile = parts.passProfile ?? PASS_PROFILE_TEXT;
	if (
		passProfile !== PASS_PROFILE_TEXT &&
		passProfile !== PASS_PROFILE_EMOJI &&
		passProfile !== PASS_PROFILE_RAW
	) {
		throw new CesvuError(
			'KDF_PARAMS_OUT_OF_RANGE',
			`buildHeader: passProfile ${passProfile} is not valid (expected 1=text, 2=emoji, or 3=raw).`
		);
	}

	const pl = preambleBytes.length;
	const out = new Uint8Array(FIXED_PREFIX + pl + POST_PREAMBLE_FIXED);
	const dv = new DataView(out.buffer);

	out.set(MAGIC, 0);
	dv.setUint16(6, VERSION, false);
	dv.setUint16(8, pl, false);
	out.set(preambleBytes, FIXED_PREFIX);

	const base = FIXED_PREFIX + pl;
	out[base] = cipherMode;
	dv.setUint32(base + 1, parts.kdf.memoryKiB, false);
	out[base + 5] = parts.kdf.timeCost;
	out[base + 6] = passProfile;
	out.set(parts.salt, base + 7);
	dv.setUint16(base + 39, parts.kdf.chunkShift, false);
	out.set(parts.streamHeader, base + 41);
	out.set(parts.keyCheck, base + 73);

	return out;
}



// ── Header parsing (SINGLE SOURCE OF TRUTH for read offsets) ───────

/** What {@link parseHeader} returns. `salt` is a subarray view; do NOT mutate. */
export interface ParsedHeader {
	version: number;
	cipherMode: number;
	mode: CipherModeName;
	salt: Uint8Array;
	kdf: {
		memoryKiB: number;
		timeCost: number;
		chunkShift: number;
	};
	/** Passphrase normalization profile (1=text, 2=emoji, 3=raw). */

	passProfile: PassProfile;
	streamHeader: Uint8Array;
	/** 32-byte keyCheck tag (see {@link computeKeyCheck}); a subarray view. */
	keyCheck: Uint8Array;
	ciphertextOffset: number;
}


/**
 * Read the ENTIRE .cesvu v1 header. MUST be kept in lockstep with
 * {@link buildHeader}.
 *
 * SCOPE: this function validates the HEADER ONLY, and therefore requires
 * only enough bytes to contain a header. It deliberately does NOT require
 * any ciphertext to be present — "is this a well-formed header?" and "is
 * this a complete file?" are separate questions, and conflating them is a
 * bug:
 *
 *   Previously `minLen` also added `_secretstreamABytes`, i.e. it demanded
 *   room for the first chunk's MAC. But `decryptCesvuStream` stops
 *   accumulating header bytes once it has `FIXED_PREFIX + MAX_PREAMBLE_LEN
 *   + POST_PREAMBLE_FIXED`. A VALID maximum-preamble header delivered as
 *   one exact standalone chunk therefore hit `TOO_SHORT` (no MAC bytes yet)
 *   at precisely the length where the accumulator refused to read more —
 *   and a perfectly good file was rejected.
 *
 * Ciphertext-length validation belongs to the callers that actually decrypt:
 * {@link decryptCesvu} enforces the `_secretstreamABytes` minimum on the
 * body, and {@link decryptCesvuStream} surfaces a missing/short body when
 * it pulls the first segment.
 */
export async function parseHeader(bytes: Uint8Array): Promise<ParsedHeader> {
	await loadSodiumConstants();
	const minLen = FIXED_PREFIX + POST_PREAMBLE_FIXED;
	if (bytes.length < minLen) {
		throw new CesvuError(
			'TOO_SHORT',
			`This file is too short to be a valid cesvu file (got ${bytes.length} bytes, need at least ${minLen}). It's either truncated or not a cesvu file at all.`
		);
	}

	if (
		bytes[0] !== MAGIC[0] ||
		bytes[1] !== MAGIC[1] ||
		bytes[2] !== MAGIC[2] ||
		bytes[3] !== MAGIC[3] ||
		bytes[4] !== MAGIC[4] ||
		bytes[5] !== MAGIC[5]
	) {
		throw new CesvuError(
			'BAD_MAGIC',
			`This file is not a cesvu file — its header doesn't start with the expected magic bytes.${PRODUCER_NONCONFORMANT}`
		);
	}

	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = dv.getUint16(6, false);
	if (version !== VERSION) {
		throw new CesvuError(
			'UNSUPPORTED_VERSION',
			`This cesvu file uses v${version}, which this app doesn't support (only v${VERSION} is supported).${PRODUCER_NONCONFORMANT}`
		);
	}
	const pl = dv.getUint16(8, false);
	if (pl > MAX_PREAMBLE_LEN) {
		throw new CesvuError(
			'BAD_PREAMBLE_LENGTH',
			`The preamble length (${pl} bytes) in this file's header exceeds the cesvu v1 spec max of ${MAX_PREAMBLE_LEN} bytes.${PRODUCER_NONCONFORMANT}`
		);
	}
	if (FIXED_PREFIX + pl + POST_PREAMBLE_FIXED > bytes.length) {
		throw new CesvuError(
			'TOO_SHORT',
			`This file's header declares more bytes than the file actually contains — it's truncated or corrupted.${PRODUCER_NONCONFORMANT}`
		);
	}
	// The preamble field is skipped as OPAQUE padding — never decoded or
	// validated. This package no longer reads/displays/customizes preamble
	// text (see DEFAULT_PREAMBLE); only its declared LENGTH matters, so the
	// offset math below can correctly locate the rest of the header.
	const basePL = FIXED_PREFIX + pl;
	const cipherMode = bytes[basePL];
	const modeName = CIPHER_MODE_NAMES[cipherMode as keyof typeof CIPHER_MODE_NAMES];
	if (modeName === undefined || !IMPLEMENTED_CIPHER_MODES.has(cipherMode)) {
		throw new CesvuError(
			'UNSUPPORTED_CIPHER_MODE',
			`This cesvu file declares cipherMode ${cipherMode}${
				modeName ? ` (${modeName})` : ''
			}, which this app doesn't support (only ${CIPHER_MODE_NAMES[CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305]} is supported).${PRODUCER_NONCONFORMANT}`
		);
	}
	const memoryKiB = dv.getUint32(basePL + 1, false);
	const timeCost = bytes[basePL + 5];
	const passProfile = bytes[basePL + 6];
	const salt = bytes.subarray(basePL + 7, basePL + 7 + _pwhashSaltBytes);
	const chunkShift = dv.getUint16(basePL + 39, false);
	const streamHeader = bytes.subarray(basePL + 41, basePL + 41 + _secretstreamHeaderBytes);
	const keyCheck = bytes.subarray(basePL + 73, basePL + 73 + KEYCHECK_LEN);
	const ciphertextOffset = basePL + POST_PREAMBLE_FIXED;


	// chunkShift range check first (security review: P0 fix).
	if (chunkShift < CHUNK_SHIFT_MIN || chunkShift > CHUNK_SHIFT_MAX) {
		throw new CesvuError(
			'CHUNK_SIZE_OUT_OF_RANGE',
			`The chunk size encoded as chunkShift=${chunkShift} is outside the cesvu v1 spec's allowed range (${CHUNK_SHIFT_MIN}..${CHUNK_SHIFT_MAX}, i.e. ${1 << CHUNK_SHIFT_MIN} bytes..${1 << CHUNK_SHIFT_MAX} bytes per chunk).${PRODUCER_NONCONFORMANT}`
		);
	}

	// SECURITY (memory-exhaustion DoS / CPU-exhaustion DoS): reject an
	// out-of-range Argon2id memory or time_cost parameter before any
	// caller can feed it to the KDF.
	try {
		KDFParamsSchema.parse({ memoryKiB, timeCost, chunkShift });
	} catch (e) {
		if (e instanceof z.ZodError) {
			throw new CesvuError(
				'KDF_PARAMS_OUT_OF_RANGE',
				`The KDF parameters in this file are outside the cesvu v1 spec's allowed range (memory must be ${KDF_MEMORY_KIB_MIN}..${KDF_MEMORY_KIB_MAX} KiB, time cost must be ${KDF_TIME_COST_MIN}..${KDF_TIME_COST_MAX}).${PRODUCER_NONCONFORMANT}`
			);
		}
		throw e;
	}


	if (
		passProfile !== PASS_PROFILE_TEXT &&
		passProfile !== PASS_PROFILE_EMOJI &&
		passProfile !== PASS_PROFILE_RAW
	) {
		throw new CesvuError(
			'KDF_PARAMS_OUT_OF_RANGE',
			`This file declares passProfile ${passProfile}, which this app doesn't recognize (expected 1=text, 2=emoji, or 3=raw).${PRODUCER_NONCONFORMANT}`
		);
	}

	return {
		version,
		cipherMode,
		mode: modeName,
		salt,
		kdf: { memoryKiB, timeCost, chunkShift },
		passProfile: passProfile as PassProfile,

		streamHeader,
		keyCheck,
		ciphertextOffset
	};
}


// ── Top-level export: build a .cesvu file ────────────────────────────

/** Options for {@link encryptCesvu} and {@link encryptCesvuStream}. */
export interface EncryptOptions {
	metadata: CesvuMetadata;
	/**
	 * Override KDF params. Default: {@link KDF_MEMORY_KIB_DEFAULT} memory,
	 * {@link KDF_TIME_COST_DEFAULT} time cost, 1 MiB chunks (chunkShift=20).
	 */
	kdf?: { memoryKiB?: number; timeCost?: number; chunkShift?: number };

	passphraseType?: PassphraseType;
}

/**
 * Encrypt a plaintext payload into a .cesvu v1 file.
 */
export async function encryptCesvu(
	plaintext: Uint8Array,
	passphrase: string,
	options: EncryptOptions
): Promise<Uint8Array> {
	const kdf = {
		memoryKiB: options.kdf?.memoryKiB ?? KDF_MEMORY_KIB_DEFAULT,
		timeCost: options.kdf?.timeCost ?? KDF_TIME_COST_DEFAULT,
		chunkShift: options.kdf?.chunkShift ?? CHUNK_SHIFT_DEFAULT
	};


	const out: Uint8Array[] = [];
	for await (const chunk of encryptCesvuStream(
		(async function* () {
			yield plaintext;
		})(),
		passphrase,
		{ ...options, kdf }
	)) {
		out.push(chunk);
	}
	const total = out.reduce((n, c) => n + c.length, 0);
	const result = new Uint8Array(total);
	let offset = 0;
	for (const c of out) {
		result.set(c, offset);
		offset += c.length;
	}
	return result;
}

/**
 * Streaming encrypt: takes an async iterable of plaintext chunks and yields
 * ciphertext chunks (`header || chunk_1 || ... || chunk_N`). Peak memory is
 * O(chunk_size) regardless of total payload size. The first emitted chunk
 * is the full .cesvu v1 header, bound into chunk 1's MAC via `ad`.
 */
export async function* encryptCesvuStream(
	plaintextChunks: AsyncIterable<Uint8Array>,
	passphrase: string,
	options: EncryptOptions
): AsyncGenerator<Uint8Array, void, undefined> {
	await loadSodiumConstants();
	const s = await sodiumReady();

	const passProfile = passphraseTypeToProfile(options.passphraseType);
	// Gate + normalize + encode once, before any key derivation.
	const pwBytes = preparePassphrase(passphrase, passProfile);


	const metadata = CesvuMetadataSchema.parse(options.metadata);
	const metaJson = _encoder.encode(JSON.stringify(metadata));
	const metaLen = metaJson.byteLength;
	const metaPrefix = new Uint8Array(2 + metaLen);
	new DataView(metaPrefix.buffer).setUint16(0, metaLen, false);
	metaPrefix.set(metaJson, 2);

	const memoryKiB = options.kdf?.memoryKiB ?? KDF_MEMORY_KIB_DEFAULT;
	const timeCost = options.kdf?.timeCost ?? KDF_TIME_COST_DEFAULT;
	const chunkShift = options.kdf?.chunkShift ?? CHUNK_SHIFT_DEFAULT;
	const chunkSize = 1 << chunkShift;

	const salt = randomBytes(_pwhashSaltBytes);

	const key = await deriveKeyFromPassphrase(pwBytes, salt, {
		memoryKiB,
		timeCost,
		chunkShift
	});


	let header: Uint8Array | null = null;
	let chunk: Uint8Array | null = null;
	try {

		const { state, header: streamHeader } = s.crypto_secretstream_xchacha20poly1305_init_push(key);

		// Fast wrong-passphrase detector: a keyed tag over a fixed context.
		const keyCheck = await computeKeyCheck(key);

		header = await buildHeader({
			preamble: DEFAULT_PREAMBLE,
			salt,
			kdf: { memoryKiB, timeCost, chunkShift },
			passProfile,
			streamHeader,
			keyCheck
		});


		yield header;

		let pendingChunk: Uint8Array | null = null;

		const plaintextIter = plaintextChunks[Symbol.asyncIterator]();
		const pull = async (): Promise<Uint8Array | null> => {
			if (pendingChunk !== null) {
					const c = pendingChunk;
					pendingChunk = null;
					if (c.length === 0) return null;
					if (c.length > chunkSize) {
							pendingChunk = c.subarray(chunkSize);
							return c.subarray(0, chunkSize);
					}
					return c;
			}
			while (true) {
				const r = await plaintextIter.next();
				if (r.done) return null;
				if (r.value.length > 0) return r.value;
			}
		};


		let metaPrefixPending = true;
		const getChunk = async (): Promise<Uint8Array | null> => {
			const buf = new Uint8Array(chunkSize);
			let off = 0;
			if (metaPrefixPending) {
				buf.set(metaPrefix, 0);
				off = metaPrefix.length;
				metaPrefixPending = false;
			}
			let src = await pull();
			while (src !== null && off < chunkSize) {
				const take = Math.min(src.length, chunkSize - off);
				buf.set(src.subarray(0, take), off);
				off += take;
				if (take < src.length) {
					pendingChunk = src.subarray(take);
				}
				if (off >= chunkSize) break;
				src = await pull();
			}
			if (off === 0) return null;
			return buf.subarray(0, off);
		};

		let firstChunkEmitted = false;
		const TAG_MESSAGE = s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
		const TAG_FINAL = s.crypto_secretstream_xchacha20poly1305_TAG_FINAL;

		chunk = await getChunk();
		let isLast = false;

		while (chunk !== null) {
			const next = await getChunk();
			isLast = next === null;
			const tag = isLast ? TAG_FINAL : TAG_MESSAGE;
			const ad = firstChunkEmitted ? null : header;
			const ct = s.crypto_secretstream_xchacha20poly1305_push(
				state,
				chunk,
				ad,
				tag
			);
			yield ct;
			firstChunkEmitted = true;
			secureZero(chunk);
			chunk = next;
			if (isLast) break;
		}
	} finally {

		secureZero(key);
		secureZero(metaPrefix);
		if (chunk) secureZero(chunk);
	}
}



// ── Top-level import: decrypt a .cesvu file ──────────────────────────

/** What {@link decryptCesvu} returns. */
export interface DecryptedCesvu {
	plaintext: Uint8Array;
	metadata: CesvuMetadata;
	mode: CipherModeName;
	/** Literal Argon2id memory_cost (KiB) this file used. */
	kdfMemoryKiB: number;
	/** Literal Argon2id time_cost this file used. */
	kdfTimeCost: number;

	/** Passphrase normalization profile this file declared (1=text, 2=emoji, 3=raw). */
	passProfile: PassProfile;
}


/**
 * Decrypt a .cesvu v1 file (one-shot; buffers the whole plaintext).
 *
 * Strict: the header's `passProfile` selects EXACTLY ONE normalizer, so
 * there is a single Argon2id derivation and no try-both fallback. The
 * legacy `preferredType` argument is ignored (kept for source-compat).
 */
export async function decryptCesvu(
	bytes: Uint8Array,
	passphrase: string,
	_preferredType?: PassphraseType
): Promise<DecryptedCesvu> {
	const { mode, salt, kdf, passProfile, streamHeader, keyCheck, ciphertextOffset } =
		await parseHeader(bytes);


	const headerBytes = bytes.subarray(0, ciphertextOffset);
	const cipherBody = bytes.subarray(ciphertextOffset);

	if (cipherBody.length < _secretstreamABytes) {
		throw new CesvuError(
			'TOO_SHORT',
			`This file's ciphertext (${cipherBody.length} bytes) is shorter than the minimum ${_secretstreamABytes}-byte secretstream MAC — it's truncated or corrupted.${PRODUCER_NONCONFORMANT}`
		);
	}

	// Strict: the header's passProfile selects exactly one normalizer.
	const pwBytes = preparePassphrase(passphrase, passProfile);


	const chunkSize = 1 << kdf.chunkShift;

	async function attemptDecrypt(
		passphraseBytes: Uint8Array
	): Promise<DecryptedCesvu> {

		const s = await sodiumReady();
		const key = await deriveKeyFromPassphrase(passphraseBytes, salt, {
				memoryKiB: kdf.memoryKiB,
				timeCost: kdf.timeCost,
				chunkShift: kdf.chunkShift
		});

		try {
			// Fast wrong-passphrase rejection: compare the header's keyCheck
			// tag against this SAME derived key (no second Argon2id run)
			// BEFORE touching any ciphertext chunk.
			const computedKeyCheck = await computeKeyCheck(key);
			if (!constantTimeEqual(computedKeyCheck, keyCheck)) {
				// Pre-authentication: a failed keyCheck is indistinguishable
				// from a tampered header, and must stay that way.
				throw new CesvuError(
					'WRONG_PASSPHRASE_OR_HEADER_TAMPER',
					`Wrong passphrase. Check the words or emoji and try again.`
				);
			}
			const state = s.crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, key);
			const TAG_FINAL = s.crypto_secretstream_xchacha20poly1305_TAG_FINAL;

			const chunkSrc = (async function* () {
				for (const seg of splitCipherChunks(
					cipherBody,
					chunkSize,
					_secretstreamABytes
				)) {
					yield seg;
				}
			})();
			const out: Uint8Array[] = [];
			for await (const pt of decryptCesvuStreamInner(
				s,
				chunkSrc,
				state,
				headerBytes,
				true,
				TAG_FINAL
			)) {
				out.push(pt);
			}
			const totalLen = out.reduce((n, c) => n + c.length, 0);
			if (totalLen < 2) {
				// Every chunk above passed its MAC, so the passphrase is
				// proven correct — the payload is simply too short to hold
				// even a metadata length prefix. Broken producer, not a
				// bad password.
				throw new CesvuError(
					'METADATA_CORRUPT_POST_AUTH',
					`This file decrypted and authenticated correctly — the passphrase is CORRECT — but its payload is only ${totalLen} byte(s), too short to contain the required metadata prefix.${PRODUCER_NONCONFORMANT}`
				);
			}
			const stitched = new Uint8Array(totalLen);
			let off = 0;
			for (const c of out) {
				stitched.set(c, off);
				off += c.length;
			}
			try {
				const unpacked = unpackMetadata(stitched);
				const plaintext = stitched.subarray(unpacked.byteLen);
				return {
					plaintext,
					metadata: unpacked.meta,
					mode,
					kdfMemoryKiB: kdf.memoryKiB,
					kdfTimeCost: kdf.timeCost,
					passProfile
				};

			} catch (err) {
				if (
					err instanceof CesvuError &&
					(err.code === 'METADATA_CORRUPT' || err.code === 'METADATA_INCOMPLETE')
				) {
					// Reached only after every chunk's MAC verified, so the
					// key is right and the metadata really is malformed.
					// Reporting "wrong passphrase" here was actively false.
					throw new CesvuError(
						'METADATA_CORRUPT_POST_AUTH',
						`This file decrypted and authenticated correctly — the passphrase is CORRECT — but its embedded metadata is malformed, so the original filename and type can't be recovered.${PRODUCER_NONCONFORMANT}`
					);
				}
				throw err;
			}

		} finally {
			secureZero(key);
		}
	}

	// Strict single derivation — the header's passProfile already told us
	// exactly which normalization to use, so there is no try-both.
	return await attemptDecrypt(pwBytes);
}

/**
 * Inner streaming decrypt primitive. Takes a libsodium secretstream
 * `state`, an async iterable of ciphertext chunks, and the full file
 * header bytes for `ad`-binding on chunk 1. Yields plaintext chunks.
 */
async function* decryptCesvuStreamInner(
	s: typeof _sodium,
	ciphertextChunks: AsyncIterable<Uint8Array>,
	state: SodiumNS.StateAddress,
	headerBytes: Uint8Array,
	firstChunk: boolean,
	TAG_FINAL: number,
	preDecryptedFirst?: { message: Uint8Array; tag: number }
): AsyncGenerator<Uint8Array, void, undefined> {

	let isFirst = firstChunk;
	let tagFinalSeen = false;

	// ── Item #9: strict secretstream tag policy ──────────────────────
	//
	// v1 uses exactly two tags: TAG_MESSAGE (0x00) for every chunk but the
	// last, TAG_FINAL (0x03) for the last. libsodium also defines TAG_PUSH
	// (0x01) and TAG_REKEY (0x02), and its `pull` accepts them happily —
	// so without this check a file carrying them would decrypt, and a
	// TAG_REKEY would silently advance the stream key, putting a reader
	// that honours it and one that doesn't into permanently different
	// states.
	//
	// NOT a breaking change: the tag byte is covered by each chunk's
	// Poly1305 MAC, and neither this writer nor the Python writer has ever
	// emitted anything but 0x00/0x03, so no conformant file can trip it.
	// Because the tag is authenticated, reaching this check at all means
	// the passphrase was already proven correct — hence CIPHERTEXT_CORRUPT
	// rather than anything passphrase-related.
	const TAG_MESSAGE = s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
	const assertTagAllowed = (tag: number): void => {
		if (tag !== TAG_MESSAGE && tag !== TAG_FINAL) {
			throw new CesvuError(
				'CIPHERTEXT_CORRUPT',
				`This file uses an unsupported secretstream chunk tag (0x${tag
					.toString(16)
					.padStart(2, '0')}). The .cesvu v1 spec permits only TAG_MESSAGE (0x00) and TAG_FINAL (0x03). The chunk authenticated, so the passphrase is CORRECT — the file is non-conformant or has been altered.${PRODUCER_NONCONFORMANT}`
			);
		}
	};

	// Has ANY segment's MAC verified yet? Once one has, the passphrase is
	// cryptographically proven correct, so every later failure is file
	// corruption — never a bad password. This flag is what lets the errors
	// below tell the truth instead of blaming the passphrase for damage.
	let authenticated = false;

	if (preDecryptedFirst) {
		isFirst = false;
		// The caller already pulled and verified segment 1.
		authenticated = true;

		// The caller verified the MAC but not the tag; check it here so the
		// streaming path enforces the same policy as the one-shot path.
		assertTagAllowed(preDecryptedFirst.tag);

		if (preDecryptedFirst.message.length > 0) {
			yield preDecryptedFirst.message;
		}
		if (preDecryptedFirst.tag === TAG_FINAL) {
			tagFinalSeen = true;
		}
	}

	if (!tagFinalSeen) {
		for await (const c of ciphertextChunks) {
			if (c.length === 0) continue;
			const ad = isFirst ? headerBytes : null;
			const result = (s.crypto_secretstream_xchacha20poly1305_pull as unknown as (
				state: SodiumNS.StateAddress,
				cipher: Uint8Array,
				ad: Uint8Array | null
			) => { message: Uint8Array; tag: number } | false | undefined)(state, c, ad);

			if (!result) {
				// Split by whether anything has authenticated yet. Before the
				// first successful pull this is genuinely ambiguous; after it,
				// blaming the passphrase would be a lie.
				throw authenticated
					? new CesvuError(
							'CIPHERTEXT_CORRUPT',
							`This file is damaged: a chunk failed its authentication check partway through. The passphrase is CORRECT (an earlier chunk already verified with it), so re-entering it will not help — the file itself has been altered or corrupted in transit/storage.`
						)
					: new CesvuError(
							'WRONG_PASSPHRASE_OR_HEADER_TAMPER',
							`Wrong passphrase. Check the words or emoji and try again. (If you're sure the passphrase is correct, the file may be corrupted or the producer is non-conformant.)`
						);
			}
			const { message, tag } = result;
			// This chunk's MAC verified, so the key — and therefore the
			// passphrase — is now proven correct.
			authenticated = true;
			isFirst = false;
			assertTagAllowed(tag);

			if (message.length > 0) {
				yield message;
			}
			if (tag === TAG_FINAL) {
				tagFinalSeen = true;
				break;
			}
		}
	}
	if (tagFinalSeen) {
		for await (const trailing of ciphertextChunks) {
			if (trailing.length > 0) {
				// Only reachable after TAG_FINAL, so authentication has
				// definitively succeeded. This is a malformed/appended file,
				// never a passphrase problem.
				throw new CesvuError(
					'TRAILING_DATA',
					`This file has ${trailing.length} unexpected bytes after its final chunk. Everything up to that point decrypted and authenticated correctly, so the passphrase is CORRECT — but data has been appended to the file.${PRODUCER_NONCONFORMANT}`
				);
			}
		}
	} else if (authenticated) {
		// At least one chunk authenticated, so the key is right and the
		// stream simply stopped early: the file is truncated. Telling the
		// user to re-enter a passphrase that already worked would be false
		// AND would cost them another full Argon2id derivation.
		throw new CesvuError(
			'TRUNCATED',
			`This file is incomplete: the encrypted stream ends without its final chunk. The passphrase is CORRECT (earlier chunks decrypted successfully) — the file itself was truncated, so re-entering the passphrase will not help. Any data recovered from it is only a PREFIX of the original and must not be treated as the whole file.`
		);
	} else {
		// Nothing ever authenticated — genuinely ambiguous.
		throw new CesvuError(
			'WRONG_PASSPHRASE_OR_HEADER_TAMPER',
			`The encrypted stream ended without a TAG_FINAL chunk — the file is truncated or corrupted.${PRODUCER_NONCONFORMANT}`
		);
	}

}


/**
 * Streaming decrypt: takes an async iterable of ciphertext chunks (the
 * first of which MUST begin with the .cesvu v1 file header) and yields
 * individual plaintext chunks (metadata prefix already stripped).
 *
 * Strict: the header's `passProfile` selects EXACTLY ONE normalizer. The
 * legacy `preferredType` argument is ignored (kept for source-compat).
 *
 * `onMetadata`, if provided, fires SYNCHRONOUSLY the instant the embedded
 * `CesvuMetadata` (carrying the ORIGINAL filename/extension) is parsed —
 * always strictly before the first plaintext chunk is yielded.
 */
export async function* decryptCesvuStream(
	ciphertextChunks: AsyncIterable<Uint8Array>,
	passphrase: string,
	_preferredType?: PassphraseType,
	onMetadata?: (metadata: CesvuMetadata) => void
): AsyncGenerator<Uint8Array, { metadata: CesvuMetadata; mode: CipherModeName }, undefined> {


	await loadSodiumConstants();
	const s = await sodiumReady();

	const headerIter = ciphertextChunks[Symbol.asyncIterator]();
	try {
	const maxHeaderLen = FIXED_PREFIX + MAX_PREAMBLE_LEN + POST_PREAMBLE_FIXED;
	let header: Uint8Array = new Uint8Array(0);
	let parsedHeader: ParsedHeader | null = null;
	for (;;) {
		try {
			parsedHeader = await parseHeader(header);
			break;
		} catch (err) {
			const isTooShort = err instanceof CesvuError && err.code === 'TOO_SHORT';
			if (!isTooShort || header.length >= maxHeaderLen) {
				throw err;
			}
		}

		const r = await headerIter.next();
		if (r.done) {
			throw new CesvuError('TOO_SHORT', 'Stream produced no chunks.');
		}
		header = header.length === 0 ? r.value : concatBytes(header, r.value);
	}

	const { mode, salt, kdf, passProfile, streamHeader, keyCheck, ciphertextOffset } = parsedHeader;


	// Strict: the header's passProfile selects exactly one normalizer.
	const pwBytes = preparePassphrase(passphrase, passProfile);


	const headerBytes = header.subarray(0, ciphertextOffset);
	const chunkSize = 1 << kdf.chunkShift;

	const segmentSize = chunkSize + _secretstreamABytes;
	const bodyChunks = (async function* () {
		let leftover: Uint8Array =
			ciphertextOffset < header.length ? header.subarray(ciphertextOffset) : new Uint8Array(0);

		while (true) {
			while (leftover.length >= segmentSize) {
				yield leftover.subarray(0, segmentSize);
				leftover = leftover.subarray(segmentSize);
			}

			const r = await headerIter.next();
			if (r.done) {
				if (leftover.length > 0) yield leftover;
				return;
			}

			leftover =
				leftover.length === 0
					? r.value
					: concatBytes(leftover, r.value);
		}
	})();
	const bodyIter = bodyChunks[Symbol.asyncIterator]();


	const firstSegResult = await bodyIter.next();
	if (firstSegResult.done) {
		// A well-formed header with no ciphertext at all. Nothing has
		// authenticated, so this is a structural problem, not a passphrase
		// one — and calling it "wrong passphrase" would send the user to
		// retry a derivation that was never even attempted.
		throw new CesvuError(
			'TOO_SHORT',
			`This file has a valid header but no ciphertext at all — it is truncated.${PRODUCER_NONCONFORMANT}`
		);
	}
	const firstSeg = firstSegResult.value;
	const TAG_FINAL = s.crypto_secretstream_xchacha20poly1305_TAG_FINAL;

	type Unlocked = { key: Uint8Array; state: SodiumNS.StateAddress; message: Uint8Array; tag: number };

	async function tryUnlockFirstSegment(passphraseBytes: Uint8Array): Promise<Unlocked | null> {
		const key = await deriveKeyFromPassphrase(passphraseBytes, salt, {
			memoryKiB: kdf.memoryKiB,
			timeCost: kdf.timeCost,
			chunkShift: kdf.chunkShift
		});

		// Key-material ownership: this function either TRANSFERS the key to
		// its caller (inside the returned Unlocked, whose `finally` zeroes
		// it) or must zero it here. Previously the zeroing lived on the two
		// early-return paths only, so ANY throw between them — a malformed
		// streamHeader making init_pull raise, a wrapper-level exception, an
		// unexpected runtime failure — escaped with the derived key still
		// live in memory. A try/finally keyed off an explicit ownership flag
		// closes every exit, including ones not yet written.
		let keyOwnershipTransferred = false;
		try {
			// Fast wrong-passphrase rejection: compare the header's keyCheck
			// tag against this SAME derived key (no second Argon2id run)
			// BEFORE pulling the first ciphertext segment.
			const computedKeyCheck = await computeKeyCheck(key);
			if (!constantTimeEqual(computedKeyCheck, keyCheck)) {
				return null;
			}
			const state = s.crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, key);
			const result = (s.crypto_secretstream_xchacha20poly1305_pull as unknown as (
				state: SodiumNS.StateAddress,
				cipher: Uint8Array,
				ad: Uint8Array | null
			) => { message: Uint8Array; tag: number } | false | undefined)(state, firstSeg, headerBytes);
			// NOTE: if init_pull succeeded but the pull failed, the
			// secretstream `state` is a WASM heap address that the JS
			// wrapper exposes no way to free. We zero the key (the only
			// thing we CAN clear) and let the state be reclaimed with the
			// WASM heap — stated plainly rather than implying full cleanup.
			if (!result) {
				return null;
			}
			keyOwnershipTransferred = true;
			return { key, state, message: result.message, tag: result.tag };
		} finally {
			if (!keyOwnershipTransferred) secureZero(key);
		}
	}



	// Strict single derivation — the header's passProfile already told us
	// exactly which normalization to use, so there is no try-both.
	const unlocked: Unlocked | null = await tryUnlockFirstSegment(pwBytes);
	if (!unlocked) {
		// Pre-authentication: a failed keyCheck and a tampered header are
		// deliberately indistinguishable here.
		throw new CesvuError(
			'WRONG_PASSPHRASE_OR_HEADER_TAMPER',
			`Wrong passphrase. Check the words or emoji and try again. (If you're sure the passphrase is correct, the file may be corrupted or the producer is non-conformant.)`
		);
	}

	const { key, state } = unlocked;
	// Declared outside the try so `finally` can close it. If the CONSUMER
	// abandons this generator early (breaks out of a for-await, calls
	// .return()), our finally runs but the INNER generator would otherwise
	// be left suspended — retaining the secretstream state, the last
	// decrypted message buffer, and references to the header/ciphertext
	// views until GC happens to collect them.
	let inner: AsyncGenerator<Uint8Array, void, undefined> | null = null;
	try {
		const bodyAsyncIterable: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => bodyIter };
		inner = decryptCesvuStreamInner(

			s,
			bodyAsyncIterable,
			state,
			headerBytes,
			false,
			TAG_FINAL,
			{ message: unlocked.message, tag: unlocked.tag }
		);

		let metaBuf: Uint8Array | null = null;
		let metadata: CesvuMetadata | null = null;

		while (true) {
			const { value: msg, done } = await inner.next();
			if (done) break;
			metaBuf = metaBuf ? concatBytes(metaBuf, msg) : msg;
			if (metadata === null) {
				try {
					const parsed = unpackMetadata(metaBuf);
					metadata = parsed.meta;
					onMetadata?.(metadata);
					const rest = metaBuf.subarray(parsed.byteLen);
					metaBuf = null;
					if (rest.length > 0) yield rest;
				} catch (err) {
					if (err instanceof CesvuError && err.code === 'METADATA_INCOMPLETE') {
						continue;
					}
					if (err instanceof CesvuError && err.code === 'METADATA_CORRUPT') {
						// The first segment's MAC already verified before we
						// got here, so the passphrase is proven correct and
						// the metadata is genuinely malformed.
						throw new CesvuError(
							'METADATA_CORRUPT_POST_AUTH',
							`This file's first chunk decrypted and authenticated correctly — the passphrase is CORRECT — but its embedded metadata is malformed.${PRODUCER_NONCONFORMANT}`
						);
					}
					throw err;
				}

			} else {
				yield metaBuf;
				metaBuf = null;
			}
		}

		if (metadata === null) {
			// The stream ended (with a valid TAG_FINAL) before enough bytes
			// arrived to complete the metadata prefix. Authenticated, so
			// again: not a passphrase problem.
			throw new CesvuError(
				'METADATA_CORRUPT_POST_AUTH',
				`This file decrypted and authenticated correctly — the passphrase is CORRECT — but it ended before its metadata was complete.${PRODUCER_NONCONFORMANT}`
			);
		}

		return { metadata, mode };
	} finally {
		// ORDER MATTERS: close the inner generator FIRST. Its own finally
		// blocks may still touch the secretstream state bound to `key`, so
		// zeroing the key before it unwinds could have it operate on
		// already-cleared material.
		try {
			await inner?.return?.(undefined as never);
		} catch {
			/* best-effort */
		}
		secureZero(key);
	}

	} finally {
		await headerIter.return?.()?.catch?.(() => {});
	}
}


// (Legacy KDF tier-mapping helpers removed: kdfParamsToOpsMem /
// opsLimitToIterations are obsolete now that both Argon2id time_cost and
// memory_cost are stored literally per-file, per KDFParamsSchema.)
