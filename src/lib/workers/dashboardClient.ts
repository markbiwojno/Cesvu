/**
 * src/lib/workers/dashboardClient.ts — Main-thread client for the dashboard worker
 *
 * Spawns a fresh worker per `compute()` call, posts the row buffer +
 * column metadata, awaits a single response, then terminates the worker.
 * One-shot semantics — no long-running pool. See dashboard.worker.ts for
 * the rationale.
 *
 * Vite bundling: `new URL('./dashboard.worker.ts', import.meta.url)` is
 * the canonical Vite pattern. The build produces a separate JS chunk
 * for the worker and a URL we can hand to `new Worker()`.
 */

import type { ColumnProfile } from '$lib/types.js';
import type { WorkbookKpis, ColumnStats } from '$lib/pipeline/columnStats.js';
import type { ChartData } from '$lib/visuals/chart-specs.js';
import type { Filter } from '$lib/pipeline/filter.js';
import type { ComputeRequest, ComputeResult } from './dashboard.worker.js';

export interface DashboardComputeResult {
	statsByColumn: Record<string, ColumnStats>;
	chartDataByColumn: Record<string, ChartData | null>;
	sortedColumns: ColumnProfile[];
	kpis: WorkbookKpis;
	elapsedMs: number;
}

/** Error type for cancelled computes. */
export class DashboardComputeCancelledError extends Error {
	constructor() {
		super('Dashboard compute was cancelled by a newer call');
		this.name = 'DashboardComputeCancelledError';
	}
}

/**
 * Compute dashboard data off the main thread.
 *
 * OOM / freeze fixes (the user reported a hard freeze on the first
 * "Analyze this column" click, followed by an out-of-memory crash on
 * 200k-row files):
 *
 *   1. The pre-snapshot JSON round-trip is now ASYNC and CHUNKED,
 *      yielding to the event loop between 5k-row chunks via
 *      `setTimeout(0)`. The previous sync version blocked the main
 *      thread for 200-400ms on the cold-cache case.
 *   2. The snapshot cache is capped at ONE entry (previously 4).
 *      Each entry held BOTH the serialized string AND the parsed
 *      array (two ~50MB copies for a 200k-row buffer). 4 entries
 *      × 100MB = 400MB on the main thread — the OOM. Now the cache
 *      holds only the parsed array, and only for the currently-
 *      active buffer.
 *   3. In-flight cancellation: when a new compute starts while a
 *      previous one is still running, the old worker is terminated
 *      BEFORE the new one is spawned. This prevents two workers
 *      from holding 200k rows in parallel. The old promise rejects
 *      with `DashboardComputeCancelledError` (which the caller in
 *      DashboardPane silently swallows).
 */
