<!--
	VegaChart.svelte — renders a Vega-Lite spec via vega-embed.

	- vegaEmbed with { actions: false, renderer: 'svg' }
	- Dark theme (the spec itself carries the dark config; this wrapper just
	  provides layout + states)
	- Re-renders when `spec` changes via $effect
	- Skeleton pulse while embedding
	- Fallback message on error — never throws/crashes the chat

	The component is intentionally dumb: all chart shaping lives in
	chart-specs.ts. Here we only embed, swap on change, and clean up.
-->
<script lang="ts">
	import type { TopLevelSpec } from 'vega-lite';

	interface Props {
		/** The Vega-Lite spec to render. null/undefined renders nothing. */
		spec: TopLevelSpec | null | undefined;
		/** Optional accessible label for the chart container. */
		label?: string;
	}

	let { spec, label = 'Chart' }: Props = $props();

	let container = $state<HTMLDivElement | null>(null);
	let loading = $state(false);
	let errored = $state(false);

	// The result handle from vegaEmbed — used to finalize() (free listeners /
	// the embedded Vega view) before re-embedding or on destroy.
	let view: { finalize: () => void } | null = null;

	function teardown() {
		if (view) {
			try {
				view.finalize();
			} catch {
				/* ignore — already gone */
			}
			view = null;
		}
	}

	/**
	 * Re-embed whenever the spec (or the container element) changes. Lazily
	 * imports vega-embed so it isn't pulled into the initial bundle for users
	 * who never trigger a column analysis.
	 */
	$effect(() => {
		// Read reactive deps up front so the effect tracks them.
		const currentSpec = spec;
		const el = container;

		if (!el || !currentSpec) {
			teardown();
			errored = false;
			loading = false;
			return;
		}

		let cancelled = false;
		loading = true;
		errored = false;

		(async () => {
			try {
				const { default: vegaEmbed } = await import('vega-embed');
				if (cancelled || !container) return;

				// Drop any previous view before mounting the new one.
				teardown();

				// Unwrap to a plain POJO before embedding. The dashboard-worker
				// path already hands us a JSON-roundtripped object, but the chat
				// path (ChatPane → workspace.messages) stores the spec in Svelte
				// 5 $state, so by the time it reaches us as a prop it's a reactive
				// PROXY. vega-embed's internal cloning/traversal chokes on that
				// proxy and its promise never settles — the chart hangs forever on
				// the "Crunching chart…" skeleton. $state.snapshot() deep-unwraps
				// the proxy to a plain object (and is a cheap clone for the
				// already-plain dashboard specs), restoring the guarantee
				// vega-embed needs.
				const plainSpec = $state.snapshot(currentSpec) as object;

				const result = await vegaEmbed(
					container,
					plainSpec,
					{
						actions: false,
						// 'canvas' is dramatically lighter on memory + GPU
						// when many charts are mounted in a grid (200
						// inline SVG trees = brutal). The dashboard's
						// grids use canvas. The chat / single-chart paths
						// can override this via CSS / a prop if they want
						// SVG. For the workbench this is the right default.
						renderer: 'canvas',
						// Match the host background; the spec already styles axes/marks.
						theme: undefined
					}
				);

				if (cancelled) {
					// Effect re-ran (or destroyed) mid-embed — discard this view.
					try {
						result.finalize();
					} catch {
						/* ignore */
					}
					return;
				}

				view = result;
				loading = false;
			} catch (err) {
				if (cancelled) return;
				console.warn('[VegaChart] embed failed:', err);
				errored = true;
				loading = false;
			}
		})();

		// Cleanup for THIS effect run: cancel the in-flight embed and tear down.
		return () => {
			cancelled = true;
			teardown();
		};
	});
</script>

<div class="vega-chart relative" role="img" aria-label={label}>
	{#if errored}
		<div
			class="flex h-[120px] items-center justify-center rounded-lg border border-slate-700 bg-slate-900/40 px-4 text-center text-xs text-gray-500"
		>
			Chart unavailable.
		</div>
	{:else}
		<!-- The embed target. Always present AND always at full container
		     width so vega-embed's `width: 'container'` sees the right number
		     on the first measure. The previous implementation toggled
		     `invisible h-0 overflow-hidden` during loading — that collapsed
		     the container to 0 width, so vega-embed sized the chart to 0
		     (or its fallback default) and rendered the chart to the right
		     of the popover, clipped off-page. Now the embed target is
		     always full size, and the skeleton is a positioned absolute
		     overlay that doesn't push the layout. -->
		<div bind:this={container} class="w-full min-h-[300px]"></div>

		{#if loading}
			<!-- Skeleton pulse while embedding. Sits on top of (and matches
			     the size of) the empty embed target below it. -->
			<div
				class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-slate-700/40 animate-pulse"
			>
				<span class="text-xs text-gray-500">Crunching chart…</span>
			</div>
		{/if}
	{/if}
</div>

<style>
	.vega-chart {
		width: 100%;
	}
	/* vega-embed wraps the SVG in a .vega-embed div; make it fill the width so
	   the "container" width spec is honored inside the chat bubble. */
	.vega-chart :global(.vega-embed) {
		width: 100%;
	}
	.vega-chart :global(svg) {
		max-width: 100%;
	}
</style>
