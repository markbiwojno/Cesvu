/**
 * src/lib/pipeline/resultFormatter.ts — Convert OperationResults into chat messages
 *
 * formatResult(result) → ChatMessage
 *
 * Each OperationResult type maps to a human-readable markdown message.
 * Row data is attached as structured data for the DataTable component.
 */

import type {
	OperationResult,
	ColumnStats
} from '$lib/pipeline/operations.js';

// ============================================================
// ChatMessage
// ============================================================

export interface FormattedChatMessage {
	role: 'assistant';
	content: string;
	/** Structured row data for DataTable rendering (rows result only) */
	data?: Record<string, string>[];
	/** Column order for DataTable */
	columns?: string[];
	/** True if this message represents an error */
	isError?: boolean;
}

// ============================================================
// formatNumber
// ============================================================

/**
 * Format a number for display:
 * - null/undefined → "N/A"
 * - large integers → locale commas (1,234,567)
 * - decimals → 2 decimal places
 * - tiny decimals (|x| < 0.01 and x ≠ 0) → 4 decimal places
 */
export function formatNumber(value: number | null | undefined): string {
	if (value === null || value === undefined) return 'N/A';
	if (isNaN(value)) return 'N/A';

	const abs = Math.abs(value);

	// Integer — use locale commas
	if (Number.isInteger(value)) {
		return value.toLocaleString();
	}

	// Tiny decimal — 4 places
	if (abs > 0 && abs < 0.01) {
		return value.toFixed(4);
	}

	// Standard — 2 decimal places with locale commas
	return value.toLocaleString(undefined, {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2
	});
}

// ============================================================
// formatGroupedTable
// ============================================================

/**
 * Render a grouped result as a markdown table.
 * First column = group key. Subsequent columns = aggregate aliases.
 */
export function formatGroupedTable(
	data: Record<string, { alias: string; value: number }[]>
): string {
	const keys = Object.keys(data);
	if (keys.length === 0) return '_No groups found._';

	// Collect all aliases from the first group (they're consistent across groups)
	const aliases = data[keys[0]].map(a => a.alias);

	// Header
	const header = ['Group', ...aliases].map(h => `**${h}**`).join(' | ');
	const separator = ['---', ...aliases.map(() => '---')].join(' | ');

	// Rows
	const rows = keys.map(key => {
		const aggs = data[key];
		const cells = [key, ...aggs.map(a => formatNumber(a.value))];
		return cells.join(' | ');
	});

	return [header, separator, ...rows].join('\n');
}

// ============================================================
// formatRankedList
// ============================================================

/**
 * Render a ranked list as a numbered markdown list (descending order).
 * Items are assumed to already be sorted descending by the engine.
 */
export function formatRankedList(
	data: { category: string; value: number }[],
	metricLabel?: string
): string {
	if (data.length === 0) return '_No results._';

	const label = metricLabel ? ` (${metricLabel})` : '';
	return data
		.map((item, i) => `${i + 1}. **${item.category}** — ${formatNumber(item.value)}${label}`)
		.join('\n');
}

// ============================================================
// formatTrendSummary
// ============================================================

/**
 * Render a trend result as a markdown table with min/max/change summary.
 * Single-point trend gets a special message.
 */
export function formatTrendSummary(data: Record<string, unknown>[]): string {
	if (data.length === 0) return '_No trend data._';

	// Single point
	if (data.length === 1) {
		const point = data[0];
		const keys = Object.keys(point);
		const periodKey = keys[0] ?? 'period';
		const valueKey = keys[1] ?? 'value';
		const val = typeof point[valueKey] === 'number' ? formatNumber(point[valueKey] as number) : String(point[valueKey] ?? 'N/A');
		return `Only one data point: **${String(point[periodKey])}** → ${val}`;
	}

	// Multiple points — build markdown table
	const keys = Object.keys(data[0]);
	const periodKey = keys[0] ?? 'period';
	const valueKey = keys[1] ?? 'value';

	const header = `**${periodKey}** | **${valueKey}**`;
	const separator = '--- | ---';
	const rows = data.map(point => {
		const period = String(point[periodKey] ?? '');
		const val = typeof point[valueKey] === 'number'
			? formatNumber(point[valueKey] as number)
			: String(point[valueKey] ?? 'N/A');
		return `${period} | ${val}`;
	});

	// Compute min, max, overall change from numeric values
	const numericValues = data
		.map(p => p[valueKey])
		.filter((v): v is number => typeof v === 'number' && !isNaN(v));

	const summaryLines: string[] = [];
	if (numericValues.length >= 2) {
		const min = Math.min(...numericValues);
		const max = Math.max(...numericValues);
		const first = numericValues[0];
		const last = numericValues[numericValues.length - 1];
		const change = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : null;
		const changeStr = change !== null
			? `${change >= 0 ? '+' : ''}${formatNumber(change)}%`
			: 'N/A';

		summaryLines.push('');
		summaryLines.push(`**Min:** ${formatNumber(min)} | **Max:** ${formatNumber(max)} | **Overall change:** ${changeStr}`);
	}

	return [header, separator, ...rows, ...summaryLines].join('\n');
}

// ============================================================
// formatDistribution
// ============================================================

const BAR_MAX_WIDTH = 20; // max █ characters

/**
 * Render a distribution as a markdown table with a percentage bar.
 */
