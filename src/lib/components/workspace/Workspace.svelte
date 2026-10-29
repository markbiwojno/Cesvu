<script lang="ts">
	import { onMount } from 'svelte';
	import { workspace } from '$lib/stores/workspace.svelte.js';
	import { offlineReady } from '$lib/stores/offlineReady.svelte.js';
	import DocumentPane from './DocumentPane.svelte';
	import ChatPane from './ChatPane.svelte';
	import NotesPane from '$lib/components/lenses/NotesPane.svelte';
	import ModelSelector from '$lib/components/ui/ModelSelector.svelte';
	import ThemeToggle from '$lib/components/ui/ThemeToggle.svelte';
	import { mode } from 'mode-watcher';
	import { DEFAULT_MODELS } from '$lib/stores/workspace.svelte.js';
	import { notesStore } from '$lib/stores/notesStore.svelte.js';
	import ExportModal from '$lib/components/ExportModal.svelte';
	import type { ParsedFile } from '$lib/types.js';
	import { dropContainsDirectory } from '$lib/utils/drag-drop.js';
	import { isCesvuZip } from '$lib/utils/is-cesvu-zip.js';
	import { parsedFileToDocumentInit } from '$lib/utils/parsed-file-to-document.js';






	/**
	 * Contract lens = a focused, LLM-free reading + note-taking experience.
	 * When active we hide the template picker, model selector, and the Chat
	 * tab (all of which would trigger a model download), and render the
	 * Notes pane on the right instead of Chat/Notes.
	 */
	const isContract = $derived(workspace.effectiveLens === 'contract');

	/**
	 * Tabular file = CSV or Excel. For these, the right pane keeps the
	 * Chat/Notes toggle: ChatPane is the base layer so users can run LLM
	 * filter/aggregate/sort queries, and Notes fully REPLACES it (same
	 * clean swap as the document lens) via the sheet's own "Notes" button
	 * or the header's Notes tab.
	 */
	const isTabularFile = $derived(
		workspace.file?.type === 'csv' || workspace.file?.type === 'excel'
	);

	/**
	 * Keep the notes store bound to whichever DOCUMENT is active — NOT the lens.
	 * Notes belong to the CesvuDocument (cell notes in the tabular/document
	 * lens, prose notes in the contract lens), so binding must follow the
	 * document id, never `isContract`. Gating this on the lens meant toggling
	 * contract ⇄ document re-fired the effect and re-bound (clearing + reloading)
	 * the note list — which is what made notes vanish on a lens switch. Now the
	 * effect only tracks `activeContractId`, and bindDocument() is idempotent on
	 * an unchanged id, so lens toggles leave the notes untouched.
	 */
	$effect(() => {
		const id = workspace.activeContractId;
		// bindDocument() is idempotent on an unchanged id and async (it loads
		// persisted notes from IndexedDB) — await it before deciding whether to
		// auto-open the Notes pane below, otherwise notesStore.count would still
		// read the PREVIOUS document's (possibly zero) count.
		//
		// `wasRestored` (see bindDocument()'s doc comment in notesStore.svelte.ts)
		// is true ONLY when this call actually loaded notes from a PERSISTED
		// record — i.e. a genuine "reopening an existing annotated document"
		// event. It is false both for a brand-new/empty document AND for the
		// MIGRATE case: the first time a user clicks Share/Export on a document
		// they've been actively working on all session, beginContract() persists
		// it for the first time and activeContractId flips from null to a real
		// id — but that is NOT a "reopen," it's "the user is exporting whatever
		// they're currently looking at." Passing this through to
		// autoOpenNotesIfAny lets it distinguish the two (see its doc comment).
		notesStore.bindDocument(id).then((wasRestored) => {
			autoOpenNotesIfAny(id, wasRestored);
		});
	});

	/**
	 * Auto-switch the right pane to Notes the moment a PREVIOUSLY-SAVED
	 * document's notes are restored from storage — so returning to a
	 * previously-annotated file doesn't require an extra click to see them.
	 * Fires (at most) once per document id: `autoOpenedDocIds` remembers which
	 * ids we've already acted on, so it never fights a later manual click back
	 * to Chat for the SAME document (bindDocument's own id-unchanged guard
	 * would otherwise cause this effect to re-run on unrelated re-renders).
	 *
	 * `wasRestored` GATES THE WHOLE FUNCTION — not just the lens override
	 * below. Originally this ran whenever `notesStore.count > 0`, regardless
	 * of WHY activeContractId just became non-null. That was wrong: clicking
	 * Share/Export on a document being actively edited ALSO flips
	 * activeContractId from null to a real id (beginContract() persisting it
	 * for the very first time), which would spuriously re-trigger this
	 * "just reopened a document" behavior — e.g. forcibly opening the Notes
	 * pane / overriding the lens right as the user clicks Share, with notes
	 * that were never actually "reopened" at all, just already on-screen.
	 * Requiring wasRestored === true (see bindDocument()'s doc comment)
	 * confines this entirely to the real "reopening an existing annotated
	 * document" case.
	 *
	 * ── Default lens follows the LAST (most recently created) note's
	 *    createdInLens ──────────────────────────────────────────────────────
	 * Alongside opening the Notes pane, this ALSO defaults which lens
	 * (contract vs. document) the document opens in, based on wherever the
	 * user was working when they dropped their LAST note. NOTE: notesStore
	 * sorts by CREATION ORDER (oldest first) — see sortByAnchor()'s doc
	 * comment in notesStore.svelte.ts, which deliberately chose creation
	 * order so note numbering matches the order the user actually made them.
	 * `.at(-1)` here means "whichever note this user created MOST RECENTLY
	 * on this document" (i.e. note count N of N, not note 1).
	 *
	 * Rationale: the most recent note is the strongest signal of what the
	 * user was doing right before they last left this document. A user who
	 * started annotating in the document lens but spent their final notes in
	 * the contract lens (exact clause highlighting) almost certainly wants
	 * to land back in the contract lens next time — the FIRST note they ever
	 * made could reflect a brief initial look in a lens they've since moved
	 * away from entirely. The most recent note's lens is therefore a better
	 * proxy for "where the user actually left off" than the first one, and
	 * both are stronger evidence of intent than detectLens()'s automatic
	 * content-scoring heuristic, so it's allowed to override
	 * workspace.detectedLens here via the SAME setLensOverride() the
	 * toolbar's manual "Lens" dropdown uses — meaning the dropdown will
	 * correctly show the forced lens selected, not silently diverge from
	 * "Auto" while behaving otherwise.
	 *
	 * `createdInLens` is ONLY ever recorded for PDF notes (see its doc comment
	 * in notesStore.svelte.ts — ClauseHighlighter.svelte passes 'contract',
	 * PdfViewer.svelte passes 'document'). DocumentHighlighter.svelte (the
	 * DOCX/TXT/MD document-lens surface) never sets it, since both lenses
	 * render those file types identically with no positional drift to track.
	 * So for non-PDF documents, or when the last note predates this field,
	 * `lastNoteLens` is undefined and this is a deliberate no-op — the
	 * existing content-based auto-detection (detectLens, set via
	 * workspace.setLens) is left as the sole decider, exactly as before this
	 * behavior was added.
	 *
	 * IMPORTANT — the lens override below is DELIBERATELY NOT gated by
	 * `autoOpenedDocIds`. That set only limits the "auto-open Notes pane"
	 * side-effect to once per document id per session; the lens-override
	 * computation runs on EVERY genuine reopen (every `wasRestored === true`
	 * call), always from whatever the note list looks like AT THAT MOMENT.
	 * This matters because the set of notes — and therefore which one is
	 * "last" — can change BETWEEN reopens of the same document within one
	 * session (the user deletes/adds notes, closes, reopens again). If the
	 * override were gated by `autoOpenedDocIds` too, only the FIRST reopen
	 * this session would ever get a correct lens; every later reopen would
	 * silently keep whichever lens detectLens()'s content heuristic guesses,
	 * ignoring however the notes have since changed (this was a real bug:
	 * delete the last-created note, reopen, and the lens stayed wrong because
	 * the override computation never even ran). Deliberately NOT reactive to
	 * edits made WHILE the document stays open, though — this only
	 * recomputes at the reopen boundary (`wasRestored` fires exactly once
	 * per `bindDocument()` call that restores from storage), not on every
	 * add/edit/delete during an active session, so it never yanks the lens
	 * out from under a user who is mid-annotation.
	 */
	const autoOpenedDocIds = new Set<string>();
	function autoOpenNotesIfAny(id: string | null, wasRestored: boolean) {
		if (!id || !wasRestored) return;

		// Recomputed on every genuine reopen (see the IMPORTANT note above) —
		// LAST note in CREATION ORDER (most recently created, not document/
		// anchor position; see the doc comment above for why this drives the
		// default lens).
		const lastNoteLens = notesStore.notes.at(-1)?.createdInLens;
		if (lastNoteLens) {
			workspace.setLensOverride(lastNoteLens);
		}

		// Auto-open Notes pane: fires at MOST once per document id, for the
		// life of this session, so it never fights a user who later manually
		// switches back to Chat for the SAME document.
		if (autoOpenedDocIds.has(id)) return;
		autoOpenedDocIds.add(id);
		if (notesStore.count > 0) {
			workspace.openNotesPane();
		}
	}






	// ============================================================
	// Resize state
	// ============================================================
	const STORAGE_KEY = 'cesvu-split-pct';
	const MIN_PCT = 30;
	const MAX_PCT = 70;

	let leftPct = $state(60);
	let isDragging = $state(false);
	let containerEl = $state<HTMLDivElement | null>(null);

	// ============================================================
	// .cesvu drag-and-drop (workspace-wide)
	//
	// The landing FileDropzone only exists before a document is open. To let a
	// recipient drop a shared .cesvu onto the app at ANY time, the whole
	// workspace shell is a drop target. A dashed overlay appears while a file is
	// dragged over it; dropping a .cesvu hands it to DocumentPane's unlock flow
	// via the store (workspace.requestImport). Non-.cesvu drops are ignored here
	// (the FileDropzone owns ordinary uploads on the landing page).
	//
	// dragCounter tracks enter/leave on nested children so the overlay doesn't
	// flicker when the cursor crosses an inner element boundary.
	// ============================================================
	let isFileDragging = $state(false);
	let dragCounter = 0;

	/** Does this drag carry files (vs. text / the split-handle drag)? */
	function dragHasFiles(e: DragEvent): boolean {
		return Array.from(e.dataTransfer?.types ?? []).includes('Files');
	}

	function onDragEnter(e: DragEvent) {
		if (!dragHasFiles(e)) return;
		e.preventDefault();
		dragCounter++;
		isFileDragging = true;
	}

	function onDragOver(e: DragEvent) {
		if (!dragHasFiles(e)) return;
		// Allow the drop by preventing the default "no drop" cursor.
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}

	function onDragLeave(e: DragEvent) {
		if (!dragHasFiles(e)) return;
		dragCounter--;
		if (dragCounter <= 0) {
			dragCounter = 0;
			isFileDragging = false;
		}
	}

	async function onDrop(e: DragEvent) {
		if (!dragHasFiles(e)) return;
		e.preventDefault();
		dragCounter = 0;
		isFileDragging = false;
		// A dropped FOLDER hands back a synthetic zero-byte File (see
		// drag-drop.ts's doc comment). Reject it here with a toast instead
		// of letting it sail through as a bogus "file".
		if (dropContainsDirectory(e)) {
			workspace.showToast(
				"Folders can't be opened — drop an individual file instead.",
				3500
			);
			return;
		}

		const file = e.dataTransfer?.files?.[0];
		if (!file) return;

		// Cesvu export archives route to the open flow. Detected by content,
		// not the `_cesvu.zip` suffix — browsers rename repeat downloads.
		if (await isCesvuZip(file)) {
			workspace.requestImport(file);
		}
	}



	/**
	 * Warn before a refresh / tab close when there's in-progress work. Documents
	 * now live only in memory (see contract-store.svelte.ts — in-memory by
	 * design), so a reload wipes everything that hasn't been exported to a
	 * `_cesvu.zip` archive. We only prompt when there's something to lose (a file is open
	 * or notes exist); an empty workspace reloads silently. The custom string is
	 * shown by older browsers; modern ones display their own generic message, so
	 * we set both `returnValue` and the return value for maximum compatibility.
	 *
	 */
	function onBeforeUnload(e: BeforeUnloadEvent) {
		if (workspace.hasFile || notesStore.count > 0) {
			e.preventDefault();
			e.returnValue = 'Your in progress work will be lost';
			return 'Your in progress work will be lost';
		}
	}


	onMount(() => {
		// Restore pending model from sessionStorage (set before model-switch reload)
		workspace.initFromSession();

		const saved = localStorage.getItem(STORAGE_KEY);
		if (saved) {
			const n = parseFloat(saved);
			if (n >= MIN_PCT && n <= MAX_PCT) leftPct = n;
		}

		window.addEventListener('beforeunload', onBeforeUnload);

		// Fixed-position dropdown panels (Template/Model) are anchored to a
		// snapshot of the trigger button's rect taken at open-time — they do
		// NOT live-track the button, so a scroll or viewport resize while one
		// is open would leave it visually orphaned from its trigger. Closing
		// on either event matches standard dropdown/menu behavior elsewhere
		// in the browser platform (e.g. native <select>, most UI libraries).
		window.addEventListener('scroll', closeFloatingPanels, true);
		window.addEventListener('resize', closeFloatingPanels);

		return () => {
			window.removeEventListener('beforeunload', onBeforeUnload);
			window.removeEventListener('scroll', closeFloatingPanels, true);
			window.removeEventListener('resize', closeFloatingPanels);
		};
	});



	function startDrag(e: MouseEvent | TouchEvent) {
		e.preventDefault();
		isDragging = true;

		function onMove(ev: MouseEvent | TouchEvent) {
			if (!containerEl) return;
			const rect = containerEl.getBoundingClientRect();
			const clientX = 'touches' in ev ? ev.touches[0].clientX : ev.clientX;
			const pct = ((clientX - rect.left) / rect.width) * 100;
			leftPct = Math.min(MAX_PCT, Math.max(MIN_PCT, pct));
		}

		function onUp() {
			isDragging = false;
			localStorage.setItem(STORAGE_KEY, String(leftPct));
			window.removeEventListener('mousemove', onMove as EventListener);
			window.removeEventListener('mouseup', onUp);
			window.removeEventListener('touchmove', onMove as EventListener);
			window.removeEventListener('touchend', onUp);
		}

		window.addEventListener('mousemove', onMove as EventListener);
		window.addEventListener('mouseup', onUp);
		window.addEventListener('touchmove', onMove as EventListener, { passive: false });
		window.addEventListener('touchend', onUp);
	}

	/**
	 * Keyboard resizing for the split handle (a11y). `role="separator"` with a
	 * tabindex is only operable if arrow keys move it — otherwise keyboard users
	 * can focus the handle but never resize. ArrowLeft/Right nudge by 2% (Shift
	 * for 10%), Home/End jump to the min/max. Each change is persisted, matching
	 * the mouse/touch onUp behavior.
	 */
	function onHandleKeydown(e: KeyboardEvent) {
		const step = e.shiftKey ? 10 : 2;
		let next = leftPct;
		switch (e.key) {
			case 'ArrowLeft':
			case 'ArrowDown':
				next = leftPct - step;
				break;
			case 'ArrowRight':
			case 'ArrowUp':
				next = leftPct + step;
				break;
			case 'Home':
				next = MIN_PCT;
				break;
			case 'End':
				next = MAX_PCT;
				break;
			default:
				return; // ignore other keys
		}
		e.preventDefault();
		leftPct = Math.min(MAX_PCT, Math.max(MIN_PCT, next));
		localStorage.setItem(STORAGE_KEY, String(leftPct));
	}


	// ============================================================
	// Step labels
	// ============================================================
	const stepLabels: Record<string, string> = {
		upload: 'Upload',
		'template-select': 'Template',
		analyzing: 'Analyzing',
		results: 'Results'
	};
	const stepOrder = ['upload', 'template-select'];

	// ============================================================
	// Model panel toggle
	//
	// This panel renders via `position: fixed` (see the template below),
	// anchored to the trigger button's live bounding rect rather than via
	// `position: absolute` inside the header. The header has `overflow-x-auto`
	// for mobile horizontal scrolling, and per the CSS overflow spec, setting
	// overflow-x to anything but `visible` forces the browser to COMPUTE
	// overflow-y as `auto` too — even if you explicitly write
	// `overflow-y: visible` in the stylesheet, the computed value still comes
	// out `auto` for the y-axis. That silently clips any `absolute` child that
	// extends below the header's own bottom edge, which is exactly what these
	// dropdowns did (they pop up via `top-full`). z-index cannot rescue you
	// from an ancestor's overflow clip. `position: fixed` positioned via
	// getBoundingClientRect() escapes this entirely, since fixed-position
	// elements are laid out against the viewport (or the nearest
	// transformed/will-change ancestor, of which there is none here) and are
	// NOT affected by an ancestor's `overflow` at all.
	// ============================================================
	let showModelPanel = $state(false);
	let modelPanelPos = $state({ top: 0, right: 0 });
	let modelBtnEl = $state<HTMLButtonElement | null>(null);

	/** Compute {top, right} (in px, right measured from viewport's right edge)
	 *  for a fixed-position panel anchored just below-and-right-aligned to `el`. */
	function computeAnchorPos(el: HTMLElement | null): { top: number; right: number } {
		if (!el) return { top: 0, right: 0 };
		const rect = el.getBoundingClientRect();
		return {
			top: rect.bottom + 4,
			right: window.innerWidth - rect.right
		};
	}

	function toggleModelPanel() {
		if (!showModelPanel) modelPanelPos = computeAnchorPos(modelBtnEl);
		showModelPanel = !showModelPanel;
	}

	// Fixed-position panels don't automatically track the anchor when the
	// page scrolls or the viewport resizes (unlike absolute-in-flow
	// children). Simplest, most robust behavior — matching how most
	// dropdown/menu libraries handle this — is to just close the panel
	// rather than try to keep repositioning it live.
	function closeFloatingPanels() {
		showModelPanel = false;
	}

	function handleModelSelect(id: string) {
		const m = DEFAULT_MODELS.find(m => m.id === id);
		if (m) { workspace.setModel(m); showModelPanel = false; }
	}


	// ============================================================
	// Share (.cesvu export)
	//
	// The Export button is available whenever a file is open. A CesvuDocument
	// is only persisted to IndexedDB on demand (beginContract isn't part of the
	// normal upload flow), so the click handler creates the record first, then
	// opens the modal. A persistence failure (private mode / quota) surfaces as
	// a toast instead of a silently-missing button.
	// ============================================================
	let showExport = $state(false);
	let preparingExport = $state(false);

	/** A file is open → the Share button is visible at all. */
	const canExport = $derived(workspace.hasFile);
	/** Green/enabled only once the user has added at least one note — an
	 *  export with no annotations has nothing worth sharing yet. Mirrors the
	 *  former "Send Back" button's ready-gate. */
	const shareReady = $derived(notesStore.count > 0);

	/**
	 * Open the Export flow. Ensures a persisted CesvuDocument exists first
	 * (beginContract is best-effort and swallows IndexedDB errors), then shows
	 * the modal. If persistence fails we tell the user rather than no-op.
	 *
	 * The text/sourceType/rawContent mapping lives in
	 * parsed-file-to-document.ts's `parsedFileToDocumentInit` — shared with
	 * ImportModal.svelte's "Choose a file to send back" path, which needs the
	 * exact same ParsedFile → CesvuDocument-init mapping for viewer-supported
	 * reply files.
	 */
	async function openExport() {
		if (!shareReady) return;
		const f = workspace.file;
		if (!f) return;
		if (!workspace.activeContractId) {
			preparingExport = true;
			try {
				const init = parsedFileToDocumentInit(f);
				await workspace.beginContract(init.text, {
					name: f.name,
					sourceType: init.sourceType,
					// Carry the original bytes so the recipient re-parses the REAL
					// PDF / XLSX / CSV — not a lossy text flattening.
					rawContent: init.rawContent

				});
			} finally {
				preparingExport = false;
			}
		}

		// beginContract() just created a BLANK record. Any analysis the user ran
		// before this point called persistProfile() while activeContractId was
		// still null — a no-op — so the live profile (parties / key dates / risks)
		// never reached the record. Flush it now, before the export reads it.
		// (Notes migrate themselves via notesStore.bindDocument's null→real path.)
		if (workspace.activeContractId && workspace.contractProfile) {
			workspace.persistProfile(workspace.contractProfile);
		}

		if (workspace.activeContractId) {
			showExport = true;

		} else {
			workspace.showToast("Couldn't prepare this file for sharing. Try a normal browser window.");
		}
	}
