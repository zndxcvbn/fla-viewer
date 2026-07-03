import { describe, it, expect } from 'vitest';
// The committed fixture is a REAL Flash MX 2004 binary (OLE2) FLA: the
// "onRollOver Strobe Button" sample from canfieldstudios.com (btnstrob.fla).
// Its `Page 1` scene PLACES library Symbol 1 (a green 180px square) via a
// CPicSprite instance at (300,150) px — the case this module decodes. Loaded
// via Vite's ?url + fetch, the same way the other binary-FLA fixtures load.
import btnstrobUrl from './fixtures/btnstrob.fla?url';
import { OLE2File } from '../ole2-reader';
import { parseBinaryFLA } from '../binary-fla-parser';
import {
  attachInstanceNames,
  buildCombinedClassTable,
  correctFp8Refs,
  dedupeInstances,
  instanceSymbolType,
  markUnreliableRefs,
  scanForInstances,
  scanNamedInstances,
  tryParseInstanceAt,
  tryParseTextInstanceAt,
  unjoinedNames,
  type DecodedInstance,
  type NamedInstance,
} from '../binary-instance-decoder';

async function loadBtnstrob(): Promise<Uint8Array> {
  const res = await fetch(btnstrobUrl);
  return new Uint8Array(await res.arrayBuffer());
}

// ── byte-builder helpers (little-endian) ────────────────────────────────────
function u8(...v: number[]): number[] {
  return v.map((n) => n & 0xff);
}
function u16le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function s32le(v: number): number[] {
  const n = v < 0 ? v + 0x100000000 : v;
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}
function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
}
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** Encode a string as UTF-16LE bytes. */
function utf16le(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out.push(code & 0xff, (code >> 8) & 0xff);
  }
  return out;
}

/** A Flash string: FF FE FF <len_u8> <UTF-16LE chars>. */
function flashString(s: string): number[] {
  return [0xff, 0xfe, 0xff, s.length, ...utf16le(s)];
}

const FIXED_1 = 0x00010000; // 1.0 in 16.16 fixed-point
const NEWCLASS = [0xff, 0xff];

/**
 * Build a CPicSymbol-derived placement BODY (the bytes that follow the class
 * tag), exactly matching the layout verified byte-for-byte against btnstrob.fla
 * `Page 1`: CPicObj base (schema 2 → NULL child + 2×s32 point), then
 * symbol_schema, 6-u32 matrix, field_b0/cc, field_90, name, media_ref.
 */
function placementBody(opts: {
  cpicObjSchema?: number;
  flags?: number;
  pointX?: number;
  pointY?: number;
  symbolSchema?: number;
  matrix: [number, number, number, number, number, number]; // a,b,c,d (16.16), tx,ty (twips)
  name?: string;
  mediaRef: number;
}): number[] {
  const schema = opts.cpicObjSchema ?? 2;
  const name = opts.name ?? '';
  const out: number[] = [];
  out.push(...u8(schema, opts.flags ?? 0));
  out.push(...u16le(0x0000)); // NULL child list (leaf placement)
  out.push(...s32le(opts.pointX ?? 6000));
  out.push(...s32le(opts.pointY ?? 3000));
  if (schema >= 3) out.push(...u8(0));
  if (schema >= 4) out.push(...u8(0));
  out.push(...u8(opts.symbolSchema ?? 14)); // symbol_schema
  for (const m of opts.matrix) out.push(...s32le(m));
  out.push(...u16le(0)); // field_b0
  out.push(...u16le(2)); // field_cc
  out.push(...u8(1)); // field_90 marker
  out.push(...u16le(256), ...u16le(0), ...u16le(256), ...u16le(0)); // 4×u16
  out.push(...u8(name.length), ...ascii(name)); // instance name
  out.push(...u32le(opts.mediaRef)); // media_ref → library item id
  return out;
}

