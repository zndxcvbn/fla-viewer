const utf16le = new TextDecoder('utf-16le');

export const FLASH_STRING_BOM = new Uint8Array([0xff, 0xfe, 0xff]);

export interface FlashString {
  value: string;
  start: number;
  textStart: number;
  end: number;
  charLength: number;
  extended: boolean;
}

export function decodeUtf16Le(data: Uint8Array, start: number, byteLength: number): string {
  return utf16le.decode(data.subarray(start, start + byteLength));
}

export function hasFlashStringBom(data: Uint8Array, pos: number): boolean {
  return (
    pos >= 0 &&
    pos + 3 <= data.length &&
    data[pos] === 0xff &&
    data[pos + 1] === 0xfe &&
    data[pos + 2] === 0xff
  );
}

/**
 * Read a Flash UTF-16LE string at `pos`.
 *
 * Normal form:   FF FE FF <u8 charLen> <UTF-16LE chars>
 * Extended form: FF FE FF FF <u16 charLen> <UTF-16LE chars>
 */
export function readFlashStringAt(
  data: Uint8Array,
  pos: number,
  opts: { allowEmpty?: boolean; allowExtended?: boolean; maxChars?: number } = {}
): FlashString | null {
  if (!hasFlashStringBom(data, pos)) return null;

  const allowExtended = opts.allowExtended ?? false;
  const extended = data[pos + 3] === 0xff;
  let charLength: number;
  let textStart: number;
  if (extended) {
    if (!allowExtended || pos + 6 > data.length) return null;
    charLength = data[pos + 4] | (data[pos + 5] << 8);
    textStart = pos + 6;
  } else {
    if (pos + 4 > data.length) return null;
    charLength = data[pos + 3];
    textStart = pos + 4;
  }

  if (!opts.allowEmpty && charLength === 0) return null;
  if (opts.maxChars !== undefined && charLength > opts.maxChars) return null;

  const end = textStart + charLength * 2;
  if (end > data.length) return null;

  for (let i = 0; i < charLength; i++) {
    const c = data[textStart + i * 2] | (data[textStart + i * 2 + 1] << 8);
    if (c === 0) return null;
  }

  return {
    value: decodeUtf16Le(data, textStart, charLength * 2),
    start: pos,
    textStart,
    end,
    charLength,
    extended,
  };
}

export function collectFlashStrings(data: Uint8Array, opts: { maxChars?: number } = {}): string[] {
  const strings: string[] = [];
  for (let pos = 0; pos < data.length - 4; pos++) {
    const decoded = readFlashStringAt(data, pos, { maxChars: opts.maxChars });
    if (!decoded) continue;
    strings.push(decoded.value);
    pos = decoded.end - 1;
  }
  return strings;
}

export function decodeRawUtf16UntilNull(
  data: Uint8Array,
  pos: number
): { value: string; end: number } | null {
  let i = pos;
  if (i + 2 > data.length || (data[i] | (data[i + 1] << 8)) === 0) return null;
  let value = '';
  while (i + 2 <= data.length) {
    const c = data[i] | (data[i + 1] << 8);
    if (c === 0) break;
    value += String.fromCharCode(c);
    i += 2;
  }
  return { value, end: i + 2 };
}
