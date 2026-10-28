/**
 * Barrel for the export module.
 *
 * Consumers import from `$lib/export` (resolved to this file) rather than
 * reaching into `$lib/export/cesvu-export.js` directly. This keeps the
 * concrete filename an implementation detail and gives the build a single
 * stable entry point. `cesvu-export.ts` remains the single source of truth
 * for the `.cesvu` v2 container format — do NOT add format logic here.
 */
export * from './cesvu-export.js';
