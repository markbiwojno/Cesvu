<script lang="ts">
	/**
	 * RedFlagBadge.svelte — summary pill for red flags detected in a contract.
	 *
	 * Scans the document text (off the main thread via requestIdleCallback so it
	 * never blocks first paint) and shows one of three states:
	 *   - scanning  → "Scanning…"
	 *   - none      → "No red flags"
	 *   - found(N)  → "N red flags" (clickable; cycles focus through each match)
	 *
	 * Clicking the badge advances an internal cursor through the red-flag matches
	 * and calls `onJump` with the next match, so the parent can scroll the
	 * reading surface to it. All copy/counts come from the glossary detector —
	 * nothing is hardcoded.
	 */
	import { getRedFlagSummary } from '$lib/lenses/contract/glossary-detector.js';
	import type { GlossaryMatch, RedFlagSummary, Perspective } from '$lib/lenses/contract/types.js';

	interface Props {
		/** The full contract text to scan. */
		text: string;
		/**
		 * Active glossary perspective. The flag count is identical across
		 * perspectives (same term set), but the badge label + colour flip:
		 * 'employee' → red flags, 'investor' → green flags. Passing it also
		 * re-triggers the scan effect when the lens changes.
		 */
		perspective?: Perspective;
		/** Called with the next flag match when the badge is clicked. */
		onJump?: (match: GlossaryMatch, index: number) => void;
	}

	let { text, perspective = 'employee', onJump }: Props = $props();

	/** True when the investor lens is active (green flags instead of red). */
	const isGreen = $derived(perspective === 'investor');
	/** Singular/plural noun for the active perspective's flags. */
	const flagNoun = $derived(isGreen ? 'green flag' : 'red flag');


	let scanning = $state(true);
	let summary = $state<RedFlagSummary | null>(null);
	let cursor = $state(-1);

	// Re-scan whenever the text changes. Defer the (cheap but non-trivial) scan to
	// idle time so opening a document stays snappy.
	$effect(() => {
		const current = text;
		// Read perspective so flipping the lens re-runs the scan against the
		// rebuilt trie (counts match; the matches embed the active entries).
		void perspective;
		scanning = true;

		summary = null;
		cursor = -1;

		if (!current || current.trim().length === 0) {
			scanning = false;
			summary = { totalRedFlags: 0, byCategory: {} as never, matches: [] };
			return;
		}

		let cancelled = false;
		const run = () => {
			if (cancelled) return;
			summary = getRedFlagSummary(current);
			scanning = false;
		};

		// Pull idle-callback APIs off globalThis as `unknown`-typed optionals so we
		// degrade gracefully on engines (and TS lib targets) that lack them.
		const g = globalThis as unknown as {
			requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
			cancelIdleCallback?: (h: number) => void;
		};
		const ric = g.requestIdleCallback;
		const handle = ric ? ric(run, { timeout: 1200 }) : (setTimeout(run, 0) as unknown as number);

		return () => {
			cancelled = true;
			const cic = g.cancelIdleCallback;
			if (ric && cic) cic(handle);
			else clearTimeout(handle);
		};


	});

	const total = $derived(summary?.totalRedFlags ?? 0);

	function handleClick() {
		if (!summary || summary.matches.length === 0) return;
		cursor = (cursor + 1) % summary.matches.length;
		onJump?.(summary.matches[cursor], cursor);
	}
</script>

{#if scanning}
	<span class="badge badge-scan" title="Scanning for {flagNoun} terms…">
		<span class="spinner" aria-hidden="true"></span>
		Scanning…
	</span>
{:else if total === 0}
	<span class="badge badge-clear" title="No known {flagNoun} terms detected">
		<span aria-hidden="true">✓</span> No {flagNoun}s
	</span>
{:else}
	<button
		type="button"
		class="badge {isGreen ? 'badge-flag-green' : 'badge-flag'}"
		onclick={handleClick}
		title="Click to jump to each {flagNoun} in order"
	>
		<span aria-hidden="true">{isGreen ? '✅' : '🚩'}</span>
		{total}
		{total === 1 ? flagNoun : `${flagNoun}s`}
	</button>
{/if}


<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.7rem;
		font-weight: 600;
		padding: 0.2rem 0.55rem;
		border-radius: 999px;
		white-space: nowrap;
		border: 1px solid transparent;
	}
	.badge-scan {
		color: #9ca3af;
		border-color: #374151;
		background: #1f2937;
	}
	.badge-clear {
		color: #6ee7b7; /* emerald-300 */
		border-color: #065f46;
		background: rgba(6, 95, 70, 0.25);
	}
	.badge-flag {
		color: #fca5a5; /* red-300 */
		border-color: #991b1b;
		background: rgba(153, 27, 27, 0.25);
		cursor: pointer;
		transition: background-color 0.15s;
	}
	.badge-flag:hover {
		background: rgba(153, 27, 27, 0.45);
	}
	.badge-flag-green {
		color: #6ee7b7; /* emerald-300 */
		border-color: #065f46;
		background: rgba(6, 95, 70, 0.3);
		cursor: pointer;
		transition: background-color 0.15s;
	}
	.badge-flag-green:hover {
		background: rgba(6, 95, 70, 0.5);
	}

	.spinner {
		width: 0.7rem;
		height: 0.7rem;
		border: 2px solid #4b5563;
		border-top-color: #9ca3af;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* ── Light-mode overrides — applied when the app is in light mode (see
	     <html> class managed by mode-watcher). The dark palette above uses
	     light text on dark/translucent backgrounds (e.g. emerald-300 text on
	     a near-black emerald tint), which is illegible against a light page
	     background — these swap in a light pill treatment (darker accessible
	     text on a pale tint) mirroring the dark styles 1:1. Selectors are
	     fully :global(...) since Svelte's scoping analysis can't verify a
	     split global()/local chain will ever match, and flags it as an
	     unused-selector warning. */
	:global(html:not(.dark) .badge-scan) {
		color: #4b5563; /* gray-600 */
		border-color: #d1d5db; /* gray-300 */
		background: #f3f4f6; /* gray-100 */
	}
	:global(html:not(.dark) .badge-clear) {
		color: #047857; /* emerald-700 */
		border-color: #6ee7b7; /* emerald-300 */
		background: #ecfdf5; /* emerald-50 */
	}
	:global(html:not(.dark) .badge-flag) {
		color: #b91c1c; /* red-700 */
		border-color: #fca5a5; /* red-300 */
		background: #fef2f2; /* red-50 */
	}
	:global(html:not(.dark) .badge-flag:hover) {
		background: #fee2e2; /* red-100 */
	}
	:global(html:not(.dark) .badge-flag-green) {
		color: #047857; /* emerald-700 */
		border-color: #6ee7b7; /* emerald-300 */
		background: #ecfdf5; /* emerald-50 */
	}
	:global(html:not(.dark) .badge-flag-green:hover) {
		background: #d1fae5; /* emerald-100 */
	}
	:global(html:not(.dark) .spinner) {
		border-color: #d1d5db; /* gray-300 */
		border-top-color: #6b7280; /* gray-500 */
	}
</style>
