/**
 * src/lib/pipeline/engine.ts — CSV analysis execution engine
 *
 * Executes DataOperation objects against in-memory CSV row data.
 * All operations run client-side. No server calls.
 *
 * Column matching uses fuzzy normalization (lowercase, strip spaces/underscores/hyphens).
 * Numeric parsing strips $, %, commas before Number().
 * Date parsing reuses the same patterns as query.ts.
 */

import type {
	DataOperation,
	CrossSheetOperation,
	Filter,
	SortClause,
	OperationResult,
	ColumnStats,
	AggregateFunction
} from '$lib/pipeline/operations.js';
import type { Workbook, Sheet } from '$lib/data/workbook.js';


// ============================================================
// Internal helpers
// ============================================================

/** Normalize a column name for fuzzy matching */
function normCol(s: string): string {
	return s.toLowerCase().replace(/[\s_\-]/g, '');
}

/**
 * Resolve a column name from user input against actual data columns.
 * Returns the actual column name (preserving original case) or null.
 */
function resolveColumn(name: string, columns: string[]): string | null {
	const needle = normCol(name);
	// 1. Exact match (case-insensitive)
	for (const col of columns) {
		if (col.toLowerCase() === name.toLowerCase()) return col;
	}
	// 2. Normalized match (strip spaces/underscores/hyphens)
	for (const col of columns) {
		if (normCol(col) === needle) return col;
	}
	// 3. Substring match (longest wins)
	let best: string | null = null;
	let bestLen = 0;
	for (const col of columns) {
		const cn = normCol(col);
		if (cn.includes(needle) || needle.includes(cn)) {
			if (cn.length > bestLen) {
				best = col;
				bestLen = cn.length;
			}
		}
	}
	return best;
}

/** Convert a cell value to a number, stripping currency/percent symbols */
function toNum(v: unknown): number | null {
	if (v === null || v === undefined || v === '') return null;
	if (typeof v === 'number') return isNaN(v) ? null : v;
	if (typeof v === 'string') {
		const n = Number(v.replace(/[$,%\s]/g, ''));
		return isNaN(n) ? null : n;
	}
	return null;
}

/** Convert a cell value to a lowercase string */
function toStr(v: unknown): string {
	if (v === null || v === undefined) return '';
	return String(v);
}

/** Parse a date string to a timestamp (ms). Returns null if unparseable. */
function parseDate(v: unknown): number | null {
	if (v === null || v === undefined || v === '') return null;
	const s = String(v).trim();
	// Try ISO and common formats
	const d = new Date(s);
	if (!isNaN(d.getTime())) return d.getTime();
	// MM/DD/YYYY
	const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
	if (m) {
		const year = m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]);
		const d2 = new Date(year, parseInt(m[1]) - 1, parseInt(m[2]));
		if (!isNaN(d2.getTime())) return d2.getTime();
	}
	return null;
}

/** Get all column names from the first row */
function getColumns(data: Record<string, string>[]): string[] {
	if (data.length === 0) return [];
	return Object.keys(data[0]);
}

/** Return an error result for an unknown column */
function unknownColumnError(name: string, columns: string[]): OperationResult {
	return {
		type: 'error',
		message: `Column '${name}' not found. Available columns: ${columns.join(', ')}`,
		availableColumns: columns
	};
}

// ============================================================
// applyFilters
// ============================================================

/**
 * Apply a list of filters to a row. Returns true if the row passes all filters.
 * All filters are ANDed together.
 */
