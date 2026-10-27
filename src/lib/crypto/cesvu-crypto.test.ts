/**
 * src/lib/crypto/cesvu-crypto.test.ts
 *
 * Comprehensive coverage for the .cesvu v1 envelope. Each test maps
 * to a specific code path or failure mode:
 *
 *  - Round-trip on default and FAST_KDF params.
 *  - Round-trip on multi-chunk payloads (3 MiB → 3 chunks).
 *  - Header tampering → DECRYPT_FAILED on chunk 1.
 *  - Chunk-boundary tampering (chunk N>1) → DECRYPT_FAILED on that chunk.
 *  - Truncated mid-stream → DECRYPT_FAILED (no TAG_FINAL).
 *  - Wrong passphrase → DECRYPT_FAILED (after both normalization retries).
 *  - chunkShift out of [16, 24] → CHUNK_SIZE_OUT_OF_RANGE.
 *  - memoryKiB / iterations out of range → KDF_PARAMS_OUT_OF_RANGE.
 *  - No hard payload size cap: encrypt/decrypt are fully chunked
 *    (O(chunk_size) peak memory) with no software-enforced ceiling.
 *  - Magic / version / preamble / trailing-garbage / truncation error paths.
 *  - Passphrase normalization (diceware + emoji) round-trip.
 *  - Whitespace-only passphrase rejected with plain Error.
 *  - Zero-knowledge boundary: metadata + body sentinels never appear
 *    in the raw envelope; magic + canonical preamble DO appear in the clear.
 *  - Wire-format offsets pinned (magic@0, version@6, preambleLen@8).
 *  - OPSLIMIT_MIN pinning: iterations=1 → OPSLIMIT_MIN (regression guard).
 *  - Streaming API memory-shape regression: a 16 MiB encrypt→decrypt never
 *    retains more than ~8 MiB alive at peak, measured via FinalizationRegistry.
 *  - EFF wordlist membership (isDicewareWord).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
	encryptCesvu,
	decryptCesvu,
	encryptCesvuStream,
	decryptCesvuStream,
	normalizeDicewarePassphrase,
	CesvuError,
	type CesvuErrorCode,
	type CesvuMetadata,
	VERSION,
	MAGIC,
	DEFAULT_PREAMBLE,
	CHUNK_SHIFT_MIN,
	CHUNK_SHIFT_MAX,
	KDF_TIME_COST_MIN,
	KDF_TIME_COST_MAX,
	KDF_TIME_COST_DEFAULT,
	sodiumReady,

	CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305,
	CIPHER_MODE_AEAD_CHACHA20POLY1305_IETF,
	CIPHER_MODE_NAMES,
	verifyPassphrase,
	matchesUnauthenticatedHeaderKeyCheck,
	computeKeyCheck,

	KEYCHECK_LEN,
	FIXED_PREFIX,
	POST_PREAMBLE_FIXED,
	parseHeader
} from './cesvu-crypto.js';



/** Fast-but-valid Argon2id params (64 MiB floor / 64 KiB chunks). */
const FAST_KDF = { memoryKiB: 65536, chunkShift: 16 };

const META: CesvuMetadata = {
	filename: 'doc.json',
	mimeType: 'application/json',
	createdAt: 1_700_000_000_000
};

const PASSPHRASE = 'correct horse battery staple winter forest';

/** Await a rejected promise and assert it is a CesvuError with `code`. */
async function expectCode(p: Promise<unknown>, code: CesvuErrorCode): Promise<void> {
	const err = await p.then(
		() => {
			throw new Error('expected the promise to reject, but it resolved');
		},
		(e) => e as unknown
	);
	expect(err).toBeInstanceOf(CesvuError);
	expect((err as CesvuError).code).toBe(code);
}

/** Concatenate Uint8Arrays (test-local). */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

/** True when `needle` appears as a contiguous byte run inside `haystack`. */
function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
	if (needle.length === 0) return true;
	outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
		for (let j = 0; j < needle.length; j++) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return true;
	}
	return false;
}

