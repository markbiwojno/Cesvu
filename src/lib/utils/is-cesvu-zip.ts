/**
 * is-cesvu-zip.ts — decide whether a picked/dropped file is a Cesvu export
 * archive (to be routed into the import flow) rather than a source file.
 *
 * Detection is by CONTENT + generic `.zip` extension, NOT the `_cesvu.zip`
 * suffix. Browsers rename repeated downloads ("cesvu-document_cesvu (1).zip"),
 * and OSes/mail clients rename attachments, so the suffix is not reliable —
 * a renamed export used to fall through to the plain-text parser and show
 * garbled zip bytes.
 *
 * Office files (.docx/.xlsx) are zips too and start with the same magic
 * bytes, so the extension must be `.zip` as well; the manifest itself is
 * validated later by importFromCesvu().
 */

/** Zip local-file-header magic: "PK\x03\x04". */
export function hasZipMagic(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x50 &&
		bytes[1] === 0x4b &&
		bytes[2] === 0x03 &&
		bytes[3] === 0x04
	);
}

/** True when the file name ends in `.zip` (case-insensitive). */
export function hasZipExtension(name: string): boolean {
	return name.toLowerCase().endsWith('.zip');
}

/** True for a `.zip` file whose first bytes are the zip magic. */
export async function isCesvuZip(file: File): Promise<boolean> {
	if (!hasZipExtension(file.name)) return false;
	try {
		const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
		return hasZipMagic(head);
	} catch {
		return false;
	}
}
