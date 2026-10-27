/**
 * src/lib/stores/annotations.svelte.ts — Annotation state (Svelte 5 runes)
 *
 * Annotations live INSIDE the encrypted .cesvu payload (ContentType 0x02).
 * They travel with the document — no separate server storage.
 *
 * Monetization:
 *   Free tier  — VIEW only (addAnnotation is gated in the UI)
 *   Pro tier   — CREATE + VIEW
 *
 * This store is the single source of truth for annotations in the current
 * session. It is loaded from the decrypted payload and serialized back
 * into the payload on save/export.
 */

import type { Annotation, AnnotationSelection } from '$lib/types.js';
import { newId } from '$lib/utils/id.js';

// ============================================================
// State (module-level Svelte 5 runes)
// ============================================================

let annotations = $state<Annotation[]>([]);
let selectedAnnotationId = $state<string | null>(null);
let isCreating = $state(false);
let pendingSelection = $state<AnnotationSelection | null>(null);

// ============================================================
// Derived
// ============================================================

let annotationCount = $derived(annotations.length);
let unresolvedCount = $derived(annotations.filter(a => !a.resolved).length);
let hasAnnotations = $derived(annotations.length > 0);
let selectedAnnotation = $derived(
	selectedAnnotationId
		? annotations.find(a => a.id === selectedAnnotationId) ?? null
		: null
);

// ============================================================
// Actions
// ============================================================

/**
 * Replace the entire annotation list (called after decrypting a .cesvu file).
 */
function loadAnnotations(docAnnotations: Annotation[]): void {
	annotations = docAnnotations;
	selectedAnnotationId = null;
	isCreating = false;
	pendingSelection = null;
}

/**
 * Add a new annotation (Pro tier only — caller must check tier before calling).
 * Returns the created annotation.
 */
function addAnnotation(
	selection: AnnotationSelection,
	body: string,
	author: string,
	color = '#FFD700'
): Annotation {
	const annotation: Annotation = {
		id: newId('ann'),
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		author,
		selection,
		body,
		color,
		resolved: false
	};
	annotations = [...annotations, annotation];
	return annotation;
}

/**
 * Update fields on an existing annotation.
 * Always updates `updated_at`.
 */
function updateAnnotation(id: string, updates: Partial<Omit<Annotation, 'id' | 'created_at'>>): void {
	annotations = annotations.map(a =>
		a.id === id
			? { ...a, ...updates, updated_at: new Date().toISOString() }
			: a
	);
}

/**
 * Delete an annotation by ID.
 */
function deleteAnnotation(id: string): void {
	annotations = annotations.filter(a => a.id !== id);
	if (selectedAnnotationId === id) selectedAnnotationId = null;
}

/**
 * Mark an annotation as resolved (for review workflows).
 */
function resolveAnnotation(id: string): void {
	updateAnnotation(id, { resolved: true });
}

/**
 * Re-open a resolved annotation.
 */
function reopenAnnotation(id: string): void {
	updateAnnotation(id, { resolved: false });
}

/**
 * Select an annotation (highlights it in the document viewer).
 */
function selectAnnotation(id: string | null): void {
	selectedAnnotationId = id;
}

/**
 * Set the pending selection (text the user has highlighted but not yet annotated).
 */
function setPendingSelection(sel: AnnotationSelection | null): void {
	pendingSelection = sel;
}

/**
 * Begin the annotation creation flow.
 * Sets isCreating = true so the AnnotationInput component renders.
 */
function beginCreate(sel: AnnotationSelection): void {
	pendingSelection = sel;
	isCreating = true;
}

/**
 * Cancel the annotation creation flow.
 */
function cancelCreate(): void {
	isCreating = false;
	pendingSelection = null;
}

// ============================================================
// Queries
// ============================================================

/**
 * Get all annotations for a specific document (by document_id).
 */
function getAnnotationsForDocument(documentId: string): Annotation[] {
	return annotations.filter(a => a.selection.document_id === documentId);
}

/**
 * Get all annotations whose selection overlaps a given character range.
 * Used by the document viewer to highlight annotated text.
 */
function getAnnotationsForRange(start: number, end: number): Annotation[] {
	return annotations.filter(
		a => a.selection.start_offset <= end && a.selection.end_offset >= start
	);
}

/**
 * Get annotations sorted by position in the document (start_offset ascending).
 */
function getSortedAnnotations(documentId?: string): Annotation[] {
	const list = documentId
		? annotations.filter(a => a.selection.document_id === documentId)
		: [...annotations];
	return list.sort((a, b) => a.selection.start_offset - b.selection.start_offset);
}

// ============================================================
// Serialization
// ============================================================

/**
 * Serialize the current annotation list to a JSON string.
 * This is what gets written into the .cesvu payload (ContentType 0x02).
 */
function serializeAnnotations(): string {
	return JSON.stringify(annotations);
}

/**
 * Parse a JSON string back into annotations.
 * Validates the shape — silently drops malformed entries.
 */
function deserializeAnnotations(json: string): Annotation[] {
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isValidAnnotation);
	} catch {
		return [];
	}
}

function isValidAnnotation(a: unknown): a is Annotation {
	if (typeof a !== 'object' || a === null) return false;
	const obj = a as Record<string, unknown>;
	return (
		typeof obj.id === 'string' &&
		typeof obj.created_at === 'string' &&
		typeof obj.updated_at === 'string' &&
		typeof obj.author === 'string' &&
		typeof obj.body === 'string' &&
		typeof obj.color === 'string' &&
		typeof obj.resolved === 'boolean' &&
		typeof obj.selection === 'object' &&
		obj.selection !== null
	);
}

/**
 * Reset all annotation state (called when a new document is loaded).
 */
function reset(): void {
	annotations = [];
	selectedAnnotationId = null;
	isCreating = false;
	pendingSelection = null;
}

// ============================================================
// Export
// ============================================================

export const annotationStore = {
	// State getters
	get annotations() { return annotations; },
	get selectedAnnotationId() { return selectedAnnotationId; },
	get isCreating() { return isCreating; },
	get pendingSelection() { return pendingSelection; },

	// Derived getters
	get annotationCount() { return annotationCount; },
	get unresolvedCount() { return unresolvedCount; },
	get hasAnnotations() { return hasAnnotations; },
	get selectedAnnotation() { return selectedAnnotation; },

	// Actions
	loadAnnotations,
	addAnnotation,
	updateAnnotation,
	deleteAnnotation,
	resolveAnnotation,
	reopenAnnotation,
	selectAnnotation,
	setPendingSelection,
	beginCreate,
	cancelCreate,
	reset,

	// Queries
	getAnnotationsForDocument,
	getAnnotationsForRange,
	getSortedAnnotations,

	// Serialization
	serializeAnnotations,
	deserializeAnnotations
};

/**
 * Composable accessor — use inside Svelte components.
 * Returns the same singleton store object.
 */
export function useAnnotations() {
	return annotationStore;
}