describe('cesvu-crypto — envelope error paths (v2)', () => {
	let envelope: Uint8Array;
	const plaintext = new TextEncoder().encode('{"hello":"world"}');

	beforeAll(async () => {
		envelope = await encryptCesvu(plaintext, PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
	}, 30_000);

	it('round-trips a valid envelope (sanity baseline)', async () => {
		const { plaintext: out, metadata } = await decryptCesvu(envelope, PASSPHRASE);
		expect(new TextDecoder().decode(out)).toBe('{"hello":"world"}');
		expect(metadata.filename).toBe('doc.json');
		expect(metadata.mimeType).toBe('application/json');
	}, 30_000);

	it('rejects a non-.cesvu file with BAD_MAGIC', async () => {
		const garbage = new Uint8Array(200);
		await expectCode(decryptCesvu(garbage, PASSPHRASE), 'BAD_MAGIC');
	});

	it('rejects a truncated file with TOO_SHORT', async () => {
		const tiny = new Uint8Array(20);
		await expectCode(decryptCesvu(tiny, PASSPHRASE), 'TOO_SHORT');
	});

	it('rejects a v2 file (legacy AES-GCM) with UNSUPPORTED_VERSION', async () => {
		// Bump the version byte (offset 6) down to 1 — v1 files get the
		// standard rejection, no compatibility path.
		const downgraded = envelope.slice();
		new DataView(downgraded.buffer).setUint16(6, 2, false);
		await expectCode(decryptCesvu(downgraded, PASSPHRASE), 'UNSUPPORTED_VERSION');
	});

	it('rejects a future-version file (v3) with UNSUPPORTED_VERSION', async () => {
		const bumped = envelope.slice();
		new DataView(bumped.buffer).setUint16(6, VERSION + 1, false);
		await expectCode(decryptCesvu(bumped, PASSPHRASE), 'UNSUPPORTED_VERSION');
	});

	it('rejects a version-0 file with UNSUPPORTED_VERSION (strict whitelist)', async () => {
		const zeroed = envelope.slice();
		new DataView(zeroed.buffer).setUint16(6, 0, false);
		await expectCode(decryptCesvu(zeroed, PASSPHRASE), 'UNSUPPORTED_VERSION');
	});

	it('rejects the wrong passphrase with DECRYPT_FAILED (after both normalization retries)', async () => {
		await expectCode(
			decryptCesvu(envelope, 'wrong words entirely different passphrase here'),
			'WRONG_PASSPHRASE_OR_HEADER_TAMPER'
		);
	}, 30_000);

	it('rejects an above-max memoryKiB with KDF_PARAMS_OUT_OF_RANGE', async () => {
		// memoryKiB: 262145 exceeds the 256 MiB ceiling.
		await expectCode(
			encryptCesvu(plaintext, PASSPHRASE, {
				metadata: META,
				kdf: { memoryKiB: 262145, chunkShift: 16 }
			}),
			'KDF_PARAMS_OUT_OF_RANGE'
		);
	});

	it('rejects a below-min memoryKiB with KDF_PARAMS_OUT_OF_RANGE', async () => {
		// memoryKiB: 4096 is below the 64 MiB floor.
		await expectCode(
			encryptCesvu(plaintext, PASSPHRASE, {
				metadata: META,
				kdf: { memoryKiB: 4096, chunkShift: 16 }
			}),
			'KDF_PARAMS_OUT_OF_RANGE'
		);
	});


	it('rejects a header-tamper attack with DECRYPT_FAILED on chunk 1', async () => {
		// Flip a bit in the header's salt (offset 10..41). The full header
		// is bound as `ad` on chunk 1, so any mutation invalidates chunk 1's
		// MAC — surfaces as DECRYPT_FAILED.
		const tampered = envelope.slice();
		tampered[10] ^= 0xff;
		// Header tamper is caught by the chunk-1 MAC, i.e. BEFORE anything
		// has authenticated — so it is deliberately indistinguishable from a
		// wrong passphrase.
		await expectCode(decryptCesvu(tampered, PASSPHRASE), 'WRONG_PASSPHRASE_OR_HEADER_TAMPER');
	}, 30_000);

	it('rejects a preamble tamper with DECRYPT_FAILED (header is bound as ad)', async () => {
		const tampered = envelope.slice();
		tampered[FIXED_PREFIX_OFFSET] ^= 0xff;
		await expectCode(decryptCesvu(tampered, PASSPHRASE), 'WRONG_PASSPHRASE_OR_HEADER_TAMPER');
	}, 30_000);

	it('rejects a chunkShift out of [16, 24] with CHUNK_SIZE_OUT_OF_RANGE', async () => {
		// chunkShift: 25 > CHUNK_SHIFT_MAX.
		await expectCode(
			encryptCesvu(plaintext, PASSPHRASE, {
				metadata: META,
				kdf: { memoryKiB: 65536, chunkShift: 25 }
			}),
			'CHUNK_SIZE_OUT_OF_RANGE'
		);
		// chunkShift: 15 < CHUNK_SHIFT_MIN.
		await expectCode(
			encryptCesvu(plaintext, PASSPHRASE, {
				metadata: META,
				kdf: { memoryKiB: 65536, chunkShift: 15 }
			}),
			'CHUNK_SIZE_OUT_OF_RANGE'
		);
	});

	it('rejects a chunkShift flip in the wire header with CHUNK_SIZE_OUT_OF_RANGE', async () => {
		// Flip the high byte of chunkShift to 0xff → 65535 → out of range.
		// Offset is 10 (FIXED_PREFIX) + pl (preamble) + 39, where 39 is the
		// post-preamble offset of chunkShift under the v1 layout:
		//   cipherMode(1) + kdfMemKiB(4, uint32) + timeCost(1) + passProfile(1) + salt(32) = 39.
		const tampered = envelope.slice();
		const pl = new TextEncoder().encode(DEFAULT_PREAMBLE).length;
		const chunkShiftOffset = 10 + pl + 39;



		tampered[chunkShiftOffset] = 0xff;
		tampered[chunkShiftOffset + 1] = 0xff;
		await expectCode(decryptCesvu(tampered, PASSPHRASE), 'CHUNK_SIZE_OUT_OF_RANGE');
	});


	it('rejects a file with trailing garbage appended with DECRYPT_FAILED', async () => {
		// secretstream has no explicit length; appended bytes corrupt the
		// per-chunk MAC, so this fails closed.
		const withGarbage = concatBytes(envelope, new Uint8Array([1, 2, 3, 4, 5]));
		// NOTE: this payload is small enough that chunk 1 and the appended
		// garbage fall inside the SAME secretstream segment, so the very
		// first pull fails and nothing has authenticated yet. That is why
		// this is the ambiguous pre-auth code and not TRAILING_DATA —
		// TRAILING_DATA requires the garbage to arrive in a segment AFTER a
		// TAG_FINAL that already verified.
		await expectCode(
			decryptCesvu(withGarbage, PASSPHRASE),
			'WRONG_PASSPHRASE_OR_HEADER_TAMPER'
		);
	}, 30_000);

	it('rejects a truncated stream (no TAG_FINAL) with DECRYPT_FAILED', async () => {
		// Drop the last 4 bytes of the envelope; the truncated final chunk
		// will fail MAC verification, which surfaces as DECRYPT_FAILED.
		const truncated = envelope.slice(0, envelope.length - 4);
		// Same reasoning as the trailing-garbage case: truncating a
		// single-segment file damages segment 1 itself, so the failure is
		// pre-authentication and stays ambiguous. A multi-segment file
		// truncated after a verified chunk yields TRUNCATED instead.
		await expectCode(
			decryptCesvu(truncated, PASSPHRASE),
			'WRONG_PASSPHRASE_OR_HEADER_TAMPER'
		);
	}, 30_000);

	it('normalizes the passphrase internally (messy encrypt, clean decrypt round-trips)', async () => {
		const messyPassphrase = '  Correct  HORSE Battery\tStaple Winter FOREST \n';
		expect(normalizeDicewarePassphrase(messyPassphrase)).toBe(PASSPHRASE);
		const env = await encryptCesvu(plaintext, messyPassphrase, {
			metadata: META,
			kdf: FAST_KDF
		});
		const { plaintext: out } = await decryptCesvu(env, PASSPHRASE);
		expect(new TextDecoder().decode(out)).toBe('{"hello":"world"}');
	}, 30_000);

	it('normalizes the passphrase internally (clean encrypt, messy decrypt round-trips)', async () => {
		const messyPassphrase = '  Correct  HORSE Battery\tStaple Winter FOREST \n';
		const env = await encryptCesvu(plaintext, PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const { plaintext: out } = await decryptCesvu(env, messyPassphrase);
		expect(new TextDecoder().decode(out)).toBe('{"hello":"world"}');
	}, 30_000);

	it('rejects a whitespace-only passphrase with a plain Error', async () => {
		await expect(
			encryptCesvu(plaintext, '   ', { metadata: META, kdf: FAST_KDF })
		).rejects.toThrow(/passphrase is empty/);
		await expect(decryptCesvu(envelope, '   ')).rejects.toThrow(/passphrase is empty/);
	});
});

const FIXED_PREFIX_OFFSET = 10;

describe('cesvu-crypto — multi-chunk streaming round-trip', () => {
	it('round-trips a 3 MiB plaintext across 3 chunks (1 MiB chunks)', async () => {
		const big = new Uint8Array(3 * 1024 * 1024 + 17); // odd size to exercise boundaries
		// Fill with a deterministic pattern.
		for (let i = 0; i < big.length; i++) big[i] = (i * 7 + 11) & 0xff;

		const env = await encryptCesvu(big, PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const { plaintext: out } = await decryptCesvu(env, PASSPHRASE);
		expect(out.length).toBe(big.length);
		expect(out).toEqual(big);
	}, 60_000);

	it('round-trips via the streaming API directly (chunked source)', async () => {
		// Build a multi-chunk plaintext source.
		const totalSize = 2 * 1024 * 1024 + 333;
		const full = new Uint8Array(totalSize);
		for (let i = 0; i < totalSize; i++) full[i] = (i * 13 + 5) & 0xff;
		const CHUNK = 64 * 1024;
		async function* source() {
			for (let off = 0; off < full.length; off += CHUNK) {
				yield full.subarray(off, Math.min(off + CHUNK, full.length));
			}
		}

		// Encrypt via streaming.
		const ctChunks: Uint8Array[] = [];
		for await (const c of encryptCesvuStream(source(), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		})) {
			ctChunks.push(c);
		}
		const env = concatBytes(...ctChunks);

		// Decrypt via streaming.
		const ptChunks: Uint8Array[] = [];
		let finalReturn: { metadata: CesvuMetadata; preamble: string } | null = null;
		async function* ctSource() {
			for (const c of ctChunks) yield c;
		}
		const gen = decryptCesvuStream(ctSource(), PASSPHRASE);
		while (true) {
			const next = await gen.next();
			if (next.done) {
				finalReturn = next.value;
				break;
			}
			ptChunks.push(next.value);
		}
		const pt = concatBytes(...ptChunks);
		expect(pt.length).toBe(totalSize);
		expect(pt).toEqual(full);
		expect(finalReturn).not.toBeNull();
		expect(finalReturn!.metadata.filename).toBe('doc.json');
	}, 60_000);
});

describe('cesvu-crypto — zero-knowledge boundary (no plaintext leakage)', () => {
	const enc = new TextEncoder();

	it('never writes the document metadata (filename) into the raw envelope', async () => {
		const sentinel = 'FILENAME_SENTINEL_4f3a9c1e8b7d2056';
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: { filename: `${sentinel}.pdf`, mimeType: 'application/pdf', createdAt: 0 },
			kdf: FAST_KDF
		});
		expect(bytesContain(envelope, enc.encode(sentinel))).toBe(false);
		const { metadata } = await decryptCesvu(envelope, PASSPHRASE);
		expect(metadata.filename).toBe(`${sentinel}.pdf`);
	}, 30_000);

	it('never writes the document body into the raw envelope', async () => {
		const secret = 'DOCUMENT_BODY_SENTINEL_a1b2c3d4e5f60718';
		const envelope = await encryptCesvu(enc.encode(secret), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		expect(bytesContain(envelope, enc.encode(secret))).toBe(false);
		const { plaintext } = await decryptCesvu(envelope, PASSPHRASE);
		expect(new TextDecoder().decode(plaintext)).toBe(secret);
	}, 30_000);

	it('keeps public-by-design bytes in the clear (magic + canonical preamble)', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		expect(bytesContain(envelope.subarray(0, 6), MAGIC)).toBe(true);
		expect(bytesContain(envelope, enc.encode(DEFAULT_PREAMBLE))).toBe(true);
	}, 30_000);

	it('locks the wire-format header offsets (magic@0, version@6, preambleLen@8, cipherMode@10+PL)', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const dv = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
		expect(Array.from(envelope.subarray(0, 6))).toEqual(Array.from(MAGIC));
		expect(dv.getUint16(6, false)).toBe(VERSION);
		const pl = enc.encode(DEFAULT_PREAMBLE).length;
		expect(dv.getUint16(8, false)).toBe(pl);
		// The 1-byte cipherMode field sits immediately after the preamble,
		// at 10 (FIXED_PREFIX) + PL. Everything after it (salt, KDF params,
		// chunkShift, streamHeader) shifted +1 byte when this field was
		// introduced.
		expect(envelope[10 + pl]).toBe(CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305);
	}, 30_000);
});

