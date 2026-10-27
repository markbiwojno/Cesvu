<script lang="ts">
	/**
	 * SpreadsheetViewer.svelte — viewer for the NON-streaming workbook path
	 * (parseCsv / parseExcel → workspace.setWorkbook).
	 *
	 * This is a SIBLING of CsvViewer.svelte / DocumentPane.svelte, NOT a
	 * replacement. The streaming parseCSV path (DocumentPane + workspace.csvRows)
	 * is untouched. SpreadsheetViewer reads the fully-materialized workbook from
	 * the store:
	 *   - workspace.workbook        → Workbook | null
	 *   - workspace.currentSheet    → active Sheet
	 *   - workspace.currentRows     → rows of the active sheet
	 *   - workspace.workbookProfile → per-sheet column profiles (badges)
	 *
	 * The virtualized table, header-click sorting, and row/cell/column selection
	 * logic are ported from the CSV table in DocumentPane.svelte. Sort state is
	 * LOCAL to this component (not workspace.activeSort, which belongs to the
	 * streaming path) so the two paths never interfere.
	 *
	 * SheetTabs is rendered above the table and hides itself for single-sheet
	 * workbooks.
	 */
import { tick } from 'svelte';
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import { notesStore } from '$lib/stores/notesStore.svelte.js';
	import SheetTabs from './SheetTabs.svelte';
	import LoadingSpinner from '$lib/components/ui/LoadingSpinner.svelte';
	import CellContextMenu from './CellContextMenu.svelte';
	import FilterBar from '$lib/components/workspace/FilterBar.svelte';
	import type { MenuTarget } from './cellMenuActions.js';

	import type { ColumnProfile } from '$lib/types.js';
