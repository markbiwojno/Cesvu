import { describe, it, expect } from 'vitest';
import { looksBinary } from './txt.js';

describe('looksBinary', () => {
	it('accepts ordinary text, including non-ASCII', () => {
		expect(looksBinary('')).toBe(false);
		expect(looksBinary('Hello, world.\nSecond line.')).toBe(false);
		expect(looksBinary('契約書 — café')).toBe(false);
	});

	it('flags NUL bytes', () => {
		expect(looksBinary('abc\u0000def')).toBe(true);
	});

	it('flags zip bytes decoded as UTF-8 (regression: garbled re-import)', () => {
		const zipish = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x80, 0x81]);
		expect(looksBinary(new TextDecoder('utf-8').decode(zipish))).toBe(true);
	});
});
