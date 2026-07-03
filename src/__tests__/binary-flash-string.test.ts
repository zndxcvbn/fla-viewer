import { describe, expect, it } from 'vitest';
import {
  collectFlashStrings,
  decodeRawUtf16UntilNull,
  decodeUtf16Le,
  hasFlashStringBom,
  readFlashStringAt,
} from '../binary-flash-string';

function utf16le(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    out.push(code & 0xff, (code >> 8) & 0xff);
  }
  return out;
}

function flashString(s: string): Uint8Array {
  return Uint8Array.from([0xff, 0xfe, 0xff, s.length, ...utf16le(s)]);
}

function extendedFlashString(s: string): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xfe,
    0xff,
    0xff,
    s.length & 0xff,
    (s.length >> 8) & 0xff,
    ...utf16le(s),
  ]);
}

describe('binary-flash-string', () => {
  it('reads normal Flash UTF-16LE strings', () => {
    const data = flashString('Layer 1');
    const decoded = readFlashStringAt(data, 0);
    expect(decoded?.value).toBe('Layer 1');
    expect(decoded?.charLength).toBe(7);
    expect(decoded?.textStart).toBe(4);
    expect(decoded?.end).toBe(data.length);
    expect(decoded?.extended).toBe(false);
  });

  it('reads extended Flash strings only when enabled', () => {
    const data = extendedFlashString('function stop() { return; }');
    expect(readFlashStringAt(data, 0)).toBeNull();
    const decoded = readFlashStringAt(data, 0, { allowExtended: true });
    expect(decoded?.value).toContain('function stop');
    expect(decoded?.textStart).toBe(6);
    expect(decoded?.extended).toBe(true);
  });

  it('rejects empty strings unless explicitly allowed', () => {
    const data = Uint8Array.from([0xff, 0xfe, 0xff, 0x00]);
    expect(readFlashStringAt(data, 0)).toBeNull();
    expect(readFlashStringAt(data, 0, { allowEmpty: true })?.value).toBe('');
  });

  it('collects Flash strings while skipping noise', () => {
    const first = flashString('Width');
    const second = flashString('550');
    const data = Uint8Array.from([0xaa, ...first, 0xbb, ...second]);
    expect(collectFlashStrings(data)).toEqual(['Width', '550']);
  });

  it('decodes raw UTF-16LE until a null terminator', () => {
    const data = Uint8Array.from([...utf16le('Text'), 0x00, 0x00, 0xff]);
    const decoded = decodeRawUtf16UntilNull(data, 0);
    expect(decoded).toEqual({ value: 'Text', end: 10 });
  });

  it('exposes BOM and plain UTF-16 helpers', () => {
    const data = flashString('A');
    expect(hasFlashStringBom(data, 0)).toBe(true);
    expect(decodeUtf16Le(data, 4, 2)).toBe('A');
  });
});