import { evaluate as evalFilterTree, describeFilter } from '$lib/pipeline/filter.js';
	import { matchesValue } from '$lib/pipeline/valueMatch.js';



	// ============================================================
	// Data source — the non-streaming workbook path
	// ============================================================
	const workbook = $derived(workspace.workbook);
	const sheet = $derived(workspace.currentSheet);
	const columns = $derived<string[]>(sheet?.headers ?? []);
	const rows = $derived<Record<string, string>[]>(workspace.currentRows);

	/** Per-sheet column profiles for the active sheet (badges). */
	const sheetProfile = $derived(
		workspace.workbookProfile?.sheets.find((s) => s.name === sheet?.name) ?? null
	);
	function profileFor(col: string): ColumnProfile | null {
		return sheetProfile?.columns.find((c) => c.name === col) ?? null;
	}

	// ============================================================
	// Selection handlers (mirror DocumentPane)
	// ============================================================
	const selectedColumn = $derived(
		workspace.selection?.type === 'column'
			? (workspace.selection.data as { column: string }).column
			: null
	);
	/**
	 * Truncate a value for use in a SELECTION LABEL (the blue chip + the chat
	 * placeholder, which both echo selection.label). Sheets without a real header
	 * row use the first data row's VALUES as column keys, so an unbounded `col`
	 * can be the entire cell's content — which then floods the chat input's
	 * placeholder, making it look like "the whole cell was typed into the box".
	 * Labels are display-only; the full value still travels in `data` to the LLM.
	 */
	function labelize(s: string, max = 24): string {
		const flat = String(s).replace(/\s+/g, ' ').trim();
		return flat.length > max ? `${flat.slice(0, max)}…` : flat;
	}
	function selectColumn(col: string) {
		workspace.setSelection({ type: 'column', label: `${labelize(col)} column`, data: { column: col, sheet: sheet?.name } });
	}
	function selectRow(rowIndex: number, rowData: Record<string, unknown>) {
		workspace.setSelection({ type: 'row', label: `Row ${rowIndex + 1}`, data: { rowIndex, rowData, sheet: sheet?.name } });
	}
	function selectCell(col: string, rowIndex: number, value: unknown) {
		workspace.setSelection({ type: 'cell', label: `${labelize(col)} · Row ${rowIndex + 1}`, data: { column: col, rowIndex, value, sheet: sheet?.name } });
	}


	// ── Right-click context menu (shared with the CSV grid) ───────────────────
	let menu = $state<{ x: number; y: number; target: MenuTarget } | null>(null);
	function openMenu(e: MouseEvent, target: MenuTarget) {
		e.preventDefault();
		e.stopPropagation();
		menu = { x: e.clientX, y: e.clientY, target };
	}
	function closeMenu() {
		menu = null;
	}


	// ============================================================
	// Sort + filter — driven by the SHARED workspace store
	// ============================================================
	// Sort and filter both live on the workspace store (workspace.activeSort /
	// workspace.activeFilter) so the chat query engine and header clicks use a
	// single source of truth. Previously this viewer kept a LOCAL sort that the
	// chat engine couldn't see, so chat "sort by X" did nothing visible on the
	// Excel path. `sort` here is just an alias for the store value.
	const sort = $derived(workspace.activeSort);

	// Apply the active filter (set by the chat query engine) to the sheet rows.
	// Mirrors the logic in DocumentPane's CSV path: supports filterTree (compound
	// boolean), dateFilter (date comparison), and simple pattern/column matching.
	const filteredRows = $derived((() => {
		const f = workspace.activeFilter;
		if (!f) return rows;

		// Compound boolean filter tree takes precedence. Use the canonical
		// evaluate() from filter.ts (same engine DocumentPane uses) so AND/OR/NOT,
		// all leaf ops, and fuzzy column resolution behave identically.
		if (f.filterTree) {
			return rows.filter((row) => evalFilterTree(f.filterTree!, row));
		}


		// Date comparison filter.
		if (f.dateFilter) {
			const { dateMs, dateOp } = f.dateFilter;
			const cols = f.column ? [f.column] : columns;
			return rows.filter((row) =>
				cols.some((c) => {
					const d = parseCellDate(row[c]);
					if (!d) return false;
					const ms = d.getTime();
					switch (dateOp) {
						case 'after': return ms > dateMs;
						case 'before': return ms < dateMs;
						case 'on': return new Date(ms).toDateString() === new Date(dateMs).toDateString();
						case 'not_on': return new Date(ms).toDateString() !== new Date(dateMs).toDateString();
						case 'on_or_after': return ms >= dateMs;

						case 'on_or_before': return ms <= dateMs;
						default: return ms > dateMs;
					}
				})
			);
		}

		// Simple pattern filter. matchesValue() adds numeric + Excel date-serial ⇄
		// date-string equivalence on top of substring matching — so on this Excel
		// path "LastUpdate = 46133" matches the row whose LastUpdate cell shows the
		// formatted date that serial 46133 represents.
		if (!f.pattern) return rows;
		const col = f.column;
		return rows.filter((row) => {
			if (col) {
				return matchesValue(row[col], f.pattern, 'contains');
			}
			return columns.some((c) => matchesValue(row[c], f.pattern, 'contains'));
		});

	})());

	// Sort the (already filtered) rows.
	const sortedRows = $derived((() => {
		if (!sort) return filteredRows;
		const col = sort.column;
		const dir = sort.direction;
		return [...filteredRows].sort((a, b) => {
			const av = a[col];
			const bv = b[col];
			const an = Number(av);
			const bn = Number(bv);
			if (!isNaN(an) && !isNaN(bn) && av !== '' && bv !== '') {
				return dir === 'asc' ? an - bn : bn - an;
			}
			const as = String(av ?? '').toLowerCase();
			const bs = String(bv ?? '').toLowerCase();
			if (as < bs) return dir === 'asc' ? -1 : 1;
			if (as > bs) return dir === 'asc' ? 1 : -1;
			return 0;
		});
	})());

	function handleHeaderClick(col: string) {
		const current = workspace.activeSort;
		if (!current || current.column !== col) {
			workspace.setActiveSort({ column: col, direction: 'asc' });
		} else if (current.direction === 'asc') {
			workspace.setActiveSort({ column: col, direction: 'desc' });
		} else {
			workspace.clearActiveSort();
		}
		windowStart = 0;
	}

	// ── Local helpers for filter evaluation (kept in-component, no async) ──────
	function parseCellDate(v: unknown): Date | null {
		if (!v) return null;
		const s = String(v).trim();
		const d = new Date(s);
		if (!isNaN(d.getTime())) return d;
		const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
		if (m) {
			const yr = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
			const d2 = new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
			if (!isNaN(d2.getTime())) return d2;
		}
		return null;
	}

	// ============================================================

	// Virtual scroll (ported from DocumentPane) — 200 rows in DOM
	// ============================================================
	const RENDER_SIZE = 240;
	const ROW_HEIGHT = 28; // px — must match CSS
	const OVERSCAN = 80;   // rows rendered above the viewport (absorbs scroll lag)
	const MAX_SCROLL_PX = 50_000;


	let windowStart = $state(0);
	// Live scrollTop — used to anchor the top spacer in proportional mode so the
	// rendered rows always sit directly under the viewport (no black band).
	let scrollTopPx = $state(0);

	const totalBuffered = $derived(sortedRows.length);
	const visibleRows = $derived(sortedRows.slice(windowStart, windowStart + RENDER_SIZE));

	const exactScrollHeight = $derived(totalBuffered * ROW_HEIGHT);
	const virtualHeight = $derived(Math.min(exactScrollHeight, MAX_SCROLL_PX));
	const isProportional = $derived(exactScrollHeight > MAX_SCROLL_PX);

	function scrollTopToRowIndex(scrollTop: number, containerHeight: number): number {
		if (!isProportional) {
			return Math.floor(scrollTop / ROW_HEIGHT);
		}
		const maxScrollTop = Math.max(1, virtualHeight - containerHeight);
		const fraction = Math.min(1, scrollTop / maxScrollTop);
		return Math.floor(fraction * (totalBuffered - 1));
	}

	/** Inverse of scrollTopToRowIndex — the scrollTop that lands exactly on
	 *  `rowIdx`. Used by the wheel handler below to move a precise row
	 *  distance in PROPORTIONAL mode without ever going through a pixel
	 *  delta (which is what let a normal scroll amplify into a huge row
	 *  jump on big sheets — see handleWheel's doc comment). */
	function rowIndexToScrollTop(rowIdx: number, containerHeight: number): number {
		if (!isProportional) return rowIdx * ROW_HEIGHT;
		const maxScrollTop = Math.max(1, virtualHeight - containerHeight);
		const fraction = totalBuffered > 1 ? rowIdx / (totalBuffered - 1) : 0;
		return Math.min(maxScrollTop, fraction * maxScrollTop);
	}

	/**
	 * Correct scrollTop to make `visualIdx` land at the TOP of the viewport,
	 * given the already-clamped `windowStart` this row's jump landed on.
	 *
	 * The top spacer anchors to `scrollTopPx - overscanPx` (clamped to
	 * [0, spacerMax] — see topSpacerPx below), which assumes the distance
	 * between `windowStart` and `visualIdx` is exactly OVERSCAN rows. That
	 * is only true in the UNCLAMPED middle of a sheet. Near the top,
	 * `windowStart` clamps to 0 so the real distance is `visualIdx` (<
	 * OVERSCAN); near the bottom it clamps to `totalBuffered - RENDER_SIZE`
	 * so the real distance is > OVERSCAN. Blindly using the proportional
	 * fraction formula (rowIndexToScrollTop) in those clamped regions — or
	 * even just past them, since the fraction can still be SMALLER than
	 * overscanPx on a huge sheet (e.g. row 500 of 500,000 rows) — produces a
	 * scrollTop that disagrees with where the spacer/windowStart actually
	 * puts the row, so the target ends up far outside the viewport (row 40
	 * showing rows 2-20, row 500 showing rows 438-456).
	 *
	 * This derives the UNIQUE scrollTop that is self-consistent with the
	 * spacer-clamp formula for each of the three possible regions:
	 *   - D < OVERSCAN  → windowStart clamped to 0 (top): spacer is pinned to
	 *     0, so scrollTop must equal D * ROW_HEIGHT (same as exact mode).
	 *   - D > OVERSCAN  → windowStart clamped to the bottom: spacer is pinned
	 *     to its max, so scrollTop = spacerMax + D * ROW_HEIGHT.
	 *   - D === OVERSCAN → the normal, unclamped case. Any scrollTop whose
	 *     spacer value lands strictly between 0 and spacerMax keeps the row
	 *     at the viewport top, so we use the proportional fraction (for
	 *     read-back consistency with wheel scrolling afterward) but CLAMP it
	 *     into that valid band so it doesn't silently floor to the spacer's
	 *     0 clamp on a huge sheet.
	 */
	function computeLandingScrollTop(visualIdx: number, windowStart: number, containerHeight: number): number {
		if (!isProportional) return visualIdx * ROW_HEIGHT;
		const d = visualIdx - windowStart;
		const overscanPx = OVERSCAN * ROW_HEIGHT;
		const spacerMax = Math.max(0, virtualHeight - RENDER_SIZE * ROW_HEIGHT);
		if (d < OVERSCAN) return d * ROW_HEIGHT;
		if (d > OVERSCAN) return spacerMax + d * ROW_HEIGHT;
		const proportional = rowIndexToScrollTop(visualIdx, containerHeight);
		return Math.min(overscanPx + spacerMax, Math.max(overscanPx, proportional));
	}

	// In proportional mode, anchor the top spacer to the LIVE scrollTop (minus the
	// overscan rows rendered above the first visible row) instead of re-deriving a
	// fraction from windowStart — the two never agree exactly, which left a black
	// band at the top of the viewport after a fast scrollbar drag.
	const overscanPx = OVERSCAN * ROW_HEIGHT;
	const topSpacerPx = $derived(
		!isProportional
			? windowStart * ROW_HEIGHT
			: Math.max(0, Math.min(scrollTopPx - overscanPx, virtualHeight - RENDER_SIZE * ROW_HEIGHT))
	);
	const bottomSpacerPx = $derived(
		!isProportional
			? Math.max(0, (totalBuffered - windowStart - RENDER_SIZE) * ROW_HEIGHT)
			: Math.max(0, virtualHeight - topSpacerPx - RENDER_SIZE * ROW_HEIGHT)
	);


	// Scroll handling — coalesce (never DROP) scroll events. The previous version
	// bailed out while a frame was pending, so the final position of a fast
	// flick / momentum scroll was never read and the empty spacer rows showed as
	// a black gap. We now re-read the CURRENT scrollTop inside the rAF and run a
	// "settle" pass so the window converges on wherever the scroll stopped.
	let rafPending = false;
	let scrollEl: HTMLDivElement | null = null;
	// Last horizontal scroll position. A scroll event whose scrollLeft changed is
	// a SIDEWAYS scroll (horizontal scrollbar drag, shift-wheel, trackpad pan); we
	// must not move the row window for it — in proportional mode even a 1px
	// incidental vertical drift maps to many rows, so the rows "snapped far away"
	// when the user only scrolled sideways. Starts at 0 (the initial DOM value) so
	// a first PURE-vertical scroll isn't misread as horizontal.
	let lastSeenScrollLeft = 0;
	// One-shot guard used by note jumps. Programmatic scrollTop writes fire

	// the normal scroll handler; this preserves the exact target window for that
	// synthetic scroll frame so the rendered rows do not settle a few rows off.
	let programmaticWindowStart = $state<number | null>(null);
	let scrollLockUntil = 0;
	let lockedScrollTop = 0;
	const SCROLL_LOCK_MS = 400;



	// Single source of truth for "what row is the wheel handler currently
	// on". Jumps (row-jump box, note-pin) set this to the EXACT target row
	// directly — no formula involved. Native scroll (scrollbar drag,
	// keyboard) updates it via the plain scrollTopToRowIndex formula below,
	// which is self-consistent for that path. handleWheel reads AND writes
	// this instead of re-deriving from scrollTop, because a jump's landing
	// scrollTop is computed by computeLandingScrollTop — a BOUNDARY-AWARE
	// formula that deliberately diverges from the plain scrollTopToRowIndex
	// fraction in clamped regions (and whenever the natural fraction value
	// is smaller than the overscan offset, which is common for any
	// mid-sheet target on a huge sheet). Re-deriving "current row" from
	// scrollTop via the plain formula right after such a jump decoded to a
	// WILDLY different row than the one just landed on — e.g. jump to row
	// 1000 decoded back to ~row 1900 — so the very first wheel tick computed
	// its step from the wrong starting point and appeared to "jump" from
	// 1000 to ~2000. Tracking the exact row explicitly avoids this mismatch.
	let lastKnownRowIndex = 0;

	function applyScrollWindow() {
		if (!scrollEl) return;
		// Record live scrollTop so the top spacer anchors to the real viewport.
		scrollTopPx = scrollEl.scrollTop;
		const rowIdx = scrollTopToRowIndex(scrollEl.scrollTop, scrollEl.clientHeight);
		lastKnownRowIndex = rowIdx;
		const desired = Math.max(0, rowIdx - OVERSCAN);
		const clamped = Math.min(desired, Math.max(0, totalBuffered - RENDER_SIZE));
		if (clamped !== windowStart) windowStart = clamped;
	}

	const MAX_WHEEL_ROW_STEP = 3;
	// Minimum |deltaPx| required to move even 1 row. A trackpad's inertial
	// "coast" after lifting your fingers doesn't stop abruptly — the OS keeps
	// firing wheel events with DECAYING deltaY for roughly 0.5-1.5s, trailing
	// toward zero. Without a floor, every one of those tiny tail-end events
	// still moves at least 1 row, so a single flick produces dozens-to-
	// hundreds of 1-row steps in a row — "it keeps scrolling for a long
	// time" even though no single step is large. Dropping sub-threshold
	// events lets the decaying tail fizzle out quickly. Deliberate wheel
	// ticks are well above this; only the fading tail end falls below it.
	const MIN_WHEEL_DELTA_PX = 4;
	// A single continuous trackpad swipe fires wheel events at ~60-120Hz for
	// as long as the finger is moving (plus the momentum tail afterward) —
	// MUCH more frequently than discrete mouse-wheel "ticks". A SLIDING
	// rolling-window cap (tried previously) only limits the RATE, so a long
	// swipe still crawls indefinitely at that rate and can cover hundreds of
	// rows over a couple of seconds — still felt like "way too much."
	//
	// Fix: cap each GESTURE (one continuous run of wheel events with no gap
	// longer than WHEEL_GESTURE_GAP_MS between them) to a hard MAXIMUM
	// DURATION. Once a gesture has been moving the view for longer than
	// MAX_GESTURE_MS, further events in that SAME gesture are dropped
	// entirely — no more movement — until the user pauses (a gap longer
	// than WHEEL_GESTURE_GAP_MS) and starts a NEW gesture. This bounds the
	// total distance a single swipe can ever cover to a small, predictable
	// amount, rather than letting it crawl for as long as the finger moves.
	const WHEEL_GESTURE_GAP_MS = 100; // pause longer than this = new gesture
	const MAX_GESTURE_MS = 300;       // hard cutoff for one continuous gesture
	let gestureStartTime = 0;
	let lastWheelEventTime = 0;
	/**
	 * Wheel scroll, throttled in BOTH proportional AND exact mode.
	 *
	 * Proportional mode: the virtual scroll height is capped at
	 * MAX_SCROLL_PX, so scrollTopToRowIndex's fraction math maps a single
	 * pixel of scrollTop to MANY rows once a sheet has hundreds of
	 * thousands of rows — e.g. on a 500k-row sheet, 1px ≈ 10 rows. A normal
	 * wheel/trackpad scroll's native pixel delta (never mind its momentum
	 * tail) could therefore fling the view thousands of rows away from
	 * where the user was looking — reported as "select row 800, then
	 * scroll, and it jumps far away."
	 *
	 * Exact mode: 1 row is exactly ROW_HEIGHT px, so there's no fraction
	 * amplification — but a fast wheel/trackpad flick can still cover
	 * several thousand real pixels in one gesture, which at ROW_HEIGHT
	 * px/row is still 1000+ rows ("can jump from row 1000 to 2000
	 * instantly in the middle of a spreadsheet"). The native browser
	 * scroll has no row-count awareness at all, so it needs the SAME
	 * throttle as proportional mode, just without the fraction conversion.
	 *
	 * Fix: take over wheel scrolling entirely in both modes.
	 * preventDefault() stops the browser's native (unthrottled) scroll
	 * from running at all. We instead step the CURRENT row index by a
	 * small, capped amount (further throttled by the rolling window
	 * above) and convert that back to an exact scrollTop — so even a
	 * fast, sustained swipe (many capped events firing in succession) can
	 * never jump more than a bounded total distance, regardless of sheet
	 * size or mode.
	 */
	function handleWheel(e: WheelEvent) {
		if (!scrollEl || totalBuffered === 0) return;
		if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // sideways — let it pass through natively

		// Deliberate wheel input always wins over a prior jump's scroll lock.
		programmaticWindowStart = null;

		let deltaPx = e.deltaY;
		if (e.deltaMode === 1) deltaPx *= ROW_HEIGHT;
		else if (e.deltaMode === 2) deltaPx *= scrollEl.clientHeight;
		if (deltaPx === 0) return;
		if (Math.abs(deltaPx) < MIN_WHEEL_DELTA_PX) return;

		e.preventDefault();

		const now = performance.now();
		// A gap longer than WHEEL_GESTURE_GAP_MS since the last wheel event
		// means the finger lifted (or a mouse-wheel tick was isolated) —
		// this event starts a BRAND NEW gesture with a fresh time budget.
		if (now - lastWheelEventTime > WHEEL_GESTURE_GAP_MS) {
			gestureStartTime = now;
		}
		lastWheelEventTime = now;
		// Hard cutoff: this gesture has already been moving the view for
		// longer than MAX_GESTURE_MS — stop granting it any more movement,
		// no matter how many more wheel events arrive, until it pauses and
		// a new gesture begins.
		if (now - gestureStartTime > MAX_GESTURE_MS) return;

		const rawRows = deltaPx / ROW_HEIGHT;
		const rowStep =
			Math.sign(rawRows) * Math.min(MAX_WHEEL_ROW_STEP, Math.max(1, Math.round(Math.abs(rawRows))));

		// Step from lastKnownRowIndex, NOT a fresh re-derivation via
		// scrollTopToRowIndex(scrollEl.scrollTop, ...) — see its doc comment
		// for why that round-trip disagrees with a jump's landing scrollTop.
		const targetRowIdx = Math.max(0, Math.min(lastKnownRowIndex + rowStep, totalBuffered - 1));
		lastKnownRowIndex = targetRowIdx;

		scrollEl.scrollTop = rowIndexToScrollTop(targetRowIdx, scrollEl.clientHeight);
	}

	/**
	 * Svelte action: attach `wheel` as a NON-PASSIVE native listener.
	 * Svelte 5's `onwheel={...}` attribute binds the listener as PASSIVE, so
	 * preventDefault() would silently no-op (see
	 * https://github.com/sveltejs/svelte/issues/15066). Also assigns
	 * `scrollEl` on mount so a wheel event on a freshly-opened sheet always
	 * finds a non-null scrollEl.
	 */
	function nonPassiveWheel(node: HTMLElement, handler: (e: WheelEvent) => void) {
		scrollEl = node as HTMLDivElement;
		node.addEventListener('wheel', handler, { passive: false });
		return {
			destroy() {
				node.removeEventListener('wheel', handler);
			}
		};
	}

	function handleTableScroll(e: Event) {
		scrollEl = e.currentTarget as HTMLDivElement;
		// Note-jump scroll lock. While active, HOLD the window at the jump target
		// and only re-anchor the spacer to the live scrollTop. This swallows the
		// synthetic scroll events the jump's scrollTop assignment fires AND any
		// residual momentum from a prior flick, so neither can drag the rendered
		// block off the row — the "keeps flinging down after the highlight" bug.
		if (programmaticWindowStart !== null) {
			if (performance.now() < scrollLockUntil) {
				windowStart = programmaticWindowStart;
				// Re-assert the landing scrollTop. Writing scrollTop cancels the
				// browser's in-flight inertial (momentum) scroll, so a flick that
				// was still decelerating when the jump fired can't carry the view
				// past the row. Only write when it actually drifted (avoids a
				// pointless event storm).
				if (Math.abs(scrollEl.scrollTop - lockedScrollTop) > 0.5) {
					scrollEl.scrollTop = lockedScrollTop;
				}
				scrollTopPx = lockedScrollTop;
				return;
			}
			// Lock expired — release and resume normal windowing.
			programmaticWindowStart = null;
		}
		// Detect a SIDEWAYS scroll synchronously, at event time. If scrollLeft
		// changed, this event is a horizontal scroll (scrollbar drag, shift-wheel,
		// trackpad pan) — do NOT move the row window. We decide this HERE, not in
		// the rAF, because the settle pass calls applyScrollWindow twice and the
		// second call would otherwise re-derive rows from any incidental vertical
		// drift (which proportional mode amplifies into a huge jump).
		const sl = scrollEl.scrollLeft;
		if (sl !== lastSeenScrollLeft) {
			lastSeenScrollLeft = sl;
			// Keep the spacer anchored to the live scrollTop so no black band
			// appears, but leave windowStart (the rendered rows) untouched.
			scrollTopPx = scrollEl.scrollTop;
			return;
		}
		if (rafPending) return;
		rafPending = true;
		requestAnimationFrame(() => {
			rafPending = false;
			applyScrollWindow();
			requestAnimationFrame(() => {
				applyScrollWindow();
			});
		});
	}



	// Reset scroll + clear sort/filter when the active sheet changes. A sort or
	// filter set against one sheet's columns is meaningless on another sheet, so
	// we clear the shared store state on every sheet switch.
	let lastSheet = $state('');
	$effect(() => {
		if (sheet && sheet.name !== lastSheet) {
			lastSheet = sheet.name;
			windowStart = 0;
			workspace.clearActiveSort();
			workspace.clearActiveFilter();
			// Stamp rows with their original sheet index (__rowIdx__) so note
			// anchors stay stable across sort/filter. Only stamp once per sheet
			// (if already set, skip to keep it O(1) on repeated visits).
			const r = workspace.currentRows;
			for (let i = 0; i < r.length; i++) {
				if ((r[i] as Record<string, unknown>).__rowIdx__ === undefined) {
					(r[i] as Record<string, unknown>).__rowIdx__ = i;
				}
			}
		}
	});


	// Reset the virtual-scroll window to the top whenever the active filter or
	// sort changes. Without this, applying a filter while scrolled down leaves
	// visibleRows = sortedRows.slice(windowStart, …) pointing past the (smaller)
	// filtered result — so the pane looks blank even though rows matched
	// ("the filter is applied but it's not visible"). Snap the window and the
	// real DOM scrollTop back to 0 so matches are shown immediately.
	$effect(() => {
		void workspace.activeFilter;
		void workspace.activeSort;
		windowStart = 0;
		scrollTopPx = 0;
		if (scrollEl) scrollEl.scrollTop = 0;
	});


	// ── Cell notes — pin overlay + scroll-to-cell ──────────────────────────
	// NotesMode is the single source of truth for whether the pin overlay is
	// visible. The pin itself is a small yellow dot in the cell's top-right
	// corner (rendered inside the <td> below). The pin shows the note's
	// number in the bubble list; for the rare case of 2+ notes on one cell,
	// the count is shown instead.
	const showCellPins = $derived(workspace.notesMode);

	/** Per-cell note count for the current sheet, keyed by `${col}\0${rowIndex}`.
	 *  Only cells with at least one note appear in the map. Recomputed when
	 *  the note list changes. O(n) over the note list — cheap; per-file note
	 *  count is small (tens, not thousands). */
	const cellNoteCounts = $derived.by<Map<string, number>>(() => {
		const out = new Map<string, number>();
		const sheetName = sheet?.name ?? '';
		for (const n of notesStore.notes) {
			if (n.anchor.kind !== 'cell') continue;
			if (n.anchor.sheet !== sheetName) continue;
			if (n.anchor.rowIndex < 0) continue; // column-level notes render in the header, not the cell
			const key = `${n.anchor.column}\0${n.anchor.rowIndex}`;
			out.set(key, (out.get(key) ?? 0) + 1);
		}
		return out;
	});

	/** Per-column note count (column-level notes with rowIndex = -1). */
	const columnNoteCounts = $derived.by<Map<string, number>>(() => {
		const out = new Map<string, number>();
		const sheetName = sheet?.name ?? '';
		for (const n of notesStore.notes) {
			if (n.anchor.kind !== 'cell') continue;
			if (n.anchor.sheet !== sheetName) continue;
			if (n.anchor.rowIndex !== -1) continue;
			out.set(n.anchor.column, (out.get(n.anchor.column) ?? 0) + 1);
		}
		return out;
	});

	/**
	 * First-note-id map. The pin shows the COUNT; clicking it needs a specific
	 * id to focus. We store the first note's id per cell and per column. If
	 * the cell has multiple notes, the pin click takes the user to note #1
	 * and they click the others in the bubble list to switch.
	 */
	const cellNoteFirstId = $derived.by<Map<string, string>>(() => {
		const out = new Map<string, string>();
		const sheetName = sheet?.name ?? '';
		for (const n of notesStore.notes) {
			if (n.anchor.kind !== 'cell') continue;
			if (n.anchor.sheet !== sheetName) continue;
			if (n.anchor.rowIndex < 0) continue;
			const key = `${n.anchor.column}\0${n.anchor.rowIndex}`;
			if (!out.has(key)) out.set(key, n.id);
		}
		return out;
	});
	const columnNoteFirstId = $derived.by<Map<string, string>>(() => {
		const out = new Map<string, string>();
		const sheetName = sheet?.name ?? '';
		for (const n of notesStore.notes) {
			if (n.anchor.kind !== 'cell') continue;
			if (n.anchor.sheet !== sheetName) continue;
			if (n.anchor.rowIndex !== -1) continue;
			if (!out.has(n.anchor.column)) out.set(n.anchor.column, n.id);
		}
		return out;
	});

	/**
	 * Per-cell "pane number" — the 1-based index this cell's FIRST note has
	 * in the NotesPane bubble list. The NotesPane numbers EVERY bubble by its
	 * GLOBAL position in notesStore.notes (i + 1), across all sheets and both
	 * anchor kinds. The pin MUST use that same global index so a note that
	 * shows "2" in the pane also shows "2" on its pin.
	 *
	 * A previous version counted a SEPARATE per-sheet index here, which made the
	 * pins disagree with the pane: a note that was #2 in the pane (because an
	 * earlier note lives on another sheet, or sorts ahead of it) showed "1" on
	 * its pin. We now mirror DocumentPane exactly — use the global enumeration
	 * index — and just filter to THIS sheet so we only emit pins for cells that
	 * are actually on screen.
	 */
	const cellNotePaneNumber = $derived.by<Map<string, number>>(() => {
		const out = new Map<string, number>();
		const sheetName = sheet?.name ?? '';
		notesStore.notes.forEach((n, i) => {
			if (n.anchor.kind !== 'cell') return;
			if (n.anchor.sheet !== sheetName) return;
			if (n.anchor.rowIndex < 0) return;
			const key = `${n.anchor.column}\0${n.anchor.rowIndex}`;
			if (!out.has(key)) out.set(key, i + 1); // global index → matches NotesPane bubble number
		});
		return out;
	});
	const columnNotePaneNumber = $derived.by<Map<string, number>>(() => {
		const out = new Map<string, number>();
		const sheetName = sheet?.name ?? '';
		notesStore.notes.forEach((n, i) => {
			if (n.anchor.kind !== 'cell') return;
			if (n.anchor.sheet !== sheetName) return;
			if (n.anchor.rowIndex !== -1) return;
			if (!out.has(n.anchor.column)) out.set(n.anchor.column, i + 1); // global index
		});
		return out;
	});

	/** Currently highlighted cell (after a scroll-to-cell effect). Drives the
	 *  brief ring on the cell. Cleared automatically after HIGHLIGHT_MS. */
	let highlightKey = $state<string | null>(null);
	let highlightTimer: ReturnType<typeof setTimeout> | null = null;
	const HIGHLIGHT_MS = 1400;

	function flashHighlight(col: string, rowIndex: number) {
		const key = `${col}\0${rowIndex}`;
		highlightKey = key;
		if (highlightTimer) clearTimeout(highlightTimer);
		highlightTimer = setTimeout(() => { highlightKey = null; highlightTimer = null; }, HIGHLIGHT_MS);
	}

	/** Consume workspace.scrollToCell. Resolves the stored original row index
	 *  (__rowIdx__) to the current display position in sortedRows so the scroll
	 *  lands on the correct row even when filter/sort is active. */
	$effect(() => {
		const target = workspace.scrollToCell;
		if (!target) return;
		// Only honor signals aimed at THIS sheet.
		if (target.sheet !== (sheet?.name ?? '')) return;

		// Resolve original sheet row index → current display position.
		// sortedRows[i].__rowIdx__ holds the original index stamped at sheet
		// activation. Falls back to treating rowIndex as a display index for
		// legacy notes created before the stamp was introduced.
		let visualIdx = sortedRows.findIndex(
			(r) => (r as Record<string, unknown>).__rowIdx__ === target.rowIndex
		);
		if (visualIdx === -1) {
			if (workspace.activeFilter) {
				// Row is filtered out — clear the filter; effect re-runs with all rows.
				workspace.clearActiveFilter();
				return; // don't clear signal; re-run will find the row
			}
			// No filter active but __rowIdx__ not found: fall back to raw index.
			visualIdx = Math.min(target.rowIndex, sortedRows.length - 1);
		}

		// New approach: render the target row into the virtual window, then
		// scroll the REAL <tr> element into view. Native scrollIntoView is
		// pixel-exact in BOTH exact-pixel and proportional (capped) modes, so it
		// avoids the fraction-math drift that mis-placed deep rows. The previous
		// approach set scrollTop = fraction * maxScrollTop, which is only an
		// approximation once the content exceeds the 50k-px virtual-height cap.
		const clamped = Math.min(
			Math.max(0, visualIdx - OVERSCAN),
			Math.max(0, totalBuffered - RENDER_SIZE)
		);
		programmaticWindowStart = clamped;
		windowStart = clamped;
		// Pre-anchor the proportional-mode spacer near the target so the rendered
		// block is already close before we measure (prevents a one-frame flash).
		// Use computeLandingScrollTop (not a naive `clamped * ROW_HEIGHT`) so
		// scrollTop stays mathematically consistent with wherever the spacer
		// clamp actually renders the row, in ALL regions (top/bottom-clamped
		// windowStart included) — see its doc comment for the full rationale.
		const preAnchor = computeLandingScrollTop(visualIdx, clamped, scrollEl?.clientHeight ?? 0);
		scrollTopPx = preAnchor;
		// Arm the scroll lock RIGHT NOW — before scrollRowIntoView's tick()/rAF
		// gap. If the user flicked the scrollbar and THEN clicked a note, the
		// momentum is still firing scroll events. Without an already-armed lock,
		// one of those events lands in the gap, sees the lock expired, nulls
		// programmaticWindowStart, and recomputes windowStart from the OLD scroll
		// position — so the target row is never rendered and querySelector can't
		// find it (the "won't snap unless started from the top" bug). Holding the
		// window at `clamped` through the gap keeps the row in the DOM.
		lockedScrollTop = preAnchor;
		scrollLockUntil = performance.now() + SCROLL_LOCK_MS;
		const col = target.column;
		workspace.clearScrollToCell();
		void scrollRowIntoView(visualIdx, col, clamped);
	});

	/** Phase 2 of the note jump: after the virtual window has rendered the
	 *  target row, position it via a SINGLE direct scrollTop assignment (no
	 *  scrollIntoView). scrollIntoView animates and, in proportional mode, chases
	 *  the rendered block as the spacer re-anchors — which is exactly the "keeps
	 *  flinging down" symptom. A one-shot scrollTop set is instant, and the
	 *  scroll lock (below) holds the window fixed so the synthetic scroll events
	 *  it fires — plus any leftover momentum — can't drag us off the row. */
	async function scrollRowIntoView(visualIdx: number, col: string, clamped: number) {
		// Wait for Svelte to flush the windowStart change, then one more frame so
		// layout (spacer heights) has settled before we measure the row.
		await tick();
		await new Promise((r) => requestAnimationFrame(() => r(null)));
		const el = scrollEl?.querySelector(
			`tr[data-rowidx="${visualIdx}"]`
		) as HTMLElement | null;
		if (el && scrollEl) {
			// Engage the lock BEFORE we move, so the scroll events this assignment
			// fires are absorbed (window held at `clamped`, no recompute/drift).
			programmaticWindowStart = clamped;
			scrollLockUntil = performance.now() + SCROLL_LOCK_MS;
			let finalTop: number;
			if (isProportional) {
				// Centering via `elTop - halfClientHeight` subtracts a REAL pixel
				// amount (~300-400px) which doesn't round-trip through the
				// compressed proportional fraction — it corrupted scrollTop enough
				// that the NEXT scroll/wheel event computed a wildly wrong row and
				// jumped far away. Use the round-trip-consistent formula instead;
				// the OVERSCAN buffer still keeps the row inside the rendered window.
				finalTop = computeLandingScrollTop(visualIdx, clamped, scrollEl.clientHeight);
			} else {
				// Center the row using its live offset within the scroll content.
				const elTop = el.offsetTop;
				const target = elTop - Math.max(0, (scrollEl.clientHeight - ROW_HEIGHT) / 2);
				const maxST = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
				finalTop = Math.max(0, Math.min(target, maxST));
			}
			scrollEl.scrollTop = finalTop;
			scrollTopPx = finalTop;
			lockedScrollTop = finalTop; // re-asserted during the lock to kill momentum
			// Record the EXACT row just landed on — not re-derived via the
			// plain fraction formula, which would disagree with finalTop in
			// proportional mode (see lastKnownRowIndex's doc comment above).
			lastKnownRowIndex = visualIdx;
		}
		flashHighlight(col, visualIdx);
	}

	// ── "Row [n] / total" jump control (sheet info bar toolbar) ─────────────
	// Independent of the note-pin scrollToCell signal above — this is a
	// direct, local UI interaction (type a row number, land there), styled
	// after PdfViewer's "Page [n] / numPages" control. Deliberately uses
	// VISUAL/display row position (current sortedRows order, post sort/filter)
	// rather than the stable __rowIdx__ file-origin index that scrollToCell
	// resolves — "row 42" means "the 42nd row you can currently see," so no
	// filter-clearing dance is needed the way the note-jump signal requires.
	/** The row-jump input's own value — null when the field is empty mid-edit. */
	let rowJumpValue = $state<number | null>(1);

	function commitRowJump() {
		if (rowJumpValue === null || !Number.isFinite(rowJumpValue) || totalBuffered === 0) {
			rowJumpValue = null;
			return;
		}
		// 1-based input → 0-based visual index, clamped into range.
		const visualIdx = Math.max(0, Math.min(Math.round(rowJumpValue) - 1, totalBuffered - 1));
		rowJumpValue = visualIdx + 1; // reflect the clamped value back into the input
		const clamped = Math.min(
			Math.max(0, visualIdx - OVERSCAN),
			Math.max(0, totalBuffered - RENDER_SIZE)
		);
		programmaticWindowStart = clamped;
		windowStart = clamped;
		// See the identical note in the scrollToCell effect above —
		// computeLandingScrollTop keeps scrollTop consistent with the spacer
		// clamp in all regions (top/bottom-clamped windowStart included).
		const preAnchor = computeLandingScrollTop(visualIdx, clamped, scrollEl?.clientHeight ?? 0);
		scrollTopPx = preAnchor;
		lockedScrollTop = preAnchor;
		scrollLockUntil = performance.now() + SCROLL_LOCK_MS;
		// flashHighlight() needs a column to key the highlight ring on — there's
		// no "selected" column for a pure row jump, so flash the first column as
		// a visible "you landed here" confirmation, matching the note-jump flash.
		const col = columns[0] ?? '';
		void scrollRowIntoView(visualIdx, col, clamped);
	}

	function handleRowJumpKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			(e.target as HTMLInputElement).blur();
		}
	}



	/** Click handler for a pin: open the Notes pane (if not already open)
	 *  and scroll/focus the matching note bubble. Notes is gated by
	 *  `workspace.openPane` (single slot). Same one-liner pattern the
	 *  cell-context-menu "Add note" action uses. */
	function onPinClick(noteId: string) {
		if (workspace.openPane?.kind !== 'notes') {
			workspace.openNotesPane();
		}
		workspace.requestFocusNote(noteId);
	}

	/** Handle to the mounted FilterBar instance, so the toolbar's "Filter"
	 *  button (below) can trigger "+ Add condition" the same way the CSV
	 *  path's own Filter button does — see FilterBar's addConditionExternal(). */
	let filterBarRef = $state<{ addConditionExternal: () => void } | null>(null);

