#!/usr/bin/env node
/**
 * scripts/sync-cdn.mjs — Download + hash ONNX model weights, populate manifests
 *
 * For each manifest in scripts/r2-uploads/manifests/:
 *   1. For each file in the manifest, download from the source URL.
 *   2. Compute sha256 + size using @noble/hashes (same primitive freeze.mjs uses).
 *   3. Update the manifest in-place with real values.
 *
 * LFS HANDLING:
 *   HuggingFace Hub serves Git LFS pointer files (small text, ~300 bytes) for
 *   large binaries. We detect them by reading the response body if the
 *   Content-Length is small, check for the LFS magic header, parse the oid,
 *   and refetch with `?download=true` which forces a 302 to the Xet CDN
 *   that serves the actual binary.
 *
 * UPLOAD (--upload):
 *   Requires wrangler authenticated against the team Cloudflare account and
 *   CESVU_R2_BUCKET set in the environment. The script FAILS LOUDLY if
 *   either is missing — no silent fallback, no swallowed errors.
 *
 * Idempotent: re-running with no source changes is a fast no-op for files
 * where sha256 + size already match the downloaded bytes.
 *
 * Modes:
 *   (default)  Download + hash + write manifests. No R2 upload.
 *   --upload   Also push each file to R2 via `wrangler r2 object put`.
 *   --dry-run  Print the planned operations, don't download or upload.
 *
 * Usage:
 *   pnpm sync:cdn             # download + hash
 *   pnpm sync:cdn:upload      # download + hash + upload to R2
 *   pnpm sync:cdn:dry         # preview without downloading
 *
 * See scripts/r2-uploads/README.md for the upload workflow.
 *
 * NOTE: This script only handles ONNX model weights. ONNX Runtime WASM blobs
 * are bundled in /static/ (not CDN entries) — see freeze.mjs CDN_ENTRIES.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const PROJECT_ROOT = join(SCRIPT_DIR, '..');
const MANIFESTS_DIR = join(PROJECT_ROOT, 'scripts/r2-uploads/manifests');
const TMP_DIR = join(PROJECT_ROOT, 'scripts/r2-uploads/.tmp');

// === CLI flags ===

const args = process.argv.slice(2);
const uploadMode = args.includes('--upload');
const dryRunMode = args.includes('--dry-run');

// === Manifest order (controls log order; small first, large last) ===

const MANIFEST_FILES = [
	'classifier files (small fp32 model)',
	'smollm2-1.7b-instruct-v1.json',
	'smollm3-3b-v1.json',
	'olmo-3-7b-instruct-v1.json',
	'legal-clause-classifier-v1.json'
];

// ============================================================
// ONNX Runtime version detection (informational only)
// ============================================================

async function getOrtVersion() {
	const candidates = [
		join(PROJECT_ROOT, 'node_modules/@huggingface/transformers/package.json'),
		join(PROJECT_ROOT, 'node_modules/onnxruntime-web/package.json')
	];
	for (const p of candidates) {
		try {
			const json = JSON.parse(await readFile(p, 'utf8'));
			if (json.version && json.name === 'onnxruntime-web') return json.version;
		} catch { /* missing or malformed — try next */ }
	}
	return '<PINNED-VERSION>';
}

// ============================================================
// Startup precondition checks
// ============================================================

/**
 * If --upload was passed, verify the wrangler CLI is installed and
 * authenticated BEFORE we download anything. Refuse to proceed if either
 * check fails — better to fail loud at startup than to silently upload
 * to the wrong account 7GB later.
 */
