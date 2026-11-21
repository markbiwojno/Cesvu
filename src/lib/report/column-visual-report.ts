/**
 * src/lib/report/column-visual-report.ts — shared types + a one-line stat
 * summary formatter for the "Column Visual Analysis" report.
 *
 * Kept separate from pdf-writer.ts (pure layout/drawing) and
 * column-chart-renderer.ts (DOM-dependent rasterization) so the summary-line
 * formatting is independently unit-testable.
 */

import type { ColumnStats } from '$lib/pipeline/columnStats.js';

/** One compact stat line per column, mirroring ColumnTile.svelte's stat strip. */
export function formatStatSummary(stats: ColumnStats): string {
	switch (stats.kind) {
		case 'numeric':
			return `mean ${formatNum(stats.mean)} · median ${formatNum(stats.median)} · σ ${formatNum(stats.std)} · p5 ${formatNum(stats.p5)} · p95 ${formatNum(stats.p95)}`;
		case 'categorical': {
			const top = stats.topValues
				.slice(0, 3)
				.map((t) => `${t.value} (${(t.pct * 100).toFixed(0)}%)`)
				.join(', ');
			return top || `${stats.uniqueCount} unique values`;
		}
		case 'datetime':
			return `${stats.min.toISOString().slice(0, 10)} → ${stats.max.toISOString().slice(0, 10)} · peak ${stats.peakMonth} (${stats.peakCount})`;
		case 'text':
			return `${stats.uniqueCount} unique · median ${Math.round(stats.medianLength)} chars · p95 ${Math.round(stats.p95Length)} chars`;
	}
}

function formatNum(n: number): string {
	return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** One column's fully-prepared report entry: chart image + stat line. */
export interface ColumnVisualEntry {
	column: string;
	title: string;
	/** PNG bytes of the rendered chart, or null if nothing was plottable. */
	chartPng: Uint8Array | null;
	chartWidth: number;
	chartHeight: number;
	statSummary: string;
}
