import { describe, it, expect } from 'vitest';
import { formatStatSummary } from './column-visual-report.js';
import type { ColumnStats } from '$lib/pipeline/columnStats.js';

describe('formatStatSummary', () => {
	it('formats numeric stats as mean/median/std/p5/p95', () => {
		const stats: ColumnStats = {
			kind: 'numeric',
			count: 10, nonNull: 10, nullCount: 0,
			min: 1, max: 100, mean: 50.456, median: 48, std: 12.3456,
			q1: 20, q3: 80, iqr: 60, p5: 5.1, p95: 95.9,
			zOutliers: [], iqrOutliers: [], outlierSamples: []
		};
		const line = formatStatSummary(stats);
		expect(line).toContain('mean 50.46');
		expect(line).toContain('median 48');
		expect(line).toContain('σ 12.35');
		expect(line).toContain('p5 5.1');
		expect(line).toContain('p95 95.9');
	});

	it('formats categorical stats as top values with percentages', () => {
		const stats: ColumnStats = {
			kind: 'categorical',
			count: 10, nonNull: 10, nullCount: 0, uniqueCount: 3,
			topValues: [
				{ value: 'East', count: 5, pct: 0.5 },
				{ value: 'West', count: 3, pct: 0.3 },
				{ value: 'North', count: 2, pct: 0.2 }
			],
			hasLongTail: false, top10Share: 1
		};
		const line = formatStatSummary(stats);
		expect(line).toBe('East (50%), West (30%), North (20%)');
	});

	it('falls back to unique count when a categorical column has no top values', () => {
		const stats: ColumnStats = {
			kind: 'categorical',
			count: 0, nonNull: 0, nullCount: 0, uniqueCount: 0,
			topValues: [], hasLongTail: false, top10Share: 0
		};
		expect(formatStatSummary(stats)).toBe('0 unique values');
	});

	it('formats datetime stats as a range + peak month', () => {
		const stats: ColumnStats = {
			kind: 'datetime',
			count: 10, nonNull: 10, nullCount: 0,
			min: new Date('2023-01-01'), max: new Date('2024-06-15'),
			peakMonth: '2023-12', peakCount: 4, distinctMonths: 6
		};
		const line = formatStatSummary(stats);
		expect(line).toBe('2023-01-01 → 2024-06-15 · peak 2023-12 (4)');
	});

	it('formats text stats as unique count + length percentiles', () => {
		const stats: ColumnStats = {
			kind: 'text',
			count: 10, nonNull: 10, nullCount: 0, uniqueCount: 9,
			medianLength: 24.4, p95Length: 103.9, topValues: []
		};
		expect(formatStatSummary(stats)).toBe('9 unique · median 24 chars · p95 104 chars');
	});
});
