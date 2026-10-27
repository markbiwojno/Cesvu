/**
 * vault-modal-phases.ts — single source of truth for "which modal phases
 * represent an in-flight, disruptive encrypt/write operation that must not
 * be dismissible" (backdrop click, Escape, or the header ✕ button — see
 * Modal.svelte's `dismissible` prop doc comment).
 *
 * This exists because SecureSaveModal.svelte, ExportModal.svelte, and
 * SendBackModal.svelte each wire their own `dismissible={...}` expression
 * against their own local `phase` string union, and it is very easy for a
 * refactor that splits or renames a phase (e.g. SecureSaveModal.svelte
 * splitting a single "generating" phase into "generating" + "saving", where
 * "saving" is the phase that actually calls `writeVaultFile`/does the real
 * I/O) to silently leave the new phase out of the guard, re-opening a hole
 * where a user can click away mid-encrypt and abandon the operation with no
 * way to resume it. Centralizing the phase list here, backed by a unit
 * test enumerating every phase name across all three modals, makes that
 * class of regression fail a test instead of shipping silently.
 */

/**
 * Phases across ExportModal.svelte / SecureSaveModal.svelte /
 * SendBackModal.svelte during which a real encrypt/write operation is
 * actively in flight. The modal must be non-dismissible for every phase in
 * this set.
 *
 * - 'generating' — used by all three: the actual encrypt call is in flight
 *   (ExportModal/SendBackModal do the whole encrypt here; SecureSaveModal
 *   uses this phase ONLY for the cheap passphrase-generation step, but it's
 *   still safest to keep it non-dismissible since it feeds directly into
 *   'saving').
 * - 'saving' — SecureSaveModal.svelte only: the actual streaming
 *   encrypt + disk write (`writeVaultFile`) is in flight.
 * - 'sharing' — ExportModal.svelte only: the Web Share API flow
 *   (ShareSheet.svelte) is active, including its non-dismissible success
 *   banner — a backdrop click/Escape/✕ here would abandon a share the OS
 *   sheet may already be mid-flight on, or silently drop the "send your
 *   passcode separately" reminder before the user has acted on it.
 */
const BLOCKING_VAULT_PHASES: ReadonlySet<string> = new Set(['generating', 'saving', 'sharing']);

/**
 * True when a modal in the given phase may be dismissed (backdrop click,
 * Escape, header ✕). False while a real encrypt/write is in flight.
 */
export function isDismissiblePhase(phase: string): boolean {
	return !BLOCKING_VAULT_PHASES.has(phase);
}
