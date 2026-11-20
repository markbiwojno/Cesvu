<script lang="ts">
	import { untrack, tick } from 'svelte';
	import { workspace } from '$lib/stores/workspace.svelte.js';

	import FileDropzone from '$lib/components/ui/FileDropzone.svelte';
	import ImportModal from '$lib/components/ImportModal.svelte';

	import LoadingSpinner from '$lib/components/ui/LoadingSpinner.svelte';
	import ErrorBanner from '$lib/components/ui/ErrorBanner.svelte';

	import SpreadsheetViewer from '$lib/components/viewer/SpreadsheetViewer.svelte';
	import PdfViewer from '$lib/components/viewer/PdfViewer.svelte';

	import CellContextMenu from '$lib/components/viewer/CellContextMenu.svelte';
	import type { MenuTarget } from '$lib/components/viewer/cellMenuActions.js';
	import ClauseSplitter from '$lib/components/lenses/ClauseSplitter.svelte';
	import ClauseHighlighter from '$lib/components/lenses/ClauseHighlighter.svelte';
	import DocumentHighlighter from '$lib/components/lenses/DocumentHighlighter.svelte';
	import ClauseSidebar from '$lib/components/lenses/ClauseSidebar.svelte';
	import NotesPane from '$lib/components/lenses/NotesPane.svelte';

	import { isCesvuZip } from '$lib/utils/is-cesvu-zip.js';
	import {
		ROW_HEIGHT,
		keyScrollTarget,
		keyScrollLeftTarget,
		wheelAction,
		horizontalDeltaPx
	} from '$lib/components/viewer/spreadsheet-scroll.js';
	import { scrollLock } from '$lib/stores/scrollLock.svelte.js';
	import { clauseStore } from '$lib/stores/clauseStore.svelte.js';
	import { notesStore } from '$lib/stores/notesStore.svelte.js';

	import { detectLens, type Lens } from '$lib/lenses/detect-lens.js';
	import { buildProfileFromClauses } from '$lib/lenses/contract/build-profile.js';
	import { type Clause } from '$lib/lenses/contract/clause-splitter.js';
	import { getLoadedPipe, runInference } from '$lib/llm/inference.js';


	import type { SplitMode, DocumentSplits, CesvuDocument } from '$lib/schema.js';






	import type { CsvData, StructuredText, ParsedFile } from '$lib/types.js';


	import type { ParsedCsvFile } from '$lib/parsers/csv.js';
	import { evaluate as evalFilterTree } from '$lib/pipeline/filter.js';
	import type { Filter, LeafMatchFn } from '$lib/pipeline/filter.js';
	import { matchesValue } from '$lib/pipeline/valueMatch.js';

	// Bridge the filter tree's leaf comparisons to matchesValue() so compound
	// filters (e.g. "lastupdate = 09/15/2025 AND state = CA") honor the SAME
	// date-serial ⇄ date-string ⇄ numeric equivalence the single-condition path
	// already uses. startsWith/endsWith aren't date-relevant → return false so
	// matchLeaf() falls back to its built-in prefix/suffix logic.
	const leafMatch: LeafMatchFn = (cell, query, op) => {
		if (op === 'eq' || op === 'contains') return matchesValue(cell, query, op);
		return false;
	};

	/**
	 * Synchronous wrapper for the recursive filter tree evaluator.
	 * Handles the '_any_' sentinel column (search all columns).
	 */
	function evaluateFilterTree(
		filter: Filter,
		row: Record<string, unknown>,
		cols: string[]
	): boolean {
		// Patch '_any_' leaf nodes to search all columns
		function patchAny(f: Filter): Filter {
			if ('and' in f) return { and: f.and.map(patchAny) };
			if ('or' in f)  return { or: f.or.map(patchAny) };
			if ('not' in f) return { not: patchAny(f.not) };
			// Leaf
			if ((f as { column: string }).column === '_any_') {
				// Expand to OR across all columns
				return { or: cols.map(c => ({ ...f, column: c })) };
			}
			return f;
		}
		return evalFilterTree(patchAny(filter), row, leafMatch);
	}

	// ============================================================
	// Interactive filter bar — edit the active filter in place
	//
	// The chat query engine sets workspace.activeFilter; these handlers let the
	// user re-target it (column), change the operator, or edit the value without
	// retyping a query. Each handler rebuilds the activeFilter object via
	// setActiveFilter() so the reactive liveRows recompute re-runs immediately.
	// Only single-condition filters are editable; compound filterTree filters
	// stay read-only (a tree can't be represented in three dropdowns).
	// ============================================================

	import type { FilterLeaf, FilterOp } from '$lib/pipeline/filter.js';
	import { countMatches, describeFilter } from '$lib/pipeline/filter.js';


	// ============================================================
	// Multi-condition filter model
	//
	// The filter bar is a flat list of conditions, all combined with AND. Each
	// condition can be negated (NOT) individually. This maps onto the existing
	// Filter tree as { and: [ leaf | {not: leaf}, … ] }, so the same evaluate()/
	// countMatches() engine handles it — no engine change. The "+ Add condition"
	// button appends a row; each row picks a column, an operator, and a value.
	//
	// Operators come in three flavors depending on the column kind:
	//   - text   : contains / not contains / equals / not equals
	//   - number : = / ≠ / < / ≤ / > / ≥   (numeric comparison)
	//   - date   : on / not on / before / not before / after / not after /
	//              on or before / on or after
	// Negation is part of the OPERATOR itself (a "not_" prefixed value), so the
	// user reads each condition straight across: column → operator → value.
	// There is no separate NOT toggle.
	// ============================================================

	/** One editable filter condition (a row in the filter bar). */
	type Condition = {
		id: number;
		column: string;                  // '' = all columns (only valid for text ops)
		kind: 'text' | 'number' | 'date'; // which operator set + input type to show
		op: string;            // e.g. 'contains'|'not_contains'|'eq'|'not_eq'|'lt'|'gt'|'on'|'before'…
		value: string;         // text value, number string, or 'YYYY-MM-DD' for date rows
	};

	// Operator dropdowns — each comparison is paired with its negated form so
	// negation lives in the dropdown, in natural reading order.
	const TEXT_OPS = [
		{ value: 'contains', label: 'contains' },
		{ value: 'not_contains', label: 'not contains' },
		{ value: 'eq', label: 'equals' },
		{ value: 'not_eq', label: 'not equals' }
	];
	// Numeric comparisons use base op values directly (no "not_" prefix needed —
	// the set is already symmetric: = / ≠ / < / ≤ / > / ≥).
	const NUMBER_OPS = [
		{ value: 'eq', label: '= equals' },
		{ value: 'neq', label: '≠ not equal' },
		{ value: 'lt', label: '< less than' },
		{ value: 'lte', label: '≤ less or equal' },
		{ value: 'gt', label: '> greater than' },
		{ value: 'gte', label: '≥ greater or equal' },
		{ value: 'outside', label: '↔ outside [lo, hi]' }
	];
	const DATE_OPS = [
		{ value: 'on', label: 'on' },
		{ value: 'not_on', label: 'not on' },
		{ value: 'before', label: 'before' },
		{ value: 'not_before', label: 'not before' },
		{ value: 'after', label: 'after' },
		{ value: 'not_after', label: 'not after' },
		{ value: 'on_or_before', label: 'on or before' },
		{ value: 'on_or_after', label: 'on or after' }
	];



	let nextConditionId = 0;
	let conditions = $state<Condition[]>([]);
	// Guard so the seeding effect (store → conditions) doesn't fight the rebuild
	// (conditions → store). When we publish our own filter we bump this and skip
	// the next seed pass.
	let selfUpdate = false;

	/** Heuristic: does a column name look like it holds dates? Used to default a
	 *  new condition's operator set (text vs date) for that column. */
	function columnIsDate(col: string): boolean {
		const cl = col.toLowerCase().replace(/[\s_\-]/g, '');
		return /date|updated|created|modified|expir|issued|timestamp/.test(cl);
	}

	/** Does a column hold (mostly) numeric values? Data-driven: sample up to 50
	 *  non-empty cells from the live rows and check that the large majority parse
	 *  as finite numbers. Used to default a new condition to the numeric operator
	 *  set (< / > / etc.). Columns that look like dates are NOT treated as numeric
	 *  (date handling owns those). */
	function columnIsNumber(col: string): boolean {
		if (!col || columnIsDate(col)) return false;
		const rows = workspace.csvRows;
		if (!rows || rows.length === 0) return false;
		let seen = 0, numeric = 0;
		for (let i = 0; i < rows.length && seen < 50; i++) {
			const raw = rows[i][col];
			if (raw === null || raw === undefined) continue;
			const s = String(raw).trim();
			if (s === '') continue;
			seen++;
			// Allow thousands separators / currency symbols when sniffing.
			const cleaned = s.replace(/[$,\s]/g, '');
			if (cleaned !== '' && !isNaN(Number(cleaned)) && isFinite(Number(cleaned))) numeric++;
		}
		return seen >= 3 && numeric / seen >= 0.8;
	}


	/** Parse a "YYYY-MM-DD" date input into local-midnight ms, or null. */
	function dateInputToMs(iso: string): number | null {
		if (!iso) return null;
		const [y, m, d] = iso.split('-').map(Number);
		const ms = new Date(y, m - 1, d).getTime();
		return isNaN(ms) ? null : ms;
	}
	/** Format local-midnight ms as "YYYY-MM-DD" for a native date input. */
	function msToDateInput(ms: number): string {
		const d = new Date(ms);
		const yr = d.getFullYear();
		const mo = String(d.getMonth() + 1).padStart(2, '0');
		const da = String(d.getDate()).padStart(2, '0');
		return `${yr}-${mo}-${da}`;
	}
	/** "YYYY-MM-DD" → "MM/DD/YYYY" — the format the leaf matcher's toDate()/
	 *  matchesValue() parse for date equality and comparison. */
	function dateInputToSlash(iso: string): string {
		const ms = dateInputToMs(iso);
		if (ms === null) return iso;
		const d = new Date(ms);
		return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
	}

	/** Split an operator value into its base op + whether it's negated.
	 *  "not_contains" → { base: 'contains', negate: true }. */
	function splitOp(op: string): { base: string; negate: boolean } {
		if (op.startsWith('not_')) return { base: op.slice(4), negate: true };
		return { base: op, negate: false };
	}

	/** Map one condition → a Filter node. Negation (a "not_"-prefixed operator)
	 *  wraps the leaf in { not: leaf }. Date ops → eq/gt/gte/lt/lte; text ops →
	 *  eq/contains. Returns null if the condition has no value yet. */
	function conditionToLeaf(c: Condition): Filter | null {
		const column = c.column || '_any_';
		const { base, negate } = splitOp(c.op);
		let leaf: FilterLeaf;
		if (c.kind === 'date') {
			if (!c.value) return null;
			const dateStr = dateInputToSlash(c.value);
			let op: FilterOp;
			switch (base) {
				case 'before':        op = 'lt'; break;
				case 'after':         op = 'gt'; break;
				case 'on_or_before':  op = 'lte'; break;
				case 'on_or_after':   op = 'gte'; break;
				default:              op = 'eq'; break; // 'on'
			}
			leaf = { column, op, value: dateStr };
		} else if (c.kind === 'number') {
			// Numeric comparison. The base op IS already a FilterOp
			// (eq/neq/lt/lte/gt/gte) — pass it straight through. The engine's
			// gt/gte/lt/lte path runs parseFloat on both sides; eq/neq use
			// matchesValue() which already handles numeric equivalence.
			if (c.value.trim() === '') return null;
			leaf = { column, op: base as FilterOp, value: c.value.trim() };
		} else {
			// text
			if (c.value === '') return null;
			const op: FilterOp = base === 'eq' ? 'eq' : 'contains';
			leaf = { column, op, value: c.value };
		}
		return negate ? { not: leaf } : leaf;

	}

	/** Build the Filter tree from the current conditions and publish it to the
	 *  store (or clear it when no conditions have values). Recomputes matchCount
	 *  via countMatches over the live rows. */
	function publishConditions() {
		const leaves: Filter[] = [];
		for (const c of conditions) {
			const node = conditionToLeaf(c);
			if (!node) continue;
			leaves.push(node);
		}


		selfUpdate = true;
		if (leaves.length === 0) {
			workspace.clearActiveFilter();
			return;
		}
		const tree: Filter = leaves.length === 1 ? leaves[0] : { and: leaves };
		const rows = csvData !== null ? workspace.csvRows : [];
		const matchCount = countMatches(tree, rows, leafMatch);
		workspace.setActiveFilter({
			pattern: describeFilter(tree),
			matchCount,
			filterTree: tree
		});
	}

	// ── Row mutation handlers (each re-publishes the tree) ────────────────────
	function addCondition() {
		// Default the new row to the first non-active column if possible, else ''.
		const cols = csvData?.columns ?? [];
		const used = new Set(conditions.map((c) => c.column));
		const col = cols.find((c) => !used.has(c)) ?? '';
		const kind: Condition['kind'] =
			col && columnIsDate(col) ? 'date' : col && columnIsNumber(col) ? 'number' : 'text';
		conditions.push({
			id: nextConditionId++,
			column: col,
			kind,
			op: kind === 'date' ? 'on' : kind === 'number' ? 'eq' : 'contains',
			value: ''
		});

		// New row has no value yet → don't publish (would be a no-op leaf).
	}

	function removeCondition(id: number) {
		conditions = conditions.filter((c) => c.id !== id);
		publishConditions();
	}
	function setConditionColumn(id: number, column: string) {
		const c = conditions.find((x) => x.id === id);
		if (!c) return;
		c.column = column;
		// Re-default the operator kind based on the new column: date > number > text.
		const want: Condition['kind'] =
			column !== '' && columnIsDate(column) ? 'date'
			: column !== '' && columnIsNumber(column) ? 'number'
			: 'text';
		if (want !== c.kind) {
			c.kind = want;
			c.op = want === 'date' ? 'on' : want === 'number' ? 'eq' : 'contains';
			c.value = '';
		}
		publishConditions();

	}
	function setConditionOp(id: number, op: string) {
		const c = conditions.find((x) => x.id === id);
		if (!c) return;
		c.op = op;
		publishConditions();
	}
	let valueDebounce: ReturnType<typeof setTimeout> | null = null;

	function setConditionValue(id: number, value: string, debounce: boolean) {
		const c = conditions.find((x) => x.id === id);
		if (!c) return;
		c.value = value;
		if (debounce) {
			if (valueDebounce) clearTimeout(valueDebounce);
			valueDebounce = setTimeout(publishConditions, 200);
		} else {
			publishConditions();
		}
	}

	// ── Seed conditions from an externally-set activeFilter (chat query) ───────
	// Unwrap a chat-produced Filter tree (or the legacy pattern/dateFilter shape)
	// into editable Condition rows so the user can refine a chat-driven filter.
	function leafToCondition(leaf: FilterLeaf, negate: boolean): Condition | null {
		const column = leaf.column === '_any_' ? '' : leaf.column;
		const val = Array.isArray(leaf.value) ? leaf.value.join(', ') : String(leaf.value ?? '');
		const pfx = (base: string, neg: boolean) => (neg ? `not_${base}` : base);
		const valLooksLikeDate = /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(val) || /^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(val);
		const valIsNumeric = val !== '' && !isNaN(Number(val.replace(/[$,\s]/g, '')));

		// Comparison ops (lt/gt/lte/gte): a DATE-looking value → date row, otherwise
		// a NUMBER row. This is how a chat filter like "Revenue > 1000" seeds an
		// editable numeric condition instead of a (meaningless) date one.
		const dateOpMap: Record<string, string> = { lt: 'before', gt: 'after', lte: 'on_or_before', gte: 'on_or_after' };
		if (leaf.op in dateOpMap) {
			if (valLooksLikeDate) {
				const ms = (() => { const d = new Date(val); return isNaN(d.getTime()) ? null : d.getTime(); })();
				return {
					id: nextConditionId++,
					column,
					kind: 'date',
					op: pfx(dateOpMap[leaf.op], negate),
					value: ms !== null ? msToDateInput(ms) : ''
				};
			}
			// Numeric comparison row — op passes straight through (lt/gt/lte/gte).
			return { id: nextConditionId++, column, kind: 'number', op: leaf.op, value: val };
		}

		// 'outside' is a numeric op with a tuple value [lo, hi] (the IQR
		// fence). Render as a number row whose value is "lo,hi". The
		// worker reads the leaf directly via evalFilter so the display
		// string is only for the bar — the actual filter shape stays
		// a single leaf in workspace.activeFilter.filterTree.
		if (leaf.op === 'outside') {
			const arr = Array.isArray(leaf.value) ? leaf.value : [];
			const lo = String(arr[0] ?? '');
			const hi = String(arr[1] ?? '');
			return {
				id: nextConditionId++,
				column,
				kind: 'number',
				op: 'outside',
				value: `${lo},${hi}`
			};
		}

		// eq on a date-looking value → date "on" row.
		if (leaf.op === 'eq' && valLooksLikeDate) {
			const ms = (() => { const d = new Date(val); return isNaN(d.getTime()) ? null : d.getTime(); })();
			return {
				id: nextConditionId++,
				column,
				kind: 'date',
				op: pfx('on', negate),
				value: ms !== null ? msToDateInput(ms) : ''
			};
		}

		// eq/neq on a purely numeric value → number row (= / ≠).
		if ((leaf.op === 'eq' || leaf.op === 'neq') && valIsNumeric) {
			const op = leaf.op === 'neq' || negate ? 'neq' : 'eq';
			return { id: nextConditionId++, column, kind: 'number', op, value: val };
		}

		// Otherwise a text row. neq is a negated eq; the negate flag (from a
		// wrapping {not:…}) is folded into the operator value.
		const base = leaf.op === 'eq' || leaf.op === 'neq' ? 'eq' : 'contains';
		const neg = negate || leaf.op === 'neq';
		return { id: nextConditionId++, column, kind: 'text', op: pfx(base, neg), value: val };

	}

	function treeToConditions(tree: Filter): Condition[] {
		if ('and' in tree) {
			return tree.and.flatMap(treeToConditions);
		}
		if ('not' in tree) {
			const inner = tree.not;
			if ('and' in inner || 'or' in inner) return []; // can't represent nested groups
			const c = leafToCondition(inner as FilterLeaf, true);
			return c ? [c] : [];
		}
		if ('or' in tree) return []; // OR not representable in the AND-only bar
		const c = leafToCondition(tree as FilterLeaf, false);
		return c ? [c] : [];
	}
	function seedFromActiveFilter() {
		const f = workspace.activeFilter;
		if (!f) { conditions = []; return; }
		// Compound / leaf filter tree.
		if (f.filterTree) {
			const seeded = treeToConditions(f.filterTree);
			// Only adopt if we could fully represent it; otherwise leave read-only.
			conditions = seeded;
			return;
		}
		// Legacy date filter shape.
		if (f.dateFilter) {
			const opMap: Record<string, string> = {
				on: 'on', not_on: 'on', before: 'before', after: 'after',
				on_or_before: 'on_or_before', on_or_after: 'on_or_after'
			};
			const dBase = opMap[f.dateFilter.dateOp] ?? 'on';
			conditions = [{
				id: nextConditionId++,
				column: f.column ?? '',
				kind: 'date',
				op: f.dateFilter.dateOp === 'not_on' ? `not_${dBase}` : dBase,
				value: msToDateInput(f.dateFilter.dateMs)
			}];
			return;

		}
		// Legacy single text filter.
		if (f.pattern) {
			const vop = f.valueOp ?? 'contains';
			const isEq = vop === 'eq' || vop === 'neq';
			const isNeg = vop === 'neq' || vop === 'not_contains';
			const base = isEq ? 'eq' : 'contains';
			conditions = [{
				id: nextConditionId++,
				column: f.column ?? '',
				kind: 'text',
				op: isNeg ? `not_${base}` : base,
				value: f.pattern
			}];
			return;
		}

		conditions = [];
	}

	// Sync conditions whenever the store's activeFilter changes from the OUTSIDE
	// (chat query engine). Our own publishConditions() sets selfUpdate so this
	// effect skips one pass and doesn't clobber in-progress edits.
	$effect(() => {
		void workspace.activeFilter;
		if (selfUpdate) { selfUpdate = false; return; }
		seedFromActiveFilter();
	});

	/** True when there's an active filter we could NOT turn into editable rows
	 *  (e.g. it contained OR or nested groups). Then we show the read-only chip. */
	const isReadOnlyFilter = $derived(
		!!workspace.activeFilter && conditions.length === 0
	);


	// ============================================================
	// _cesvu.zip import (open an exported document)
	//
	// Lives on the upload/landing page alongside the other source formats. A
	// dropped or picked _cesvu.zip archive is routed here (see
	// handleFileSelected) and opened immediately — no password or shared
	// secret involved, since the export carries no confidentiality.
	// ============================================================
	let showImport = $state(false);
	let importFile = $state<File | null>(null);
	let importInputEl = $state<HTMLInputElement | null>(null);

	function openImportFor(file: File) {
		importFile = file;
		showImport = true;
	}

	async function onImportPicked(e: Event) {
		const input = e.target as HTMLInputElement;
		const f = input.files?.[0];
		// Mobile Safari's document picker does NOT filter by the `accept`
		// attribute very strictly — it shows every file type regardless of
		// the `accept=".zip"` hint below. Without this guard, picking e.g. a
		// .pdf or .jpg here would route straight into the unlock flow and
		// fail deep inside parsing with a confusing error. Validate the
		// extension ourselves and reject early with a clear message.
		if (f && !(await isCesvuZip(f))) {
			workspace.setError('Please select a Cesvu .zip file.');
			input.value = '';
			return;
		}
		if (f) openImportFor(f);
		// Reset so the same file can be picked again.
		input.value = '';
	}


	// Consume a _cesvu.zip archive handed in by the workspace-level drag-and-drop zone
	// (Workspace.svelte). The drop target is the whole shell, which doesn't own
	// the unlock modal, so it stashes the file on the store via requestImport();
	// we pick it up here and clear it immediately (PULL pattern) so it can't be
	// re-opened on a later render.
	$effect(() => {
		const pending = workspace.pendingImportFile;
		if (pending) {
			openImportFor(pending);
			workspace.clearImport();
		}
	});


	/**
	 * A _cesvu.zip archive was opened. The decoded {@link CesvuDocument} is already
	 * persisted to IndexedDB (importFromCesvu did that); now MATERIALIZE it into
	 * the workspace so it actually displays. Without this the modal would close
	 * onto the empty upload page — the doc would be saved but invisible.
	 *
	 * v2 imports carry `rawContent` (base64 of the original file bytes) for
	 * every binary / structured type (csv | excel | pdf | docx). We decode that
	 * back into a File and route it through the SAME parseFile() / parseCSV()
	 * pipeline the original upload uses — so the recipient gets the real PDF
	 * bytes, the real XLSX workbook, the real CSV rows. The fallback path
	 * (rawContent absent — legacy v1 exports, or txt/md where `text` IS the full
	 * content) renders the plain text directly. The original filename is
	 * preserved so lens auto-detection (contract vs document) still works. We
	 * DON'T clear showImport here — the modal shows its own "unlocked" screen and
	 * dismisses itself via onclose a moment later.
	 */
	async function handleImported(doc: CesvuDocument) {
		// This session was opened by importing a _cesvu.zip archive. Mark it so the
		// Export dialog can offer to recover the original source file (a directly
		// uploaded file already lives on the user's disk, so it never offers this).
		workspace.setOpenedFromCesvu(true);

		// "Source omitted" detection: a sender who excluded the original source
		// file ships a pdf/docx/csv/excel record with NO rawContent. For txt/md
		// the missing rawContent is normal (the text IS the source), so those are
		// never flagged. Drives the recipient banner below the viewer.
		const sourceWasOmitted =
			!doc.rawContent && doc.sourceType !== 'txt' && doc.sourceType !== 'md';
		workspace.setSourceOmitted(sourceWasOmitted);

		// ── Fast path: txt / md (or any legacy v1 record with no rawContent) ──

		// `text` IS the complete file content; hand it straight to the workspace.
		if (!doc.rawContent) {

			const enc = new TextEncoder().encode(doc.text);
			const buf = new ArrayBuffer(enc.byteLength);
			new Uint8Array(buf).set(enc);
			const parsed: ParsedFile = {
				type: doc.sourceType === 'md' ? 'md' : 'txt',
				name: doc.name,
				size: enc.byteLength,
				rawContent: buf,
				parsedData: doc.text
			};
			workspace.setFile(parsed);
			await workspace.resumeContract(doc.id);
			// Restore the saved analysis profile (parties, key dates, risks).
			// setFile() above fired the lens detection + split-flow $effects, which
			// clear contractProfile ("stale profile" guard). await tick() lets those
			// effects fully settle FIRST; the split-flow guard (splitFlowFor === text)
			// then prevents any re-clear, so this restore sticks.
			await tick();
			if (doc.profile) workspace.setContractProfile(doc.profile);
			return;
		}



		// ── Round-trip path: bytes → File → re-parse with the real parser ──
		// `doc.rawContent` is now typically a raw Uint8Array (CFP1 framing —
		// see contract-store.svelte.ts); a base64 STRING is still accepted for
		// backward compatibility with older in-memory records. Building the
		// File directly from the Uint8Array (no intermediate ArrayBuffer copy)
		// avoids doubling memory for a large (multi-hundred-MB) DICOM study.
		workspace.setParseProgress({ stage: 'Opening document…' });
		// Declared BEFORE the try block that may assign it (large-DICOM
		// streaming-import branch, below) — assigning to `file` before its
		// declaration would throw a ReferenceError (temporal dead zone).
		let file: File | undefined;
		let bytes: Uint8Array;
		try {
			if (doc.rawContent instanceof Uint8Array) {
				bytes = doc.rawContent;
			} else if (typeof doc.rawContent === 'string') {
				const bin = atob(doc.rawContent);
				bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			} else {
				bytes = new Uint8Array(0);
			}

		} catch (e) {

			workspace.setParseProgress(null);
			workspace.setError(`Unable to open this file. (${(e as Error).message})`);
			return;
		}
		// DICOM studies skip the `new File([bytes], ...)` + `parseFile()`
		// combo entirely: `new File([...])` COPIES the whole buffer, and
		// parseFile()'s dicom branch would then call `file.arrayBuffer()`
		// which copies it AGAIN — two full extra copies of a study that can
		// be multi-hundred-MB to multi-GB, on top of the already-decrypted
		// `bytes` buffer. That's exactly the kind of duplicate allocation
		// that throws "Array buffer allocation failed" for large studies.
		// Instead, call the dicom parser directly with the decrypted
		// Uint8Array (a zero-copy view already), and build the ParsedFile
		// object by hand — same shape parseFile()'s dicom branch returns.
		// A lightweight `File` (metadata only, zero bytes) is still built
		// where a `File`-shaped value is needed downstream (extension
		// sniffing in parseDicom/looksLikeDicomZip), but it never carries
		// the real payload. `file` was already declared above (it may have
		// been assigned in the streaming-import branch there).
		try {

			const { parseFile, parseCSV, parsePDFBytes, parseDOCXBytes } = await import('$lib/parsers/index.js');
			const { compressFile, buildCsvStructureNotes } = await import('$lib/pipeline/pipeline.js');
			let parsed: ParsedFile;
			// Tracks whether the CSV branch below already streamed the full row
			// set into workspace.csvRows / workspace.summary via onChunk/onComplete
			// (see the direct-upload path's identical wiring, above in this file).
			// When true, the generic setSummary(compressFile(parsed)) call after
			// this if/else is SKIPPED for csv — compressFile(parsed) would only
			// ever see the stale first-chunk snapshot parseCSV() resolved with.
			let csvStreamHandled = false;
			if (doc.sourceType === 'csv') {
				file = new File([bytes as BlobPart], doc.name, { type: 'application/octet-stream' });
				workspace.setParseProgress({ stage: 'Parsing CSV…', rowsRead: 0 });
				workspace.setStreamingState(false, 0, []);
				csvStreamHandled = true;
				// High-water mark: only stamp NEW rows on each chunk (O(new rows) per
				// call). Mirrors the direct-upload CSV path's identical stamping —
				// see its doc comment above for the full rationale (stable row
				// identity for note anchors across sort/filter).
				let stampedUpTo = 0;
				function stampRows(rows: Record<string, unknown>[]) {
					for (let i = stampedUpTo; i < rows.length; i++) {
						rows[i].__rowIdx__ = i;
					}
					stampedUpTo = rows.length;
				}
				parsed = await parseCSV(file, {
					onProgress(rowsRead) {
						workspace.setParseProgress({ stage: 'Parsing CSV…', rowsRead });
					},
					onChunk(totalScanned, rows) {
						stampRows(rows);
						// Reassign array reference → triggers $derived re-run.
						workspace.setStreamingState(false, totalScanned, rows);
					},
					onComplete(totalScanned, rows, finalProfiles) {
						stampRows(rows);
						workspace.setStreamingState(true, totalScanned, rows);
						// Build the definitive summary from the FINAL profiles and true
						// row count — parsed.totalRowCount / parsed.columnProfiles are
						// stale first-chunk snapshots by the time this fires.
						setTimeout(() => {
							try {
								const finalSummary = {
									fileType: 'csv' as const,
									fileName: doc.name,
									rowCount: totalScanned,
									columnCount: (parsed.parsedData as import('$lib/types.js').CsvData).columns.length,
									columnProfiles: finalProfiles,
									structureNotes: buildCsvStructureNotes(finalProfiles, totalScanned)
								};
								workspace.setSummary(finalSummary);
							} catch (_) { /* non-fatal */ }
						}, 0);
					}
				});
			} else if (doc.sourceType === 'pdf') {
				// Bytes-native path — skips the `new File([bytes])` +
				// `file.arrayBuffer()` round-trip entirely (two extra full
				// copies of a potentially large PDF), which matters a lot on
				// mobile Safari's much tighter per-tab memory ceiling.
				workspace.setParseProgress({ stage: 'Parsing PDF…' });
				parsed = await parsePDFBytes(bytes, doc.name);
			} else if (doc.sourceType === 'docx') {
				// Same bytes-native reasoning as PDF above.
				workspace.setParseProgress({ stage: 'Parsing DOCX…' });
				parsed = await parseDOCXBytes(bytes, doc.name);
			} else {
				file = new File([bytes as BlobPart], doc.name, { type: 'application/octet-stream' });
				workspace.setParseProgress({
					stage: `Parsing ${(doc.name.split('.').pop() ?? 'file').toUpperCase()}…`
				});
				parsed = await parseFile(file);
			}

			workspace.setParseProgress(null);
			workspace.setFile(parsed);
			// Excel's compressFile() does a full workbook scan — defer it so the
			// table paints first; everything else is cheap enough to run inline.
			// DICOM has no tabular/text summary to compute at all (parsedData is
			// a DicomStudy, not CsvData/StructuredText) — compressFile() would be
			// meaningless here, so it's skipped for that type. CSV is ALSO
			// skipped here — its onChunk/onComplete handlers above already
			// build and set the (accurate, full-file) summary as rows stream
			// in; calling compressFile(parsed) here would overwrite it with a
			// stale first-chunk-only snapshot (parsed.totalRowCount/columnProfiles
			// are frozen at whatever parseCSV() had when its promise resolved).
			if (parsed.type === 'excel') {
				const build = () => {
					try { workspace.setSummary(compressFile(parsed)); } catch (_) { /* non-fatal */ }
				};
				if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(build, { timeout: 2000 });
				else setTimeout(build, 0);
			} else if (!csvStreamHandled) {
				try { workspace.setSummary(compressFile(parsed)); } catch (_) { /* non-fatal */ }
			}
		} catch (e) {
			workspace.setParseProgress(null);
			workspace.setError(`Unable to open this file. (${(e as Error).message})`);
			return;
		}

		// Bind this session to the persisted record so notes/profile save back to
		// it and a later Export reuses the same document instead of duplicating it.
		await workspace.resumeContract(doc.id);

		// Restore the saved analysis profile (parties, key dates, risks). setFile()
		// above fired the lens detection + split-flow $effects, which clear
		// contractProfile ("stale profile" guard). await tick() lets those effects
		// fully settle FIRST; the split-flow guard (splitFlowFor === text) then
		// prevents any re-clear, so this restore sticks.
		await tick();
		if (doc.profile) workspace.setContractProfile(doc.profile);
	}




	// ============================================================
	// File upload handler
	// ============================================================
	async function handleFileSelected(file: File) {

		// A _cesvu.zip archive is an exported document, not a source file to
		// parse — route it into the open flow instead of the normal parser
		// pipeline.
		// Detected by content, not the `_cesvu.zip` suffix: browsers rename
		// repeat downloads to "... (1).zip", which used to fall through to the
		// plain-text parser and display garbled zip bytes.
		if (await isCesvuZip(file)) {
			openImportFor(file);
			return;
		}

		// A directly-uploaded source file already exists on the user's disk, so the

		// Export dialog must NOT offer to "download the source file" for it.
		workspace.setOpenedFromCesvu(false);
		// Clear any stale error from a previous failed import — otherwise a new
		// selection could briefly show a banner from an unrelated prior failure.
		workspace.setError('');

		try {
			workspace.setParseProgress({ stage: 'Reading file…' });



			const { parseFile, parseCSV } = await import('$lib/parsers/index.js');
			const { compressFile, buildCsvStructureNotes } = await import('$lib/pipeline/pipeline.js');

		let parsed: import('$lib/types.js').ParsedFile;

		if (file.name.toLowerCase().endsWith('.csv') || file.type === 'text/csv') {
				workspace.setParseProgress({ stage: 'Parsing CSV…', rowsRead: 0 });
				workspace.setStreamingState(false, 0, []);
			// High-water mark: only stamp NEW rows on each chunk (O(new rows) per call).
			let stampedUpTo = 0;
			/**
			 * Stamp each row with its original file index (__rowIdx__).
			 * This gives every row a stable identity that survives filter/sort
			 * re-ordering, so note anchors always scroll back to the right row.
			 * Aligns with the annotation spec's CellSelector.row (stable row number).
			 */
			function stampRows(rows: Record<string, unknown>[]) {
				for (let i = stampedUpTo; i < rows.length; i++) {
					rows[i].__rowIdx__ = i;
				}
				stampedUpTo = rows.length;
			}
			parsed = await parseCSV(file, {
				onProgress(rowsRead) {
					workspace.setParseProgress({ stage: 'Parsing CSV…', rowsRead });
				},
				onChunk(totalScanned, rows) {
					stampRows(rows); // stamp before handing to workspace
					// Reassign array reference → triggers $derived re-run in DocumentPane
					workspace.setStreamingState(false, totalScanned, rows);
				},
				onComplete(totalScanned, rows, finalProfiles) {
					stampRows(rows); // stamp any rows added in the final chunk
					workspace.setStreamingState(true, totalScanned, rows);

					// Build the definitive summary from the FINAL profiles and true row count.
					// finalProfiles are re-finalized from ALL accumulated rows (Welford's algorithm
					// ran on every row). totalScanned is the true row count for the full file.
					// This replaces any partial summary built from the first chunk.
					setTimeout(() => {
						try {
							// Build summary directly from final profiles + true row count.
							// Do NOT call compressFile(parsed) — parsed.totalRowCount and
							// parsed.columnProfiles are stale first-chunk snapshots.
							const finalSummary = {
								fileType: 'csv' as const,
								fileName: file.name,
								rowCount: totalScanned,
								columnCount: (parsed.parsedData as import('$lib/types.js').CsvData).columns.length,
								columnProfiles: finalProfiles,
								structureNotes: buildCsvStructureNotes(finalProfiles, totalScanned)
							};
							workspace.setSummary(finalSummary);
							console.log('[DocumentPane] Final summary built. rowCount:', totalScanned, 'profiles:', finalProfiles.length);
						} catch (e) {
							console.warn('[DocumentPane] Failed to build final summary:', e);
						}
					}, 0);
				}
			});
			// Show table immediately — streaming continues in background
			workspace.setParseProgress(null);
			workspace.setFile(parsed);
			// Build initial partial summary from first chunk so chat works immediately.
			// Will be replaced by the accurate summary when onComplete fires.
			setTimeout(() => {
				try {
					const summary = compressFile(parsed);
					workspace.setSummary(summary);
				} catch (_) { /* non-fatal */ }
			}, 0);
			} else {
				workspace.setParseProgress({ stage: `Parsing ${file.name.split('.').pop()?.toUpperCase() ?? 'file'}…` });
				parsed = await parseFile(file);
				// Render the document FIRST. setFile wires up the workbook/text so the
				// viewer can paint; compressFile() is then computed off the critical
				// path. For large .xlsx workbooks compressFile() runs profileWorkbook()
				// (a full row scan) — doing it synchronously here froze the tab before
				// the table ever appeared.
				workspace.setParseProgress(null);
				workspace.setFile(parsed);

				if (parsed.type === 'excel') {
					// Defer the (heavy) summary build until the main thread is idle, so
					// the spreadsheet paints immediately. Chat that needs the summary
					// will see it a moment later. rIC with a 2s timeout; setTimeout
					// fallback for Safari/Firefox.
					const buildSummary = () => {
						try {
							workspace.setSummary(compressFile(parsed));
						} catch (_) { /* non-fatal */ }
					};
					if (typeof requestIdleCallback !== 'undefined') {
						requestIdleCallback(buildSummary, { timeout: 2000 });
					} else {
						setTimeout(buildSummary, 0);
					}
				} else {
					// txt/md/pdf/docx: compressFile is cheap (string slicing) — inline.
					workspace.setSummary(compressFile(parsed));
				}
			}

		} catch (e) {
			console.error('[DocumentPane] handleFileSelected failed:', e);
			workspace.setParseProgress(null);
			workspace.setError(String(e instanceof Error ? e.message : e));
		}
	}

	// ============================================================
	// CSV selection handlers
	// ============================================================

	function selectColumn(colName: string) {
		workspace.setSelection({ type: 'column', label: `${colName} column`, data: { column: colName } });
	}
	function selectRow(rowIndex: number, rowData: Record<string, unknown>) {
		workspace.setSelection({ type: 'row', label: `Row ${rowIndex + 1}`, data: { rowIndex, rowData } });
	}
	function selectCell(colName: string, rowIndex: number, value: unknown) {
		workspace.setSelection({ type: 'cell', label: `${colName} · Row ${rowIndex + 1}`, data: { column: colName, rowIndex, value } });
	}

	// ============================================================
	// Right-click context menu (shared CellContextMenu + cellMenuActions)
	// ============================================================
	let menu = $state<{ x: number; y: number; target: MenuTarget } | null>(null);

	/** Open the context menu at the cursor for a given target. */
	function openMenu(e: MouseEvent, target: MenuTarget) {
		e.preventDefault();
		e.stopPropagation();
		menu = { x: e.clientX, y: e.clientY, target };
	}
	function closeMenu() {
		menu = null;
	}


	// ============================================================
	// Text selection handler
	// ============================================================
	function handleTextMouseUp() {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) return;
		const text = sel.toString().trim();
		if (text.length < 3) return;
		workspace.setSelection({
			type: 'text',
			label: `"${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"`,
			data: { text }
		});
	}

	// ============================================================
	// Derived display data
	// ============================================================
	const csvData = $derived(
		workspace.file?.type === 'csv' ? (workspace.file.parsedData as CsvData) : null
	);
	// Excel files route to SpreadsheetViewer (non-streaming workbook path).
	const isExcel = $derived(workspace.file?.type === 'excel');
	const textData = $derived(
		workspace.file?.type === 'txt' || workspace.file?.type === 'md'
			? (workspace.file.parsedData as string)
			: null
	);
	// DOCX renders as native styled HTML (mammoth.convertToHtml); PDF renders
	// pixel-perfect via PdfViewer.
	const structuredData = $derived(
		workspace.file?.type === 'docx'
			? (workspace.file.parsedData as StructuredText)
			: null
	);
	/** Display HTML for DOCX (already sanitized in the parser). */
	const docxHtml = $derived(structuredData?.html ?? '');

	const isPdf = $derived(workspace.file?.type === 'pdf');

	const pdfBytes = $derived(
		workspace.file?.type === 'pdf' ? (workspace.file.rawContent as ArrayBuffer) : null
	);
	const pdfStructured = $derived(
		workspace.file?.type === 'pdf' ? (workspace.file.parsedData as StructuredText) : null
	);

	// PDF text selection → workspace selection (carries page number for source-linking)
	function handlePdfAddToContext(payload: { text: string; pageNumber: number }) {
		const t = payload.text.trim();
		if (t.length < 1) return;
		workspace.setSelection({
			type: 'text',
			label: `p.${payload.pageNumber}: "${t.slice(0, 36)}${t.length > 36 ? '…' : ''}"`,
			data: { text: t, pageNumber: payload.pageNumber }
		});
	}

	// ── PDF "Page [n] / numPages" jump control ──────────────────────────────
	// Handle to the mounted PdfViewer so the toolbar input below can call its
	// goToPage() — same bind:this + exported-function pattern as FilterBar's
	// addConditionExternal() (see SpreadsheetViewer.svelte).
	let pdfViewerRef = $state<{ goToPage: (n: number) => void } | null>(null);
	/** Total pages in the current PDF — set once by onNumPagesKnown. */
	let pdfNumPages = $state(0);
	/** The page currently scrolled into view — kept live by onPageChange so the
	 *  input reflects manual scrolling, not just goToPage() jumps. */
	let pdfCurrentPage = $state(1);
	/** The input's own value, editable independently of pdfCurrentPage until the
	 *  user commits (Enter/blur) — otherwise every scroll tick would clobber
	 *  whatever partial number they're mid-typing. Svelte coerces
	 *  bind:value to a number for <input type="number"> — null when the
	 *  field is empty (user cleared it, e.g. mid-retype). */
	let pdfPageInputValue = $state<number | null>(1);

	$effect(() => {
		pdfPageInputValue = pdfCurrentPage;
	});

	/** Reset the control's state whenever a new PDF file is opened, so a
	 *  stale page count/current page from a previous document never leaks in. */
	$effect(() => {
		void pdfBytes;
		pdfNumPages = 0;
		pdfCurrentPage = 1;
	});

	function commitPdfPageJump() {
		if (pdfPageInputValue === null || !Number.isFinite(pdfPageInputValue)) {
			pdfPageInputValue = pdfCurrentPage;
			return;
		}
		pdfViewerRef?.goToPage(pdfPageInputValue);
		// goToPage() clamps internally; updateVisiblePages()'s onPageChange will
		// report the clamped result back via pdfCurrentPage/the $effect above.
	}

	function handlePdfPageInputKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			(e.target as HTMLInputElement).blur();
		}
	}

	const selectedColumn = $derived(
		workspace.selection?.type === 'column'
			? (workspace.selection.data as { column: string }).column
			: null
	);
	const csvMeta = $derived(
		workspace.file?.type === 'csv' ? (workspace.file as unknown as ParsedCsvFile) : null
	);

	// ============================================================
	// Live streaming rows — workspace.csvRows is $state, reassigned on each chunk
	// so $derived re-runs and the virtual scroll spacers grow correctly
	// ============================================================
	const allRows = $derived(csvData !== null ? workspace.csvRows : []);

	// Apply active filter from chat query engine (set by runChatInference)
	const liveRows = $derived(
		workspace.activeFilter
			? (() => {
				const f = workspace.activeFilter!;

				// ── Filter tree path (new) ────────────────────────────────────────


				// When a filterTree is present, use the recursive evaluate() engine.
				// This handles AND / OR / NOT / compound expressions.
				// The '_any_' sentinel column means "search all columns".
				const ft = (f as { filterTree?: Filter }).filterTree;
				if (ft) {
					const cols = csvData?.columns ?? [];
					return allRows.filter(row => evaluateFilterTree(ft, row, cols));
				}

				// ── Legacy path (pattern/column/dateFilter) ───────────────────────
				const pat = f.pattern.toLowerCase();
				const col = f.column;
				const cols = csvData?.columns ?? [];
				const df = f.dateFilter;

				// Helper: parse a cell value as a Date (same logic as analysis.ts)
				function parseRowDate(v: unknown): Date | null {
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

				// Build date column list once (outside filter loop for perf)
				// Use semanticDateHint to narrow which date columns to check
				const hint = df?.semanticDateHint ?? 'any';
				const dateCols = col ? [col] : (df ? cols.filter(c => {
					const cl = c.toLowerCase().replace(/[\s_\-]/g, '');
					if (hint === 'update') return cl.includes('lastupdate') || cl.includes('updatedate') || cl.includes('modifieddate') || cl.includes('modified') || cl.includes('updated') || cl.includes('lastmodified') || cl.includes('changedate');
					if (hint === 'expiry') return cl.includes('expir') || cl.includes('expire');
					if (hint === 'issue') return cl.includes('issue') || cl.includes('issued') || cl.includes('issuance');
					return cl.includes('date') || cl.includes('updated') || cl.includes('created') || cl.includes('modified') || cl.includes('expir') || cl.includes('issued');
				}) : []);
				const checkCols = (df && dateCols.length > 0) ? dateCols : (df ? cols : []);

				// Debug: log first row to verify date parsing (fires once on first filter)
				if (df && allRows.length > 0) {
					const sampleRow = allRows[0];
					const sampleCol = checkCols[0];
					if (sampleCol) {
						const sampleVal = sampleRow[sampleCol];
						const sampleDate = parseRowDate(sampleVal);
						console.log('[DocumentPane filter] sample col:', sampleCol, 'val:', sampleVal, 'parsed:', sampleDate?.getTime(), 'target ms:', df.dateMs, 'op:', df.dateOp);
					}
				}

				return allRows.filter(row => {
					// Date filter
					if (df) {
						const targetMs = df.dateMs;
						const targetDate = new Date(targetMs);
						const matched = checkCols.some(c => {
							const d = parseRowDate(row[c]);
							if (!d) return false;
							const rowMs = d.getTime();
							switch (df.dateOp) {
								case 'after':        return rowMs > targetMs;
								case 'before':       return rowMs < targetMs;
								case 'on':           return d.toDateString() === targetDate.toDateString();
								case 'not_on':       return d.toDateString() !== targetDate.toDateString();
								case 'on_or_after':  return rowMs >= targetMs;
								case 'on_or_before': return rowMs <= targetMs;
								default:             return rowMs > targetMs;

							}
						});
						if (!matched) return false;
						if (!pat) return true;
					}
					// Text filter — matchesValue() adds numeric + Excel date-serial ⇄
					// date-string equivalence on top of plain substring matching, so
					// "LastUpdate = 46133" lights up the row showing that serial's date.
					// valueOp (set by the interactive filter bar) chooses the
					// comparison; it defaults to 'contains' for chat-driven filters.
					if (pat) {
						const vop = f.valueOp ?? 'contains';
						const baseOp = vop === 'eq' || vop === 'neq' ? 'eq' : 'contains';
						const negate = vop === 'neq' || vop === 'not_contains';
						const test = (cell: unknown) => matchesValue(cell, f.pattern, baseOp);
						if (col) {
							const hit = test(row[col]);
							return negate ? !hit : hit;
						}
						// No column → match across all columns. For positive ops a row
						// qualifies if ANY column matches; for negated ops it qualifies
						// only if NO column matches.
						const anyHit = cols.some(c => test(row[c]));
						return negate ? !anyHit : anyHit;
					}
					return true;


				});
			})()
			: allRows
	);

	// Apply active sort from workspace.activeSort (set by header click or chat sort_rows intent)
	const sortedRows = $derived((() => {
		const s = workspace.activeSort;
		if (!s) return liveRows;
		const col = s.column;
		const dir = s.direction;
		return [...liveRows].sort((a, b) => {
			const av = a[col];
			const bv = b[col];
			// Numeric sort if both values are numeric
			const an = Number(av);
			const bn = Number(bv);
			if (!isNaN(an) && !isNaN(bn)) {
				return dir === 'asc' ? an - bn : bn - an;
			}
			// String sort
			const as = String(av ?? '').toLowerCase();
			const bs = String(bv ?? '').toLowerCase();
			if (as < bs) return dir === 'asc' ? -1 : 1;
			if (as > bs) return dir === 'asc' ? 1 : -1;
			return 0;
		});
	})());

	const isStreaming = $derived(csvData !== null && !workspace.streamingDone);
	const totalScanned = $derived(workspace.streamingTotal > 0 ? workspace.streamingTotal : allRows.length);

	// ============================================================
	// Virtual scroll — 240 rows in the DOM, sliding as the user scrolls.
	//
	// One row is exactly ROW_HEIGHT px, so scrollTop <-> row index is a direct,
	// lossless mapping (see spreadsheet-scroll.ts). The old "proportional" mode,
	// which capped the scroll height at 50,000px, is gone: its jump and scroll
	// mappings disagreed and flung the view thousands of rows after a jump.
	// ============================================================
	const RENDER_SIZE = 240;
	const OVERSCAN = 80;         // rows rendered above the viewport (absorbs scroll lag)


	let windowStart = $state(0);

	const totalBuffered = $derived(sortedRows.length);
	const visibleRows = $derived(sortedRows.slice(windowStart, windowStart + RENDER_SIZE));

	function scrollTopToRowIndex(scrollTop: number): number {
		return Math.floor(scrollTop / ROW_HEIGHT);
	}

	function rowIndexToScrollTop(rowIdx: number): number {
		return rowIdx * ROW_HEIGHT;
	}

	// Spacer rows stand in for the rows outside the rendered window, so the
	// scroll height is exactly totalBuffered * ROW_HEIGHT.
	const topSpacerPx = $derived(windowStart * ROW_HEIGHT);
	const bottomSpacerPx = $derived(
		Math.max(0, (totalBuffered - windowStart - RENDER_SIZE) * ROW_HEIGHT)
	);


	// Scroll handling — coalesce (never DROP) scroll events.
	//
	// The old version bailed out (`if (rafPending) return`) while a frame was
	// pending, so the LAST scroll position of a fast flick / momentum scroll was
	// never read. The window stayed parked at an intermediate row while the user
	// kept scrolling, exposing the empty spacer rows as a black gap.
	//
	// Now we always remember the live scroll element and re-read its CURRENT
	// scrollTop inside the rAF, then schedule a short "settle" re-check so the
	// window converges on wherever the scroll actually stopped. OVERSCAN above
	// the target absorbs the remaining one-frame lag in both directions.
	let rafPending = false;
	let scrollEl: HTMLDivElement | null = null;
	// Last horizontal scroll position. A scroll event whose scrollLeft changed is
	// a SIDEWAYS scroll (horizontal scrollbar drag, shift-wheel, trackpad pan); we
	// must not move the row window for it — incidental vertical drift during a
	// sideways pan would otherwise shift the rendered rows. Starts at 0 (the
	// initial DOM value) so a first PURE-vertical scroll isn't misread as
	// horizontal.
	let lastSeenScrollLeft = 0;
	// Note-jump scroll lock. A programmatic jump sets `programmaticWindowStart`

	// (the window to HOLD) and `scrollLockUntil` (a short deadline). While the
	// lock is active the scroll handler keeps the window pinned and only
	// re-anchors the spacer, so the synthetic scroll events fired by the jump —
	// plus any momentum still in flight from a previous flick — can't drag the
	// rendered block away from the row we just landed on.
	let programmaticWindowStart = $state<number | null>(null);
	let scrollLockUntil = 0;
	let lockedScrollTop = 0;
	const SCROLL_LOCK_MS = 400;



	// ── Cell notes (CSV streaming path) ───────────────────────────────────
	// Mirrors the pin/scroll wiring in SpreadsheetViewer.svelte. The user
	// can right-click a cell → Add note; the bubble appears in the right
	// NotesPane (mounted in Workspace.svelte for the tabular path).
	// For the streaming CSV path we only render the per-cell pin in the
	// <td>; the scroll-to-cell effect is added in Phase 3b.

	const showCellPins = $derived(workspace.notesMode);
	const cellNoteCounts = $derived.by<Map<string, number>>(() => {
		const out = new Map<string, number>();
		for (const n of notesStore.notes) {
			if (n.anchor.kind !== 'cell') continue;
			if (n.anchor.rowIndex < 0) continue; // column-level notes render in the header
			const key = `${n.anchor.column}\0${n.anchor.rowIndex}`;
			out.set(key, (out.get(key) ?? 0) + 1);
		}
		return out;
	});
	const columnNoteCounts = $derived.by<Map<string, number>>(() => {
		const out = new Map<string, number>();
		for (const n of notesStore.notes) {
			if (n.anchor.kind !== 'cell') continue;
			if (n.anchor.rowIndex !== -1) continue;
			out.set(n.anchor.column, (out.get(n.anchor.column) ?? 0) + 1);
		}
		return out;
	});

	/**
	 * First-note-id map for the pin click. The pin shows the note's NUMBER
	 * (matching the NotesPane's bubble index, 1-based) — so cell A's pin
	 * might say "1", cell B's pin "2", etc., in the same order the user
	 * sees them in the right pane. We store the FIRST note's id per cell
	 * (and per column for column-level notes); the pin click focuses that
	 * first one. If a cell holds 2+ notes, the title attribute shows
	 * "3 notes" but the badge shows the first note's number — keeps the
	 * "1, 2, 3" ordering visual consistent.
	 *
	 * This mirrors the same `cellNoteFirstId` derivation in SpreadsheetViewer.
	 */
	const cellNoteFirstId = $derived.by<Map<string, string>>(() => {
		const out = new Map<string, string>();
		for (const n of notesStore.notes) {
			if (n.anchor.kind !== 'cell') continue;
			if (n.anchor.rowIndex < 0) continue;
			const key = `${n.anchor.column}\0${n.anchor.rowIndex}`;
			if (!out.has(key)) out.set(key, n.id); // first wins
		}
		return out;
	});
	const columnNoteFirstId = $derived.by<Map<string, string>>(() => {
		const out = new Map<string, string>();
		for (const n of notesStore.notes) {
			if (n.anchor.kind !== 'cell') continue;
			if (n.anchor.rowIndex !== -1) continue;
			if (!out.has(n.anchor.column)) out.set(n.anchor.column, n.id);
		}
		return out;
	});

	/**
	 * Per-cell "pane number" — the 1-based index this cell's FIRST note has
	 * in the NotesPane bubble list. Drives the pin label so the cell's amber
	 * disc shows "1" when the first note is at position 1 in the right pane,
	 * "2" when it's at position 2, etc. — matching the bubble ordering.
	 *
	 * Why the first note's number (and not the count): with 3 notes sharing
	 * a cell, we used to show "3" (the count). The user wants the pins to
	 * follow the same 1, 2, 3, … ordering as the NotesPane so they can
	 * visually map pin → bubble without counting. If a cell has 2+ notes, we
	 * show the first's pane number in the badge and append "+" in the title
	 * so the user knows there are more.
	 */
	const cellNotePaneNumber = $derived.by<Map<string, number>>(() => {
		const out = new Map<string, number>();
		notesStore.notes.forEach((n, i) => {
			if (n.anchor.kind !== 'cell') return;
			if (n.anchor.rowIndex < 0) return;
			const key = `${n.anchor.column}\0${n.anchor.rowIndex}`;
			if (!out.has(key)) out.set(key, i + 1); // first wins
		});
		return out;
	});
	const columnNotePaneNumber = $derived.by<Map<string, number>>(() => {
		const out = new Map<string, number>();
		notesStore.notes.forEach((n, i) => {
			if (n.anchor.kind !== 'cell') return;
			if (n.anchor.rowIndex !== -1) return;
			if (!out.has(n.anchor.column)) out.set(n.anchor.column, i + 1);
		});
		return out;
	});

	/**
	 * Pin click handler. Called from the <td> pin and the column header pin.
	 * Opens the Notes popover if it isn't already open, then requests focus
	 * on the matching note bubble. The popover is gated by a single
	 * `workspace.openPane` slot, so opening the Notes popover while the
	 * analyzer popover is open will swap them (handled by Workspace.svelte).
	 */
	function onPinClick(noteId: string) {
		if (workspace.openPane?.kind !== 'notes') {
			workspace.openNotesPane();
		}
		workspace.requestFocusNote(noteId);
	}

	/** Brief ring on the cell the user just clicked-to-jump to. */
	let highlightKey = $state<string | null>(null);
	let highlightTimer: ReturnType<typeof setTimeout> | null = null;
	const HIGHLIGHT_MS = 1400;
	function flashHighlight(col: string, rowIndex: number) {
		const key = `${col}\0${rowIndex}`;
		highlightKey = key;
		if (highlightTimer) clearTimeout(highlightTimer);
		highlightTimer = setTimeout(() => {
			highlightKey = null;
			highlightTimer = null;
		}, HIGHLIGHT_MS);
	}

	/** Scroll-to-cell effect (CSV path).
	 *
	 * target.rowIndex is the ORIGINAL file row index (__rowIdx__), not a display
	 * position. We resolve it to the current visual position in sortedRows so the
	 * scroll lands on the correct row even when filter/sort is active.
	 *
	 * If the target row is currently filtered out, we clear the active filter and
	 * return WITHOUT clearing the signal — sortedRows will expand, this effect
	 * re-runs, and the second pass finds and scrolls to the row. */
	$effect(() => {
		const target = workspace.scrollToCell;
		if (!target) return;
		// CSV is single-sheet — no sheet name to compare.

		// Resolve original file row index → current display position.
		// sortedRows[i].__rowIdx__ holds the original index stamped at parse time.
		// Falls back to treating rowIndex as a display position for legacy notes
		// that pre-date the __rowIdx__ stamp (created before this change).
		let visualIdx = sortedRows.findIndex(
			(r) => (r as Record<string, unknown>).__rowIdx__ === target.rowIndex
		);
		if (visualIdx === -1) {
			if (workspace.activeFilter) {
				// Row is filtered out — clear the filter; effect re-runs with all rows.
				// We do NOT clear the scroll signal here so the re-run can find it.
				workspace.clearActiveFilter();
				return;
			}
			// No filter active but __rowIdx__ not found (legacy note): fall back to
			// treating the stored rowIndex as a display index (old behavior).
			visualIdx = Math.min(target.rowIndex, sortedRows.length - 1);
		}

		// Render the target row into the virtual window, then position the
		// scroll (see scrollRowIntoView).
		const clamped = Math.min(
			Math.max(0, visualIdx - OVERSCAN),
			Math.max(0, totalBuffered - RENDER_SIZE)
		);
		// Wrap the windowStart write in untrack so this effect does NOT re-run when
		// the scroll handler later adjusts windowStart on user scroll.
		untrack(() => {
			programmaticWindowStart = clamped;
			if (clamped !== windowStart) windowStart = clamped;
			// Pre-position the lock at the target so the rendered block is already
			// close before scrollRowIntoView measures (no top-flash).
			const preAnchor = rowIndexToScrollTop(visualIdx);
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
		});
		const col = target.column;
		// One-shot: clear the trigger so the effect doesn't re-fire on subsequent
		// scroll-handler adjustments.
		workspace.clearScrollToCell();
		void scrollRowIntoView(visualIdx, col, clamped);
	});

	// ── "Row [n] / total" jump control (CSV toolbar) ────────────────────────
	// Independent of the note-pin scrollToCell signal above — this is a
	// direct, local UI interaction (type a row number, land there), styled
	// after PdfViewer's "Page [n] / numPages" control. Deliberately uses
	// VISUAL/display row position (current sortedRows order, post sort/filter)
	// rather than the stable __rowIdx__ file-origin index that scrollToCell
	// resolves — "row 42" means "the 42nd row you can currently see," so no
	// filter-clearing dance is needed the way the note-jump signal requires.
	/** The row-jump input's own value — null when the field is empty mid-edit. */
	let csvRowJumpValue = $state<number | null>(1);

	function commitCsvRowJump() {
		if (csvRowJumpValue === null || !Number.isFinite(csvRowJumpValue) || totalBuffered === 0) {
			csvRowJumpValue = null;
			return;
		}
		// 1-based input → 0-based visual index, clamped into range.
		const visualIdx = Math.max(0, Math.min(Math.round(csvRowJumpValue) - 1, totalBuffered - 1));
		csvRowJumpValue = visualIdx + 1; // reflect the clamped value back into the input
		const clamped = Math.min(
			Math.max(0, visualIdx - OVERSCAN),
			Math.max(0, totalBuffered - RENDER_SIZE)
		);
		untrack(() => {
			programmaticWindowStart = clamped;
			if (clamped !== windowStart) windowStart = clamped;
			// Land exactly on the row: scrollTop is row * ROW_HEIGHT.
			lockedScrollTop = rowIndexToScrollTop(visualIdx);
			scrollLockUntil = performance.now() + SCROLL_LOCK_MS;
		});
		// flashHighlight() needs a column to key the highlight ring on — there's
		// no "selected" column for a pure row jump, so flash the first column as
		// a visible "you landed here" confirmation, matching the note-jump flash.
		const col = csvData?.columns[0] ?? '';
		void scrollRowIntoView(visualIdx, col, clamped);
	}

	function handleCsvRowJumpKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			(e.target as HTMLInputElement).blur();
		}
	}

	/** Phase 2 of the note jump: after the virtual window has rendered the
	 *  target row, position it via a SINGLE direct scrollTop assignment (no
	 *  scrollIntoView). scrollIntoView animates and can chase the rendered block
	 *  as the window re-anchors — the "keeps flinging down" symptom. A one-shot
	 *  scrollTop set is instant, and the scroll lock (below) holds the window
	 *  fixed so the synthetic scroll events it fires — plus any leftover
	 *  momentum — can't drag us off the row. */
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
			// Center the row using its live offset within the scroll content.
			const elTop = el.offsetTop;
			const centered = elTop - Math.max(0, (scrollEl.clientHeight - ROW_HEIGHT) / 2);
			const maxST = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
			const finalTop = Math.max(0, Math.min(centered, maxST));
			scrollEl.scrollTop = finalTop;
			lockedScrollTop = finalTop; // re-asserted during the lock to kill momentum
			// Record the exact row just landed on so the next wheel tick steps from it.
			lastKnownRowIndex = visualIdx;
		}
		flashHighlight(col, visualIdx);
	}



	/** Focus-once-then-clear: the just-created/clicked note, used by

	 *  NotesPane to scroll/focus the matching bubble. */
	$effect(() => {
		const id = workspace.focusNoteId;
		if (!id) return;
		// No-op here; NotesPane owns the scroll/focus behavior. The
		// CSV viewer just records that something happened (so the
		// effect doesn't fire stale). clearFocusNote runs from
		// NotesPane after consuming the signal.
		void id;
	});

	// The row the wheel handler is currently on. Jumps (row-jump box, note pin)
	// set it to the exact target row; native scroll (scrollbar drag, keyboard)
	// updates it from scrollTop in applyScrollWindow. handleWheel steps from it
	// instead of re-deriving the row from scrollTop.
	let lastKnownRowIndex = 0;

	function applyScrollWindow() {
		if (!scrollEl) return;
		const rowIdx = scrollTopToRowIndex(scrollEl.scrollTop);
		lastKnownRowIndex = rowIdx;
		// Center the window on the target row: render OVERSCAN rows above so a
		// one-frame lag in EITHER direction never reaches the spacer.
		const desired = Math.max(0, rowIdx - OVERSCAN);
		const clamped = Math.min(desired, Math.max(0, totalBuffered - RENDER_SIZE));
		if (clamped !== windowStart) windowStart = clamped;
	}

	/**
	 * Silent scrollTop clamp. Called from the second (settle) rAF after
	 * applyScrollWindow has re-rendered the table. If the user's current
	 * scrollTop is now past the new scrollHeight (which happens when a
	 * streaming chunk arrives, the streaming indicator disappears, or a
	 * filter narrows the row count), the browser would otherwise silently
	 * snap the user back to the new max — the symptom is "scroll blocked
	 * past the last note". We proactively set scrollTop to the new max so
	 * the user just sees a smooth tail of the table.
	 *
	 * We don't tell the user anything (per requirement B). The snap happens
	 * in the same rAF as the re-render, so it's imperceptible.
	 */
	function clampScrollAfterRender() {
		if (!scrollEl) return;
		const max = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
		if (scrollEl.scrollTop > max) {
			scrollEl.scrollTop = max;
		}
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
	 * Wheel / trackpad scroll, throttled. The browser's native scroll has no
	 * row-count awareness: a fast flick (plus its momentum tail) can cover
	 * thousands of pixels, i.e. 1000+ rows, in one gesture. preventDefault()
	 * stops the native scroll; we instead step the CURRENT row index by a
	 * small, capped amount (further throttled by the gesture window above) and
	 * convert it to an exact scrollTop, so even a fast, sustained swipe can
	 * never move more than a bounded distance.
	 *
	 * With the scroll lock ON (off by default; toggled from the toolbar) vertical
	 * wheel input is ignored entirely; the scrollbar, the Row box and the
	 * keyboard still work.
	 */
	function handleWheel(e: WheelEvent) {
		if (!scrollEl || totalBuffered === 0) return;

		const action = wheelAction(e.deltaX, e.deltaY, e.ctrlKey, scrollLock.locked);
		if (action === 'pass') return; // pinch-zoom, or sideways scroll with the lock off
		if (action === 'block') {
			e.preventDefault();
			return;
		}
		if (action === 'scroll-horizontal') {
			// Lock ON: scroll sideways ourselves and apply ONLY the horizontal
			// part. Letting the browser do it also applied the swipe's small
			// vertical component, so the table drifted and then jumped rows.
			e.preventDefault();
			scrollEl.scrollLeft += horizontalDeltaPx(e.deltaX, e.deltaMode, scrollEl.clientWidth);
			return;
		}

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

		// Step from lastKnownRowIndex (the exact row of the last jump or wheel
		// step) rather than re-deriving it from scrollTop.
		const targetRowIdx = Math.max(0, Math.min(lastKnownRowIndex + rowStep, totalBuffered - 1));
		lastKnownRowIndex = targetRowIdx;

		scrollEl.scrollTop = rowIndexToScrollTop(targetRowIdx);
	}

	/**
	 * Arrow / Page / Home / End navigation. Listens on the WINDOW so it works
	 * whenever the user isn't typing, with no need for the table to hold focus
	 * (jumping with the Row box leaves focus on <body>). Each key moves
	 * scrollTop relative to where the view IS — a jump centers the target row,
	 * so stepping from a derived "current row" shifted the view by half a page.
	 */
	function handleWindowKeydown(e: KeyboardEvent) {
		if (!scrollEl || totalBuffered === 0 || e.defaultPrevented) return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		// Only act while THIS table is on screen and the user isn't typing in a
		// field, a dialog, or on a control that owns the arrow keys.
		if (!scrollEl.isConnected || scrollEl.offsetParent === null) return;
		const t = e.target as HTMLElement | null;
		if (t) {
			const tag = t.tagName;
			if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
			if (t.closest('[role="dialog"], [role="separator"], [role="menu"], [role="tablist"]')) return;
		}
		// Left/Right pan sideways (works regardless of the scroll lock, which
		// only affects wheel/trackpad). Up/Down/Page/Home/End keep working too
		// while locked -- the lock never applied to the keyboard, only the wheel.
		{
			const maxLeft = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth);
			const nextLeft = keyScrollLeftTarget(e.key, scrollEl.scrollLeft, maxLeft);
			if (nextLeft !== null) {
				e.preventDefault();
				scrollEl.scrollLeft = nextLeft;
				return;
			}
		}
		const maxTop = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
		const next = keyScrollTarget(e.key, scrollEl.scrollTop, scrollEl.clientHeight, maxTop);
		if (next === null) return;
		e.preventDefault();
		programmaticWindowStart = null; // a deliberate key press ends any jump lock
		scrollEl.scrollTop = next;
		lastKnownRowIndex = scrollTopToRowIndex(next);
	}

	/**
	 * Svelte action: attach `wheel` as a NON-PASSIVE native listener.
	 * Svelte 5's `onwheel={...}` attribute binds the listener as PASSIVE, so
	 * preventDefault() would silently no-op (see
	 * https://github.com/sveltejs/svelte/issues/15066). Also assigns
	 * `scrollEl` on mount so a wheel event on a freshly-opened file always
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
		// drift.
		const sl = scrollEl.scrollLeft;
		if (sl !== lastSeenScrollLeft) {
			lastSeenScrollLeft = sl;
			// Leave windowStart (the rendered rows) untouched.
			return;
		}
		if (rafPending) return;
		rafPending = true;
		requestAnimationFrame(() => {
			rafPending = false;
			applyScrollWindow();
			// Settle pass: capture the final resting position after momentum,

			// THEN clamp scrollTop to the new max if the spacer height dropped
			// (streaming chunk arrived, streaming indicator disappeared, filter
			// narrowed the row count). Runs in the SAME rAF as the re-render
			// so the snap is imperceptible — no toast, no flash, no toast bar.
			requestAnimationFrame(() => {
				applyScrollWindow();
				clampScrollAfterRender();
			});
		});
	}


	// ============================================================
	// Column header sort — toggle: none → asc → desc → none
	// Executes sort directly via executeSort(), no LLM call.
	// ============================================================
	function handleHeaderClick(col: string) {
		const current = workspace.activeSort;
		if (!current || current.column !== col) {
			// Different column or no sort → start asc
			workspace.setActiveSort({ column: col, direction: 'asc' });
		} else if (current.direction === 'asc') {
			// Same column, asc → desc
			workspace.setActiveSort({ column: col, direction: 'desc' });
		} else {
			// Same column, desc → remove sort
			workspace.clearActiveSort();
		}
		// Reset virtual scroll to top after sort
		windowStart = 0;
	}

	$effect(() => { if (workspace.file) windowStart = 0; });

	// Reset the virtual-scroll window to the top whenever the active filter or
	// sort changes. Without this, applying a filter while scrolled down (e.g.
	// windowStart=5000) leaves visibleRows = sortedRows.slice(5000, …) — but a
	// filtered result often has FEWER rows than the old offset, so the slice is
	// empty and the pane looks blank ("the filter is applied but it's not
	// visible"). Re-reading activeFilter/activeSort here makes this effect re-run
	// on every filter/sort change; we snap both the virtual window and the real
	// DOM scrollTop back to 0 so the matching rows are shown immediately.
	$effect(() => {
		// touch the reactive deps so the effect re-runs when they change
		void workspace.activeFilter;
		void workspace.activeSort;
		windowStart = 0;
		if (scrollEl) scrollEl.scrollTop = 0;
	});

	// ============================================================
	// Lens detection + contract profile wiring
	// ============================================================

	/**
	 * Normalize extracted contract text for even, block-like reading.
	 *
	 * PDF/DOCX text extraction inserts a hard "\n" at every VISUAL line wrap, so
	 * the raw text is full of mid-sentence breaks that the highlighter (rendered
	 * with `whitespace: pre-line`) would reproduce as a ragged column. We collapse
	 * those SOFT (single) newlines back into spaces while PRESERVING real
	 * paragraph breaks (runs of 2+ newlines → a single blank line). The result
	 * reflows as full-width justified paragraphs.
	 *
	 * This runs at the SINGLE source that feeds BOTH the rendered text and the
	 * character offsets stored per clause (clauseStore slices THIS string), so the
	 * normalization keeps offsets perfectly self-consistent — no remapping needed.
	 */
	function normalizeContractText(raw: string): string {
		return (
			raw
				// Normalize line endings first so the newline runs are uniform.
				.replace(/\r\n?/g, '\n')
				// Protect paragraph breaks: collapse 2+ newlines (optionally with
				// surrounding spaces) to a sentinel we restore after soft-wrap removal.
				.replace(/[ \t]*\n[ \t]*\n[ \t]*\n*/g, '\u0000')
				// Soft wraps: a lone newline mid-paragraph → a single space.
				.replace(/[ \t]*\n[ \t]*/g, ' ')
				// Restore paragraph breaks.
				.replace(/\u0000/g, '\n\n')
				// Collapse any runs of spaces/tabs introduced by the joins.
				.replace(/[ \t]{2,}/g, ' ')
		);
	}

	/** Extracted plain text for the current file (drives lens detection). */
	const documentText = $derived.by<string>(() => {
		const f = workspace.file;
		if (!f) return '';
		if (f.type === 'txt' || f.type === 'md') return (f.parsedData as string) ?? '';
		// PDF/DOCX extraction inserts soft line-wrap newlines — normalize them so
		// the contract reads as even, justified blocks (offsets stay consistent
		// because this is the SAME string the clause store slices).
		if (f.type === 'docx' || f.type === 'pdf')
			return normalizeContractText((f.parsedData as StructuredText)?.text ?? '');
		return ''; // csv/excel → spreadsheet lens, text not consulted
	});

	/** Effective lens: manual override wins over auto-detection (from the store). */
	const effectiveLens = $derived<Lens | null>(workspace.effectiveLens);

	// Auto-detect the lens whenever a new file is opened. detectLens is
	// deterministic and cheap; it sets the auto-detected lens (override, if any,
	// still wins via the store's effectiveLens). Runs once per file.
	$effect(() => {
		const f = workspace.file;
		const name = f?.name ?? '';
		const text = documentText;
		if (!f) return;
		const lens = detectLens(text, name);
		workspace.setLens(lens);
	});

	// ── Manual clause splitting is the DEFAULT contract experience ─────────────
	//
	// The automatic splitter NO LONGER runs on upload. Instead, when the
	// effective lens is 'contract', we present ClauseSplitter so the user marks
	// clause boundaries themselves. Only when they confirm (Done / Confirm /
	// auto-detect→Done) do we build the profile from THEIR chosen clauses.
	//
	// `manualClauses` holds the user's confirmed segmentation. While it is null
	// (and the lens is 'contract') the ClauseSplitter is shown. Reset per file.

	/** The user's confirmed clause segmentation (null = still splitting). */
	let manualClauses = $state<Clause[] | null>(null);

	/** Restored manual split offsets for re-opened contracts (seed the splitter). */
	let restoredSplits = $state<number[]>([]);

	// Reset the manual-split flow whenever the source document text changes (new
	// file, or text re-extracted). Also restore any persisted split offsets so a
	// re-opened contract resumes where the user left off.
	let splitFlowFor = $state<string | null>(null);
	$effect(() => {
		const text = documentText;
		const lens = workspace.effectiveLens;
		if (lens !== 'contract') {
			// Not a contract → clear any prior profile/clauses. NOTE: we do NOT
			// touch clauseStore here. The marks are bound to the DOCUMENT (see the
			// bindDocument effect below), not the lens, so toggling between the
			// contract and document lenses preserves the user's highlights.
			manualClauses = null;
			restoredSplits = [];
			splitFlowFor = null;
			if (workspace.contractProfile || workspace.contractProfileLoading) {
				workspace.setContractProfile(null);
				workspace.setContractProfileLoading(false);
			}
			return;
		}
		if (splitFlowFor === text) return; // same doc, already initialized
		splitFlowFor = text;
		manualClauses = null;
		// Resume persisted manual splits for this contract session (if any).
		// workspace.splitMode tells us which set is active; we only restore the
		// MANUAL offsets into the splitter (auto re-runs deterministically).
		restoredSplits = [];
		// Clear any stale profile from a previous document.
		workspace.setContractProfile(null);
		workspace.setContractProfileLoading(false);
	});

	// Bind the clause store to the current DOCUMENT (not the lens). This is what
	// makes highlights survive a lens toggle: bindDocument() is a no-op while the
	// document text + contract id are unchanged, so switching contract ⇄ document
	// keeps every mark. When the document text actually changes (new file), it
	// loads the new document's persisted `clauses` (or starts clean); when the id
	// transitions null → real (a fresh upload that just got persisted on export),
	// it migrates the in-memory marks into the new record. Marks now live on
	// CesvuDocument.clauses, so they travel inside the _cesvu.zip export.
	$effect(() => {
		const text = documentText;
		const contractId = workspace.activeContractId;
		const lens = workspace.effectiveLens;
		if (!text) return;
		// Await the (async) bind so any restored marks are in place BEFORE
		// auto-detect runs — otherwise auto-detect could see an empty set and
		// clobber the just-loaded clauses.
		void clauseStore.bindDocument(text, contractId).then(() => {
			// HYBRID CLAUSE SELECTION: as soon as the contract lens is active for a
			// document, run auto-detect. It's idempotent (no-op once it has run for
			// this document, and a no-op when marks were restored from a prior
			// session), so re-runs on lens toggles are free. The user then reviews
			// the green/yellow/red boundaries and accepts or adjusts them.
			if (lens === 'contract') {
				void clauseStore.autoDetect(text);
			}
		});
	});




	/**
	 * "Run Full Analysis" (from ClauseSidebar) — turn the live highlighted clauses
	 * into a Clause[] and funnel them through the SAME buildProfileFromClauses()
	 * shared core the manual splitter used, enriching the session with parties /
	 * dates / missing-clause warnings. Each marked span becomes a Clause keyed by
	 * its stable store id (so the existing scroll/highlight bridge keeps working).
	 * Also persists the highlight start offsets via the manual split path (no
	 * schema change — highlights ARE character offsets) and the built profile.
	 */
	/**
	 * LLM refinement callback for party extraction. Uses ONLY an ALREADY-loaded
	 * model (getCachedModel) so building a profile never triggers a ~900MB model
	 * download or blocks on inference. When no model is cached the extractor
	 * silently falls back to its deterministic regex candidates. Returns the raw
	 * completion text; the extractor parses the JSON itself.
	 */
	async function partyRunInference(prompt: string): Promise<string> {
		const pipe = getLoadedPipe();
		if (!pipe) throw new Error('no cached model');
		const result = await runInference(pipe, prompt, 256, { repetitionPenalty: 1.1 });
		return result.text ?? '';
	}

	/** Pass the LLM refiner ONLY when a model is already loaded (else regex-only). */
	function maybeRunInference() {
		return getLoadedPipe() ? partyRunInference : undefined;
	}


	let fullAnalysisRunning = $state(false);

	/** Mobile bottom-sheet expanded state for the contract-lens clause list —
	 *  mirrors ContractSidebar.svelte's `sheetOpen` narrow-screen pattern.
	 *  Collapsed by default so it doesn't eat 45% of the viewport on open. */
	let mobileClauseSheetOpen = $state(false);

	/**
	 * Which tab the mobile sheet is showing — 'clauses' (ClauseSidebar) or
	 * 'notes' (NotesPane). On desktop (lg+) these render as two SEPARATE
	 * regions (the always-visible ClauseSidebar column + the right-rail
	 * NotesPane in Workspace.svelte), but on mobile there's only one sheet,
	 * so it needs its own tab switcher to host both.
	 */
	let mobileSheetTab = $state<'clauses' | 'notes'>('clauses');

	/**
	 * Dropping (or clicking) a prose note pin fires workspace.requestFocusNote().
	 * On desktop that's consumed by the always-visible right-rail NotesPane, but
	 * on mobile the ONLY place NotesPane exists is inside this collapsible sheet
	 * (see Workspace.svelte's `hidden lg:flex` on the contract lens's outer right
	 * pane). Without this, a pin drop on mobile silently created the note with no
	 * visible editor to type into — "I click and nothing happens". Auto-open the
	 * sheet on the Notes tab so NotesPane mounts and its own focusNoteId effect
	 * can scroll/focus the new note's textarea.
	 */
	$effect(() => {
		const id = workspace.focusNoteId;
		if (!id) return;
		const note = notesStore.notes.find((n) => n.id === id);
		if (!note || note.anchor.kind !== 'prose') return;
		mobileSheetTab = 'notes';
		mobileClauseSheetOpen = true;
	});

	function runFullAnalysis() {

		const marks = clauseStore.clauses;
		if (marks.length === 0) return;
		const text = documentText;

		// Map highlighted spans → Clause[] for the shared profile builder. Reuse
		// the store's stable id so downstream scroll-to-clause resolves correctly.
		const clauses: Clause[] = marks.map((m, i) => ({
			id: m.id,
			number: i + 1,
			title: m.heading ?? `Clause ${i + 1}`,
			text: m.text
		}));

		// Persist the highlight boundaries (start offsets) through the manual
		// split path — lossless and schema-compatible.
		onSplitsChange(
			marks.map((m) => m.startOffset),
			'manual'
		);

		fullAnalysisRunning = true;
		const myToken = ++contractBuildToken;
		workspace.setContractProfileLoading(true);
		buildProfileFromClauses(text, clauses, maybeRunInference())
			.then((profile) => {
				if (myToken !== contractBuildToken) return; // superseded
				workspace.setContractProfile(profile);
				workspace.setContractProfileLoading(false);
				workspace.persistProfile(profile);
				fullAnalysisRunning = false;
			})

			.catch((err: unknown) => {
				if (myToken !== contractBuildToken) return;
				console.warn('[DocumentPane] runFullAnalysis failed:', err);
				workspace.setContractProfile(null);
				workspace.setContractProfileLoading(false);
				fullAnalysisRunning = false;
			});
	}


	/**
	 * The user confirmed a clause split (manual, single, or auto via Done).
	 * Build the profile from THEIR clauses (shared core, identical to auto path),
	 * publish it to the store, and persist it best-effort.
	 */
	let contractBuildToken = 0;
	function onSplitComplete(clauses: Clause[]) {
		manualClauses = clauses;
		const text = documentText;
		const myToken = ++contractBuildToken;
		workspace.setContractProfileLoading(true);
		buildProfileFromClauses(text, clauses, maybeRunInference())
			.then((profile) => {
				if (myToken !== contractBuildToken) return; // superseded
				workspace.setContractProfile(profile);
				workspace.setContractProfileLoading(false);
				workspace.persistProfile(profile); // best-effort IndexedDB persist
			})

			.catch((err: unknown) => {
				if (myToken !== contractBuildToken) return;
				console.warn('[DocumentPane] buildProfileFromClauses failed:', err);
				workspace.setContractProfile(null);
				workspace.setContractProfileLoading(false);
			});
	}

	/**
	 * The splitter reports every divider edit so the offsets are persisted
	 * continuously — a tab close mid-split loses nothing. Best-effort.
	 */
	function onSplitsChange(offsets: number[], mode: SplitMode) {
		const splits: Partial<DocumentSplits> = { mode, [mode]: offsets };
		workspace.persistSplits(splits);
	}


	/** True when the contract lens is active (highlight/marking view). */
	const showContractView = $derived(effectiveLens === 'contract');

	/** The PDF page-jump toolbar control is DOCUMENT-lens-only (see its
	 *  render condition further down) — reset its state when switching INTO
	 *  the contract lens so a stale page count/ref from the document lens's
	 *  PdfViewer (now unmounted) never lingers if the user switches back and
	 *  forth. Mirrors the pdfBytes-keyed reset above, which covers the
	 *  "opened a different PDF" case; this covers the "same PDF, different
	 *  lens" case. */
	$effect(() => {
		if (showContractView) {
			pdfViewerRef = null;
			pdfNumPages = 0;
			pdfCurrentPage = 1;
		}
	});

	// NOTE: the scroll-to-clause PULL signal is now consumed inside
	// ClauseHighlighter (it owns the highlighted reading surface). DocumentPane
	// no longer renders per-clause anchor blocks, so the old anchor-scroll effect
	// was removed along with the divider-based ClauseSplitter results view.

	/** Lens override dropdown handler. '' (auto) clears the override. */
	function onLensOverrideChange(e: Event) {
		const v = (e.currentTarget as HTMLSelectElement).value;
		workspace.setLensOverride(v === 'auto' ? null : (v as Lens));
	}