function rowPassesFilter(row: Record<string, string>, filter: Filter, columns: string[]): boolean {
	const col = resolveColumn(filter.column, columns);
	if (!col) return false; // unknown column — exclude row

	const rawVal = row[col];
	const { op, value } = filter;

	// Numeric comparison
	if (['gt', 'gte', 'lt', 'lte'].includes(op)) {
		const cellNum = toNum(rawVal);
		const filterNum = toNum(value as string | number);
		if (cellNum === null || filterNum === null) return false;
		if (op === 'gt')  return cellNum > filterNum;
		if (op === 'gte') return cellNum >= filterNum;
		if (op === 'lt')  return cellNum < filterNum;
		if (op === 'lte') return cellNum <= filterNum;
	}

	// Date comparison — try date parse first, fall back to numeric
	if (['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(op)) {
		const cellDate = parseDate(rawVal);
		const filterDate = parseDate(value as string);
		if (cellDate !== null && filterDate !== null) {
			if (op === 'eq')  return cellDate === filterDate;
			if (op === 'neq') return cellDate !== filterDate;
			if (op === 'gt')  return cellDate > filterDate;
			if (op === 'gte') return cellDate >= filterDate;
			if (op === 'lt')  return cellDate < filterDate;
			if (op === 'lte') return cellDate <= filterDate;
		}
	}

	// String / equality comparisons
	const cellStr = toStr(rawVal);
	const cellLower = cellStr.toLowerCase();

	switch (op) {
		case 'eq':
			return cellLower === String(value).toLowerCase();
		case 'neq':
			return cellLower !== String(value).toLowerCase();
		case 'contains':
			return cellLower.includes(String(value).toLowerCase());
		case 'starts_with':
			return cellLower.startsWith(String(value).toLowerCase());
		case 'in': {
			const arr = value as string[];
			return arr.map(s => s.toLowerCase()).includes(cellLower);
		}
		case 'between': {
			const [lo, hi] = value as [number, number];
			const n = toNum(rawVal);
			if (n === null) return false;
			return n >= lo && n <= hi; // inclusive
		}
		default:
			return false;
	}
}

export function applyFilters(
	data: Record<string, string>[],
	filters: Filter[],
	columns: string[]
): Record<string, string>[] {
	if (filters.length === 0) return data;
	return data.filter(row => filters.every(f => rowPassesFilter(row, f, columns)));
}

// ============================================================
// Aggregate helpers
// ============================================================

function computeNumericValues(
	data: Record<string, string>[],
	column: string
): number[] {
	const values: number[] = [];
	for (const row of data) {
		const n = toNum(row[column]);
		if (n === null) {
			console.warn(`[engine] skipping NaN/null in column "${column}"`);
			continue;
		}
		values.push(n);
	}
	return values;
}

function computeAggregate(values: number[], fn: AggregateFunction | string): number | null {
	if (fn === 'count') return values.length;
	if (values.length === 0) return null;

	switch (fn) {
		case 'sum':
			return values.reduce((a, b) => a + b, 0);
		case 'avg':
			return values.reduce((a, b) => a + b, 0) / values.length;
		case 'min':
			return Math.min(...values);
		case 'max':
			return Math.max(...values);
		case 'median': {
			const sorted = [...values].sort((a, b) => a - b);
			const mid = Math.floor(sorted.length / 2);
			return sorted.length % 2 === 0
				? (sorted[mid - 1] + sorted[mid]) / 2
				: sorted[mid];
		}
		case 'stddev': {
			if (values.length < 2) return null; // single-row stddev => null
			const mean = values.reduce((a, b) => a + b, 0) / values.length;
			const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
			return Math.sqrt(variance);
		}
		default:
			return null;
	}
}

// ============================================================
// Multi-column sort
// ============================================================

/**
 * Compare two cell values for sorting.
 *
 * Priority:
 *   1. Empty/null values sort LAST (regardless of direction — caller inverts)
 *   2. Numeric strings compare numerically  (100 > 20)
 *   3. Date strings compare chronologically
 *   4. Fallback: case-insensitive localeCompare
 *
 * Returns negative / 0 / positive (same contract as Array.prototype.sort).
 * The caller applies direction by negating the result for 'desc'.
 */
export function compareValues(a: string, b: string): number {
	const aEmpty = a === '' || a === null || a === undefined;
	const bEmpty = b === '' || b === null || b === undefined;

	// Empty values always sort last
	if (aEmpty && bEmpty) return 0;
	if (aEmpty) return 1;   // a is empty → a goes after b
	if (bEmpty) return -1;  // b is empty → b goes after a

	// Numeric comparison
	const an = toNum(a);
	const bn = toNum(b);
	if (an !== null && bn !== null) return an - bn;

	// Date comparison — use parseDate (ms timestamp)
	const ad = parseDate(a);
	const bd = parseDate(b);
	if (ad !== null && bd !== null) return ad - bd;

	// Case-insensitive string comparison
	return a.toLowerCase().localeCompare(b.toLowerCase());
}

function sortRows(
	data: Record<string, string>[],
	clauses: SortClause[],
	columns: string[]
): Record<string, string>[] {
	const resolved = clauses.map(c => ({
		col: resolveColumn(c.column, columns) ?? c.column,
		dir: c.direction
	}));

	return [...data].sort((a, b) => {
		for (const { col, dir } of resolved) {
			const av = a[col] ?? '';
			const bv = b[col] ?? '';
			const cmp = compareValues(av, bv);
			if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
		}
		return 0;
	});
}

/**
 * Sort a dataset by one or more columns and return an OperationResult.
 * Exported so analysis.ts can call it directly for sort_rows intent.
 *
 * - Clones data before sorting (never mutates input)
 * - Resolves columns via fuzzy matching
 * - Applies sort clauses in order (next clause breaks ties)
 * - Applies limit after sorting if provided
 */
export function executeSort(
	data: Record<string, string>[],
	op: { columns: SortClause[]; limit?: number }
): OperationResult {
	if (data.length === 0) {
		return { type: 'error', message: 'Dataset is empty.' };
	}
	const allColumns = getColumns(data);

	// Validate that at least one sort column resolves
	const resolvedClauses = op.columns
		.map(c => ({ ...c, column: resolveColumn(c.column, allColumns) ?? c.column }))
		.filter(c => allColumns.includes(c.column));

	if (resolvedClauses.length === 0) {
		return unknownColumnError(op.columns[0]?.column ?? '?', allColumns);
	}

	const sorted = sortRows(data, resolvedClauses, allColumns);
	const limited = op.limit != null && op.limit > 0
		? sorted.slice(0, op.limit)
		: sorted;

	return {
		type: 'rows',
		data: limited,
		columns: allColumns,
		totalCount: data.length
	};
}

// ============================================================
// executeOnRows — single-sheet row dispatch
// ============================================================

/**
 * Execute a single-sheet {@link DataOperation} against an in-memory array of
 * row objects.
 *
 * This is the low-level executor. It is sheet-agnostic — it just receives rows.
 * Sheet routing and cross-sheet handling live in {@link executeOperation}
 * (the workbook-aware entry point). It remains exported so streaming callers
 * (e.g. the chat query path) that already hold a row buffer can use it directly
 * without constructing a full `Workbook`.
 */
export function executeOnRows(
	data: Record<string, string>[],
	op: DataOperation
): OperationResult {
	// Empty dataset guard
	if (data.length === 0) {
		return { type: 'error', message: 'Dataset is empty.' };
	}

	const columns = getColumns(data);

	switch (op.type) {

		// ----------------------------------------------------------
		case 'aggregate': {
			const col = resolveColumn(op.column, columns);
			if (!col) return unknownColumnError(op.column, columns);

			let rows = data;
			if (op.filters?.length) {
				rows = applyFilters(rows, op.filters, columns);
			}

			if (op.groupBy) {
				const groupCol = resolveColumn(op.groupBy, columns);
				if (!groupCol) return unknownColumnError(op.groupBy, columns);

				// Group rows by groupBy column, compute aggregate per group
				const groups = new Map<string, Record<string, string>[]>();
				for (const row of rows) {
					const key = toStr(row[groupCol]);
					if (!groups.has(key)) groups.set(key, []);
					groups.get(key)!.push(row);
				}

				const grouped: Record<string, { alias: string; value: number }[]> = {};
				for (const [key, groupRows] of groups) {
					const values = computeNumericValues(groupRows, col);
					const result = computeAggregate(values, op.function);
					grouped[key] = [{
						alias: `${op.function}(${col})`,
						value: result ?? 0
					}];
				}
				return { type: 'grouped', data: grouped };
			}

			// Scalar aggregate
			const values = op.function === 'count'
				? [] // count uses row count, not numeric values
				: computeNumericValues(rows, col);

			const value = op.function === 'count'
				? rows.length
				: computeAggregate(values, op.function);

			return {
				type: 'scalar',
				value,
				label: `${op.function}(${col})`
			};
		}

		// ----------------------------------------------------------
		case 'filter': {
			let rows = applyFilters(data, op.filters, columns);

			if (op.sort) {
				rows = sortRows(rows, [op.sort], columns);
			}

			const totalCount = rows.length;

			if (op.limit != null && op.limit > 0) {
				rows = rows.slice(0, op.limit);
			}

			const resultColumns = op.columns
				? op.columns.map(c => resolveColumn(c, columns) ?? c).filter(c => columns.includes(c))
				: columns;

			const projected = rows.map(row => {
				const out: Record<string, string> = {};
				for (const c of resultColumns) out[c] = row[c] ?? '';
				return out;
			});

			return {
				type: 'rows',
				data: projected,
				columns: resultColumns,
				totalCount
			};
		}

		// ----------------------------------------------------------
		case 'sort': {
			return executeSort(data, op);
		}

		// ----------------------------------------------------------
		case 'group': {
			const groupCol = resolveColumn(op.column, columns);
			if (!groupCol) return unknownColumnError(op.column, columns);

			// Validate aggregate columns
			for (const agg of op.aggregates) {
				const aggCol = resolveColumn(agg.column, columns);
				if (!aggCol) return unknownColumnError(agg.column, columns);
			}

			// Group rows
			const groups = new Map<string, Record<string, string>[]>();
			for (const row of data) {
				const key = toStr(row[groupCol]);
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key)!.push(row);
			}

			const grouped: Record<string, { alias: string; value: number }[]> = {};
			for (const [key, groupRows] of groups) {
				const aggResults: { alias: string; value: number }[] = [];
				for (const agg of op.aggregates) {
					const aggCol = resolveColumn(agg.column, columns)!;
					const values = agg.function === 'count'
						? []
						: computeNumericValues(groupRows, aggCol);
					const value = agg.function === 'count'
						? groupRows.length
						: (computeAggregate(values, agg.function) ?? 0);
					aggResults.push({
						alias: agg.alias ?? `${agg.function}(${aggCol})`,
						value
					});
				}
				grouped[key] = aggResults;
			}

			return { type: 'grouped', data: grouped };
		}

		// ----------------------------------------------------------
		case 'compare': {
			const col = resolveColumn(op.column, columns);
			if (!col) return unknownColumnError(op.column, columns);
			const byCol = resolveColumn(op.by, columns);
			if (!byCol) return unknownColumnError(op.by, columns);

			// Group by "by" column, aggregate "column" per group
			const groups = new Map<string, Record<string, string>[]>();
			for (const row of data) {
				const key = toStr(row[byCol]);
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key)!.push(row);
			}

			const result: Record<string, number> = {};
			for (const [key, groupRows] of groups) {
				const values = op.function === 'count'
					? []
					: computeNumericValues(groupRows, col);
				const value = op.function === 'count'
					? groupRows.length
					: (computeAggregate(values, op.function) ?? 0);
				result[key] = value;
			}

			return {
				type: 'comparison',
				data: result,
				column: col,
				by: byCol
			};
		}

		// ----------------------------------------------------------
		case 'trend': {
			const col = resolveColumn(op.column, columns);
			if (!col) return unknownColumnError(op.column, columns);
			const overCol = resolveColumn(op.over, columns);
			if (!overCol) return unknownColumnError(op.over, columns);

			// Sort by "over" column
			const sorted = sortRows(data, [{ column: overCol, direction: 'asc' }], columns);

			// Group by "over" column, aggregate "column" per group
			const groups = new Map<string, Record<string, string>[]>();
			for (const row of sorted) {
				const key = toStr(row[overCol]);
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key)!.push(row);
			}

			const trendData: Record<string, unknown>[] = [];
			for (const [key, groupRows] of groups) {
				const values = computeNumericValues(groupRows, col);
				const value = computeAggregate(values, op.function);
				trendData.push({ [overCol]: key, [col]: value });
			}

			return { type: 'trend', data: trendData };
		}

		// ----------------------------------------------------------
		case 'top_n':
		case 'bottom_n': {
			const n = op.n;
			const col = resolveColumn(op.column, columns);
			if (!col) return unknownColumnError(op.column, columns);

			if (op.by) {
				// Aggregate "column" grouped by "by", then rank
				const byCol = resolveColumn(op.by, columns);
				if (!byCol) return unknownColumnError(op.by, columns);

				const groups = new Map<string, Record<string, string>[]>();
				for (const row of data) {
					const key = toStr(row[byCol]);
					if (!groups.has(key)) groups.set(key, []);
					groups.get(key)!.push(row);
				}

				const entries: { category: string; value: number }[] = [];
				for (const [key, groupRows] of groups) {
					const values = computeNumericValues(groupRows, col);
					const value = computeAggregate(values, 'sum') ?? 0;
					entries.push({ category: key, value });
				}

				entries.sort((a, b) =>
					op.type === 'top_n' ? b.value - a.value : a.value - b.value
				);

				return { type: 'top_n', data: entries.slice(0, n) };
			} else {
				// Rank rows directly by the column value
				const withValues = data
					.map(row => ({ row, value: toNum(row[col]) }))
					.filter(({ value }) => value !== null) as { row: Record<string, string>; value: number }[];

				withValues.sort((a, b) =>
					op.type === 'top_n' ? b.value - a.value : a.value - b.value
				);

				const top = withValues.slice(0, n).map(({ row, value }) => ({
					category: toStr(row[col]),
					value
				}));

				return { type: 'top_n', data: top };
			}
		}

		// ----------------------------------------------------------
		case 'correlation': {
			const colA = resolveColumn(op.column_a, columns);
			if (!colA) return unknownColumnError(op.column_a, columns);
			const colB = resolveColumn(op.column_b, columns);
			if (!colB) return unknownColumnError(op.column_b, columns);

			// Collect paired numeric values (skip rows where either is null)
			const pairs: [number, number][] = [];
			for (const row of data) {
				const a = toNum(row[colA]);
				const b = toNum(row[colB]);
				if (a !== null && b !== null) pairs.push([a, b]);
			}

			if (pairs.length < 2) {
				return {
					type: 'scalar',
					value: null,
					label: `correlation(${colA}, ${colB})`
				};
			}

			// Pearson correlation coefficient
			const n = pairs.length;
			const sumA = pairs.reduce((s, [a]) => s + a, 0);
			const sumB = pairs.reduce((s, [, b]) => s + b, 0);
			const meanA = sumA / n;
			const meanB = sumB / n;

			let num = 0, denomA = 0, denomB = 0;
			for (const [a, b] of pairs) {
				const da = a - meanA;
				const db = b - meanB;
				num += da * db;
				denomA += da * da;
				denomB += db * db;
			}

			const denom = Math.sqrt(denomA * denomB);
			const r = denom === 0 ? null : num / denom;

			return {
				type: 'scalar',
				value: r !== null ? Math.round(r * 10000) / 10000 : null,
				label: `correlation(${colA}, ${colB})`
			};
		}

		// ----------------------------------------------------------
		case 'distribution': {
			const col = resolveColumn(op.column, columns);
			if (!col) return unknownColumnError(op.column, columns);

			const values = computeNumericValues(data, col);
			if (values.length === 0) {
				return { type: 'distribution', data: [] };
			}

			const bins = op.bins ?? Math.max(2, Math.round(Math.sqrt(values.length)));
			const min = Math.min(...values);
			const max = Math.max(...values);

			if (min === max) {
				// All values identical — single bin
				return {
					type: 'distribution',
					data: [{ bin: String(min), count: values.length }]
				};
			}

			const binWidth = (max - min) / bins;
			const counts = new Array<number>(bins).fill(0);

			for (const v of values) {
				let idx = Math.floor((v - min) / binWidth);
				if (idx >= bins) idx = bins - 1; // clamp max value into last bin
				counts[idx]++;
			}

			const distData = counts.map((count, i) => {
				const lo = min + i * binWidth;
				const hi = lo + binWidth;
				return {
					bin: `${Math.round(lo * 100) / 100}–${Math.round(hi * 100) / 100}`,
					count
				};
			});

			return { type: 'distribution', data: distData };
		}

		// ----------------------------------------------------------
		case 'describe': {
			const targetCols = op.columns
				? op.columns.map(c => resolveColumn(c, columns) ?? c).filter(c => columns.includes(c))
				: columns;

			const descData: Record<string, ColumnStats> = {};

			for (const col of targetCols) {
				const rawValues = data.map(row => row[col] ?? '');
				const nonEmpty = rawValues.filter(v => v !== '' && v !== null && v !== undefined);
				const nulls = rawValues.length - nonEmpty.length;
				const unique = new Set(nonEmpty).size;

				// Detect column type
				const numericValues: number[] = [];
				let isNumeric = true;
				let isInteger = true;
				let isDate = true;

				for (const v of nonEmpty) {
					const n = toNum(v);
					if (n === null) {
						isNumeric = false;
						isInteger = false;
					} else {
						numericValues.push(n);
						if (!Number.isInteger(n)) isInteger = false;
					}
					if (parseDate(v) === null) isDate = false;
				}

				// Determine type
				let colType: ColumnStats['type'];
				if (isNumeric && nonEmpty.length > 0) {
					colType = isInteger ? 'integer' : 'number';
				} else if (isDate && nonEmpty.length > 0) {
					colType = 'date';
				} else if (unique <= Math.min(50, nonEmpty.length * 0.5) && nonEmpty.length > 0) {
					colType = 'category';
				} else {
					colType = 'string';
				}

				const stats: ColumnStats = {
					type: colType,
					count: nonEmpty.length,
					unique,
					nulls
				};

				if (colType === 'number' || colType === 'integer') {
					stats.min = numericValues.length > 0 ? Math.min(...numericValues) : undefined;
					stats.max = numericValues.length > 0 ? Math.max(...numericValues) : undefined;
					stats.sum = numericValues.reduce((a, b) => a + b, 0);
					stats.mean = numericValues.length > 0 ? stats.sum / numericValues.length : undefined;

					// Median
					if (numericValues.length > 0) {
						const sorted = [...numericValues].sort((a, b) => a - b);
						const mid = Math.floor(sorted.length / 2);
						stats.median = sorted.length % 2 === 0
							? (sorted[mid - 1] + sorted[mid]) / 2
							: sorted[mid];
					}

					// Stddev (sample)
					if (numericValues.length >= 2) {
						const mean = stats.mean!;
						const variance = numericValues.reduce((s, v) => s + (v - mean) ** 2, 0) / (numericValues.length - 1);
						stats.stddev = Math.sqrt(variance);
					}
				} else if (colType === 'date') {
					const timestamps = nonEmpty.map(v => parseDate(v)!).filter(t => t !== null);
					if (timestamps.length > 0) {
						stats.min = new Date(Math.min(...timestamps)).toISOString().slice(0, 10);
						stats.max = new Date(Math.max(...timestamps)).toISOString().slice(0, 10);
					}
				} else {
					// category / string — compute top values
					const freq = new Map<string, number>();
					for (const v of nonEmpty) {
						freq.set(v, (freq.get(v) ?? 0) + 1);
					}
					stats.top = [...freq.entries()]
						.sort((a, b) => b[1] - a[1])
						.slice(0, 10)
						.map(([value, count]) => ({ value, count }));

					if (nonEmpty.length > 0) {
						const sorted = [...nonEmpty].sort();
						stats.min = sorted[0];
						stats.max = sorted[sorted.length - 1];
					}
				}

				descData[col] = stats;
			}

			return { type: 'describe', data: descData };
		}

		// ----------------------------------------------------------
		case 'answer': {
			// Pass-through — the caller (LLM layer) handles this
			return {
				type: 'answer',
				question: op.question,
				context: op.context
			};
		}

		// ----------------------------------------------------------
		case 'crossSheet': {
			// Cross-sheet operations span two sheets and cannot be executed by
			// this single-sheet engine (which receives one sheet's rows). They
			// are resolved by the higher-level workbook layer, which fetches both
			// sheets before delegating. Reaching here means a crossSheet op was
			// routed to the single-sheet executor by mistake.
			return {
				type: 'error',
				message: `Cross-sheet operations (${op.sheetA}.${op.columnA} ↔ ${op.sheetB}.${op.columnB}) must be executed by the workbook layer, not the single-sheet engine.`
			};
		}

		// ----------------------------------------------------------
		default: {
			const exhaustive: never = op;
			return {
				type: 'error',
				message: `Unknown operation type: ${(exhaustive as DataOperation).type}`
			};
		}
	}
}

