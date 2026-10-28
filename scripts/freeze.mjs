#!/usr/bin/env node
/**
 * scripts/freeze.mjs — Build artifact integrity manifest
 *
 * Subcommands:
 *   freeze         — walk dist/, hash every file with SHA-256 + SHA-384, write
 *                    dist/integrity.json (per-file entry stores both hashes + size).
 *   verify         — walk dist/, hash every file, compare against dist/integrity.json.
 *                    Exits non-zero on mismatch; this is the pre-deploy gate.
 *   inject         — rewrite every *.html under dist/ to add integrity="sha384-…"
 *                    + crossorigin="anonymous" attributes on local <script src>,
 *                    <link rel="stylesheet">, <link rel="modulepreload">, and
 *                    <link rel="preload" as="script|style">. Driven by integrity.json.
 *                    Idempotent: re-running is safe.
 *   sri:verify     — re-parse dist/*.html and assert every local script/link has
 *                    an integrity attribute matching the manifest. Exits non-zero
 *                    if anything is missing or stale.
 *   models:build   — read R2-sidecar manifests from scripts/r2-uploads/manifests/
 *                    and write static/models.json with pinned sha256 hashes. Fully
 *                    offline; no HF Hub, no jsDelivr.
 *
 * Crypto:
 *   Uses node:crypto's createHash('sha256'/'sha384') — Node's built-in digest
 *   implementation, no third-party dependency. No GPG, no openssl.
 *
 * Output (dist/integrity.json), current schema:
 *   {
 *     version: '1.0.0',
 *     algorithm: 'sha256',
 *     git_sha: '<current commit>',
 *     built_at: '<ISO timestamp>',
 *     files: {
 *       'index.html':          { sha256: '<hex>', sha384: '<hex>', size: 1234 },
 *       '_app/.../chunk.js':   { sha256: '<hex>', sha384: '<hex>', size: 5678 },
 *       ...
 *     }
 *   }
 *
 * The old single-hex-string shape ('index.html': '<sha256>') is still accepted by
 * `verify` and `sri:verify` for backwards compatibility — those entries are flagged
 * with a warning, not a failure, until `freeze` is re-run.
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep, posix, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Anchor every project-root-relative path to THIS SCRIPT'S location, not the
// process cwd. This way the script works no matter where it is invoked from
// (pnpm script, absolute path, or a different cwd). Prevents the cwd-relative
// breakage that bit us when running `node scripts/freeze.mjs` directly.
const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(__filename);
const PROJECT_ROOT = join(SCRIPT_DIR, '..');

const DIST_DIR = join(PROJECT_ROOT, 'dist');
const MANIFEST_PATH = join(DIST_DIR, 'integrity.json');
const MODELS_MANIFEST_PATH = join(PROJECT_ROOT, 'static/models.json');
const MANIFESTS_DIR = join(PROJECT_ROOT, 'scripts/r2-uploads/manifests');

// ============================================================
// File walking
// ============================================================

/**
 * Recursively list all files under `root`, returning POSIX-style paths
 * relative to `root`. Skips dotfiles and source maps by default.
 */
async function walkFiles(root) {
	const out = [];

	async function recurse(dir) {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (err) {
			if (err.code === 'ENOENT') return;
			throw err;
		}
		for (const entry of entries) {
			// Skip hidden files (.DS_Store, .git, etc.) and sourcemaps
			if (entry.name.startsWith('.')) continue;
			if (entry.name.endsWith('.map')) continue;
			if (entry.name === 'integrity.json') continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await recurse(full);
			} else if (entry.isFile()) {
				// Normalize to POSIX-style for cross-platform manifests
				const rel = relative(root, full).split(sep).join(posix.sep);
				out.push({ abs: full, rel });
			}
		}
	}

	await recurse(root);
	return out;
}

/**
 * Walk dist/ and return every *.html file. Used by `inject` and `sri:verify`.
 */
async function walkHtml(root) {
	const files = await walkFiles(root);
	return files.filter((f) => f.rel.endsWith('.html'));
}

// ============================================================
// Hashing
// ============================================================