function cpicSymbolSchema22Tail(targetRef: number): number[] {
  return [
    ...u32le(1),
    ...u32le(0),
    ...u16le(0),
    0xff, 0xff, 0xfe, 0xff, 0x00,
    ...u32le(targetRef),
    ...u8(0, 0, 0, 0, 0, 0, 0),
    0x00, 0x00, 0x80, 0x3f,
    ...u8(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    0x00, 0x00, 0x80, 0x3f,
    ...u8(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    0x00, 0x00, 0x80, 0x3f,
    ...u8(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
    0x00, 0x00, 0x80, 0x3f,
    ...u8(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
  ];
}

function placementBodySchema22Variant(opts: {
  matrix: [number, number, number, number, number, number];
  targetRef: number;
}): number[] {
  const out: number[] = [];
  out.push(...u8(5, 0));
  out.push(...u16le(0x0000));
  out.push(...s32le(0), ...s32le(0));
  out.push(...u8(0, 0));
  out.push(...u8(22));
  for (const m of opts.matrix) out.push(...s32le(m));
  out.push(...u16le(0), ...u16le(2), ...u8(1));
  out.push(...u16le(56), ...u16le(0), ...u16le(108), ...u16le(64));
  out.push(...u8(108, 0, 148, 0, 108, 0));
  out.push(...cpicSymbolSchema22Tail(opts.targetRef));
  return out;
}

/** `FFFF <schema u16> <len u16> <ascii name>` — a NEWCLASS declaration. */
function classDecl(name: string, schema = 1): number[] {
  return [
    ...NEWCLASS,
    ...u16le(schema),
    ...u16le(name.length),
    ...ascii(name),
  ];
}

const IDENTITY: [number, number, number, number, number, number] = [
  FIXED_1,
  0,
  0,
  FIXED_1,
  6000, // tx = 6000 twips = 300 px
  3000, // ty = 3000 twips = 150 px
];

// ── tryParseInstanceAt: the field-by-field placement parser ─────────────────
describe('binary-instance-decoder: tryParseInstanceAt', () => {
  it('decodes a CPicSprite placement body (matrix + media_ref)', () => {
    const body = new Uint8Array(
      placementBody({ matrix: IDENTITY, mediaRef: 1 })
    );
    const inst = tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl');
    expect(inst).not.toBeNull();
    expect(inst!.mediaRef).toBe(1);
    expect(inst!.className).toBe('CPicSprite');
    expect(inst!.matrix).toEqual({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      tx: 300, // 6000 twips ÷ 20
      ty: 150, // 3000 twips ÷ 20
    });
    expect(inst!.endPos).toBe(body.length);
  });

  it('consumes CPicSymbol schema 22 native tail before the next CArchive tag', () => {
    const tail = cpicSymbolSchema22Tail(4);
    expect(tail).toHaveLength(128);
    const body = new Uint8Array([
      ...placementBody({
        cpicObjSchema: 5,
        symbolSchema: 22,
        matrix: [FIXED_1, 0, 0, FIXED_1, 0, 0],
        mediaRef: 1,
      }),
      ...tail,
    ]);

    const inst = tryParseInstanceAt(body, 0, 'CPicSymbol', 'class_decl');
    expect(inst).not.toBeNull();
    expect(inst!.mediaRef).toBe(1);
    expect(inst!.altMediaRef).toBe(4);
    expect(inst!.endPos).toBe(body.length);
  });

  it('uses schema 22 transform tail when legacy name/media fields are absent', () => {
    const body = new Uint8Array(
      placementBodySchema22Variant({
        matrix: [FIXED_1, 0, 0, FIXED_1, 0, 0],
        targetRef: 38,
      })
    );

    const inst = tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl');
    expect(inst).not.toBeNull();
    expect(inst!.mediaRef).toBe(38);
    expect(inst!.altMediaRef).toBe(38);
    expect(inst!.instanceName).toBe('');
    expect(inst!.endPos).toBe(body.length);
  });

  it('decodes a non-identity matrix (scale + translate)', () => {
    // a=0.5, d=2.0, tx=40 twips (=2px), ty=-100 twips (=-5px).
    const body = new Uint8Array(
      placementBody({
        matrix: [FIXED_1 / 2, 0, 0, FIXED_1 * 2, 40, -100],
        mediaRef: 7,
        name: 'inst7',
      })
    );
    const inst = tryParseInstanceAt(body, 0, 'CPicShapeObj', 'backref')!;
    expect(inst.matrix.a).toBeCloseTo(0.5, 6);
    expect(inst.matrix.d).toBeCloseTo(2.0, 6);
    expect(inst.matrix.tx).toBeCloseTo(2, 6);
    expect(inst.matrix.ty).toBeCloseTo(-5, 6);
    expect(inst.instanceName).toBe('inst7');
    expect(inst.mediaRef).toBe(7);
  });

  it('handles CPicObj schema 5 (extra1/extra2 bytes present)', () => {
    const body = new Uint8Array(
      placementBody({ cpicObjSchema: 5, matrix: IDENTITY, mediaRef: 3 })
    );
    const inst = tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')!;
    expect(inst.mediaRef).toBe(3);
    expect(inst.matrix.tx).toBe(300);
  });

  it('decodes a BlurFilter from the placement tail', () => {
    const body = new Uint8Array([
      ...placementBody({ matrix: IDENTITY, mediaRef: 3 }),
      0x00, // no color transform
      0x01, // one filter
      0x01, // BlurFilter
      ...s32le(10 * FIXED_1),
      ...s32le(12 * FIXED_1),
      0x10, // quality=2 in the top five bits
    ]);
    const inst = tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')!;
    expect(inst.filters).toEqual([{ type: 'blur', blurX: 10, blurY: 12, quality: 2 }]);
    expect(inst.endPos).toBe(body.length);
  });

  it('decodes a DropShadowFilter after a color transform tail', () => {
    const body = new Uint8Array([
      ...placementBody({ matrix: IDENTITY, mediaRef: 3 }),
      0x01, // has color transform
      ...u16le(128), // alphaMultiplier = 0.5
      0xff, ...u16le(0),
      0xff, ...u16le(0),
      0xff, ...u16le(0),
      ...u16le(0),
      0x01, // one filter
      0x00, // DropShadowFilter
      0x11, 0x22, 0x33, 0x80,
      ...s32le(4 * FIXED_1),
      ...s32le(5 * FIXED_1),
      ...s32le(Math.round(Math.PI / 4 * FIXED_1)),
      ...s32le(6 * FIXED_1),
      ...u16le(512), // strength = 2.0 fixed8
      0x18, // quality=3
    ]);
    const inst = tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')!;
    expect(inst.colorTransform?.alphaMultiplier).toBeCloseTo(0.5, 6);
    expect(inst.filters).toHaveLength(1);
    const filter = inst.filters![0];
    expect(filter.type).toBe('dropShadow');
    if (filter.type === 'dropShadow') {
      expect(filter.color).toBe('#112233');
      expect(filter.alpha).toBeCloseTo(128 / 255, 6);
      expect(filter.blurX).toBe(4);
      expect(filter.blurY).toBe(5);
      expect(filter.distance).toBe(6);
      expect(filter.angle).toBeCloseTo(45, 3);
      expect(filter.strength).toBe(2);
      expect(filter.quality).toBe(3);
    }
    expect(inst.endPos).toBe(body.length);
  });

  it('decodes schema 23 component dataBindingXML tail and Flash-string instance name', () => {
    const componentXml = "<component metaDataFetched='true' schemaUrl='' schemaOperation='' sceneRootLabel='ItemCard' oldCopiedComponentPath=''>\n</component>\n";
    const body = new Uint8Array([
      ...u8(6, 2),
      ...u16le(0),
      ...s32le(6553),
      ...s32le(7111),
      ...u8(0, 0, 0),
      ...u8(23),
      ...s32le(FIXED_1),
      ...s32le(0),
      ...s32le(0),
      ...s32le(FIXED_1),
      ...s32le(6553),
      ...s32le(7111),
      ...u16le(0),
      ...u16le(2),
      ...u8(1),
      ...u16le(1),
      ...u16le(0),
      ...u16le(1),
      ...u16le(1),
      ...u8(0),
      ...u32le(1),
      ...u32le(1),
      ...u32le(0),
      ...flashString(''),
      ...u32le(2),
      ...new Array(120).fill(0),
      ...flashString('animate'),
      ...u8(2, 0, 0, 0, 0, 0),
      ...flashString(componentXml),
    ]);

    const inst = tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')!;
    expect(inst).not.toBeNull();
    expect(inst.instanceName).toBe('animate');
    expect(inst.mediaRef).toBe(1);
    expect(inst.componentDataBindingXML).toBe(componentXml);
    expect(inst.colorTransform).toBeUndefined();
    expect(inst.endPos).toBe(body.length);
  });
  it('rejects a body whose child list is not the NULL terminator', () => {
    const body = new Uint8Array(
      placementBody({ matrix: IDENTITY, mediaRef: 1 })
    );
    // Corrupt the child tag (bytes 2..3) to a non-null value.
    body[2] = 0xff;
    body[3] = 0xff;
    expect(tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')).toBeNull();
  });

  it('rejects a degenerate (a=d=0) matrix', () => {
    const body = new Uint8Array(
      placementBody({ matrix: [0, 0, 0, 0, 6000, 3000], mediaRef: 1 })
    );
    expect(tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')).toBeNull();
  });

  it('rejects an out-of-range media_ref (likely a mis-parse)', () => {
    const body = new Uint8Array(
      placementBody({ matrix: IDENTITY, mediaRef: 99999 })
    );
    expect(tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')).toBeNull();
  });

  it('rejects truncated input without throwing', () => {
    const body = new Uint8Array(
      placementBody({ matrix: IDENTITY, mediaRef: 1 })
    ).subarray(0, 10);
    expect(tryParseInstanceAt(body, 0, 'CPicSprite', 'class_decl')).toBeNull();
  });
});

/**
 * Build a CPicText body for tryParseTextInstanceAt.
 *
 * Layout (schema=5, 14-byte header):
 *   [0-1]   schema(5), flags(0)
 *   [2-3]   childTag = 0x0000
 *   [4-7]   regPoint.x = INT_MIN
 *   [8-11]  regPoint.y = INT_MIN
 *   [12-13] extra1=0, extra2=0
 *   [14-52] format block (39 bytes)
 *     [43]    width LSB, [44] fontSize (=width MSB), [45] fontSize MSB (0)
 *     [51]    height LSB, [52] height MSB
 *   [53+]   Flash strings + fillColor
 *
 * fillColor encoded as 4 padding zeros + ABGR bytes after last font face.
 * E.g., #999999 → `00 00 00 00 99 99 99 ff`.
 */
function cpicTextBody(opts: {
  widthLow?: number;
  fontSize?: number;
  heightTwips?: number;
  fontFace?: string;
  characters?: string;
  instanceName?: string;
  fillColor?: string;
}): Uint8Array {
  const fontSize = opts.fontSize ?? 30;
  const widthLow = opts.widthLow ?? 79;
  const height = opts.heightTwips ?? 857;
  const fontFace = opts.fontFace ?? '';
  const text = opts.characters ?? '';
  const name = opts.instanceName ?? '';
  const fillColor = opts.fillColor ?? '';

  const out: number[] = [];

  // CPicObj header (schema=5)
  out.push(5, 0);
  out.push(...u16le(0x0000));
  out.push(...s32le(0x80000000));
  out.push(...s32le(0x80000000));
  out.push(0, 0);

  // Format block fill (14..42 = 29 bytes of plausible padding)
  out.push(0x0e, 0x00, 0x00, 0x01); // [14-17]
  for (let i = 0; i < 25; i++) out.push(0); // [18-42]

  // [43] width low byte, [44] fontSize (overlap), [45] zero
  out.push(widthLow, fontSize, 0);

  // [46-50] padding
  for (let i = 0; i < 5; i++) out.push(0);

  // [51] height LSB, [52] height MSB
  out.push(height & 0xff, (height >> 8) & 0xff);

  // Flash strings after the format block.
  // In real FLAs, the font face is followed immediately by fillColor
  // (4-zero padding + ABGR bytes), then text sentinel + instance name.
  if (fontFace) {
    out.push(...flashString(fontFace));
    // Fill color: 4-zero padding + ABGR bytes (after last font face string)
    if (fillColor && fillColor.startsWith('#') && fillColor.length >= 7) {
      const r = parseInt(fillColor.slice(1, 3), 16);
      const g = parseInt(fillColor.slice(3, 5), 16);
      const b = parseInt(fillColor.slice(5, 7), 16);
      if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
        out.push(0x00, 0x00, 0x00, 0x00); // padding
        out.push(b, g, r, 0xff); // ABGR: B, G, R, A
      }
    }
  }
  if (text) {
    // Text sentinel FF FE FF 00 + UTF-16LE text + null terminator
    out.push(0xff, 0xfe, 0xff, 0x00, ...utf16le(text), 0x00, 0x00);
  }
  if (name) out.push(...flashString(name));

  return new Uint8Array(out);
}

// ── tryParseTextInstanceAt: CPicText body parser ────────────────────────────
describe('binary-instance-decoder: tryParseTextInstanceAt (CPicText)', () => {
  it('decodes fontFace, characters, instanceName from Flash strings', () => {
    const body = cpicTextBody({
      fontFace: '$EverywhereMediumFont*',
      characters: 'Hello',
      instanceName: 'myField',
    });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst).not.toBeNull();
    expect(inst!.className).toBe('CPicText');
    expect(inst!.instanceName).toBe('myField');
    expect(inst!.textData?.characters).toBe('Hello');
    expect(inst!.textData?.fontFace).toBe('$EverywhereMediumFont*');
  });

  it('returns null for invalid schema', () => {
    const body = cpicTextBody({ characters: 'x' });
    body[0] = 99; // invalid schema
    expect(tryParseTextInstanceAt(body, 0, 'backref')).toBeNull();
  });

  it('returns null for non-null childTag', () => {
    const body = cpicTextBody({ characters: 'x' });
    body[2] = 0x01; // non-null childTag
    body[3] = 0x00;
    expect(tryParseTextInstanceAt(body, 0, 'class_decl')).toBeNull();
  });

  it('handles empty characters (no text sentinel)', () => {
    const body = cpicTextBody({
      fontFace: '_sans',
      characters: '', // no text sentinel included
    });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst).not.toBeNull();
    expect(inst!.textData?.characters).toBe('');
    expect(inst!.textData?.fontFace).toBe('_sans');
  });

  it('handles unnamed text (no instance name)', () => {
    const body = cpicTextBody({
      characters: 'static text',
      instanceName: '', // no instance name Flash string
    });
    const inst = tryParseTextInstanceAt(body, 0, 'backref');
    expect(inst).not.toBeNull();
    expect(inst!.instanceName).toBe('');
    expect(inst!.textData?.characters).toBe('static text');
  });

  it('recovers non-ASCII characters (Cyrillic)', () => {
    const body = cpicTextBody({
      fontFace: 'ArialMT',
      characters: 'Привет мир',
    });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst).not.toBeNull();
    expect(inst!.textData?.characters).toBe('Привет мир');
    expect(inst!.textData?.fontFace).toBe('ArialMT');
  });
});

describe('binary-instance-decoder: tryParseTextInstanceAt structured fields (P1.2)', () => {
  it('reads fontSize from bodyStart+44', () => {
    const body = cpicTextBody({ fontSize: 30, characters: 'x' });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst!.textData?.fontSize).toBe(30);
  });

  it('reads height from bodyStart+51/52', () => {
    const body = cpicTextBody({ heightTwips: 857, characters: 'x' });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst!.textData?.height).toBeCloseTo(857 / 20, 4);
  });

  it('reads width from bodyStart+43 with fontSize overlap', () => {
    // width = (fontSize << 8) | widthLow
    const body = cpicTextBody({ fontSize: 30, widthLow: 79, characters: 'x' });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    // 30 * 256 + 79 = 7759 twips ÷ 20 = 387.95 px
    expect(inst!.textData?.width).toBeCloseTo(7759 / 20, 4);
  });

  it('defaults fontSize when byte[44] is 0', () => {
    const body = cpicTextBody({ fontSize: 0, characters: 'x' });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst!.textData?.fontSize).toBeUndefined();
  });

  it('defaults height when twips out of range', () => {
    // height 0 → out of range (zero)
    const zero = cpicTextBody({ heightTwips: 0, characters: 'x' });
    const inst = tryParseTextInstanceAt(zero, 0, 'class_decl');
    expect(inst!.textData?.height).toBeUndefined();
  });

  it('defaults width when twips out of range', () => {
    const body = cpicTextBody({ fontSize: 1, widthLow: 0, characters: 'x' });
    // width = (1 << 8) | 0 = 256 twips = 12.8 px — in range
    const inst1 = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst1!.textData?.width).toBeCloseTo(256 / 20, 4);

    // width 0 → out of range (zero)
    const zero = cpicTextBody({ fontSize: 0, widthLow: 0, characters: 'x' });
    const inst2 = tryParseTextInstanceAt(zero, 0, 'class_decl');
    expect(inst2!.textData?.width).toBeUndefined();
  });

  it('extracts fillColor from ABGR bytes after font face', () => {
    const body = cpicTextBody({
      fontFace: '$EverywhereMediumFont*',
      characters: 'x',
      fillColor: '#FFFFFF',
    });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst!.textData?.fillColor).toBe('#FFFFFF');
  });

  it('extracts #999999 fillColor', () => {
    const body = cpicTextBody({
      fontFace: '$EverywhereMediumFont*',
      characters: 'x',
      fillColor: '#999999',
    });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst!.textData?.fillColor).toBe('#999999');
  });

  it('defaults fillColor to #000000 when no color bytes follow font face', () => {
    const body = cpicTextBody({
      fontFace: '$EverywhereMediumFont*',
      characters: 'x',
      fillColor: '', // no padding/color appended
    });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst!.textData?.fillColor).toBe('#000000');
  });

  it('defaults fillColor to #000000 when no font face present', () => {
    const body = cpicTextBody({
      characters: 'static text',
      fontFace: '',
    });
    const inst = tryParseTextInstanceAt(body, 0, 'class_decl');
    expect(inst!.textData?.fillColor).toBe('#000000');
  });
});