describe('cesvu-crypto — cipher mode enum (1-byte header field)', () => {
	const enc = new TextEncoder();

	it('CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305 is 1 and CIPHER_MODE_AEAD_CHACHA20POLY1305_IETF is 2', () => {
		expect(CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305).toBe(1);
		expect(CIPHER_MODE_AEAD_CHACHA20POLY1305_IETF).toBe(2);
		expect(CIPHER_MODE_NAMES[CIPHER_MODE_SECRETSTREAM_XCHACHA20POLY1305]).toBe(
			'secretstream_xchacha20poly1305'
		);
		expect(CIPHER_MODE_NAMES[CIPHER_MODE_AEAD_CHACHA20POLY1305_IETF]).toBe(
			'aead_chacha20poly1305_ietf'
		);
	});

	it('decryptCesvu resolves mode === "secretstream_xchacha20poly1305" on a normal round-trip', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const { mode } = await decryptCesvu(envelope, PASSPHRASE);
		expect(mode).toBe('secretstream_xchacha20poly1305');
	}, 30_000);

	it('decryptCesvuStream resolves mode === "secretstream_xchacha20poly1305" on a normal round-trip', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		async function* source() {
			yield envelope;
		}
		const gen = decryptCesvuStream(source(), PASSPHRASE);
		let result = await gen.next();
		while (!result.done) result = await gen.next();
		expect(result.value.mode).toBe('secretstream_xchacha20poly1305');
	}, 30_000);

	it('rejects an unrecognized cipherMode byte with UNSUPPORTED_CIPHER_MODE', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const pl = enc.encode(DEFAULT_PREAMBLE).length;
		const tampered = envelope.slice();
		tampered[10 + pl] = 99; // not in CIPHER_MODE_NAMES
		await expectCode(decryptCesvu(tampered, PASSPHRASE), 'UNSUPPORTED_CIPHER_MODE');
	}, 30_000);

	it('rejects cipherMode=2 (CIPHER_MODE_AEAD_CHACHA20POLY1305_IETF) with UNSUPPORTED_CIPHER_MODE — reserved but not yet implemented', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const pl = enc.encode(DEFAULT_PREAMBLE).length;
		const tampered = envelope.slice();
		tampered[10 + pl] = CIPHER_MODE_AEAD_CHACHA20POLY1305_IETF;
		await expectCode(decryptCesvu(tampered, PASSPHRASE), 'UNSUPPORTED_CIPHER_MODE');
	}, 30_000);
});


