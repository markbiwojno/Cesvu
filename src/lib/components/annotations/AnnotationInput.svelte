<!--
  AnnotationInput.svelte — Create or edit an annotation.

  Shown as a floating popover anchored to the selected text.
  Reads pendingSelection from annotationStore.
  Calls annotationStore.addAnnotation() on submit.
  Calls annotationStore.cancelCreate() on cancel.

  Props:
    userTier    — 'free' | 'pro' (free users see upgrade prompt instead of form)
    authorName  — Pre-filled author name (from localStorage or user profile)
    onSaved     — Called after annotation is saved (so parent can re-render)
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { annotationStore } from '$lib/stores/annotations.svelte.js';
	import type { Annotation } from '$lib/types.js';

	interface Props {
		userTier?: 'free' | 'pro';
		authorName?: string;
		onSaved?: (annotation: Annotation) => void;
	}

	let {
		userTier = 'free',
		authorName = '',
		onSaved
	}: Props = $props();

	// ── Form state ────────────────────────────────────────────────────────────
	let body = $state('');
	let author = $state(untrack(() => authorName) || loadSavedAuthor());

	// Keep `author` in sync when the parent passes a NEW authorName (e.g. the
	// user switches documents). `$state(...)` only evaluates its initializer
	// once, so without this the field would keep showing the first document's
	// name. We DON'T use `$derived` — `author` must stay user-editable; this
	// effect only overrides it when the incoming prop actually changes.
	let lastAuthorName = untrack(() => authorName);
	$effect(() => {
		if (authorName && authorName !== lastAuthorName) {
			author = authorName;
			lastAuthorName = authorName;
		}
	});

	let color = $state('#FFD700');
	let isSaving = $state(false);
	let error = $state('');

	const COLORS = [
		{ hex: '#FFD700', label: 'Yellow' },
		{ hex: '#86EFAC', label: 'Green' },
		{ hex: '#93C5FD', label: 'Blue' },
		{ hex: '#FCA5A5', label: 'Red' },
		{ hex: '#C4B5FD', label: 'Purple' },
		{ hex: '#FED7AA', label: 'Orange' }
	];

	let pendingSelection = $derived(annotationStore.pendingSelection);
	let isCreating = $derived(annotationStore.isCreating);

	// ── Persist author name ───────────────────────────────────────────────────
	function loadSavedAuthor(): string {
		if (typeof localStorage === 'undefined') return '';
		return localStorage.getItem('cesvu_annotation_author') ?? '';
	}

	function saveAuthor(name: string) {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem('cesvu_annotation_author', name);
		}
	}

	// ── Submit ────────────────────────────────────────────────────────────────
	async function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (!pendingSelection) return;
		if (!body.trim()) { error = 'Annotation text is required.'; return; }

		isSaving = true;
		error = '';

		try {
			const trimmedAuthor = author.trim() || 'Anonymous';
			saveAuthor(trimmedAuthor);

			const annotation = annotationStore.addAnnotation(
				pendingSelection,
				body.trim(),
				trimmedAuthor,
				color
			);

			annotationStore.cancelCreate();
			body = '';
			onSaved?.(annotation);
		} catch (e_) {
			error = String(e_);
		} finally {
			isSaving = false;
		}
	}

	function handleCancel() {
		annotationStore.cancelCreate();
		body = '';
		error = '';
	}

	// ── Keyboard shortcut: Cmd/Ctrl+Enter to submit ───────────────────────────
	function handleKeydown(e: KeyboardEvent) {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
			e.preventDefault();
			const form = (e.currentTarget as HTMLElement).closest('form');
			form?.requestSubmit();
		}
		// Guard against IME composition: pressing Escape to dismiss an IME
		// candidate window (CJK input) must NOT cancel the popover and lose the
		// in-progress text. `isComposing` is true while a composition is active.
		if (e.key === 'Escape' && !e.isComposing) {
			handleCancel();
		}
	}
</script>