// ── buildCombinedClassTable: NEWCLASS forward scan ──────────────────────────
describe('binary-instance-decoder: buildCombinedClassTable', () => {
  it('allocates two combined slots per NEWCLASS, in stream order', () => {
    const data = new Uint8Array([
      ...classDecl('CPicPage'),
      0x00,
      ...classDecl('CPicLayer'),
      0x00,
      ...classDecl('CPicSprite'),
    ]);
    const combined = buildCombinedClassTable(data);
    // 3 classes × 2 slots = 6 entries; class is at odd 1-based index.
    expect(combined).toEqual([
      'CPicPage',
      'CPicPage',
      'CPicLayer',
      'CPicLayer',
      'CPicSprite',
      'CPicSprite',
    ]);
    // CPicSprite's class slot is combined index 5 (1-based) → combined[4].
    expect(combined[4]).toBe('CPicSprite');
  });
});

// ── scanForInstances: class-decl + backref recovery ─────────────────────────
describe('binary-instance-decoder: scanForInstances', () => {
  it('recovers a placement following a CPicSprite class declaration', () => {
    const data = new Uint8Array([
      ...classDecl('CPicPage'),
      ...classDecl('CPicSprite'),
      ...placementBody({ matrix: IDENTITY, mediaRef: 1 }),
    ]);
    const found = scanForInstances(data);
    expect(found).toHaveLength(1);
    expect(found[0].className).toBe('CPicSprite');
    expect(found[0].mediaRef).toBe(1);
    expect(found[0].recoveredVia).toBe('class_decl');
    expect(found[0].matrix.tx).toBe(300);
  });

  it('recovers extra placements via a back-ref tag to the instance class', () => {
    // With CPicPage (combined 1/2) then CPicSprite (combined 3/4) declared, a
    // second placement is instantiated with a back-ref to CPicSprite's object
    // slot — tag 0x8004 (combined index 4). (Real files put CPicSprite later in
    // the table; this synthetic stream just declares the two classes it needs.)
    const decls = [...classDecl('CPicPage'), ...classDecl('CPicSprite')];
    const first = placementBody({ matrix: IDENTITY, mediaRef: 1 });
    const backref = u16le(0x8004);
    const second = placementBody({
      matrix: [FIXED_1, 0, 0, FIXED_1, 1000, 2000],
      mediaRef: 2,
    });
    const data = new Uint8Array([...decls, ...first, ...backref, ...second]);
    const found = scanForInstances(data);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.mediaRef).sort()).toEqual([1, 2]);
    const byBackref = found.find((f) => f.recoveredVia === 'backref');
    expect(byBackref).toBeDefined();
    expect(byBackref!.mediaRef).toBe(2);
    expect(byBackref!.matrix.tx).toBe(50); // 1000 twips ÷ 20
  });

  it('does NOT treat a back-ref to a NON-instance class as a placement', () => {
    // CPicFrame is declared at combined index 3/4 — NOT an instance class. A
    // back-ref 0x8004 preceding a placement-shaped body must be ignored, even
    // if the trailing bytes would otherwise parse (false-positive guard).
    const decls = [
      ...classDecl('CPicPage'),
      ...classDecl('CPicFrame'),
      ...classDecl('CPicSprite'),
    ];
    const sprite = placementBody({ matrix: IDENTITY, mediaRef: 1 });
    // A CPicFrame back-ref (0x8004) followed by a placement-shaped body.
    const frameBackref = u16le(0x8004);
    const decoy = placementBody({
      matrix: [FIXED_1, 0, 0, FIXED_1, 500, 500],
      mediaRef: 9,
    });
    const data = new Uint8Array([
      ...decls,
      ...sprite,
      ...frameBackref,
      ...decoy,
    ]);
    const found = scanForInstances(data);
    // Only the genuine CPicSprite declaration placement is recovered.
    expect(found.map((f) => f.mediaRef)).toEqual([1]);
  });
});

