/**
 * Cross-language passphrase normalization vectors.
 *
 * Consumes `shared/passphrase-vectors.json`, the SAME file the pytest suite in
 * `CLI/cesvu/tests/test_passphrase_vectors.py` consumes. The two suites exist
 * to catch drift between the TypeScript web app and the Python CLI:
 * normalization is key-determining, so any divergence means a file encrypted
 * by one tool cannot be opened by the other, with no useful diagnostic.
 *
 * Contract: `.cesvu SPEC/README.md`, section "passProfile normalization (must
 * match exactly)".
 *
 * This lives in its OWN file rather than inside `cesvu-crypto.test.ts` so the
 * vector suite stays runnable independently of that file's unrelated
 * pre-existing type errors.
 *
 * DECODING: `inputUtf16` is a list of UTF-16 CODE UNITS, so JS can build the
 * string directly with `String.fromCharCode` — the JS string model is already
 * UTF-16, and surrogate pairs recombine implicitly. (The Python side has to
 * work considerably harder here; see the note in the pytest file.)
 */

import { describe, it, expect } from 'vitest';

import vectorData from '../../../shared/passphrase-vectors.json';
import {
	preparePassphrase,
	CesvuError,
	CANONICAL_WHITESPACE,
	RAW_PASSPHRASE_MAX_BYTES,
	rawPassphraseByteLength,
	type PassProfile
} from './cesvu-crypto';

interface Vector {
	id: string;
	group: string;
	profile: number;
	inputUtf16: string[];
	note?: string;
	expect: { normalizedUtf8Hex?: string; error?: string };
}

const DATA = vectorData as unknown as {
	rawMaxBytes: number;
	canonicalWhitespace: string[];
	vectors: Vector[];
};

const VECTORS = DATA.vectors;

/** UTF-16 code units (4-digit hex) -> string. */
function decodeUtf16(units: string[]): string {
	return units.map((u) => String.fromCharCode(parseInt(u, 16))).join('');
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

describe('passphrase vectors — harness self-check', () => {
	it('recombines surrogate pairs into one code point', () => {
		const s = decodeUtf16(['D83D', 'DE00']);
		expect(s).toBe('\u{1F600}');
		expect([...s]).toHaveLength(1);
	});

	it('preserves lone surrogates so the implementation rejects them, not the harness', () => {
		expect(decodeUtf16(['0061', 'D800', '0062'])).toHaveLength(3);
	});

	it('decodes the empty vector', () => {
		expect(decodeUtf16([])).toBe('');
	});
});

describe('passphrase vectors — constants agree with the vector file', () => {
	it('RAW_PASSPHRASE_MAX_BYTES matches rawMaxBytes', () => {
		expect(RAW_PASSPHRASE_MAX_BYTES).toBe(DATA.rawMaxBytes);
	});

	// Replaces the old "RAW_PASSPHRASE_MAX_LEN alias has not drifted" check.
	// That constant was a UTF-16 code-unit approximation of the byte cap,
	// used by the Svelte entry points to count "characters"; it was removed
	// because it was wrong in both directions (see rawPassphraseByteLength).
	// What matters now is that the UI's measure IS the crypto layer's
	// measure, so these test that rather than that two numbers are equal.
	it('rawPassphraseByteLength agrees with what preparePassphrase encodes', () => {
		for (const s of ['', 'abc', 'café', '漢字', '😀😀', ' \t ']) {
			expect(rawPassphraseByteLength(s)).toBe(new TextEncoder().encode(s).length);
		}
	});

	it('rawPassphraseByteLength is the measure that catches the cases .length misses', () => {
		// 512 CJK chars: .length says 512 (under the cap), bytes say 1536.
		// A units-based UI gate would enable submit here and the crypto
		// layer would then throw PASSPHRASE_TOO_LONG.
		const cjk = '漢'.repeat(512);
		expect(cjk.length).toBe(RAW_PASSPHRASE_MAX_BYTES);
		expect(rawPassphraseByteLength(cjk)).toBeGreaterThan(RAW_PASSPHRASE_MAX_BYTES);

		// 256 emoji: .length says 512 (at the cap, so a units-based UI gate
		// would block it) but it is only 1024 bytes... also over. The point
		// is the counter: the user typed 256 characters, not 512.
		const emoji = '😀'.repeat(256);
		expect(emoji.length).toBe(512);
		expect([...emoji].length).toBe(256);

		// And a password that is genuinely fine is not blocked: 256 emoji is
		// over, but 100 is comfortably under by the real measure.
		expect(rawPassphraseByteLength('😀'.repeat(100))).toBeLessThanOrEqual(
			RAW_PASSPHRASE_MAX_BYTES
		);
	});

	it('CANONICAL_WHITESPACE is the same 30 code points', () => {
		const expected = new Set(DATA.canonicalWhitespace.map((u) => parseInt(u, 16)));
		expect(expected.size).toBe(30);
		expect(new Set(CANONICAL_WHITESPACE)).toEqual(expected);
	});
});

const OK = VECTORS.filter((v) => v.expect.error === undefined);
const ERR = VECTORS.filter((v) => v.expect.error !== undefined);

describe('passphrase vectors — normalization', () => {
	it.each(OK.map((v) => [v.id, v] as const))('%s', (_id, vec) => {
		const text = decodeUtf16(vec.inputUtf16);
		const got = preparePassphrase(text, vec.profile as PassProfile);
		// Compare lowercase: the vector file documents uppercase hex but emits
		// lowercase for some entries, and casing is not a real mismatch.
		expect(toHex(got)).toBe(vec.expect.normalizedUtf8Hex!.toLowerCase());
	});
});

describe('passphrase vectors — coded rejections', () => {
	const coded = ERR.filter((v) => v.expect.error !== 'PASSPHRASE_EMPTY');

	it.each(coded.map((v) => [v.id, v] as const))('%s', (_id, vec) => {
		const text = decodeUtf16(vec.inputUtf16);
		let thrown: unknown;
		try {
			preparePassphrase(text, vec.profile as PassProfile);
		} catch (e) {
			thrown = e;
		}
		expect(thrown, `${vec.id} should have thrown`).toBeInstanceOf(CesvuError);
		expect((thrown as CesvuError).code).toBe(vec.expect.error);
	});
});

describe('passphrase vectors — empty after normalization', () => {
	const empties = ERR.filter((v) => v.expect.error === 'PASSPHRASE_EMPTY');

	/*
	 * OPEN DECISION: whether this should be a coded CesvuError('PASSPHRASE_EMPTY')
	 * or stay a plain Error. The vector file's `expectEncoding` note currently
	 * documents the latter, so this asserts only that it throws, and keeps
	 * passing either way.
	 *
	 * Do not tighten to a bare Error: the Python side has a confirmed crash
	 * where a whitespace-only passphrase escapes cli.py's `except CesvuError`
	 * as a raw traceback. If that is fixed by adopting the coded error, this
	 * must not start failing for it.
	 */
	it.each(empties.map((v) => [v.id, v] as const))('%s', (_id, vec) => {
		const text = decodeUtf16(vec.inputUtf16);
		expect(() => preparePassphrase(text, vec.profile as PassProfile)).toThrow();
	});
});

describe('passphrase vectors — coverage', () => {
	it('every vector is exercised', () => {
		expect(OK.length + ERR.length).toBe(VECTORS.length);
		expect(VECTORS.length).toBe(148);
	});
});
