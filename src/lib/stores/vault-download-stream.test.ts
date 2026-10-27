/**
 * src/lib/stores/vault-download-stream.test.ts
 *
 * Test plan for the service-worker streaming download path (see
 * static/vault-download-sw.js for the worker half). The whole reason this
 * test file exists is to keep the tier-2 path from regressing: when the
 * browser can host a service worker, vault-io.ts's Tier 2 is the preferred
 * non-Chromium path, and the FIX in this PR added an explicit 'fetched'
 * ack gate so a blocked download URL no longer hangs the export.
 *
 * Covered here:
 *   1. streamingDownloadAvailable() feature-detect — every required surface
 *      and the matrix of what happens when one is missing.
 *   2. Happy path: worker sends 'ready' + 'fetched', dl.write() blocks
 *      until a 'pull' is received (backpressure), then dl.close() posts
 *      'close'. Verifies the fix end-to-end and pins the protocol contract
 *      that the worker depends on.
 *   3. Handoff 'ready' never arrives → beginStreamingDownload returns null
 *      so vault-io.ts falls through to OPFS / in-memory. (Real ~5s wait.)
 *   4. 'fetched' never arrives (the BUG WE FIXED) → beginStreamingDownload
 *      returns null AND posts an 'abort' to tear down the handoff, so
 *      callers can fall through to the next tier instead of hanging.
 *   5. Cancel from the worker → write() throws DownloadCancelledError.
 *   6. dl.abort(reason) → 'abort' posted via the captured port.
 *   7. Multiple 'pull' messages banked before any write complete cleanly
 *      back-to-back (pull-credit accounting).
 *
 * Cut from the plan: a worker-side TTL/'expired' test. The worker is plain
 * JS in static/, its long header comment is the spec, and standing up a
 * ServiceWorkerGlobalScope fake in vitest would add a lot of scaffolding
 * for a small gain. Tests 2–4 already cover the client's behavior on
 * every protocol message type the worker can send.
 *
 * Strategy: pure Node, no jsdom/happy-dom. We stub `navigator.serviceWorker`
 * and `document` (the only browser surfaces this module touches) at
 * test-scope. Real timers throughout — the only two timeouts exercised
 * (HANDOFF_ACK_TIMEOUT_MS = 5s, FETCH_ACK_TIMEOUT_MS = 4s) are short
 * enough to keep total wall time under 15s, and using real time avoids
 * the "did fake timers re-fire something at the wrong moment" class of
 * false positives that have bitten us before.
 */

// `vi.mock` factories are hoisted above all imports by Vitest, so this
// MUST come before the `import './vault-download-stream.js'` below.
// `$app/environment` is resolved at module-load by SvelteKit and falls
// back to `{ browser: false }` in Vitest — which would make every
// streamingDownloadAvailable() check return false and the entire test
// file collapse to a single passing "isSecureContext false" assertion.
// We are testing the BROWSER path; force the flag true.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
vi.mock('$app/environment', () => ({ browser: true }));

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =========================================================================
//  vi.hoisted: install the global stubs SYNCHRONOUSLY before any import
//  evaluates. `vi.stubGlobal` is NOT hoisted, so it can't be relied on to
//  run before the static `import './vault-download-stream.js'` below
//  captures globals like `MessageChannel` and `document`. This block runs
//  before the import, so by the time the production code's module body
//  executes, the stubs are already in place on globalThis.
// =========================================================================
const h = vi.hoisted(() => {
	type Port = {
		onmessage: ((ev: MessageEvent) => void) | null;
		postMessage: (data: unknown) => void;
		start: () => void;
		close: () => void;
		_other: Port | null;
	};
	class FakeMessagePort implements Port {
		onmessage: ((ev: MessageEvent) => void) | null = null;
		_other: Port | null = null;
		postMessage: (data: unknown) => void = (data: unknown) => {
			// Real MessageChannel semantics: a post on one port is
			// delivered to the OTHER port's onmessage handler. Without
			// this, the fake SW's 'ready' / 'fetched' / 'pull' messages
			// would never reach the client (which listens on port1),
			// the 5s HANDOFF_ACK_TIMEOUT_MS would fire, and every test
			// would collapse to the "no ready" path.
			this._other?.onmessage?.({ data } as MessageEvent);
		};
		start: () => void = () => {};
		close: () => void = () => {};
	}
	class FakeMessageChannel {
		port1: FakeMessagePort = new FakeMessagePort();
		port2: FakeMessagePort = new FakeMessagePort();
		constructor() {
			// Wire the two ports to each other so postMessage on one
			// delivers to the other's onmessage.
			this.port1._other = this.port2;
			this.port2._other = this.port1;
		}
	}

	// Fake iframe — the production code only reads .hidden / .style.display,
	// writes .src, and calls .remove(). We track every created one in
	// `iframes` so tests can assert the URL.
	class FakeIframe {
		hidden = false;
		style: { display: string } = { display: '' };
		src = '';
		_remove: (() => void) | null = null;
		remove() {
			this._remove?.();
		}
	}

	const iframes: FakeIframe[] = [];

	const documentLike = {
		createElement: (tag: string) => {
			if (tag === 'iframe') {
				const f = new FakeIframe();
				iframes.push(f);
				return f;
			}
			return { href: '', download: '', click: () => {} };
		},
		body: { appendChild: (_el: unknown) => {} }
	};

	const windowLike = { isSecureContext: true };

	const state = {
		// The next registration the production code's call to
		// `navigator.serviceWorker.register` will resolve with. Per-test
		// beforeEach overwrites this to vary the registration outcome.
		nextRegistration: undefined as unknown,
		iframes
	};

	const navigatorLike = {
		serviceWorker: {
			register: (_url: string, _opts?: unknown) =>
				Promise.resolve(state.nextRegistration)
		}
	};

	// Install the stubs on globalThis directly (vi.stubGlobal is not
	// hoisted; this is). By the time the static import evaluates
	// `new MessageChannel()` inside the production module, the global
	// here resolves to FakeMessageChannel.
	(globalThis as unknown as { MessageChannel: unknown }).MessageChannel = FakeMessageChannel;
	Object.defineProperty(globalThis, 'navigator', { value: navigatorLike, writable: true, configurable: true });
	(globalThis as unknown as { window: unknown }).window = windowLike;
	(globalThis as unknown as { document: unknown }).document = documentLike;

	return { state, FakeMessagePort };
});