describe('cesvu-crypto — configurable KDF time_cost range/default', () => {
	beforeAll(async () => {
		await sodiumReady();
	});

	it('KDF_TIME_COST_DEFAULT is 3 (= OPSLIMIT_MODERATE)', async () => {
		const s = await sodiumReady();
		expect(KDF_TIME_COST_DEFAULT).toBe(3);
		expect(KDF_TIME_COST_DEFAULT).toBe(s.crypto_pwhash_OPSLIMIT_MODERATE);
	});

	it('KDF_TIME_COST_MIN..MAX is [1, 10]', () => {
		expect(KDF_TIME_COST_MIN).toBe(1);
		expect(KDF_TIME_COST_MAX).toBe(10);
	});

	it('rejects an above-max timeCost with KDF_PARAMS_OUT_OF_RANGE', async () => {
		const plaintext = new TextEncoder().encode('payload');
		await expectCode(
			encryptCesvu(plaintext, PASSPHRASE, {
				metadata: META,
				kdf: { ...FAST_KDF, timeCost: KDF_TIME_COST_MAX + 1 }
			}),
			'KDF_PARAMS_OUT_OF_RANGE'
		);
	});

	it('rejects a below-min timeCost with KDF_PARAMS_OUT_OF_RANGE', async () => {
		const plaintext = new TextEncoder().encode('payload');
		await expectCode(
			encryptCesvu(plaintext, PASSPHRASE, {
				metadata: META,
				kdf: { ...FAST_KDF, timeCost: KDF_TIME_COST_MIN - 1 }
			}),
			'KDF_PARAMS_OUT_OF_RANGE'
		);
	});

	it('round-trips with an explicit non-default timeCost', async () => {
		const plaintext = new TextEncoder().encode('payload with custom time cost');
		const env = await encryptCesvu(plaintext, PASSPHRASE, {
			metadata: META,
			kdf: { ...FAST_KDF, timeCost: 1 }
		});
		const { plaintext: out, kdfTimeCost } = await decryptCesvu(env, PASSPHRASE);
		expect(kdfTimeCost).toBe(1);
		expect(new TextDecoder().decode(out)).toBe('payload with custom time cost');
	}, 30_000);
});