</script>




<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="flex flex-col h-screen h-dvh bg-surface dark:bg-slate-950 overflow-hidden relative"

	ondragenter={onDragEnter}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
>

	<!-- .cesvu drop overlay — dashed border + prompt while a file is dragged
	     over the workspace. Purely visual; pointer-events-none so it never
	     swallows the drop event (which the container handles). -->
	{#if isFileDragging}
		<div
			class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-surface/80 dark:bg-slate-950/80 backdrop-blur-sm"
		>
			<div class="m-4 flex h-[calc(100%-2rem)] w-[calc(100%-2rem)] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-blue-500 bg-blue-950/20">
				<span class="text-4xl" aria-hidden="true">📄</span>
				<p class="text-lg font-semibold text-blue-200">Drop .cesvu file</p>
				<p class="text-xs text-blue-300/70">Open a shared document</p>
			</div>
		</div>
	{/if}



	<!-- ============================================================ -->
	<!-- TOP BAR -->
	<!-- ============================================================ -->

	<!-- overflow-x-auto: on narrow/mobile screens the header's contents
	     (logo, steps, offline badge, template/model/analyze, tabs, export)
	     overflow the flex row before any of it can wrap — without this, that
	     overflow is invisible/clipped and buttons like Export become
	     unreachable. Scrolling horizontally keeps every control reachable
	     without changing desktop layout (content already fits there). -->
	<header class="flex items-center gap-3 px-4 py-2.5 border-b border-gray-200 dark:border-slate-950 bg-surface dark:bg-slate-900 flex-shrink-0 z-20 overflow-x-auto">

		<!-- App logo. /cesvu_logo.svg is a white wordmark (for the dark
		     header); /cesvu_logo_dark.svg is the same mark in dark ink (for
		     the light header). Swapped based on the live mode so the logo
		     always has contrast against the header background. -->
		<a href="/" class="flex-shrink-0" aria-label="Cesvu home">
			<img
				src={$mode === 'dark' ? '/cesvu_logo.svg' : '/cesvu_logo_dark.svg'}
				alt="Cesvu"
				class="h-10 w-auto"
			/>
		</a>

		<!-- Step indicator -->
		<div class="flex items-center gap-1 flex-shrink-0">
			{#each stepOrder as s, i}
				<div class="flex items-center gap-1">
					<span class="text-xs px-2 py-0.5 rounded-full transition-colors
						{workspace.step === s
							? 'bg-blue-700 text-white font-medium'
							: stepOrder.indexOf(workspace.step) > i
								? 'text-green-600 dark:text-green-400'
							: 'text-gray-500 dark:text-gray-400'}">
						{stepLabels[s]}
					</span>
					{#if i < stepOrder.length - 1}
						<span class="text-gray-300 dark:text-gray-700 text-xs">›</span>
					{/if}
				</div>
			{/each}
		</div>

		<!-- Offline-readiness indicator. Tells the user the moment it's safe to
		     disconnect WiFi, instead of leaving them to guess based on whether
		     they'd previously opened a file online (see offlineReady.svelte.ts —
		     this flips to 'ready' once the service worker has finished
		     precaching the full app shell). -->
		<div
			class="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 transition-colors
				{offlineReady.state === 'ready'
					? 'text-green-600 dark:text-green-400'
					: 'text-amber-600 dark:text-amber-400'}"
			title={offlineReady.state === 'ready'
				? 'The app shell is fully cached — safe to disconnect from the internet.'
				: 'Preparing offline mode — keep the internet connected until this is ready.'}
		>
			{#if offlineReady.state === 'ready'}
				<span class="h-1.5 w-1.5 rounded-full bg-green-600 dark:bg-green-400" aria-hidden="true"></span>
				<span>Ready to work offline</span>
			{:else}
				<span class="h-2.5 w-2.5 rounded-full border-2 border-amber-600 dark:border-amber-400 border-t-transparent dark:border-t-transparent animate-spin" aria-hidden="true"></span>
				<span>Preparing offline mode…</span>
			{/if}
		</div>

		<div class="flex-1"></div>

		<!-- Light/dark mode toggle. Persists to localStorage via mode-watcher. -->
		<ThemeToggle />

		<!-- Model selector button (when file loaded).
		     Hidden in contract mode — contracts use the LLM-free Notes flow, so
		     the model selector (which would kick off a ~900MB model download)
		     is suppressed. -->
		{#if workspace.hasFile && !isContract}
			<!-- Model selector button -->
			<div class="relative">
				<button
					bind:this={modelBtnEl}
					onclick={toggleModelPanel}
					class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-xs font-medium text-gray-700 dark:text-gray-300 transition-colors"
				>
					<span>{workspace.selectedModel.name}</span>
					<span class="text-gray-400 dark:text-gray-600">▾</span>
				</button>
			</div>

		{/if}


		<!-- Tab switcher. In contract mode the right pane is always Notes (no
		     Chat/Notes LLM tabs), so we show a single static "Notes" label
		     instead of the toggle.

		     For tabular files (CSV/Excel) the SAME Chat/Notes toggle is shown
		     — "Chat" is the deterministic query/workbench surface, "Notes"
		     fully replaces it with the cell-anchored NotesPane (see the
		     right-pane routing below). -->
		{#if isContract}
			<div class="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-gray-100 dark:bg-slate-800 text-xs font-medium text-gray-700 dark:text-gray-300 flex-shrink-0">
				<span>📝</span>
				<span>Notes {notesStore.count > 0 ? `(${notesStore.count})` : ''}</span>
			</div>
		{:else}
			<!-- Chat/Notes toggle — shared by the document lens (PDF/DOCX/TXT/MD)
			     AND the tabular workbench (CSV/Excel), so users can run LLM filter
			     queries against their rows.

			     "Notes" is driven by workspace.openPane (kind='notes') rather than
			     activeTab — the SAME single-slot mechanism the document lens's
			     pin-click/toolbar and the tabular sheet's own Notes button already
			     use, so all three entry points (header tab, document pin, sheet
			     toolbar) stay in sync automatically. Clicking "Chat" closes the
			     Notes pane/popover and switches back to the chat view. -->
			<div class="flex rounded-lg bg-gray-100 dark:bg-slate-800 p-0.5 flex-shrink-0">
				<button
					onclick={() => { workspace.closeOpenPane(); workspace.setActiveTab('chat'); }}
					class="px-3 py-1 rounded-md text-xs font-medium transition-colors
						{workspace.openPane?.kind !== 'notes' && workspace.activeTab === 'chat' ? 'bg-white text-gray-900 shadow-sm dark:bg-slate-700 dark:text-white dark:shadow-none' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}"
				>
					Chat {workspace.messageCount > 0 ? `(${workspace.messageCount})` : ''}
				</button>
				<button
					onclick={() => workspace.openNotesPane()}
					class="px-3 py-1 rounded-md text-xs font-medium transition-colors
						{workspace.openPane?.kind === 'notes' ? 'bg-white text-gray-900 shadow-sm dark:bg-slate-700 dark:text-white dark:shadow-none' : 'text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'}"
				>
					Notes {notesStore.count > 0 ? `(${notesStore.count})` : ''}
				</button>
			</div>

		{/if}

		<!-- Share (.cesvu export). Import lives on the upload/landing page.
		     Greyed out/disabled until the user has added at least one note;
		     turns blue/enabled the instant one exists. -->
		{#if canExport}
			<div class="flex items-center gap-1.5 flex-shrink-0">
				<button
					onclick={openExport}
					disabled={preparingExport || !shareReady}
					title={shareReady ? 'Share this document' : 'Add a note to enable Share'}
					class="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:cursor-not-allowed
						{shareReady
							? 'bg-blue-700 hover:bg-blue-600 text-white'
							: 'bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-gray-500 opacity-50'}"
				>
				{preparingExport ? 'Preparing…' : 'Share'}
				</button>

			</div>
		{/if}

	</header>

	<!-- Fixed-position Model dropdown panel — rendered OUTSIDE the
	     header so it is never subject to the header's overflow-x-auto
	     (which forces overflow-y to compute as `auto`, clipping anything
	     that would otherwise pop below the header). Positioned via
	     getBoundingClientRect() of the trigger button, captured at
	     open-time (see toggleModelPanel + the
	     scroll/resize close listeners in onMount). z-50 keeps it above
	     the document pane/viewer without needing to fight any ancestor's
	     stacking or clipping context. -->
	{#if showModelPanel}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="fixed w-80 max-w-[calc(100vw-2rem)] bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl z-50 p-3"
			style="top: {modelPanelPos.top}px; right: {modelPanelPos.right}px;"
			onmouseleave={() => (showModelPanel = false)}
		>
			<ModelSelector
				models={DEFAULT_MODELS}
				selected={workspace.selectedModel.id}
				onSelect={handleModelSelect}
			/>
		</div>
	{/if}


	<!-- ============================================================ -->
	<!-- SPLIT PANES -->
	<!-- ============================================================ -->
	<!-- flex-col sm:flex-row: below the `sm` breakpoint the document pane and
	     the right pane (Notes/Dashboard/Chat) STACK vertically instead of
	     squeezing into two narrow side-by-side columns — a 60/40 (or
	     resized) horizontal split is unreadable on a phone-width screen. The
	     desktop side-by-side split (with the draggable handle) is unchanged
	     at sm and above. -->
	<div
		bind:this={containerEl}
		class="flex-1 flex flex-col sm:flex-row overflow-hidden min-h-0"
		class:select-none={isDragging}
	>
		<!-- LEFT: Document pane. Full width before a file is uploaded so the
		     FileDropzone owns the viewport with no right panel competing.
		     Below `sm`, height is a fixed share of the viewport (h-[45vh]) so
		     the right pane below it still gets usable space; the drag-resize
		     `leftPct` only applies to the desktop width (sm:w-[...]). -->
		<!-- Contract lens gets FULL height on mobile too: it manages its own
		     internal split (reading surface + collapsible bottom sheet for
		     clauses/notes), so boxing it into the generic h-[45vh] cap (meant
		     for the csv/document + chat stacked layout) left almost no room for
		     both the document text AND the mobile clause sheet's handle to
		     coexist — the expanded sheet swallowed the entire 45vh box. -->
		<div
			class="w-full sm:w-[var(--left-pct)] flex-shrink-0 overflow-hidden border-r border-b sm:border-b-0 border-gray-200 dark:border-slate-800 {isContract ? 'h-full' : 'h-[45dvh] sm:h-auto'}"
			style="--left-pct: {workspace.hasFile ? leftPct : 100}%"
		>
			<DocumentPane />
		</div>



		<!-- RESIZE HANDLE — desktop-only (hidden below `sm`): the horizontal
		     drag-to-resize handle has no meaning once the panes are stacked
		     vertically on mobile. Only shown once a file is loaded (the pane
		     is hidden before that, so a handle would be a dangling
		     affordance). -->
		{#if workspace.hasFile}

			<div
				class="hidden sm:block flex-shrink-0 w-1 cursor-col-resize hover:bg-blue-600 active:bg-blue-500 transition-colors relative group z-10
					{isDragging ? 'bg-blue-500' : 'bg-gray-200 dark:bg-slate-800'}"
				onmousedown={startDrag}
				ontouchstart={startDrag}
				onkeydown={onHandleKeydown}
				role="separator"
				aria-label="Resize panels"
				aria-orientation="vertical"
				aria-valuemin={MIN_PCT}
				aria-valuemax={MAX_PCT}
				aria-valuenow={Math.round(leftPct)}
				tabindex="0"
			>
				<!-- Wider hit area -->
				<div class="absolute inset-y-0 -left-1.5 -right-1.5"></div>
			</div>
		{/if}


		<!-- RIGHT: Notes (contract) / Chat/Notes (tabular + other).
		     Hidden entirely before upload so the user never sees the
		     "upload file to start chatting" prompt — the left pane is the
		     only thing on screen until they drop a file.

		     Routing order:
		       1. contract lens   → NotesPane  (LLM-free reading + notes)
		       2. tabular file    → ChatPane, with NotesPane REPLACING it when
		                            open (same clean swap as the document lens
		                            below)
		       3. otherwise       → ChatPane / NotesPane (Chat/Notes tab toggle) -->
		<!-- Right pane: contract notes (always on), tabular Chat⇄Notes swap,
		     or document-lens Chat⇄Notes swap. Notes, for both tabular and
		     document lenses, fully REPLACES ChatPane in the same flex slot
		     instead of floating over it. -->
		<!-- On mobile (below lg), the contract lens's own DocumentPane already
		     renders its own clause/notes UI (desktop ClauseSidebar column OR the
		     mobile bottom sheet) — it doesn't need this SEPARATE right pane too.
		     With flex-col stacking below `sm`, showing this outer NotesPane
		     underneath the now-full-height DocumentPane doubled up the Notes UI
		     and pushed the doc's own close (✕) button and reading surface off
		     screen. `hidden lg:flex` keeps this pane desktop-only for the
		     contract lens; other lenses (tabular/document) still show it at all
		     sizes as before. -->
		{#if workspace.hasFile || isContract}
			<div class="{isContract ? 'hidden lg:flex' : 'flex'} flex-1 overflow-hidden min-w-0 relative">



				{#if isContract}
					<NotesPane />
				{:else if isTabularFile}
					<!-- Tabular (CSV/Excel): the LLM chat is the right-pane base
					     layer so users can run filter / aggregate / sort queries
					     against their rows (ChatPane builds a queryContext for
					     csv + excel). Notes REPLACES ChatPane entirely (same
					     clean full-width swap as the document lens below) when
					     open. -->
					{#if workspace.openPane?.kind === 'notes'}
						<NotesPane />
					{:else}
						<ChatPane />
					{/if}
				{:else}

					<!-- Document lens (PDF / DOCX / TXT / MD). When the user drops or
					     clicks a note pin (PdfViewer / DocumentHighlighter call
					     workspace.openNotesPane()), the Notes pane REPLACES Chat
					     entirely — same <NotesPane /> in the same full-width slot as the
					     contract lens, so the two look identical. The chat is hidden (not
					     squeezed by a side popover); the header Chat/Notes tabs bring
					     it back (they call closeOpenPane()). -->
					{#if workspace.openPane?.kind === 'notes'}
						<NotesPane />
					{:else}
						<ChatPane />
					{/if}
				{/if}

			</div>
		{/if}


	</div>
</div>

<!-- Share modal -->
{#if showExport && workspace.activeContractId}
	<ExportModal
		documentId={workspace.activeContractId}
		openedFromCesvu={workspace.openedFromCesvu}
		onclose={() => (showExport = false)}
	/>

{/if}