export function formatDistribution(data: { bin: string; count: number }[]): string {
	if (data.length === 0) return '_No distribution data._';

	const total = data.reduce((s, d) => s + d.count, 0);
	const maxCount = Math.max(...data.map(d => d.count));

	const header = '**Range** | **Count** | **%** | **Bar**';
	const separator = '--- | --- | --- | ---';

	const rows = data.map(({ bin, count }) => {
		const pct = total > 0 ? (count / total) * 100 : 0;
		const barLen = maxCount > 0 ? Math.round((count / maxCount) * BAR_MAX_WIDTH) : 0;
		const bar = '█'.repeat(barLen);
		return `${bin} | ${count.toLocaleString()} | ${pct.toFixed(1)}% | ${bar}`;
	});

	return [header, separator, ...rows].join('\n');
}

// ============================================================
// formatDescribeTable
// ============================================================

/**
 * Render a describe result as a markdown table.
 * Columns: Column | Type | Count | Unique | Nulls | Min | Max | Mean
 */
export function formatDescribeTable(data: Record<string, ColumnStats>): string {
	const cols = Object.keys(data);
	if (cols.length === 0) return '_No columns to describe._';

	const header = '**Column** | **Type** | **Count** | **Unique** | **Nulls** | **Min** | **Max** | **Mean**';
	const separator = '--- | --- | --- | --- | --- | --- | --- | ---';

	const rows = cols.map(colName => {
		const s = data[colName];
		const min = s.min !== undefined
			? (typeof s.min === 'number' ? formatNumber(s.min) : String(s.min))
			: 'N/A';
		const max = s.max !== undefined
			? (typeof s.max === 'number' ? formatNumber(s.max) : String(s.max))
			: 'N/A';
		const mean = s.mean !== undefined ? formatNumber(s.mean) : 'N/A';

		return [
			colName,
			s.type,
			s.count.toLocaleString(),
			s.unique.toLocaleString(),
			s.nulls.toLocaleString(),
			min,
			max,
			mean
		].join(' | ');
	});

	return [header, separator, ...rows].join('\n');
}

// ============================================================
// formatResult — main dispatcher
// ============================================================

export function formatResult(result: OperationResult): FormattedChatMessage {
	switch (result.type) {

		case 'scalar': {
			const val = formatNumber(result.value);
			return {
				role: 'assistant',
				content: `**${result.label}**: ${val}`
			};
		}

		case 'rows': {
			const count = result.totalCount;
			const shown = result.data.length;
			const suffix = shown < count
				? ` (showing ${shown.toLocaleString()} of ${count.toLocaleString()})`
				: ` (${count.toLocaleString()} row${count !== 1 ? 's' : ''})`;
			return {
				role: 'assistant',
				content: `Found ${count.toLocaleString()} row${count !== 1 ? 's' : ''}${suffix}.`,
				data: result.data,
				columns: result.columns
			};
		}

		case 'grouped': {
			const groupCount = Object.keys(result.data).length;
			const table = formatGroupedTable(result.data);
			return {
				role: 'assistant',
				content: `**${groupCount} group${groupCount !== 1 ? 's' : ''}:**\n\n${table}`
			};
		}

		case 'comparison': {
			const entries = Object.entries(result.data)
				.map(([category, value]) => ({ category, value }))
				.sort((a, b) => b.value - a.value);
			const list = formatRankedList(entries, `${result.column} by ${result.by}`);
			return {
				role: 'assistant',
				content: `**Comparison of ${result.column} by ${result.by}:**\n\n${list}`
			};
		}

		case 'trend': {
			const table = formatTrendSummary(result.data);
			return {
				role: 'assistant',
				content: `**Trend:**\n\n${table}`
			};
		}

		case 'top_n': {
			const list = formatRankedList(result.data);
			return {
				role: 'assistant',
				content: `**Rankings:**\n\n${list}`
			};
		}

		case 'distribution': {
			const table = formatDistribution(result.data);
			return {
				role: 'assistant',
				content: `**Distribution:**\n\n${table}`
			};
		}

		case 'describe': {
			const table = formatDescribeTable(result.data);
			return {
				role: 'assistant',
				content: `**Column Summary:**\n\n${table}`
			};
		}

		case 'answer': {
			return {
				role: 'assistant',
				content: result.context
					? `${result.context}`
					: result.question
			};
		}

		case 'crossSheet': {
			if (result.correlation === null) {
				return {
					role: 'assistant',
					content: `**${result.label}**: not enough matched data points (${result.pairCount} pair${result.pairCount !== 1 ? 's' : ''}) to compute a correlation.`
				};
			}
			const strength =
				Math.abs(result.correlation) >= 0.7
					? 'strong'
					: Math.abs(result.correlation) >= 0.4
						? 'moderate'
						: 'weak';
			const direction = result.correlation >= 0 ? 'positive' : 'negative';
			const matchNote =
				result.matchStrategy === 'key' && result.matchKey
					? ` (matched on "${result.matchKey}")`
					: ' (matched by row order)';
			return {
				role: 'assistant',
				content: `**${result.label}**: r = ${result.correlation} — a ${strength} ${direction} correlation across ${result.pairCount.toLocaleString()} matched pair${result.pairCount !== 1 ? 's' : ''}${matchNote}.`
			};
		}

		case 'error': {
			const hint = result.availableColumns?.length
				? `\n\nAvailable columns: ${result.availableColumns.join(', ')}`
				: '';
			return {
				role: 'assistant',
				content: `⚠️ ${result.message}${hint}`,
				isError: true
			};
		}

		default: {
			// Exhaustive check
			const _exhaustive: never = result;
			return {
				role: 'assistant',
				content: `Unknown result type: ${(_exhaustive as OperationResult).type}`,
				isError: true
			};
		}
	}
}