// ============================================================
// executeOperation — workbook-aware entry point
// ============================================================

/**
 * Resolve a sheet from a workbook by name. When `name` is undefined, returns
 * the first sheet (the default target — for a CSV this is the only sheet).
 * Throws a descriptive error if the named sheet does not exist.
 */
function resolveSheet(wb: Workbook, name?: string): Sheet {
	const sheet = name ? wb.sheets.find((s) => s.name === name) : wb.sheets[0];
	if (!sheet) {
		const available = wb.sheets.map((s) => s.name).join(', ');
		throw new Error(`Sheet "${name}" not found. Available sheets: ${available}`);
	}
	return sheet;
}

/**
 * Validate that every referenced column exists in the target sheet's headers.
 * Throws a descriptive error naming the offending column and the sheet.
 */
function validateColumns(sheet: Sheet, columns: string[]): void {
	for (const col of columns) {
		if (resolveColumn(col, sheet.headers) === null) {
			throw new Error(
				`Column "${col}" not found in sheet "${sheet.name}". Available columns: ${sheet.headers.join(', ')}`
			);
		}
	}
}

/**
 * Collect the column references a single-sheet operation depends on, so they
 * can be validated up-front against the target sheet's headers.
 */
function operationColumnRefs(op: Exclude<DataOperation, CrossSheetOperation>): string[] {
	switch (op.type) {
		case 'aggregate':
			return [op.column, ...(op.groupBy ? [op.groupBy] : []), ...(op.filters?.map((f) => f.column) ?? [])];
		case 'filter':
			return [...op.filters.map((f) => f.column), ...(op.columns ?? []), ...(op.sort ? [op.sort.column] : [])];
		case 'sort':
			return op.columns.map((c) => c.column);
		case 'group':
			return [op.column, ...op.aggregates.map((a) => a.column)];
		case 'compare':
			return [op.column, op.by];
		case 'trend':
			return [op.column, op.over];
		case 'top_n':
		case 'bottom_n':
			return [op.column, ...(op.by ? [op.by] : [])];
		case 'correlation':
			return [op.column_a, op.column_b];
		case 'distribution':
			return [op.column];
		case 'describe':
			return op.columns ?? [];
		case 'answer':
			return [];
		default: {
			const _exhaustive: never = op;
			return _exhaustive;
		}
	}
}