// ── dedupeInstances ─────────────────────────────────────────────────────────
describe('binary-instance-decoder: dedupeInstances', () => {
  it('collapses placements identical in mediaRef + matrix, keeps distinct', () => {
    const base: Omit<DecodedInstance, 'matrix' | 'mediaRef'> = {
      className: 'CPicSprite',
      instanceName: '',
      recoveredVia: 'backref',
      bodyStart: 0,
      endPos: 0,
      altMediaRef: 0,
    };
    const m = (tx: number): DecodedInstance['matrix'] => ({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      tx,
      ty: 0,
    });
    const insts: DecodedInstance[] = [
      { ...base, mediaRef: 1, matrix: m(10) },
      { ...base, mediaRef: 1, matrix: m(10) }, // exact duplicate
      { ...base, mediaRef: 1, matrix: m(20) }, // distinct position
      { ...base, mediaRef: 2, matrix: m(10) }, // distinct symbol
    ];
    const deduped = dedupeInstances(insts);
    expect(deduped).toHaveLength(3);
  });
});

describe('binary-instance-decoder: instanceSymbolType', () => {
  it('maps placement classes to viewer symbol kinds', () => {
    expect(instanceSymbolType('CPicButton')).toBe('button');
    expect(instanceSymbolType('CPicShapeObj')).toBe('graphic');
    expect(instanceSymbolType('CPicSprite')).toBe('movieclip');
  });
});

