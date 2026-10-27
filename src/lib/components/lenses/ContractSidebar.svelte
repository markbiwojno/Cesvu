<script lang="ts">
	/**
	 * ContractSidebar.svelte — contract-lens sidebar.
	 *
	 * Appears to the LEFT of the document viewer when a contract is detected.
	 * Shows: a color-coded risk summary, the clause list (each clickable to
	 * scroll the viewer to that clause, with a risk dot), parties, and key dates.
	 * Warns about missing standard clauses (e.g. no confidentiality clause).
	 *
	 * Layout:
	 *   - Desktop (lg+): fixed 280px column, left of the viewer.
	 *   - Narrow (<lg): collapses to a bottom sheet (fixed to the bottom edge,
	 *     toggle to expand/collapse).
	 *
	 * The component is presentational: clause clicks are forwarded via the
	 * `onClauseClick` callback so the PARENT owns scrolling the viewer (this
	 * component never touches the document DOM directly).
	 */
	import type { ContractProfile, ClauseRisk } from '$lib/lenses/contract/types.js';

	import { isObligationLabel } from '$lib/lenses/contract/obligations.js';

	interface Props {
		profile: ContractProfile;
		/** Called with the clause id when a clause is clicked (parent scrolls viewer). */
		onClauseClick?: (clauseId: string) => void;
	}

	let { profile, onClauseClick }: Props = $props();

	// Collapsible section state.
	let showClauses = $state(true);
	let showParties = $state(true);
	let showDates = $state(true);
	// Bottom-sheet expanded state (narrow screens only).
	let sheetOpen = $state(false);

	// ── Clause filter tabs ──────────────────────────────────────────────────
	// In-place clause-list filtering (no chat, no LLM). The Obligations tab uses
	// the shared OBLIGATION_LABELS set; High Risk filters on risk === 'high'.
	type ClauseFilter = 'all' | 'obligations' | 'high';
	let clauseFilter = $state<ClauseFilter>('all');

	const obligationClauses = $derived(
		profile.clauses.filter((c) => isObligationLabel(c.rawLabel))
	);
	const highRiskClauses = $derived(profile.clauses.filter((c) => c.risk === 'high'));

	const filteredClauses = $derived(
		clauseFilter === 'obligations'
			? obligationClauses
			: clauseFilter === 'high'
				? highRiskClauses
				: profile.clauses
	);

	const tabs = $derived<Array<{ id: ClauseFilter; label: string; count: number }>>([
		{ id: 'all', label: 'All', count: profile.clauses.length },
		{ id: 'obligations', label: 'Obligations', count: obligationClauses.length },
		{ id: 'high', label: 'High Risk', count: highRiskClauses.length }
	]);


	const RISK_DOT: Record<ClauseRisk, string> = {
		high: '🔴',
		medium: '🟡',
		low: '🟢'
	};
	const RISK_TEXT: Record<ClauseRisk, string> = {
		high: 'text-red-600 dark:text-red-400',
		medium: 'text-amber-600 dark:text-amber-400',
		low: 'text-emerald-600 dark:text-emerald-400'
	};

	const totalClauses = $derived(profile.clauses.length);

	function clickClause(id: string) {
		onClauseClick?.(id);
		sheetOpen = false; // collapse the sheet after navigating on mobile
	}
</script>

