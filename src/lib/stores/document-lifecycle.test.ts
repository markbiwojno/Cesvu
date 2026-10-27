/**
 * src/lib/stores/document-lifecycle.test.ts
 *
 * Regression guard for the document open/close lifecycle (see
 * .clinerules/schema_rules.txt → "Per-document RUNTIME state").
 *
 * Bug history this pins:
 *  1. Closing a document (✕) and opening a new one let the new document INHERIT
 *     the previous one's marked clauses + notes — closeDocument() reset workspace
 *     state but NOT the sibling per-document stores (clauseStore / notesStore),
 *     which keep their own document binding. Fixed by tearing every registered
 *     store down via workspace's perDocumentTeardowns.
 *  2. setFile() used to clear activeContractId on every load, racing
 *     resumeContract() (the import path) — an old→null→new flip that left the
 *     viewer stuck loading and could make Export target the wrong record. Fixed
 *     by making closeDocument() the SINGLE clearer of activeContractId.
 *
 * The clause store is populated via the persisted-restore path (seed a clause on
 * the record, then bindDocument restores it) so the test never invokes the
 * lazy-loaded legal classifier model.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { workspace } from './workspace.svelte.js';
import { clauseStore } from './clauseStore.svelte.js';
import { notesStore } from './notesStore.svelte.js';
import { createDocument, updateDocument } from './contract-store.svelte.js';
import type { PersistedClause } from '../schema.js';

/** A fully-formed persisted clause (no classifier needed to restore it). */
function persistedClause(): PersistedClause {
	return {
		id: 'mark-0',
		startOffset: 0,
		endOffset: 5,
		text: 'Hello',
		color: '#fde68a',
		heading: null,
		label: null,
		risk: null,
		status: 'pending',
		confidence: 'edited'
	};
}

describe('document open/close lifecycle', () => {
	// Every test starts from a clean slate — mirrors what a page refresh would do.
	beforeEach(() => {
		workspace.closeDocument();
	});

	it('closeDocument() unbinds clauseStore + notesStore and clears the contract binding', async () => {
		const text = 'The quick brown fox jumped';
		const doc = await createDocument({
			name: 'A.txt',
			sourceType: 'txt',
			text,
			rawContent: null
		});

		// Notes: bind + add one (no model involved).
		await notesStore.bindDocument(doc.id);
		notesStore.addNote(0, 'a note on doc A');
		expect(notesStore.count).toBeGreaterThan(0);

		// Clauses: seed a persisted clause, then let bindDocument() restore it.
		await updateDocument(doc.id, { clauses: [persistedClause()] });
		await clauseStore.bindDocument(text, doc.id);
		expect(clauseStore.count).toBeGreaterThan(0);

		// The session is bound to the record (resumeContract owns activeContractId).
		await workspace.resumeContract(doc.id);
		expect(workspace.activeContractId).toBe(doc.id);

		// ✕ / start over.
		workspace.closeDocument();

		expect(workspace.activeContractId).toBeNull();
		expect(clauseStore.count).toBe(0);
		expect(notesStore.count).toBe(0);
	});

	it('a freshly opened document does NOT inherit the previous one’s clauses/notes', async () => {
		// Open + populate document A.
		const textA = 'Document A body text';
		const docA = await createDocument({
			name: 'A.txt',
			sourceType: 'txt',
			text: textA,
			rawContent: null
		});
		await updateDocument(docA.id, { clauses: [persistedClause()] });
		await clauseStore.bindDocument(textA, docA.id);
		await notesStore.bindDocument(docA.id);
		notesStore.addNote(0, 'note on A');
		expect(clauseStore.count).toBeGreaterThan(0);
		expect(notesStore.count).toBeGreaterThan(0);

		// Close A, then open a genuinely different document B.
		workspace.closeDocument();

		const textB = 'Document B is completely different';
		const docB = await createDocument({
			name: 'B.txt',
			sourceType: 'txt',
			text: textB,
			rawContent: null
		});
		await clauseStore.bindDocument(textB, docB.id);
		await notesStore.bindDocument(docB.id);

		// B is clean — none of A's runtime state leaked across the close.
		expect(clauseStore.count).toBe(0);
		expect(notesStore.count).toBe(0);
	});

	it('setFile() does not clear the contract binding (resumeContract owns it)', async () => {
		const doc = await createDocument({
			name: 'C.txt',
			sourceType: 'txt',
			text: 'Doc C',
			rawContent: null
		});
		await workspace.resumeContract(doc.id);
		expect(workspace.activeContractId).toBe(doc.id);

		// A document load must NOT touch activeContractId (the import-path race).
		workspace.setFile({
			type: 'txt',
			name: 'C.txt',
			parsedData: {}
		} as unknown as Parameters<typeof workspace.setFile>[0]);

		expect(workspace.activeContractId).toBe(doc.id);
	});
});