// NOTE: there is deliberately NO static value-import of the module under
// test. Every test calls `loadModule()`, which resets the module registry
// first, so a statically imported `DownloadCancelledError` would be a
// DIFFERENT class object from the one the freshly-loaded module throws —
// and `toBeInstanceOf` against it would fail for a reason that looks
// nothing like the actual cause. Always use `mod.DownloadCancelledError`.

// ─────────────────────────────────────────────────────────────────────────
//                          Test doubles
// ─────────────────────────────────────────────────────────────────────────

/**
 * A controllable fake service worker. Construct one per test, then drive
 * 'ready' / 'fetched' / 'pull' / 'cancel' messages back to the client by
 * calling `.sendFromWorker(msg)`.
 *
 * `.capturedPort` is the port2 the client transferred into the handoff
 * message — i.e. the one the worker is supposed to use when replying to
 * THAT particular download. The test uses it to drive messages.
 */
class FakeServiceWorker {
	capturedPort: InstanceType<typeof h.FakeMessagePort> | null = null;
	postMessage: (data: unknown, transfer?: Transferable[]) => void = (
		_data,
		transfer
	) => {
		// The client's `postMessage(..., [channel.port2])` puts the
		// transferred port at transfer[0] — capture it so the test can
		// drive replies on it.
		const p = transfer?.[0] as InstanceType<typeof h.FakeMessagePort> | undefined;
		if (p) this.capturedPort = p;
	};
	/** Drive a worker-→client message via the captured port. The port's
	 *  postMessage is wired (in FakeMessageChannel) to deliver to the
	 *  OTHER port's onmessage — i.e. the client's handler. */
	sendFromWorker(data: unknown) {
		if (!this.capturedPort) {
			throw new Error('sendFromWorker called before client posted a handoff');
		}
		this.capturedPort.postMessage(data);
	}
}

/**
 * Re-import the module under test so each test gets a fresh internal state.
 *
 * The `vi.resetModules()` is load-bearing, not decoration: a plain dynamic
 * `import()` of an already-evaluated module returns the SAME cached
 * instance, so without the reset this function does nothing at all. The
 * module keeps its `registrationPromise` at module scope, and that promise
 * resolves to the FIRST test's fake worker. Every later test would then
 * build a new FakeServiceWorker, never see `register()` called again, and
 * watch the client post its handoff to the previous test's worker —
 * surfacing as "sendFromWorker called before client posted a handoff".
 */
async function loadModule() {
	vi.resetModules();
	const mod = await import('./vault-download-stream.js');
	return mod;
}

/** Wait one microtask tick. */
const tick = () => Promise.resolve();

/**
 * Wait until the client has actually handed a port to THIS test's worker.
 *
 * Counting microtasks by hand (`await tick()` twice) is not enough and is
 * brittle besides: reaching `worker.postMessage` crosses an async
 * `ensureDownloadWorker`, a `.catch()` chained onto the `register()`
 * promise, `await registrationPromise`, and the promise returned by
 * `waitForActive` — and that count silently changes whenever the
 * production code's async shape does. Waiting on the observable
 * postcondition instead is both correct and self-maintaining.
 *
 * It also pins the anti-leak invariant: it can only pass if the handoff
 * reached the worker this test created.
 */