export async function computeDashboardData(
	columns: ColumnProfile[],
	rows: Record<string, unknown>[],
	filter: Filter | null = null,
	/** Names of columns the user has opted in to render with a chart.
	 *  Empty array (the common case) = "every column gets lite" —
	 *  NO chart data, NO outlier walks. Worker always receives
	 *  an array now (legacy "undefined = full" interpretation is
	 *  removed). */
	loadedColumns: string[] = []
): Promise<DashboardComputeResult> {
	// Build the snapshots BEFORE spawning the worker. The async
	// stringify walk yields to the event loop between chunks so
	// the UI stays responsive. The actual heavy compute (stats +
	// chart data) still runs off-thread in the worker.
	const [cleanColumns, cleanRows] = await Promise.all([
		jsonSnapshotAsync('columns', columns),
		jsonSnapshotAsync('rows', rows)
	]);

	// In-flight cancellation. The auto-load effect re-fires the
	// parent's compute effect on every focusedColumn change. If
	// the previous worker is still chewing on a 200k-row buffer,
	// we MUST terminate it before spawning the new one — otherwise
	// two workers run in parallel, each holding ~50MB on the
	// main thread + ~50MB in the worker, for ~100MB total. On a
	// constrained machine the second spawn never lands.
	cancelInFlight();

	return new Promise((resolve, reject) => {
		// Vite resolves this at build time into its own chunk.
		const worker = new Worker(
			new URL('./dashboard.worker.ts', import.meta.url),
			{ type: 'module' }
		);

		let settled = false;
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			worker.terminate();
			inFlightWorker = null;
			fn();
		};

		worker.addEventListener('message', (ev: MessageEvent<ComputeResult>) => {
			settle(() => resolve({
				statsByColumn: ev.data.statsByColumn,
				chartDataByColumn: ev.data.chartDataByColumn,
				sortedColumns: ev.data.sortedColumns,
				kpis: ev.data.kpis,
				elapsedMs: ev.data.elapsedMs
			}));
		});

		worker.addEventListener('error', (ev) => {
			settle(() => reject(new Error(`Dashboard worker error: ${ev.message ?? 'unknown'}`)));
		});

		worker.addEventListener('messageerror', () => {
			settle(() => reject(new Error('Dashboard worker message could not be deserialized')));
		});

		// Track the in-flight worker so a subsequent compute can
		// cancel it. We do this AFTER the listeners are wired so
		// `cancelInFlight()` can distinguish "no worker" from
		// "worker running".
		inFlightWorker = { worker, cancelToken: { cancelled: false } };
		// Tie the cancel token to a rejection so the previous call's
		// promise settles. We use the cancelToken rather than
		// terminate()'s return value so the OLD promise's reject
		// fires before the new worker is spawned.
		if (inFlightWorker.cancelToken.cancelled) {
			settle(() => reject(new DashboardComputeCancelledError()));
			return;
		}

		const req: ComputeRequest = {
			columns: cleanColumns,
			rows: cleanRows,
			filter,
			loadedColumns
		};
		worker.postMessage(req);
	});
}

// ── In-flight cancel registry ──────────────────────────────────────────────────

interface CancelToken { cancelled: boolean; }
let inFlightWorker: { worker: Worker; cancelToken: CancelToken } | null = null;

/**
 * Terminate the in-flight worker, if any, and flip its cancel token so
 * the old promise rejects with `DashboardComputeCancelledError`. Called
 * from `computeDashboardData()` BEFORE spawning a new worker. This is
 * the "old worker is cancelled when a newer one starts" behavior the
 * DashboardPane comments reference; previously it was a lie — the
 * code just spawned a second worker alongside the first. Two workers
 * chewing on the same 200k-row buffer were the OOM root cause.
 */
function cancelInFlight(): void {
	if (inFlightWorker === null) return;
	inFlightWorker.cancelToken.cancelled = true;
	// The new promise being built below will see `cancelled === true`
	// and reject synchronously in its constructor (see the guard
	// right after we assign inFlightWorker). The worker itself is
	// already terminated inside its own `settle()` once the previous
	// message handler returns — but to be safe (and to release
	// memory NOW rather than when the message lands), terminate
	// it explicitly here too. `terminate()` is idempotent and a
	// no-op if the worker has already settled.
	try { inFlightWorker.worker.terminate(); } catch { /* ignore */ }
	inFlightWorker = null;
}

// ── Per-identity JSON snapshot cache ──────────────────────────────────────────

/**
 * Keyed by the row/columns array's object identity. Svelte 5 keeps
 * the same proxy reference stable across reads of the same buffer,
 * so identity is a reliable invalidation key.
 *
 * Stores ONLY the parsed plain JS array (not the serialized string).
 * The string is a one-shot intermediate used to build the parse —
 * once `JSON.parse` is done, the string is wasted memory. The previous
 * design held both (string + parsed) and let 4 entries accumulate =
 * ~400MB on the main thread for a 200k-row file. One entry, just
 * the parsed array, caps the footprint at ~50MB.
 *
 * Filter clicks within the same session stay near-free (~1ms reference
 * assignment on cache hit).
 */
const snapshotCache = new Map<unknown, unknown>();

/**
 * Chunk size for the async stringify walk. 5k elements per chunk keeps
 * each individual yield short (< 8ms on a 200k×50 buffer) so the user
 * sees a smooth UI while the snapshot builds. Smaller chunks = smoother
 * UI but more event-loop ticks; bigger chunks = faster total but
 * visible jank. 5k is the sweet spot observed for 200k×52 buffers.
 */