// ── REAL-FILE: btnstrob.fla scene places library Symbol 1 ───────────────────
// The headline case: the scene (Page 1) PLACES Symbol 1 (a green square) via a
// CPicSprite instance at (300,150) px. The geometry PR decoded the symbol into
// the library but left the stage EMPTY; this decodes the placement.
describe('binary-instance-decoder: real Flash MX 2004 FLA (btnstrob.fla)', () => {
  it('recovers the scene CPicSprite placement (media_ref 1 @ 300,150)', async () => {
    const bytes = await loadBtnstrob();
    expect([...bytes.slice(0, 4)]).toEqual([0xd0, 0xcf, 0x11, 0xe0]);
    const ole = new OLE2File(bytes);
    const found = scanForInstances(ole.readStream('Page 1'));
    expect(found).toHaveLength(1);
    expect(found[0].className).toBe('CPicSprite');
    expect(found[0].mediaRef).toBe(1); // → library "Symbol 1"
    expect(found[0].matrix).toEqual({
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      tx: 300,
      ty: 150,
    });
  });

  it('attaches the instance name to the placement by byte offset (no new placements)', async () => {
    const bytes = await loadBtnstrob();
    const page1 = new OLE2File(bytes).readStream('Page 1');
    const raw = scanForInstances(page1);
    // The structural read leaves the placement name empty for this file…
    expect(raw[0].instanceName).toBe('');
    // …and the name scanner finds it at the SAME body offset.
    const named = scanNamedInstances(page1);
    expect(named.some((n) => n.name === 'mvcBtnStrobe' && n.bodyStart === raw[0].bodyStart)).toBe(true);

    const enriched = attachInstanceNames(raw, named);
    // The join only fills the name — count, order, geometry are unchanged.
    expect(enriched).toHaveLength(raw.length);
    expect(enriched[0].instanceName).toBe('mvcBtnStrobe');
    expect(enriched[0].mediaRef).toBe(raw[0].mediaRef);
    expect(enriched[0].matrix).toEqual(raw[0].matrix);
  });

  it('parseBinaryFLA composites Symbol 1 onto the scene (was empty)', async () => {
    const bytes = await loadBtnstrob();
    const doc = parseBinaryFLA(bytes);

    // The library still decodes its symbols (geometry PR).
    expect(doc.symbols.has('Symbol 1')).toBe(true);

    // btnstrob carries no AS linkage table, so the optional document field is
    // omitted (only populated for binary FLAs that actually have linkage records).
    expect(doc.linkage).toBeUndefined();

    // The scene now carries a SymbolInstance referencing Symbol 1 — previously
    // the scene's frames were entirely empty.
    const scene = doc.timelines[0];
    const allElements = scene.layers.flatMap((l) =>
      l.frames.flatMap((f) => f.elements)
    );
    const symbolInstances = allElements.filter((e) => e.type === 'symbol');
    expect(symbolInstances).toHaveLength(1);
    const placed = symbolInstances[0];
    expect(placed.type).toBe('symbol');
    if (placed.type === 'symbol') {
      expect(placed.libraryItemName).toBe('Symbol 1');
      // The placement's authoring instance name is folded in by byte offset from
      // the higher-recall name scanner (the structural read leaves it empty here).
      expect(placed.name).toBe('mvcBtnStrobe');
      expect(placed.matrix.tx).toBe(300);
      expect(placed.matrix.ty).toBe(150);
      // The referenced symbol exists and carries the green square geometry.
      const sym = doc.symbols.get(placed.libraryItemName)!;
      const shapes = sym.timeline.layers
        .flatMap((l) => l.frames.flatMap((f) => f.elements))
        .filter((e) => e.type === 'shape');
      expect(shapes.length).toBeGreaterThanOrEqual(1);
    }

    // The placement is hosted on a layer the renderer will actually draw
    // (visible, not a guide/folder reference layer) — otherwise the artwork
    // would be silently dropped.
    const hostLayer = scene.layers.find((l) =>
      l.frames.some((f) => f.elements.some((e) => e.type === 'symbol'))
    )!;
    expect(hostLayer.visible).toBe(true);
    expect(hostLayer.layerType === 'guide' || hostLayer.layerType === 'folder').toBe(
      false
    );
  });
});

