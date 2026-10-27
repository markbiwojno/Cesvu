/// <reference types="vitest/config" />
import { sveltekit } from '@sveltejs/kit/vite';

import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));


/**
 * Inline Vite plugin: add COOP + COEP headers via server middleware.
 *
 * Why not use server.headers?
 *   server.headers applies to ALL responses including JS modules served via @fs/.
 *   COEP on JS modules causes the browser to block Vite's dynamic imports from
 *   node_modules (they lack Cross-Origin-Resource-Policy headers), breaking HMR.
 *
 * Why does middleware work?
 *   The middleware runs before Vite's module transform pipeline. We set the headers
 *   on the Node.js ServerResponse object. Vite's transform pipeline may overwrite
 *   Content-Type but does NOT strip custom headers — so COOP/COEP survive on all
 *   responses including HTML, JS modules, and WASM files.
 *
 *   COEP: credentialless (not require-corp) is the key:
 *   - Allows cross-origin resources that don't set CORP (e.g. Vite @fs/ modules
 *     during dev). Note: model weights live on first-party ai.cesvu.com
 *     (see scripts/r2-uploads/), but ORT WASM blobs are now bundled in
 *     /static/ (no runtime fetch), so this escape hatch is mainly for Vite's
 *     dev-time @fs/ fetches which still lack CORP.
 *   - Only blocks credentialed cross-origin requests (cookies/auth headers)
 *   - Sufficient for crossOriginIsolated = true → SharedArrayBuffer → WebGPU
 *
 * Result: crossOriginIsolated = true in the browser → WebGPU works in dev.
 */
function crossOriginIsolationPlugin(): Plugin {
	return {
		name: 'cross-origin-isolation',
		configureServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
				res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
				res.setHeader('Service-Worker-Allowed', '/');
				next();
			});
		},
		configurePreviewServer(server) {
			server.middlewares.use((_req, res, next) => {
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
				res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
				res.setHeader('Service-Worker-Allowed', '/');
				next();
			});
		}
	};
}