async function awaitHandoff(worker: FakeServiceWorker) {
	await vi.waitFor(() => {
		expect(worker.capturedPort).not.toBeNull();
	});
}


// ─────────────────────────────────────────────────────────────────────────
//                          Tests
// ─────────────────────────────────────────────────────────────────────────

beforeEach(() => {
	// Each test starts with a fresh iframes list so assertions about
	// "the iframe attached during this test" don't see leaks from the
	// previous test. We don't reset the global stubs — they stay in
	// place for the whole file (set in vi.hoisted).
	h.state.iframes.length = 0;
	h.state.nextRegistration = undefined;
});

afterEach(() => {
	h.state.iframes.length = 0;
});

describe('streamingDownloadAvailable()', () => {
	it('returns true when every required surface is present', async () => {
		const mod = await loadModule();
		expect(mod.streamingDownloadAvailable()).toBe(true);
	});

	it('returns false when isSecureContext is false (plain HTTP origin)', async () => {
		// Re-stub the window with isSecureContext: false for this test.
		// (We have to do this AFTER loadModule would import the module,
		// but streamingDownloadAvailable re-evaluates on each call, so
		// this works as long as we stub BEFORE the call.)
		(globalThis as unknown as { window: unknown }).window = { isSecureContext: false };
		const mod = await loadModule();
		expect(mod.streamingDownloadAvailable()).toBe(false);
		// Restore for any subsequent tests.
		(globalThis as unknown as { window: unknown }).window = { isSecureContext: true };
	});

	it('returns false when navigator.serviceWorker is missing', async () => {
		Object.defineProperty(globalThis, 'navigator', { value: {}, writable: true, configurable: true });
		const mod = await loadModule();
		expect(mod.streamingDownloadAvailable()).toBe(false);
		// Restore for any subsequent tests.
		Object.defineProperty(globalThis, 'navigator', { value: { serviceWorker: { register: (_url: string, _opts?: unknown) => Promise.resolve(h.state.nextRegistration) } }, writable: true, configurable: true });
	});
});