// ── scanNamedInstances: CPicFrame boundary prevents frame labels as names ────
describe('binary-instance-decoder: scanNamedInstances CPicFrame boundary', () => {
  it('excludes a CPicFrame frame label from named instances (regression: SoulGem)', () => {
    // Binary stream with:
    //   1. CPicText NEWCLASS + empty instance name (unnamed text field)
    //   2. CPicFrame NEWCLASS + frame label "frameLabel"
    //
    // Without the BOUNDARY_CLASSES fix, placementName for the CPicText range
    // would scan past the CPicFrame and find "frameLabel" as a text-field name.
    // The fix records CPicFrame as a range boundary, so the scan stops there.
    const data = new Uint8Array([
      // ── CPicText NEWCLASS ──
      0xff, 0xff, 0x01, 0x00, // NEWCLASS tag + schema
      0x08, 0x00,             // MFC CString length (8)
      0x43, 0x50, 0x69, 0x63, 0x54, 0x65, 0x78, 0x74, // "CPicText"
      0x00,                   // empty instance name (unnamed)
      // ── CPicFrame NEWCLASS ──
      0xff, 0xff, 0x01, 0x00, // NEWCLASS tag + schema
      0x09, 0x00,             // MFC CString length (9)
      0x43, 0x50, 0x69, 0x63, 0x46, 0x72, 0x61, 0x6d, 0x65, // "CPicFrame"
      // Frame label Flash string: FF FE FF 07 "frameLabel"
      0xff, 0xfe, 0xff, 0x07,
      0x66, 0x00, 0x72, 0x00, 0x61, 0x00, 0x6d, 0x00, 0x65, 0x00,
      0x4c, 0x00, 0x61, 0x00, 0x62, 0x00, 0x65, 0x00, 0x6c, 0x00,
    ]);
    const result = scanNamedInstances(data);
    // The frame label must NOT appear as a named instance.
    expect(result.some((n) => n.name === 'frameLabel')).toBe(false);
    // The unnamed CPicText produces no names either.
    expect(result).toHaveLength(0);
  });

  it('still recovers a named CPicText when a CPicFrame follows it', () => {
    // Same layout, but the CPicText carries a real instance name "myText".
    const data = new Uint8Array([
      // ── CPicText NEWCLASS ──
      0xff, 0xff, 0x01, 0x00,
      0x08, 0x00,
      0x43, 0x50, 0x69, 0x63, 0x54, 0x65, 0x78, 0x74,
      // Instance name Flash string: FF FE FF 06 "myText"
      0xff, 0xfe, 0xff, 0x06,
      0x6d, 0x00, 0x79, 0x00, 0x54, 0x00, 0x65, 0x00, 0x78, 0x00, 0x74, 0x00,
      // ── CPicFrame NEWCLASS ──
      0xff, 0xff, 0x01, 0x00,
      0x09, 0x00,
      0x43, 0x50, 0x69, 0x63, 0x46, 0x72, 0x61, 0x6d, 0x65,
      // Frame label Flash string: FF FE FF 07 "frameLabel"
      0xff, 0xfe, 0xff, 0x07,
      0x66, 0x00, 0x72, 0x00, 0x61, 0x00, 0x6d, 0x00, 0x65, 0x00,
      0x4c, 0x00, 0x61, 0x00, 0x62, 0x00, 0x65, 0x00, 0x6c, 0x00,
    ]);
    const result = scanNamedInstances(data);
    // The real CPicText name is still recovered.
    expect(result.some((n) => n.name === 'myText')).toBe(true);
    expect(result.some((n) => n.name === 'myText' && n.type === 'text')).toBe(true);
    // The frame label is still excluded.
    expect(result.some((n) => n.name === 'frameLabel')).toBe(false);
  });
});