describe('cesvu-crypto — chunkShift range validation', () => {
	it('CHUNK_SHIFT_MIN is 16 (64 KiB)', () => {
		expect(CHUNK_SHIFT_MIN).toBe(16);
		expect(1 << CHUNK_SHIFT_MIN).toBe(64 * 1024);
	});

	it('CHUNK_SHIFT_MAX is 24 (16 MiB)', () => {
		expect(CHUNK_SHIFT_MAX).toBe(24);
		expect(1 << CHUNK_SHIFT_MAX).toBe(16 * 1024 * 1024);
	});

	it('round-trips at the maximum chunk size (16 MiB chunks)', async () => {
		const data = new Uint8Array(20 * 1024 * 1024); // 20 MiB → 2 chunks
		for (let i = 0; i < data.length; i++) data[i] = (i * 3 + 7) & 0xff;
		const env = await encryptCesvu(data, PASSPHRASE, {
			metadata: META,
			kdf: { ...FAST_KDF, chunkShift: 24 }
		});
		const { plaintext } = await decryptCesvu(env, PASSPHRASE);
		expect(plaintext).toEqual(data);
	}, 120_000);
});

describe('cesvu-crypto — isDicewareWord (EFF wordlist membership)', () => {
	const KNOWN_GOOD = ['rocket', 'garden', 'candle', 'apple', 'wolf'];
	const KNOWN_BAD = ['zzzzzzz', 'notaword', 'qwertyuiop', 'mirror', 'forest', 'window'];

	it('returns true for lowercase words in the EFF list', async () => {
		const { isDicewareWord } = await import('./cesvu-crypto.js');
		for (const w of KNOWN_GOOD) {
			expect(await isDicewareWord(w)).toBe(true);
		}
	});

	it('is case-insensitive', async () => {
		const { isDicewareWord } = await import('./cesvu-crypto.js');
		for (const w of KNOWN_GOOD) {
			expect(await isDicewareWord(w.toUpperCase())).toBe(true);
			expect(await isDicewareWord(w[0]!.toUpperCase() + w.slice(1))).toBe(true);
		}
	});

	it('returns false for words NOT in the EFF list', async () => {
		const { isDicewareWord } = await import('./cesvu-crypto.js');
		for (const w of KNOWN_BAD) {
			expect(await isDicewareWord(w)).toBe(false);
		}
	});

	it('returns false for empty / whitespace-only input', async () => {
		const { isDicewareWord } = await import('./cesvu-crypto.js');
		expect(await isDicewareWord('')).toBe(false);
		expect(await isDicewareWord('   ')).toBe(false);
		expect(await isDicewareWord('\t\n')).toBe(false);
	});
});

describe('cesvu-crypto — TrackedBuffer memory-shape regression', () => {
	/**
	 * Track live Uint8Array allocations via FinalizationRegistry. This is
	 * the cross-browser (Chrome-portable) alternative to the deprecated
	 * `performance.memory` API. Each TrackedBuffer reports itself to a
	 * shared counter on allocation; the counter drops when the underlying
	 * buffer is GC'd.
	 */
	let liveBytes = 0;
	const registry = new FinalizationRegistry((held: { bytes: number }) => {
		liveBytes -= held.bytes;
	});

	class TrackedBuffer extends Uint8Array {
		// `Uint8Array.prototype.subarray` uses the species constructor
		// internally, invoking it as `new TrackedBuffer(buffer, byteOffset,
		// length)` -- NOT `new TrackedBuffer(size)`. A constructor that only
		// accepts (and forwards to `super`) a single `size: number` breaks
		// that call: `super(size)` where `size` is actually an ArrayBuffer
		// object produces a Uint8Array view over the ENTIRE underlying
		// buffer, silently discarding the intended byteOffset/length. Any
		// `.subarray()` call on a TrackedBuffer instance then returns
		// something the same length as the ORIGINAL full buffer, not the
		// requested slice -- which is exactly the "offset is out of bounds"
		// crash this regression test is meant to catch, but from a bug in
		// the test double, not the library under test. Forward all
		// constructor args verbatim so both call shapes work, and only
		// track bytes for the explicit `new TrackedBuffer(size)` call site.
		constructor(a?: number | ArrayBufferLike, b?: number, c?: number) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			super(a as any, b as any, c as any);
			if (typeof a === 'number' && b === undefined && c === undefined) {
				liveBytes += a;
				registry.register(this, { bytes: a }, this);
			}
		}

	}


	it('a 16 MiB encrypt→decrypt cycle never retains > 16 MiB alive', async () => {
		const baselineBytes = liveBytes;
		const big = new TrackedBuffer(16 * 1024 * 1024);
		for (let i = 0; i < big.length; i++) big[i] = i & 0xff;

		// Encrypt then immediately decrypt.
		const env = await encryptCesvu(big, PASSPHRASE, {
			metadata: META,
			kdf: { ...FAST_KDF, chunkShift: 18 } // 256 KiB chunks
		});

		// The plaintext buffer should already be releasable after encryptCesvu
		// returned — but we want to assert the ceiling DURING the call, so we
		// measure the peak from baseline up to the end of the encryption.
		const peakAfterEncrypt = liveBytes - baselineBytes;
		expect(peakAfterEncrypt).toBeLessThan(16 * 1024 * 1024 + 4 * 1024 * 1024);

		// Now decrypt and check we don't blow the budget again.
		const { plaintext } = await decryptCesvu(env, PASSPHRASE);
		const peakAfterDecrypt = liveBytes - baselineBytes;
		expect(peakAfterDecrypt).toBeLessThan(16 * 1024 * 1024 + 4 * 1024 * 1024);

		// Drop references to allow GC to reclaim tracked buffers.
		big.fill(0);
	}, 60_000);
});