const SNAPSHOT_CHUNK_SIZE = 5_000;

/**
 * Async version of jsonSnapshot(). The previous sync version did
 * `JSON.stringify(value)` on the main thread for 200k+ rows, which
 * froze the UI for 200-400ms on the first call (the cold-cache
 * case). The user hit this on "Analyze this column" — the very first
 * click on a freshly-loaded CSV — and reported a hard freeze.
 *
 * The fix walks the array chunk-by-chunk and yields to the event
 * loop between chunks via `setTimeout(0)`. The main thread stays
 * free to paint, scroll, and respond to clicks while the snapshot
 * builds. The cache then makes subsequent calls (filter clicks, etc.)
 * near-free — same as before.
 *
 * We could move this to a dedicated worker, but the cost is two more
 * structured-clone transfers (a round-trip of the same row buffer).
 * Async chunked stringify on the main thread is the smaller change
 * with the same user-visible result: no freeze, ~same wall time.
 */
async function jsonSnapshotAsync<T>(key: 'rows' | 'columns', value: T): Promise<T> {
	const cached = snapshotCache.get(value) as T | undefined;
	if (cached !== undefined) {
		// Cache hit: ~1ms (a reference assignment). This is what
		// makes filter clicks feel instant.
		return cached;
	}

	// Fast path: tiny buffers (e.g. the columns array — always tens
	// of entries) stringify synchronously. No need to yield for
	// sub-millisecond work.
	const isRows = key === 'rows';
	const arr = value as unknown as unknown[];
	if (!isRows || !Array.isArray(arr) || arr.length < SNAPSHOT_CHUNK_SIZE) {
		const parsed = JSON.parse(JSON.stringify(value)) as T;
		cacheSet(value, parsed);
		return parsed;
	}

	// Slow path: chunked stringify for large row buffers. JSON.stringify
	// on an array is a single sync call, so we have to BUILD the
	// string ourselves row-by-row to yield. We:
	//   1. open the JSON array
	//   2. stringify N rows at a time, joining with commas
	//   3. yield to the event loop between chunks
	//   4. close the JSON array
	//   5. JSON.parse the result
	// The result is byte-identical to JSON.stringify(arr) for arrays
	// of plain JS objects (which our row buffer always is — Papa Parse
	// with `dynamicTyping: true` emits only string|number|boolean|null).
	const parts: string[] = ['['];
	for (let i = 0; i < arr.length; i += SNAPSHOT_CHUNK_SIZE) {
		const end = Math.min(i + SNAPSHOT_CHUNK_SIZE, arr.length);
		const chunk: string[] = [];
		for (let j = i; j < end; j++) {
			chunk.push(JSON.stringify(arr[j]));
		}
		parts.push(chunk.join(','));
		if (end < arr.length) {
			parts.push(','); // trailing comma → next chunk starts cleanly
			// Yield to the event loop. setTimeout(0) is universally
			// available; queueMicrotask would NOT yield (it keeps
			// the main thread blocked). The user gets a paint frame
			// between chunks.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	}
	parts.push(']');
	const joined = parts.join('');
	const parsed = JSON.parse(joined) as T;
	cacheSet(value, parsed);
	if (typeof console !== 'undefined') {
		console.debug(`[dashboard] ${key} snapshot built`);
	}
	return parsed;
}

/**
 * Cache-write with strict size cap. We hold at most ONE entry —
 * the currently-active buffer. On a new file (or new sheet) the
 * old buffer's identity changes and the previous entry is
 * overwritten. This puts a hard ceiling on the main-thread
 * snapshot memory (~50MB for a 200k-row file).
 */
function cacheSet<T>(value: T, parsed: T): void {
	// Drop any prior entry first so the GC can reclaim it before
	// we install the new one — even with size=1, the Map's
	// `clear()` releases the strong reference synchronously.
	if (snapshotCache.size > 0) {
		snapshotCache.clear();
	}
	snapshotCache.set(value, parsed);
}
