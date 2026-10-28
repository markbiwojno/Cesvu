<script lang="ts">
	/**
	 * ImportModal.svelte — open a .cesvu file.
	 *
	 * The file is chosen BEFORE this modal opens (file input or drag-drop) and
	 * handed in via the `file` prop. The `.cesvu` export carries a SHA-256
	 * integrity checksum only, not confidentiality (see cesvu-export.ts's top
	 * doc comment). Opening a file is therefore just: confirm, parse +
	 * checksum-verify, show the result.
	 *
	 * ── "File opened" success screen (stays open) ────────────────────────────
	 * The success screen stays open until the user takes an explicit action
	 * (View file) or dismisses it themselves (backdrop click / Escape / ✕ —
	 * all handled by Modal.svelte already).
	 */
	import { onMount } from 'svelte';
	import Modal from '$lib/components/common/Modal.svelte';
	import { importFromCesvu } from '$lib/stores/contract-store.svelte.js';
	import type { CesvuDocument } from '$lib/schema.js';

	interface Props {
		file: File;
		onclose: () => void;
		onimported: (doc: CesvuDocument) => void;
	}
	let { file, onclose, onimported }: Props = $props();

	type Phase = 'input' | 'opening' | 'success' | 'error';
	let phase = $state<Phase>('input');
	let error = $state('');

	/** The just-opened document — captured so the success screen can show
	 *  its name/size without re-reading anything. */
	let openedDoc = $state<CesvuDocument | null>(null);
	let showFileInfo = $state(false);

	/** Best-effort decrypted size for the success screen's "2.4 MB" line —
	 *  the raw source bytes when present (pdf/docx/csv/excel), otherwise the
	 *  UTF-8 byte length of the extracted text (txt/md). */
	function decodedByteSize(doc: CesvuDocument): number {
		if (doc.rawContent instanceof Uint8Array) return doc.rawContent.length;
		if (typeof doc.rawContent === 'string' && doc.rawContent.length > 0) {
			// base64 → byte length without decoding the whole thing.
			const s = doc.rawContent.replace(/=+$/, '');
			return Math.floor((s.length * 3) / 4);
		}
		return new TextEncoder().encode(doc.text ?? '').length;
	}

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		const units = ['KB', 'MB', 'GB', 'TB'];
		let v = n / 1024;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
	}

	/** Trigger a normal browser download of the opened document's bytes,
	 *  under its real name — the "Download file" item buried under More
	 *  options. Mirrors ExportModal.svelte's download(). */
	function downloadDecoded() {
		const doc = openedDoc;
		if (!doc) return;
		let bytes: Uint8Array;
		if (doc.rawContent instanceof Uint8Array && doc.rawContent.length > 0) {
			bytes = doc.rawContent;
		} else if (typeof doc.rawContent === 'string' && doc.rawContent.length > 0) {
			const bin = atob(doc.rawContent);
			bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		} else {
			bytes = new TextEncoder().encode(doc.text ?? '');
		}
		const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = doc.name || 'document';
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	}

	async function open() {
		phase = 'opening';
		error = '';
		try {
			const doc = await importFromCesvu(file);
			openedDoc = doc;
			phase = 'success';
			// The document is materialized into the workspace IMMEDIATELY on a
			// successful open — not deferred to "View file" — so it's already
			// live behind this modal by the time the success screen shows.
			// "View file" (and closing the modal any other way: ✕, backdrop,
			// Escape) all just reveal it; none of them should ever delete it.
			onimported(doc);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Unable to open this file.';
			phase = 'error';
		}
	}

	/** The document is already open behind this modal (onimported(doc)
	 *  already fired in open()) — closing just reveals it. */
	function viewFile() {
		onclose();
	}

	onMount(() => {
		void open();
	});
</script>

<Modal open={true} title="Open document" {onclose} dismissible={phase !== 'opening'}>
	{#if phase === 'input' || phase === 'opening'}
		<div class="flex flex-col items-center justify-center gap-3 py-10 text-center">
			<div class="h-8 w-8 animate-spin rounded-full border-2 border-gray-200 dark:border-slate-700 border-t-blue-500"></div>
			<p class="text-sm text-gray-500 dark:text-gray-400">Opening {file.name}…</p>
		</div>
	{:else if phase === 'error'}
		<div class="space-y-4 py-4">
			<p class="text-sm text-red-600 dark:text-red-300">{error}</p>
			<button
				onclick={open}
				class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700"
			>
				Try again
			</button>
		</div>
	{:else if phase === 'success' && openedDoc}
		<!-- Wide, but compact — the success details sit above a single,
		     prominent "View file" button sized to its own content (not a
		     fraction of the viewport). No separate Cancel button — the
		     header ✕ (and backdrop click / Escape) is the only way to
		     dismiss without opening, handled by Modal's dismissible logic. -->
		<div class="flex flex-col gap-5 py-2">
			<div class="flex flex-col items-center gap-3 text-center">
				<div class="flex h-12 w-12 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/40 text-2xl">
					✓
				</div>
				<p class="text-sm font-medium text-gray-900 dark:text-white">File opened.</p>
				<p class="text-xs text-gray-500 dark:text-gray-400">
					{openedDoc.name} · {formatBytes(decodedByteSize(openedDoc))}
				</p>

				<button
					onclick={() => (showFileInfo = !showFileInfo)}
					class="text-xs font-medium text-blue-700 transition-colors hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
				>
					More options
				</button>

				{#if showFileInfo}
					<button
						onclick={downloadDecoded}
						class="rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 dark:bg-slate-800 dark:text-gray-200 dark:hover:bg-slate-700"
					>
						Download file
					</button>
				{/if}
			</div>

			<button
				onclick={viewFile}
				class="flex items-center justify-center rounded-xl bg-blue-700 py-4 text-base font-semibold text-white transition-colors hover:bg-blue-600"
			>
				View file
			</button>
		</div>
	{/if}
</Modal>
