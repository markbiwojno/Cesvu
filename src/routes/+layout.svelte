<script lang="ts">
	import '../app.css';
	import { ModeWatcher } from 'mode-watcher';
	import { browser } from '$app/environment';
	import { Buffer } from 'buffer';
	import { offlineReady } from '$lib/stores/offlineReady.svelte.js';

	// mammoth.js (DOCX parser) references the Node `Buffer` global at runtime.
	// The browser has no Buffer, so without this polyfill extractRawText() throws
	// ReferenceError and DOCX uploads silently fail (the document pane never
	// renders). We expose the bundled `buffer` polyfill on globalThis once, on the
	// client, before any file is parsed. (`global` itself is mapped to globalThis
	// via vite.config.ts `define`.) No CDN, no Node runtime — fully bundled.
	if (browser && typeof (globalThis as any).Buffer === 'undefined') {
		(globalThis as any).Buffer = Buffer;
	}

	// Manually register the service worker.
	//
	// Why manual? @vite-pwa/sveltekit's `injectRegister: 'auto'` relies on Vite's
	// transformIndexHtml hook to inject a <script src="/registerSW.js"> tag into
	// the built HTML. SvelteKit's static-adapter build never calls that hook, so
	// with 'auto' the registration script was emitted to dist/ but never
	// referenced anywhere — navigator.serviceWorker.register() was NEVER called,
	// no precache ever populated, and the app had zero real offline capability.
	//
	// We call navigator.serviceWorker.register() directly instead of going
	// through `virtual:pwa-register/svelte` (that virtual module pulls in
	// `workbox-window`, which Vite's SSR build tries to resolve in a Node/SSR
	// context and fails). Plain register() has no such bundling concerns and is
	// SSR-safe behind the `browser` guard (this never runs on the server).
	//
	// CRITICAL FIX: window.addEventListener('load', ...) is a RACE CONDITION.
	// If the `load` event has already fired by the time this module finishes
	// evaluating — which happens whenever the JS bundle parses/executes fast
	// relative to page load (fast local server, fast machine, cached bundle,
	// etc.) — attaching the listener AFTER the event already fired means it
	// NEVER runs. register() is then never called: no request for /sw.js ever
	// appears in the Network tab, no service worker shows up in DevTools, and
	// there is no error anywhere, because nothing ever throws — the code that
	// would register the SW simply never executes. This was confirmed to be
	// the actual root cause of "app never works offline unless a file was
	// opened online first": the SW was never registering AT ALL, so nothing
	// was ever being precached or runtime-cached in the first place, in any
	// browser, regardless of network speed. Checking document.readyState
	// first and registering immediately if the page has already finished
	// loading closes this race entirely.
	if (browser && 'serviceWorker' in navigator) {
		function registerServiceWorker() {
			navigator.serviceWorker
				.register('/sw.js', { scope: '/' })
				.then((registration) => {
					 
					console.log('[pwa] service worker registered:', registration);
					// Drives the header's "Preparing offline mode… / Ready to work
					// offline" indicator — see offlineReady.svelte.ts for the state
					// machine (waits for the worker to reach 'activated', which is
					// when Workbox's precache is guaranteed to be fully populated).
					offlineReady.trackRegistration(registration);
				})
				.catch((error) => {
					console.error('[pwa] service worker registration failed:', error);
					// Registration failed outright — fail open rather than leaving
					// the indicator stuck on "Preparing…" forever.
					offlineReady.markReady();
				});
		}

		if (document.readyState === 'complete') {
			registerServiceWorker();
		} else {
			window.addEventListener('load', registerServiceWorker);
		}
	} else if (browser) {
		// No service worker support in this browser — nothing to wait for.
		offlineReady.markReady();
	}


	let { children } = $props();



	// Prevent the browser's native "open dropped file" behavior. Without this,
	// dropping a file even slightly outside an explicit dropzone causes the
	// browser to navigate away to the file (looks like a page refresh and the
	// upload silently fails). The FileDropzone still handles drops landing on
	// it via stopPropagation; everything else is swallowed here.
	function preventWindowDrop(e: DragEvent) {
		// Only intercept actual file drags, not in-page text/element drags.
		if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
			e.preventDefault();
		}
	}
</script>

<svelte:window ondragover={preventWindowDrop} ondrop={preventWindowDrop} />

<!-- Light mode is the default; "system" respects an OS-level dark-mode
     preference (prefers-color-scheme) when no explicit choice has been
     made yet. Once a user toggles the header switch, mode-watcher persists
     that explicit choice to localStorage and it always wins on future
     visits — this default only applies to first-time visitors / cleared
     site data. -->
<ModeWatcher defaultMode="system" />
{@render children()}
