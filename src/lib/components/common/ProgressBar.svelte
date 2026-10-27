<script lang="ts">
	interface Props {
		progress: number; // 0-100
		stage?: string;
		showLabel?: boolean;
	}
	let { progress, stage, showLabel = true }: Props = $props();

	let clampedProgress = $derived(Math.max(0, Math.min(100, progress)));
</script>

<div class="space-y-2">
	{#if showLabel && stage}
		<div class="flex items-center justify-between text-xs text-gray-400">
			<span>{stage}</span>
			<span>{Math.round(clampedProgress)}%</span>
		</div>
	{/if}
	<div class="h-1.5 bg-slate-800 rounded-full overflow-hidden">
		<div
			class="h-full bg-brand-500 rounded-full transition-all duration-300 ease-out"
			style="width: {clampedProgress}%"
			role="progressbar"
			aria-valuenow={clampedProgress}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-label={stage ?? 'Progress'}
		></div>
	</div>
</div>