</script>

<div class="flex flex-col h-full bg-surface dark:bg-slate-950 overflow-hidden">
	{#if !workbook || !sheet}
		<!-- EMPTY / LOADING STATE -->
		<div class="h-full flex items-center justify-center">
			{#if workbook && !sheet}
				<p class="text-xs text-gray-400 dark:text-gray-600 p-4">This workbook has no sheets.</p>
			{:else}
				<LoadingSpinner size="md" message="No workbook loaded." />
			{/if}
		</div>
	{:else}
		<!-- Sheet tabs (hidden for single-sheet workbooks) -->
		<SheetTabs
			sheets={workbook.sheets}
			activeSheet={workspace.activeSheet}
			onSelect={(name) => workspace.setActiveSheet(name)}
		/>

		<!-- Sheet info bar -->
		<div class="flex items-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-slate-800 bg-surface dark:bg-slate-900 flex-shrink-0">
			<span class="text-sm text-gray-700 dark:text-gray-300 font-medium truncate flex-1">{sheet.name}</span>
			<span class="text-xs text-gray-400 dark:text-gray-600 flex-shrink-0 tabular-nums flex items-center gap-1.5">
				{#if sheet.isSampled && sheet.rowCount > rows.length}
					<span class="text-amber-500" title="Column statistics were computed from all {sheet.rowCount.toLocaleString()} rows.">
						Displaying {rows.length.toLocaleString()} of {sheet.rowCount.toLocaleString()} rows · Stats reflect all rows
					</span>
				{:else}
					{rows.length.toLocaleString()} rows
				{/if}
				· {columns.length} cols
			</span>

			{#if sort}
				<button
					onclick={() => workspace.clearActiveSort()}
					class="text-xs text-violet-700 hover:text-violet-900 dark:text-violet-500 dark:hover:text-violet-300 px-2 py-0.5 rounded border border-violet-400 dark:border-violet-800 hover:border-violet-600"
				>Clear sort ({sort.direction === 'asc' ? '▲' : '▼'} {sort.column})</button>
			{/if}

			<!-- "Row [n] / total" jump control — sits immediately LEFT of the
			     Filter button, matching the CSV path's identical control in
			     DocumentPane.svelte. Uses VISUAL row position (current
			     sortedRows order, post sort/filter) — see commitRowJump()'s
			     doc comment. Commits on Enter or blur, NOT on every keystroke;
			     out-of-range input is silently clamped — same UX as
			     PdfViewer's page-jump control and the CSV path's row-jump. -->
			{#if totalBuffered > 0}
				<label class="flex-shrink-0 inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
					<span class="uppercase tracking-wide text-[10px]">Row</span>
					<input
						type="number"
						min="1"
						max={totalBuffered}
						bind:value={rowJumpValue}
						onkeydown={handleRowJumpKeydown}
						onblur={commitRowJump}
						class="w-16 bg-gray-100 border border-gray-300 text-gray-800 dark:bg-slate-800 dark:border-slate-700 dark:text-gray-200 rounded px-1 py-0.5 text-xs text-center tabular-nums focus:outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
						aria-label="Jump to row (1 to {totalBuffered})"
						title="Jump to a row — press Enter or click away to go"
					/>
					<span class="tabular-nums">/ {totalBuffered.toLocaleString()}</span>
				</label>
			{/if}

			<!-- Manual filter trigger — adds a condition row WITHOUT any LLM
			     call, matching the CSV path's identical "Filter" button in
			     DocumentPane.svelte. Notes viewing lives solely in the
			     header's Chat/Notes tab (both drive the same
			     workspace.openPane slot; a dedicated button here would just
			     duplicate it). -->
			<button
				type="button"
				onclick={() => filterBarRef?.addConditionExternal()}
				class="flex-shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-amber-600/60 text-amber-700 hover:text-amber-900 hover:border-amber-500 hover:bg-amber-100 dark:border-amber-700/60 dark:text-amber-300 dark:hover:text-amber-100 dark:hover:bg-amber-900/30 transition-colors"
				title="Add a filter condition"
			>
				<span aria-hidden="true">🔍</span> Filter
			</button>

		</div>

		<!-- Filter bar (Excel path) — same component DocumentPane uses on
		     the CSV path. Edits publish back to workspace.activeFilter.
		     The FilterBar is internally AND-only and supports the
		     'outside' op natively (renders as "↔ outside [lo, hi]"). -->
		<FilterBar bind:this={filterBarRef} columns={columns} rows={rows} matchCount={filteredRows.length} />

		<!-- Table -->

		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<div class="flex-1 csv-scroll-container overflow-auto" onscroll={handleTableScroll} use:nonPassiveWheel={handleWheel} role="region" aria-label="{sheet.name} data table">
			{#if columns.length === 0}
				<p class="text-xs text-gray-400 dark:text-gray-600 p-4">This sheet has no columns.</p>
			{:else}
				<table class="w-full text-xs border-collapse">
					<thead class="sticky top-0 z-10">
						<tr class="bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800">
							<th class="w-10 px-2 py-2.5 text-center text-gray-400 dark:text-gray-600 font-normal border-r border-gray-200 dark:border-slate-800 select-none">#</th>
							{#each columns as col}
								{@const sortState = sort?.column === col ? sort.direction : null}
								{@const prof = profileFor(col)}
								{@const colNotes = columnNoteCounts.get(col) ?? 0}
								<th
									class="px-3 py-2 text-left font-semibold whitespace-nowrap select-none transition-colors
										{sortState ? 'text-violet-700 bg-violet-100 dark:text-violet-300 dark:bg-violet-950/30' : selectedColumn === col ? 'text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-950/40' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-slate-800/60'}"
									oncontextmenu={(e) => openMenu(e, { kind: 'column', column: col, columns, sheet: sheet?.name })}
								>

									<div class="flex flex-col gap-1">
										<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
										<span
											class="inline-flex items-center gap-1 cursor-pointer"
											title="Sort by {col}"
											onclick={(e) => { e.stopPropagation(); handleHeaderClick(col); }}
										>
											{col}
											{#if sortState === 'asc'}<span class="text-violet-400 text-[10px]">▲</span>
											{:else if sortState === 'desc'}<span class="text-violet-400 text-[10px]">▼</span>{/if}
											{#if showCellPins && colNotes > 0}
												{@const colFirstId = columnNoteFirstId.get(col)}
												{@const colPaneNum = columnNotePaneNumber.get(col)}
												{#if colFirstId && colPaneNum !== undefined}
													<span
														class="cell-note-pin cell-note-pin--column"
														role="button"
														tabindex="0"
														title="{colNotes} column note{colNotes === 1 ? '' : 's'} (note #{colPaneNum} in pane for this sheet)"
														aria-label="Open column note{colNotes === 1 ? '' : 's'} for {col} (note {colPaneNum} in pane)"
														onclick={(e) => { e.stopPropagation(); onPinClick(colFirstId); }}
														onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPinClick(colFirstId); } }}
													>{colPaneNum}</span>
												{/if}
											{/if}
										</span>
										<!-- Per-sheet column profile badge -->
										{#if prof}
											{@const p = prof as unknown as { type?: string; uniqueCount?: number; mean?: number; min?: number; max?: number }}
											<button
												type="button"
												onclick={(e) => { e.stopPropagation(); selectColumn(col); }}
												class="self-start rounded px-1 py-0.5 text-[9px] font-normal lowercase tracking-wide
													{p.type === 'numeric'
														? 'bg-emerald-100 text-emerald-700 border border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-400 dark:border-emerald-900'
														: 'bg-sky-100 text-sky-700 border border-sky-300 dark:bg-sky-950/50 dark:text-sky-400 dark:border-sky-900'}"
												title={p.type === 'numeric'
													? `numeric · mean ${p.mean?.toFixed?.(1) ?? '—'} · min ${p.min ?? '—'} · max ${p.max ?? '—'}`
													: `categorical · ${p.uniqueCount ?? '—'} unique`}
											>
												{#if p.type === 'numeric'}
													123 {p.mean !== undefined ? `μ${p.mean.toFixed(0)}` : ''}
												{:else}
													abc {p.uniqueCount !== undefined ? `${p.uniqueCount}u` : ''}
												{/if}
											</button>
										{/if}
									</div>
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#if topSpacerPx > 0}
							<tr style="height: {topSpacerPx}px;"><td colspan={columns.length + 1}></td></tr>
						{/if}

						{#each visibleRows as row, i}
							{@const absIdx = windowStart + i}
							<!-- rowOrigIdx: stable original sheet index (__rowIdx__ stamped at
							     sheet activation). Note anchors are keyed by this value, not
							     absIdx, so pins and highlight rings resolve correctly after
							     sort/filter changes the display order. -->
							{@const rowOrigIdx = typeof (row as Record<string, unknown>).__rowIdx__ === 'number'
								? (row as Record<string, unknown>).__rowIdx__ as number
								: absIdx}
							<tr
								data-rowidx={absIdx}
								class="border-b border-gray-100 dark:border-slate-900 hover:bg-gray-50 dark:hover:bg-slate-900/60 transition-colors cursor-pointer group csv-row"
								onclick={() => selectRow(absIdx, row as Record<string, unknown>)}
							>
								<td
									class="px-2 py-1.5 text-center text-gray-400 dark:text-gray-700 border-r border-gray-100 dark:border-slate-900 select-none group-hover:text-gray-500 tabular-nums"
									oncontextmenu={(e) => openMenu(e, { kind: 'row', rowIndex: absIdx, rowData: row as Record<string, unknown>, columns, sheet: sheet?.name })}
								>
									{absIdx + 1}
								</td>
								{#each columns as col}
									{@const cellNotes = cellNoteCounts.get(`${col}\0${rowOrigIdx}`) ?? 0}
									{@const isHighlightedCell = highlightKey === `${col}\0${absIdx}`}
									<td
										class="px-3 py-1.5 text-gray-700 dark:text-gray-300 whitespace-nowrap {selectedColumn === col ? 'bg-blue-50 dark:bg-blue-950/20' : ''} {isHighlightedCell ? 'cell-highlight' : ''} relative"
										onclick={(e) => { e.stopPropagation(); selectCell(col, absIdx, (row as Record<string, unknown>)[col]); }}
										oncontextmenu={(e) => openMenu(e, { kind: 'cell', column: col, value: (row as Record<string, unknown>)[col], rowIndex: absIdx, rowData: row as Record<string, unknown>, columns, sheet: sheet?.name })}
									>
										{(row as Record<string, unknown>)[col] ?? ''}
										{#if showCellPins && cellNotes > 0}
											{@const cellFirstId = cellNoteFirstId.get(`${col}\0${rowOrigIdx}`)}
											{@const cellPaneNum = cellNotePaneNumber.get(`${col}\0${rowOrigIdx}`)}

											{#if cellFirstId && cellPaneNum !== undefined}
												<span
													class="cell-note-pin"
													role="button"
													tabindex="0"
													title="{cellNotes} note{cellNotes === 1 ? '' : 's'} on {col} · row {absIdx + 1} (note #{cellPaneNum} in pane for this sheet)"
													aria-label="Open note{cellNotes === 1 ? '' : 's'} on {col} row {absIdx + 1} (note {cellPaneNum} in pane)"
													onclick={(e) => { e.stopPropagation(); onPinClick(cellFirstId); }}
													onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPinClick(cellFirstId); } }}
												>{cellPaneNum}</span>
											{/if}
										{/if}
									</td>
								{/each}
							</tr>

						{/each}

						{#if bottomSpacerPx > 0}
							<tr style="height: {bottomSpacerPx}px;"><td colspan={columns.length + 1}></td></tr>
						{/if}

						{#if totalBuffered === 0}
							<tr>
								<td colspan={columns.length + 1} class="px-4 py-8 text-center text-gray-400 dark:text-gray-600 text-xs">
									This sheet has no rows.
								</td>
							</tr>
						{/if}
					</tbody>
				</table>
			{/if}
		</div>
	{/if}
</div>

{#if menu}
	<CellContextMenu x={menu.x} y={menu.y} target={menu.target} onClose={closeMenu} />
{/if}

<style>
	:global(.csv-row td) {

		height: 28px;
		max-height: 28px;
		overflow: hidden;
	}

	/* ── Cell-note pin (mirrors the contract view's `note-pin` for parity) ──
	 *
	 * On a tabular cell, the pin is a 14px amber disc in the cell's top-right
	 * corner with the note's number (or count, if 2+ notes on one cell). On a
	 * column header (column-level notes), it's an inline disc next to the
	 * column name — same color and shape, just a different position.
	 *
	 * The pin is ONLY rendered when workspace.notesMode is on (the same toggle
	 * the contract view's pin overlay respects). Toggling notesMode off makes
	 * the dots disappear immediately — the user keeps the data, the visual
	 * clutter goes away.
	 */
	.cell-note-pin {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 14px;
		height: 14px;
		padding: 0 3px;
		border-radius: 9999px;
		background: #fbbf24; /* amber-400 — same as contract pin */
		color: #111827; /* gray-900 — same as contract pin */
		font-size: 9px;
		font-weight: 700;
		line-height: 1;
		box-shadow: 0 0 0 1.5px rgba(15, 23, 42, 0.85); /* halo so it pops on light/dark cells */
		z-index: 2;
		cursor: pointer;
		font-variant-numeric: tabular-nums;
	}

	/* When the pin sits inside a <td> it is positioned absolutely in the
	   top-right corner. The <td> has `position: relative` for this. */
	td.relative .cell-note-pin {
		position: absolute;
		top: 2px;
		left: 2px;
	}

	/* When the pin sits inline in a column header (next to the column name),
	   it's a 16px disc — slightly larger than the cell version since the
	   header is a more visual element. */
	.cell-note-pin--column {
		min-width: 16px;
		height: 16px;
		font-size: 10px;
		padding: 0 4px;
	}

	/* ── Scroll-to-cell highlight ring ─────────────────────────────────────
	 *
	 * When the user clicks a note bubble in NotesPane, the table scrolls to
	 * the matching cell and applies this 1.4s amber ring so the eye lands
	 * on it. Animation keyframes: fade in (40ms), hold, fade out (300ms).
	 */
	.cell-highlight {
		box-shadow: inset 0 0 0 2px #fbbf24; /* amber-400, matches the pin */
		animation: cell-highlight-fade 1.4s ease-out;
	}
	@keyframes cell-highlight-fade {
		0%   { box-shadow: inset 0 0 0 2px rgba(251, 191, 36, 0); background-color: rgba(251, 191, 36, 0.18); }
		15%  { box-shadow: inset 0 0 0 2px rgba(251, 191, 36, 1); background-color: rgba(251, 191, 36, 0.18); }
		100% { box-shadow: inset 0 0 0 2px rgba(251, 191, 36, 0); background-color: rgba(251, 191, 36, 0); }
	}

	.csv-scroll-container::-webkit-scrollbar {
		width: 16px;
		height: 16px;
	}
	.csv-scroll-container::-webkit-scrollbar-track {
		background: #111827;
	}
	.csv-scroll-container::-webkit-scrollbar-thumb {
		background: #4b5563;
		border-radius: 8px;
		border: 3px solid #111827;
	}
	.csv-scroll-container::-webkit-scrollbar-thumb:hover {
		background: #6b7280;
	}
	.csv-scroll-container::-webkit-scrollbar-corner {
		background: #111827;
	}

	/* Light-mode scrollbar override */
	:global(html:not(.dark)) .csv-scroll-container::-webkit-scrollbar-track {
		background: #f9fafb;
	}
	:global(html:not(.dark)) .csv-scroll-container::-webkit-scrollbar-thumb {
		background: #cbd5e1;
		border-color: #f9fafb;
	}
	:global(html:not(.dark)) .csv-scroll-container::-webkit-scrollbar-thumb:hover {
		background: #94a3b8;
	}
	:global(html:not(.dark)) .csv-scroll-container::-webkit-scrollbar-corner {
		background: #f9fafb;
	}
</style>
