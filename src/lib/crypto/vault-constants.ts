/**
 * src/lib/crypto/vault-constants.ts — shared constants for the "vault"
 * feature: encrypting an unsupported file type for safekeeping, and
 * decrypting an oversized `.cesvu` straight to disk instead of trying to
 * open it in the in-app viewer.
 *
 * Single source of truth for the supported-viewer extension allow-list (kept
 * in sync with `src/lib/parsers/index.ts`'s `detectType()` and
 * `FileDropzone.svelte`'s default `acceptedTypes`) and the import-side
 * size threshold.
 */

/** Extensions the in-app viewer can actually open. Anything else dropped
 *  onto the app is a candidate for the encrypt-to-vault flow instead of the
 *  normal parse pipeline. */
export const VAULT_SUPPORTED_EXTENSIONS = [
	'xlsx',
	'xls',
	'csv',
	'tsv',
	'pdf',
	'docx',
	'txt',
	'md'
] as const;

const VAULT_SUPPORTED_EXTENSION_SET = new Set<string>(VAULT_SUPPORTED_EXTENSIONS);

/** Extract the lowercase extension (no dot) from a filename, or ''. */
function extensionOf(name: string): string {
	const idx = name.lastIndexOf('.');
	if (idx < 0 || idx === name.length - 1) return '';
	return name.slice(idx + 1).toLowerCase();
}

/**
 * True when `file` is NOT one of the viewer-supported types — i.e. it's a
 * candidate for the "encrypt this file into a .cesvu vault" flow rather
 * than the normal parse pipeline.
 */
export function isVaultCandidate(file: File): boolean {
	const ext = extensionOf(file.name);
	if (VAULT_SUPPORTED_EXTENSION_SET.has(ext)) return false;
	return true;
}

/**
 * Size cutoff (bytes) above which a dropped `.cesvu` file is routed to the
 * "decrypt straight to disk" flow instead of the normal in-memory unlock +
 * viewer flow. 256 MiB.
 */
export const VAULT_IMPORT_STREAM_THRESHOLD_BYTES = 256 * 1024 * 1024;
