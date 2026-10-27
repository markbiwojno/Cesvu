// SPDX-License-Identifier: Apache-2.0

/**
 * passphrase-helpers.ts — server-side conveniences for building an
 * encrypt/decrypt API around cesvu-crypto's passphrase profiles
 * (diceware / emoji / raw), mirroring the UX contract of the web app's
 * SecureSaveModal (encrypt) and SecureOpenModal (decrypt) — WITHOUT any
 * terminal/readline/DOM assumptions, so a server can wire these into its
 * own HTTP handlers.
 *
 * SCOPE: these helpers only cover passphrase generation, validation, and
 * profile discovery (the "front door" of encrypt/decrypt). They deliberately
 * do NOT cover:
 *   - Streaming large files without buffering the whole file in memory
 *     (use `encryptCesvuStream`/`decryptCesvuStream` directly for that).
 *   - User-facing error-message mapping for `CesvuError` codes.
 *   - Progress reporting during long encrypt/decrypt operations.
 *   - Rate limiting / failed-attempt cooldowns (this belongs in the
 *     consuming app's own session/auth layer, e.g. Redis-backed
 *     per-IP/per-session counters — NOT something a stateless crypto
 *     library should own).
 * See NPM/README.md for a fuller discussion of these gaps.
 *
 * All normalization is delegated to the existing shared
 * `preparePassphrase`/`normalizeForProfile` functions in cesvu-crypto.ts —
 * nothing here reimplements normalization, so there's no risk of drift
 * between what these helpers accept and what encrypt/decrypt actually do.
 */

import {
	generateDicewarePassphrase,
	generateEmojiPassphrase,
	preparePassphrase,
	parseHeader,
	CesvuError,
	RAW_PASSPHRASE_MAX_BYTES,
	rawPassphraseByteLength,
	PASS_PROFILE_TEXT,
	PASS_PROFILE_EMOJI,
	PASS_PROFILE_RAW,
	type PassProfile,
	type PassphraseType
} from './cesvu-crypto.js';

// ── generatePassphrase (encrypt-side) ──────────────────────────────

export interface GeneratedPassphrase {
	/** The individual words/emoji (empty for 'raw'). */
	words: string[];
	/** The full passphrase string, ready to pass to `encryptCesvu`. */
	passphrase: string;
}

/**
 * Produce (diceware/emoji) or validate-and-pass-through (raw) a
 * passphrase for a NEW .cesvu file, before encrypting with it.
 *
 * - 'diceware' / 'emoji': generates a fresh random passphrase. `rawPassphrase`
 *   is ignored for these types.
 * - 'raw': `rawPassphrase` is REQUIRED — validated via the same
 *   `preparePassphrase` gate used by encrypt/decrypt (surrogate rejection,
 *   byte-length cap), then passed through unchanged.
 *
 * Throws a `TypeError` if `type === 'raw'` and `rawPassphrase` is omitted.
 * Throws `CesvuError` (e.g. `PASSPHRASE_TOO_LONG`, `PASSPHRASE_INVALID_ENCODING`)
 * if a supplied raw passphrase fails validation.
 */

export async function generatePassphrase(
	type: PassphraseType,
	rawPassphrase?: string
): Promise<GeneratedPassphrase> {
	if (type === 'diceware') {
		const words = await generateDicewarePassphrase();
		return { words, passphrase: words.join(' ') };
	}
	if (type === 'emoji') {
		const words = await generateEmojiPassphrase();
		return { words, passphrase: words.join('') };
	}
	if (type === 'raw') {
		if (rawPassphrase === undefined) {
			// Missing argument is an API-misuse error, not a passphrase-content
			// problem, so it does not belong in CesvuErrorCode (which is
			// reserved for facts about passphrase bytes or file contents).
			throw new TypeError(
				"generatePassphrase: 'raw' requires a rawPassphrase argument."
			);
		}

		// Validates (surrogates, byte cap, empty-after-normalize) without
		// discarding the derived bytes — we only need the validation.
		preparePassphrase(rawPassphrase, PASS_PROFILE_RAW);
		return { words: [rawPassphrase], passphrase: rawPassphrase };
	}
	throw new CesvuError(
		'KDF_PARAMS_OUT_OF_RANGE',
		`generatePassphrase: unknown passphrase type ${String(type)}`
	);
}

// ── peekPassProfile (decrypt-side) ─────────────────────────────────