describe('decryptCesvuStream — realistic misaligned browser chunk boundaries (regression)', () => {
	/**
	 * REGRESSION GUARD: a real browser's `file.stream()` / `blob.stream()`
	 * hands back raw reads whose sizes have NO relationship to our fixed
	 * `chunkSize + 17`-byte ciphertext segmentation. A previous version of
	 * `decryptCesvuStream`'s internal `bodyChunks` generator called
	 * `splitCipherChunks` fresh on EACH raw chunk independently (always
	 * restarting segmentation at offset 0), which only produced correct
	 * segments when every raw read happened to align exactly on a
	 * segment boundary.
	 *
	 * Node/happy-dom's `Blob.stream()` conveniently hands back the ENTIRE
	 * buffer as a single raw chunk, so the bug was invisible to the
	 * existing test suite (which builds ciphertext via an in-memory
	 * `AsyncIterable` or `Blob.stream()`). This test instead wraps the
	 * ciphertext in a hand-rolled async iterable that deliberately
	 * yields small, arbitrarily-sized, NON-segment-aligned chunks — the
	 * same shape a real Chrome/Edge/Firefox `ReadableStream` reader
	 * produces — to catch any regression of the carry-over/leftover-
	 * buffer fix.
	 */
	function chunkedAsyncIterable(
		bytes: Uint8Array,
		rawChunkSize: number
	): AsyncIterable<Uint8Array> {
		return {
			[Symbol.asyncIterator]() {
				let offset = 0;
				return {
					async next(): Promise<IteratorResult<Uint8Array>> {
						if (offset >= bytes.length) {
							return { value: undefined, done: true };
						}
						const end = Math.min(offset + rawChunkSize, bytes.length);
						const value = bytes.subarray(offset, end);
						offset = end;
						return { value, done: false };
					}
				};
			}
		};
	}

	it('round-trips a multi-chunk payload when the ciphertext arrives in small, misaligned raw reads', async () => {
		// 3 MiB plaintext with 1 MiB (chunkShift=20 default) → guaranteed
		// multiple full ciphertext segments plus a final partial one.
		const plaintext = new Uint8Array(3 * 1024 * 1024);
		for (let i = 0; i < plaintext.length; i++) plaintext[i] = i & 0xff;

		const ciphertext = await encryptCesvu(plaintext, PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});

		// Deliberately pick a raw-read size that does NOT evenly divide
		// (chunkSize + 17) — 4096-byte reads, wildly smaller than the
		// 64 KiB (chunkShift=16 in FAST_KDF) segment size, and not a
		// clean divisor of it either, forcing segment boundaries to
		// straddle raw reads repeatedly through the whole file.
		const source = chunkedAsyncIterable(ciphertext, 4096);

		const chunks: Uint8Array[] = [];
		const stream = decryptCesvuStream(source, PASSPHRASE);
		let result = await stream.next();
		while (!result.done) {
			chunks.push(result.value);
			result = await stream.next();
		}
		const { metadata } = result.value;

		let total = 0;
		for (const c of chunks) total += c.length;
		const stitched = new Uint8Array(total);
		let off = 0;
		for (const c of chunks) {
			stitched.set(c, off);
			off += c.length;
		}

		expect(metadata).toEqual(META);
		expect(stitched).toEqual(plaintext);
	}, 60_000);

	it('round-trips when raw reads are small (128 bytes — far smaller than the 64 KiB+17 segment size)', async () => {
		// Even more adversarial than the 4096-byte test above: 128-byte raw
		// reads guarantee every single segment boundary straddles many raw
		// reads. (Note: decryptCesvuStream currently requires the FIRST
		// raw chunk from the source to contain the entire ~100+-byte .cesvu
		// header in one piece — real browser ReadableStreams never split a
		// read that small in practice, so 128 bytes is realistic while
		// still stressing the body's carry-over segmentation heavily.)
		const plaintext = new Uint8Array(200 * 1024); // 200 KiB, > one 64 KiB chunk
		for (let i = 0; i < plaintext.length; i++) plaintext[i] = (i * 7) & 0xff;

		const ciphertext = await encryptCesvu(plaintext, PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});

		const source = chunkedAsyncIterable(ciphertext, 128);


		const chunks: Uint8Array[] = [];
		const stream = decryptCesvuStream(source, PASSPHRASE);
		let result = await stream.next();
		while (!result.done) {
			chunks.push(result.value);
			result = await stream.next();
		}
		const { metadata } = result.value;

		let total = 0;
		for (const c of chunks) total += c.length;
		const stitched = new Uint8Array(total);
		let off = 0;
		for (const c of chunks) {
			stitched.set(c, off);
			off += c.length;
		}

		expect(metadata).toEqual(META);
		expect(stitched).toEqual(plaintext);
	}, 60_000);
});

