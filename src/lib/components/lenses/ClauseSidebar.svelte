<script lang="ts">
	/**
	 * ClauseSidebar.svelte — live sidebar for the highlight-to-mark contract flow.
	 *
	 * Subscribes to clauseStore and renders one card per marked clause, in
	 * document order. Each card shows a number + color swatch (matching the
	 * highlight), the classifier heading (or a spinner while it resolves), a risk
	 * badge, and a short excerpt. Clicking a card scrolls the document to that
	 * clause (via workspace.requestScrollToClause).
	 *
	 * Honest counter (NOT a progress bar): we have no idea how many clauses a
	 * contract "should" have, so a bar that fills to some fraction of an unknown
	 * total would be dishonest. We show a plain "N clauses marked" count — which
	 * is truthful and still satisfying as it ticks up. Once 3+ clauses are marked
	 * the "Run Full Analysis" button appears (enriches the profile with
	 * parties / dates / missing-clause warnings via the parent callback).
	 */
	import { clauseStore } from '$lib/stores/clauseStore.svelte.js';
	import type { ClauseConfidence } from '$lib/stores/clauseStore.svelte.js';
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import type { ClauseRisk } from '$lib/models/legal-classifier.js';
	import type { ContractProfile, ContractParty, ContractDate } from '$lib/lenses/contract/types.js';



	interface Props {
		/** Called when the user clicks "Run / Re-run Full Analysis" (parent builds profile). */
		onRunAnalysis?: () => void;
		/** True while the full-profile build is running (drives the button state). */
		analyzing?: boolean;
		/**
		 * The enriched profile (parties / dates / missing clauses), once built.
		 * Rendered as a summary header ABOVE the live clause list — the live list
		 * always stays visible so clauses marked AFTER analysis still appear.
		 */
		profile?: ContractProfile | null;
	}

	let { onRunAnalysis, analyzing = false, profile = null }: Props = $props();

	const clauses = $derived(clauseStore.clauses);
	const count = $derived(clauseStore.count);
	const canAnalyze = $derived(clauseStore.canAnalyze);

	/**
	 * True when clauses have been marked SINCE the profile was built — the
	 * "Run Full Analysis" button becomes "Re-run" so the user can fold the new
	 * clauses into the parties/dates/missing summary.
	 */
	const hasProfile = $derived(profile !== null);


	const RISK_DOT: Record<ClauseRisk, string> = {
		high: '🔴',
		medium: '🟡',
		low: '🟢'
	};
	const RISK_BADGE: Record<ClauseRisk, string> = {
		high: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-950/60 dark:text-red-300 dark:border-red-800',
		medium: 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800',
		low: 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800'
	};

	/**
	 * Confidence badge styling. Auto-detected clauses carry a green/yellow/red
	 * boundary-confidence badge; once the user merges/splits/adjusts/adds a clause
	 * it flips to a blue "edited" badge (its original guess is no longer relevant).
	 */
	const CONFIDENCE_BADGE: Record<ClauseConfidence, { label: string; cls: string }> = {
		high: { label: 'High', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800' },
		medium: { label: 'Medium', cls: 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800' },
		low: { label: 'Low', cls: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-950/60 dark:text-red-300 dark:border-red-800' },
		edited: { label: 'Edited', cls: 'bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800' }
	};

	/** First ~80 chars of the clause text, single-line, for the card excerpt. */
	function excerpt(text: string): string {
		const clean = text.replace(/\s+/g, ' ').trim();
		return clean.length > 80 ? clean.slice(0, 80) + '…' : clean;
	}

	function clickCard(id: string) {
		workspace.requestScrollToClause(id);
	}

	// ============================================================
	// Editable parties — remove / add / rename / toggle kind
	//
	// The auto-extracted party list is a best-effort guess (it sometimes picks up
	// place names like "Iowa" as a party). Let the user correct it directly:
	// remove a wrong entry, rename one, flip person ⇄ org, or add a missing party.
	// Edits replace the profile via setContractProfile() and are persisted
	// best-effort. Every edit marks the party source 'manual'.
	// ============================================================

	/** Which party (by index) is currently being inline-edited, or null. */

	let editingPartyIdx = $state<number | null>(null);
	let editingName = $state('');
	/** True when the "add party" input row is open. */
	let addingParty = $state(false);
	let newPartyName = $state('');

	/** Replace the profile's party list and persist (best-effort). */
	function commitParties(parties: ContractParty[]) {
		if (!profile) return;
		const next = { ...profile, parties };
		workspace.setContractProfile(next);
		workspace.persistProfile(next);
	}

	function removeParty(idx: number) {
		if (!profile) return;
		commitParties(profile.parties.filter((_, i) => i !== idx));
		if (editingPartyIdx === idx) editingPartyIdx = null;
	}

	function startEditParty(idx: number) {
		if (!profile) return;
		editingPartyIdx = idx;
		editingName = profile.parties[idx]?.name ?? '';
		addingParty = false;
	}

	function saveEditParty() {
		if (!profile || editingPartyIdx === null) return;
		const name = editingName.trim();
		if (name === '') { removeParty(editingPartyIdx); return; }
		const parties = profile.parties.map((p, i) =>
			i === editingPartyIdx ? { ...p, name, source: 'manual' as const } : p
		);
		commitParties(parties);
		editingPartyIdx = null;
	}

	function togglePartyKind(idx: number) {
		if (!profile) return;
		const parties = profile.parties.map((p, i) =>
			i === idx
				? { ...p, kind: (p.kind === 'org' ? 'person' : 'org') as 'org' | 'person', source: 'manual' as const }
				: p
		);
		commitParties(parties);
	}

	function startAddParty() {
		addingParty = true;
		newPartyName = '';
		editingPartyIdx = null;
	}

	function saveAddParty() {
		if (!profile) return;
		const name = newPartyName.trim();
		if (name === '') { addingParty = false; return; }
		const party: ContractParty = { name, kind: 'org', source: 'manual' };
		commitParties([...profile.parties, party]);
		addingParty = false;
		newPartyName = '';
	}

	// ============================================================
	// Editable key dates — remove / add / edit (label + value)
	//
	// Same model as parties: auto-extracted dates are a best-effort guess, so the
	// user can correct the label ("Effective"), correct the value ("Jan 15, 2025"),
	// remove a wrong date, or add one the extractor missed. Edits replace the
	// profile via setContractProfile() and are persisted best-effort.
	// ============================================================

	/** Which date (by index) is being inline-edited, or null. */
	let editingDateIdx = $state<number | null>(null);
	let editingDateLabel = $state('');
	let editingDateValue = $state('');
	/** True when the "add date" input row is open. */
	let addingDate = $state(false);
	let newDateLabel = $state('');
	let newDateValue = $state('');

	/** Replace the profile's date list and persist (best-effort). */
	function commitDates(dates: ContractDate[]) {
		if (!profile) return;
		const next = { ...profile, dates };
		workspace.setContractProfile(next);
		workspace.persistProfile(next);
	}

	function removeDate(idx: number) {
		if (!profile) return;
		commitDates(profile.dates.filter((_, i) => i !== idx));
		if (editingDateIdx === idx) editingDateIdx = null;
	}

	function startEditDate(idx: number) {
		if (!profile) return;
		editingDateIdx = idx;
		editingDateLabel = profile.dates[idx]?.label ?? '';
		editingDateValue = profile.dates[idx]?.value ?? '';
		addingDate = false;
	}

	function saveEditDate() {
		if (!profile || editingDateIdx === null) return;
		const label = editingDateLabel.trim();
		const value = editingDateValue.trim();
		// A date with neither a label nor a value is meaningless — drop it.
		if (label === '' && value === '') { removeDate(editingDateIdx); return; }
		const dates = profile.dates.map((d, i) =>
			i === editingDateIdx ? { ...d, label: label || d.label, value } : d
		);
		commitDates(dates);
		editingDateIdx = null;
	}

	function startAddDate() {
		addingDate = true;
		newDateLabel = '';
		newDateValue = '';
		editingDateIdx = null;
	}

	function saveAddDate() {
		if (!profile) return;
		const label = newDateLabel.trim();
		const value = newDateValue.trim();
		if (label === '' && value === '') { addingDate = false; return; }
		const date: ContractDate = { label: label || 'Date', value };
		commitDates([...profile.dates, date]);
		addingDate = false;
		newDateLabel = '';
		newDateValue = '';
	}
</script>



<aside
	class="flex flex-col h-full overflow-hidden bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100"
	aria-label="Marked clauses"
>
	<!-- Header: honest counter (no progress bar). -->
	<div class="px-3 py-3 border-b border-gray-200 dark:border-slate-800 flex-shrink-0">
		<div class="flex items-baseline gap-2">
			<span
				class="text-2xl font-bold tabular-nums {count >= 3 ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-900 dark:text-gray-100'}"
				>{count}</span
			>
			<span class="text-sm text-gray-500 dark:text-gray-400">{count === 1 ? 'clause' : 'clauses'} marked</span>
		</div>
		{#if clauseStore.analyzingCount > 0}
			<p class="mt-0.5 text-[11px] text-blue-600 dark:text-blue-400">
				Analyzing {clauseStore.analyzingCount}…
			</p>
		{:else if count > 0 && count < 3}
			<p class="mt-0.5 text-[11px] text-gray-400 dark:text-gray-500">Mark {3 - count} more to run full analysis.</p>
		{/if}
	</div>

	<!-- Enriched profile summary (parties / dates / missing clauses) — shown
	     ABOVE the live clause list once "Run Full Analysis" has built a profile.
	     The live list below stays visible so clauses marked AFTER analysis still
	     appear (and can be folded in via "Re-run analysis"). -->
	<!-- Scrollable body: profile summary (parties/dates/missing clauses) + the
	     live clause card list share ONE scroll region. Previously the profile
	     summary was flex-shrink-0 (never scrollable) and the clause list below
	     it was flex-1 overflow-y-auto WITHOUT min-h-0 — a flex child's default
	     min-height is `auto`, so it refused to shrink below its content height
	     and just overflowed the aside's overflow-hidden instead of scrolling.
	     Wrapping both in one flex-1 min-h-0 overflow-y-auto container fixes both:
	     the whole thing (summary + cards) now scrolls together as expected. -->
	<div class="flex-1 min-h-0 overflow-y-auto">
	{#if profile}
		<div class="flex-shrink-0 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60 px-3 py-2.5 space-y-2 text-xs">

			<div>
				<p class="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Parties</p>
				<div class="flex flex-wrap gap-1 items-center">
					{#each profile.parties as p, idx}
						{#if editingPartyIdx === idx}
							<!-- Inline edit: rename, Enter saves, Esc cancels, blur saves. -->
							<span class="inline-flex items-center gap-1 px-1 py-0.5 rounded bg-blue-50 dark:bg-slate-700 border border-blue-400 dark:border-blue-700">
								<button
									type="button"
									class="text-xs leading-none hover:opacity-70"
									title="Toggle organization / person"
									onclick={() => togglePartyKind(idx)}
								>{p.kind === 'org' ? '🏢' : '👤'}</button>
								<!-- svelte-ignore a11y_autofocus -->
								<input
									type="text"
									class="bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100 text-xs rounded px-1 py-0.5 w-28 focus:outline-none focus:ring-1 focus:ring-blue-500"
									bind:value={editingName}
									autofocus
									onkeydown={(e) => {
										if (e.key === 'Enter') { e.preventDefault(); saveEditParty(); }
										else if (e.key === 'Escape') { e.preventDefault(); editingPartyIdx = null; }
									}}
									onblur={saveEditParty}
									aria-label="Edit party name"
								/>
							</span>
						{:else}
							<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-200 dark:bg-slate-800 text-gray-800 dark:text-gray-200 group">
								<button
									type="button"
									class="text-xs leading-none hover:opacity-70"
									title="Toggle organization / person"
									onclick={() => togglePartyKind(idx)}
								>{p.kind === 'org' ? '🏢' : '👤'}</button>
								<button
									type="button"
									class="hover:underline"
									title="Click to rename"
									onclick={() => startEditParty(idx)}
								>{p.name}</button>{#if p.role}<span class="text-gray-500"> · {p.role}</span>{/if}
								<button
									type="button"
									class="ml-0.5 text-gray-500 hover:text-rose-600 dark:hover:text-rose-300 leading-none"
									title="Remove party"
									aria-label="Remove {p.name}"
									onclick={() => removeParty(idx)}
								>✕</button>
							</span>
						{/if}
					{/each}

					<!-- Add a party -->
					{#if addingParty}
						<!-- svelte-ignore a11y_autofocus -->
						<input
							type="text"
							class="bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100 text-xs rounded px-1.5 py-0.5 w-28 border border-blue-400 dark:border-blue-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
							bind:value={newPartyName}
							placeholder="Party name…"
							autofocus
							onkeydown={(e) => {
								if (e.key === 'Enter') { e.preventDefault(); saveAddParty(); }
								else if (e.key === 'Escape') { e.preventDefault(); addingParty = false; }
							}}
							onblur={saveAddParty}
							aria-label="New party name"
						/>
					{:else}
						<button
							type="button"
							class="px-1.5 py-0.5 rounded border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:border-gray-500 dark:hover:border-gray-400 transition-colors"
							onclick={startAddParty}
						>+ Add party</button>
					{/if}
				</div>
			</div>

			<div>
				<p class="text-[10px] uppercase tracking-wide text-gray-500 mb-0.5">Key dates</p>
				<ul class="space-y-0.5">
					{#each profile.dates as d, idx}
						<li class="text-gray-700 dark:text-gray-300">
							{#if editingDateIdx === idx}
								<!-- Inline edit: label + value. Enter saves, Esc cancels, blur saves. -->
								<span class="inline-flex items-center gap-1">
									<!-- svelte-ignore a11y_autofocus -->
									<input
										type="text"
										class="bg-white dark:bg-slate-900 text-gray-700 dark:text-gray-300 text-xs rounded px-1 py-0.5 w-24 focus:outline-none focus:ring-1 focus:ring-blue-500"
										bind:value={editingDateLabel}
										placeholder="Label"
										autofocus
										onkeydown={(e) => {
											if (e.key === 'Enter') { e.preventDefault(); saveEditDate(); }
											else if (e.key === 'Escape') { e.preventDefault(); editingDateIdx = null; }
										}}
										aria-label="Edit date label"
									/>
									<span class="text-gray-400 dark:text-gray-600">:</span>
									<input
										type="text"
										class="bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100 text-xs rounded px-1 py-0.5 w-28 focus:outline-none focus:ring-1 focus:ring-blue-500"
										bind:value={editingDateValue}
										placeholder="Value"
										onkeydown={(e) => {
											if (e.key === 'Enter') { e.preventDefault(); saveEditDate(); }
											else if (e.key === 'Escape') { e.preventDefault(); editingDateIdx = null; }
										}}
										onblur={saveEditDate}
										aria-label="Edit date value"
									/>
								</span>
							{:else}
								<span class="inline-flex items-center gap-1 group">
									<button
										type="button"
										class="text-left hover:underline"
										title="Click to edit"
										onclick={() => startEditDate(idx)}
									><span class="text-gray-500">{d.label}:</span> {d.value}</button>
									<button
										type="button"
										class="text-gray-400 dark:text-gray-600 hover:text-rose-600 dark:hover:text-rose-300 leading-none"
										title="Remove date"
										aria-label="Remove {d.label}"
										onclick={() => removeDate(idx)}
									>✕</button>
								</span>
							{/if}
						</li>
					{/each}
					<li>
						{#if addingDate}
							<!-- svelte-ignore a11y_autofocus -->
							<span class="inline-flex items-center gap-1">
								<input
									type="text"
									class="bg-white dark:bg-slate-900 text-gray-700 dark:text-gray-300 text-xs rounded px-1 py-0.5 w-24 border border-blue-400 dark:border-blue-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
									bind:value={newDateLabel}
									placeholder="Label"
									autofocus
									onkeydown={(e) => {
										if (e.key === 'Enter') { e.preventDefault(); saveAddDate(); }
										else if (e.key === 'Escape') { e.preventDefault(); addingDate = false; }
									}}
									aria-label="New date label"
								/>
								<span class="text-gray-400 dark:text-gray-600">:</span>
								<input
									type="text"
									class="bg-white dark:bg-slate-900 text-gray-900 dark:text-gray-100 text-xs rounded px-1 py-0.5 w-28 border border-blue-400 dark:border-blue-700 focus:outline-none focus:ring-1 focus:ring-blue-500"
									bind:value={newDateValue}
									placeholder="e.g. Jan 15, 2025"
									onkeydown={(e) => {
										if (e.key === 'Enter') { e.preventDefault(); saveAddDate(); }
										else if (e.key === 'Escape') { e.preventDefault(); addingDate = false; }
									}}
									onblur={saveAddDate}
									aria-label="New date value"
								/>
							</span>
						{:else}
							<button
								type="button"
								class="mt-0.5 px-1.5 py-0.5 rounded border border-dashed border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:border-gray-500 dark:hover:border-gray-400 transition-colors"
								onclick={startAddDate}
							>+ Add date</button>
						{/if}
					</li>
				</ul>
			</div>

			{#if profile.missingStandardClauses.length > 0}
				<div>
					<p class="text-[10px] uppercase tracking-wide text-amber-600/90 dark:text-amber-500/80 mb-0.5">
						Missing standard clauses
					</p>
					<div class="flex flex-wrap gap-1">
						{#each profile.missingStandardClauses as m}
							<span class="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/50 border border-amber-300 dark:border-amber-800/60 text-amber-800 dark:text-amber-300">
								⚠️ {m}
							</span>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Clause cards (part of the shared scroll region opened above — no
	     nested scroll container here). -->
	<div>
		{#if count === 0}
			<!-- Empty state -->
			<div class="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">

				<span class="text-3xl" aria-hidden="true">👈</span>
				<p class="text-sm text-gray-500 dark:text-gray-400">Highlight your first clause to begin.</p>
				<p class="text-[11px] text-gray-400 dark:text-gray-600">
					Select any text in the document, then choose <strong class="text-gray-500 dark:text-gray-400"
						>Mark as Clause</strong
					>.
				</p>
			</div>
		{:else}
			<ul class="py-1">
				{#each clauses as clause, i (clause.id)}
					<li>
						<button
							type="button"
							onclick={() => clickCard(clause.id)}
							class="w-full text-left px-3 py-2 border-b border-gray-200/70 dark:border-slate-800/70 hover:bg-gray-100 dark:hover:bg-slate-800/60 transition-colors"
						>
							<div class="flex items-center gap-2">
								<!-- Number + color swatch (matches the highlight tint) -->
								<span
									class="flex items-center justify-center w-5 h-5 rounded text-[11px] font-bold text-gray-900 shrink-0 tabular-nums"
									style="background-color: {clause.color};">{i + 1}</span
								>

								<!-- Heading or provisional spinner -->
								{#if clause.status === 'pending' || clause.status === 'analyzing'}
									<span class="flex items-center gap-1.5 text-sm text-gray-500 dark:text-gray-400 flex-1 min-w-0">
										<span
											class="inline-block w-3 h-3 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-blue-500 dark:border-t-blue-400 animate-spin shrink-0"
											aria-hidden="true"
										></span>
										<span class="italic truncate">Analyzing…</span>
									</span>
								{:else}
									<span class="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1 min-w-0 truncate">
										{clause.heading ?? 'Untitled Clause'}
									</span>
								{/if}

								<!-- Risk badge (only once resolved) -->
								{#if clause.risk}
									<span
										class="shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase tracking-wide {RISK_BADGE[
											clause.risk
										]}"
										title="{clause.risk} risk"
									>
										{RISK_DOT[clause.risk]} {clause.risk}
									</span>
								{/if}
							</div>

							<!-- Excerpt + confidence/edited badge.
							     NOTE: this badge describes DETECTION CONFIDENCE (how sure we are
							     about the clause boundaries), NOT risk. It is deliberately worded
							     "… match" / "Edited" so it can't be misread as a second risk level
							     next to the HIGH/MEDIUM/LOW risk badge above. -->
							<div class="mt-1 pl-7 flex items-start gap-2">
								<p class="flex-1 min-w-0 text-xs text-gray-500 dark:text-gray-500 leading-snug">{excerpt(clause.text)}</p>
								<span
									class="shrink-0 px-1.5 py-0.5 rounded border text-[10px] font-medium normal-case {CONFIDENCE_BADGE[
										clause.confidence
									].cls}"
									title="{clause.confidence === 'edited'
										? 'You edited this clause — boundaries are user-confirmed'
										: `Auto-detection boundary confidence: ${CONFIDENCE_BADGE[clause.confidence].label}. This is how sure we are about where the clause starts and ends — it is NOT the clause's risk level.`}"
								>
									{#if clause.confidence === 'edited'}
										✎ Edited
									{:else}
										◎ {CONFIDENCE_BADGE[clause.confidence].label} match
									{/if}
								</span>
							</div>


						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
	</div>

	<!-- Run Full Analysis — appears at 3+ marked clauses. -->

	{#if canAnalyze}
		<div class="p-3 border-t border-gray-200 dark:border-slate-800 flex-shrink-0">
			<button
				type="button"
				onclick={() => onRunAnalysis?.()}
				disabled={analyzing}
				class="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
			>
				{#if analyzing}
					<span
						class="inline-block w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin"
						aria-hidden="true"
					></span>
					Analyzing…
				{:else}
					<span aria-hidden="true">⚡</span> {hasProfile ? 'Re-run Full Analysis' : 'Run Full Analysis'}
				{/if}
			</button>
			<p class="mt-1.5 text-[10px] text-gray-400 dark:text-gray-600 text-center">
				{hasProfile
					? 'Fold newly marked clauses into the summary.'
					: 'Extracts parties, dates & missing standard clauses.'}
			</p>
		</div>
	{/if}
</aside>