/**
 * Given the leading bytes of an existing .cesvu file (not necessarily the
 * whole file — enough to cover the header, which is at most
 * `FIXED_PREFIX + MAX_PREAMBLE_LEN + POST_PREAMBLE_FIXED` bytes), return
 * which passphrase profile it expects (1=diceware/text, 2=emoji, 3=raw).
 *
 * Returns `null` if `bytes` is too short to contain a full header yet
 * (mirrors `SecureOpenModal`'s peek loop, which retries with a larger
 * slice on a `TOO_SHORT` error) — callers streaming an upload should
 * accumulate more bytes and retry rather than treating `null` as failure.
 *
 * Throws for any other header-parsing error (bad magic, corrupt KDF
 * params, etc.) — those indicate the file isn't a valid .cesvu file at
 * all, not merely "not enough bytes yet".
 */
export async function peekPassProfile(bytes: Uint8Array): Promise<PassProfile | null> {
	try {
		const header = await parseHeader(bytes);
		return header.passProfile;
	} catch (err) {
		if (err instanceof CesvuError && err.code === 'TOO_SHORT') {
			return null;
		}
		throw err;
	}
}

// ── Validators (both encrypt- and decrypt-side) ────────────────────

export interface ValidationResult {
	ok: boolean;
	error?: string;
}

export interface RawPassphraseValidation extends ValidationResult {
	byteLength: number;
	maxBytes: number;
}

/**
 * Validate a raw (custom) passphrase's shape before spending an Argon2id
 * derivation on it — used both before encrypting with a user-supplied raw
 * passphrase, and before attempting to decrypt a profile-3 file.
 *
 * This is a pre-check only: it does NOT replace `preparePassphrase`'s
 * surrogate-rejection, which still runs (and is authoritative) inside
 * encrypt/decrypt. This just lets a server return a fast 400 instead of
 * paying the KDF cost for obviously-empty/oversized input.
 */
export function validateRawPassphrase(passphrase: string): RawPassphraseValidation {
	const byteLength = rawPassphraseByteLength(passphrase);
	if (passphrase.length === 0) {
		return {
			ok: false,
			byteLength,
			maxBytes: RAW_PASSPHRASE_MAX_BYTES,
			error: 'Passphrase must not be empty.'
		};
	}
	if (byteLength > RAW_PASSPHRASE_MAX_BYTES) {
		return {
			ok: false,
			byteLength,
			maxBytes: RAW_PASSPHRASE_MAX_BYTES,
			error: `Passphrase is ${byteLength} bytes, which exceeds the ${RAW_PASSPHRASE_MAX_BYTES}-byte maximum.`
		};
	}
	return { ok: true, byteLength, maxBytes: RAW_PASSPHRASE_MAX_BYTES };
}

export interface DicewareValidation extends ValidationResult {
	count: number;
	required: number;
}

/** Diceware passphrases must have exactly 6 words (see SecureOpenModal). */
const DICEWARE_REQUIRED_WORDS = 6;

/**
 * Validate the SHAPE of a diceware attempt (word count) before attempting
 * decrypt against a profile-1 file. Does not check dictionary membership —
 * that's the KDF/keyCheck's job, same as the web app.
 */
export function validateDicewareWords(words: string[]): DicewareValidation {
	const count = words.filter((w) => w.trim().length > 0).length;
	if (count !== DICEWARE_REQUIRED_WORDS) {
		return {
			ok: false,
			count,
			required: DICEWARE_REQUIRED_WORDS,
			error: `Expected exactly ${DICEWARE_REQUIRED_WORDS} words, got ${count}.`
		};
	}
	return { ok: true, count, required: DICEWARE_REQUIRED_WORDS };
}

export interface EmojiValidation extends ValidationResult {
	count: number;
	required: number;
}

/** Emoji passphrases must have at least 8 emoji (see SecureOpenModal). */
const EMOJI_REQUIRED_COUNT = 8;

/**
 * Validate the SHAPE of an emoji attempt (minimum emoji count, counted by
 * Unicode code point, not UTF-16 code unit) before attempting decrypt
 * against a profile-2 file.
 */
export function validateEmojiPassphrase(passphrase: string): EmojiValidation {
	const count = Array.from(passphrase).length;
	if (count < EMOJI_REQUIRED_COUNT) {
		return {
			ok: false,
			count,
			required: EMOJI_REQUIRED_COUNT,
			error: `Expected at least ${EMOJI_REQUIRED_COUNT} emoji, got ${count}.`
		};
	}
	return { ok: true, count, required: EMOJI_REQUIRED_COUNT };
}

/** Map a `PassProfile` byte to which validator applies (for dispatch). */
export function profileRequiresValidator(
	profile: PassProfile
): 'diceware' | 'emoji' | 'raw' {
	if (profile === PASS_PROFILE_TEXT) return 'diceware';
	if (profile === PASS_PROFILE_EMOJI) return 'emoji';
	if (profile === PASS_PROFILE_RAW) return 'raw';
	throw new CesvuError(
		'KDF_PARAMS_OUT_OF_RANGE',
		`profileRequiresValidator: unknown passProfile ${String(profile)}`
	);
}
