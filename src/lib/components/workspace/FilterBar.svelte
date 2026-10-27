<script lang="ts">
	/**
	 * FilterBar.svelte — editable AND-only filter bar driven by
	 * workspace.activeFilter.
	 *
	 * Used by SpreadsheetViewer.svelte (the XLSX path). DocumentPane
	 * still has its own inline conditions implementation — that one
	 * was the original; this component is the lift-target for a
	 * future refactor that consolidates the two.
	 *
	 * Behavior:
	 *  - Reads workspace.activeFilter and seeds an internal
	 *    `conditions` array (a flat list of AND-joined rows).
	 *  - Renders one row per condition: column → operator → value → ✕
	 *  - Edits publish back to workspace.activeFilter.
	 *  - Supports the same ops as the chat engine: text (contains / not
	 *    contains / equals / not equals), number (= / ≠ / < / ≤ / >
	 *    / ≥ / outside), date (on / not on / before / after / on or
	 *    before / on or after).
	 *  - The 'outside' op is a numeric op with a tuple value [lo, hi]
	 *    (IQR fence). It renders as a number row whose value is
	 *    "lo,hi" — the user can edit the two bounds in a single
	 *    input. The filter is stored as a single `outside` leaf in
	 *    workspace.activeFilter.filterTree, so every consumer
	 *    (SpreadsheetViewer's filter eval, DocumentPane's
	 *    filter-eval worker, the chat engine) treats it identically
	 *    to any other comparison op.
	 *  - Filters that can't be represented as AND-joined editable
	 *    rows (OR trees, nested groups) are shown as a read-only
	 *    banner with `describeFilter(tree)`.
	 */

	import { workspace } from '$lib/stores/workspace.svelte.js';
	import {
		evaluate as evalFilter,
		describeFilter,
		countMatches,
		type Filter,
		type FilterLeaf,
		type FilterOp
	} from '$lib/pipeline/filter.js';
	import { matchesValue } from '$lib/pipeline/valueMatch.js';

	// ── Props ──────────────────────────────────────────────────────────────

	interface Props {
		/** Column names for the picker dropdown. */
		columns: string[];
		/** The full row buffer — used to recompute matchCount on edits. */
		rows: Record<string, unknown>[];
		/** Optional: the live filtered row count. If not provided, we
		 *  recompute on the fly via countMatches(). */
		matchCount?: number;
	}

	let { columns, rows, matchCount: matchCountProp }: Props = $props();

	// ── Instance API ─────────────────────────────────────────────────────
	// Exposed so a parent (e.g. SpreadsheetViewer's toolbar "Filter" button)
	// can trigger "+ Add condition" from outside without duplicating the
	// conditions-array logic. Access via `bind:this={filterBarRef}` then
	// `filterBarRef.addCondition()`. See the addCondition() definition below
	// for the actual row-insertion logic — this is just the public handle.
	export function addConditionExternal() {
		addCondition();
	}

	// ── Operator dropdowns ────────────────────────────────────────────────

	const TEXT_OPS = [
		{ value: 'contains', label: 'contains' },
		{ value: 'not_contains', label: 'not contains' },
		{ value: 'eq', label: 'equals' },
		{ value: 'not_eq', label: 'not equals' }
	] as const;
	const NUMBER_OPS = [
		{ value: 'eq', label: '= equals' },
		{ value: 'neq', label: '≠ not equal' },
		{ value: 'lt', label: '< less than' },
		{ value: 'lte', label: '≤ less or equal' },
		{ value: 'gt', label: '> greater than' },
		{ value: 'gte', label: '≥ greater or equal' },
		{ value: 'outside', label: '↔ outside [lo, hi]' }
	] as const;
	const DATE_OPS = [
		{ value: 'on', label: 'on' },
		{ value: 'not_on', label: 'not on' },
		{ value: 'before', label: 'before' },
		{ value: 'not_before', label: 'not before' },
		{ value: 'after', label: 'after' },
		{ value: 'not_after', label: 'not after' },
		{ value: 'on_or_before', label: 'on or before' },
		{ value: 'on_or_after', label: 'on or after' }
	] as const;

	// ── Condition type + state ──────────────────────────────────────────

	interface Condition {
		id: number;
		column: string;
		kind: 'text' | 'number' | 'date';
		op: string;
		value: string;
	}

	let nextConditionId = 0;
	let conditions = $state<Condition[]>([]);
	let selfUpdate = false; // re-entrancy guard for the seed effect

	// Date helpers (same as DocumentPane)
	function dateInputToMs(iso: string): number | null {
		if (!iso) return null;
		const [y, m, d] = iso.split('-').map(Number);
		const ms = new Date(y, m - 1, d).getTime();
		return isNaN(ms) ? null : ms;
	}
	function msToDateInput(ms: number): string {
		const d = new Date(ms);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	}
	function dateInputToSlash(iso: string): string {
		const ms = dateInputToMs(iso);
		if (ms === null) return iso;
		const d = new Date(ms);
		return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
	}

	// Heuristics (mirrors DocumentPane)
	function columnIsDate(col: string): boolean {
		const cl = col.toLowerCase().replace(/[\s_-]/g, '');
		return /date|updated|created|modified|expir|issued|timestamp/.test(cl);
	}
	function columnIsNumber(col: string, cols: string[]): boolean {
		if (!col || columnIsDate(col)) return false;
		// Sample a few rows to see if the column holds numeric data
		let seen = 0, numeric = 0;
		for (let i = 0; i < Math.min(rows.length, 50); i++) {
			const raw = (rows[i] as Record<string, unknown>)[col];
			if (raw === null || raw === undefined) continue;
			const s = String(raw).trim();
			if (s === '') continue;
			seen++;
			const cleaned = s.replace(/[$,\s]/g, '');
			if (cleaned !== '' && !isNaN(Number(cleaned)) && isFinite(Number(cleaned))) numeric++;
		}
		// Use the prop columns if we have nothing else
		if (seen === 0 && cols.length > 0) {
			// We couldn't sample — fall back to the column name heuristic
			// (treat as text by default).
			return false;
		}
		return seen >= 3 && numeric / seen >= 0.8;
	}
	function defaultKindFor(column: string): Condition['kind'] {
		if (column && columnIsDate(column)) return 'date';
		if (column && columnIsNumber(column, columns)) return 'number';
		return 'text';
	}

	// ── Split / base op ──────────────────────────────────────────────────
	function splitOp(op: string): { base: string; negate: boolean } {
		if (op.startsWith('not_')) return { base: op.slice(4), negate: true };
		return { base: op, negate: false };
	}

	// ── Condition → Filter leaf ──────────────────────────────────────────
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
			// 'outside' takes a tuple [lo, hi] as its value. The condition
			// stores it as the string "lo,hi" — split it back on publish.
			if (base === 'outside') {
				const parts = c.value.split(',').map((s) => s.trim());
				if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
				leaf = { column, op: 'outside', value: parts };
			} else {
				if (c.value.trim() === '') return null;
				leaf = { column, op: base as FilterOp, value: c.value.trim() };
			}
		} else {
			// text
			if (c.value === '') return null;
			const op: FilterOp = base === 'eq' ? 'eq' : 'contains';
			leaf = { column, op, value: c.value };
		}
		return negate ? { not: leaf } : leaf;
	}

	// ── Filter tree → Condition[] (the seed) ───────────────────────────
	function leafToCondition(leaf: FilterLeaf, negate: boolean): Condition | null {
		const column = leaf.column === '_any_' ? '' : leaf.column;
		const val = Array.isArray(leaf.value) ? leaf.value.join(', ') : String(leaf.value ?? '');
		const pfx = (base: string, neg: boolean) => (neg ? `not_${base}` : base);
		const valLooksLikeDate = /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(val) || /^\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(val);

		// Comparison ops (lt/gt/lte/gte): a DATE-looking value → date row
		const dateOpMap: Record<string, string> = { lt: 'before', gt: 'after', lte: 'on_or_before', gte: 'on_or_after' };
		if (leaf.op in dateOpMap) {
			if (valLooksLikeDate) {
				const ms = dateInputToMs(val) ?? new Date(val).getTime();
				return {
					id: nextConditionId++,
					column, kind: 'date',
					op: pfx(dateOpMap[leaf.op], negate),
					value: isNaN(ms) ? '' : msToDateInput(ms)
				};
			}
			return { id: nextConditionId++, column, kind: 'number', op: leaf.op, value: val };
		}

		// 'outside' is a numeric op with a tuple value [lo, hi]
		if (leaf.op === 'outside') {
			const arr = Array.isArray(leaf.value) ? leaf.value : [];
			const lo = String(arr[0] ?? '');
			const hi = String(arr[1] ?? '');
			return { id: nextConditionId++, column, kind: 'number', op: 'outside', value: `${lo},${hi}` };
		}

		// eq on a date-looking value → date "on" row
		if (leaf.op === 'eq' && valLooksLikeDate) {
			const ms = dateInputToMs(val) ?? new Date(val).getTime();
			return {
				id: nextConditionId++, column, kind: 'date',
				op: pfx('on', negate),
				value: isNaN(ms) ? '' : msToDateInput(ms)
			};
		}

		// eq/neq on a numeric value → number row
		if ((leaf.op === 'eq' || leaf.op === 'neq') && val !== '' && !isNaN(Number(val.replace(/[$,\s]/g, '')))) {
			const op = leaf.op === 'neq' || negate ? 'neq' : 'eq';
			return { id: nextConditionId++, column, kind: 'number', op, value: val };
		}

		// Otherwise a text row
		const base = leaf.op === 'eq' || leaf.op === 'neq' ? 'eq' : 'contains';
		const neg = negate || leaf.op === 'neq';
		return { id: nextConditionId++, column, kind: 'text', op: pfx(base, neg), value: val };
	}

	function treeToConditions(tree: Filter): Condition[] {
		if ('and' in tree) return tree.and.flatMap(treeToConditions);
		if ('not' in tree) {
			const inner = tree.not;
			if ('and' in inner || 'or' in inner) return []; // can't represent nested groups
			const c = leafToCondition(inner as FilterLeaf, true);
			return c ? [c] : [];
		}
		if ('or' in tree) return []; // OR not representable
		const c = leafToCondition(tree as FilterLeaf, false);
		return c ? [c] : [];
	}

	// LeafMatchFn: bridge to matchesValue() so date-serial⇄date equivalence works.
	const leafMatch = (cell: unknown, query: string, op: 'eq' | 'contains' | 'startsWith' | 'endsWith') => {
		if (op === 'eq' || op === 'contains') return matchesValue(cell, query, op);
		return false;
	};

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
		const matchCount = countMatches(tree, rows, leafMatch);
		workspace.setActiveFilter({
			pattern: describeFilter(tree),
			matchCount,
			filterTree: tree
		});
	}

	// ── Row mutation handlers ──────────────────────────────────────────
	function addCondition() {
		const used = new Set(conditions.map((c) => c.column));
		const col = columns.find((c) => !used.has(c)) ?? '';
		const kind = defaultKindFor(col);
		conditions.push({
			id: nextConditionId++,
			column: col,
			kind,
			op: kind === 'date' ? 'on' : kind === 'number' ? 'eq' : 'contains',
			value: ''
		});
		// New row has no value yet — don't publish.
	}
	function removeCondition(id: number) {
		conditions = conditions.filter((c) => c.id !== id);
		publishConditions();
	}
	function setConditionColumn(id: number, column: string) {
		const c = conditions.find((x) => x.id === id);
		if (!c) return;
		c.column = column;
		const want = defaultKindFor(column);
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

	// ── Seed from activeFilter (re-seeded when filter changes externally) ───
	function seedFromActiveFilter() {
		const f = workspace.activeFilter;
		if (!f) { conditions = []; return; }
		if (f.filterTree) {
			conditions = treeToConditions(f.filterTree);
			return;
		}
		// Legacy single-condition form: some callers (notably the chat query
		// engine's simple-pattern path) set only {column, pattern, valueOp}
		// without a filterTree. Synthesize a leaf and run it through the same
		// leafToCondition() the tree path uses, so the chip renders instead of an
		// empty bar. valueOp (when present) preserves equals / not-equals /
		// not-contains; the default is 'contains' (the chat default). When no
		// column was resolved (multi-column OR search) there's nothing editable
		// to show — fall through to [] and let the read-only banner handle it.
		if (f.column && f.pattern) {
			const c =
				f.valueOp === 'eq'
					? leafToCondition({ column: f.column, op: 'eq', value: f.pattern } as FilterLeaf, false)
					: f.valueOp === 'neq'
						? leafToCondition({ column: f.column, op: 'neq', value: f.pattern } as FilterLeaf, false)
						: f.valueOp === 'not_contains'
							? leafToCondition({ column: f.column, op: 'contains', value: f.pattern } as FilterLeaf, true)
							: leafToCondition({ column: f.column, op: 'contains', value: f.pattern } as FilterLeaf, false);
			conditions = c ? [c] : [];
			return;
		}
		conditions = [];
	}


	$effect(() => {
		void workspace.activeFilter;
		if (selfUpdate) { selfUpdate = false; return; }
		seedFromActiveFilter();
	});

	/** True when there's a filter we couldn't represent as editable rows
	 * (e.g. OR / nested). Read-only banner. */
	const isReadOnlyFilter = $derived(
		!!workspace.activeFilter && workspace.activeFilter.filterTree !== undefined
		&& conditions.length === 0
		&& !workspace.activeFilter.dateFilter
	);

	// Compute live matchCount for the banner.
	const liveMatchCount = $derived(
		matchCountProp ?? (workspace.activeFilter?.matchCount ?? 0)
	);
</script>

{#if workspace.activeFilter || conditions.length > 0}
	<div class="px-4 py-2 bg-amber-50 dark:bg-amber-950/60 border-b border-amber-300 dark:border-amber-800/60 flex-shrink-0 space-y-1.5">
		<!-- Header line: row count + clear -->
		<div class="flex items-center gap-2">
			<span class="text-amber-600 dark:text-amber-400 text-xs" aria-hidden="true">🔍</span>
			<span class="text-xs text-amber-700 dark:text-amber-300">
				Showing <strong class="text-amber-800 dark:text-amber-200 tabular-nums">{liveMatchCount.toLocaleString()}</strong> rows
			</span>
			<button
				onclick={() => { conditions = []; workspace.clearActiveFilter(); }}
				class="ml-auto text-xs text-amber-700 hover:text-amber-900 dark:text-amber-500 dark:hover:text-amber-300 transition-colors px-2 py-0.5 rounded border border-amber-400 dark:border-amber-800 hover:border-amber-600"
			>Clear filter</button>
		</div>

		{#if isReadOnlyFilter}
			<!-- Filter we can't represent as editable rows (e.g. OR / nested). -->
			<p class="text-xs text-amber-700 dark:text-amber-300/90 italic">
				matching <strong class="text-amber-800 dark:text-amber-200">{workspace.activeFilter?.filterTree
					? describeFilter(workspace.activeFilter.filterTree)
					: workspace.activeFilter?.pattern}</strong>
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
					<!-- Column -->
					<select
						class="bg-white border border-amber-400 text-amber-900 dark:bg-amber-900/40 dark:border-amber-700/60 dark:text-amber-100 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:border-amber-500"
						value={cond.column}
						onchange={(e) => setConditionColumn(cond.id, (e.currentTarget as HTMLSelectElement).value)}
						aria-label="Filter column"
					>
						<option value="">All columns</option>
						{#each columns as c}
							<option value={c}>{c}</option>
						{/each}
					</select>

					<!-- Operator (op set depends on column kind) -->
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

					<!-- Value input — date / number / text -->
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
							type="text"
							inputmode="decimal"
							class="bg-white border border-amber-400 text-amber-900 placeholder-amber-400 dark:bg-amber-900/40 dark:border-amber-700/60 dark:text-amber-100 dark:placeholder-amber-500/60 rounded px-2 py-0.5 text-xs focus:outline-none focus:border-amber-500 w-28 dark:[color-scheme:dark]"
							value={cond.value}
							oninput={(e) => setConditionValue(cond.id, (e.currentTarget as HTMLInputElement).value, true)}
							placeholder={cond.op === 'outside' ? 'lo,hi' : 'number…'}
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
