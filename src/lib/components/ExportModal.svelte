<script lang="ts">
	/**
	 * ExportModal.svelte — turn a saved document into a portable .cesvu file.
	 *
	 * Flow:
	 *   1. "options" — the sender chooses whether the ORIGINAL SOURCE FILE is
	 *      embedded in the .cesvu. Default is INCLUDE for every source-bearing
	 *      type (PDF/DOCX/CSV/XLSX): "Include the original file" is checked, and
	 *      the sender can opt out. Opting out still ships the extracted text +
	 *      analysis; for CSV/XLSX it also means the recipient can't rebuild the
	 *      interactive table (we say so). TXT/MD have no separate source, so the
	 *      step is skipped entirely (goes straight to "generating").
	 *   2. "generating" — build the plain, checksummed .cesvu file (see
	 *      exportAsCesvu). The .cesvu export carries a SHA-256 integrity
	 *      checksum only, not confidentiality (see cesvu-export.ts's top doc
	 *      comment).
	 *   3. "sharing" / "done" — the file is ready to share (Web Share API) or
	 *      has already downloaded.
	 */
	import { onMount } from 'svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import ShareSheet from '$lib/components/ShareSheet.svelte';
	import {
		exportAsCesvu,
		getDocument,
		describeExportError
	} from '$lib/stores/contract-store.svelte.js';

	import { DEFAULT_CESVU_DOWNLOAD_NAME } from '$lib/utils/cesvu-filename.js';
	import type { SourceType } from '$lib/schema.js';

	interface Props {
		documentId: string;
		/**
		 * True when THIS session was opened by unlocking a .cesvu file. Kept as
		 * a prop for callers/tests that still pass it, but no longer drives any
		 * UI in this modal — the "recover original file" affordance that used
		 * to live here (gated on this + hasSource) has been removed.
		 */
		openedFromCesvu?: boolean;
		onclose: () => void;
	}
	let { documentId, openedFromCesvu = false, onclose }: Props = $props();

	type Phase = 'options' | 'generating' | 'sharing' | 'done' | 'error';
	let phase = $state<Phase>('options');
	let error = $state('');

	let blob: Blob | null = null;

	/**
	 * Phases during which a real build/write operation is actively in
	 * flight — the modal must be non-dismissible (backdrop click, Escape,
	 * header ✕) for these. See Modal.svelte's `dismissible` prop.
	 */
	function isDismissiblePhase(p: Phase): boolean {
		return p !== 'generating' && p !== 'sharing';
	}

	// ── Source-inclusion choice ────────────────────────────────────────────────
	// `excludeSource` is the user-facing opt-out state (checked = "Don't include
	// source file"). It defaults to FALSE for every source-bearing type, so the
	// original file is INCLUDED by default and the sender can opt out. TXT/MD have
	// no separate source so the options step is skipped.
	let sourceType = $state<SourceType | null>(null);
	let excludeSource = $state(false);
	/** This session's opened doc actually carries the original bytes. */
	let hasSource = $state(false);

	/** CSV/XLSX rebuild their interactive viewer from the raw bytes; excluding the
	 *  source means the recipient only gets the extracted data (no live table). */
	const isTabular = $derived(sourceType === 'csv' || sourceType === 'excel');
	/** TXT/MD: the text IS the content, there's no separate binary to exclude. */
	const noSourceConcept = $derived(sourceType === 'txt' || sourceType === 'md');
	/** What we actually pass to the builder — include by default, opt-out aware. */
	const includeSource = $derived(!excludeSource);

	/** Human label for the file kind, used in the helper text. */
	const typeLabel = $derived(
		sourceType === 'pdf'
			? 'PDF'
			: sourceType === 'docx'
				? 'Word'
				: sourceType === 'csv'
					? 'CSV'
					: sourceType === 'excel'
						? 'spreadsheet'
						: 'source'
	);

	onMount(() => {
		void init();
	});

	/** Inspect the document so we can pick the right options UI (or skip it). */
	async function init() {
		try {
			const doc = await getDocument(documentId);
			sourceType = doc?.sourceType ?? null;
			hasSource =
				(typeof doc?.rawContent === 'string' && doc.rawContent.length > 0) ||
				(doc?.rawContent instanceof Uint8Array && doc.rawContent.length > 0);
		} catch {
			sourceType = null;
		}

		// Skip the options step when there's no source choice to make:
		//   - TXT/MD have no separate source binary, and
		//   - any document re-exported WITHOUT its source bytes (e.g. opened from
		//     a .cesvu whose sender excluded the source) has nothing to include,
		//     so offering "Include original source file" would be redundant.
		// In both cases go straight to generating.
		if (noSourceConcept || !hasSource) {
			void prepare();
		} else {
			phase = 'options';
		}
	}

	async function prepare() {
		phase = 'generating';
		try {
			const result = await exportAsCesvu(documentId, { includeSource });
			blob = result.blob;
			download();
			phase = 'done';
		} catch (e) {
			error = e instanceof Error ? e.message : describeExportError(e);
			phase = 'error';
		}
	}

	/** The exported .cesvu is ALWAYS named generically, never after the
	 *  document it came from.
	 *
	 *  This file is the artifact the sender hands to someone else, so its
	 *  outer name is the one part of the export that is readable by anyone
	 *  who merely sees it — in an inbox, a cloud drive, or a Finder window.
	 *  Deriving it from the document (e.g. "quarterly-layoffs-plan.cesvu")
	 *  leaks the subject matter to exactly those observers. Stripping just
	 *  the extension isn't enough; the base name is usually the more
	 *  revealing half.
	 *
	 *  Nothing is lost by this. The real filename and extension travel
	 *  inside the envelope's metadata (exportAsCesvu sets metadata.filename),
	 *  and the web importer restores from there. The recipient still gets
	 *  the correct name; only passive observers are kept in the dark.
	 */
	function exportFileName(): string {
		return DEFAULT_CESVU_DOWNLOAD_NAME;
	}

	function download() {
		if (!blob) return;
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = exportFileName();
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	/**
	 * The file exists in memory as `blob` at this point, so this is the hook
	 * point for the Web Share API flow (see ShareSheet.svelte). `shareFile`
	 * is built fresh each time this phase is entered, wrapping the same blob
	 * the "Download again" button already uses.
	 */
	let shareFile: File | null = $state(null);
	function share() {
		if (!blob) return;
		shareFile = new File([blob], DEFAULT_CESVU_DOWNLOAD_NAME, {
			type: 'application/octet-stream'
		});
		phase = 'sharing';
	}

	/** ShareSheet's fallback — restores the pre-Share-API default behavior
	 *  exactly (download the file, show the "done" screen). Reached when
	 *  the file is too large, canShare() reports unsupported, or
	 *  navigator.share() rejects with anything other than a user cancel. */
	function shareFallback() {
		download();
		phase = 'done';
	}

	/** The user cancelled the OS share sheet — silently return to the
	 *  done screen with no toast, no error, no fallback. */
	function shareCancelled() {
		phase = 'done';
	}
</script>

<Modal open={true} title="Share document" {onclose} dismissible={isDismissiblePhase(phase)}>

	{#if phase === 'options'}
		<div class="space-y-4">
			<p class="text-sm text-gray-700 dark:text-gray-300">
				Choose what to include in the file.
			</p>

			<!-- Every source-bearing type (PDF / DOCX / CSV / XLSX) INCLUDES the
			     original file by default. Unchecking opts out and ships only the
			     extracted text + analysis. -->
			<label
				class="flex cursor-pointer items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-3 dark:border-slate-700 dark:bg-slate-800/40"
			>
				<input
					type="checkbox"
					checked={includeSource}
					onchange={(e) => (excludeSource = !e.currentTarget.checked)}
					class="mt-0.5 h-4 w-4 rounded border-gray-300 bg-white text-blue-600 dark:border-gray-600 dark:bg-slate-800"
				/>

				<span class="space-y-1">
					<span class="block text-sm font-medium text-gray-900 dark:text-gray-100">
						Include the original file
					</span>
					<span class="block text-xs text-gray-500 dark:text-gray-400">
						{#if includeSource}
							The recipient can download the original {typeLabel} file.
							{#if isTabular}They can also reopen it as an interactive table.{/if}
						{:else}
							The recipient gets the extracted text and analysis, but cannot download the
							original {typeLabel} file{#if isTabular} or reopen the interactive table{/if}.
						{/if}
					</span>
				</span>
			</label>
		</div>
	{:else if phase === 'generating'}
		<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 dark:border-slate-700 border-t-blue-500"></div>
			<p class="text-sm text-gray-500 dark:text-gray-400">Preparing your file…</p>
		</div>
	{:else if phase === 'error'}
		<div class="space-y-4 py-4">
			<p class="text-sm text-red-600 dark:text-red-300">{error}</p>
			<button
				onclick={prepare}
				class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700"
			>
				Try again
			</button>
		</div>
	{:else if phase === 'sharing'}
		<!-- Web Share API flow — see ShareSheet.svelte. Handles size/canShare
		     gating, the iOS clipboard workaround, and the success banner
		     itself; falls back to the plain download ("done" screen) below
		     via shareFallback() whenever sharing isn't possible. -->
		{#if shareFile}
			<ShareSheet
				file={shareFile}
				onFallback={shareFallback}
				onCancel={shareCancelled}
				onDone={onclose}
			/>
		{/if}
	{:else}
		<!-- done -->
		<div class="flex flex-col items-center justify-center gap-3 py-8 text-center">
			<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40 text-2xl">
				✓
			</div>
			<p class="text-sm font-medium text-gray-900 dark:text-white">Your file is downloading.</p>
			<p class="text-xs text-gray-500 dark:text-gray-400">
				This file is not encrypted — anyone with it can open it.
			</p>
		</div>
	{/if}

	{#snippet footer()}
		{#if phase === 'options'}
			<div class="flex justify-end gap-2">
				<button
					onclick={onclose}
					class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
				>
					Cancel
				</button>
				<button
					onclick={prepare}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600"
				>
					Continue
				</button>
			</div>
		{:else if phase === 'sharing'}
			<!-- No footer buttons — ShareSheet.svelte renders its own
			     in-body actions for each of its internal states. -->
		{:else if phase === 'done'}
			<div class="flex justify-end gap-2">
				<button
					onclick={download}
					class="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
				>
					Download again
				</button>
				<button
					onclick={share}
					class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700"
				>
					Share
				</button>
				<button
					onclick={onclose}
					class="rounded-lg bg-blue-700 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-600"
				>
					Done
				</button>
			</div>
		{/if}
	{/snippet}
</Modal>