{#if isCreating && pendingSelection}
	<!-- Backdrop (click to cancel) -->
	<div
		class="fixed inset-0 z-40"
		onclick={handleCancel}
		aria-hidden="true"
	></div>

	<!-- Popover panel -->
	<div
		class="fixed z-50 bottom-6 right-6 w-80 rounded-xl border border-slate-700 bg-slate-900
			   shadow-2xl shadow-black/60 overflow-hidden"
		role="dialog"
		aria-modal="true"
		aria-label="Add annotation"
	>
		<!-- Header -->
		<div class="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/80">
			<div class="flex items-center gap-2">
				<span class="text-sm font-semibold text-white">✏️ Add Annotation</span>
				{#if userTier === 'pro'}
					<span class="px-1.5 py-0.5 rounded bg-blue-900/50 border border-blue-800 text-blue-300 text-[10px] font-semibold">Pro</span>
				{/if}
			</div>
			<button
				onclick={handleCancel}
				class="text-gray-500 hover:text-gray-300 transition-colors text-lg leading-none"
				aria-label="Cancel annotation"
			>×</button>
		</div>

		{#if userTier !== 'pro'}
			<!-- Free tier upgrade prompt -->
			<div class="p-5 space-y-3 text-center">
				<div class="text-3xl">🔒</div>
				<p class="text-sm font-semibold text-white">Annotations are a Pro feature</p>
				<p class="text-xs text-gray-400">Upgrade to Pro to create and manage annotations on your documents.</p>
				<button
					onclick={handleCancel}
					class="w-full px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-sm font-semibold transition-colors"
				>
					Upgrade to Pro →
				</button>
				<button
					onclick={handleCancel}
					class="w-full px-4 py-1.5 rounded-lg text-gray-500 hover:text-gray-300 text-xs transition-colors"
				>
					Cancel
				</button>
			</div>
		{:else}
			<!-- Selected quote preview -->
			{#if pendingSelection.quote}
				<div class="px-4 py-2 bg-amber-950/30 border-b border-amber-900/40">
					<p class="text-xs text-amber-300/80 italic line-clamp-2">
						"{pendingSelection.quote.slice(0, 120)}{pendingSelection.quote.length > 120 ? '…' : ''}"
					</p>
				</div>
			{/if}

			<!-- Form -->
			<form onsubmit={handleSubmit} class="p-4 space-y-3">
				<!-- Annotation body -->
				<div>
					<label for="ann-body" class="block text-xs font-medium text-gray-400 mb-1">
						Note <span class="text-red-400">*</span>
					</label>
					<!-- svelte-ignore a11y_autofocus -->
					<textarea
						id="ann-body"
						bind:value={body}
						onkeydown={handleKeydown}
						placeholder="Add your note… (Markdown supported)"
						rows="3"
						autofocus
						class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700
							   text-sm text-gray-200 placeholder-gray-600
							   focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600
							   resize-none transition-colors"
						aria-required="true"
					></textarea>
					<p class="text-[10px] text-gray-600 mt-0.5">Cmd+Enter to save · Esc to cancel</p>
				</div>

				<!-- Author name -->
				<div>
					<label for="ann-author" class="block text-xs font-medium text-gray-400 mb-1">
						Your name
					</label>
					<input
						id="ann-author"
						type="text"
						bind:value={author}
						placeholder="Anonymous"
						class="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700
							   text-sm text-gray-200 placeholder-gray-600
							   focus:outline-none focus:border-blue-600 focus:ring-1 focus:ring-blue-600
							   transition-colors"
					/>
				</div>

				<!-- Color picker -->
				<div>
					<p class="text-xs font-medium text-gray-400 mb-1.5">Highlight color</p>
					<div class="flex gap-2">
						{#each COLORS as c}
							<button
								type="button"
								onclick={() => { color = c.hex; }}
								class="w-6 h-6 rounded-full border-2 transition-all duration-150
									   {color === c.hex ? 'border-white scale-110' : 'border-transparent hover:border-gray-500'}"
								style="background-color: {c.hex};"
								aria-label="Color: {c.label}"
								title={c.label}
							></button>
						{/each}
					</div>
				</div>

				<!-- Error -->
				{#if error}
					<p class="text-xs text-red-400 flex items-center gap-1">
						<span>⚠️</span> {error}
					</p>
				{/if}

				<!-- Actions -->
				<div class="flex gap-2 pt-1">
					<button
						type="submit"
						disabled={isSaving || !body.trim()}
						class="flex-1 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500
							   disabled:opacity-50 disabled:cursor-not-allowed
							   text-gray-900 text-sm font-semibold transition-colors"
					>
						{isSaving ? 'Saving…' : 'Save annotation'}
					</button>
					<button
						type="button"
						onclick={handleCancel}
						class="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700
							   text-gray-400 text-sm transition-colors"
					>
						Cancel
					</button>
				</div>
			</form>
		{/if}
	</div>
{/if}