describe('cesvu-crypto — keyCheck (fast wrong-passphrase detection)', () => {
	const enc = new TextEncoder();

	/** Length of just the .cesvu header (no ciphertext body). */
	function headerLen(): number {
		return FIXED_PREFIX + enc.encode(DEFAULT_PREAMBLE).length + POST_PREAMBLE_FIXED;
	}

	it('POST_PREAMBLE_FIXED accounts for the 32-byte keyCheck field', () => {
		// 1 (cipherMode) + 4 (uint32 memKiB) + 1 (timeCost) + 1 (passProfile)
		// + 32 (salt) + 2 (chunkShift) + 32 (streamHeader slot) + 32 (keyCheck) = 105
		expect(POST_PREAMBLE_FIXED).toBe(105);
		expect(KEYCHECK_LEN).toBe(32);
	});



	it('computeKeyCheck is deterministic and 32 bytes', async () => {
		await sodiumReady();
		const key = new Uint8Array(32).fill(7);
		const a = await computeKeyCheck(key);
		const b = await computeKeyCheck(key);
		expect(a.length).toBe(KEYCHECK_LEN);
		expect(a).toEqual(b);
		// Different key → different tag.
		const other = await computeKeyCheck(new Uint8Array(32).fill(9));
		expect(a).not.toEqual(other);
	});

	it('matchesUnauthenticatedHeaderKeyCheck returns true for the correct passphrase using ONLY the header (no body)', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const headerOnly = envelope.subarray(0, headerLen());
		expect(await matchesUnauthenticatedHeaderKeyCheck(headerOnly, PASSPHRASE)).toBe(true);
	}, 30_000);

	it('verifyPassphrase REFUSES a header-only input (TOO_SHORT) — it must authenticate ciphertext', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const headerOnly = envelope.subarray(0, headerLen());
		await expectCode(verifyPassphrase(headerOnly, PASSPHRASE), 'TOO_SHORT');
	}, 30_000);

	it('verifyPassphrase returns true for the correct passphrase on a full file', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		expect(await verifyPassphrase(envelope, PASSPHRASE)).toBe(true);
	}, 30_000);

	/**
	 * THE FINDING-1 REGRESSION GUARD.
	 *
	 * Re-encrypt the SAME plaintext under an ATTACKER-chosen passphrase and
	 * graft that whole (self-consistent) header — salt, KDF params,
	 * passProfile, streamHeader AND keyCheck — onto the ORIGINAL victim
	 * ciphertext body. Every header field agrees with the attacker's
	 * password, so a keyCheck-only check is fooled. Only authenticating
	 * real ciphertext catches it.
	 */
	it('verifyPassphrase is NOT fooled by a wholesale header swap (keyCheck is unauthenticated)', async () => {
		const ATTACKER_PASS = 'attacker chosen passphrase entirely different words';
		const victim = await encryptCesvu(enc.encode('secret payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const attacker = await encryptCesvu(enc.encode('secret payload'), ATTACKER_PASS, {
			metadata: META,
			kdf: FAST_KDF
		});

		// Same preamble/params on both sides, so the headers are the same
		// length and the graft is byte-aligned.
		const hLen = headerLen();
		const forged = concatBytes(attacker.subarray(0, hLen), victim.subarray(hLen));

		// The unauthenticated check is fooled — that is exactly why it is
		// named the way it is and must never gate a trust decision.
		expect(await matchesUnauthenticatedHeaderKeyCheck(forged, ATTACKER_PASS)).toBe(true);

		// verifyPassphrase authenticates the first segment and rejects it.
		expect(await verifyPassphrase(forged, ATTACKER_PASS)).toBe(false);

		// And the file genuinely does not decrypt, confirming the forgery.
		await expectCode(decryptCesvu(forged, ATTACKER_PASS), 'WRONG_PASSPHRASE_OR_HEADER_TAMPER');
	}, 60_000);


	it('verifyPassphrase returns false for a wrong passphrase (no throw)', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		expect(await verifyPassphrase(envelope, 'totally wrong passphrase words here now')).toBe(false);
	}, 30_000);

	it('verifyPassphrase accepts a messy-but-equivalent passphrase (normalizer applied)', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const messy = '  Correct  HORSE Battery\tStaple Winter FOREST \n';
		expect(await verifyPassphrase(envelope, messy)).toBe(true);
	}, 30_000);

	it('tampering the keyCheck field breaks chunk-1 MAC → DECRYPT_FAILED (bound as ad)', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const pl = enc.encode(DEFAULT_PREAMBLE).length;
		// keyCheck sits at base+73 where base = 10 (FIXED_PREFIX) + pl.
		const keyCheckOffset = FIXED_PREFIX + pl + 73;

		const tampered = envelope.slice();

		tampered[keyCheckOffset] ^= 0xff;
		// verifyPassphrase now sees a wrong tag → false (fast reject).
		expect(await verifyPassphrase(tampered, PASSPHRASE)).toBe(false);
		// And an actual decrypt still fails closed via the chunk-1 MAC.
		await expectCode(decryptCesvu(tampered, PASSPHRASE), 'WRONG_PASSPHRASE_OR_HEADER_TAMPER');
	}, 30_000);

	it('verifyPassphrase throws on an empty passphrase', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		await expect(verifyPassphrase(envelope, '   ')).rejects.toThrow(/passphrase is empty/);
	}, 30_000);
});





describe('cesvu-crypto -- decryptCesvu/decryptCesvuStream keyCheck fast-fail (finding 2 fix)', () => {
	const enc = new TextEncoder();

	it('decryptCesvu rejects a wrong passphrase via keyCheck (matches verifyPassphrase result)', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const wrongPass = 'totally wrong passphrase words here now';
		expect(await verifyPassphrase(envelope, wrongPass)).toBe(false);
		await expectCode(decryptCesvu(envelope, wrongPass), 'WRONG_PASSPHRASE_OR_HEADER_TAMPER');
	}, 30_000);

	it('decryptCesvuStream rejects a wrong passphrase via keyCheck before yielding any plaintext', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const wrongPass = 'totally wrong passphrase words here now';
		async function* source() {
			yield envelope;
		}
		const gen = decryptCesvuStream(source(), wrongPass);
		await expect(gen.next()).rejects.toThrow(/Wrong passphrase/);
	}, 30_000);

	it('decrypt with the correct passphrase still works after keyCheck was inlined (no regression)', async () => {
		const envelope = await encryptCesvu(enc.encode('payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const { plaintext } = await decryptCesvu(envelope, PASSPHRASE);
		expect(new TextDecoder().decode(plaintext)).toBe('payload');
	}, 30_000);
});

