/**
 * Tracks whether the app shell is fully precached and safe to use offline.
 *
 * Wired up from +layout.svelte's service worker registration:
 *   - If `serviceWorker` isn't supported, or a worker is already `.active` at
 *     registration time (returning visitor — precache already happened on a
 *     previous visit), we're ready immediately.
 *   - Otherwise we watch the installing/waiting worker's statechange events.
 *     Because the SW config has skipWaiting + clientsClaim, and Workbox's
 *     precacheAndRoute() populates the Cache API synchronously during the
 *     install event (before the worker can reach 'activated'), reaching the
 *     'activated' state reliably means the full app shell is now cached and
 *     a subsequent offline load will succeed.
 *
 * The Workspace header reads `offlineReady.state` to show a
 * "Preparing offline mode…" → "Ready to work offline" indicator, so the user
 * has a real signal for when it's safe to disconnect WiFi instead of having
 * to guess.
 */

export type OfflineReadyState = 'checking' | 'ready';

class OfflineReadyStore {
	state = $state<OfflineReadyState>('checking');

	markReady() {
		this.state = 'ready';
	}

	/** Called once from +layout.svelte right after navigator.serviceWorker.register() resolves. */
	trackRegistration(registration: ServiceWorkerRegistration) {
		// A worker is already controlling/active → precache already happened
		// on a previous visit. Nothing to wait for.
		if (registration.active) {
			this.markReady();
			return;
		}

		// Otherwise watch whichever worker is currently installing (or about to).
		const watch = (worker: ServiceWorker | null) => {
			if (!worker) return;
			if (worker.state === 'activated') {
				this.markReady();
				return;
			}
			worker.addEventListener('statechange', () => {
				if (worker.state === 'activated') this.markReady();
			});
		};

		watch(registration.installing);
		watch(registration.waiting);

		// Covers the case where `installing` hasn't been assigned yet at the
		// moment this runs (register() resolved before the browser started
		// installing) — updatefound fires when it does.
		registration.addEventListener('updatefound', () => {
			watch(registration.installing);
		});
	}
}

export const offlineReady = new OfflineReadyStore();
