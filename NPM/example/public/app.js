// SPDX-License-Identifier: Apache-2.0

/**
 * app.js — vanilla JS frontend for the @cesvu/crypto example.
 *
 * No framework, no build step. UX conventions here deliberately mirror the
 * cesvu.com web app's SecureSaveModal.svelte (encrypt) and
 * SecureOpenModal.svelte (decrypt):
 *   - generate-then-confirm-then-encrypt flow for diceware/emoji
 *   - live UTF-8 byte counter + 512-byte cap for custom/raw passphrases
 *   - peek-the-file's-passphrase-profile BEFORE the user types anything,
 *     so the decrypt input's label/counter matches what the file expects
 *   - a 3-strikes / 5-second cooldown after repeated failed decrypt attempts
 *     (documented here, as in the package's own README, as UX only — not a
 *     substitute for real server-side rate limiting)
 */

const RAW_MAX_BYTES = 512;


// ── small utilities ──────────────────────────────────────────────────

function utf8ByteLength(str) {
	return new TextEncoder().encode(str).length;
}

function emojiCount(str) {
	return Array.from(str).length;
}

function setStatus(el, kind, message) {
	el.hidden = false;
	el.className = `status ${kind}`;
	el.textContent = message;
}

function clearStatus(el) {
	el.hidden = true;
	el.textContent = '';
}

async function downloadBlobResponse(res, fallbackName) {
	const disposition = res.headers.get('Content-Disposition') || '';
	const match = /filename="([^"]*)"/.exec(disposition);
	const filename = match ? decodeURIComponent(match[1]) : fallbackName;
	const blob = await res.blob();
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
	return filename;
}

function readMetaHeader(res) {
	const raw = res.headers.get('X-Cesvu-Meta');
	if (!raw) return null;
	try {
		return JSON.parse(atob(raw));
	} catch {
		return null;
	}
}

async function errorFromResponse(res) {
	try {
		const body = await res.json();
		return body.message || body.code || `HTTP ${res.status}`;
	} catch {
		return `HTTP ${res.status}`;
	}
}

// ── Encrypt panel ─────────────────────────────────────────────────────

const encFileInput = document.getElementById('enc-file');
const encModeRadios = document.getElementsByName('enc-mode');
const encPtypeRadios = document.getElementsByName('enc-ptype');
const encDicewareEmojiBox = document.getElementById('enc-diceware-emoji');
const encRawBox = document.getElementById('enc-raw');
const encGenerateBtn = document.getElementById('enc-generate-btn');
const encWordsBox = document.getElementById('enc-words');
const encWordsWarning = document.getElementById('enc-words-warning');
const encConfirmRow = document.getElementById('enc-confirm-row');
const encConfirmChk = document.getElementById('enc-confirm-saved');
const encRawInput = document.getElementById('enc-raw-input');
const encRawCounter = document.getElementById('enc-raw-counter');
const encRawOnlyChk = document.getElementById('enc-raw-only');
const encSubmitBtn = document.getElementById('enc-submit-btn');
const encStatus = document.getElementById('enc-status');



let encGeneratedPassphrase = null; // { words, passphrase } from the server

function encPtype() {
	for (const r of encPtypeRadios) if (r.checked) return r.value;
	return 'diceware';
}

function encMode() {
	for (const r of encModeRadios) if (r.checked) return r.value;
	return 'memory';
}

function updateEncSubpanels() {
	const ptype = encPtype();
	encDicewareEmojiBox.hidden = ptype === 'raw';
	encRawBox.hidden = ptype !== 'raw';
	updateEncSubmitEnabled();
}

function updateEncSubmitEnabled() {
	const ptype = encPtype();
	const hasFile = encFileInput.files.length > 0;
	let ready = hasFile;
	if (ptype === 'raw') {
		const bytes = utf8ByteLength(encRawInput.value);
		ready = ready && bytes > 0 && bytes <= RAW_MAX_BYTES;
	} else {
		ready = ready && !!encGeneratedPassphrase && encConfirmChk.checked;
	}
	encSubmitBtn.disabled = !ready;
}

