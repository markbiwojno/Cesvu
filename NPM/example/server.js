// SPDX-License-Identifier: Apache-2.0

/**
 * server.js — zero-dependency Node.js demo server for @cesvu/crypto.
 *
 * Exercises the full public API surface of the package:
 *   - encryptCesvuFile / decryptCesvuFile   (in-memory, CFP1 auto-framing)
 *   - encryptCesvuStream / decryptCesvuStream (true streaming, O(chunk) memory)
 *   - generatePassphrase / peekPassProfile / validateRawPassphrase
 *     (server-side passphrase helpers, mirroring SecureSaveModal/SecureOpenModal)
 *   - withAtomicWriter (safe streaming-decrypt commit, per the package's own
 *     documented "write to a temp sink and rename" pattern)
 *
 * Deliberately built on nothing but Node's built-in `node:http`/`node:fs`/
 * `node:crypto` — no Express, no multer, no bundler. Binary uploads are sent
 * as a raw POST body (not multipart/form-data) with metadata carried in the
 * query string, which keeps the server free of a multipart parser.
 */

import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomBytes as cryptoRandomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
	encryptCesvuFile,
	decryptCesvuFile,
	decryptCesvuFileToDirectory,
	encryptCesvuStream,
	decryptCesvuStream,
	withAtomicWriter,
	generatePassphrase,
	peekPassProfile,
	validateRawPassphrase,
	validateDicewareWords,
	validateEmojiPassphrase,
	isDicewareWord,
	isCuratedEmoji,
	CesvuError,
	RAW_PASSPHRASE_MAX_BYTES
} from '@cesvu/crypto';



const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8787;

// ── tiny helpers ─────────────────────────────────────────────────────

function tmpPath(suffix) {
	return path.join(os.tmpdir(), `cesvu-example-${cryptoRandomBytes(8).toString('hex')}${suffix}`);
}

async function readBody(req, limitBytes = 512 * 1024 * 1024) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		total += chunk.length;
		if (total > limitBytes) {
			throw Object.assign(new Error('Request body too large.'), { statusCode: 413 });
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function readJson(req) {
	const buf = await readBody(req, 1024 * 1024);
	if (buf.length === 0) return {};
	try {
		return JSON.parse(buf.toString('utf8'));
	} catch {
		throw Object.assign(new Error('Malformed JSON body.'), { statusCode: 400 });
	}
}

function sendJson(res, statusCode, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(statusCode, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body)
	});
	res.end(body);
}

/** Map a thrown error to a JSON-friendly {code, message} shape. */
function errorPayload(err) {
	if (err instanceof CesvuError) {
		return { code: err.code, message: err.message };
	}
	return { code: 'SERVER_ERROR', message: err instanceof Error ? err.message : String(err) };
}

async function unlinkQuiet(p) {
	if (!p) return;
	try {
		await fs.unlink(p);
	} catch {
		/* best-effort cleanup */
	}
}

const MIME_BY_EXT = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8'
};

async function serveStatic(req, res, urlPath) {
	const rel = urlPath === '/' ? '/index.html' : urlPath;
	// Reject path traversal / anything outside PUBLIC_DIR.
	const safeRel = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
	const filePath = path.join(PUBLIC_DIR, safeRel);
	if (!filePath.startsWith(PUBLIC_DIR)) {
		res.writeHead(403).end('Forbidden');
		return;
	}
	try {
		const data = await fs.readFile(filePath);
		const ext = path.extname(filePath);
		res.writeHead(200, { 'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream' });
		res.end(data);
	} catch {
		res.writeHead(404).end('Not found');
	}
}

// ── route handlers ───────────────────────────────────────────────────

/**
 * POST /api/peek-profile
 * Body: raw bytes — the first slice of an uploaded .cesvu file (any
 * length; client retries with a larger slice on `null`, exactly like
 * SecureOpenModal.svelte's peekPassProfile() loop).
 * Response: { passProfile: 1 | 2 | 3 | null }
 */