function requireWranglerReady(bucket) {
	console.log(`[sync:cdn] upload mode requested — verifying wrangler…`);
	try {
		const version = execFileSync('wrangler', ['--version'], { encoding: 'utf8' }).trim();
		console.log(`[sync:cdn] wrangler: ${version}`);
	} catch {
		console.error('');
		console.error('[sync:cdn] FATAL: --upload requested but `wrangler` is not installed or not on PATH.');
		console.error('         Install: pnpm add -Dw wrangler');
		console.error('         Auth:    wrangler login');
		console.error('         Then re-run: pnpm sync:cdn:upload');
		process.exit(1);
	}

	let who;
	try {
		who = execFileSync('wrangler', ['whoami'], { encoding: 'utf8' }).trim();
	} catch {
		console.error('');
		console.error('[sync:cdn] FATAL: wrangler is installed but not authenticated.');
		console.error('         Run: wrangler login');
		console.error('         Then re-run: pnpm sync:cdn:upload');
		process.exit(1);
	}
	console.log(`[sync:cdn] cloudflare account:\n${who.split('\n').map(l => '    ' + l).join('\n')}`);

	console.log(`[sync:cdn] target bucket: ${bucket}`);
	console.log(`[sync:cdn] continuing in 5 seconds — press Ctrl-C to abort…`);
	return new Promise((resolve) => {
		process.on('SIGINT', () => {
			console.error('\n[sync:cdn] aborted by user.');
			process.exit(130);
		});
		setTimeout(resolve, 5000);
	});
}

// ============================================================
// Download with streaming + LFS detection + @noble/hashes
// ============================================================

const LFS_PROBE_THRESHOLD_BYTES = 10_000;

/**
 * Look up the Git LFS oid (sha256) for a file via the HuggingFace API.
 *
 * The LFS oid is the canonical content-addressed hash published by HF for
 * LFS-tracked files — the closest thing to a "public hash" we can get for
 * model weights. Cross-referencing our computed sha256 against it is the
 * "public hash check": if our download produces a different sha256, the
 * CDN-served bytes don't match what the model publisher registered with
 * the platform, and we abort.
 *
 * Returns the LFS oid (hex, no "sha256:" prefix), or null if:
 *   - the fileUrl is not from huggingface.co
 *   - the file isn't LFS-tracked (some small files are inline-only)
 *   - the API call fails for any reason (network, rate limit, etc.)
 *
 * API endpoint:
 *   GET https://huggingface.co/api/models/{org}/{model}/tree/{revision}/{dir}
 *   → returns directory listing; LFS-tracked entries have `lfs.oid`.
 */
