import { describe, it, expect } from 'vitest';
import {
  extractImports,
  extractLinkage,
} from '../binary-linkage-decoder';

// ── byte-builder helpers ────────────────────────────────────────────────────
function u8(...v: number[]): number[] {
  return v.map((n) => n & 0xff);
}
function utf16(s: string): number[] {
  const o: number[] = [];
  for (const c of s) o.push(c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8);
  return o;
}
/** A Flash string `FF FE FF <u8 len> <UTF-16LE>`. */
function flashStr(s: string): number[] {
  return [0xff, 0xfe, 0xff, s.length, ...utf16(s)];
}
/**
 * One linkage record: `<id> <sep> <className> <schema> 02 00 00 00`. The schema
 * byte varies by Flash version (0x05 / 0x07 in the real corpus); the separator
 * is "." in some files and EMPTY in others — both are covered below.
 */
function record(id: string, sep: string, cls: string, schema: number): number[] {
  return [...flashStr(id), ...flashStr(sep), ...flashStr(cls), schema, 0x02, 0x00, 0x00, 0x00];
}

describe('extractLinkage — binary Contents linkage table', () => {
  it('decodes id + className + kind for both separator styles and schemas', () => {
    const bytes = new Uint8Array([
      ...u8(0, 0, 0, 0), // leading padding
      ...record('MyButton', '.', 'com.example.MyButton', 0x05), // "." separator
      ...u8(0, 0, 0, 0, 0, 0, 0, 0), // gap between records
      ...record('MyList', '', 'skyui.List', 0x07), // EMPTY separator
    ]);
    expect(extractLinkage(bytes)).toEqual([
      { identifier: 'MyButton', className: 'com.example.MyButton', kind: 'library' },
      { identifier: 'MyList', className: 'skyui.List', kind: 'library' },
    ]);
  });

  it('tags the document class when the nearest edit-name is "Symbol 0"', () => {
    const bytes = new Uint8Array([
      ...utf16('Symbol 0'), // root edit-name immediately precedes the record
      ...record('DocClass', '.', 'MyDocument', 0x05),
    ]);
    const links = extractLinkage(bytes);
    expect(links).toHaveLength(1);
    expect(links[0].identifier).toBe('DocClass');
    expect(links[0].className).toBe('MyDocument');
    expect(links[0].kind).toBe('document');
    expect(links[0].boundName).toBe('Symbol 0');
  });

  it('keeps a library record bound to a non-root "Symbol 1" edit-name', () => {
    const bytes = new Uint8Array([
      ...utf16('Symbol 1'),
      ...record('LibClip', '.', 'MyClip', 0x05),
    ]);
    expect(extractLinkage(bytes)[0].kind).toBe('library');
  });

  it('returns [] for a stream with no linkage records', () => {
    expect(extractLinkage(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual([]);
  });
});

describe('extractLinkage — export record variants', () => {
  it('returns className empty for RS-only export records', () => {
    // RS-only: has export identifier but NO class name (schema=5, cls="")
    const bytes = new Uint8Array([
      ...utf16('Symbol 1'),
      ...record('PS3_A', '.', '', 0x05),
      ...u8(0, 0, 0, 0),
      ...utf16('Symbol 2'),
      ...record('Tab', '.', '', 0x05),
    ]);
    const links = extractLinkage(bytes);
    const rsRecords = links.filter((l) => !l.className);
    expect(rsRecords).toHaveLength(2);
    expect(rsRecords[0].identifier).toBe('PS3_A');
    expect(rsRecords[1].identifier).toBe('Tab');
  });

  it('returns non-empty className for AS+RS export records', () => {
    // AS+RS: has both export identifier and class name (schema=7, cls!="")
    const bytes = new Uint8Array([
      ...utf16('Symbol 1'),
      ...record('ItemCard', '.', 'ItemCard', 0x07),
      ...u8(0, 0, 0, 0),
      ...utf16('Symbol 2'),
      ...record('QSlider', '.', 'Components.QuantitySlider', 0x07),
    ]);
    const links = extractLinkage(bytes);
    const asRecords = links.filter((l) => l.className);
    expect(asRecords).toHaveLength(2);
    expect(asRecords[0].className).toBe('ItemCard');
    expect(asRecords[1].className).toBe('Components.QuantitySlider');
  });

  it('mixes RS-only and AS+RS records in the same stream', () => {
    // Real-world scenario: some symbols have only an export identifier (RS),
    // others have a full class name (AS+RS)
    const bytes = new Uint8Array([
      ...utf16('Sprite 45'),
      ...record('item_name', '.', '', 0x05),                // RS-only
      ...u8(0, 0, 0, 0, 0, 0, 0, 0),
      ...utf16('Sprite 32'),
      ...record('ItemCard', '.', 'ItemCard', 0x07),        // AS+RS
    ]);
    const links = extractLinkage(bytes);
    expect(links).toHaveLength(2);
    // RS-only: identifier present, className empty
    const rsOnly = links.find((l) => l.identifier === 'item_name');
    expect(rsOnly?.className).toBe('');
    // AS+RS: both present
    const asPlus = links.find((l) => l.identifier === 'ItemCard');
    expect(asPlus?.className).toBe('ItemCard');
  });

  it('decodes runtime-shared import records from adjacent name/url strings', () => {
    const bytes = new Uint8Array([
      ...flashStr('ButtonArt'),
      ...flashStr('skyui/buttonart.swf'),
      ...u8(0, 0, 0, 0),
      ...flashStr('$EverywhereMediumFont'),
      ...flashStr('gfxfontlib.swf'),
    ]);

    expect(extractImports(bytes)).toEqual([
      {
        identifier: 'ButtonArt',
        className: 'ButtonArt',
        kind: 'import',
        linkageURL: 'skyui/buttonart.swf',
      },
      {
        identifier: '$EverywhereMediumFont',
        className: '$EverywhereMediumFont',
        kind: 'import',
        linkageURL: 'gfxfontlib.swf',
      },
    ]);
  });

});