/**
 * Workbook-aware operation entry point.
 *
 * Routes the operation to the correct sheet (via `op.sheet`, defaulting to the
 * first sheet), validates all referenced columns against that sheet's headers,
 * then delegates to {@link executeOnRows}. Cross-sheet operations are routed to
 * {@link executeCrossSheet}.
 *
 * Throws descriptive errors for unknown sheets / columns (caller may catch and
 * convert to an ErrorResult if it prefers a non-throwing path).
 */
export function executeOperation(op: DataOperation, wb: Workbook): OperationResult {
	if (op.type === 'crossSheet') {
		return executeCrossSheet(op, wb);
	}

	const sheet = resolveSheet(wb, op.sheet);
	validateColumns(sheet, operationColumnRefs(op));
	return executeOnRows(sheet.rows, op);
}

// ============================================================
// executeCrossSheet — cross-sheet correlation
// ============================================================

/**
 * Execute a cross-sheet correlation between a column in sheet A and a column in
 * sheet B.
 *
 * Row matching strategy:
 *   - If both sheets share a column whose (fuzzy-resolved) name matches `columnA`
 *     AND `columnB` is NOT that key — we still default to positional (index)
 *     matching unless an explicit common key is detectable. To keep the contract
 *     simple and deterministic, this implementation matches rows by INDEX
 *     (same order) by default. If the two sheets share a common key column
 *     (a header present in both sheets, other than the value columns), rows are
 *     joined on that key instead.
 *   - Only pairs where BOTH values parse as numbers are included.
 *
 * Returns a Pearson correlation coefficient plus scatter-plot data (the matched
 * [x, y] pairs) so the UI can render a scatter chart.
 */
