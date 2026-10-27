/**
 * static/vault-download-sw.js — a tiny, self-contained service worker whose
 * ONLY job is to turn a client-side ReadableStream of bytes into a real
 * browser download, streamed straight to the OS download manager.
 *
 * ─── Why this exists ───────────────────────────────────────────────────
 *
 * The vault decrypt/encrypt paths (src/lib/crypto/vault-io.ts) produce
 * output incrementally and can handle arbitrarily large files. On Chromium
 * we stream straight to disk via `showSaveFilePicker`. Firefox and Safari
 * don't have that API, so the previous fallback staged the whole output in
 * an OPFS scratch file and then triggered `<a download>` from a Blob URL
 * pointing at it.
 *
 * That fallback had an unfixable race: there is NO download-completion
 * event for a synthetic `<a download>` click, and the browser reads the
 * Blob lazily off disk as the download proceeds. Deleting the OPFS scratch
 * file when the function returned yanked the file out from under an
 * in-progress download, producing Firefox's:
 *
 *     "can't find the file at blob:http://…/<uuid>"
 *
 * on large files (small ones happened to finish first). Any timer-based
 * "wait a bit before deleting" is a guess that's simultaneously too short
 * for a multi-GB file on a slow disk and too long to be leaving decrypted
 * plaintext sitting on disk in a zero-knowledge app.
 *
 * ─── Why a service worker fixes it properly ────────────────────────────
 *
 * A service worker can answer a request with a `Response` whose body is a
 * ReadableStream. The browser treats that exactly like a streaming HTTP
 * download: paired with `Content-Disposition: attachment`, the OS download
 * manager takes over and consumes the stream at its own pace.
 *
 *   - No staging file. Plaintext exists only as in-flight chunks, so
 *     there's nothing to clean up and no race to lose.
 *   - `Content-Disposition: attachment` is an unambiguous "download this"
 *     instruction, so Firefox can't decide to open an inline preview tab
 *     (the other half of the bug above).
 *   - The stream's `pull`/`cancel` callbacks give us TRUE completion and
 *     cancellation signals instead of a timer.
 *
 * ─── Why a SECOND service worker ───────────────────────────────────────
 *
 * The app already has a Workbox-generated service worker at `/sw.js`
 * (scope `/`) built by @vite-pwa/sveltekit's `generateSW` strategy. With
 * `generateSW` the entire worker is authored by Workbox from
 * vite.config.ts, so there is no source file of ours to add a `fetch`
 * handler to. Adding one would require migrating to `injectManifest` and
 * hand-reimplementing the precache manifest, all three runtimeCaching
 * rules, navigateFallback, the denylist, skipWaiting/clientsClaim, etc. —
 * and vite.config.ts documents several painfully-debugged offline bugs
 * (the `injectRegister: 'auto'` silent failure, `navigateFallback: '/'`
 * precache miss, the `/_app/immutable/` lazy-chunk gap) that such a
 * rewrite could easily reintroduce.
 *
 * Multiple service workers can coexist on one origin as long as their
 * scopes differ, and the MOST SPECIFIC scope wins for a given URL. So this
 * worker registers at scope `/vault-download/` and handles only URLs under
 * that prefix; `/sw.js` keeps serving everything else, completely
 * untouched. (vite.config.ts's `navigateFallbackDenylist` also excludes
 * `/vault-download/` so the Workbox navigation fallback can never shadow a
 * download URL.)
 *
 * ─── Why the URL looks like a file path ────────────────────────────────
 *
 * Download URLs are `/vault-download/<id>/<filename>` rather than the
 * shorter `/_vault-dl/<id>`. Two reasons, both learned the hard way:
 *
 *   - A leading-underscore path segment ending in a bare UUID is a common
 *     malware/C2 URL signature, and at least one enterprise URL filter
 *     (Firefox's `WebsiteFilter` policy) blocked it outright, replacing the
 *     download with a "Your organization has blocked access to this page"
 *     block page. Ending the path in an ordinary-looking filename is far
 *     less likely to trip generic heuristics.
 *   - If `Content-Disposition` is ever stripped or mangled in transit, the
 *     browser falls back to the URL's last path segment for the filename.
 *     With the old scheme that meant saving a file named after a UUID with
 *     no extension; now the fallback is already the correct name.
 *
 * The `<filename>` segment is cosmetic — the id alone identifies the
 * handoff, and the authoritative name comes from the header — so a
 * mismatched or missing trailing segment is harmless.
 *
 * This file is deliberately plain JS in `static/` rather than TypeScript

 * in `src/`: it must be served at a stable, predictable URL (not a hashed
 * bundle name) so `register()` can find it, and keeping it dependency-free
 * means it can't be affected by the app's bundling. It's also why this
 * works in `vite dev`, where the PWA plugin's own SW is disabled
 * (`devOptions.enabled: false`).
 *
 * ─── Protocol ──────────────────────────────────────────────────────────
 *
 * 1. Client generates a random id and postMessages this worker:
 *      { type: 'CESVU_DL_INIT', id, filename, size? }  + [MessagePort]
 *    A MessagePort is used (rather than transferring a ReadableStream)
 *    because transferable streams aren't supported in Firefox/Safari.
 * 2. Client navigates a hidden iframe to `/vault-download/<id>/<filename>`.
 * 3. This worker's fetch handler matches the id, immediately posts
 *    { type: 'fetched' } so the client knows the navigation actually
 *    reached us (see step 3a), and replies with a streaming Response
 *    carrying Content-Disposition: attachment.
 * 3a. That 'fetched' ack matters: the INIT/'ready' handshake in steps 1-2
 *    travels over a MessagePort and succeeds even if the iframe navigation
 *    is then blocked by a URL filter, blocking extension, or proxy. Without
 *    a signal that the FETCH specifically happened, the client would sit
 *    forever waiting for a 'pull' that can never come. The client treats a
 *    missing 'fetched' as "this tier is unusable" and falls back.
 * 4. The worker asks for data one chunk at a time by posting

 *    { type: 'pull' } through the port; the client replies with
 *    { type: 'chunk', chunk } / { type: 'close' } / { type: 'abort' }.
 *    Requesting each chunk only when the stream is ready for it applies
 *    real backpressure, so at most one chunk is buffered here regardless
 *    of file size — the download's speed, not ours, sets the pace.
 */

