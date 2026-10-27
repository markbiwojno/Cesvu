<script lang="ts">
	/**
	 * GlossaryTooltip.svelte — click-to-open definition + red/green-flag popover.
	 *
	 * Wraps an inline run of contract text (the matched glossary term) and shows a
	 * floating card ON CLICK (no hover trigger — see below). The card content is driven

	 * ENTIRELY by the glossary entry — definition, risk/benefit note, and
	 * negotiation script — nothing is hardcoded. `entry.flagKind` is the single
	 * source of truth for the visual treatment:
	 *   - 'red'   → wavy-red underline, risk note, "soften it" script (employee)
	 *   - 'green' → wavy-emerald underline, benefit note, "keep it" script (investor)
	 *   - 'none'  → dotted-blue underline, plain definition
	 *
	 * Negotiation script UX (per product spec):
	 *   - Flagged terms show the short one-liner (`negotiationScript`) by default.
	 *   - "Show full script" expands to the longer `scriptLong` on demand.
	 *   - A Copy button copies whichever script is currently shown.
	 *
	 * The trigger stays inline (display: contents on the wrapper) so it never
	 * breaks the surrounding justified contract layout or text selection.
	 */
	import { tick } from 'svelte';
	import type { Snippet } from 'svelte';
	import type { GlossaryEntry } from '$lib/lenses/contract/types.js';

	interface Props {
		/** The matched glossary entry (definition + optional risk/benefit/script). */
		entry: GlossaryEntry;
		/** The inline text to render as the (underlined) trigger. */
		children: Snippet;
	}

	let { entry, children }: Props = $props();

	// flagKind is the single source of truth. Fall back to isRedFlag for any
	// entry that predates the field (defensive — the loader always sets it now).
	const flagKind = $derived(entry.flagKind ?? (entry.isRedFlag ? 'red' : 'none'));
	const isRedFlag = $derived(flagKind === 'red');
	const isGreenFlag = $derived(flagKind === 'green');
	const isFlag = $derived(isRedFlag || isGreenFlag);
	/** The risk note (red) or benefit note (green) for this entry. */
	const flagNote = $derived(isGreenFlag ? entry.benefitNote : entry.riskNote);


	// ── Popover visibility + placement ────────────────────────────────────────
	//
	// CLICK-ONLY model: the popover never opens on hover. A click on the term
	// (or anywhere within the term's hit area) toggles it. It's dismissed by a
	// second click, an outside click, Escape, or scroll. This removes the
	// flaky hover/dwell race entirely.
	//
	// MEASURE-THEN-PLACE positioning: rather than guessing the card's height
	// up front (which was the root cause of inconsistent placement/flicker —
	// real cards range from ~90px to 350px+ depending on whether there's a
	// risk/benefit note and negotiation script), we render the card as soon
	// as it opens but keep it invisible (`ready = false`) until we've measured
	// its ACTUAL rendered height via `popEl.getBoundingClientRect()` and used
	// that real number to decide above/below + clamp within bounds. The user
	// never sees the wrongly-placed intermediate frame, which is what removes
	// the flicker. A ResizeObserver keeps this correct if the content's height
	// changes after opening (e.g. "Show full script" growing the card).
	let visible = $state(false);
	let ready = $state(false);
	let placement = $state<'top' | 'bottom'>('top');
	let triggerEl = $state<HTMLSpanElement | null>(null);
	let popEl = $state<HTMLSpanElement | null>(null);

	// The click point that opened the popover (or null for keyboard), retained
	// so we can re-place after measuring and again on any resize.
	let anchorX: number | null = null;
	let anchorY: number | null = null;

	let resizeObserver: ResizeObserver | null = null;

	// Whether the long script is expanded. Resets when the popover closes.
	let showLong = $state(false);
	// Transient "Copied!" feedback on the copy button.
	let copied = $state(false);

	/** The script text currently shown (long if expanded + available). */
	const activeScript = $derived(
		showLong && entry.scriptLong ? entry.scriptLong : (entry.negotiationScript ?? '')
	);

	// Viewport coordinates for the FIXED popover. Computed from the trigger's
	// bounding rect at open time. The popover is `position: fixed` (so the
	// contract pane's overflow:auto can't clip it), but we clamp its X and Y to
	// the CONTRACT CONTAINER's rect so the card always reads as "inside the
	// textbox" and is never cut off at the top, bottom, or sides.
	let popX = $state(0);
	let popY = $state(0);

	/** Popover dimensions (must track the CSS) used to clamp within bounds. */
	const POP_WIDTH = 352; // 22rem @16px
	// Only used for the very first (pre-measurement) placement pass, while the
	// card is still invisible — never shown to the user, so it doesn't need to
	// be exact. Once measured, the REAL height drives every decision below.
	const POP_INITIAL_GUESS_HEIGHT = 160;
	const GUTTER = 10; // min gap from any edge
	const GAP = 8; // must match the CSS translate offsets on .pop-top / .pop-bottom


	/**
	 * Resolve the scroll container the popover should stay inside. Walks up from
	 * the trigger to the nearest contract reading surface (`[data-contract-surface]`
	 * or the scrollable region) and falls back to the viewport.
	 */
	function boundsRect(): { left: number; right: number; top: number; bottom: number } {
		const fallback = { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
		let el: HTMLElement | null = triggerEl;
		while (el) {
			if (el.matches('[data-contract-surface], [role="region"]')) {
				const r = el.getBoundingClientRect();
				// Intersect with the viewport so an off-screen-scrolled container
				// still clamps to what the user can actually see.
				return {
					left: Math.max(r.left, 0),
					right: Math.min(r.right, window.innerWidth),
					top: Math.max(r.top, 0),
					bottom: Math.min(r.bottom, window.innerHeight)
				};
			}
			el = el.parentElement;
		}
		return fallback;
	}

	/**
	 * Position the fixed popover NEXT TO THE CLICK POINT, clamped INSIDE the
	 * contract container so it can never be cut off.
	 *
	 * Anchoring at the pointer (not the trigger's bounding box) is what makes the
	 * card appear right where the user clicked. A matched term can wrap across
	 * lines, so its bounding rect may span the whole paragraph width — centering
	 * on that rect would open the card far from the actual click. When there's no
	 * pointer (keyboard Enter/Space), we fall back to the trigger's rect center.
	 *
	 * @param clientX/clientY  viewport coords of the click; null for keyboard.
	 * @param popHeight        the height to use for the above/below + clamp
	 *                         decision. Pass a real measured height once the
	 *                         card is in the DOM; falls back to a rough guess
	 *                         only for the very first (invisible) placement.
	 */
	function computePosition(
		clientX: number | null,
		clientY: number | null,
		popHeight: number = POP_INITIAL_GUESS_HEIGHT
	) {
		if (!triggerEl) return;
		const rect = triggerEl.getBoundingClientRect();
		const b = boundsRect();

		// Anchor point: the click location, or the trigger center for keyboard.
		const ax = clientX ?? rect.left + rect.width / 2;
		const ay = clientY ?? rect.top + rect.height / 2;
		// The line height we should clear when opening above/below the click. Use
		// the trigger's own line box if it's a single line, else a sane default.
		const lineH = rect.height > 0 && rect.height < 48 ? rect.height : 22;

		// Vertical: prefer ABOVE the clicked line; flip below only if there isn't
		// room above within the container FOR THE REAL (measured) card height.
		// popY is the anchor edge for the CSS translate (pop-top pulls fully up
		// + gap; pop-bottom drops down + gap), then we clamp so the far edge of
		// the card never exceeds the container bounds even after that translate.
		const roomAbove = ay - b.top;
		const roomBelow = b.bottom - ay;
		if (roomAbove >= popHeight + GUTTER + GAP || roomAbove >= roomBelow) {
			placement = 'top';
			popY = ay - lineH / 2; // top of the clicked line
			// Clamp: the card's top edge (popY - GAP - popHeight) must not go
			// above the container's top bound.
			const minAnchor = b.top + GUTTER + GAP + popHeight;
			if (popY < minAnchor) popY = minAnchor;
		} else {
			placement = 'bottom';
			popY = ay + lineH / 2; // bottom of the clicked line
			// Clamp: the card's bottom edge (popY + GAP + popHeight) must not go
			// past the container's bottom bound.
			const maxAnchor = b.bottom - GUTTER - GAP - popHeight;
			if (popY > maxAnchor) popY = maxAnchor;
		}

		// Horizontal: center the panel on the click X, then clamp the CENTER so
		// the panel's edges (center ± half width) stay within the container.
		const half = POP_WIDTH / 2;
		const minX = b.left + GUTTER + half;
		const maxX = b.right - GUTTER - half;
		// If the container is narrower than the panel, just center within it.
		popX = minX > maxX ? (b.left + b.right) / 2 : Math.max(minX, Math.min(ax, maxX));
	}

	/**
	 * Re-measure the ACTUAL rendered card and re-place it using its real
	 * height. Called once right after open (post-`tick()`, so `popEl` reflects
	 * real content), and again whenever the card's size changes while open
	 * (via the ResizeObserver below — e.g. "Show full script" growing it).
	 */
	function measureAndPlace() {
		if (!popEl) return;
		const height = popEl.getBoundingClientRect().height;
		computePosition(anchorX, anchorY, height);
	}

	/** Hide the popover and reset transient UI. */
	function close() {
		visible = false;
		ready = false;
		showLong = false;
		resizeObserver?.disconnect();
		resizeObserver = null;
	}

	/**
	 * Click/tap toggles the popover. CLICK-ONLY — there is no hover trigger.
	 * Opening anchors the card at the click point (clientX/clientY) so it
	 * appears right where the user clicked; keyboard activation passes null →
	 * trigger center.
	 *
	 * Two-phase open: place with a rough guess first (so there's a sane
	 * fallback position even if measurement is somehow skipped), render the
	 * card invisibly, then measure its real height on the next tick and
	 * re-place + reveal. The user only ever sees the final, correctly placed
	 * frame — this is what eliminates the flicker and the wrong-side bugs.
	 */
	async function toggle(clientX: number | null = null, clientY: number | null = null) {
		if (visible) {
			close();
			return;
		}
		anchorX = clientX;
		anchorY = clientY;
		computePosition(clientX, clientY); // rough first pass, card stays hidden
		visible = true;
		ready = false;
		await tick(); // let the (invisible) card mount with real content
		measureAndPlace();
		ready = true; // reveal now that placement reflects the true size

		if (popEl && typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver(() => measureAndPlace());
			resizeObserver.observe(popEl);
		}
	}





	async function copyScript() {

		try {
			await navigator.clipboard.writeText(activeScript);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// Clipboard may be unavailable (permissions / insecure context) — ignore.
		}
	}

	// Dismiss on Escape, scroll, or any click/tap outside the term + popover.
	$effect(() => {
		if (!visible) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') close();
		};
		const onScroll = () => close();
		// Outside-click: a pointerdown that lands on neither the trigger nor the
		// popover dismisses. Capture phase so it runs before surface handlers.
		const onPointerDown = (e: PointerEvent) => {
			const t = e.target as Node | null;
			if (t && (triggerEl?.contains(t) || popEl?.contains(t))) return;
			close();
		};
		window.addEventListener('keydown', onKey);
		window.addEventListener('scroll', onScroll, { passive: true, capture: true });
		document.addEventListener('pointerdown', onPointerDown, true);
		return () => {
			window.removeEventListener('keydown', onKey);
			window.removeEventListener('scroll', onScroll, { capture: true });
			document.removeEventListener('pointerdown', onPointerDown, true);
		};
	});

