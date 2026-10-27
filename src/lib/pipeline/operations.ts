/**
 * src/lib/pipeline/operations.ts — Type definitions for the CSV analysis engine
 *
 * Pure type definitions only. No runtime code.
 * All types are exported for use by the query engine, executor, and UI components.
 */

// ============================================================
// Filter
// ============================================================

export type FilterOperator =
	| 'eq'
	| 'neq'
	| 'gt'
	| 'gte'
	| 'lt'
	| 'lte'
	| 'contains'
	| 'starts_with'
	| 'in'
	| 'between';

export interface Filter {
	column: string;
	op: FilterOperator;
	value: string | number | string[] | [number, number];
}

// ============================================================
// SortClause
// ============================================================

export interface SortClause {
	column: string;
	direction: 'asc' | 'desc';
}

// ============================================================
// DataOperation — discriminated union by `type`
// ============================================================

export type AggregateFunction = 'sum' | 'avg' | 'min' | 'max' | 'count' | 'median' | 'stddev';

/**
 * Mixin for sheet-scoped operations (multi-sheet workbook support).
 *
 * Every single-sheet `DataOperation` carries an optional `sheet` name. When
 * omitted, the engine operates on the **first sheet** of the workbook (which,
 * for a CSV, is the only sheet — so existing single-sheet behavior is
 * unchanged and fully backward compatible).
 */
export interface SheetScoped {
	/** Sheet/tab name to operate on. Omit to use the first sheet. */
	sheet?: string;
}

export interface AggregateOperation extends SheetScoped {
	type: 'aggregate';
	function: AggregateFunction;
	column: string;
	filters?: Filter[];
	groupBy?: string;
}

export interface FilterOperation extends SheetScoped {
	type: 'filter';
	filters: Filter[];
	columns?: string[];
	sort?: SortClause;
	limit?: number;
}

export interface SortOperation extends SheetScoped {
	type: 'sort';
	columns: SortClause[];
	limit?: number;
}

export interface GroupOperation extends SheetScoped {
	type: 'group';
	column: string;
	aggregates: {
		function: string;
		column: string;
		alias?: string;
	}[];
}

export interface CompareOperation extends SheetScoped {
	type: 'compare';
	column: string;
	by: string;
	function: 'sum' | 'avg' | 'count';
}

export interface TrendOperation extends SheetScoped {
	type: 'trend';
	column: string;
	over: string;
	function: 'sum' | 'avg';
}

export interface TopNOperation extends SheetScoped {
	type: 'top_n';
	n: number;
	column: string;
	by?: string;
}

export interface BottomNOperation extends SheetScoped {
	type: 'bottom_n';
	n: number;
	column: string;
	by?: string;
}

export interface CorrelationOperation extends SheetScoped {
	type: 'correlation';
	column_a: string;
	column_b: string;
}

export interface DistributionOperation extends SheetScoped {
	type: 'distribution';
	column: string;
	bins?: number;
}

export interface DescribeOperation extends SheetScoped {
	type: 'describe';
	columns?: string[];
}

export interface AnswerOperation extends SheetScoped {
	type: 'answer';
	question: string;
	context: string;
}

/**
 * Cross-sheet operation — relates a column in one sheet to a column in
 * another (e.g. join/lookup/correlation across two tabs of a workbook).
 *
 * Unlike the single-sheet operations above, this one names BOTH sheets
 * explicitly, so it does not extend {@link SheetScoped}.
 */
export interface CrossSheetOperation {
	type: 'crossSheet';
	sheetA: string;
	columnA: string;
	sheetB: string;
	columnB: string;
}

export type DataOperation =
	| AggregateOperation
	| FilterOperation
	| SortOperation
	| GroupOperation
	| CompareOperation
	| TrendOperation
	| TopNOperation
	| BottomNOperation
	| CorrelationOperation
	| DistributionOperation
	| DescribeOperation
	| AnswerOperation
	| CrossSheetOperation;

// ============================================================
// ColumnStats
// ============================================================

export interface ColumnStats {
	type: 'number' | 'integer' | 'date' | 'category' | 'string';
	count: number;
	unique: number;
	nulls: number;
	min?: number | string;
	max?: number | string;
	mean?: number;
	median?: number;
	sum?: number;
	stddev?: number;
	top?: {
		value: string;
		count: number;
	}[];
}

// ============================================================
// OperationResult — discriminated union by `type`
// ============================================================

export interface ScalarResult {
	type: 'scalar';
	value: number | null;
	label: string;
}

export interface RowsResult {
	type: 'rows';
	data: Record<string, string>[];
	columns?: string[];
	totalCount: number;
}

export interface GroupedResult {
	type: 'grouped';
	data: Record<string, { alias: string; value: number }[]>;
}

export interface ComparisonResult {
	type: 'comparison';
	data: Record<string, number>;
	column: string;
	by: string;
}

export interface TrendResult {
	type: 'trend';
	data: Record<string, unknown>[];
}

export interface TopNResult {
	type: 'top_n';
	data: {
		category: string;
		value: number;
	}[];
}

export interface DistributionResult {
	type: 'distribution';
	data: {
		bin: string;
		count: number;
	}[];
}

export interface DescribeResult {
	type: 'describe';
	data: Record<string, ColumnStats>;
}

export interface AnswerResult {
	type: 'answer';
	question: string;
	context: string;
}

export interface ErrorResult {
	type: 'error';
	message: string;
	availableColumns?: string[];
}

/**
 * Result of a {@link CrossSheetOperation} — a correlation between a column in
 * one sheet and a column in another, plus the matched pairs for scatter plots.
 */
export interface CrossSheetResult {
	type: 'crossSheet';
	/** Human-readable label, e.g. "correlation(Sales.revenue, Costs.spend)". */
	label: string;
	/** Pearson correlation coefficient, or null if it could not be computed. */
	correlation: number | null;
	/** How rows were paired: by a shared key column, or by row index. */
	matchStrategy: 'key' | 'index';
	/** The shared key column used when matchStrategy is 'key'. */
	matchKey?: string;
	/** Number of matched numeric pairs that contributed to the result. */
	pairCount: number;
	/** Matched [x, y] pairs for rendering a scatter plot. */
	scatter: { x: number; y: number; key?: string }[];
}

export type OperationResult =
	| ScalarResult
	| RowsResult
	| GroupedResult
	| ComparisonResult
	| TrendResult
	| TopNResult
	| DistributionResult
	| DescribeResult
	| AnswerResult
	| CrossSheetResult
	| ErrorResult;