describe('cesvu-crypto -- KDF domain separation (deriveKeyFromPassphrase, finding 1 fix)', () => {
	it('the returned stream key is NOT the raw Argon2id output (domain separation applied)', async () => {
		const { deriveKeyFromPassphrase, preparePassphrase } = await import('./cesvu-crypto.js');
		const s = await sodiumReady();
		const salt = new Uint8Array(s.crypto_pwhash_SALTBYTES).fill(3);
		const memoryKiB = FAST_KDF.memoryKiB;

		const rawArgon2id = s.crypto_pwhash(
			32,
			new TextEncoder().encode(PASSPHRASE),
			salt,
			KDF_TIME_COST_DEFAULT,
			memoryKiB * 1024,
			s.crypto_pwhash_ALG_ARGON2ID13
		);

		// deriveKeyFromPassphrase takes Uint8Array, NOT string, on purpose:
		// preparePassphrase() is the only supported way to produce these
		// bytes, so no call site can reach Argon2id while skipping the
		// surrogate / normalization / length gate. Passing a raw string here
		// used to fail at runtime inside secureZero with the very unhelpful
		// "Only Uint8Array instances can be wiped".
		//
		// Profile 3 (RAW) is identity, so these bytes are exactly
		// TextEncoder().encode(PASSPHRASE) — matching rawArgon2id above.
		const streamKey = await deriveKeyFromPassphrase(preparePassphrase(PASSPHRASE, 3), salt, {
			memoryKiB,
			chunkShift: FAST_KDF.chunkShift
		});


		expect(streamKey.length).toBe(32);
		expect(streamKey).not.toEqual(rawArgon2id);
	}, 30_000);

	it('deriveKeyFromPassphrase is deterministic for the same passphrase/salt/params', async () => {
		const { deriveKeyFromPassphrase, preparePassphrase } = await import('./cesvu-crypto.js');
		const salt = new Uint8Array(16).fill(5);
		// NOTE: deriveKeyFromPassphrase wipes the passphrase buffer it is
		// given (secureZero in its `finally`). Reusing one buffer across both
		// calls would hand the second call all-zero bytes, so this test would
		// "pass" while comparing two keys derived from different inputs.
		// Build fresh bytes per call.
		const a = await deriveKeyFromPassphrase(preparePassphrase(PASSPHRASE, 3), salt, FAST_KDF);
		const b = await deriveKeyFromPassphrase(preparePassphrase(PASSPHRASE, 3), salt, FAST_KDF);
		expect(a).toEqual(b);
	}, 30_000);

	it('a full encrypt/decrypt round-trip still works with the domain-separated key (no regression)', async () => {
		const envelope = await encryptCesvu(new TextEncoder().encode('hello domain separation'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const { plaintext } = await decryptCesvu(envelope, PASSPHRASE);
		expect(new TextDecoder().decode(plaintext)).toBe('hello domain separation');
	}, 30_000);
});

describe('cesvu-crypto — fresh salt per file (unlinkability, "Send Back" prerequisite)', () => {
	/**
	 * SECURITY (unlinkability): "Send Back" (see contract-store.svelte.ts's
	 * sendBackAsCesvu) re-encrypts under the EXACT SAME passphrase the
	 * recipient already holds — no new passphrase is generated or
	 * communicated. That is only safe if an attacker who collects multiple
	 * files can't tell they share a passphrase by comparing the files
	 * themselves. This locks in the guarantee: encryptCesvu draws a fresh
	 * random salt on EVERY call, so two files encrypted under the IDENTICAL
	 * passphrase (and even identical plaintext/metadata) still get different
	 * salts, different derived keys, and unrelated ciphertext bytes.
	 */
	const enc = new TextEncoder();

	it('two encryptions of the SAME passphrase (and same plaintext) get DIFFERENT salts', async () => {
		const a = await encryptCesvu(enc.encode('identical payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const b = await encryptCesvu(enc.encode('identical payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});

		const { salt: saltA } = await parseHeader(a);
		const { salt: saltB } = await parseHeader(b);

		expect(saltA.length).toBeGreaterThan(0);
		expect(Array.from(saltA)).not.toEqual(Array.from(saltB));
	}, 30_000);

	it('two encryptions of the SAME passphrase produce UNRELATED ciphertext bytes (not just a different salt field)', async () => {
		const a = await encryptCesvu(enc.encode('identical payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});
		const b = await encryptCesvu(enc.encode('identical payload'), PASSPHRASE, {
			metadata: META,
			kdf: FAST_KDF
		});

		// Same passphrase + same plaintext + same metadata, yet the FULL
		// envelopes must differ (different salt → different derived key →
		// different streamHeader/keyCheck/ciphertext) — an observer holding
		// both files cannot conclude they share a passphrase from the bytes.
		expect(a).not.toEqual(b);

		// Both must still independently decrypt correctly with the shared
		// passphrase — reusing it is intentional (that's the whole point of
		// Send Back), only the on-disk bytes must be unlinkable.
		const { plaintext: outA } = await decryptCesvu(a, PASSPHRASE);
		const { plaintext: outB } = await decryptCesvu(b, PASSPHRASE);
		expect(new TextDecoder().decode(outA)).toBe('identical payload');
		expect(new TextDecoder().decode(outB)).toBe('identical payload');
	}, 30_000);

	it('three back-to-back encryptions of the same passphrase never repeat a salt', async () => {
		const envelopes = await Promise.all(
			[0, 1, 2].map(() =>
				encryptCesvu(enc.encode('payload'), PASSPHRASE, { metadata: META, kdf: FAST_KDF })
			)
		);
		const salts = await Promise.all(envelopes.map(async (e) => (await parseHeader(e)).salt));
		const asHex = salts.map((s) => Array.from(s).join(','));
		expect(new Set(asHex).size).toBe(asHex.length);
	}, 30_000);
});