/// <reference lib="webworker" />

// Pending handoffs, keyed by download id: the metadata + MessagePort we
// received in step 1, waiting for the matching fetch in step 3.
const pending = new Map();

// A service worker can be terminated when idle and respawned on the next
// event, which would silently drop `pending` (it's in-memory only). The
// window between the INIT message and the iframe's fetch is a few
// milliseconds in practice, but if a handoff is never claimed we drop it
// rather than leak the entry (and its port) forever.
const HANDOFF_TTL_MS = 60_000;

/** URL prefix this worker owns. Must stay in sync with `SW_SCOPE` in
 *  src/lib/stores/vault-download-stream.ts and the `navigateFallbackDenylist`
 *  entry in vite.config.ts. */
const DL_PREFIX = '/vault-download/';


self.addEventListener('install', () => {
	// Take over immediately; there's no cache to warm and nothing to
	// migrate, so waiting for existing clients to close serves no purpose.
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	// Claim in-scope clients right away so a download triggered on the very
	// first page load doesn't have to wait for a reload to be intercepted.
	event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
	const data = event.data;
	if (!data || typeof data !== 'object') return;

	// Readiness probe — lets the client confirm this worker is alive and
	// actually receiving messages before it commits to the download path.
	if (data.type === 'CESVU_DL_PING') {
		const reply = event.ports && event.ports[0];
		if (reply) reply.postMessage({ type: 'CESVU_DL_PONG' });
		return;
	}

	if (data.type !== 'CESVU_DL_INIT') return;

	const port = event.ports && event.ports[0];
	if (!port || typeof data.id !== 'string') return;

	const entry = {
		filename: typeof data.filename === 'string' ? data.filename : 'download',
		// Optional total byte count. When present the download UI can show a
		// real progress bar / ETA instead of an indeterminate spinner; when
		// absent (unknown output length) we simply omit Content-Length.
		size: Number.isFinite(data.size) && data.size >= 0 ? data.size : null,
		port,
		timer: setTimeout(() => {
			// Never claimed — drop it and tell the client so it can fall back
			// rather than hanging forever waiting for a 'pull'.
			pending.delete(data.id);
			try {
				port.postMessage({ type: 'expired' });
				port.close();
			} catch {
				/* port may already be gone */
			}
		}, HANDOFF_TTL_MS)
	};

	pending.set(data.id, entry);

	// Acknowledge, so the client only navigates the iframe once it KNOWS the
	// handoff is registered. Without this the fetch could arrive first and
	// find nothing (see the 503 path in the fetch handler).
	try {
		port.postMessage({ type: 'ready' });
	} catch {
		/* best-effort */
	}
});

/**
 * Encode a filename for Content-Disposition. Emits both a sanitized
 * plain `filename=` (for legacy parsers) and RFC 5987 `filename*=UTF-8''`
 * (which every current browser prefers), so non-ASCII names — and the
 * emoji-heavy names this app can produce — survive intact.
 *
 * Quotes, backslashes and control characters are stripped from the plain
 * form because they'd otherwise break out of the quoted-string and let a
 * crafted filename inject extra header parameters.
 */
