<script lang="ts">
	import { onMount, tick } from 'svelte';

	interface Props {
		open: boolean;
		title?: string;
		onclose?: () => void;
		/**
		 * When false, the modal cannot be dismissed via backdrop click, the
		 * Escape key, or the header ✕ button — only an explicit in-flow
		 * action (e.g. a "Cancel"/"Done" button the caller renders itself)
		 * can close it. Defaults to true. Callers use this to protect an
		 * in-progress operation (e.g. streaming encryption) from being torn
		 * down mid-flight by an accidental click-away or Escape press, which
		 * would abandon the operation with no way to resume it.
		 */
		dismissible?: boolean;
		children: import('svelte').Snippet;
		footer?: import('svelte').Snippet;
	}
	let { open, title, onclose, dismissible = true, children, footer }: Props = $props();


	let panelEl = $state<HTMLDivElement | null>(null);
	// The element that had focus before the modal opened — restored on close so
	// keyboard users return to the control that launched the dialog.
	let previouslyFocused: HTMLElement | null = null;

	function handleKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') {
			if (dismissible) onclose?.();
			return;
		}
		if (e.key === 'Tab') trapFocus(e);
	}


	/** Collect the focusable elements inside the panel, in DOM order. */
	function focusable(): HTMLElement[] {
		if (!panelEl) return [];
		return Array.from(
			panelEl.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
			)
		).filter((el) => el.offsetParent !== null || el === document.activeElement);
	}

	/** Keep Tab / Shift+Tab cycling inside the panel (focus trap). */
	function trapFocus(e: KeyboardEvent) {
		const els = focusable();
		if (els.length === 0) {
			// Nothing focusable — keep focus on the panel itself.
			e.preventDefault();
			panelEl?.focus();
			return;
		}
		const first = els[0];
		const last = els[els.length - 1];
		const active = document.activeElement as HTMLElement | null;
		if (e.shiftKey) {
			if (active === first || !panelEl?.contains(active)) {
				e.preventDefault();
				last.focus();
			}
		} else {
			if (active === last || !panelEl?.contains(active)) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	// On open: remember the launcher, then move focus into the panel.
	// On close: restore focus to the launcher.
	$effect(() => {
		if (open) {
			previouslyFocused = document.activeElement as HTMLElement | null;
			tick().then(() => {
				const els = focusable();
				(els[0] ?? panelEl)?.focus();
			});
		} else if (previouslyFocused) {
			previouslyFocused.focus();
			previouslyFocused = null;
		}
	});

	onMount(() => {
		document.addEventListener('keydown', handleKeydown);
		return () => document.removeEventListener('keydown', handleKeydown);
	});
</script>

{#if open}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
		onclick={(e) => { if (dismissible && e.target === e.currentTarget) onclose?.(); }}
		role="presentation"
	>

		<!-- Panel -->
		<div
			bind:this={panelEl}
			class="relative bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
			role="dialog"
			aria-modal="true"
			aria-label={title}
			tabindex="-1"
		>
			<!-- Close button: available when onclose is set AND the modal is
			     currently dismissible, regardless of whether a title/header is
			     rendered. Absolutely positioned so it floats over headerless
			     modals too. Hidden entirely (rather than just disabled) while
			     `dismissible` is false, so there's no dead-looking control
			     during e.g. an in-progress encrypt. -->
			{#if onclose && dismissible}
				<button
					onclick={onclose}
					class="absolute top-3 right-3 z-10 text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-300 transition-colors p-1 rounded"
					aria-label="Close"
				>
					✕
				</button>
			{/if}


			{#if title}
				<div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-slate-800 pr-12">
					<h2 class="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
				</div>
			{/if}
			<div class="flex-1 overflow-y-auto px-6 py-4">
				{@render children()}
			</div>
			{#if footer}
				<div class="px-6 py-4 border-t border-gray-200 dark:border-slate-800">
					{@render footer()}
				</div>
			{/if}
		</div>
	</div>
{/if}
