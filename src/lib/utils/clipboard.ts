// SPDX-License-Identifier: Apache-2.0

/**
 * src/lib/utils/clipboard.ts — copy-to-clipboard with a WebKit-safe fallback.
 *
 * `navigator.clipboard.writeText()` is considerably flakier on iOS WebKit
 * (which underlies EVERY browser on iOS — Safari, Chrome-for-iOS,
 * Firefox-for-iOS, etc., since Apple requires all of them to use WebKit's
 * engine) than on Chromium/Firefox-desktop. It can silently reject
 * depending on iOS version, whether the page is a home-screen PWA vs. a
 * regular tab, and focus/permission state at the moment of the call.
 *
 * The callers of this used to do:
 *
 *     try {
 *         await navigator.clipboard.writeText(text);
 *         copied = true;
 *     } catch {
 *         // swallowed — user sees nothing
 *     }
 *
 * which on a WebKit rejection just did nothing, with zero feedback. This
 * module fixes that in two ways:
 *   1. Falls back to the older `document.execCommand('copy')` technique
 *      (hidden, off-screen `<textarea>` + `select()` + `execCommand`) when
 *      the Clipboard API is unavailable or throws — that technique has much
 *      broader/older WebKit support.
 *   2. Reports success/failure via a return value instead of swallowing
 *      errors, so callers can show the user something when BOTH methods
 *      fail rather than leaving the click looking like a dead end.
 */

/**
 * Attempt to copy `text` to the clipboard. Tries the modern Clipboard API
 * first, then falls back to the legacy `execCommand('copy')` technique.
 * Returns `true` if either method reports success, `false` if both fail
 * (e.g. clipboard access is blocked entirely) — never throws.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
	if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Fall through to the legacy technique below — this is exactly
			// the WebKit-flakiness case this module exists to route around.
		}
	}

	return legacyExecCommandCopy(text);
}

/**
 * Old-school clipboard copy: stuff `text` into an off-screen, non-editable
 * `<textarea>`, select it, and call `document.execCommand('copy')`. Works
 * in far more browser/version combinations than the Clipboard API,
 * including older iOS Safari where `navigator.clipboard` may be missing or
 * unreliable entirely.
 */
function legacyExecCommandCopy(text: string): boolean {
	if (typeof document === 'undefined') return false;

	const textarea = document.createElement('textarea');
	textarea.value = text;
	// Keep it out of the visual layout and off-screen, but still genuinely
	// present/selectable in the DOM — some WebKit versions refuse to copy
	// from an element with `display: none` or zero size.
	textarea.style.position = 'fixed';
	textarea.style.top = '0';
	textarea.style.left = '-9999px';
	textarea.style.width = '1px';
	textarea.style.height = '1px';
	textarea.style.opacity = '0';
	textarea.setAttribute('readonly', '');
	textarea.setAttribute('aria-hidden', 'true');

	document.body.appendChild(textarea);

	// iOS Safari in particular needs an actual text selection range (not
	// just focus) before execCommand('copy') will do anything.
	const previousActive = document.activeElement as HTMLElement | null;
	textarea.contentEditable = 'true';
	textarea.readOnly = false;
	textarea.focus();
	textarea.setSelectionRange(0, text.length);

	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}

	textarea.remove();
	previousActive?.focus?.();

	return ok;
}