/**
 * Compute sha256 + sha384 + byte length of a file.
 * Returns the new manifest-shape entry: { sha256, sha384, size }.
 */
async function hashFileFull(absPath) {
	const buf = await readFile(absPath);
	return {
		sha256: createHash('sha256').update(buf).digest('hex'),
		sha384: createHash('sha384').update(buf).digest('hex'),
		size: buf.byteLength
	};
}

/**
 * Backwards-compatible single-hash read of a file (sha256 only).
 * Kept for callers that only need sha256; `freeze` uses hashFileFull now.
 */
async function hashFile(absPath) {
	const buf = await readFile(absPath);
	return createHash('sha256').update(buf).digest('hex');
}

/**
 * Normalize a manifest entry to { sha256, sha384, size } regardless of shape.
 * Accepts:
 *   - new shape: { sha256: '<hex>', sha384: '<hex>', size: <number> }
 *   - old shape: '<sha256 hex string>'
 * Returns null if sha256 is missing.
 */
function normalizeEntry(entry) {
	if (entry == null) return null;
	if (typeof entry === 'string') return { sha256: entry, sha384: null, size: null };
	if (typeof entry === 'object' && typeof entry.sha256 === 'string') {
		return {
			sha256: entry.sha256,
			sha384: typeof entry.sha384 === 'string' ? entry.sha384 : null,
			size: typeof entry.size === 'number' ? entry.size : null
		};
	}
	return null;
}

// ============================================================
// Git SHA (best effort)
// ============================================================

function getGitSha() {
	try {
		return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
			.toString()
			.trim()
			.slice(0, 40);
	} catch {
		return 'unknown';
	}
}

// ============================================================
// freeze subcommand
// ============================================================

async function freezeCommand() {
	const root = DIST_DIR;
	try {
		await stat(root);
	} catch {
		console.error(`✗ ${root}/ not found. Run \`pnpm build\` first.`);
		process.exit(1);
	}

	console.log(`[freeze] Walking ${root}/…`);
	const files = await walkFiles(root);
	console.log(`[freeze] Found ${files.length} files. Hashing with SHA-256 + SHA-384 via node:crypto…`);

	const entries = {};
	let count = 0;
	for (const { abs, rel } of files) {
		entries[rel] = await hashFileFull(abs);
		count++;
		if (count % 50 === 0) {
			process.stdout.write(`\r[freeze] Hashed ${count}/${files.length}…`);
		}
	}
	process.stdout.write(`\r[freeze] Hashed ${count}/${files.length}.\n`);

	const manifest = {
		version: '1.0.0',
		algorithm: 'sha256',
		git_sha: getGitSha(),
		built_at: new Date().toISOString(),
		files: entries
	};

	await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
	console.log(`✓ Wrote ${MANIFEST_PATH} (${files.length} files, sha256 + sha384 + size each).`);
}

// ============================================================
// verify subcommand
// ============================================================