// Post-build plugin: strips the dead 22MB ONNX WASM fallback asset that is
// never reachable at runtime because wasmPaths is always set before model load.
// Reduces deploy size by ~22MB with zero runtime impact.
function stripDeadWasmPlugin(): Plugin {
	return {
		name: 'strip-dead-wasm',
		apply: 'build',
		closeBundle() {
			import('node:fs').then(({ readdirSync, rmSync }) => {
				import('node:path').then(({ join }) => {
					const assetsDir = 'dist/_app/immutable/assets';
					try {
						const files = readdirSync(assetsDir);
						const deadWasm = files.find(f =>
							f.match(/^ort-wasm-simd-threaded\.asyncify\.[^.]+\.wasm$/)
						);
						if (deadWasm) {
							rmSync(join(assetsDir, deadWasm));
							console.log(`[strip-dead-wasm] Removed dead asset: ${deadWasm} (~22MB saved)`);
						}
					} catch {
						// assets dir may not exist in all build modes — safe to ignore
					}
				});
			});
		}
	};
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit(),
		crossOriginIsolationPlugin(),
		stripDeadWasmPlugin(),
		// PWA / offline support.

		//
		// Goal: a cold load with no network must still boot the app. The service
		// worker precaches the entire static app shell (HTML/JS/CSS/wasm) at install
		// time, so a fresh refresh offline is served from the Cache API instead of
		// hitting the network and failing. Everything that already runs client-side
		// (parsing, encryption, local inference once the model is cached) keeps
		// working with WiFi disabled.
		//
		// registerType 'autoUpdate': when a new build is deployed, the new SW takes
		// over automatically on next load — no "click to update" prompt needed.
		SvelteKitPWA({
			filename: 'sw.js',
			registerType: 'autoUpdate',
			// @sveltejs/adapter-static's build never calls Vite's transformIndexHtml
			// hook, so injectRegister: 'auto' silently fails to inject the
			// registration script into the built HTML — navigator.serviceWorker
			// .register() is then NEVER called, no precache ever populates, and the
			// app has zero real offline capability. We register the SW manually in
			// +layout.svelte instead (see the registerServiceWorker block there).
			injectRegister: false,

			manifest: {
				name: 'Cesvu',
				short_name: 'Cesvu',
				description: 'Private, zero-knowledge document analysis',
				theme_color: '#0f172a',
				background_color: '#0f172a',
				display: 'standalone',
				start_url: '/',
				// Use the existing logo asset so the manifest ships no broken icon
				// references. Swap in dedicated 192/512 PNGs when branding art is ready.
				icons: [
					{
						src: '/second_logo.jpeg',
						sizes: '512x512',
						type: 'image/jpeg'
					}
				]
			},
			workbox: {
				// Precache the full static shell. Includes:
				//   - App HTML/JS/CSS bundles
				//   - /static/* assets (logos, eff_word_list.txt)
				//   - /static/ort-wasm-simd-threaded.{jsep,regular,asyncify}.{mjs,wasm}
				//     (all 4 ORT WASM variants — Chrome/Safari/Firefox + loaders)
				//   - /static/models.json (pinned CDN entries manifest)
				// ONNX model weights are NOT in the bundle (they live on ai.cesvu.com)
				// so they are handled by runtimeCaching below, not precache.
				globPatterns: ['**/*.{js,mjs,css,html,ico,png,svg,woff2,wasm,json,txt}'],
				// onnxruntime-web wasm blobs and some vendor chunks exceed the 2 MiB
				// default; raise the ceiling so the shell precaches fully.
				maximumFileSizeToCacheInBytes: 150 * 1024 * 1024,

				skipWaiting: true,
				clientsClaim: true,

				// Exclude the dead ONNX WASM fallback from precache entirely.
				// wasmPaths is always set before model load so this file is
				// never fetched at runtime — no point caching 22MB of dead weight.
				globIgnores: ['**/ort-wasm-simd-threaded.asyncify.*.wasm'],


				// navigateFallback points at index.html (not bare '/') so Workbox
				// can find it in the precache manifest and bind the NavigationRoute
				// to a URL that actually exists. Using bare '/' here was the actual
				// root cause of "app fails to load offline unless a file was opened
				// online first" — Workbox's NavigationRoute was bound to a URL with
				// no matching precache entry, so the fallback silently failed.
				navigateFallback: '/index.html',
				navigateFallbackDenylist: [
					/^\/api\//,
					/^\/sw\.js$/,
					/^\/workbox-.*\.js$/
				],


				// Explicit manifest entries for shell URLs that glob may miss.
				// revision: null is correct for hashed/immutable URLs;
				// index.html gets a real hash so the SW knows when to re-cache it.
				additionalManifestEntries: [
					{ url: '/index.html', revision: Date.now().toString() },
					{ url: '/', revision: null },
				],

				runtimeCaching: [

					{
						// First-party ONNX model files. Large and immutable — cache
						// aggressively so the second analysis (and offline) is instant.
						urlPattern: ({ url }: { url: URL }) => url.hostname === 'ai.cesvu.com',
						handler: 'CacheFirst',
						options: {
							cacheName: 'cesvu-models',
							expiration: {
								maxEntries: 32,
								maxAgeSeconds: 60 * 60 * 24 * 30 // 30 days
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					},
					{
						// Sharing / annotation API. Try the network first so live data
						// wins when online, fall back to cache when offline.
						urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/api/'),
						handler: 'NetworkFirst',
						options: {
							cacheName: 'cesvu-api',
							networkTimeoutSeconds: 5,
							expiration: {
								maxEntries: 64,
								maxAgeSeconds: 60 * 60 * 24 // 1 day
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					},
					{
						// SAFETY NET for lazy-loaded / dynamically-imported chunks
						// (e.g. the xlsx worker + its "xlsx" library chunk, the pdfjs
						// worker, mammoth, transformers.js, etc.). These are only
						// requested the first time a user opens a matching file type,
						// via `new Worker(new URL(...))` or `await import(...)` deep in
						// a worker. Even though globPatterns precaches every built JS
						// file at install time, a module worker's OWN internal dynamic
						// import()s don't always go through the same fetch-interception
						// path as top-level page requests, and any transient failure
						// during install-time precache leaves a single chunk uncached
						// with no fallback. THIS was the actual bug behind "works
						// offline only if the file type was already opened once while
						// online" — that first online load happened to warm this exact
						// gap (via normal HTTP cache), while a browser that never
						// fetched the chunk had nothing to fall back on.
						//
						// CacheFirst here means: once ANY request for a hashed
						// /_app/immutable/ asset succeeds (even the very first time,
						// while online), it's cached forever and every subsequent
						// request — online or offline — is served from the Cache API
						// without hitting the network again.
						urlPattern: ({ url }: { url: URL }) => url.pathname.startsWith('/_app/immutable/'),
						handler: 'CacheFirst',
						options: {
							cacheName: 'cesvu-app-shell',
							expiration: {
								maxEntries: 200,
								maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year — hashed filenames are immutable
							},
							cacheableResponse: {
								statuses: [0, 200]
							}
						}
					}
				]
			},
			devOptions: {

				// Keep the SW off in `vite dev` (it interferes with HMR). It is built
				// and active in `vite build` / `vite preview` and production.
				enabled: false
			}
		})
	],
	// mammoth.js (DOCX parser) is a Node-oriented library that references the
	// `global` object and the `Buffer` constructor at runtime. In the browser
	// neither exists, so extractRawText() throws ReferenceError and DOCX upload
	// silently fails. We map `global` → `globalThis` at build time and pre-bundle
	// the `buffer` polyfill; the actual `globalThis.Buffer` assignment happens in
	// +layout.svelte before any parser runs. No CDN, no Node runtime — all bundled.
	define: {
		global: 'globalThis'
	},
	optimizeDeps: {
		include: ['buffer', 'globalthis'],

		exclude: ['@huggingface/transformers']
	},


	worker: {
		format: 'es'
	},

	// Vitest runs tests in forked worker processes (default 'forks' pool).
	// `NODE_OPTIONS=--max-old-space-size=...` set on the parent shell only
	// applies to the parent vitest process — it is NOT inherited by the
	// forked test workers. Several large-payload round-trip test files
	// running in one worker can exceed Node's default old-space limit
	// there, crashing with "FATAL ERROR: Reached heap limit Allocation
	// failed - JavaScript heap out of memory" even though every individual
	// test passes. In Vitest 4, `execArgv` moved from
	// `test.poolOptions.forks.execArgv` to this
	// top-level `test.execArgv` (test.poolOptions was removed entirely —
	// see https://vitest.dev/guide/migration#pool-rework). It's passed
	// directly to each forked/threaded worker process.
	test: {
		execArgv: ['--max-old-space-size=8192'],
		// /dicom holds archived DICOM-only code (moved out of src/lib — see
		// dicom/README.md) that is no longer wired into the app. Its test file
		// still imports relative to its OLD location inside src/lib/stores, so
		// leaving it in Vitest's default discovery glob makes the whole suite
		// fail with a broken-import error. Exclude the directory outright
		// rather than fix up imports for code that isn't shipped anymore.
		exclude: ['**/node_modules/**', '**/dist/**', 'dicom/**']
	}

});



