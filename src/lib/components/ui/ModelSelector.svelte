<script lang="ts">
	interface ModelOption {
		id: string;
		name: string;
		size: string;
		tier: 'free' | 'pro';
		description: string;
	}

	interface Props {
		models: ModelOption[];
		selected?: string | null;
		onSelect: (modelId: string) => void;
		class?: string;
	}
	let {
		models,
		selected = null,
		onSelect,
		class: className = ''
	}: Props = $props();
</script>

<div class="space-y-2 {className}" role="radiogroup" aria-label="Model selection">
	{#each models as model (model.id)}
		{@const isSelected = selected === model.id}

		<button
			onclick={() => onSelect(model.id)}
			role="radio"
			aria-checked={isSelected}
			class="w-full text-left flex items-center gap-4 p-4 rounded-xl border transition-all duration-100
				focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
				{isSelected
					? 'bg-blue-50 border-blue-300 ring-1 ring-blue-300 dark:bg-blue-950/40 dark:border-blue-700 dark:ring-blue-700'
					: 'bg-gray-50 border-gray-200 hover:border-gray-300 hover:bg-gray-100 cursor-pointer dark:bg-slate-900 dark:border-slate-800 dark:hover:border-slate-700 dark:hover:bg-slate-800/60'}"
		>
			<!-- Radio indicator -->
			<div class="flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center
				{isSelected ? 'border-blue-500 bg-blue-500' : 'border-gray-300 dark:border-gray-600'}">
				{#if isSelected}
					<div class="w-1.5 h-1.5 rounded-full bg-white"></div>
				{/if}
			</div>

			<!-- Model info -->
			<div class="flex-1 min-w-0">
				<div class="flex items-center gap-2 mb-0.5">
					<span class="text-sm font-semibold {isSelected ? 'text-blue-700 dark:text-blue-200' : 'text-gray-900 dark:text-gray-200'}">
						{model.name}
					</span>
					<span class="text-xs text-gray-500 dark:text-gray-500 font-mono">{model.size}</span>
					<span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700 border border-green-300 dark:bg-green-900/40 dark:text-green-400 dark:border-green-800">
						Free
					</span>
				</div>
				<p class="text-xs text-gray-500 dark:text-gray-500 leading-relaxed">{model.description}</p>
			</div>
		</button>
	{/each}
</div>