async function verifyCommand() {
	const root = DIST_DIR;

	let manifest;
	try {
		manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
	} catch {
		console.error(`✗ ${MANIFEST_PATH} not found. Run \`pnpm freeze\` first.`);
		process.exit(1);
	}

	if (manifest.algorithm !== 'sha256') {
		console.error(`✗ Unsupported algorithm: ${manifest.algorithm}. Expected sha256.`);
		process.exit(1);
	}

	// Backwards-compat: count old-shape entries and warn (not fail).
	let oldShape = 0;
	for (const v of Object.values(manifest.files)) {
		if (typeof v === 'string') oldShape++;
	}

	console.log(`[verify] Loaded manifest (${Object.keys(manifest.files).length} files, git_sha=${manifest.git_sha.slice(0, 8)}).`);
	if (oldShape > 0) {
		console.warn(`  ! ${oldShape} entries are in the legacy string-shape. Re-run \`pnpm freeze\` to upgrade (warn-only, verification still proceeds).`);
	}

	const files = await walkFiles(root);
	const onDisk = new Map(files.map((f) => [f.rel, f.abs]));

	let mismatches = 0;
	let missing = 0;
	let extra = 0;

	// Check every manifest file matches
	for (const [rel, rawExpected] of Object.entries(manifest.files)) {
		const abs = onDisk.get(rel);
		if (!abs) {
			console.error(`  ✗ MISSING: ${rel}`);
			missing++;
			continue;
		}
		const expected = normalizeEntry(rawExpected);
		if (!expected || !expected.sha256) {
			console.error(`  ✗ MALFORMED entry for ${rel}`);
			mismatches++;
			continue;
		}
		const actual = await hashFile(abs);
		if (actual !== expected.sha256) {
			console.error(`  ✗ MISMATCH: ${rel}`);
			console.error(`      expected: ${expected.sha256}`);
			console.error(`      actual:   ${actual}`);
			mismatches++;
		}
	}

	// Check no extra files (likely cause: uncommitted new asset)
	for (const { rel } of files) {
		if (!(rel in manifest.files)) {
			console.error(`  ✗ EXTRA: ${rel} (not in manifest)`);
			extra++;
		}
	}

	const total = mismatches + missing + extra;
	if (total === 0) {
		console.log(`✓ All ${Object.keys(manifest.files).length} files match manifest. Integrity OK.`);
		process.exit(0);
	} else {
		console.error(`\n✗ ${mismatches} mismatches, ${missing} missing, ${extra} extra.`);
		console.error(`  Run \`pnpm freeze\` to regenerate the manifest (only if changes are intentional).`);
		process.exit(1);
	}
}

// ============================================================
// inject subcommand (SRI)
// ============================================================

/**
 * Match the URL-bearing tags we want to harden with SRI. Groups:
 *   1: tag name (script or link)
 *   2: attributes before src/href (with leading space, may be empty)
 *   3: attribute name (src or href)
 *   4: the URL (between double quotes)
 *   5: attributes after the URL (with leading space, may be empty)
 *   6: self-closing slash (or empty)
 *
 * The regex is intentionally tight: double-quoted attributes only (SvelteKit's
 * static adapter emits them this way), no template literals, no JSX-style.
 * If Vite ever changes its emitted attribute style, this regex needs to follow.
 *
 * The match starts at "<script" or "<link" (not just "<" + word) so we don't
 * catch e.g. `<linkage>` or `<scriptlet>`. We match the FIRST src/href per tag
 * (lazy `*?` after the tag opener), which is fine because SvelteKit/Vite only
 * emit one of these per tag.
 */
const SRI_TAG_RE =
	/<(script|link)\b([^>]*?)\s(src|href)="([^"]+)"([^>]*?)(\/?)>/g;

function buildSriAttr(sha384Hex) {
	return ` integrity="sha384-${sha384Hex}" crossorigin="anonymous"`;
}

/**
 * Given an HTML string and a manifest, rewrite the string so every local
 * <script>/<link> tag has integrity="sha384-…" crossorigin="anonymous".
 * Returns { html, stats } where stats counts what changed.
 */
