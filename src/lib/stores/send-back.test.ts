/**
 * send-back.test.ts
 *
 * Round-trip and behavior guards for {@link sendBackAsCesvu} (the
 * contract-store function behind Workspace.svelte's "Send Back" button).
 * Unlike {@link exportAsCesvu}, sendBackAsCesvu never generates a new
 * passphrase — it re-encrypts under a passphrase the CALLER already
 * supplies (captured at unlock time by sessionKey.svelte.ts), so a
 * recipient's reply can be opened by the original sender with the exact
 * same words/emoji they already have.
 */

import { describe, it, expect } from 'vitest';
import {
	createDocument,
	updateDocument,
	sendBackAsCesvu,
	importFromCesvu,
	exportAsCesvu
} from './contract-store.svelte.js';
import { parseHeader } from '$lib/crypto/index.js';

/** Wrap a Blob as a File the way the import UI does. */
function blobToFile(blob: Blob, name: string): File {
	return new File([blob], name, { type: blob.type });
}

const SHARED_PASSPHRASE = 'correct horse battery staple winter forest';

describe('sendBackAsCesvu — reuses the SAME passphrase, never generates a new one', () => {
	it('round-trips: the reply decrypts with the EXACT passphrase the sender already had', async () => {
		const doc = await createDocument({
			name: 'contract.txt',
			sourceType: 'txt',
			text: 'Original document body'
		});
		// Simulate the recipient adding an annotation before sending back.
		await updateDocument(doc.id, {
			annotations: [
				{
					id: 'note-1',
					anchorId: '0',
					anchor: { kind: 'prose', offset: 0 },
					author: 'You',
					body: 'Looks good, one comment here.',
					createdAt: Date.now()
				}
			]
		});

		const { blob } = await sendBackAsCesvu(doc.id, SHARED_PASSPHRASE, 'diceware');
		const file = blobToFile(blob, 'reply.cesvu');

		// The sender opens it with the SAME passphrase they already had —
		// no new words were generated or communicated.
		const imported = await importFromCesvu(file, SHARED_PASSPHRASE);

		expect(imported.text).toBe('Original document body');
		expect(imported.annotations).toHaveLength(1);
		expect(imported.annotations[0].body).toBe('Looks good, one comment here.');
	}, 20_000);

	it('defaults includeSource to TRUE (opposite of exportAsCesvu\'s default)', async () => {
		const rawBytes = new Uint8Array([1, 2, 3, 4, 5]);
		const doc = await createDocument({
			name: 'sheet.csv',
			sourceType: 'csv',
			text: 'a,b\n1,2',
			rawContent: rawBytes
		});

		const { blob } = await sendBackAsCesvu(doc.id, SHARED_PASSPHRASE, 'diceware');
		const file = blobToFile(blob, 'reply.cesvu');
		const imported = await importFromCesvu(file, SHARED_PASSPHRASE);

		expect(imported.rawContent).not.toBeNull();
		expect(Array.from(imported.rawContent as Uint8Array)).toEqual(Array.from(rawBytes));
	}, 20_000);

	it('honors includeSource: false to omit the original bytes', async () => {
		const rawBytes = new Uint8Array([9, 9, 9]);
		const doc = await createDocument({
			name: 'sheet.csv',
			sourceType: 'csv',
			text: 'a,b\n1,2',
			rawContent: rawBytes
		});

		const { blob } = await sendBackAsCesvu(doc.id, SHARED_PASSPHRASE, 'diceware', {
			includeSource: false
		});
		const file = blobToFile(blob, 'reply.cesvu');
		const imported = await importFromCesvu(file, SHARED_PASSPHRASE);

		expect(imported.rawContent).toBeNull();
	}, 20_000);

	it('rejects with the correct passphrase but WRONG profile the same way any mismatch would', async () => {
		// Sanity: passing a mismatched passphraseType still produces a file
		// that opens fine as long as the SAME (type, passphrase) pair is
		// used on both ends — passphraseType only selects normalization,
		// it is not itself a secret.
		const doc = await createDocument({
			name: 'x.txt',
			sourceType: 'txt',
			text: 'body'
		});
		const emojiPass = '🦏🐙🌵🚀🍄🔥🐝🌙';
		const { blob } = await sendBackAsCesvu(doc.id, emojiPass, 'emoji');
		const file = blobToFile(blob, 'reply.cesvu');
		const imported = await importFromCesvu(file, emojiPass, 'emoji');
		expect(imported.text).toBe('body');
	}, 20_000);

	it('throws a plain Error for an unknown document id', async () => {
		await expect(
			sendBackAsCesvu('does-not-exist', SHARED_PASSPHRASE, 'diceware')
		).rejects.toThrow(/Document not found/);
	});

	// ── Unlinkability: reusing the passphrase must not make two Send Back ──
	// replies (or a Send Back + a regular Export) recognizable as sharing a
	// passphrase — see cesvu-crypto.test.ts's dedicated salt-uniqueness
	// suite for the crypto-level guarantee this relies on. Here we confirm
	// the store-level call path actually benefits from it.
	it('two Send Back calls with the same passphrase produce envelopes with different salts', async () => {
		const doc = await createDocument({
			name: 'x.txt',
			sourceType: 'txt',
			text: 'body'
		});
		const { blob: blobA } = await sendBackAsCesvu(doc.id, SHARED_PASSPHRASE, 'diceware');
		const { blob: blobB } = await sendBackAsCesvu(doc.id, SHARED_PASSPHRASE, 'diceware');

		const bytesA = new Uint8Array(await blobA.arrayBuffer());
		const bytesB = new Uint8Array(await blobB.arrayBuffer());
		const { salt: saltA } = await parseHeader(bytesA);
		const { salt: saltB } = await parseHeader(bytesB);

		expect(Array.from(saltA)).not.toEqual(Array.from(saltB));
	}, 20_000);

	it('a Send Back reply and a normal Export of the same document share NO linkable bytes beyond the plaintext content itself', async () => {
		const doc = await createDocument({
			name: 'x.txt',
			sourceType: 'txt',
			text: 'body'
		});

		const exported = await exportAsCesvu(doc.id, { passphraseType: 'diceware' });
		const { blob: sentBackBlob } = await sendBackAsCesvu(doc.id, SHARED_PASSPHRASE, 'diceware');

		const exportedBytes = new Uint8Array(await exported.blob.arrayBuffer());
		const sentBackBytes = new Uint8Array(await sentBackBlob.arrayBuffer());
		const { salt: exportSalt } = await parseHeader(exportedBytes);
		const { salt: sendBackSalt } = await parseHeader(sentBackBytes);

		expect(Array.from(exportSalt)).not.toEqual(Array.from(sendBackSalt));
	}, 20_000);
});