for (const r of encPtypeRadios) r.addEventListener('change', updateEncSubpanels);
encFileInput.addEventListener('change', updateEncSubmitEnabled);
encConfirmChk.addEventListener('change', updateEncSubmitEnabled);

// Debounced so we don't hammer /api/validate-raw on every keystroke.
let encRawValidateTimer = null;

encRawInput.addEventListener('input', () => {
	// Instant client-side estimate so the counter never feels laggy...
	const bytes = utf8ByteLength(encRawInput.value);
	encRawCounter.textContent = `${bytes} / ${RAW_MAX_BYTES} bytes${bytes > RAW_MAX_BYTES ? ' — too long' : ''}`;
	encRawCounter.classList.toggle('over', bytes > RAW_MAX_BYTES);
	updateEncSubmitEnabled();

	// ...then confirm against the server's validateRawPassphrase (the same
	// gate encryptCesvu itself uses), which also catches things a naive
	// byte-count can't: empty-after-normalize, etc.
	clearTimeout(encRawValidateTimer);
	const value = encRawInput.value;
	encRawValidateTimer = setTimeout(async () => {
		try {
			const res = await fetch(`/api/validate-raw?passphrase=${encodeURIComponent(value)}`);
			if (!res.ok) return;
			const result = await res.json();
			encRawCounter.textContent = `${result.byteLength} / ${result.maxBytes} bytes${result.ok ? '' : ` — ${result.error}`}`;
			encRawCounter.classList.toggle('over', !result.ok);
		} catch {
			/* best-effort — the client-side estimate above already stands */
		}
	}, 200);
});


encGenerateBtn.addEventListener('click', async () => {
	clearStatus(encStatus);
	const type = encPtype();
	try {
		const res = await fetch('/api/generate-passphrase', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type })
		});
		if (!res.ok) throw new Error(await errorFromResponse(res));
		const result = await res.json();
		encGeneratedPassphrase = result;

		encWordsBox.hidden = false;
		encWordsBox.innerHTML = '';
		for (const w of result.words) {
			const span = document.createElement('span');
			span.textContent = w;
			encWordsBox.appendChild(span);
		}
		encWordsWarning.hidden = false;
		encConfirmRow.hidden = false;
		encConfirmChk.checked = false;
		updateEncSubmitEnabled();
	} catch (err) {
		setStatus(encStatus, 'error', String(err.message || err));
	}
});

encSubmitBtn.addEventListener('click', async () => {
	clearStatus(encStatus);
	const file = encFileInput.files[0];
	if (!file) return;

	const ptype = encPtype();
	const mode = encMode();
	let passphrase;
	if (ptype === 'raw') {
		passphrase = encRawInput.value;
	} else {
		passphrase = encGeneratedPassphrase.passphrase;
	}

	const params = new URLSearchParams({
		mode,
		passphraseType: ptype,
		passphrase,
		filename: file.name
	});
	if (encRawOnlyChk.checked) {
		params.set('rawOnly', '1');
	}



	setStatus(encStatus, 'info', 'Encrypting…');
	encSubmitBtn.disabled = true;
	try {
		const res = await fetch(`/api/encrypt?${params.toString()}`, {
			method: 'POST',
			body: file
		});
		if (!res.ok) throw new Error(await errorFromResponse(res));
		const filename = await downloadBlobResponse(res, `${file.name}.cesvu`);
		setStatus(encStatus, 'ok', `Downloaded ${filename}.`);
	} catch (err) {
		setStatus(encStatus, 'error', String(err.message || err));
	} finally {
		updateEncSubmitEnabled();
	}
});

updateEncSubpanels();

// ── Decrypt panel ─────────────────────────────────────────────────────

const decFileInput = document.getElementById('dec-file');
const decModeRadios = document.getElementsByName('dec-mode');
const decLabel = document.getElementById('dec-passphrase-label');

const decInput = document.getElementById('dec-passphrase-input');
const decShowToggle = document.getElementById('dec-show-toggle');
const decCounter = document.getElementById('dec-counter');
const decWordValidityEl = document.getElementById('dec-word-validity');
const decRawOnlyChk = document.getElementById('dec-raw-only');
const decSubmitBtn = document.getElementById('dec-submit-btn');
const decCooldownEl = document.getElementById('dec-cooldown');
const decStatus = document.getElementById('dec-status');