</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="flex flex-col h-full bg-surface dark:bg-slate-950 overflow-hidden relative">

	<!-- PARSE PROGRESS OVERLAY -->
	{#if workspace.isParsing}
		<div class="absolute inset-0 z-30 flex flex-col items-center justify-center bg-surface/95 dark:bg-slate-950/95 backdrop-blur-sm">
			<div class="flex flex-col items-center gap-4 p-8 rounded-2xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800 shadow-2xl max-w-xs w-full mx-4">
				<div class="relative w-12 h-12">
					<div class="absolute inset-0 rounded-full border-2 border-gray-200 dark:border-slate-800"></div>
					<div class="absolute inset-0 rounded-full border-2 border-blue-500 border-t-transparent animate-spin"></div>
				</div>
				<div class="text-center space-y-1">
					<p class="text-sm font-medium text-gray-800 dark:text-gray-200">{workspace.parseProgress?.stage ?? 'Processing…'}</p>
					{#if workspace.parseProgress?.rowsRead !== undefined}
						<p class="text-xs text-gray-500 font-mono tabular-nums">
							{workspace.parseProgress.rowsRead.toLocaleString()} rows scanned
						</p>
						{#if workspace.parseProgress.rowsRead > 10_000}
							<p class="text-[10px] text-amber-600">Displaying capped rows · Stats reflect all rows</p>

						{/if}
					{/if}
				</div>
				<div class="w-full h-1 bg-gray-200 dark:bg-slate-800 rounded-full overflow-hidden">
					<div class="h-full bg-blue-600 rounded-full animate-[progress_1.5s_ease-in-out_infinite]" style="width: 40%"></div>
				</div>
				<p class="text-[10px] text-gray-400 dark:text-gray-600 text-center">Large files may take a moment.<br>The page will stay responsive.</p>
			</div>
		</div>
	{/if}

	<!-- File info bar. overflow-x-auto lets the middle badges/controls scroll
	     horizontally on narrow phones (iPhone SE etc.) instead of silently
	     overflowing; the close (✕) button is `sticky right-0` with its own
	     background so it NEVER scrolls out of reach — without this, on a
	     375px-wide screen the accumulated badges (file type, lens select,
	     filter, notes, size/row info) pushed the ✕ off the right edge with
	     no way to reach it, making the document impossible to close. -->
	{#if workspace.file}
		<div class="flex items-center gap-3 px-4 py-2 border-b border-gray-200 dark:border-slate-800 bg-surface dark:bg-slate-900 flex-shrink-0 overflow-x-auto">


			<span class="px-2 py-0.5 rounded text-[10px] font-mono font-medium uppercase bg-blue-100 dark:bg-blue-900/40 border border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-300">
				{workspace.file.type}
			</span>
			<span class="text-sm text-gray-700 dark:text-gray-300 font-medium truncate flex-1">{workspace.file.name}</span>

			<!-- Lens override — only meaningful for non-spreadsheet documents.
			     'Auto' clears the manual override and falls back to detectLens(). -->
			{#if !isExcel && !csvData}
				<label class="flex-shrink-0 inline-flex items-center gap-1.5 text-[10px] text-gray-500">
					<span class="uppercase tracking-wide">Lens</span>
					<select
						class="bg-gray-100 border border-gray-300 text-gray-800 dark:bg-slate-800 dark:border-slate-700 dark:text-gray-200 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-blue-500"
						value={workspace.lensOverride ?? 'auto'}
						onchange={onLensOverrideChange}
						aria-label="Document lens"
						title={workspace.lensOverride ? 'Manual override active' : `Auto-detected: ${workspace.detectedLens ?? '…'}`}
					>
						<option value="auto">Auto{workspace.detectedLens ? ` (${workspace.detectedLens})` : ''}</option>
						<option value="contract">Contract</option>
						<option value="document">Document</option>
					</select>
				</label>
			{/if}

			<!-- "Row [n] / total" jump control — CSV only, sits immediately LEFT of
			     the Filter button. Uses VISUAL row position (current sortedRows
			     order, post sort/filter) — see commitCsvRowJump()'s doc comment.
			     Commits on Enter or blur, NOT on every keystroke — same UX as
			     PdfViewer's page-jump control (typing "97" shouldn't jump to row
			     9 first). Out-of-range input is silently clamped rather than
			     shown as an error, for the same frictionless-input reason. -->
			{#if csvData && totalBuffered > 0}
				<label class="flex-shrink-0 inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
					<span class="uppercase tracking-wide text-[10px]">Row</span>
					<input
						type="number"
						min="1"
						max={totalBuffered}
						bind:value={csvRowJumpValue}
						onkeydown={handleCsvRowJumpKeydown}
						onblur={commitCsvRowJump}
						class="w-16 bg-gray-100 border border-gray-300 text-gray-800 dark:bg-slate-800 dark:border-slate-700 dark:text-gray-200 rounded px-1 py-0.5 text-xs text-center tabular-nums focus:outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
						aria-label="Jump to row (1 to {totalBuffered})"
						title="Jump to a row — press Enter or click away to go"
					/>
					<span class="tabular-nums">/ {totalBuffered.toLocaleString()}</span>
				</label>
			{/if}

			<!-- Scroll lock — OFF by default. While on, vertical trackpad / wheel
			     scrolling is ignored (a laptop trackpad swipe overshot); use the
			     scrollbar, the arrow / Page keys or the Row box. Shared with the
			     Excel viewer's identical button in SpreadsheetViewer.svelte. -->
			{#if csvData && totalBuffered > 0}
				<button
					type="button"
					onclick={() => scrollLock.toggle()}
					aria-pressed={scrollLock.locked}
					class="flex-shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors {scrollLock.locked ? 'border-blue-600/60 bg-blue-100 text-blue-800 dark:border-blue-700/60 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-300 text-gray-600 hover:bg-gray-100 dark:border-slate-700 dark:text-gray-400 dark:hover:bg-slate-800'}"
					title={scrollLock.locked ? 'Scroll lock ON — trackpad/wheel scrolling is disabled. Use the scrollbar, arrow keys or the Row box. Click to turn off.' : 'Scroll lock OFF — click to disable trackpad/wheel scrolling'}
				>
					<span aria-hidden="true">{scrollLock.locked ? '🔒' : '🔓'}</span> Scroll lock
				</button>
			{/if}

			<!-- Manual filter trigger — adds a condition row WITHOUT any LLM call.

			     Only shown for CSV tables (the only view with a filterable grid).
			     Sits just left of the file-size/meta block at the top of the pane. -->
			{#if csvData}
				<button
					onclick={addCondition}
					class="flex-shrink-0 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-amber-700/60 text-amber-300 hover:text-amber-100 hover:border-amber-500 hover:bg-amber-900/30 transition-colors"
					title="Add a filter condition"
				>
					<span aria-hidden="true">🔍</span> Filter
				</button>
			{/if}

			<!-- "Add Note" mode toggle. Shown for PDFs (any lens — PdfViewer has
			     no toolbar of its own, so without this button nothing ever calls
			     setNotesMode(true) for PDFs and clicking the page silently did
			     nothing; PdfViewer.handleSurfaceClick is gated on notesMode) AND
			     for the contract lens regardless of file type (txt/md/docx
			     contracts used to get this toggle from ClauseHighlighter's own
			     inline copy, which was removed as a duplicate now that it lives
			     here uniformly — the plain DOCUMENT lens for txt/md/docx still
			     gets this affordance for free from DocumentHighlighter's own
			     toolbar instead). Matches the pin icon + blue active state used
			     in DocumentHighlighter for visual consistency. Hidden for Excel
			     (SpreadsheetViewer owns its own toolbar) and DICOM (imaging viewer
			     has its own dedicated tooling, no plain-text note-pin concept).

			     The standalone "Notes" view-toggle button that used to live here
			     was removed — it duplicated the header's Chat/Notes tab (both
			     drove the same workspace.openPane slot), so the header tab is now
			     the single control for viewing this file's notes. -->
			{#if !isExcel && (isPdf || showContractView)}
				<button
					type="button"
					onclick={() => workspace.setNotesMode(!workspace.notesMode)}
					class="flex-shrink-0 inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border transition-colors
						{workspace.notesMode
							? 'bg-blue-600 text-white border-blue-500 font-semibold'
							: 'border-gray-300 text-gray-600 hover:text-gray-900 hover:border-gray-500 dark:border-gray-600 dark:text-gray-300 dark:hover:text-white dark:hover:border-gray-400'}"
					title={workspace.notesMode
						? `Add Note mode on — click the page to drop a note. Click to turn off.${isPdf ? ' Note: PDF pins are exact in the Contract lens but only approximate in the Document lens.' : ''}`
						: `Turn on Add Note mode, then click anywhere on the page to pin a note.${isPdf ? ' Note: PDF pins are exact in the Contract lens but only approximate in the Document lens.' : ''}`}
					aria-pressed={workspace.notesMode}
				>
					<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3">
						<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>
					</svg>
					Add Note
				</button>
			{/if}

			<!-- "Page [n] / numPages" jump control — PDFs in the DOCUMENT lens
			     ONLY. The contract lens renders PDFs through ClauseHighlighter
			     (the same flat, continuous-text reading surface used for
			     txt/md/docx there), NOT PdfViewer, so there is no mounted
			     PdfViewer instance for pdfViewerRef.goToPage() to call —
			     showContractView must be excluded or the control renders with
			     nothing behind it. DOCX/TXT/MD are skipped entirely (both
			     lenses) since mammoth/plain text have no pagination concept at
			     all — see docx.ts's header comment.
			     Commits on Enter or blur, NOT on every keystroke — otherwise typing
			     "97" would jump to page 9 first. Out-of-range input is silently
			     clamped by PdfViewer.goToPage() rather than shown as an error, to
			     stay frictionless (matches Chrome/Acrobat/Preview's own behavior). -->
			{#if isPdf && !showContractView && pdfNumPages > 0}
				<label class="flex-shrink-0 inline-flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
					<span class="uppercase tracking-wide text-[10px]">Page</span>
					<input
						type="number"
						min="1"
						max={pdfNumPages}
						bind:value={pdfPageInputValue}
						onkeydown={handlePdfPageInputKeydown}
						onblur={commitPdfPageJump}
						class="w-12 bg-gray-100 border border-gray-300 text-gray-800 dark:bg-slate-800 dark:border-slate-700 dark:text-gray-200 rounded px-1 py-0.5 text-xs text-center tabular-nums focus:outline-none focus:border-blue-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
						aria-label="Jump to page (1 to {pdfNumPages})"
						title="Jump to a page — press Enter or click away to go"
					/>
					<span class="tabular-nums">/ {pdfNumPages}</span>
				</label>
			{/if}


			<span class="text-xs text-gray-400 dark:text-gray-600 flex-shrink-0 flex items-center gap-1.5">
				{(workspace.file.size / 1024 / 1024).toFixed(1)} MB
				{#if csvData}
					·
				{#if isStreaming}
						<span class="text-blue-400 tabular-nums">{totalScanned.toLocaleString()} rows loading…</span>
						<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
					{:else if !workspace.activeFilter && totalScanned > liveRows.length}
						<span class="text-amber-500 tabular-nums" title="Column statistics were computed from all {totalScanned.toLocaleString()} rows.">
							Displaying {liveRows.length.toLocaleString()} of {totalScanned.toLocaleString()} rows · Stats reflect all rows
						</span>
					{:else}
						{liveRows.length.toLocaleString()} rows
					{/if}

					· {csvData.columns.length} cols
				{/if}
				{#if textData}· {textData.length.toLocaleString()} chars{/if}
				{#if structuredData}· {structuredData.text.length.toLocaleString()} chars{/if}
				{#if pdfStructured}· {pdfStructured.pageCount ?? 0} pages{/if}


			</span>
			<button
				onclick={() => workspace.reset()}
				class="sticky right-0 text-xs text-gray-500 hover:text-gray-900 dark:text-gray-300 dark:hover:text-white transition-colors flex-shrink-0 bg-surface dark:bg-slate-900 pl-2 pr-1 py-1 rounded"
				aria-label="Remove file"
			>✕</button>
		</div>
	{/if}


	<!-- Source-omitted banner — shown to a recipient who opened a _cesvu.zip whose
	     sender chose NOT to embed the original file. The extracted text + analysis
	     are all present; only the original binary (PDF/DOCX/…) is unavailable. -->
	{#if workspace.sourceOmitted}
		<div
			class="flex items-start gap-2 px-4 py-2 border-b border-amber-900/50 bg-amber-950/30 text-xs text-amber-200 flex-shrink-0"
			role="note"
		>
			<span aria-hidden="true">ℹ️</span>
			<span>
				The sender didn't include the original source file. You're viewing the extracted
				text and analysis; the original document isn't available to download.
			</span>
		</div>
	{/if}

	<!-- Main content -->

	<div class="flex-1 overflow-hidden">

		<!-- UPLOAD STATE -->
		{#if !workspace.file && !workspace.isParsing}
			<!-- items-start + overflow-y-auto: on mobile Safari the address bar
			     can collapse/expand the visible viewport AFTER layout, and this
			     pane's height is itself a `dvh`-based share of the shell (see
			     Workspace.svelte). Top-aligning with a scroll fallback means the
			     content is always reachable regardless of any dvh/vh mismatch —
			     the tightened spacing below (space-y-3, smaller dropzone padding
			     on mobile) keeps the WHOLE card (dropzone + divider + import
			     button) fitting on one screen without needing that scroll in the
			     common case. -->
			<div class="h-full flex items-start justify-center overflow-y-auto p-4 sm:p-6">
				<div class="w-full max-w-md space-y-3 sm:space-y-4 py-4">
					{#if workspace.error}
						<ErrorBanner message={workspace.error} />
					{/if}
					<FileDropzone

					acceptedTypes={['xlsx', 'csv', 'pdf', 'docx', 'txt', 'md']}
						onFileSelected={handleFileSelected}
					/>



					<!-- Open a previously shared Cesvu document. A picked or dropped
					     _cesvu.zip archive routes to the open flow (see handleFileSelected). -->
					<div class="flex items-center justify-center gap-2 text-xs text-gray-500">
						<span class="h-px flex-1 bg-gray-200 dark:bg-slate-800"></span>
						<span>or</span>
						<span class="h-px flex-1 bg-gray-200 dark:bg-slate-800"></span>
					</div>
					<button
						type="button"
						onclick={() => importInputEl?.click()}
						class="w-full inline-flex items-center justify-center gap-2 px-4 py-2 sm:py-2.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-100 hover:border-gray-400 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800 dark:hover:border-gray-600 text-sm font-medium text-gray-800 dark:text-gray-200 transition-colors"
					>
						<span aria-hidden="true">📄</span>
						<span>Import a Cesvu file</span>
					</button>

					<input
						bind:this={importInputEl}
						type="file"
						accept=".zip"
						onchange={onImportPicked}
						class="sr-only"
						aria-hidden="true"
						tabindex="-1"
					/>
				</div>
			</div>


		<!-- CONTRACT LENS — rebuilt clause view (uniform for txt/md/docx/pdf) +
		     left sidebar (risk summary, clauses, parties, dates). Clicking a
		     clause in the sidebar scrolls + highlights it here. -->
		{:else if showContractView}
			<!-- HIGHLIGHT-TO-MARK (default contract experience) — the user
			     highlights any clause and "Marks as Clause"; each mark is
			     classified locally and resolves in place in the live sidebar.
			     "Run Full Analysis" (≥3 marks) enriches the session with parties,
			     dates, and missing-clause warnings (full ContractSidebar). -->
			<!-- `relative` is REQUIRED here: the mobile bottom-sheet below is
			     `absolute inset-x-0 bottom-0`, which positions against the nearest
			     positioned ancestor. Without `relative` on THIS wrapper, the browser
			     climbs past it to whatever positioned ancestor exists further up the
			     tree, so `bottom-0` resolves against the WRONG box — the sheet lands
			     pinned near the top of the contract pane instead of the bottom. -->
			<div class="relative flex h-full overflow-hidden">
				<!-- Highlighter reading surface (left/main).
				     min-w-0 is REQUIRED: a flex item defaults to min-width:auto, which
				     refuses to shrink below its content width — so without it the
				     contract column overflows to the right (clipped under the sidebar
				     / off-screen). min-w-0 lets it shrink to the available space so the
				     text wraps and stays fully visible.
				     Bottom padding on mobile reserves room for the collapsed bottom-sheet
				     handle so the last lines of the document aren't hidden under it. -->
				<div class="flex-1 min-w-0 overflow-hidden pb-10 lg:pb-0">
					<ClauseHighlighter text={documentText} />
				</div>


				<!-- Live clause sidebar (right). It is ALWAYS rendered so clauses
				     marked AFTER "Run Full Analysis" still appear in the list. Once a
				     profile is built, its enriched summary (parties / dates / missing
				     clauses) renders as a header inside the SAME sidebar, and the
				     button becomes "Re-run" to fold in new marks. -->
				<div class="flex-shrink-0 w-[300px] border-l border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden hidden lg:flex lg:flex-col">
					<ClauseSidebar
						onRunAnalysis={runFullAnalysis}
						analyzing={fullAnalysisRunning}
						profile={workspace.contractProfile}
					/>
				</div>

				<!-- Mobile: live clause sidebar as a collapsible bottom sheet — mirrors
				     ContractSidebar.svelte's narrow-screen pattern (tap the header to
				     expand/collapse) so it doesn't permanently eat 45% of the viewport
				     over the reading surface. Collapsed, it's just a thin handle bar. -->
				<div
					class="lg:hidden absolute inset-x-0 bottom-0 border-t border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden flex flex-col z-30 transition-[height] duration-200"
					style="height: {mobileClauseSheetOpen ? '70dvh' : '2.5rem'}; padding-bottom: {mobileClauseSheetOpen ? 'env(safe-area-inset-bottom, 0px)' : '0px'};"
				>
					<!-- Header: tap to collapse/expand. When collapsed it's just a
					     thin handle bar (matches the pre-existing pattern); expanded,
					     it also hosts the Clauses/Notes tab switcher so the sheet can
					     host BOTH panes — mobile has no separate right-rail NotesPane
					     (see Workspace.svelte's `hidden lg:flex`), so this sheet is the
					     ONLY place a mobile user can type into a prose note. -->
					<button
						type="button"
						class="w-full flex-shrink-0 flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200"
						onclick={() => (mobileClauseSheetOpen = !mobileClauseSheetOpen)}
						aria-expanded={mobileClauseSheetOpen}
					>
						<span class="flex items-center gap-1.5">
							{#if mobileSheetTab === 'notes'}
								<svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor" class="w-3 h-3 text-amber-400">
									<path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/>
								</svg>
							{:else}
								<span aria-hidden="true">📋</span>
							{/if}
							{mobileSheetTab === 'notes' ? 'Notes' : 'Clauses'}

							<span class="text-gray-500 font-normal tabular-nums">
								({mobileSheetTab === 'notes' ? notesStore.count : clauseStore.count})
							</span>
						</span>
					<span aria-hidden="true" class="text-gray-500">{mobileClauseSheetOpen ? '▾' : '▸'}</span>
					</button>
					{#if mobileClauseSheetOpen}
						<!-- Tab switcher -->
						<div class="flex-shrink-0 flex items-center gap-1 px-3 pb-2 border-b border-gray-200 dark:border-slate-800">
							<button
								type="button"
								class="px-3 py-1 rounded-md text-xs font-medium transition-colors
									{mobileSheetTab === 'clauses' ? 'bg-gray-200 text-gray-900 dark:bg-slate-700 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}"
								onclick={() => (mobileSheetTab = 'clauses')}
							>
								📋 Clauses <span class="tabular-nums">({clauseStore.count})</span>
							</button>
							<button
								type="button"
								class="px-3 py-1 rounded-md text-xs font-medium transition-colors
									{mobileSheetTab === 'notes' ? 'bg-gray-200 text-gray-900 dark:bg-slate-700 dark:text-white' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}"
								onclick={() => (mobileSheetTab = 'notes')}
							>
								📝 Notes <span class="tabular-nums">({notesStore.count})</span>
							</button>
						</div>
						<div class="flex-1 min-h-0 overflow-hidden">
							{#if mobileSheetTab === 'notes'}
								<NotesPane />
							{:else}
								<ClauseSidebar
									onRunAnalysis={runFullAnalysis}
									analyzing={fullAnalysisRunning}
									profile={workspace.contractProfile}
								/>
							{/if}
						</div>
					{/if}
				</div>
			</div>

		<!-- EXCEL WORKBOOK — non-streaming SpreadsheetViewer (multi-sheet, tabs) -->
		{:else if isExcel}
			<SpreadsheetViewer />


		<!-- CSV TABLE — virtual scroll over live streaming rows -->
		{:else if csvData}
			<!-- Active filter bar — interactive multi-condition builder.
			     A flat list of conditions joined by AND. Each row reads left to
			     right: column → operator → value → remove (✕). Negation lives in
			     the operator dropdown (e.g. "not contains", "not after"), so there
			     is no separate NOT toggle. "+ Add condition" appends a row. Shown
			     whenever there's an active filter OR a condition row being edited. -->

			{#if workspace.activeFilter || conditions.length > 0}
				<div class="px-4 py-2 bg-amber-50 dark:bg-amber-950/60 border-b border-amber-300 dark:border-amber-800/60 flex-shrink-0 space-y-1.5">
					<!-- Header line: result count + clear -->
					<div class="flex items-center gap-2">
						<span class="text-amber-600 dark:text-amber-400 text-xs" aria-hidden="true">🔍</span>
						{#if workspace.activeFilter?.duplicatesOf}
							<!-- Duplicates-of-value banner: "Showing X rows where [Column] = [Value]" -->
							<span class="text-xs text-amber-700 dark:text-amber-300">
								Showing <strong class="text-amber-800 dark:text-amber-200 tabular-nums">{liveRows.length.toLocaleString()}</strong> rows
								where <strong class="text-amber-800 dark:text-amber-200">{workspace.activeFilter.duplicatesOf.column}</strong>
								= <strong class="text-amber-800 dark:text-amber-200">{workspace.activeFilter.duplicatesOf.value}</strong>
							</span>
						{:else}
							<span class="text-xs text-amber-700 dark:text-amber-300">
								Showing <strong class="text-amber-800 dark:text-amber-200 tabular-nums">{liveRows.length.toLocaleString()}</strong> rows
							</span>
						{/if}
						<button
							onclick={() => { conditions = []; workspace.clearActiveFilter(); }}
							class="ml-auto text-xs text-amber-700 hover:text-amber-900 dark:text-amber-500 dark:hover:text-amber-300 transition-colors px-2 py-0.5 rounded border border-amber-400 dark:border-amber-800 hover:border-amber-600"
						>Clear filter</button>
					</div>

					{#if workspace.activeFilter?.duplicatesOf}
						<!-- No editable rows for the duplicates-of-value filter; the banner
						     above already names the column and value. -->
					{:else if isReadOnlyFilter}

						<!-- Filter we couldn't represent as editable rows (OR / nested). -->
						<p class="text-xs text-amber-700 dark:text-amber-300/90 italic">
							matching <strong class="text-amber-800 dark:text-amber-200">"{workspace.activeFilter?.pattern}"</strong>
						</p>
					{:else}

						<!-- Editable condition rows -->
						{#each conditions as cond, idx (cond.id)}
							{#if idx > 0}
								<div class="flex items-center gap-2 pl-5">
									<span class="text-[10px] font-semibold tracking-wider text-amber-600/80 dark:text-amber-500/80 uppercase">and</span>
								</div>
							{/if}
							<div class="flex flex-wrap items-center gap-1.5 pl-5">
								<!-- Column → operator → value, read left to right. Negation is
								     baked into the operator dropdown (e.g. "not contains"). -->
								<!-- Column -->

								<select
									class="bg-white border border-amber-400 text-amber-900 dark:bg-amber-900/40 dark:border-amber-700/60 dark:text-amber-100 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-amber-500"
									value={cond.column}
									onchange={(e) => setConditionColumn(cond.id, (e.currentTarget as HTMLSelectElement).value)}
									aria-label="Filter column"
								>
									<option value="">All columns</option>
									{#each csvData.columns as c}
										<option value={c}>{c}</option>
									{/each}
								</select>

								<!-- Operator — op set depends on the column kind:
								     date → DATE_OPS, number → NUMBER_OPS, else TEXT_OPS -->
								<select
									class="bg-white border border-amber-400 text-amber-900 dark:bg-amber-900/40 dark:border-amber-700/60 dark:text-amber-100 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-amber-500"
									value={cond.op}
									onchange={(e) => setConditionOp(cond.id, (e.currentTarget as HTMLSelectElement).value)}
									aria-label="Comparison operator"
								>
									{#each (cond.kind === 'date' ? DATE_OPS : cond.kind === 'number' ? NUMBER_OPS : TEXT_OPS) as op}
										<option value={op.value}>{op.label}</option>
									{/each}
								</select>

								<!-- Value — date picker, numeric input, or free text -->
								{#if cond.kind === 'date'}
									<input
										type="date"
										class="bg-white border border-amber-400 text-amber-900 dark:bg-amber-900/40 dark:border-amber-700/60 dark:text-amber-100 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-amber-500 dark:[color-scheme:dark]"
										value={cond.value}
										onchange={(e) => setConditionValue(cond.id, (e.currentTarget as HTMLInputElement).value, false)}
										aria-label="Filter date value"
									/>
								{:else if cond.kind === 'number'}
									<input
										type="number"
										inputmode="decimal"
										step="any"
										class="bg-white border border-amber-400 text-amber-900 placeholder-amber-400 dark:bg-amber-900/40 dark:border-amber-700/60 dark:text-amber-100 dark:placeholder-amber-500/60 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-amber-500 w-28 dark:[color-scheme:dark]"
										value={cond.value}
										oninput={(e) => setConditionValue(cond.id, (e.currentTarget as HTMLInputElement).value, true)}
										placeholder="number…"
										aria-label="Filter number value"
									/>
								{:else}
									<input
										type="text"
										class="bg-white border border-amber-400 text-amber-900 placeholder-amber-400 dark:bg-amber-900/40 dark:border-amber-700/60 dark:text-amber-100 dark:placeholder-amber-500/60 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-amber-500 w-40"
										value={cond.value}
										oninput={(e) => setConditionValue(cond.id, (e.currentTarget as HTMLInputElement).value, true)}
										placeholder="value…"
										aria-label="Filter value"
									/>
								{/if}


								<!-- Remove this condition -->
								<button
									onclick={() => removeCondition(cond.id)}
									class="text-amber-500/70 hover:text-rose-600 dark:hover:text-rose-300 transition-colors px-1 text-sm leading-none"
									title="Remove condition"
									aria-label="Remove condition"
								>✕</button>
							</div>
						{/each}

						<!-- Add condition -->
						<div class="pl-5 pt-0.5">
							<button
								onclick={addCondition}
								class="inline-flex items-center gap-1 text-xs text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200 transition-colors px-2 py-0.5 rounded border border-dashed border-amber-500 dark:border-amber-700/70 hover:border-amber-600 dark:hover:border-amber-500"
							>
								<span class="text-sm leading-none">+</span> Add condition
							</button>
						</div>
					{/if}
				</div>
			{/if}


			<!-- Active sort banner -->
			{#if workspace.activeSort}
				<div class="flex items-center gap-2 px-4 py-2 bg-violet-50 dark:bg-violet-950/60 border-b border-violet-300 dark:border-violet-800/60 flex-shrink-0">
					<span class="text-violet-600 dark:text-violet-400 text-xs">{workspace.activeSort.direction === 'asc' ? '▲' : '▼'}</span>
					<span class="text-xs text-violet-700 dark:text-violet-300 flex-1">
						Sorted by <strong class="text-violet-800 dark:text-violet-200">{workspace.activeSort.column}</strong>
						({workspace.activeSort.direction === 'asc' ? 'ascending' : 'descending'})
					</span>
					<button
						onclick={() => workspace.clearActiveSort()}
						class="text-xs text-violet-700 hover:text-violet-900 dark:text-violet-500 dark:hover:text-violet-300 transition-colors px-2 py-0.5 rounded border border-violet-400 dark:border-violet-800 hover:border-violet-600"
					>Clear sort</button>
				</div>
			{/if}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<!-- overflow-anchor: none — this is a virtual scroller that moves its own
			     content (spacer rows + sliding row window). Chrome's scroll anchoring
			     would also shift scrollTop to compensate for rows moving, fighting the
			     arrow-key / jump positioning (keys overshot mid-sheet). -->
			<div class="h-full csv-scroll-container overflow-auto" style="overflow-anchor: none;" onscroll={handleTableScroll} use:nonPassiveWheel={handleWheel} role="region" aria-label="CSV data table">
				<table class="w-full text-xs border-collapse">
					<thead class="sticky top-0 z-10">
						<tr class="bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800">
							<th class="w-10 px-2 py-2.5 text-center text-gray-400 dark:text-gray-600 font-normal border-r border-gray-200 dark:border-slate-800 select-none">#</th>
							{#each csvData.columns as col}
								{@const sortState = workspace.activeSort?.column === col ? workspace.activeSort.direction : null}
								{@const colNotes = columnNoteCounts.get(col) ?? 0}
								<th
									class="px-3 py-2.5 text-left font-semibold whitespace-nowrap cursor-pointer select-none transition-colors
										{sortState ? 'text-violet-700 bg-violet-100 dark:text-violet-300 dark:bg-violet-950/30' : selectedColumn === col ? 'text-blue-700 bg-blue-100 dark:text-blue-300 dark:bg-blue-950/40' : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-200 dark:hover:bg-slate-800/60'}"
									onclick={(e) => { e.stopPropagation(); handleHeaderClick(col); }}
									oncontextmenu={(e) => openMenu(e, { kind: 'column', column: col, columns: csvData.columns })}
									title="Sort by {col}"
								>

									<span class="inline-flex items-center gap-1">
										{col}
										{#if sortState === 'asc'}
											<span class="text-violet-600 dark:text-violet-400 text-[10px]">▲</span>
										{:else if sortState === 'desc'}
											<span class="text-violet-600 dark:text-violet-400 text-[10px]">▼</span>
										{:else}
											<span class="text-gray-300 dark:text-gray-700 text-[10px] opacity-0 group-hover:opacity-100">⇅</span>
										{/if}
										{#if showCellPins && colNotes > 0}
											{@const colFirstId = columnNoteFirstId.get(col)}
											{@const colPaneNum = columnNotePaneNumber.get(col)}
											{#if colFirstId && colPaneNum !== undefined}
												<span
													class="cell-note-pin cell-note-pin--column"
													role="button"
													tabindex="0"
													title="{colNotes} column note{colNotes === 1 ? '' : 's'} (note #{colPaneNum} in pane)"
													aria-label="Open column note{colNotes === 1 ? '' : 's'} for {col} (note {colPaneNum} in pane)"
													onclick={(e) => { e.stopPropagation(); onPinClick(colFirstId); }}
													onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPinClick(colFirstId); } }}
												>{colPaneNum}</span>
											{/if}
										{/if}
									</span>
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						<!-- Top spacer -->
						{#if topSpacerPx > 0}
							<tr style="height: {topSpacerPx}px;"><td colspan={csvData.columns.length + 1}></td></tr>
						{/if}

						{#each visibleRows as row, i}
							{@const absIdx = windowStart + i}
							<!-- rowOrigIdx: the stable original file index (__rowIdx__ stamped at
							     parse time). Note anchors are keyed by this value, not absIdx, so
							     pins and highlight rings resolve correctly even after sort/filter. -->
							{@const rowOrigIdx = typeof (row as Record<string, unknown>).__rowIdx__ === 'number'
								? (row as Record<string, unknown>).__rowIdx__ as number
								: absIdx}
							<tr
								data-rowidx={absIdx}
								class="border-b border-gray-100 dark:border-slate-900 hover:bg-gray-50 dark:hover:bg-slate-900/60 transition-colors cursor-pointer group csv-row"
								onclick={() => selectRow(absIdx, row as Record<string, unknown>)}
							>
								<td
									class="px-2 py-1.5 text-center text-gray-400 dark:text-gray-700 border-r border-gray-100 dark:border-slate-900 select-none group-hover:text-gray-600 dark:group-hover:text-gray-500 tabular-nums"
									oncontextmenu={(e) => openMenu(e, { kind: 'row', rowIndex: absIdx, rowData: row as Record<string, unknown>, columns: csvData.columns })}
								>
									{absIdx + 1}
								</td>
								{#each csvData.columns as col}
									{@const cellNotes = cellNoteCounts.get(`${col}\0${rowOrigIdx}`) ?? 0}
									{@const isHighlightedCell = highlightKey === `${col}\0${absIdx}`}
									<td
										class="px-3 py-1.5 text-gray-700 dark:text-gray-300 whitespace-nowrap {selectedColumn === col ? 'bg-blue-50 dark:bg-blue-950/20' : ''} {isHighlightedCell ? 'cell-highlight' : ''} relative"
										onclick={(e) => { e.stopPropagation(); selectCell(col, absIdx, (row as Record<string, unknown>)[col]); }}
										oncontextmenu={(e) => openMenu(e, { kind: 'cell', column: col, value: (row as Record<string, unknown>)[col], rowIndex: absIdx, rowData: row as Record<string, unknown>, columns: csvData.columns })}
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
													title="{cellNotes} note{cellNotes === 1 ? '' : 's'} on {col} · row {absIdx + 1} (note #{cellPaneNum} in pane)"
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

						<!-- Bottom spacer -->
						{#if bottomSpacerPx > 0}
							<tr style="height: {bottomSpacerPx}px;"><td colspan={csvData.columns.length + 1}></td></tr>
						{/if}
					</tbody>
				</table>
			</div>

			<!-- Streaming indicator — OUTSIDE the scroll container.
			     Was previously a <tr> inside <tbody>, which made the table's
			     scrollHeight shrink the moment streaming finished (taking a row
			     with it). That shrink silently clamped the user's scrollTop,
			     which felt like "the scroll blocked past the last note". Now
			     the pill is a sticky footer below the table — the scroll
			     container's geometry is independent of streaming state, so
			     no clamp is ever needed. -->
			{#if isStreaming}
				<div
					class="flex-shrink-0 flex items-center justify-center gap-2 px-4 py-2 bg-white dark:bg-slate-900 border-t border-gray-200 dark:border-slate-800 text-xs text-blue-600 dark:text-blue-400"
					role="status"
					aria-live="polite"
					aria-label="Streaming more rows from file"
				>
					<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
					Loading more rows… ({totalScanned.toLocaleString()} scanned)
				</div>
			{/if}

		<!-- TEXT CONTENT (txt / md) — DOCUMENT lens. Rendered through
		     DocumentHighlighter so the same note-pin UX as the contract lens
		     applies: turn on Notes → click drops an amber pin at a char offset.
		     Both lenses render the SAME documentText and share notesStore, so a
		     note made here appears in the contract lens and vice-versa. -->
		{:else if textData !== null}
			<DocumentHighlighter text={documentText} onAddToContext={(t) => workspace.setSelection({ type: 'text', label: `"${t.slice(0, 40)}${t.length > 40 ? '…' : ''}"`, data: { text: t } })} />


		<!-- PDF — pixel-perfect canvas render + invisible selectable text layer.
		     Notes work directly on the page: turn on Notes → click drops an amber
		     pin at the APPROXIMATE position (offset ↔ proportional scroll height).
		     docTextLength lets PdfViewer map note offsets to/from page positions,
		     so a pin here is shared with the precise text/contract lenses. -->
		{:else if isPdf && pdfBytes}
			<PdfViewer
				bind:this={pdfViewerRef}
				bytes={pdfBytes}
				docTextLength={documentText.length}
				onAddToContext={handlePdfAddToContext}
				onNumPagesKnown={(n) => (pdfNumPages = n)}
				onPageChange={(p) => (pdfCurrentPage = p)}
			/>




		<!-- DOCX — DOCUMENT lens. Rendered through DocumentHighlighter over the
		     SAME normalized documentText the contract lens uses, so the note-pin
		     UX is identical and notes cross both lenses (a note pinned in the
		     contract view shows here and vice-versa). -->
		{:else if structuredData}
			<DocumentHighlighter text={documentText} onAddToContext={(t) => workspace.setSelection({ type: 'text', label: `"${t.slice(0, 40)}${t.length > 40 ? '…' : ''}"`, data: { text: t } })} />



		{:else if !workspace.isParsing}
			<div class="h-full flex items-center justify-center">
				<LoadingSpinner size="md" message="Loading document…" />
			</div>
		{/if}

	</div>
</div>

{#if menu}
	<CellContextMenu x={menu.x} y={menu.y} target={menu.target} onClose={closeMenu} />
{/if}

<!-- Open (_cesvu.zip import) modal -->
{#if showImport && importFile}
	<ImportModal
		file={importFile}
		onclose={() => { showImport = false; importFile = null; }}
		onimported={handleImported}
	/>
{/if}



<style>
	@keyframes progress {

		0%   { transform: translateX(-100%); }
		50%  { transform: translateX(150%); }
		100% { transform: translateX(150%); }
	}

	/* ── DOCX rendered HTML (mammoth.convertToHtml) — dark-mode typography ── */
	.docx-content :global(h1) { font-size: 1.6rem; font-weight: 700; color: #f1f5f9; margin: 1.4em 0 0.5em; line-height: 1.25; }
	.docx-content :global(h2) { font-size: 1.3rem; font-weight: 700; color: #e2e8f0; margin: 1.3em 0 0.45em; line-height: 1.3; }
	.docx-content :global(h3) { font-size: 1.1rem; font-weight: 600; color: #e2e8f0; margin: 1.2em 0 0.4em; }
	.docx-content :global(h4),
	.docx-content :global(h5),
	.docx-content :global(h6) { font-size: 1rem; font-weight: 600; color: #cbd5e1; margin: 1.1em 0 0.35em; }
	.docx-content :global(p) { color: #cbd5e1; line-height: 1.7; margin: 0 0 0.9em; }
	.docx-content :global(strong) { font-weight: 700; color: #f1f5f9; }
	.docx-content :global(em) { font-style: italic; }
	.docx-content :global(a) { color: #60a5fa; text-decoration: underline; }
	.docx-content :global(ul),
	.docx-content :global(ol) { margin: 0 0 0.9em 1.5em; color: #cbd5e1; line-height: 1.7; }
	.docx-content :global(ul) { list-style: disc; }
	.docx-content :global(ol) { list-style: decimal; }
	.docx-content :global(li) { margin: 0.2em 0; }
	.docx-content :global(blockquote) { border-left: 3px solid #475569; padding-left: 1em; margin: 0 0 0.9em; color: #94a3b8; font-style: italic; }
	.docx-content :global(table) { border-collapse: collapse; width: 100%; margin: 0 0 1.2em; font-size: 0.875rem; }
	.docx-content :global(th),
	.docx-content :global(td) { border: 1px solid #334155; padding: 0.4em 0.7em; text-align: left; color: #cbd5e1; vertical-align: top; }
	.docx-content :global(th) { background: #1e293b; color: #f1f5f9; font-weight: 600; }
	.docx-content :global(tr:nth-child(even) td) { background: #0f172a; }
	.docx-content :global(hr) { border: none; border-top: 1px solid #334155; margin: 1.4em 0; }
	.docx-content :global(code) { background: #1e293b; padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.85em; color: #e2e8f0; }

	/* ── DOCX light-mode overrides — applied when the app is in light mode
	     (see <html> class managed by mode-watcher). Mirrors the dark palette
	     above 1:1 with light equivalents. Selector is fully :global(...) since
	     Svelte's scoping analysis can't verify a split global()/local chain
	     will ever match, and flags it as an unused-selector warning. -->
	:global(html:not(.dark) .docx-content h1) { color: #0f172a; }
	:global(html:not(.dark) .docx-content h2) { color: #1e293b; }
	:global(html:not(.dark) .docx-content h3) { color: #1e293b; }
	:global(html:not(.dark) .docx-content h4),
	:global(html:not(.dark) .docx-content h5),
	:global(html:not(.dark) .docx-content h6) { color: #334155; }
	:global(html:not(.dark) .docx-content p) { color: #334155; }
	:global(html:not(.dark) .docx-content strong) { color: #0f172a; }
	:global(html:not(.dark) .docx-content a) { color: #2563eb; }
	:global(html:not(.dark) .docx-content ul),
	:global(html:not(.dark) .docx-content ol) { color: #334155; }
	:global(html:not(.dark) .docx-content blockquote) { border-left-color: #cbd5e1; color: #64748b; }
	:global(html:not(.dark) .docx-content th),
	:global(html:not(.dark) .docx-content td) { border-color: #e2e8f0; color: #334155; }
	:global(html:not(.dark) .docx-content th) { background: #f1f5f9; color: #0f172a; }
	:global(html:not(.dark) .docx-content tr:nth-child(even) td) { background: #f8fafc; }
	:global(html:not(.dark) .docx-content hr) { border-top-color: #e2e8f0; }
	:global(html:not(.dark) .docx-content code) { background: #f1f5f9; color: #1e293b; }

	/* Fixed row height for accurate virtual scroll spacer math */
	:global(.csv-row td) {

		height: 28px;
		max-height: 28px;
		overflow: hidden;
	}

	/* ── Cell-note pin (mirrors the contract view's `note-pin` for parity) ──
	 *
	 * 14px amber disc with the note's number (or count). When sitting in a
	 * <td> it's absolutely positioned in the top-left corner; when sitting
	 * inline in a column header it's a 16px disc. Only rendered while
	 * workspace.notesMode is on, so the dots are opt-in visual clutter.
	 */
	:global(.cell-note-pin) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 14px;
		height: 14px;
		padding: 0 3px;
		border-radius: 9999px;
		background: #fbbf24; /* amber-400 */
		color: #111827;      /* gray-900 */
		font-size: 9px;
		font-weight: 700;
		line-height: 1;
		box-shadow: 0 0 0 1.5px rgba(15, 23, 42, 0.85);
		z-index: 2;
		cursor: pointer;
		font-variant-numeric: tabular-nums;
	}
	:global(td.relative .cell-note-pin) {
		position: absolute;
		top: 2px;
		left: 2px;
	}
	:global(.cell-note-pin--column) {
		min-width: 16px;
		height: 16px;
		font-size: 10px;
		padding: 0 4px;
	}

	/* ── Scroll-to-cell highlight ring ─────────────────────────────────────
	 * 1.4s amber ring so the eye lands on the cell the user just clicked-to-jump
	 * to from a note bubble in the right NotesPane.
	 */
	:global(.cell-highlight) {
		box-shadow: inset 0 0 0 2px #fbbf24;
		animation: cell-highlight-fade 1.4s ease-out;
	}
	@keyframes cell-highlight-fade {
		0%   { box-shadow: inset 0 0 0 2px rgba(251, 191, 36, 0); background-color: rgba(251, 191, 36, 0.18); }
		15%  { box-shadow: inset 0 0 0 2px rgba(251, 191, 36, 1); background-color: rgba(251, 191, 36, 0.18); }
		100% { box-shadow: inset 0 0 0 2px rgba(251, 191, 36, 0); background-color: rgba(251, 191, 36, 0); }
	}

	/* Wide, always-visible scrollbar for the CSV table */
	.csv-scroll-container::-webkit-scrollbar {
		width: 16px;
		height: 16px;
	}
	.csv-scroll-container::-webkit-scrollbar-track {
		background: #111827; /* gray-900 */
	}
	.csv-scroll-container::-webkit-scrollbar-thumb {
		background: #4b5563; /* gray-600 */
		border-radius: 8px;
		border: 3px solid #111827;
	}
	.csv-scroll-container::-webkit-scrollbar-thumb:hover {
		background: #6b7280; /* gray-500 */
	}
	.csv-scroll-container::-webkit-scrollbar-corner {
		background: #111827;
	}

	/* Light-mode CSV scrollbar override */
	:global(html:not(.dark)) .csv-scroll-container::-webkit-scrollbar-track {
		background: #f9fafb; /* gray-50 */
	}
	:global(html:not(.dark)) .csv-scroll-container::-webkit-scrollbar-thumb {
		background: #cbd5e1; /* gray-300 */
		border-color: #f9fafb;
	}
	:global(html:not(.dark)) .csv-scroll-container::-webkit-scrollbar-thumb:hover {
		background: #94a3b8; /* gray-400 */
	}
	:global(html:not(.dark)) .csv-scroll-container::-webkit-scrollbar-corner {
		background: #f9fafb;
	}
</style>
