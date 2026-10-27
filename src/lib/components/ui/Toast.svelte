<script lang="ts">
	/**
	 * Toast.svelte — transient bottom-center notification driven by the workspace
	 * store (workspace.toast / workspace.showToast). Used for brief feedback like
	 * "Copied" after a context-menu copy action. The store handles auto-dismiss;
	 * this component just renders and animates the current toast.
	 *
	 * Keyed on the toast `id` so an identical message fired twice still replays
	 * the enter animation.
	 */
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import { fly } from 'svelte/transition';
</script>

{#if workspace.toast}
	{#key workspace.toast.id}
		<div
			class="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 pointer-events-none"
			role="status"
			aria-live="polite"
			transition:fly={{ y: 12, duration: 150 }}
		>
			<div class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-gray-100 text-xs font-medium shadow-xl">
				{workspace.toast.message}
			</div>
		</div>
	{/key}
{/if}