</script>

<span
	bind:this={triggerEl}
	class="glossary-trigger {isRedFlag ? 'is-redflag' : isGreenFlag ? 'is-greenflag' : 'is-term'}"

	role="button"
	tabindex="0"
	aria-haspopup="dialog"
	aria-expanded={visible}
	onclick={(e) => {
		e.stopPropagation();
		// Anchor the card at the exact click point so it opens right where the
		// user clicked (the term's bounding box may span a wrapped paragraph).
		toggle(e.clientX, e.clientY);
	}}

	onkeydown={(e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			toggle(); // keyboard → null coords → anchor at trigger center
		}
	}}

>{@render children()}{#if visible}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<span
			bind:this={popEl}
			class="glossary-pop {placement === 'top' ? 'pop-top' : 'pop-bottom'} {ready ? 'is-ready' : 'is-measuring'}"
			style="left: {popX}px; top: {popY}px;"
			role="dialog"
			tabindex="-1"
			aria-label="{entry.term} definition"
			onclick={(e) => e.stopPropagation()}
		>





			{#if isFlag}
				<span class="flag-bar {isGreenFlag ? 'flag-bar-green' : 'flag-bar-red'}" aria-hidden="true"></span>
			{/if}

			<span class="pop-head">
				{#if isRedFlag}<span aria-hidden="true">🚩</span>{:else if isGreenFlag}<span aria-hidden="true">✅</span>{/if}
				<span class="pop-term">{entry.term}</span>
				<span class="pop-cat">{entry.category}</span>
			</span>

			<span class="pop-def">{entry.definition}</span>

			{#if flagNote}
				<span class="pop-note {isGreenFlag ? 'pop-note-green' : 'pop-note-red'}">
					<span aria-hidden="true">{isGreenFlag ? '💡' : '⚠️'}</span>
					{flagNote}
				</span>
			{/if}

			{#if isFlag && activeScript}
				<span class="pop-script-wrap">
					<span class="pop-script-label">{isGreenFlag ? 'What to push for' : 'Negotiation script'}</span>

					<span class="pop-script">{activeScript}</span>
					<span class="pop-script-actions">
						<button type="button" class="pop-btn" onclick={copyScript}>
							{copied ? 'Copied!' : 'Copy'}
						</button>
						{#if entry.scriptLong && entry.scriptLong !== entry.negotiationScript}
							<button type="button" class="pop-btn pop-btn-ghost" onclick={() => (showLong = !showLong)}>
								{showLong ? 'Show less' : 'Show full script'}
							</button>
						{/if}
					</span>
				</span>
			{/if}
		</span>
	{/if}</span>

<style>
	/* The wrapper is `contents` so it adds no box of its own — the inline term
	   flows naturally inside the justified contract paragraph and stays
	   selectable. The popover is absolutely positioned off the trigger span. */
	.glossary-trigger {
		position: relative;
		cursor: pointer;
		border-radius: 2px;
	}

	/* Non-red-flag glossary term: subtle dotted blue underline. */
	.is-term {
		text-decoration: underline dotted #60a5fa;
		text-underline-offset: 3px;
	}
	.is-term:hover {
		background-color: rgba(59, 130, 246, 0.08);
	}
	/* Red flag: wavy red underline — the single visual source of truth. */
	.is-redflag {
		text-decoration: underline wavy #ef4444;
		text-underline-offset: 4px;
	}
	.is-redflag:hover {
		background-color: rgba(239, 68, 68, 0.12);
	}
	/* Green flag: wavy emerald underline (investor perspective). */
	.is-greenflag {
		text-decoration: underline wavy #10b981;
		text-underline-offset: 4px;
	}
	.is-greenflag:hover {
		background-color: rgba(16, 185, 129, 0.12);
	}


	/* FIXED positioning: the popover is rendered against the VIEWPORT, not the
	   contract pane, so the pane's overflow:auto can never clip it. `left`/`top`
	   are set inline from the trigger's bounding rect (popX is the trigger
	   center; translateX(-50%) recentres the panel). pop-top renders the panel
	   ABOVE the trigger (translate fully up + an 8px gap); pop-bottom renders it
	   below (small gap down). */
	.glossary-pop {
		position: fixed;
		z-index: 1000;
		display: block;
		width: 22rem;
		max-width: min(22rem, 92vw);
		padding: 0.75rem 0.85rem;
		border-radius: 0.6rem;
		background: #1f2937; /* gray-800 */
		border: 1px solid #374151; /* gray-700 */
		box-shadow: 0 12px 30px -8px rgba(0, 0, 0, 0.6);
		text-align: left;
		white-space: normal;
		font-weight: 400;
		cursor: default;
	}
	.pop-top {
		transform: translate(-50%, calc(-100% - 8px));
	}
	.pop-bottom {
		transform: translate(-50%, 8px);
	}

	/* MEASURING PHASE: the card is mounted (so its real size is measurable via
	   getBoundingClientRect) but must stay fully invisible and non-interactive
	   — this is what prevents the user from ever seeing the wrongly-placed
	   intermediate frame that caused the old flicker/inconsistent placement. */
	.is-measuring {
		visibility: hidden;
		opacity: 0;
		pointer-events: none;
	}
	/* READY PHASE: position has been finalized against the real measured
	   height, so it's safe to reveal. The fade-in only plays here — never
	   during measuring — so there's exactly one, correctly-placed entrance. */
	.is-ready {
		visibility: visible;
		animation: pop-in 0.12s ease-out;
	}



	.flag-bar {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 3px;
		border-radius: 0.6rem 0 0 0.6rem;
	}
	.flag-bar-red {
		background: #ef4444;
	}
	.flag-bar-green {
		background: #10b981;
	}


	.pop-head {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin-bottom: 0.35rem;
	}
	.pop-term {
		font-weight: 600;
		font-size: 0.82rem;
		color: #f3f4f6;
	}
	.pop-cat {
		margin-left: auto;
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #9ca3af;
		border: 1px solid #4b5563;
		border-radius: 999px;
		padding: 0.05rem 0.4rem;
	}
	.pop-def {
		display: block;
		font-size: 0.78rem;
		line-height: 1.5;
		color: #d1d5db;
	}
	.pop-note {
		display: block;
		margin-top: 0.45rem;
		font-size: 0.74rem;
		line-height: 1.5;
	}
	.pop-note-red {
		color: #fcd34d; /* amber-300 */
	}
	.pop-note-green {
		color: #6ee7b7; /* emerald-300 */
	}


	.pop-script-wrap {
		display: block;
		margin-top: 0.55rem;
		padding-top: 0.5rem;
		border-top: 1px solid #374151;
	}
	.pop-script-label {
		display: block;
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #93c5fd; /* blue-300 */
		margin-bottom: 0.25rem;
	}

	.pop-script {
		display: block;
		font-size: 0.76rem;
		line-height: 1.5;
		color: #e5e7eb;
		font-style: italic;
	}
	.pop-script-actions {
		display: flex;
		gap: 0.4rem;
		margin-top: 0.5rem;
	}
	.pop-btn {
		font-size: 0.68rem;
		font-weight: 600;
		padding: 0.2rem 0.55rem;
		border-radius: 0.35rem;
		background: #2563eb;
		color: #fff;
		border: none;
		cursor: pointer;
		transition: background-color 0.15s;
	}
	.pop-btn:hover {
		background: #3b82f6;
	}
	.pop-btn-ghost {
		background: transparent;
		color: #93c5fd;
		border: 1px solid #3b5bdb;
	}
	.pop-btn-ghost:hover {
		background: rgba(59, 130, 246, 0.15);
	}

	/* Fade only — the translate is owned by .pop-top / .pop-bottom (the panel's
	   placement transform), so the entrance animation must NOT touch transform or
	   it would yank the fixed popover away from the trigger for its duration. */
	@keyframes pop-in {
		from {
			opacity: 0;
		}
	}

</style>