function contentDisposition(filename) {
	/* eslint-disable-next-line no-control-regex */
	const plain = filename.replace(/[\r\n"\\\x00-\x1f\x7f]/g, '_');
	const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
		'%' + c.charCodeAt(0).toString(16).toUpperCase()
	);
	return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);

	// Only ever touch our own download URLs. Anything else in scope is left
	// entirely alone (falls through to the network / the other worker).
	if (url.origin !== self.location.origin) return;
	if (!url.pathname.startsWith(DL_PREFIX)) return;

	// Path is `<prefix><id>/<filename>` — the id is the FIRST segment after
	// the prefix. The trailing filename segment is cosmetic (see the header
	// comment), so it's ignored here; slicing to the next '/' rather than
	// taking the whole remainder is what keeps it from corrupting the id.
	const rest = url.pathname.slice(DL_PREFIX.length);
	const slash = rest.indexOf('/');
	const id = slash === -1 ? rest : rest.slice(0, slash);
	const entry = pending.get(id);


	if (!entry) {
		// No matching handoff: either this worker was terminated and
		// respawned between the INIT message and this fetch (losing the
		// in-memory map), the TTL expired, or someone hit the URL directly.
		// Answer definitively instead of falling through to the network,
		// which would 404 into the SPA fallback and render the app shell
		// inside the hidden iframe.
		event.respondWith(
			new Response('Download handoff not found or already consumed.', {
				status: 503,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' }
			})
		);
		return;
	}

	// Claim it — each handoff is single-use, so a retried/duplicated request
	// can't attach a second reader to the same port.
	pending.delete(id);
	clearTimeout(entry.timer);

	const port = entry.port;

	// Tell the client the navigation actually reached us. This is the ONLY
	// signal that distinguishes "the download is under way" from "the iframe
	// navigation was silently blocked by a filter/extension/proxy" — the
	// earlier 'ready' ack only proves the MessagePort works, which it does
	// even when the navigation never happens. Posted before the Response is
	// constructed so it can't be delayed behind the first `pull`.
	try {
		port.postMessage({ type: 'fetched' });
	} catch {
		/* best-effort */
	}

	const stream = new ReadableStream({

		start(controller) {
			// `pull` is only invoked once the previous pull's promise has
			// settled, so resolving `pullResolve` on each incoming chunk is
			// what paces the client. Terminal states (close/abort) resolve
			// any outstanding pull too, otherwise the stream would hang.
			let pullResolve = null;

			this._requestChunk = () =>
				new Promise((resolve) => {
					pullResolve = resolve;
					try {
						port.postMessage({ type: 'pull' });
					} catch (err) {
						// Client realm went away (tab closed mid-download).
						controller.error(err);
						resolve();
					}
				});

			port.onmessage = (e) => {
				const msg = e.data;
				if (!msg || typeof msg !== 'object') return;

				if (msg.type === 'chunk') {
					try {
						controller.enqueue(
							msg.chunk instanceof Uint8Array ? msg.chunk : new Uint8Array(msg.chunk)
						);
					} catch (err) {
						// Stream already closed/errored (e.g. user cancelled
						// the download) — nothing to do but stop pulling.
						try {
							port.postMessage({ type: 'cancel' });
						} catch {
							/* best-effort */
						}
						void err;
					}
					if (pullResolve) {
						const r = pullResolve;
						pullResolve = null;
						r();
					}
					return;
				}

				if (msg.type === 'close') {
					try {
						controller.close();
					} catch {
						/* already closed */
					}
					if (pullResolve) {
						const r = pullResolve;
						pullResolve = null;
						r();
					}
					try {
						port.close();
					} catch {
						/* best-effort */
					}
					return;
				}

				if (msg.type === 'abort') {
					const err = new Error(msg.reason || 'Download aborted by the page.');
					try {
						controller.error(err);
					} catch {
						/* already errored */
					}
					if (pullResolve) {
						const r = pullResolve;
						pullResolve = null;
						r();
					}
					try {
						port.close();
					} catch {
						/* best-effort */
					}
				}
			};
		},

		pull() {
			// One chunk in flight at a time — this IS the backpressure.
			return this._requestChunk();
		},

		cancel(reason) {
			// The user cancelled the download (or the browser tore it down).
			// Tell the page so it can stop decrypting instead of pumping
			// chunks into a stream nobody is reading.
			try {
				port.postMessage({ type: 'cancel', reason: String(reason || '') });
				port.close();
			} catch {
				/* best-effort */
			}
		}
	});

	const headers = new Headers({
		'Content-Type': 'application/octet-stream',
		'Content-Disposition': contentDisposition(entry.filename),
		// This response is generated per-download and must never be reused.
		'Cache-Control': 'no-store, no-cache, must-revalidate',
		// Defensive: stop any sniffing from reinterpreting the bytes as
		// something renderable, which is what we're trying to avoid.
		'X-Content-Type-Options': 'nosniff'
	});
	if (entry.size !== null) {
		headers.set('Content-Length', String(entry.size));
	}

	event.respondWith(new Response(stream, { status: 200, headers }));
});
