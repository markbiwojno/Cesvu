// SPDX-License-Identifier: Apache-2.0

/**
 * src/lib/stores/vault-download-stream.ts — client half of the streaming
 * download path implemented by `static/vault-download-sw.js`.
 *
 * Hands an incrementally-produced byte stream to the browser's real
 * download manager, with no staging file anywhere. See the long header
 * comment in `static/vault-download-sw.js` for the full rationale (short
 * version: the previous OPFS-scratch-file + Blob-URL fallback had an
 * unwinnable race between deleting the scratch file and the browser
 * lazily reading it, which surfaced in Firefox as
 * "can't find the file at blob:…" on large files).
 *
 * Usage:
 *
 *   const dl = await beginStreamingDownload('archive.zip');
 *   try {
 *       for await (const chunk of chunks) await dl.write(chunk);
 *       await dl.close();
 *   } catch (err) {
 *       dl.abort(String(err));
 *       throw err;
 *   }
 *
 * `write()` resolves only when the service worker asks for the next chunk,
 * so awaiting it gives real backpressure: production is paced by how fast
 * the download is actually being consumed, and memory stays O(one chunk)
 * no matter how large the file is.
 */

import { browser } from '$app/environment';

/** Path of the download worker script (served verbatim from `static/`). */
const SW_URL = '/vault-download-sw.js';

/**
 * Scope for the download worker. Deliberately a narrow, app-internal
 * prefix so it can coexist with the Workbox worker at scope `/` — the most
 * specific registration wins for URLs underneath it. Must stay in sync
 * with `DL_PREFIX` in `static/vault-download-sw.js` and with the
 * `navigateFallbackDenylist` entry in `vite.config.ts`.
 *
 * Was `/_vault-dl/`; renamed because a leading-underscore path ending in a
 * bare UUID reads like a malware/C2 URL to generic URL filters, and an
 * enterprise Firefox `WebsiteFilter` policy blocked it outright (the
 * download was replaced by a "Your organization has blocked access to this
 * page" block page). See the header comment in the worker for the full
 * story.
 */
const SW_SCOPE = '/vault-download/';


/**
 * True on any iOS device, in ANY browser — Safari, Chrome-for-iOS,
 * Firefox-for-iOS, etc. all use WebKit under the hood on iOS (Apple
 * requires it), so "which browser" doesn't matter here, only "which OS".
 *
 * Checks both the classic iPhone/iPod/iPad user-agent substrings AND the
 * iPadOS 13+ "desktop-class" UA (which reports as `Macintosh` and is
 * indistinguishable from a real Mac by user agent alone) via the
 * touch-points heuristic: a real Mac reports `maxTouchPoints === 0`,
 * while an iPad always reports > 0 even with `navigator.platform`
 * masquerading as `MacIntel`.
 */
