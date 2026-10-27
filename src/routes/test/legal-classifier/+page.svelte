<script lang="ts">
	/**
	 * Dev test harness for the legal clause classifier.
	 *
	 * classifyClause() runs Transformers.js inference in the BROWSER (WebGPU/WASM,
	 * Cache API) — it can't be exercised from a Node CLI. This page is how you
	 * verify it: run `pnpm dev`, open /test/legal-classifier, click "Classify".
	 *
	 * The default clause is the one from the task brief; expected result is
	 * label "Indemnification", risk "high", score 0.9+.
	 */
	import {
		classifyClause,
		loadLegalClassifier,
		type ClauseClassification,
		type LoadProgress
	} from '$lib/models/legal-classifier.js';
	import {
		detectLens,
		scoreContractSignals,
		isContractScore,
		CONTRACT_SCORE_THRESHOLD,
		type ContractScore,
		type Lens
	} from '$lib/lenses/detect-lens.js';

	let text = $state(
		'The Company shall indemnify and hold harmless the Contractor from any claims.'
	);
	let result = $state<ClauseClassification | null>(null);
	let progress = $state<LoadProgress | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);

	const riskColor: Record<string, string> = {
		high: '#dc2626',
		medium: '#d97706',
		low: '#16a34a'
	};

	async function run() {
		busy = true;
		error = null;
		result = null;
		try {
			// Kick the load with progress reporting (classifyClause would load it
			// silently too, but we want a progress bar on first run).
			await loadLegalClassifier((p) => (progress = p));
			result = await classifyClause(text);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	// ──────────────────────────────────────────────────────────────────────
	// Lens detector harness (deterministic — no model, runs instantly).
	// Lets you paste any text + filename and see the weighted contract score,
	// the strong-signal count, which keywords matched, and the final lens.
	// ──────────────────────────────────────────────────────────────────────

	// Canned fixtures: a real contract excerpt (should → 'contract') and a chat
	// transcript that merely *talks about* a deal (should → 'document').
	const CONTRACT_FIXTURE =
		'THIS SERVICE AND LICENSE AGREEMENT is made and entered into effective as of ' +
		'the Effective Date between the Parties, who hereby agree as follows. The ' +
		'Receiving Party shall protect the Confidential Information of the Disclosing ' +
		'Party. Tiingo shall indemnify and hold harmless Company. This Agreement, and ' +
		'any disputes arising from it, will be governed by the governing law of New York. ' +
		'Force Majeure: nonperformance will be excused. Severability: if any provision is ' +
		'held invalid, the other provisions remain in effect. IN WITNESS WHEREOF, the ' +
		'Parties have caused this Agreement to be executed.';

	const TRANSCRIPT_FIXTURE =
		"Alex: hey did you read the agreement they sent over?\n" +
		"Sam: yeah, both parties seem fine with it but I'm worried about the breach " +
		"clause if we miss a deadline.\n" +
		"Alex: right, and it's all confidential so don't forward it around.\n" +
		"Sam: agreed. let's talk termination terms tomorrow, the proposed terms look ok.";

	let lensText = $state(CONTRACT_FIXTURE);
	let lensFileName = $state('contract.docx');

	const lensScore = $derived<ContractScore>(scoreContractSignals(lensText));
	const lensIsContract = $derived(isContractScore(lensScore));
	const lens = $derived<Lens>(detectLens(lensText, lensFileName));

	function loadContractFixture() {
		lensText = CONTRACT_FIXTURE;
		lensFileName = 'contract.docx';
	}
	function loadTranscriptFixture() {
		lensText = TRANSCRIPT_FIXTURE;
		lensFileName = 'transcript.txt';
	}
</script>

<main class="wrap">
	<h1>Legal Clause Classifier — test harness</h1>
	<p class="note">
		Browser-side inference (Transformers.js, WebGPU→WASM). First run downloads the
		model (~280MB fp32, then cached). Subsequent runs are near-instant.
	</p>

	<label for="clause">Clause text</label>
	<textarea id="clause" bind:value={text} rows="4"></textarea>

	<button onclick={run} disabled={busy || !text.trim()}>
		{busy ? 'Classifying…' : 'Classify'}
	</button>

	{#if progress && busy}
		<p class="progress">{progress.message} ({progress.percent}%)</p>
	{/if}

	{#if error}
		<div class="error">Error: {error}</div>
	{/if}

	{#if result}
		<div class="result">
			<div class="row">
				<span class="badge" style="background:{riskColor[result.risk]}">{result.risk}</span>
				<strong>{result.label}</strong>
				<span class="score">{(result.score * 100).toFixed(1)}%</span>
			</div>
			<p class="desc">{result.description}</p>
			<pre>{JSON.stringify(result, null, 2)}</pre>
		</div>
	{/if}

	<hr class="sep" />

	<h2>Lens detector — deterministic, no model</h2>
	<p class="note">
		Occurrence-weighted keyword scoring + word-boundary matching + a
		strong-signal gate. Classifies as <code>contract</code> only when total
		score ≥ {CONTRACT_SCORE_THRESHOLD} AND either ≥2 distinct strong (weight-3)
		keywords are present, or 1 strong keyword appears densely (≥3 times). Weak
		keywords are capped so common business prose can't qualify. Updates live.

	</p>

	<div class="fixtures">
		<button class="ghost" onclick={loadContractFixture}>Load contract fixture</button>
		<button class="ghost" onclick={loadTranscriptFixture}>Load transcript fixture</button>
	</div>

	<label for="lensFile">File name (extension drives spreadsheet routing)</label>
	<input id="lensFile" bind:value={lensFileName} />

	<label for="lensText">Document text</label>
	<textarea id="lensText" bind:value={lensText} rows="8"></textarea>

	<div class="result">
		<div class="row">
			<span
				class="badge"
				style="background:{lens === 'contract' ? '#dc2626' : lens === 'spreadsheet' ? '#2563eb' : '#16a34a'}"
				>{lens}</span
			>
			<strong>{lensIsContract ? 'Contract signals met' : 'Not a contract'}</strong>
			<span class="score">score {lensScore.score} / threshold {CONTRACT_SCORE_THRESHOLD}</span>
		</div>
		<p class="desc">
			Strong-signal hits: <strong>{lensScore.strongHits}</strong>
			{#if lensScore.strongHits < 2 && !(lensScore.strongHits === 1 && lensScore.strongOccurrences >= 3)}<span class="muted"> (strong-signal gate blocks contract)</span>{/if}

		</p>
		{#if lensScore.matched.length}
			<div class="chips">
				{#each lensScore.matched as kw (kw)}
					<span class="chip">{kw}</span>
				{/each}
			</div>
		{:else}
			<p class="muted">No contract keywords matched.</p>
		{/if}
	</div>
</main>

<style>
	.wrap { max-width: 640px; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; }
	h1 { font-size: 1.25rem; }
	.note { color: #64748b; font-size: 0.85rem; }
	label { display: block; font-weight: 600; margin-top: 1rem; }
	textarea { width: 100%; padding: 0.5rem; font-family: inherit; margin-top: 0.25rem; }
	button { margin-top: 0.75rem; padding: 0.5rem 1rem; cursor: pointer; }
	button:disabled { opacity: 0.6; cursor: default; }
	.progress { color: #2563eb; font-size: 0.9rem; }
	.error { margin-top: 1rem; color: #dc2626; background: #fef2f2; padding: 0.75rem; border-radius: 6px; }
	.result { margin-top: 1rem; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1rem; }
	.row { display: flex; align-items: center; gap: 0.5rem; }
	.badge { color: white; font-size: 0.7rem; text-transform: uppercase; padding: 0.15rem 0.45rem; border-radius: 999px; }
	.score { margin-left: auto; color: #64748b; }
	.desc { color: #475569; margin: 0.5rem 0; }
	pre { background: #0f172a; color: #e2e8f0; padding: 0.75rem; border-radius: 6px; overflow-x: auto; font-size: 0.8rem; }
	.sep { margin: 2rem 0 1rem; border: none; border-top: 1px solid #e2e8f0; }
	h2 { font-size: 1.05rem; }
	code { background: #f1f5f9; padding: 0.05rem 0.3rem; border-radius: 4px; font-size: 0.85em; }
	input { width: 100%; padding: 0.5rem; font-family: inherit; margin-top: 0.25rem; box-sizing: border-box; }
	.fixtures { display: flex; gap: 0.5rem; flex-wrap: wrap; }
	.ghost { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 0.85rem; }
	.chips { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.5rem; }
	.chip { background: #ecfeff; border: 1px solid #a5f3fc; color: #0e7490; font-size: 0.72rem; padding: 0.1rem 0.45rem; border-radius: 999px; }
	.muted { color: #94a3b8; font-size: 0.85rem; }
</style>