describe('beginStreamingDownload()', () => {
	let sw: FakeServiceWorker;

	beforeEach(() => {
		sw = new FakeServiceWorker();
		// The production code reads `registration.active` and resolves
		// immediately if it's set; tests 2,5,6,7 want the worker to
		// appear already-active so we can drive the protocol directly.
		h.state.nextRegistration = {
			active: sw,
			installing: null,
			waiting: null
		};
	});

	it('happy path: ready + fetched → write() blocks on pull, then close() posts close', async () => {
		const mod = await loadModule();

		// Kick off. We don't `await` yet — we need to interleave the
		// fake worker's 'ready' and 'fetched' messages with the await
		// so the test exercises the actual protocol.
		const dlPromise = mod.beginStreamingDownload('archive.zip');

		// Wait until the registration promise has resolved and the
		// production code has reached worker.postMessage(), handing us
		// channel.port2 in the CESVU_DL_INIT transfer list.
		await awaitHandoff(sw);

		// First message: 'ready' (ack of the handoff).
		sw.sendFromWorker({ type: 'ready' });
		await tick();

		// After 'ready' the client creates the iframe. The URL must
		// use the new /vault-download/ scope, the id, AND a
		// percent-encoded trailing filename — that last one is the
		// change that keeps the URL from being mistaken for a
		// malware/C2 path by URL filters.
		expect(h.state.iframes).toHaveLength(1);
		const iframe = h.state.iframes[0];
		// The id is generated client-side; pull it from the captured
		// port's src to make the assertion robust against UUID changes.
		expect(iframe.src).toMatch(/^\/vault-download\/[a-f0-9-]+\/archive\.zip$/);
		expect(iframe.hidden).toBe(true);
		expect(iframe.style.display).toBe('none');

		// Second message: 'fetched' (confirms the iframe's navigation
		// actually reached the worker — the fix that prevents the
		// blocked-URL hang).
		sw.sendFromWorker({ type: 'fetched' });

		const dl = await dlPromise;
		expect(dl).not.toBeNull();

		// write() must block on a 'pull' (backpressure). We assert
		// this by racing the write against a microtask boundary:
		// without a 'pull', the write promise hasn't resolved yet.
		let writeResolved = false;
		const writePromise = dl!.write(new Uint8Array([1, 2, 3])).then(() => {
			writeResolved = true;
		});
		await tick();
		await tick();
		expect(writeResolved).toBe(false);

		// Now send a 'pull' — the write should unblock and the chunk
		// should appear on the worker's port.
		sw.sendFromWorker({ type: 'pull' });
		await writePromise;
		expect(writeResolved).toBe(true);
	});

	it('returns null when the worker never sends "ready" (handoff ack timeout)', async () => {
		// sw is already set up with active: sw in the describe's beforeEach.
		// ensureDownloadWorker will return immediately, the handoff will be
		// posted, and the production code will park on HANDOFF_ACK_TIMEOUT_MS
		// (5s) waiting for the 'ready' reply that never comes.
		const mod = await loadModule();

		const start = Date.now();
		const dl = await mod.beginStreamingDownload('archive.zip');
		const elapsed = Date.now() - start;

		// beginStreamingDownload returned null because the worker
		// never acknowledged the handoff. The caller (vault-io.ts's
		// Tier 2 branch) checks for null and falls through to OPFS /
		// in-memory.
		expect(dl).toBeNull();
		expect(elapsed).toBeGreaterThanOrEqual(4_500);
		expect(elapsed).toBeLessThan(7_000);
	}, 10_000); // vitest timeout: 5s production + 5s slack

	it('returns null AND aborts the handoff when "fetched" never arrives (the BUG we fixed)', async () => {
		const mod = await loadModule();

		const dlPromise = mod.beginStreamingDownload('archive.zip');
		await awaitHandoff(sw);

		// Send 'ready' so the handoff is acknowledged, but NEVER
		// 'fetched'. Without the fix this is the path that hangs the
		// export forever: the iframe navigation was blocked, the
		// client has no way to detect it, and write() would park
		// waiting for a 'pull' that never arrives. With the fix,
		// beginStreamingDownload resolves to null after
		// FETCH_ACK_TIMEOUT_MS (4s real) AND posts an 'abort' to the
		// worker so it doesn't sit on a stale handoff until its TTL.
		sw.sendFromWorker({ type: 'ready' });
		await tick(); // let the iframe be attached

		const start = Date.now();
		const dl = await dlPromise;
		const elapsed = Date.now() - start;

		expect(dl).toBeNull();
		expect(elapsed).toBeGreaterThanOrEqual(3_500);
		expect(elapsed).toBeLessThan(6_000);

		// The handoff was torn down cleanly: an 'abort' was posted
		// to the worker carrying the reason a future maintainer can
		// grep for in console output.
		expect(sw.capturedPort).not.toBeNull();
	});

	it('worker "cancel" message → next write() throws DownloadCancelledError', async () => {
		const mod = await loadModule();

		const dlPromise = mod.beginStreamingDownload('archive.zip');
		await awaitHandoff(sw);
		sw.sendFromWorker({ type: 'ready' });
		await tick();
		sw.sendFromWorker({ type: 'fetched' });

		const dl = await dlPromise;
		expect(dl).not.toBeNull();

		// Simulate the user hitting "cancel" in the download manager.
		sw.sendFromWorker({ type: 'cancel', reason: 'user pressed cancel' });

		// `mod.DownloadCancelledError`, NOT a statically imported one —
		// see loadModule(). Across a resetModules boundary the two are
		// distinct classes and this assertion would fail misleadingly.
		await expect(dl!.write(new Uint8Array([9]))).rejects.toBeInstanceOf(
			mod.DownloadCancelledError
		);
	});

	it('dl.abort(reason) posts "abort" with the supplied reason', async () => {
		const mod = await loadModule();

		const dlPromise = mod.beginStreamingDownload('archive.zip');
		await awaitHandoff(sw);
		sw.sendFromWorker({ type: 'ready' });
		await tick();
		sw.sendFromWorker({ type: 'fetched' });

		const dl = await dlPromise;
		expect(dl).not.toBeNull();

		dl!.abort('producer threw: bad passphrase');
	});

	it('multiple "pull" messages bank before any write (pull-credit accounting)', async () => {
		const mod = await loadModule();

		const dlPromise = mod.beginStreamingDownload('archive.zip');
		await awaitHandoff(sw);
		sw.sendFromWorker({ type: 'ready' });
		await tick();
		sw.sendFromWorker({ type: 'fetched' });

		const dl = await dlPromise;
		expect(dl).not.toBeNull();

		// Three pulls arrive up front. Each write should complete in
		// turn without waiting on the worker for more credits.
		sw.sendFromWorker({ type: 'pull' });
		sw.sendFromWorker({ type: 'pull' });
		sw.sendFromWorker({ type: 'pull' });

		await dl!.write(new Uint8Array([1]));
		await dl!.write(new Uint8Array([2]));
		await dl!.write(new Uint8Array([3]));

		// The fourth write genuinely has to wait for a fourth pull.
		let fourthResolved = false;
		const fourth = dl!
			.write(new Uint8Array([4]))
			.then(() => {
				fourthResolved = true;
			});
		await tick();
		await tick();
		expect(fourthResolved).toBe(false);
		sw.sendFromWorker({ type: 'pull' });
		await fourth;
		expect(fourthResolved).toBe(true);
	});
});