// PassProfile: 1 = diceware/text, 2 = emoji, 3 = raw. Mirrors
// SecureOpenModal.svelte's PASS_PROFILE_* constants.
let decPassProfile = null;

function decMode() {
	for (const r of decModeRadios) if (r.checked) return r.value;
	return 'memory';
}

function updateDecCounter() {
	const value = decInput.value;
	if (decPassProfile === 3) {
		const bytes = utf8ByteLength(value);
		decCounter.textContent = `${bytes} / ${RAW_MAX_BYTES} bytes${bytes > RAW_MAX_BYTES ? ' — too long' : ''}`;
		decCounter.classList.toggle('over', bytes > RAW_MAX_BYTES);
		decWordValidityEl.hidden = true;
	} else if (decPassProfile === 2) {
		const count = emojiCount(value);
		decCounter.textContent = `${count} / 8 emoji minimum`;
		decCounter.classList.toggle('over', false);
	} else if (decPassProfile === 1) {
		const count = value.trim().split(/\s+/).filter(Boolean).length;
		decCounter.textContent = `${count} / 6 words`;
		decCounter.classList.toggle('over', false);
	} else {
		decCounter.textContent = '';
		decWordValidityEl.hidden = true;
	}
}

// Debounced server-side SHAPE + real-wordlist-membership check, exercising
// validateDicewareWords/validateEmojiPassphrase and
// isDicewareWord/isCuratedEmoji — dictionary membership isn't something
// the client can check itself (the wordlists live in the library, not
// duplicated into this frontend).
let decWordValidateTimer = null;

function scheduleDecWordValidity() {
	if (decPassProfile !== 1 && decPassProfile !== 2) return;
	clearTimeout(decWordValidateTimer);
	const profile = decPassProfile === 1 ? 'diceware' : 'emoji';
	const value = decInput.value;
	decWordValidateTimer = setTimeout(async () => {
		try {
			const res = await fetch('/api/validate-words', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ profile, value })
			});
			if (!res.ok) return;
			const result = await res.json();
			decWordValidityEl.hidden = false;
			if (profile === 'diceware') {
				const bad = result.words.filter((w) => !w.valid).map((w) => w.word);
				decWordValidityEl.textContent = bad.length
					? `Not in the diceware wordlist: ${bad.join(', ')}`
					: result.words.length
						? 'All words recognized in the diceware wordlist.'
						: '';
				decWordValidityEl.classList.toggle('over', bad.length > 0);
			} else {
				const bad = result.emoji.filter((e) => !e.valid).map((e) => e.emoji);
				decWordValidityEl.textContent = bad.length
					? `Not in the curated emoji list: ${bad.join(' ')}`
					: result.emoji.length
						? 'All emoji recognized in the curated list.'
						: '';
				decWordValidityEl.classList.toggle('over', bad.length > 0);
			}
		} catch {
			/* best-effort */
		}
	}, 250);
}

decShowToggle.addEventListener('change', () => {
	decInput.type = decShowToggle.checked ? 'text' : 'password';
});

decInput.addEventListener('input', () => {
	updateDecCounter();
	scheduleDecWordValidity();
});


decFileInput.addEventListener('change', async () => {
	decPassProfile = null;
	decLabel.textContent = 'Passphrase';
	decCounter.textContent = '';
	clearStatus(decStatus);

	const file = decFileInput.files[0];
	if (!file) return;

	// Peek loop: retry with a larger slice on null, mirroring
	// SecureOpenModal.svelte's peekPassProfile() retry behavior.
	let sliceLen = 512;
	const maxSliceLen = 8192;
	for (;;) {
		const slice = file.slice(0, sliceLen);
		const buf = await slice.arrayBuffer();
		try {
			const res = await fetch('/api/peek-profile', { method: 'POST', body: buf });
			if (!res.ok) throw new Error(await errorFromResponse(res));
			const { passProfile } = await res.json();
			if (passProfile === null) {
				if (sliceLen >= maxSliceLen || sliceLen >= file.size) break;
				sliceLen = Math.min(sliceLen * 2, maxSliceLen, file.size);
				continue;
			}
			decPassProfile = passProfile;
			break;
		} catch (err) {
			setStatus(decStatus, 'error', `Could not read file header: ${err.message || err}`);
			return;
		}
	}

	if (decPassProfile === 1) decLabel.textContent = 'Passphrase (6 words)';
	else if (decPassProfile === 2) decLabel.textContent = 'Passphrase (8+ emoji)';
	else if (decPassProfile === 3) decLabel.textContent = 'Passphrase (custom password)';
	updateDecCounter();
});

