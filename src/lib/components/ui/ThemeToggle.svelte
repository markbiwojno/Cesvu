<script lang="ts">
	/**
	 * ThemeToggle.svelte — light/dark mode switch for the main header.
	 *
	 * Wraps mode-watcher's toggleMode()/mode store. mode-watcher persists the
	 * user's explicit choice to localStorage (key: mode-watcher-mode) and
	 * applies it via a FOUC-safe inline script on load (see +layout.svelte's
	 * <ModeWatcher defaultMode="dark" />), so the choice survives reloads and
	 * new visits without a flash of the wrong theme.
	 */
	// `mode` is a Svelte store (this mode-watcher version predates the
	// rune-based `.current` API), so it's read here with the `$mode` prefix.
	import { mode, toggleMode } from 'mode-watcher';
	import { Sun, Moon } from 'lucide-svelte';
</script>

<button
	type="button"
	onclick={toggleMode}
	class="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-600 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-gray-300 transition-colors"
	aria-label={$mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
	title={$mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
>
	{#if $mode === 'dark'}
		<Sun class="w-4 h-4" aria-hidden="true" />
	{:else}
		<Moon class="w-4 h-4" aria-hidden="true" />
	{/if}
</button>