function injectSriIntoHtml(html, manifest) {
	const stats = { tagsScanned: 0, tagsInjected: 0, tagsSkippedExternal: 0, tagsSkippedExisting: 0, tagsSkippedNoManifest: 0 };

	const updated = html.replace(SRI_TAG_RE, (match, tagName, before, attrName, url, after, selfClose) => {
		stats.tagsScanned++;

		// Skip if integrity is already present (idempotent re-runs).
		if (/\bintegrity\s*=/i.test(match)) {
			stats.tagsSkippedExisting++;
			return match;
		}

		// Only local (absolute-path or relative) URLs. External CDN URLs are
		// left alone — they're not in the manifest anyway, but we want to be
		// explicit so an unexpected external script doesn't get silently dropped.
		const isLocal = url.startsWith('/') || (!/^([a-z]+:)?\/\//i.test(url) && !url.startsWith('//'));
		if (!isLocal) {
			stats.tagsSkippedExternal++;
			return match;
		}

		// Normalize to a manifest key (leading slash stripped).
		let key = url;
		if (key.startsWith('/')) key = key.slice(1);
		// Some Vite outputs use ./ prefix; normalize.
		if (key.startsWith('./')) key = key.slice(2);

		const entry = normalizeEntry(manifest.files[key]);
		if (!entry || !entry.sha384) {
			stats.tagsSkippedNoManifest++;
			return match;
		}

		stats.tagsInjected++;
		return `<${tagName}${before} ${attrName}="${url}"${after}${buildSriAttr(entry.sha384)}${selfClose}>`;
	});

	return { html: updated, stats };
}

async function injectCommand() {
	const root = DIST_DIR;

	let manifest;
	try {
		manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
	} catch {
		console.error(`✗ ${MANIFEST_PATH} not found. Run \`pnpm freeze\` first.`);
		process.exit(1);
	}

	// Count old-shape entries; refuse to inject if there are none with sha384
	// (otherwise every local tag would be silently skipped).
	let withSha384 = 0;
	for (const v of Object.values(manifest.files)) {
		const n = normalizeEntry(v);
		if (n && n.sha384) withSha384++;
	}
	if (withSha384 === 0) {
		console.error(`✗ No sha384 entries in ${MANIFEST_PATH}. Re-run \`pnpm freeze\` to upgrade the manifest.`);
		process.exit(1);
	}

	let htmlFiles;
	try {
		htmlFiles = await walkHtml(root);
	} catch (err) {
		console.error(`✗ Could not walk ${root}/: ${err.message}`);
		process.exit(1);
	}

	if (htmlFiles.length === 0) {
		console.warn(`[inject] No *.html files found under ${root}/. Skipping.`);
		return;
	}

	console.log(`[inject] Injecting SRI attributes into ${htmlFiles.length} HTML file(s)…`);

	const totals = { tagsScanned: 0, tagsInjected: 0, tagsSkippedExternal: 0, tagsSkippedExisting: 0, tagsSkippedNoManifest: 0 };
	let changedFiles = 0;

	for (const { abs, rel } of htmlFiles) {
		const original = await readFile(abs, 'utf8');
		const { html, stats } = injectSriIntoHtml(original, manifest);
		for (const k of Object.keys(totals)) totals[k] += stats[k];

		if (html !== original) {
			await writeFile(abs, html, 'utf8');
			changedFiles++;
			console.log(`  ✓ ${rel}: +${stats.tagsInjected} integrity, ${stats.tagsSkippedExisting} already had it, ${stats.tagsSkippedExternal} external, ${stats.tagsSkippedNoManifest} not in manifest`);
		} else {
			console.log(`  = ${rel}: no changes`);
		}
	}

	// Re-hash any HTML we modified and write the updated hashes back to the
	// manifest. Otherwise verify would flag the injected HTML as a hash
	// mismatch (the manifest was written by freeze BEFORE inject changed it).
	if (changedFiles > 0) {
		console.log(`[inject] Updating manifest with post-inject HTML hashes…`);
		let manifestRaw;
		try {
			manifestRaw = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
		} catch (err) {
			console.error(`✗ Could not re-read ${MANIFEST_PATH}: ${err.message}`);
			process.exit(1);
		}
		for (const { abs, rel } of htmlFiles) {
			if (manifestRaw.files[rel]) {
				const updated = await hashFileFull(abs);
				manifestRaw.files[rel] = updated;
			}
		}
		await writeFile(MANIFEST_PATH, JSON.stringify(manifestRaw, null, 2) + '\n', 'utf8');
		console.log(`  ✓ Updated ${changedFiles} HTML hash(es) in ${MANIFEST_PATH}.`);
	}
	console.log(`\n[inject] Done. Scanned ${totals.tagsScanned} tag(s); injected ${totals.tagsInjected}; updated ${changedFiles}/${htmlFiles.length} file(s).`);
	console.log(`         Skipped: ${totals.tagsSkippedExternal} external, ${totals.tagsSkippedExisting} already had integrity, ${totals.tagsSkippedNoManifest} not in manifest.`);
}

// ============================================================
// sri:verify subcommand
// ============================================================

/**
 * Extract every (tagName, attrName, url, integrityValue) tuple from an HTML string.
 * Returns an array.
 */
function extractSriTags(html) {
	const out = [];
	SRI_TAG_RE.lastIndex = 0;
	let m;
	while ((m = SRI_TAG_RE.exec(html)) !== null) {
		const tagName = m[1];
		const attrName = m[3];
		const url = m[4];
		const attrs = m[2] + ' ' + m[5] + ' ' + m[6];
		const integrityMatch = attrs.match(/\bintegrity\s*=\s*"([^"]+)"/i);
		out.push({ tagName, attrName, url, integrity: integrityMatch ? integrityMatch[1] : null });
	}
	return out;
}