// 3-strikes / 5-second cooldown — UX parity with SecureOpenModal.svelte.
// NOT a substitute for real rate limiting; see README "Security notes".
let failedAttempts = 0;
let cooldownTimer = null;

function startCooldown(seconds) {
	decSubmitBtn.disabled = true;
	let remaining = seconds;
	decCooldownEl.hidden = false;
	decCooldownEl.textContent = `Too many failed attempts. Try again in ${remaining}s…`;
	clearInterval(cooldownTimer);
	cooldownTimer = setInterval(() => {
		remaining -= 1;
		if (remaining <= 0) {
			clearInterval(cooldownTimer);
			decCooldownEl.hidden = true;
			decSubmitBtn.disabled = false;
			failedAttempts = 0;
		} else {
			decCooldownEl.textContent = `Too many failed attempts. Try again in ${remaining}s…`;
		}
	}, 1000);
}

decSubmitBtn.addEventListener('click', async () => {
	clearStatus(decStatus);
	const file = decFileInput.files[0];
	if (!file) {
		setStatus(decStatus, 'error', 'Choose a .cesvu file first.');
		return;
	}

	const passphrase = decInput.value;
	const mode = decMode();
	const params = new URLSearchParams({ mode, passphrase });
	if (decRawOnlyChk.checked) {
		params.set('rawOnly', '1');
	}
	if (decPassProfile !== null) {
		// Forwarded as `preferredType` server-side so decrypt doesn't have
		// to try every normalization — the same shortcut SecureOpenModal
		// gets for free by knowing which passphrase tab is active.
		params.set('passProfile', String(decPassProfile));
	}


	setStatus(decStatus, 'info', 'Decrypting…');
	decSubmitBtn.disabled = true;
	try {
		const res = await fetch(`/api/decrypt?${params.toString()}`, {
			method: 'POST',
			body: file
		});
		if (!res.ok) {
			const message = await errorFromResponse(res);
			failedAttempts += 1;
			if (failedAttempts >= 3) {
				setStatus(decStatus, 'error', message);
				startCooldown(5);
				return;
			}
			throw new Error(message);
		}
		failedAttempts = 0;
		const meta = readMetaHeader(res);
		const filename = await downloadBlobResponse(res, 'decrypted.out');

		const lines = [`Downloaded ${filename}.`];
		if (meta) {
			if (meta.isDocument) {
				lines.push(
					`CFP1 document unwrapped (isTextFallback=${meta.isTextFallback}).`
				);
				if (meta.extrasTotal > 0) {
					lines.push(`Not restorable to a plain file: ${meta.extrasDescription}.`);
				}
			} else if (meta.streaming) {
				lines.push('Streaming decrypt — always raw framing.');
			} else {
				lines.push('Raw/vault file — no CFP1 framing detected.');
			}
			if (meta.metadata) {
				lines.push(
					`Original filename: ${meta.metadata.filename}, mimeType: ${meta.metadata.mimeType}.`
				);
			}
			if (meta.chosenFilename) {
				lines.push(`Safe filename chosen by decryptCesvuFileToDirectory: ${meta.chosenFilename}`);
			}
			if (Array.isArray(meta.warnings) && meta.warnings.length > 0) {
				lines.push(`Warnings: ${meta.warnings.join(' | ')}`);
			}
		}


		setStatus(decStatus, 'ok', lines.join('\n'));
	} catch (err) {
		setStatus(decStatus, 'error', String(err.message || err));
	} finally {
		if (failedAttempts < 3) decSubmitBtn.disabled = false;
	}
});