function isIOS(): boolean {
	if (typeof navigator === 'undefined') return false;
	const ua = navigator.userAgent || '';
	if (/iPad|iPhone|iPod/.test(ua)) return true;
	// iPadOS 13+ desktop-mode UA disguise.
	return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** How long to wait for the worker to register + activate before giving up
 *  and letting the caller fall back to another download strategy. */
const ACTIVATION_TIMEOUT_MS = 10_000;

/** How long to wait for the worker to acknowledge the handoff (its 'ready'
 *  reply) before treating the SW path as unusable. */
const HANDOFF_ACK_TIMEOUT_MS = 5_000;

/**
 * How long to wait, after pointing the iframe at the download URL, for the
 * worker to confirm it actually received that request (its 'fetched'
 * reply).
 *
 * This is the guard against the download URL being blocked before it ever
 * reaches the worker — by an enterprise URL policy, a blocking extension,
 * or an intercepting proxy. The 'ready' handshake above can't detect that:
 * it travels over a MessagePort, which keeps working perfectly while the
 * navigation itself is being refused. Without this check the caller would
 * park forever on the first `write()` waiting for a 'pull' that can never
 * arrive.
 *
 * Generous relative to what it measures (a same-origin request answered
 * from memory by an already-active worker, normally single-digit
 * milliseconds) because the cost of being wrong is asymmetric: timing out
 * early just means falling back to a slower-but-working download tier,
 * while timing out on a working setup would skip a tier we'd rather use.
 */
const FETCH_ACK_TIMEOUT_MS = 4_000;


/** Thrown by `write()`/`close()` when the download was cancelled from the
 *  browser side (user hit cancel in the download manager, or the worker's
 *  handoff expired). Callers should treat this as a user-initiated stop. */
export class DownloadCancelledError extends Error {
	constructor(reason?: string) {
		super(reason ? `The download was cancelled: ${reason}` : 'The download was cancelled.');
		this.name = 'DownloadCancelledError';
	}
}

/** A live streaming download. */
export interface StreamingDownload {
	/** Queue one chunk. Resolves when the worker is ready for the next one
	 *  (backpressure). Rejects with {@link DownloadCancelledError} if the
	 *  download was cancelled browser-side. */
	write: (chunk: Uint8Array) => Promise<void>;
	/** Signal end-of-stream; the download completes. */
	close: () => Promise<void>;
	/** Abandon the download and error the response stream. Safe to call
	 *  after `close()` (no-op) and safe to call twice. */
	abort: (reason?: string) => void;
}

/**
 * True when this browser can support the service-worker streaming download
 * path at all.
 *
 * `isSecureContext` matters because service workers are unavailable on
 * plain-HTTP origins — the API is simply absent, so registration would
 * throw. `localhost` counts as secure, so dev and preview are fine.
 */
export function streamingDownloadAvailable(): boolean {
	return (
		browser &&
		typeof navigator !== 'undefined' &&
		'serviceWorker' in navigator &&
		typeof window !== 'undefined' &&
		window.isSecureContext === true &&
		typeof ReadableStream === 'function' &&
		typeof MessageChannel === 'function' &&
		// iOS WebKit does not reliably complete downloads triggered by
		// hidden-iframe navigation, especially for a streamed response
		// with no declared Content-Length (which this path always sends
		// — see this function's doc comment above). The handshake with
		// the service worker (ready/fetched/pull) all succeeds, so the
		// caller believes the download is progressing, but the bytes
		// never reach iOS's Downloads UI: export/import appears to hang
		// on "downloading" forever. This affects EVERY browser on iOS
		// (Safari, Chrome, Firefox — all WebKit there), so excluding by
		// OS rather than by browser is correct. Skipping this tier here
		// falls straight through to Tier 3 (OPFS scratch file + a real
		// `<a download>` click, in vault-io.ts), which does not depend
		// on iframe navigation and works correctly on iOS.
		!isIOS()
	);
}

/** Cached registration promise — registering is idempotent, but we only
 *  want one in-flight attempt no matter how many downloads start. */
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/** Resolve once `registration.active` is non-null, or null on timeout. */
function waitForActive(
	registration: ServiceWorkerRegistration
): Promise<ServiceWorker | null> {
	if (registration.active) return Promise.resolve(registration.active);

	return new Promise((resolve) => {
		const worker = registration.installing || registration.waiting;
		let settled = false;
		const finish = (value: ServiceWorker | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker?.removeEventListener('statechange', onStateChange);
			resolve(value);
		};

		const timer = setTimeout(() => finish(null), ACTIVATION_TIMEOUT_MS);

		function onStateChange() {
			if (registration.active) finish(registration.active);
		}

		if (!worker) {
			// Nothing installing/waiting and nothing active — nothing to wait
			// for. Bail immediately rather than sit on the timeout.
			finish(registration.active ?? null);
			return;
		}
		worker.addEventListener('statechange', onStateChange);
	});
}

/**
 * Register (once) and activate the download worker. Returns null if the
 * browser can't support it or activation times out, so callers can fall
 * back rather than fail.
 *
 * Registration is lazy — deferred until the first download rather than done
 * at app startup — so a user who never exports/imports a vault file never
 * pays for a second service worker registration.
 */
async function ensureDownloadWorker(): Promise<ServiceWorker | null> {
	if (!streamingDownloadAvailable()) return null;

	if (!registrationPromise) {
		registrationPromise = navigator.serviceWorker
			.register(SW_URL, { scope: SW_SCOPE })
			.catch((err) => {
				console.warn('[vault-dl] download worker registration failed:', err);
				// Reset so a later attempt can retry (e.g. transient failure).
				registrationPromise = null;
				return null;
			});
	}

	const registration = await registrationPromise;
	if (!registration) return null;

	return waitForActive(registration);
}

/**
 * Begin a streaming download of `filename`.
 *
 * Returns null when the service-worker path isn't usable in this browser —
 * the caller should then fall back to another strategy rather than treat it
 * as an error.
 *
 * NOTE on size: we deliberately don't send a byte count, so no
 * `Content-Length` is set and the download UI shows an indeterminate size.
 * That's intentional — neither the encrypt nor the decrypt path knows its
 * exact OUTPUT length up front (only the input's), and an inaccurate
 * Content-Length would truncate or stall the download, which is far worse
 * than a missing progress estimate. The in-app progress bar already
 * reports true progress against the input size.
 */
export async function beginStreamingDownload(
	filename: string
): Promise<StreamingDownload | null> {
	const worker = await ensureDownloadWorker();
	if (!worker) return null;

	const id =
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(36).slice(2)}`;

	const channel = new MessageChannel();
	const port = channel.port1;

	// ── Handoff / backpressure state ──
	let ready = false;
	let readyResolve: (() => void) | null = null;
	let readyReject: ((err: Error) => void) | null = null;
	const readyPromise = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});

	// 'pull' messages can arrive before the caller calls write(), so count
	// outstanding requests rather than requiring a waiter to already be
	// parked. `pullWaiter` is set only when write() is waiting for a pull
	// that hasn't arrived yet.
	let pullCredits = 0;
	let pullWaiter: (() => void) | null = null;

	// Set when the worker confirms the download navigation actually reached
	// its fetch handler. See FETCH_ACK_TIMEOUT_MS.
	let fetchedResolve: (() => void) | null = null;
	let fetchedReject: ((err: Error) => void) | null = null;
	const fetchedPromise = new Promise<void>((resolve, reject) => {
		fetchedResolve = resolve;
		fetchedReject = reject;
	});
	// The 'fetched' message can in principle arrive before we even finish
	// attaching the iframe, so record it as a flag rather than relying on a
	// waiter being parked already.
	let fetched = false;

	let cancelled: DownloadCancelledError | null = null;
	let finished = false;

	function rejectAllWaiters(err: DownloadCancelledError) {
		cancelled = err;
		if (readyReject) {
			const r = readyReject;
			readyReject = null;
			readyResolve = null;
			r(err);
		}
		if (fetchedReject) {
			const r = fetchedReject;
			fetchedReject = null;
			fetchedResolve = null;
			r(err);
		}

		// Wake any parked write() — it re-checks `cancelled` and throws.
		if (pullWaiter) {
			const w = pullWaiter;
			pullWaiter = null;
			w();
		}
	}

	port.onmessage = (event: MessageEvent) => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object') return;

		if (msg.type === 'ready') {
			ready = true;
			if (readyResolve) {
				const r = readyResolve;
				readyResolve = null;
				readyReject = null;
				r();
			}
			return;
		}

		if (msg.type === 'fetched') {
			fetched = true;
			if (fetchedResolve) {
				const r = fetchedResolve;
				fetchedResolve = null;
				fetchedReject = null;
				r();
			}
			return;
		}

		if (msg.type === 'pull') {
			// A 'pull' implies the fetch happened, even if the explicit
			// 'fetched' message is somehow still in flight behind it.
			if (!fetched && fetchedResolve) {
				fetched = true;
				const r = fetchedResolve;
				fetchedResolve = null;
				fetchedReject = null;
				r();
			}
			pullCredits++;

			if (pullWaiter) {
				const w = pullWaiter;
				pullWaiter = null;
				w();
			}
			return;
		}

		if (msg.type === 'cancel' || msg.type === 'expired') {
			rejectAllWaiters(
				new DownloadCancelledError(
					msg.type === 'expired' ? 'the download handoff expired' : msg.reason
				)
			);
		}
	};
	port.start?.();

	// Register the handoff, then wait for the worker to confirm it before
	// navigating the iframe — otherwise the iframe's fetch could reach the
	// worker before the handoff exists and get the 503 "not found" path.
	worker.postMessage({ type: 'CESVU_DL_INIT', id, filename }, [channel.port2]);

	const ackTimer = setTimeout(() => {
		if (!ready && readyReject) {
			const r = readyReject;
			readyReject = null;
			readyResolve = null;
			r(new Error('The download worker did not acknowledge the request in time.'));
		}
	}, HANDOFF_ACK_TIMEOUT_MS);

	try {
		await readyPromise;
	} catch (err) {
		clearTimeout(ackTimer);
		try {
			port.close();
		} catch {
			/* best-effort */
		}
		// Treat a failed handoff as "SW path unusable" so the caller falls
		// back, EXCEPT for an explicit cancel (which is a real user action
		// and shouldn't silently retry down another path).
		if (err instanceof DownloadCancelledError) throw err;
		console.warn('[vault-dl] handoff not acknowledged, falling back:', err);
		return null;
	}
	clearTimeout(ackTimer);

	// Trigger the download via a hidden iframe rather than assigning to
	// `window.location`. A top-level navigation to a Content-Disposition
	// response is usually cancelled-and-downloaded cleanly, but in some
	// browsers it can still flash/unload the page (and any beforeunload
	// handler); an iframe keeps it entirely out of the top-level session
	// history and can't disturb the current page.
	const iframe = document.createElement('iframe');
	iframe.hidden = true;
	iframe.style.display = 'none';
	// Trailing filename segment: cosmetic for the worker (the id alone
	// identifies the handoff) but it keeps the URL looking like an ordinary
	// file path, which is both less likely to trip URL filters and a correct
	// last-resort filename if Content-Disposition is ever stripped.
	iframe.src = `${SW_SCOPE}${id}/${encodeURIComponent(filename)}`;
	document.body.appendChild(iframe);

	const removeIframe = () => {

		// Detach on a short delay: the download has been handed to the
		// browser by the time the stream closes, but removing the frame in
		// the same tick as the final chunk is unnecessarily tight. Unlike
		// the old Blob-URL approach, nothing about the DATA depends on this
		// timing — the bytes were streamed through the worker, not read out
		// of a file the iframe points at — so this is pure DOM tidying and
		// can't truncate anything.
		setTimeout(() => iframe.remove(), 5_000);
	};

	// Don't hand back a usable download until we KNOW that navigation
	// reached the worker. If it was blocked (enterprise URL policy, blocking
	// extension, intercepting proxy) the port handshake above still
	// succeeded, so this is the only place the failure is detectable —
	// without it the caller's first write() would park forever on a 'pull'
	// that never comes, hanging the export with a progress bar that never
	// moves and no fallback.
	const fetchTimer = setTimeout(() => {
		if (!fetched && fetchedReject) {
			const r = fetchedReject;
			fetchedReject = null;
			fetchedResolve = null;
			r(new Error('The download request never reached the service worker.'));
		}
	}, FETCH_ACK_TIMEOUT_MS);

	try {
		await fetchedPromise;
	} catch (err) {
		clearTimeout(fetchTimer);
		// Tear the handoff down so the worker isn't left holding a port and
		// an entry until its TTL expires, and drop the iframe immediately —
		// there's no download in flight that could be truncated.
		try {
			port.postMessage({ type: 'abort', reason: 'download navigation blocked' });
			port.close();
		} catch {
			/* best-effort */
		}
		iframe.remove();

		// A real user cancel propagates; anything else means "this tier
		// doesn't work here", so return null and let the caller fall back to
		// the OPFS/in-memory path rather than failing the whole export.
		if (err instanceof DownloadCancelledError) throw err;
		console.warn(
			'[vault-dl] download URL appears to be blocked (policy, extension or proxy) — falling back:',
			err
		);
		return null;
	}
	clearTimeout(fetchTimer);

	/** Wait until the worker asks for another chunk. */

	async function awaitPull(): Promise<void> {
		if (cancelled) throw cancelled;
		if (pullCredits > 0) {
			pullCredits--;
			return;
		}
		await new Promise<void>((resolve) => {
			pullWaiter = resolve;
		});
		if (cancelled) throw cancelled;
		// A pull arrived (rather than a cancel waking us).
		if (pullCredits > 0) pullCredits--;
	}

	return {
		async write(chunk: Uint8Array): Promise<void> {
			if (finished) throw new Error('write() called after the download was closed.');
			if (cancelled) throw cancelled;
			if (chunk.length === 0) return;

			await awaitPull();

			// Structured-clone (copy) rather than transferring the chunk's
			// ArrayBuffer. Transferring would be zero-copy but DETACHES the
			// buffer in this realm, which silently corrupts data if the
			// producer reuses or retains its output buffer. The copy is
			// bounded to a single chunk and this path is I/O-bound on the
			// download anyway, so correctness wins over the micro-optimization.
			port.postMessage({ type: 'chunk', chunk });
		},

		async close(): Promise<void> {
			if (finished) return;
			if (cancelled) throw cancelled;
			finished = true;
			port.postMessage({ type: 'close' });
			try {
				port.close();
			} catch {
				/* best-effort */
			}
			removeIframe();
		},

		abort(reason?: string): void {
			if (finished) return;
			finished = true;
			try {
				port.postMessage({ type: 'abort', reason: reason ?? '' });
				port.close();
			} catch {
				/* best-effort */
			}
			removeIframe();
		}
	};
}