{#snippet body()}
	<!-- Risk summary -->
	<section class="px-3 py-3 border-b border-gray-200 dark:border-slate-800">
		<h2 class="flex items-center gap-1.5 text-xs font-semibold text-gray-800 dark:text-gray-200 uppercase tracking-wide">
			<span aria-hidden="true">⚠️</span> Risk Summary
		</h2>
		<ul class="mt-2 space-y-1 text-sm">
			<li class="flex items-center gap-2 {RISK_TEXT.high}">
				<span aria-hidden="true">🔴</span>
				<span class="font-medium tabular-nums">{profile.riskSummary.high}</span> high
			</li>
			<li class="flex items-center gap-2 {RISK_TEXT.medium}">
				<span aria-hidden="true">🟡</span>
				<span class="font-medium tabular-nums">{profile.riskSummary.medium}</span> medium
			</li>
			<li class="flex items-center gap-2 {RISK_TEXT.low}">
				<span aria-hidden="true">🟢</span>
				<span class="font-medium tabular-nums">{profile.riskSummary.low}</span> low
			</li>
		</ul>
	</section>

	<!-- Missing standard clauses -->
	{#if profile.missingStandardClauses.length > 0}
		<section class="px-3 py-2 border-b border-gray-200 dark:border-slate-800 bg-amber-50 dark:bg-amber-950/30">
			<ul class="space-y-1 text-xs text-amber-700 dark:text-amber-300">
				{#each profile.missingStandardClauses as missing (missing)}
					<li class="flex items-start gap-1.5">
						<span aria-hidden="true">⚠️</span>
						<span>No {missing.toLowerCase()} clause</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<!-- Clauses -->
	<section class="border-b border-gray-200 dark:border-slate-800">
		<button
			type="button"
			class="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 uppercase tracking-wide hover:bg-gray-100 dark:hover:bg-slate-800/50"
			onclick={() => (showClauses = !showClauses)}
			aria-expanded={showClauses}
		>
			<span>Clauses <span class="text-gray-500 normal-case">({totalClauses})</span></span>
			<span aria-hidden="true" class="text-gray-500">{showClauses ? '▾' : '▸'}</span>
		</button>
		{#if showClauses}
			{#if totalClauses === 0}
				<p class="px-3 pb-3 text-xs text-gray-500 italic">No clauses detected.</p>
			{:else}
				<!-- Filter tabs: All / Obligations / High Risk (in-place, no LLM). -->
				<div class="flex gap-1 px-3 pb-2" role="tablist" aria-label="Filter clauses">
					{#each tabs as tab (tab.id)}
						<button
							type="button"
							role="tab"
							aria-selected={clauseFilter === tab.id}
							onclick={() => (clauseFilter = tab.id)}
							class="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors
								{clauseFilter === tab.id
									? 'bg-blue-600 text-white'
									: 'bg-gray-200 text-gray-600 hover:bg-gray-300 hover:text-gray-900 dark:bg-slate-800 dark:text-gray-400 dark:hover:bg-slate-700 dark:hover:text-gray-200'}"
						>
							{tab.label}
							<span class="tabular-nums opacity-80">[{tab.count}]</span>
						</button>
					{/each}
				</div>

				{#if filteredClauses.length === 0}
					<p class="px-3 pb-3 text-xs text-gray-500 italic">
						{clauseFilter === 'obligations'
							? 'No obligation clauses detected.'
							: clauseFilter === 'high'
								? 'No high-risk clauses detected.'
								: 'No clauses detected.'}
					</p>
				{:else}
					<ul class="pb-2">
						{#each filteredClauses as clause (clause.id)}
							<li>
								<button
									type="button"
									class="group w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-slate-800 dark:hover:text-white"
									onclick={() => clickClause(clause.id)}
									title={clause.description}
								>
									<span aria-hidden="true" class="shrink-0">📋</span>
									<span class="flex-1 truncate">{clause.label}</span>
									<span
										aria-hidden="true"
										class="shrink-0 text-[10px]"
										title="{clause.risk} risk">{RISK_DOT[clause.risk]}</span
									>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			{/if}
		{/if}

	</section>

	<!-- Parties -->
	<section class="border-b border-gray-200 dark:border-slate-800">
		<button
			type="button"
			class="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 uppercase tracking-wide hover:bg-gray-100 dark:hover:bg-slate-800/50"
			onclick={() => (showParties = !showParties)}
			aria-expanded={showParties}
		>
			<span>Parties</span>
			<span aria-hidden="true" class="text-gray-500">{showParties ? '▾' : '▸'}</span>
		</button>
		{#if showParties}
			{#if profile.parties.length === 0}
				<p class="px-3 pb-3 text-xs text-gray-500 italic">No parties identified.</p>
			{:else}
				<ul class="pb-2 space-y-1">
					{#each profile.parties as party (party.name)}
						<li class="flex items-center gap-2 px-3 py-0.5 text-sm text-gray-700 dark:text-gray-300">
							<span aria-hidden="true">{party.kind === 'org' ? '🏢' : '👤'}</span>
							<span class="flex-1 truncate" title={party.role ?? party.name}>{party.name}</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	<!-- Dates -->
	<section>
		<button
			type="button"
			class="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-800 dark:text-gray-200 uppercase tracking-wide hover:bg-gray-100 dark:hover:bg-slate-800/50"
			onclick={() => (showDates = !showDates)}
			aria-expanded={showDates}
		>
			<span>Dates</span>
			<span aria-hidden="true" class="text-gray-500">{showDates ? '▾' : '▸'}</span>
		</button>
		{#if showDates}
			{#if profile.dates.length === 0}
				<p class="px-3 pb-3 text-xs text-gray-500 italic">No dates found.</p>
			{:else}
				<ul class="pb-3 space-y-1.5">
					{#each profile.dates as d (d.label)}
						<li class="px-3 text-sm">
							<span class="flex items-center gap-1.5 text-gray-500 dark:text-gray-400 text-xs">
								<span aria-hidden="true">📅</span>{d.label}
							</span>
							<span class="block pl-5 text-gray-800 dark:text-gray-200">{d.value}</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>
{/snippet}

<!-- Desktop: fixed 280px left column -->
<aside
	class="hidden lg:flex lg:flex-col w-[280px] shrink-0 h-full overflow-y-auto bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-800 text-gray-900 dark:text-gray-100"
	aria-label="Contract overview"
>
	{@render body()}
</aside>

<!-- Narrow screens: bottom sheet -->
<div class="lg:hidden">
	<aside
		class="fixed inset-x-0 bottom-0 z-40 bg-white dark:bg-slate-900 border-t border-gray-200 dark:border-slate-800 text-gray-900 dark:text-gray-100 shadow-2xl transition-transform duration-200 max-h-[70dvh] flex flex-col"
		class:translate-y-0={sheetOpen}
		aria-label="Contract overview"
	>
		<button
			type="button"
			class="w-full flex items-center justify-between px-3 py-2.5 border-b border-gray-200 dark:border-slate-800"
			onclick={() => (sheetOpen = !sheetOpen)}
			aria-expanded={sheetOpen}
		>
			<span class="flex items-center gap-2 text-sm font-semibold">
				<span aria-hidden="true">⚠️</span>
				Contract overview
				<span class="text-xs font-normal {RISK_TEXT.high}">{profile.riskSummary.high} high</span>
			</span>
			<span aria-hidden="true" class="text-gray-500">{sheetOpen ? '▾' : '▸'}</span>
		</button>
		{#if sheetOpen}
			<div class="overflow-y-auto">
				{@render body()}
			</div>
		{/if}
	</aside>
</div>
