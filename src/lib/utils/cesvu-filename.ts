/**
 * cesvu-filename.ts — shared helper for building the OUTER (on-disk)
 * filename of a downloaded/saved `.cesvu` file from an original filename.
 *
 * Zero-knowledge design note: the original filename + extension are always
 * encrypted INSIDE the `.cesvu` envelope's metadata (see CesvuMetadata /
 * cli.py's cmd_decrypt), so they're protected by the passphrase. But the
 * OUTER filename — what a mail client, cloud drive, or Finder/Explorer
 * window shows before anyone even enters a passphrase — is NOT protected
 * by anything. Naming a download "quarterly-layoffs-plan.xlsx.cesvu"
 * leaks both the subject matter (via the base name) and the file type
 * (via the embedded extension) to anyone who merely sees the file sitting
 * in a downloads folder or inbox, undermining the "we never learn
 * anything about your data" pitch of a zero-knowledge product.
 *
 * The chosen middle ground (see project discussion): keep the original
 * base name (still somewhat identifying, but genuinely useful so multiple
 * exports don't all collide under one generic name and so the sender can
 * tell them apart later), but ALWAYS strip the original extension before
 * appending ".cesvu" — so `document.txt` becomes `document.cesvu`, never
 * the doubled `document.txt.cesvu`. This is used consistently by:
 *   - vault-io.ts's exportRawFileToVault (vault save/download name)
 *   - the Python CLI's cmd_encrypt (see cli.py, mirrors this same logic)
 *
 * NOTE: ExportModal.svelte (the in-viewer document export) deliberately
 * does NOT use the derive-from-original-name behavior. It always emits the
 * generic DEFAULT_CESVU_DOWNLOAD_NAME below, because that download is the
 * artifact users actually send to other people, so even the base name is
 * worth withholding. See exportFileName() there.
 */

/**
 * The generic outer filename used when no original name is available (and,
 * for the viewer's document export, unconditionally). Anything the
 * recipient legitimately needs — the real filename and extension — travels
 * encrypted inside the envelope's metadata instead.
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
