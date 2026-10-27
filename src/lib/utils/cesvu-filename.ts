/**
 * cesvu-filename.ts — shared helper for building the OUTER (on-disk)
 * filename of a downloaded/saved `.cesvu` file from an original filename.
 *
 * Design note: the original filename + extension travel INSIDE the
 * `.cesvu` file's metadata (see CesvuMetadata), separate from the OUTER
 * filename — what a mail client, cloud drive, or Finder/Explorer window
 * shows. ExportModal.svelte's document export always emits the generic
 * DEFAULT_CESVU_DOWNLOAD_NAME below rather than deriving a name from the
 * document, so multiple exports don't collide and the artifact handed to
 * another person doesn't editorialize the subject matter in its filename.
 * See exportFileName() in ExportModal.svelte.
 */

/**
 * The generic outer filename used when no original name is available (and,
 * for the viewer's document export, unconditionally). The real filename
 * and extension travel inside the file's metadata instead.
 */
export const DEFAULT_CESVU_DOWNLOAD_NAME = 'cesvu-document.cesvu';

/**
 * OUTER NAMES ONLY. Do NOT reuse this for a filename being RESTORED from
 * a decrypted envelope's `metadata.filename` (see ImportModal.svelte).
 * The two names have opposite requirements:
 *
 *   - the OUTER `.cesvu` name should disclose as little as possible, so
 *     dropping the original extension is correct here (that's the whole
 *     point: `document.txt` -> `document.cesvu`);
 *   - a RESTORED name should be reproduced as faithfully as possible,
 *     because giving the user back their real file is the feature.
 *
 * Applied to a restored name this helper actively destroys information:
 * `quarterly-report.pdf` -> `quarterly-report` (extension gone) and
 * `契約書.pdf` -> `_` (the `\w` class is ASCII-only). One function cannot
 * serve both directions.
 *
 * Strip one trailing "path-like" extension from `base` and sanitize the
 * result to characters safe across filesystems (Windows/macOS/Linux
 * alike), returning a "" if nothing safe remains.

 *
 * - Any path separators (both `/` and `\`) are stripped first, keeping
 *   only the last path segment — so an accidentally path-shaped
 *   `name` (e.g. from untrusted embedded metadata) can never smuggle
 *   directory components into the result.
 * - A dotfile with no other content (e.g. ".gitignore") is treated as
 *   having NO extension to strip — there's no meaningful base name to
 *   pair an extension with in that case.
 * - Disallowed characters are replaced with `_`.
 */
function sanitizeBaseName(name: string): string {
	const lastSegment = name.replace(/\\/g, '/').split('/').pop() ?? name;
	const trimmed = lastSegment.trim();
	// A dot exists AND it's not the leading character (so ".gitignore"
	// keeps its full name rather than losing everything to "").
	const dotIdx = trimmed.lastIndexOf('.');
	const withoutExt = dotIdx > 0 ? trimmed.slice(0, dotIdx) : trimmed;
	return withoutExt.replace(/[^\w.\- ]+/g, '_').trim();
}

/**
 * Build the outer `.cesvu` filename for a document/file whose original
 * name is `originalName` (e.g. "quarterly-report.pdf" -> "quarterly-
 * report.cesvu"). Falls back to `fallback` (default:
 * "cesvu-document.cesvu") when `originalName` is missing/empty or
 * nothing safe remains after sanitizing.
 */
export function buildCesvuDownloadName(
	originalName: string | null | undefined,
	fallback: string = DEFAULT_CESVU_DOWNLOAD_NAME
): string {
	if (!originalName) return fallback;
	const safe = sanitizeBaseName(originalName);
	if (!safe) return fallback;
	return `${safe}.cesvu`;
}
