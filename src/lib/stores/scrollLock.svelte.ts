/**
 * src/lib/stores/scrollLock.svelte.ts — "Scroll lock" for the Excel and CSV
 * table viewers.
 *
 * A laptop trackpad swipe fires dozens of wheel events plus a momentum tail,
 * which scrolled the tables far past where the user meant to stop. While the
 * lock is ON, vertical trackpad / mouse-wheel scrolling is ignored; the user
 * moves with the scrollbar, the Arrow / Page / Home / End keys, or the "Row"
 * jump box. OFF by default (normal scrolling); the user opts in with the
 * toolbar button. One setting shared by both viewers.
 *
 * In-memory only (no persistence), consistent with the rest of the app.
 */

let locked = $state(false);

export const scrollLock = {
	get locked() {
		return locked;
	},
	set(value: boolean) {
		locked = value;
	},
	toggle() {
		locked = !locked;
	}
};