async function sriVerifyCommand() {
	const root = DIST_DIR;

	let manifest;
	try {
		manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
	} catch {
		console.error(`✗ ${MANIFEST_PATH} not found. Run \`pnpm freeze\` first.`);
		process.exit(1);
	}

	const htmlFiles = await walkHtml(root);
	if (htmlFiles.length === 0) {
		console.warn(`[sri:verify] No *.html files under ${root}/. Nothing to verify.`);
		return;
	}

	let missing = 0;
	let mismatched = 0;
	let externalCount = 0;
	let ok = 0;

	for (const { abs, rel } of htmlFiles) {
		const html = await readFile(abs, 'utf8');
		const tags = extractSriTags(html);

		for (const t of tags) {
			const isLocal = t.url.startsWith('/') || (!/^([a-z]+:)?\/\//i.test(t.url) && !t.url.startsWith('//'));
			if (!isLocal) {
				externalCount++;
				continue;
			}

			let key = t.url;
			if (key.startsWith('/')) key = key.slice(1);
			if (key.startsWith('./')) key = key.slice(2);

			const entry = normalizeEntry(manifest.files[key]);
			if (!entry || !entry.sha384) {
				console.error(`  ✗ ${rel}: <${t.tagName} ${t.attrName}="${t.url}"> has no manifest entry (run \`pnpm freeze\` and \`pnpm inject\`).`);
				missing++;
				continue;
			}
			if (!t.integrity) {
				console.error(`  ✗ ${rel}: <${t.tagName} ${t.attrName}="${t.url}"> is missing integrity attribute.`);
				missing++;
				continue;
			}
			const expected = `sha384-${entry.sha384}`;
			if (t.integrity !== expected) {
				console.error(`  ✗ ${rel}: <${t.tagName} ${t.attrName}="${t.url}"> integrity mismatch`);
				console.error(`       expected: ${expected}`);
				console.error(`       actual:   ${t.integrity}`);
				mismatched++;
				continue;
			}
			ok++;
		}
	}

	const total = missing + mismatched;
	if (total === 0) {
		console.log(`✓ SRI verified: ${ok} local tag(s) match manifest. ${externalCount} external tag(s) skipped (as expected).`);
		process.exit(0);
	} else {
		console.error(`\n✗ SRI verification failed: ${missing} missing, ${mismatched} mismatched, ${ok} OK.`);
		console.error(`  Run \`pnpm inject\` to (re)inject SRI attributes.`);
		process.exit(1);
	}
}

// ============================================================
// models:build subcommand
// ============================================================

/**
 * Known runtime-fetched CDN entries used by the app. Discriminated union:
 *
 *   { kind: 'model', id, baseUrl, file }  — ONNX model weights (q4 variants + companion files)
 *
 * NOTE: ONNX Runtime WASM blobs are bundled in /static/ — first-party, SRI-covered.
 * They are NOT CDN entries. (See scripts/r2-uploads/README.md §"WASM bundling".)
 *
 * Each model entry maps an in-app slot to a first-party Cloudflare R2 URL bound to
 * `ai.cesvu.com` and the canonical file we hash-check after download.
 *
 * MODELS (q4 quantization — smallest variant that fits browser inference):
 *   - SmolLM2-1.7B:  1 file  (combined .onnx — special case)
 *   - SmolLM3-3B:    2 files (model_q4.onnx + model_q4.onnx_data)
 *   - OLMo-3-7B:     3 files (model_q4.onnx + 2x model_q4.onnx_data_N)
 *   - Classifier:    2 files (model.onnx + model.onnx.data, fp32)
 *
 * The browser fetches these at runtime via transformers.js; the upload pipeline
 * (see scripts/r2-uploads/README.md) writes a sidecar manifest.json next to each
 * file with `{ file, sha256, size, contentType, source, pinned_at }`. We read those
 * manifests here instead of calling HuggingFace Hub or jsDelivr directly, so the
 * build is fully reproducible offline and doesn't depend on third-party APIs.
 *
 * (Legacy: previous versions of this array called the HF Hub API for the
 * models. That logic was removed when we migrated to first-party R2 hosting —
 * see `.clinerules/rules.txt` "No runtime CDN imports".)
 */
const CDN_ENTRIES = [
	// ── ONNX model weights — q4 variant (combined .onnx) ─────────────────
	{
		kind: 'model',
		id: 'smollm2-q4',
		baseUrl: 'https://ai.cesvu.com/smollm2-1.7b-instruct/v1',
		file: 'model_q4.onnx',
		manifest: 'smollm2-1.7b-instruct-v1.json'
	},

	// ── ONNX model weights — q4 variant (split into 2 files) ────────────
	{
		kind: 'model',
		id: 'smollm3-q4-onnx',
		baseUrl: 'https://ai.cesvu.com/smollm3-3b/v1',
		file: 'model_q4.onnx',
		manifest: 'smollm3-3b-v1.json'
	},
	{
		kind: 'model',
		id: 'smollm3-q4-data',
		baseUrl: 'https://ai.cesvu.com/smollm3-3b/v1',
		file: 'model_q4.onnx_data',
		manifest: 'smollm3-3b-v1.json'
	},

	// ── ONNX model weights — q4 variant (split into 3 files) ────────────
	{
		kind: 'model',
		id: 'olmo3-q4-onnx',
		baseUrl: 'https://ai.cesvu.com/olmo-3-7b-instruct/v1',
		file: 'model_q4.onnx',
		manifest: 'olmo-3-7b-instruct-v1.json'
	},
	{
		kind: 'model',
		id: 'olmo3-q4-data-1',
		baseUrl: 'https://ai.cesvu.com/olmo-3-7b-instruct/v1',
		file: 'model_q4.onnx_data',
		manifest: 'olmo-3-7b-instruct-v1.json'
	},
	{
		kind: 'model',
		id: 'olmo3-q4-data-2',
		baseUrl: 'https://ai.cesvu.com/olmo-3-7b-instruct/v1',
		file: 'model_q4.onnx_data_1',
		manifest: 'olmo-3-7b-instruct-v1.json'
	},

	// ── BERT text-classification model (fp32, 2 files) ───────────────────
	{
		// Loaded by src/lib/models/legal-classifier.ts (contract lens).
		// fp32 only — no quantized build for this model. ~280MB total.
		kind: 'model',
		id: 'classifier-onnx',
		baseUrl: 'https://ai.cesvu.com/legal-clause-classifier/v1',
		file: 'model.onnx',
		manifest: 'legal-clause-classifier-v1.json'
	},
	{
		kind: 'model',
		id: 'classifier-data',
		baseUrl: 'https://ai.cesvu.com/legal-clause-classifier/v1',
		file: 'model.onnx.data',
		manifest: 'legal-clause-classifier-v1.json'
	}

	// (No ort-wasm entries — those are bundled in /static/, not fetched from CDN.)
];

/**
 * Read each entry's manifest from scripts/r2-uploads/manifests/ — the local
 * staging copies of the R2-sidecar manifests. We DO NOT contact any external
 * API (no HF Hub, no jsDelivr). The build is fully reproducible offline.
 */
/**
 * Detect entries that still point at the courtesy default host
 * (ai.cesvu.com) and print a warning. Self-hosted forks should swap
 * these URLs out before deploying for real users — see MODELS.md →
 * "Should you use the default ai.cesvu.com host?" for the rationale.
 *
 * Env vars:
 *   CESVU_ACCEPT_DEFAULT_MODEL_HOST=1   suppress the warning
 *   CESVU_REQUIRE_NON_DEFAULT_HOST=1   fail the build if any entry uses it
 *
 * Default behaviour: warn, don't fail. CI for forks should set
 * CESVU_REQUIRE_NON_DEFAULT_HOST=1 to make the warning fatal.
 */
function checkDefaultHost(entries) {
	const DEFAULT_HOST = 'ai.cesvu.com';
	const ACCEPT = process.env.CESVU_ACCEPT_DEFAULT_MODEL_HOST === '1';
	const REQUIRE_NON_DEFAULT = process.env.CESVU_REQUIRE_NON_DEFAULT_HOST === '1';

	if (ACCEPT) return; // explicit opt-in — skip the check entirely.

	const defaultCount = entries.filter((e) => typeof e.baseUrl === 'string' && e.baseUrl.includes(DEFAULT_HOST)).length;
	if (defaultCount === 0) return; // no defaults — clean.

	const total = entries.length;
	const message =
		`⚠ ${defaultCount}/${total} ${total === 1 ? 'entry' : 'entries'} still point at ${DEFAULT_HOST}.\n` +
		`  This is the courtesy default. Self-host before deploying for real\n` +
		`  users — see MODELS.md → "Should you use the default ${DEFAULT_HOST} host?".\n` +
		`  Set CESVU_ACCEPT_DEFAULT_MODEL_HOST=1 to suppress this warning.\n` +
		`  Set CESVU_REQUIRE_NON_DEFAULT_HOST=1 to fail the build on this condition.`;

	if (REQUIRE_NON_DEFAULT) {
		console.error(`[models:build] ${message}`);
		process.exit(1);
	} else {
		console.warn(`[models:build] ${message}`);
	}
}

/**
 * Warn if any model entry's baseUrl is on a different origin than the
 * configured app origin — that requires CORS headers on the model bucket
 * or the browser will block the model fetch. Self-hosted forks set the
 * app origin via CESVU_APP_ORIGIN in CI; local dev is silent.
 *
 * Env vars:
 *   CESVU_APP_ORIGIN  e.g. https://app.example.com (omit for local dev)
 *
 * This is a warn-only check. The runtime CORS error (surfaced by the
 * looksLikeCorsError helper in src/lib/llm/inference.ts) is the real
 * gate. The build-time warning is just a heads-up to catch the
 * configuration mistake before users hit the runtime error.
 */
function checkCorsSetup(entries) {
	const APP_ORIGIN_ENV = process.env.CESVU_APP_ORIGIN;
	if (!APP_ORIGIN_ENV) return; // local dev: skip silently
	let appOrigin;
	try {
		appOrigin = new URL(APP_ORIGIN_ENV).origin;
	} catch {
		console.warn(`[models:build] CESVU_APP_ORIGIN is not a valid URL: ${APP_ORIGIN_ENV}. Skipping CORS check.`);
		return;
	}

	const crossOrigin = entries.filter((e) => {
		try {
			return new URL(e.baseUrl).origin !== appOrigin;
		} catch {
			return false; // unparseable baseUrl — already reported by the build
		}
	});

	if (crossOrigin.length === 0) return; // all same-origin — no CORS needed

	console.warn(
		`[models:build] ⚠ ${crossOrigin.length}/${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} are on a different origin than ${appOrigin}.`
	);
	console.warn(
		`              The model bucket MUST send CORS headers to allow ${appOrigin}, or the browser will block the model fetch.`
	);
	console.warn(
		`              See MODELS.md → "CORS" for the exact bucket config. The runtime will surface a clearer error if this is misconfigured.`
	);
}

async function modelsBuildCommand() {
	console.log(`[models:build] Reading R2 sidecar manifests from ${MANIFESTS_DIR}/…`);

	const out = {
		version: '1.0.0',
		updated_at: new Date().toISOString(),
		entries: []
	};

	// Group entries by `manifest` filename so we only read each snapshot file
	// once even when it covers multiple entries (SmolLM3's manifest covers 2,
	// OLMo-3's covers 3, classifier's covers 2).
	const byManifest = new Map();
	for (const e of CDN_ENTRIES) {
		if (!byManifest.has(e.manifest)) byManifest.set(e.manifest, []);
		byManifest.get(e.manifest).push(e);
	}

	for (const [manifestName, entries] of byManifest) {
		const manifestPath = join(MANIFESTS_DIR, manifestName);
		let snapshot;
		try {
			snapshot = JSON.parse(await readFile(manifestPath, 'utf8'));
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`✗ ${manifestPath}: ${msg}`);
			console.error(`  Run the upload pipeline (see scripts/r2-uploads/README.md) to produce this manifest.`);
			process.exit(1);
		}

		// Build a name → { sha256, size, contentType } lookup from the snapshot.
		// The snapshot format is { version, files: [{ name, sha256, size, contentType, ... }] }.
		const byFile = new Map();
		if (Array.isArray(snapshot.files)) {
			for (const f of snapshot.files) {
				if (f && typeof f.name === 'string') byFile.set(f.name, f);
			}
		} else {
			console.error(`✗ ${manifestPath}: missing 'files' array.`);
			process.exit(1);
		}

		for (const e of entries) {
			const f = byFile.get(e.file);
			// Accept null sha256 (= "pending upload; the upload pipeline hasn't populated this yet").
			// Reject anything else that's not a string (numbers, booleans, objects = malformed).
			if (!f || (f.sha256 !== null && typeof f.sha256 !== 'string')) {
				const got = f ? typeof f.sha256 : 'no entry';
				console.error(`✗ ${manifestPath}: 'sha256' must be a string or null for '${e.file}' (got ${got}).`);
				process.exit(1);
			}
			out.entries.push({
				kind: e.kind,
				id: e.id,
				baseUrl: e.baseUrl,
				file: e.file,
				sha256: f.sha256, // null = "not yet uploaded"; downstream code must handle.
				// lfs_oid is the Git LFS oid published by the source platform (HF).
				// Populated by sync-cdn after a successful LFS cross-check; null
				// on pre-LFS runs (the previous sync-cdn builds). Downstream code
				// may use it for runtime integrity verification (see inference.ts
				// for the proposed 30-line fetch-monkey-patch).
				lfs_oid: f.lfs_oid ?? null,
				size: typeof f.size === 'number' ? f.size : null,
				contentType: f.contentType ?? null,
				pinned_at: snapshot.pinned_at ?? null,
				source: snapshot.source ?? null
			});
			// Surface pending-upload entries prominently so a build with null
			// hashes is obvious in the log (better than silently shipping).
			const hashDisplay = f.sha256 ? `${f.sha256.slice(0, 12)}…` : '⟨pending upload⟩';
			const lfsDisplay = f.lfs_oid ? `lfs_oid=${f.lfs_oid.slice(0, 12)}…` : 'lfs_oid=⟨unset⟩';
			console.log(`  ✓ ${e.kind}/${e.id}: ${e.baseUrl}/${e.file}  sha256=${hashDisplay}  ${lfsDisplay}  size=${f.size ?? '?'}`);
		}
	}

	await writeFile(MODELS_MANIFEST_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
	console.log(`✓ Wrote ${MODELS_MANIFEST_PATH} (${out.entries.length} entries from ${byManifest.size} manifest snapshot(s)).`);

	// Warn (or fail) if the resulting manifest still uses the courtesy default
	// host. Self-hosted forks should swap to their own URLs; the default
	// ai.cesvu.com is fine for evaluation only. See MODELS.md.
	checkDefaultHost(out.entries);

	// Warn (silently) if any model URL is cross-origin to the app. The bucket
	// must send CORS headers, or the browser will block the model fetch at
	// runtime. Set CESVU_APP_ORIGIN in CI to opt into this check.
	checkCorsSetup(out.entries);
}

// ============================================================
// CLI dispatch
// ============================================================

const cmd = process.argv[2];
switch (cmd) {
	case 'freeze':
		await freezeCommand();
		break;
	case 'verify':
		await verifyCommand();
		break;
	case 'inject':
		await injectCommand();
		break;
	case 'sri:verify':
		await sriVerifyCommand();
		break;
	case 'models:build':
		await modelsBuildCommand();
		break;
	default:
		console.error('Usage: node scripts/freeze.mjs <freeze|verify|inject|sri:verify|models:build>');
		process.exit(2);
}