async function fetchLfsOidFromHfApi(fileUrl, sourceUrl) {
	if (!fileUrl.startsWith('https://huggingface.co/')) return null;

	// sourceUrl is the directory: https://huggingface.co/{org}/{model}/resolve/{rev}/{dir}/
	const m = sourceUrl.match(/^https:\/\/huggingface\.co\/([^/]+)\/([^/]+)\/resolve\/([^/]+)\/(.+?)\/?$/);
	if (!m) return null;
	const [, org, model, revision, dirPath] = m;
	const apiUrl = `https://huggingface.co/api/models/${org}/${model}/tree/${revision}/${dirPath}`;

	try {
		const response = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return null;
		const files = await response.json();
		if (!Array.isArray(files)) return null;
		const fileName = fileUrl.split('?')[0].split('/').pop();
		const match = files.find((f) => {
			const p = f?.path ?? '';
			return p === `${dirPath}/${fileName}` || p.endsWith(`/${fileName}`);
		});
		if (match?.lfs?.oid && typeof match.lfs.oid === 'string') {
			return match.lfs.oid.replace(/^sha256:/, '');
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Download a URL to a local temp path, returning { sha256, size, lfsOid }.
 *
 * Handles three response shapes:
 *   1. Small response (<10KB) → read into buffer, check for LFS magic.
 *      If LFS pointer detected, parse oid and recurse with that oid as the
 *      expected hash (defense-in-depth: the LFS pointer is the in-band
 *      public hash). If small but not LFS, query the HF API for the LFS oid.
 *   2. Large response → query the HF API for the LFS oid (no in-band
 *      pointer served for big files), then stream + hash + verify.
 *   3. Redirect (302) → fetch() follows transparently.
 *
 * In ALL cases where we successfully look up an LFS oid, the computed
 * sha256 is compared against it. A mismatch aborts the whole run — it
 * indicates either a compromised CDN or HF-side corruption, and shipping
 * a model whose hash doesn't match the public LFS oid is a serious
 * integrity failure.
 */
async function downloadFile(fileUrl, destPath, opts = {}) {
	let expectedSha256 = opts.expectedSha256 ?? null;   // LFS oid (in-band pointer OR API)
	const sourceUrl = opts.sourceUrl ?? null;           // for HF API lookup if no in-band oid

	await mkdir(dirname(destPath), { recursive: true });

	const response = await fetch(fileUrl);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText} for ${fileUrl}`);
	}

	const contentLength = Number(response.headers.get('content-length')) || null;
	const fileLabel = fileUrl.split('?')[0].split('/').pop();

	// ── Small response — probe for LFS ────────────────────────────────
	if (contentLength !== null && contentLength < LFS_PROBE_THRESHOLD_BYTES) {
		const buf = Buffer.from(await response.arrayBuffer());
		const head = buf.toString('utf-8', 0, Math.min(300, buf.length));

		if (head.startsWith('version https://git-lfs.github.com/spec/v1')) {
			const oidMatch = head.match(/^oid sha256:([0-9a-f]{64})$/m);
			if (!oidMatch) {
				throw new Error(
					`LFS pointer detected but oid could not be parsed for ${fileUrl}.\n` +
					`First 200 bytes:\n${head.slice(0, 200)}`
				);
			}
			const lfsOid = oidMatch[1];
			const retryUrl = `${fileUrl.split('?')[0]}?download=true`;
			process.stdout.write(
				`  ⚠ ${fileLabel}: LFS pointer (oid=${lfsOid.slice(0, 12)}…), retrying with ?download=true\n`
			);
			// Recurse with the LFS oid as the expected hash for verification.
			return downloadFile(retryUrl, destPath, { ...opts, expectedSha256: lfsOid });
		}

		// Small but not LFS. Try the API for the public hash.
		if (!expectedSha256 && sourceUrl) {
			expectedSha256 = await fetchLfsOidFromHfApi(fileUrl, sourceUrl);
		}

		await writeFile(destPath, buf);
		const sha = bytesToHex(sha256(buf));
		if (expectedSha256 && expectedSha256 !== sha) {
			throw new Error(
				`sha256 mismatch for ${fileLabel}\n` +
				`  LFS oid (public hash): ${expectedSha256}\n` +
				`  downloaded bytes:      ${sha}\n` +
				`  source: ${fileUrl}\n` +
				`Indicates a compromised CDN response or HF-side corruption. Aborting.`
			);
		}
		const lfsNote = expectedSha256 === sha ? ' (matches LFS oid)' : '';
		process.stdout.write(
			`  ✓ ${fileLabel} (${(buf.byteLength / 1024).toFixed(1)} KB) — sha256=${sha.slice(0, 12)}…${lfsNote}\n`
		);
		return { sha256: sha, size: buf.byteLength, lfsOid: expectedSha256 };
	}

	// ── Large response — stream to disk, hash as we go ────────────────
	// The previous implementation read the whole file back into a Buffer after
	// the download and hashed it with @noble/hashes. That works for files < 2 GiB
	// but Node Buffers are capped at ~2 GiB (kMaxLength), so anything bigger
	// (e.g. SmolLM3-3B's 2.84 GB model_q4.onnx_data) throws
	// "File size (...) is greater than 2 GiB".
	//
	// Fix: hash during the stream, using Node's createHash('sha256') which is
	// unbounded. SHA-256 is SHA-256; the output hex is identical to @noble/hashes.
	// Net result: same pin, no 2 GiB cap, no extra read pass.
	//
	// LFS oid verification: we don't get an in-band LFS pointer for large
	// files, so query the HF API for the public hash before downloading.
	// If the API lookup fails (network blip, rate limit, non-LFS file),
	// we still hash the bytes — but we can't cross-reference them.
	if (!expectedSha256 && sourceUrl) {
		expectedSha256 = await fetchLfsOidFromHfApi(fileUrl, sourceUrl);
	}

	const totalMB = contentLength != null ? (contentLength / 1024 / 1024).toFixed(1) : '?';
	process.stdout.write(`  ↓ ${fileLabel} (~${totalMB} MB)… 0%   `);

	const writer = createWriteStream(destPath);
	const hasher = createHash('sha256');
	let downloaded = 0;
	let lastPct = -1;
	try {
		const reader = response.body.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			hasher.update(value);
			writer.write(Buffer.from(value));
			downloaded += value.byteLength;
			if (contentLength) {
				const pct = Math.floor((downloaded / contentLength) * 100);
				if (pct !== lastPct && pct % 5 === 0) {
					process.stdout.write(`\r  ↓ ${fileLabel} (~${totalMB} MB)… ${pct}%   `);
					lastPct = pct;
				}
			}
		}
		reader.releaseLock();
	} finally {
		await new Promise((resolve, reject) => {
			writer.end((err) => err ? reject(err) : resolve());
		});
	}

	const sha = hasher.digest('hex');
	if (expectedSha256 && expectedSha256 !== sha) {
		// Delete the corrupted download to prevent accidental use later.
		await rm(destPath, { force: true });
		throw new Error(
			`sha256 mismatch for ${fileLabel}\n` +
			`  LFS oid (public hash): ${expectedSha256}\n` +
			`  downloaded bytes:      ${sha}\n` +
			`  source: ${fileUrl}\n` +
			`Indicates a compromised CDN response or HF-side corruption. Aborting.`
		);
	}
	const lfsNote = expectedSha256 === sha ? ' (matches LFS oid)' : '';
	process.stdout.write(
		`\r  ✓ ${fileLabel} (${(downloaded / 1024 / 1024).toFixed(1)} MB) — sha256=${sha.slice(0, 12)}…${lfsNote}\n`
	);
	return { sha256: sha, size: downloaded, lfsOid: expectedSha256 };
}

// ============================================================
// Wrangler R2 upload (--upload only)
// ============================================================

function wranglerUpload(localPath, r2Key, bucket) {
	process.stdout.write(`  ↑ ${bucket}/${r2Key}… `);
	try {
		execFileSync(
			'wrangler',
			['r2', 'object', 'put', `${bucket}/${r2Key}`, '--file', localPath],
			{ stdio: ['ignore', 'pipe', 'pipe'] }
		);
		process.stdout.write(`done\n`);
	} catch (err) {
		process.stdout.write(`FAILED\n`);
		const out = (err.stdout?.toString() ?? '').trim();
		const errOut = (err.stderr?.toString() ?? '').trim();
		throw new Error(
			`wrangler exited with code ${err.status ?? 'unknown'} for ${bucket}/${r2Key}\n` +
			(out ? `stdout: ${out}\n` : '') +
			(errOut ? `stderr: ${errOut}` : '')
		);
	}
}

// ============================================================
// R2 key derivation
// ============================================================

function computeR2Key(manifestName, kind, fileName) {
	if (kind === 'model') {
		const stem = manifestName.replace(/-v\d+\.json$/, '');
		return `${stem}/v1/${fileName}`;
	}
	throw new Error(`Unknown manifest kind: ${kind}`);
}

function resolveFileUrl(manifestSource, fileName) {
	if (manifestSource.endsWith(fileName)) return manifestSource;
	if (manifestSource.endsWith('/')) return manifestSource + fileName;
	return `${manifestSource}/${fileName}`;
}

// ============================================================
// Main
// ============================================================

async function main() {
	const modeLabel = dryRunMode
		? 'DRY-RUN (no downloads, no manifest writes, no R2 upload)'
		: uploadMode
			? 'download + hash + manifest write + R2 upload'
			: 'download + hash + manifest write (no R2 upload)';
	console.log(`[sync:cdn] mode: ${modeLabel}`);
	console.log(`[sync:cdn] manifests: ${MANIFESTS_DIR}/`);
	console.log(`[sync:cdn] files queued: ${MANIFEST_FILES.length - 1} (4 model manifests + informational line)`);

	let bucket = null;
	if (uploadMode) {
		bucket = process.env.CESVU_R2_BUCKET;
		if (!bucket) {
			console.error('');
			console.error('[sync:cdn] FATAL: --upload requested but CESVU_R2_BUCKET is not set.');
			console.error('         Set it explicitly: $env:CESVU_R2_BUCKET = "cesvu-bucket"');
			console.error('         (PowerShell)  or  export CESVU_R2_BUCKET=cesvu-bucket  (bash)');
			console.error('         Refusing to silently default to a guessed bucket name.');
			process.exit(1);
		}
		await requireWranglerReady(bucket);
	}

	// Filter out the informational-only entry, then process real manifests.
	const realManifests = MANIFEST_FILES.filter((m) => m.endsWith('.json'));
	const ortVersion = await getOrtVersion();
	console.log(`[sync:cdn] onnxruntime-web version (resolved, informational): ${ortVersion}\n`);

	if (!dryRunMode) {
		await mkdir(TMP_DIR, { recursive: true });
	}

	let total = 0;
	let updated = 0;
	let unchanged = 0;
	let failed = 0;

	for (const manifestName of realManifests) {
		const manifestPath = join(MANIFESTS_DIR, manifestName);
		let snapshot;
		try {
			snapshot = JSON.parse(await readFile(manifestPath, 'utf8'));
		} catch (err) {
			console.error(`✗ ${manifestName}: ${err.message}`);
			failed++;
			continue;
		}

		if (typeof snapshot.source === 'string' && snapshot.source.includes('<PINNED-VERSION>')) {
			snapshot.source = snapshot.source.replace('<PINNED-VERSION>', ortVersion);
		}

		const kind = snapshot.kind ?? 'model';
		console.log(`[${manifestName}] kind=${kind}  source=${snapshot.source}`);

		let manifestChanged = false;
		for (const fileEntry of snapshot.files ?? []) {
			total++;
			const fileName = fileEntry.name;
			const fileUrl = resolveFileUrl(snapshot.source, fileName);
			const tmpPath = join(TMP_DIR, manifestName.replace('.json', ''), fileName);

			try {
				if (dryRunMode) {
					console.log(`  · ${fileName}: would download from ${fileUrl}`);
					continue;
				}

				const actual = await downloadFile(fileUrl, tmpPath, { sourceUrl: snapshot.source });

				const wasEmpty = fileEntry.sha256 == null;
				const matches = fileEntry.sha256 === actual.sha256 && fileEntry.size === actual.size;

				if (matches) {
					// sha256 + size already match. But the LFS oid (public hash)
					// may be new — e.g. this is the first run after the LFS
					// verification patch was applied, and earlier runs never wrote
					// lfs_oid. Persist it if we got one and the manifest lacks it,
					// so the manifest becomes a complete audit record.
					if (actual.lfsOid && fileEntry.lfs_oid !== actual.lfsOid) {
						fileEntry.lfs_oid = actual.lfsOid;
						manifestChanged = true;
						updated++;
						console.log(`  ~ ${fileName}: lfs_oid populated (oid=${actual.lfsOid.slice(0, 12)}…)`);
					} else {
						console.log(`  = ${fileName}: unchanged (sha256 + size already match)`);
						unchanged++;
					}
				} else {
					const reason = wasEmpty
						? 'pending → populated'
						: `changed (was ${fileEntry.sha256?.slice(0, 12) ?? 'null'}…, now ${actual.sha256.slice(0, 12)}…)`;
					console.log(`  ~ ${fileName}: ${reason}`);
					fileEntry.sha256 = actual.sha256;
					fileEntry.size = actual.size;
					// Persist the LFS oid (public hash) if we got one. This is the
					// canonical content-addressed hash published by HF — the manifest
					// is a permanent record of it for audit / future re-verification.
					if (actual.lfsOid) {
						fileEntry.lfs_oid = actual.lfsOid;
					}
					manifestChanged = true;
					updated++;

					if (uploadMode) {
						const r2Key = computeR2Key(manifestName, kind, fileName);
						wranglerUpload(tmpPath, r2Key, bucket);
					}
				}
			} catch (err) {
				console.error(`  ✗ ${fileName}: ${err.message}`);
				failed++;
			}
		}

		if (!dryRunMode && manifestChanged) {
			snapshot.pinned_at = new Date().toISOString();
			await writeFile(manifestPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
			console.log(`  ✓ wrote ${manifestName} (pinned_at=${snapshot.pinned_at})`);
		}
	}

	console.log(`\n[sync:cdn] done. ${total} files processed: ${updated} updated, ${unchanged} unchanged, ${failed} failed.`);
	if (failed > 0) process.exit(1);

	if (!dryRunMode) {
		await rm(TMP_DIR, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(`\n[sync:cdn] fatal: ${err.stack || err.message}`);
	process.exit(1);
});