export function executeCrossSheet(op: CrossSheetOperation, wb: Workbook): OperationResult {
	const sheetA = resolveSheet(wb, op.sheetA);
	const sheetB = resolveSheet(wb, op.sheetB);

	// Validate the referenced value columns against each sheet's headers.
	const colA = resolveColumn(op.columnA, sheetA.headers);
	if (!colA) {
		throw new Error(
			`Column "${op.columnA}" not found in sheet "${sheetA.name}". Available columns: ${sheetA.headers.join(', ')}`
		);
	}
	const colB = resolveColumn(op.columnB, sheetB.headers);
	if (!colB) {
		throw new Error(
			`Column "${op.columnB}" not found in sheet "${sheetB.name}". Available columns: ${sheetB.headers.join(', ')}`
		);
	}

	// Detect a common key column shared by both sheets (other than the value
	// columns themselves). If found, join on it; otherwise match by index.
	let commonKeyA: string | null = null;
	let commonKeyB: string | null = null;
	for (const header of sheetA.headers) {
		if (header === colA) continue;
		const match = resolveColumn(header, sheetB.headers);
		if (match && match !== colB) {
			commonKeyA = header;
			commonKeyB = match;
			break;
		}
	}

	// Build matched numeric pairs.
	const pairs: { x: number; y: number; key?: string }[] = [];

	if (commonKeyA && commonKeyB) {
		// Key-based join: index sheet B rows by their key value.
		const indexB = new Map<string, Record<string, string>>();
		for (const row of sheetB.rows) {
			const key = toStr(row[commonKeyB]);
			if (key !== '' && !indexB.has(key)) indexB.set(key, row);
		}
		for (const rowA of sheetA.rows) {
			const key = toStr(rowA[commonKeyA]);
			const rowB = indexB.get(key);
			if (!rowB) continue;
			const x = toNum(rowA[colA]);
			const y = toNum(rowB[colB]);
			if (x !== null && y !== null) pairs.push({ x, y, key });
		}
	} else {
		// Positional (index) match: same order, paired by row index.
		const len = Math.min(sheetA.rows.length, sheetB.rows.length);
		for (let i = 0; i < len; i++) {
			const x = toNum(sheetA.rows[i][colA]);
			const y = toNum(sheetB.rows[i][colB]);
			if (x !== null && y !== null) pairs.push({ x, y });
		}
	}

	const label = `correlation(${sheetA.name}.${colA}, ${sheetB.name}.${colB})`;

	if (pairs.length < 2) {
		return {
			type: 'crossSheet',
			label,
			correlation: null,
			matchStrategy: commonKeyA ? 'key' : 'index',
			matchKey: commonKeyA ?? undefined,
			pairCount: pairs.length,
			scatter: pairs
		};
	}

	// Pearson correlation coefficient over the matched pairs.
	const n = pairs.length;
	const meanX = pairs.reduce((s, p) => s + p.x, 0) / n;
	const meanY = pairs.reduce((s, p) => s + p.y, 0) / n;

	let num = 0;
	let denomX = 0;
	let denomY = 0;
	for (const { x, y } of pairs) {
		const dx = x - meanX;
		const dy = y - meanY;
		num += dx * dy;
		denomX += dx * dx;
		denomY += dy * dy;
	}

	const denom = Math.sqrt(denomX * denomY);
	const r = denom === 0 ? null : num / denom;

	return {
		type: 'crossSheet',
		label,
		correlation: r !== null ? Math.round(r * 10000) / 10000 : null,
		matchStrategy: commonKeyA ? 'key' : 'index',
		matchKey: commonKeyA ?? undefined,
		pairCount: n,
		scatter: pairs
	};
}