// ── unjoinedNames: which recovered names become name-only "ghost" elements ───
describe('binary-instance-decoder: unjoinedNames (ghost-name selection)', () => {
  it('returns only names whose bodyStart matches no decoded placement', () => {
    const named: NamedInstance[] = [
      { name: 'joinedClip', type: 'symbol', symbolType: 'movieclip', bodyStart: 100 },
      { name: 'ghostText', type: 'text', bodyStart: 200 },
      { name: 'ghostButton', type: 'symbol', symbolType: 'button', bodyStart: 300 },
    ];
    // Two decoded placements; only bodyStart 100 overlaps a named entry.
    const insts = [{ bodyStart: 100 }, { bodyStart: 999 }] as unknown as DecodedInstance[];
    const ghosts = unjoinedNames(named, insts);
    expect(ghosts.map((g) => g.name)).toEqual(['ghostText', 'ghostButton']);
    // The joined name is excluded (it rides on its decoded placement instead).
    expect(ghosts.some((g) => g.name === 'joinedClip')).toBe(false);
  });

  it('returns the input unchanged when there are no names', () => {
    expect(unjoinedNames([], [{ bodyStart: 5 }] as unknown as DecodedInstance[])).toEqual([]);
  });
});

// ── markUnreliableRefs: distrust an FP8 mediaRef shared by named siblings ─────
describe('binary-instance-decoder: markUnreliableRefs', () => {
  it('flags a mediaRef shared by 2+ named placements (FP8 misread)', () => {
    const insts = [
      { mediaRef: 1, instanceName: 'background' },
      { mediaRef: 1, instanceName: 'icon' },
      { mediaRef: 5, instanceName: 'solo' },
    ] as unknown as DecodedInstance[];
    const out = markUnreliableRefs(insts);
    expect(out.find((i) => i.instanceName === 'background')?.unreliableRef).toBe(true);
    expect(out.find((i) => i.instanceName === 'icon')?.unreliableRef).toBe(true);
    // A ref used by a single named placement is trusted (e.g. btnstrob's scene instance).
    expect(out.find((i) => i.instanceName === 'solo')?.unreliableRef).toBeUndefined();
  });

  it('does not flag unnamed repeated copies of the same symbol', () => {
    const insts = [
      { mediaRef: 7, instanceName: '' },
      { mediaRef: 7, instanceName: '' },
      { mediaRef: 1, instanceName: 'only' },
    ] as unknown as DecodedInstance[];
    expect(markUnreliableRefs(insts).some((i) => i.unreliableRef)).toBe(false);
  });

  it('trusts a corrected (refCorrected) shared ref — repeated list entries keep it', () => {
    // Entry0..2 all legitimately reference the same renderer symbol after the FP8
    // mediaRef was corrected; they must NOT be mistaken for the misread.
    const insts = [
      { mediaRef: 8, instanceName: 'Entry0', refCorrected: true },
      { mediaRef: 8, instanceName: 'Entry1', refCorrected: true },
      { mediaRef: 8, instanceName: 'Entry2', refCorrected: true },
    ] as unknown as DecodedInstance[];
    expect(markUnreliableRefs(insts).some((i) => i.unreliableRef)).toBe(false);
  });
});

// ── correctFp8Refs: recover the real FP8 placement mediaRef from +72 ──────────
describe('binary-instance-decoder: correctFp8Refs', () => {
  it('swaps in altMediaRef for an FP8 placement when it is a real symbol number', () => {
    const insts = [
      // FP8: structural name empty, alt is a real symbol → corrected.
      { instanceName: '', mediaRef: 1, altMediaRef: 8 },
      // alt is not a real symbol stream → keep the (misread) ref, not corrected.
      { instanceName: '', mediaRef: 1, altMediaRef: 999 },
      // 16.16: structural name present → never touched.
      { instanceName: 'realName', mediaRef: 5, altMediaRef: 8 },
    ] as unknown as DecodedInstance[];
    const out = correctFp8Refs(insts, new Set([8, 46]));
    expect(out[0].mediaRef).toBe(8);
    expect(out[0].refCorrected).toBe(true);
    expect(out[1].mediaRef).toBe(1);
    expect(out[1].refCorrected).toBeUndefined();
    expect(out[2].mediaRef).toBe(5);
    expect(out[2].refCorrected).toBeUndefined();
  });
});