async function handlePeekProfile(req, res) {
	const bytes = await readBody(req, 64 * 1024);
	try {
		const passProfile = await peekPassProfile(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
		sendJson(res, 200, { passProfile });
	} catch (err) {
		sendJson(res, 400, errorPayload(err));
	}
}

/**
 * POST /api/generate-passphrase

 * Body (JSON): { type: 'diceware'|'emoji'|'raw', rawPassphrase?: string }
 * Response: { words: string[], passphrase: string }
 */
async function handleGeneratePassphrase(req, res) {
	const { type, rawPassphrase } = await readJson(req);
	try {
		const result = await generatePassphrase(type, rawPassphrase);
		sendJson(res, 200, result);
	} catch (err) {
		sendJson(res, 400, errorPayload(err));
	}
}

/**
 * GET /api/validate-raw?passphrase=...
 * Cheap shape pre-check exposed for the UI's live byte counter — mirrors
 * SecureOpenModal/SecureSaveModal's inline gating without spending an
 * Argon2id derivation.
 */
function handleValidateRaw(req, res, query) {
	const passphrase = query.get('passphrase') ?? '';
	const result = validateRawPassphrase(passphrase);
	sendJson(res, 200, { ...result, cap: RAW_PASSPHRASE_MAX_BYTES });
}

/**
 * POST /api/validate-words
 * Body (JSON): { profile: 'diceware'|'emoji', value: string }
 *
 * Server-side SHAPE + dictionary-membership validation for a manually
 * typed diceware/emoji attempt during decrypt, exercising
 * validateDicewareWords/validateEmojiPassphrase (word/emoji count) and
 * isDicewareWord/isCuratedEmoji (real wordlist membership per word/emoji)
 * — none of which the UI computed itself before this endpoint existed.
 *
 * Response (diceware): { ok, count, required, words: [{ word, valid }] }
 * Response (emoji):     { ok, count, required, emoji: [{ emoji, valid }] }
 */
async function handleValidateWords(req, res) {
	const { profile, value } = await readJson(req);
	try {
		if (profile === 'diceware') {
			const words = String(value ?? '').trim().split(/\s+/).filter(Boolean);
			const shape = validateDicewareWords(words);
			const checked = await Promise.all(
				words.map(async (word) => ({ word, valid: await isDicewareWord(word) }))
			);
			sendJson(res, 200, { ...shape, words: checked });
			return;
		}
		if (profile === 'emoji') {
			const str = String(value ?? '');
			const shape = validateEmojiPassphrase(str);
			const emojiChars = Array.from(str);
			const checked = await Promise.all(
				emojiChars.map(async (emoji) => ({ emoji, valid: await isCuratedEmoji(emoji) }))
			);
			sendJson(res, 200, { ...shape, emoji: checked });
			return;
		}
		sendJson(res, 400, { code: 'BAD_PROFILE', message: `Unknown profile ${JSON.stringify(profile)}` });
	} catch (err) {
		sendJson(res, 400, errorPayload(err));
	}
}

/**
 * POST /api/encrypt?mode=memory|stream&passphraseType=diceware|emoji|raw&passphrase=...&filename=...&rawOnly=1

 * Body: raw file bytes.
 * Response: the .cesvu file, streamed back with Content-Disposition.
 *
 * Every encrypted file carries the canonical DEFAULT_PREAMBLE (see
 * cesvu-crypto.ts) — there is no option to customize it.
 *
 * `rawOnly=1` forces raw/vault framing even for a recognized .txt/.md/.csv
 * extension — the equivalent of the CLI's `--download` flag — so a
 * recipient always gets a plain download in the web app instead of the
 * in-app document viewer. Only meaningful in `mode=memory`; streaming
 * encrypt is always raw/vault framing regardless of this flag.
 */
async function handleEncrypt(req, res, query) {
	const mode = query.get('mode') === 'stream' ? 'stream' : 'memory';
	const passphraseType = query.get('passphraseType') || 'diceware';
	const passphrase = query.get('passphrase') || '';
	const filename = query.get('filename') || 'upload.bin';
	const outName = `${filename}.cesvu`;
	const rawOnly = query.get('rawOnly') === '1';


	if (mode === 'memory') {
		// The extension on `inPath` matters: encryptCesvuFile's CFP1
		// auto-framing (detectDocumentSourceType) keys off sourcePath's
		// extension, so the temp file must carry the ORIGINAL filename's
		// extension, not a generic one.
		const inPath = tmpPath(path.extname(filename) || '.bin');
		const outPath = tmpPath('.cesvu');
		try {
			await fs.writeFile(inPath, await readBody(req));
			// encryptCesvuFile auto-detects .txt/.md/.csv and wraps them in
			// CFP1 document framing (same as the web app's Export button /
			// the Python CLI's default behavior) — that happens transparently
			// here based on `filename`'s extension, unless rawOnly opts out.
			await encryptCesvuFile(inPath, outPath, passphrase, {
				passphraseType,
				rawOnly,
				metadata: {
					filename,
					mimeType: 'application/octet-stream',
					createdAt: Date.now()
				}
			});



			res.writeHead(200, {
				'Content-Type': 'application/octet-stream',
				'Content-Disposition': `attachment; filename="${encodeURIComponent(outName)}"`
			});
			const rs = createReadStream(outPath);
			rs.pipe(res);
			rs.on('close', () => {
				unlinkQuiet(inPath);
				unlinkQuiet(outPath);
			});
		} catch (err) {
			await unlinkQuiet(inPath);
			await unlinkQuiet(outPath);
			sendJson(res, 400, errorPayload(err));
		}
		return;
	}


	// Streaming mode: pipe the request body directly through
	// encryptCesvuStream, writing ciphertext chunks to the response as
	// they're produced. True O(chunk-size) peak memory — the whole file
	// is never buffered. Streaming encrypt always produces raw/vault
	// framing (CFP1 needs the whole plaintext up front to build its JSON
	// envelope), which is called out in the UI.
	try {
		async function* bodyChunks() {
			for await (const chunk of req) {
				yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			}
		}
		res.writeHead(200, {
			'Content-Type': 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${encodeURIComponent(outName)}"`
		});
		for await (const ctChunk of encryptCesvuStream(bodyChunks(), passphrase, {
			passphraseType,
			metadata: {
				filename,
				mimeType: 'application/octet-stream',
				createdAt: Date.now()
			}
		})) {

			res.write(ctChunk);
		}
		res.end();
	} catch (err) {
		if (!res.headersSent) {
			sendJson(res, 400, errorPayload(err));
		} else {
			res.destroy();
		}
	}
}

/** Map the client's passProfile int (1/2/3, from peekPassProfile) to the
 * `preferredType` string decryptCesvu/decryptCesvuFile accept. Passing
 * this through lets decrypt skip the profile-guessing/try-both path and
 * go straight to the right normalizer — the same optimization
 * SecureOpenModal.svelte gets for free by knowing which tab the user is on. */
function preferredTypeFromProfile(raw) {
	const n = Number(raw);
	if (n === 1) return 'diceware';
	if (n === 2) return 'emoji';
	if (n === 3) return 'raw';
	return undefined;
}

/**
 * POST /api/decrypt?mode=memory|stream|directory&passphrase=...&rawOnly=1&passProfile=1|2|3
 * Body: raw .cesvu file bytes.
 * Response: the recovered file, with a base64 JSON blob of metadata/extras
 * in the X-Cesvu-Meta header.
 *
 * `rawOnly=1` skips CFP1 unwrapping and writes the decrypted plaintext
 * verbatim (memory/directory modes only — streaming decrypt never unwraps
 * CFP1 regardless of this flag).
 *
 * `passProfile`, if present (from the client's earlier peekPassProfile
 * call), is forwarded as `preferredType` so decrypt doesn't have to guess
 * the passphrase normalization.
 *
 * `mode=directory` uses decryptCesvuFileToDirectory: the output filename
 * is chosen SAFELY from the file's own untrusted metadata (see
 * output-names.ts), never overwriting an existing file. Any `warn()`
 * messages (rejected/substituted name, collision avoided) are surfaced in
 * X-Cesvu-Meta's `warnings` array. The recovered file is then streamed
 * back to the browser exactly like the other modes (the "directory" is a
 * server-side temp dir; the browser only ever sees the download).
 */
async function handleDecrypt(req, res, query) {
	const modeRaw = query.get('mode');
	const mode = modeRaw === 'stream' ? 'stream' : modeRaw === 'directory' ? 'directory' : 'memory';
	const passphrase = query.get('passphrase') || '';
	const rawOnly = query.get('rawOnly') === '1';
	const preferredType = preferredTypeFromProfile(query.get('passProfile'));

	if (mode === 'memory') {
		const inPath = tmpPath('.cesvu');
		const outPath = tmpPath('.out');
		try {
			await fs.writeFile(inPath, await readBody(req));
			// decryptCesvuFile auto-unwraps CFP1 framing (from this package,
			// the Python CLI, or the web app itself) back to plain content,
			// and reports isDocument/isTextFallback/extras for free, unless
			// rawOnly opts out.
			const result = await decryptCesvuFile(inPath, outPath, passphrase, preferredType, { rawOnly });
			const meta = {
				metadata: result.metadata,
				isDocument: result.isDocument,
				isTextFallback: result.isTextFallback,
				extrasTotal: result.extras.total,
				extrasDescription: result.extras.describe()
			};
			res.writeHead(200, {
				'Content-Type': 'application/octet-stream',
				'Content-Disposition': `attachment; filename="${encodeURIComponent(result.metadata.filename || 'decrypted.out')}"`,
				'X-Cesvu-Meta': Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')
			});
			const rs = createReadStream(outPath);
			rs.pipe(res);
			rs.on('close', () => {
				unlinkQuiet(inPath);
				unlinkQuiet(outPath);
			});
		} catch (err) {
			await unlinkQuiet(inPath);
			await unlinkQuiet(outPath);
			sendJson(res, 400, errorPayload(err));
		}
		return;
	}

	if (mode === 'directory') {
		const inPath = tmpPath('.cesvu');
		// A dedicated per-request temp directory, so chooseOutputName's
		// collision search operates on an empty directory each time rather
		// than accumulating files across requests forever.
		const outDir = path.join(os.tmpdir(), `cesvu-example-dir-${cryptoRandomBytes(8).toString('hex')}`);
		try {
			await fs.mkdir(outDir, { recursive: true });
			await fs.writeFile(inPath, await readBody(req));
			const warnings = [];
			const result = await decryptCesvuFileToDirectory(inPath, outDir, passphrase, {
				preferredType,
				rawOnly,
				warn: (message) => warnings.push(message)
			});
			const meta = {
				metadata: result.metadata,
				isDocument: result.isDocument,
				isTextFallback: result.isTextFallback,
				extrasTotal: result.extras.total,
				extrasDescription: result.extras.describe(),
				chosenFilename: path.basename(result.destPath),
				warnings
			};
			res.writeHead(200, {
				'Content-Type': 'application/octet-stream',
				'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(result.destPath))}"`,
				'X-Cesvu-Meta': Buffer.from(JSON.stringify(meta), 'utf8').toString('base64')
			});
			const rs = createReadStream(result.destPath);
			rs.pipe(res);
			rs.on('close', () => {
				unlinkQuiet(inPath);
				fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
			});
		} catch (err) {
			await unlinkQuiet(inPath);
			await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
			sendJson(res, 400, errorPayload(err));
		}
		return;
	}


	// Streaming mode: decryptCesvuStream is prefix-authenticated, not
	// whole-file atomic (see cesvu-crypto.ts's threat-model notes), so we
	// follow the package's own documented safe pattern: commit chunks to a
	// temp file via withAtomicWriter and only rename onto the final path
	// once the generator completes normally (i.e. TAG_FINAL verified).
	const finalPath = tmpPath('.out');
	try {
		async function* bodyChunks() {
			for await (const chunk of req) {
				yield new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			}
		}

		let metadata = null;
		const gen = decryptCesvuStream(bodyChunks(), passphrase, undefined, (m) => {
			metadata = m;
		});

		await withAtomicWriter(finalPath, async (write) => {
			for (;;) {
				const { value, done } = await gen.next();
				if (done) break;
				await write(value);
			}
		});

		res.writeHead(200, {
			'Content-Type': 'application/octet-stream',
			'Content-Disposition': `attachment; filename="${encodeURIComponent(metadata?.filename || 'decrypted.out')}"`,
			'X-Cesvu-Meta': Buffer.from(
				JSON.stringify({ metadata, streaming: true }),
				'utf8'
			).toString('base64')
		});

		const rs = createReadStream(finalPath);
		rs.pipe(res);
		rs.on('close', () => unlinkQuiet(finalPath));
	} catch (err) {
		await unlinkQuiet(finalPath);
		sendJson(res, 400, errorPayload(err));
	}
}

// ── router ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const { pathname, searchParams } = url;

		if (req.method === 'GET' && !pathname.startsWith('/api/')) {
			await serveStatic(req, res, pathname);
			return;
		}

		if (req.method === 'POST' && pathname === '/api/peek-profile') {
			await handlePeekProfile(req, res);
			return;
		}
		if (req.method === 'POST' && pathname === '/api/generate-passphrase') {
			await handleGeneratePassphrase(req, res);
			return;
		}
		if (req.method === 'GET' && pathname === '/api/validate-raw') {
			handleValidateRaw(req, res, searchParams);
			return;
		}
		if (req.method === 'POST' && pathname === '/api/validate-words') {
			await handleValidateWords(req, res);
			return;
		}

		if (req.method === 'POST' && pathname === '/api/encrypt') {
			await handleEncrypt(req, res, searchParams);
			return;
		}
		if (req.method === 'POST' && pathname === '/api/decrypt') {
			await handleDecrypt(req, res, searchParams);
			return;
		}

		res.writeHead(404).end('Not found');
	} catch (err) {
		if (!res.headersSent) {
			sendJson(res, err?.statusCode || 500, errorPayload(err));
		} else {
			res.destroy();
		}
	}
});

server.listen(PORT, () => {
	console.log(`@cesvu/crypto example running at http://localhost:${PORT}`);
});
