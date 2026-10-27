<script lang="ts">
	import { templateStore } from '$lib/stores/templates.svelte.js';
	import type { Template } from '$lib/utils/types.js';

	interface Props {
		onselect?: (template: Template) => void;
	}
	let { onselect }: Props = $props();

	function select(template: Template) {
		templateStore.setActiveTemplate(template.id);
		onselect?.(template);
	}
</script>

<div class="space-y-2">
	<p class="text-xs font-semibold text-gray-500 uppercase tracking-wider px-1">Analysis Template</p>
	<div class="grid grid-cols-2 gap-2">
		{#each templateStore.templates as template (template.id)}
			<button
				onclick={() => select(template)}
				class="flex items-start gap-2 p-3 rounded-xl border text-left transition-all
					{templateStore.activeTemplateId === template.id
						? 'border-brand-600 bg-brand-950/50 text-white'
						: 'border-slate-700 bg-slate-800/50 text-gray-400 hover:border-gray-600 hover:text-gray-300'}"
			>
				<span class="text-xl flex-shrink-0">{template.icon}</span>
				<div class="min-w-0">
					<p class="text-xs font-semibold truncate">{template.name}</p>
					<p class="text-xs text-gray-600 line-clamp-2 mt-0.5">{template.description}</p>
				</div>
			</button>
		{/each}
	</div>
</div>
