/**
 * src/lib/config.ts — shared application limits / tunables
 *
 * Single source of truth for cross-cutting numeric limits so the CSV and Excel
 * paths stay symmetric. Import from here rather than redefining per-module.
 */

/**
 * Maximum number of data rows held in memory for DISPLAY and the chat query
 * buffer, per tabular file (CSV) or per sheet (Excel).
 *
 * This is a memory/performance ceiling, NOT an analysis limit:
 *   - CSV: column statistics are computed on EVERY streamed row (Welford), so
 *     stats always reflect the full file even when the display buffer is capped.
 *   - Excel: each sheet is profiled over its FULL row set in the worker BEFORE
 *     the display buffer is capped, so stats likewise reflect every row.
 *
 * When a file exceeds this cap the UI surfaces a banner:
 *   "Displaying X of Y rows · Stats reflect all rows"
 *
 * 250K × ~10 cols × ~50 bytes ≈ 125MB worst case. Revisit (adaptive cap or a
 * worker-backed query engine) only if users actually hit this and complain.
 */
export const MAX_DISPLAY_ROWS = 250_000;
