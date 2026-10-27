/** APACHE 2.0 MODIFIED FILE! SEE BELOW FOR MORE DETAILS.
 * 
 * src/lib/utils/drag-drop.ts — shared drag-and-drop helpers.
 *
 * Browsers hand back a synthetic zero-byte `File` object (empty `type`,
 * `size: 0`, name = folder name) for a DRAGGED FOLDER, indistinguishable
 * from a real empty file by looking at `DataTransfer.files` alone. Left
 * unchecked, a dropped folder would sail through as a bogus zero-byte
 * "file" and confuse the upload/parse pipeline.
 *
 * The fix is to check `DataTransferItem.webkitGetAsEntry()` (despite the
 * name, standardized and supported across Chromium/Firefox/Safari) at
 * DROP TIME — it exposes a real `FileSystemEntry` with an authoritative
 * `.isDirectory` flag, before we ever touch `.files`.
 */

/** True if this drop event's payload includes at least one directory
 *  (folder), as opposed to only plain files. Must be called from within
 *  the `drop` event handler itself — `dataTransfer.items` are only valid
 *  synchronously during the event. */
export function dropContainsDirectory(e: DragEvent): boolean {
	const items = e.dataTransfer?.items;
	if (!items) return false;
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.kind !== 'file') continue;
		// webkitGetAsEntry is standardized (despite the prefix) and
		// supported in all major browsers; guard defensively anyway in
		// case it's ever unavailable (older WebViews etc.) rather than
		// throwing.
		const getEntry = (
			item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }
		).webkitGetAsEntry;
		const entry = typeof getEntry === 'function' ? getEntry.call(item) : null;
		if (entry?.isDirectory) return true;
	}
	return false;
}

/*

THIS FILE HAS BEEN MODIFIED FROM THE FOLLOWING APACHE 2.0 LICENSED REPOSITORY(S):

utils/drag-drop.ts": [
    {
      "component": "omicsclaw",
      "file": "Contents/Resources/standalone/src/lib/mentions/classify-dropped-items.ts",
      "file_hash": "573efdd54249dd0c7bc567a573195c49",
      "file_url": " ",
      "hits": 4,
      "id": "snippet",
      "latest": "v0.1.7",
      "licenses": [
        {
          "checklist_url": "https://www.osadl.org/fileadmin/checklists/unreflicenses/Apache-2.0.txt",
          "copyleft": "no",
          "name": "Apache-2.0",
          "osadl_updated": "2026-02-12T16:31:00+0000",
          "patent_hints": "yes",
          "source": "component_declared",
          "url": "https://spdx.org/licenses/Apache-2.0.html"
        }
      ],
      "lines": "12-35",
      "matched": "62%",
      "oss_lines": "27-50",
      "purl": [
        "pkg:github/tiangzlab/omicsclaw"
      ],
      "release_date": "2026-05-14",
      "server": {
        "kb_version": {
          "daily": "26.08.17",
          "monthly": "26.07"
        },
        "version": "5.4.25"
      },
      "source_hash": "c57acb1e460096597464c72a1eab5601",
      "status": "pending",
      "url": "https://github.com/TianGzlab/OmicsClaw",
      "url_hash": "4a192a1e370bf8ae90b82c015b2a6f9f",
      "vendor": "tiangzlab",
      "version": "v0.1.6"
    }
  ],
  */