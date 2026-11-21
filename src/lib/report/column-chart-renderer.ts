/**
 * src/lib/report/column-chart-renderer.ts — main-thread chart rasterizer for
 * the "Column Visual Analysis" PDF report.
 *
 * WHY MAIN THREAD: vega-embed needs a real DOM (it mounts into a container
 * element and renders via canvas/SVG). report-worker.ts runs in a Web
 * Worker with no DOM, so — unlike the Summary Report's data crunching —
 * this report's chart images must be produced here, on the main thread,
 * before being handed off to the worker for PDF layout/drawing.
 *
 * Renders charts SEQUENTIALLY (await each one fully, finalize() before the
 * next) rather than all at once, so at most one hidden Vega view + one
 * offscreen container exist at a time — bounded memory regardless of how
 * many columns the user configured.
 *
 * Fixed-resolution rasterization: the hidden container is sized to an
 * explicit pixel width/height (not "whatever the visible window happens to
 * be"), and vega-embed's canvas renderer is asked for a 2x scaleFactor, so
 * PDF output is crisp and IDENTICAL regardless of the browser window size
 * at generation time.
 */

import type { TopLevelSpec } from 'vega-lite';
import { buildReportChartSpec, type ColumnChartConfig } from './report-chart-specs.js';
import {
	categoryData as sharedCategoryData,
	histogramData as sharedHistogramData,
	timeseriesData as sharedTimeseriesData
} from '$lib/visuals/chart-data.js';
import { toNumber, toDate } from '$lib/pipeline/columnStats.js';
import type { ChartData } from '$lib/visuals/chart-specs.js';

/** Pixel size of the hidden rasterization container — fixed regardless of
 *  window size, so repeated generations are byte-for-byte reproducible. */
const RENDER_WIDTH = 640;
const RENDER_HEIGHT = 300;
/** Devicepixel multiplier for the canvas rasterization — crisp in a printed PDF. */
const SCALE_FACTOR = 2;

export interface RenderedColumnChart {
	column: string;
	config: ColumnChartConfig;
	/** PNG bytes, or null if there was nothing plottable for this column/config. */
	pngBytes: Uint8Array | null;
	/** Pixel dimensions of pngBytes (before any PDF-side scaling). */
	width: number;
	height: number;
}

/** Build the {@link ChartData} series for a column per its topN/sort/binCount config. */
function buildChartData(
	rows: Record<string, unknown>[],
	config: ColumnChartConfig
): ChartData | null {
	switch (config.columnType) {
		case 'numeric':
			return sharedHistogramData(rows, config.column, config.binCount ?? 20, toNumber);
		case 'datetime':
			return sharedTimeseriesData(rows, config.column, toDate);
		case 'categorical':
		case 'text':
			return sharedCategoryData(rows, config.column, config.topN ?? 10, config.sort ?? 'count-desc');
	}
}

/** Rasterize one spec to PNG bytes via a hidden, fixed-size vega-embed mount. */
async function rasterizeSpec(spec: TopLevelSpec): Promise<{ bytes: Uint8Array; width: number; height: number }> {
	const { default: vegaEmbed } = await import('vega-embed');

	const container = document.createElement('div');
	container.style.position = 'fixed';
	container.style.left = '-99999px';
	container.style.top = '0';
	container.style.width = `${RENDER_WIDTH}px`;
	container.style.height = `${RENDER_HEIGHT}px`;
	document.body.appendChild(container);

	try {
		const result = await vegaEmbed(container, spec, {
			actions: false,
			renderer: 'canvas',
			scaleFactor: SCALE_FACTOR
		});
		try {
			const canvas = await result.view.toCanvas(SCALE_FACTOR);
			const dataUrl = canvas.toDataURL('image/png');
			const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
			const binary = atob(base64);
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
			return { bytes, width: canvas.width, height: canvas.height };
		} finally {
			result.finalize();
		}
	} finally {
		container.remove();
	}
}

/**
 * Render every configured column's chart to PNG bytes, sequentially, with a
 * progress callback (`rendered`/`total`) so the modal can show
 * "Rendering chart N of M…" — reusing the Summary Report's progress UI.
 */
export async function renderColumnCharts(
	rows: Record<string, unknown>[],
	configs: ColumnChartConfig[],
	onProgress?: (rendered: number, total: number) => void
): Promise<RenderedColumnChart[]> {
	const results: RenderedColumnChart[] = [];
	for (let i = 0; i < configs.length; i++) {
		const config = configs[i];
		const data = buildChartData(rows, config);
		const spec = buildReportChartSpec(config, data);
		if (!spec) {
			results.push({ column: config.column, config, pngBytes: null, width: 0, height: 0 });
		} else {
			const { bytes, width, height } = await rasterizeSpec(spec);
			results.push({ column: config.column, config, pngBytes: bytes, width, height });
		}
		onProgress?.(i + 1, configs.length);
	}
	return results;
}
