<script lang="ts">
	interface Props {
		icon?: string;
		title: string;
		description?: string;
		action?: string;
		onaction?: () => void;
	}
	let { icon = '📂', title, description, action, onaction }: Props = $props();
</script>

<div class="flex flex-col items-center justify-center py-16 px-6 text-center">
	<div class="text-5xl mb-4" aria-hidden="true">{icon}</div>
	<h3 class="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">{title}</h3>
	{#if description}
		<p class="text-sm text-gray-500 max-w-sm mb-6">{description}</p>
	{/if}
	{#if action && onaction}
		<button
			onclick={onaction}
			class="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors"
		>
			{action}
		</button>
	{/if}
</div>
