<script lang="ts">
	import { dropContainsDirectory } from '$lib/utils/drag-drop.js';

	interface Props {
		/**
		 * Types that open directly in the in-app viewer. This is NOT a hard
		 * accept filter — every file type is still accepted by drag/drop or
		 * browse. Anything outside this list is routed to the encrypt/vault
		 * flow (see SecureSaveModal.svelte) instead of being rejected. Do not
		 * wire this into the native `<input accept>` as an enforced
		 * restriction beyond a UI hint, or the "any file can be secured" flow
		 * will silently break.
		 */
		acceptedTypes?: string[];
		onFileSelected: (file: File) => void;
		disabled?: boolean;
		class?: string;
	}

	let {
		acceptedTypes = ['xlsx', 'csv', 'pdf', 'docx', 'txt', 'md'],
		onFileSelected,
		disabled = false,
		class: className = ''
	}: Props = $props();

	let isDragOver = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);
	// Transient inline error shown when a dropped item can't be handled at
	// all (currently: folders — see dropContainsDirectory's doc comment).
	// Cleared on the next successful drag interaction.
	let dropError = $state('');


	// NOTE: deliberately NOT building an `accept` string for the native
	// <input> from `acceptedTypes` (see that prop's doc comment above —
	// this list is display-only, describing what opens in the in-app
	// viewer, not an enforced upload restriction). Desktop Chromium file
	// pickers always offer an "All Files" option regardless of `accept`,
	// so wiring it in there was silently harmless. iOS Safari's document
	// picker, however, ENFORCES `accept` as a hard filter with no such
	// override in most versions — a narrow extension list there made
	// every file outside it simply unselectable, silently breaking the
	// "any file of any size can be encrypted & secured" flow advertised
	// right below the dropzone. Leaving `accept` unset shows every file
	// type on every platform, matching drag-and-drop's behavior (which
	// was never restricted).


	// MIME type labels for display
	const typeLabels: Record<string, string> = {
		xlsx: 'XLSX', xls: 'XLS', csv: 'CSV', tsv: 'TSV', pdf: 'PDF',
		docx: 'DOCX', doc: 'DOC', txt: 'TXT', md: 'MD'
	};

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		if (!disabled) isDragOver = true;
		if (dropError) dropError = '';
	}

	function handleDragLeave(e: DragEvent) {
		// Only clear if leaving the dropzone entirely
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		if (
			e.clientX < rect.left || e.clientX > rect.right ||
			e.clientY < rect.top  || e.clientY > rect.bottom
		) isDragOver = false;
	}
	function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragOver = false;
		if (disabled) return;
		// A dropped FOLDER hands back a synthetic zero-byte File (see
		// drag-drop.ts's doc comment) that would otherwise sail through as
		// an "unsupported type" and get "encrypted" into a blank, useless
		// .cesvu file. Reject it here with an inline message instead of
		// ever reaching onFileSelected.
		if (dropContainsDirectory(e)) {
			dropError = "Folders can't be uploaded or encrypted — drop an individual file instead.";
			return;
		}
		dropError = '';
		const file = e.dataTransfer?.files?.[0];
		if (file) onFileSelected(file);
	}

	function handleInputChange(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (file) {
			onFileSelected(file);
			// Reset so same file can be re-selected
			if (inputEl) inputEl.value = '';
		}
	}
	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			inputEl?.click();
		}
	}
</script>

<div
	role="button"
	aria-label="File drop zone — drop a file here or activate to browse"
	aria-disabled={disabled}
	class="relative rounded-xl border-2 border-dashed transition-all duration-150 cursor-pointer select-none
		{isDragOver
			? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 scale-[1.01]'
			: 'border-gray-300 bg-gray-50 hover:border-gray-400 hover:bg-gray-100 dark:border-slate-700 dark:bg-slate-900/50 dark:hover:border-gray-600 dark:hover:bg-slate-900'}
		{disabled ? 'opacity-50 cursor-not-allowed' : ''}
		{className}"
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
	onclick={() => !disabled && inputEl?.click()}
	onkeydown={handleKeyDown}
	tabindex={disabled ? -1 : 0}
>
	<div class="flex flex-col items-center justify-center py-6 sm:py-12 px-6 text-center pointer-events-none">
		<!-- Upload icon -->
		<div class="mb-2 sm:mb-4 p-3 rounded-full bg-gray-100 border border-gray-200 dark:bg-slate-800 dark:border-slate-700">

			{#if isDragOver}
				<svg class="w-8 h-8 text-blue-500 dark:text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<path d="M12 16V4m0 0L8 8m4-4l4 4" stroke-linecap="round" stroke-linejoin="round"/>
					<path d="M4 20h16" stroke-linecap="round"/>
				</svg>
			{:else}
				<svg class="w-8 h-8 text-gray-400 dark:text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
					<path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" stroke-linecap="round" stroke-linejoin="round"/>
				</svg>
			{/if}
		</div>

		{#if isDragOver}
			<p class="text-base font-semibold text-blue-600 dark:text-blue-300">Drop to upload</p>
		{:else}
			<p class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
				Drop a file here, or <span class="text-blue-600 dark:text-blue-400 underline underline-offset-2">browse</span>
			</p>
			<p class="text-xs text-gray-500">
				🔒 Any file of any size can be encrypted &amp; secured
			</p>
			<p class="text-xs text-gray-400 dark:text-gray-600">
				Opens in viewer: {acceptedTypes.map((t) => typeLabels[t.replace('.', '')] ?? t.toUpperCase()).join(', ')}
			</p>

		{/if}
	</div>

	<!-- Hidden file input -->
	<input
		bind:this={inputEl}
		type="file"
		onchange={handleInputChange}

		{disabled}
		class="sr-only"
		aria-label="Upload file"
		tabindex="-1"
	/>

</div>

{#if dropError}
	<p class="mt-2 text-xs text-red-300" role="alert">{dropError}</p>
{/if}


