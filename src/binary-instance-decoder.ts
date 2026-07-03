/**
 * SYMBOL-INSTANCE PLACEMENT decoder for pre-CS5 *binary* `.fla` files
 * (GitHub issue #8 — the frontier the shape-geometry work in
 * {@link ./binary-shape-decoder} deliberately left open).
 *
 * The geometry decoder makes a binary FLA's *library symbols* render: it
 * recovers the `CPicShape` vector art inside each `Symbol N` / `Page N` stream.
 * But a scene's STAGE stays empty, because a scene does not contain inline art —
 * it contains symbol *instances*: a library-item reference plus a placement
 * matrix. This module decodes those placements so scenes composite their
 * library symbols and real artwork appears on the stage.
 *
 * ── How a placed instance is encoded (verified against real Flash FLAs) ──────
 *
 * The class tree (FORMAT.md §3, reverse-engineered from Flash 8's flash.exe):
 *
 *     CPicObj
 *       └── CPicSymbol  (244 B)              — a library item / placement base
 *             ├── CPicShapeObj (244 B)        — placed graphic-symbol instance
 *             ├── CPicSprite   (408 B)        — placed movie-clip instance
 *             └── CPicButton   (548 B)        — placed button instance
 *
 * A placement is a `CPicSymbol`-derived object that appears as a CHILD of a
 * `CPicFrame` (`CPicPage → CPicLayer → CPicFrame → {CPicShape | placement}`).
 * Its `Serialize` (FORMAT.md §4 `CPicSymbol::Serialize`) lays out as:
 *
 *     CPicObj::Serialize         — u8 schema; u8 flags; children-list (NULL for
 *                                  a leaf placement); 2×s32 point (schema>=1);
 *                                  u8 (schema>=3); u8 (schema>=4)
 *     u8       symbol_schema
 *     6×u32    matrix            — a,b,c,d 16.16 fixed; tx,ty integer twips
 *     u16      field_b0
 *     u16      field_cc
 *     u8       field_90 marker   — (always 1) + 4×u16
 *     u8 len + ascii instance-name  (often empty)
 *     u32      media_ref         — THE LIBRARY REFERENCE: the N in "Symbol N"
 *
 * `media_ref` is the library item id (the same `u32` the library table writes
 * after each item name in `Contents`), which maps directly to the symbol number
 * and the `Symbol N` OLE stream. So a placement says "draw library item
 * media_ref here, transformed by this matrix" — exactly Flash's stage model.
 *
 * Real byte evidence (btnstrob.fla `Page 1`): a single `CPicSprite` child of the
 * scene's frame with matrix `(65536,0,0,65536, 6000,3000)` → scale 1.0,
 * tx=300 px, ty=150 px, and `media_ref=1` → library "Symbol 1" (a green
 * `#66ff00` graphic). That places Symbol 1's art at (300,150) on the 550×400
 * stage.
 *
 * ── Why a recovery scanner (not the structured walk) ─────────────────────────
 *
 * `CPicFrame` has dozens of schema-gated trailing fields (labels, tween data,
 * sound cues, child placements) gated by a schema observed up to ~32; even the
 * reference decoder cannot reliably consume them and falls back to a signature
 * scan (FORMAT.md §10, §11.5). A structured `CPicPage→…→CPicFrame` walk desyncs
 * in that tail and SILENTLY DROPS the frame's child placements — empirically it
 * misses most instances (it found 49 across a 140-FLA corpus where a recovery
 * scan found 279). So, exactly like the shape decoder, we use a recovery
 * scanner that locates placement bodies directly:
 *
 *   1. class-declaration recovery — every `FFFF <schema> <len> "CPicSprite"`
 *      (or CPicShapeObj / CPicButton) is guaranteed to be followed by a
 *      placement body; parse it.
 *   2. back-reference recovery — Flash instantiates additional placements of an
 *      already-declared class with a back-ref tag `0x80NN`. We first scan the
 *      stream for the NEWCLASS declarations to learn which combined-table index
 *      maps to an instance class, then accept a placement body only when the two
 *      bytes preceding it are a back-ref tag whose index resolves to an instance
 *      class. (Requiring a real preceding class tag — not a brute-force body
 *      match — eliminates the false positives that a naked signature scan
 *      produces.)
 *
 * No errors are silently swallowed (project rule): a body that fails validation
 * is skipped, never crashing the parse; nothing is fabricated.
 */

import { ByteReader, EndOfStreamError } from './binary-shape-decoder';
import {
  buildCombinedClassTable as buildArchiveCombinedClassTable,
  scanCArchiveObjectStarts,
} from './binary-carchive';
import {
  decodeRawUtf16UntilNull,
  readFlashStringAt,
} from './binary-flash-string';
import { parseSwfFilterStack } from './binary-swf-filters';
import type { BlendMode, ColorTransform, ComponentParameter, Filter, Matrix } from './types';

/** 16.16 fixed-point divisor (1.0 == 0x00010000). */
const FIXED_16_16 = 65536;
/** Matrix translation unit: 1 px = 20 twips. */
const TWIPS_PER_PX = 20;

/** The three concrete `CPicSymbol` subclasses that represent a placement. */
export const INSTANCE_CLASS_NAMES = [
  'CPicSprite',
  'CPicShapeObj',
  'CPicButton',
] as const;
export type InstanceClassName = (typeof INSTANCE_CLASS_NAMES)[number];

/** Map an instance class name to a viewer symbol kind. */
export function instanceSymbolType(
  cls: InstanceClassName | string
): 'graphic' | 'movieclip' | 'button' {
  switch (cls) {
    case 'CPicButton':
      return 'button';
    case 'CPicShapeObj':
      return 'graphic';
    case 'CPicSprite':
    default:
      // CPicSprite is a movie clip; unknown placements default to movie clip.
      return 'movieclip';
  }
}

export interface DecodedTextData {
  /** Text content characters (e.g. "SELECTED  TEXT"). */
  characters: string;
  /** Font face name (e.g. "$EverywhereMediumFont*", "_sans"). */
  fontFace?: string;
  /** Font size in points. */
  fontSize?: number;
  /** Fill color as hex string (e.g. "#FFFFFF"). */
  fillColor?: string;
  /** True when the text run uses the bold face flag from CPicText format data. */
  bold?: boolean;
  /** Text alignment. */
  alignment?: 'left' | 'center' | 'right' | 'justify';
  /** Letter spacing in twips. */
  letterSpacing?: number;
  /** Width in twips. */
  width?: number;
  /** Height in twips. */
  height?: number;
}

/** One decoded placement: a library reference + transform, from one stream. */
export interface DecodedInstance {
  /** Source class (CPicSprite / CPicShapeObj / CPicButton / CPicText). */
  className: InstanceClassName | string;
  /** Library item id (the N in "Symbol N"); maps to a library entry. */
  mediaRef: number;
  /** Optional authoring instance name (usually empty for graphics). */
  instanceName: string;
  /** Placement transform (a/b/c/d unitless, tx/ty in pixels). */
  matrix: Matrix;
  /** How it was recovered (for honest coverage reporting). */
  recoveredVia: 'class_decl' | 'backref';
  /** Byte offset of the body start (just past the class tag). */
  bodyStart: number;
  /** Byte offset just past the body. */
  endPos: number;
  /** Text-specific data for CPicText placements. */
  textData?: DecodedTextData;
  /**
   * The u32 at `bodyStart + 72` — the REAL library symbol number for an FP8
   * (float32-matrix) placement, which {@link tryParseInstanceAt}'s 16.16 reader
   * mis-reads as the constant `mediaRef`. The parser prefers this (validated
   * against the actual symbol-stream numbers) for FP8 placements so a container
   * instance keeps the correct `libraryItemName`. Verified against the linkage
   * ground truth (e.g. favoritesmenu `Entry0..6` → S8 = FavoritesListEntry,
   * `btnAll` → S169 = AllButton). 0 when out of range. See memory.
   */
  altMediaRef: number;
  /**
   * Set when {@link correctFp8Refs} replaced `mediaRef` with the validated
   * `altMediaRef` (an actual symbol-stream number). A corrected ref is trusted —
   * {@link markUnreliableRefs} never flags it, so legitimately-repeated instances
   * (e.g. a list's `Entry0..6`, all the same renderer symbol) keep their shared
   * reference instead of being mistaken for the FP8 misread.
   */
  refCorrected?: boolean;
  /**
   * Set when this placement's `mediaRef` can't be trusted — an FP8 placement
   * mis-decodes the library reference (it lands on a constant), so when several
   * NAMED siblings share one ref it cannot be the real symbol. The parser then
   * emits the named child WITHOUT a libraryItemName instead of inheriting a wrong
   * class. See {@link markUnreliableRefs}.
   */
  unreliableRef?: boolean;
  /**
   * Color transform (CXForm) decoded from the CPicSprite/CPicButton tail
   * after mediaRef. Undefined when absent or not parseable. PLAN.md §3.1.
   */
  colorTransform?: ColorTransform;
  /** Blur/Glow/DropShadow filters decoded from the placement tail. */
  filters?: Filter[];
  /**
   * Component Inspector parameters. The binary layout is version-specific; this
   * is only populated when a future structured decoder can prove a safe read.
   */
  componentParameters?: ComponentParameter[];
  componentDataBindingXML?: string;
  blendMode?: BlendMode;
}

/** Read a 6-u32 affine matrix (a,b,c,d 16.16 FP; tx,ty twips → px). */
function readMatrix(r: ByteReader): Matrix {
  const a = r.s32();
  const b = r.s32();
  const c = r.s32();
  const d = r.s32();
  const tx = r.s32();
  const ty = r.s32();
  return {
    a: a / FIXED_16_16,
    b: b / FIXED_16_16,
    c: c / FIXED_16_16,
    d: d / FIXED_16_16,
    tx: tx / TWIPS_PER_PX,
    ty: ty / TWIPS_PER_PX,
  };
}

/** Plausibility bounds rejecting parses that hit unrelated bytes. */
const MAX_SCALE = 64; // |a|,|b|,|c|,|d| as 16.16 multiples of 1.0
const MAX_TX_TWIPS = 20 * 200_000; // ±200k px
const MAX_MEDIA_REF = 5000;
const MAX_NAME_LEN = 0x40;

function readU16At(data: Uint8Array, pos: number): number {
  return data[pos] | (data[pos + 1] << 8);
}

function readU32At(data: Uint8Array, pos: number): number {
  return (
    data[pos] |
    (data[pos + 1] << 8) |
    (data[pos + 2] << 16) |
    (data[pos + 3] * 0x1000000)
  ) >>> 0;
}

function hasBytes(data: Uint8Array, pos: number, bytes: readonly number[]): boolean {
  if (pos < 0 || pos + bytes.length > data.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (data[pos + i] !== bytes[i]) return false;
  }
  return true;
}

function tryConsumeSchema22TransformTail(
  data: Uint8Array,
  pos: number
): { end: number; targetRef: number } | null {
  // Observed native schema>=22 placement tail in CS4/FP10 streams:
  // fixed fields, empty marker FF FF FE FF 00, u32 target symbol id,
  // followed by four identity float anchors and padding. This is not a SWF
  // filter/CXForm stack, so the placement must consume it even when no
  // viewer-facing field is emitted.
  const len = 128;
  if (pos + len > data.length) return null;
  // First fixed words vary (`01 00 00 00`, `01 00 00 03`, `03 00 00 00`),
  // but the u16 immediately before the marker is consistently zero.
  if (readU16At(data, pos + 8) !== 0) return null;
  if (!hasBytes(data, pos + 10, [0xff, 0xff, 0xfe, 0xff, 0x00])) return null;

  const targetRef = readU32At(data, pos + 15);
  if (targetRef < 1 || targetRef > MAX_MEDIA_REF) return null;

  for (const rel of [26, 46, 66, 86]) {
    if (!hasBytes(data, pos + rel, [0x00, 0x00, 0x80, 0x3f])) return null;
  }

  return { end: pos + len, targetRef };
}

function findSchema22TransformTail(
  data: Uint8Array,
  start: number,
  maxForward = 32
): { start: number; end: number; targetRef: number } | null {
  const limit = Math.min(data.length, start + maxForward);
  for (let pos = Math.max(0, start); pos <= limit; pos++) {
    const tail = tryConsumeSchema22TransformTail(data, pos);
    if (tail) return { start: pos, ...tail };
  }
  return null;
}

function tryParseComponentDataBindingTail(
  data: Uint8Array,
  start: number,
  maxScan = 4096
): { xml: string; instanceName?: string; end: number } | null {
  const limit = Math.min(data.length - 4, start + maxScan);
  let instanceName: string | undefined;

  for (let p = start; p < limit; p++) {
    if (
      p + 10 <= data.length &&
      data[p] === 0x00 &&
      data[p + 1] === 0x00 &&
      data[p + 2] === 0x00 &&
      data[p + 3] === 0x00 &&
      data[p + 4] === 0x00 &&
      data[p + 5] === 0x80 &&
      data[p + 6] === 0x00 &&
      data[p + 7] === 0x00 &&
      data[p + 8] === 0x00 &&
      data[p + 9] === 0x80
    ) {
      return null;
    }

    const decoded = readFlashStringAt(data, p, { allowEmpty: true, maxChars: 4096 });
    if (!decoded) continue;

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(decoded.value)) {
      instanceName = decoded.value;
    }

    if (
      decoded.value.startsWith('<component ') &&
      decoded.value.includes('</component>')
    ) {
      return { xml: decoded.value, instanceName, end: decoded.end };
    }

    p = decoded.end - 1;
  }

  return null;
}
/**
 * Try to parse a `CPicSymbol`-derived placement body starting at `bodyStart`
 * (the byte just past the placement's class tag). Returns the decoded instance
 * or null if the bytes do not validate as a leaf placement. Uses a fresh reader
 * so a failed attempt never disturbs the caller.
 *
 * The validation gates (matrix-scale, media_ref range, clean instance name)
 * are what let a body match be trusted: a coincidental byte run almost never
 * satisfies all of them at once.
 */
export function tryParseInstanceAt(
  data: Uint8Array,
  bodyStart: number,
  className: InstanceClassName | string,
  recoveredVia: DecodedInstance['recoveredVia']
): DecodedInstance | null {
  if (bodyStart < 0 || bodyStart + 2 > data.length) return null;
  const r = new ByteReader(data);
  r.pos = bodyStart;
  try {
    const schema = r.u8();
    const flags = r.u8();
    if (schema < 1 || schema > 30 || flags > 0x40) return null;

    // CPicObj children list: a leaf placement has only the NULL terminator.
    const childTag = r.u16();
    if (childTag !== 0x0000) return null;

    // schema>=1: 2×s32 registration point (often the matrix's tx/ty in twips,
    // or the INT_MIN "uninitialised" sentinel — either way we ignore it and
    // use the authoritative matrix below).
    r.s32();
    r.s32();
    if (schema >= 3) r.u8();
    if (schema >= 4) r.u8();
    if (schema >= 6) r.u8();

    const symbolSchema = r.u8();
    if (symbolSchema < 1 || symbolSchema > 40) return null;

    const matrix = readMatrix(r);
    // A real placement matrix has a non-degenerate 2×2 and sane scale/translate.
    if (matrix.a === 0 && matrix.d === 0) return null;
    for (const v of [matrix.a, matrix.b, matrix.c, matrix.d]) {
      if (!Number.isFinite(v) || Math.abs(v) > MAX_SCALE) return null;
    }
    if (
      Math.abs(matrix.tx * TWIPS_PER_PX) > MAX_TX_TWIPS ||
      Math.abs(matrix.ty * TWIPS_PER_PX) > MAX_TX_TWIPS
    ) {
      return null;
    }

    r.u16(); // field_b0
    r.u16(); // field_cc
    r.u8(); // field_90 marker (always 1)
    r.u16();
    r.u16();
    r.u16();
    r.u16(); // 4×u16 field_90 struct

    const nameStart = r.pos;
    let instanceName = '';
    let mediaRef: number | undefined;
    let altMediaRef = 0;
    let schema22Tail: { start: number; end: number; targetRef: number } | null = null;

    const nameLen = r.u8();
    if (nameLen <= MAX_NAME_LEN) {
      const nameBytes = r.bytes(nameLen);
      let validName = true;
      for (const ch of nameBytes) {
        // Control bytes (other than common whitespace) mean we mis-parsed.
        if (ch < 9) {
          validName = false;
          break;
        }
        instanceName += String.fromCharCode(ch);
      }
      if (validName && r.remaining() >= 4) {
        const parsedMediaRef = r.u32();
        if (parsedMediaRef >= 1 && parsedMediaRef <= MAX_MEDIA_REF) {
          mediaRef = parsedMediaRef;
        }
      }
    }

    if (mediaRef === undefined && symbolSchema >= 22) {
      schema22Tail = findSchema22TransformTail(data, nameStart - 8);
      if (!schema22Tail) return null;
      mediaRef = schema22Tail.targetRef;
      altMediaRef = schema22Tail.targetRef;
      instanceName = '';
      r.pos = schema22Tail.end;
    }

    if (mediaRef === undefined) return null;

    // The real symbol number for an FP8 placement sits at a fixed offset from the
    // body start (the 16.16 reader above mis-reads `mediaRef`). Read it raw; the
    // parser validates it against the actual symbol-stream numbers.
    const a = bodyStart + 72;
    altMediaRef = altMediaRef || (
      a + 4 <= data.length
        ? data[a] | (data[a + 1] << 8) | (data[a + 2] << 16) | data[a + 3] * 0x1000000
        : 0
    );

    // Read color transform from CPicSprite/CPicButton tail after mediaRef.
    // PLAN.md §3.1: u8 hasColorTransform + conditional 14-byte CXForm struct.
    let colorTransform: ColorTransform | undefined;
    let filters: Filter[] | undefined;
    let componentDataBindingXML: string | undefined;
    const componentTail =
      symbolSchema >= 22
        ? tryParseComponentDataBindingTail(data, r.pos)
        : null;
    if (componentTail) {
      componentDataBindingXML = componentTail.xml;
      if (!instanceName && componentTail.instanceName) {
        instanceName = componentTail.instanceName;
      }
      r.pos = componentTail.end;
    }

    if (!componentTail && symbolSchema >= 22) {
      schema22Tail = schema22Tail ?? findSchema22TransformTail(data, r.pos);
      if (schema22Tail) {
        altMediaRef = schema22Tail.targetRef;
        r.pos = schema22Tail.end;
      }
    }

    if (!componentTail && !schema22Tail && (className === 'CPicSprite' || className === 'CPicButton') && r.remaining() >= 1) {
      const hasCT = r.u8();
      if (hasCT && r.remaining() >= 13) {
        const alphaMult16 = r.u16();          // 8.8 fixed point
        colorTransform = {
          alphaMultiplier: alphaMult16 / 256,
          redMultiplier: r.u8() / 255,
          redOffset: r.s16(),
          greenMultiplier: r.u8() / 255,
          greenOffset: r.s16(),
          blueMultiplier: r.u8() / 255,
          blueOffset: r.s16(),
          alphaOffset: r.s16(),
        };
      }
      const parsedFilters = parseSwfFilterStack(data, r.pos);
      if (parsedFilters) {
        filters = parsedFilters.filters;
        r.pos = parsedFilters.end;
      }
    }

    return {
      className,
      mediaRef,
      instanceName,
      matrix,
      recoveredVia,
      bodyStart,
      endPos: r.pos,
      altMediaRef,
      colorTransform,
      filters,
      componentDataBindingXML,
    };
  } catch (err) {
    if (err instanceof EndOfStreamError || err instanceof Error) return null;
    throw err;
  }
}

/**
 * Try to parse a CPicText placement body starting at `bodyStart`.
 * Returns the decoded instance with text data or null if the bytes do not
 * validate. Uses a fresh reader so a failed attempt never disturbs the caller.
 *
 * Two-phase scan:
 *   Phase 1 — scan all Flash strings (len>0) for font faces and instance name.
 *   Phase 2 — scan for sentinels (len=0) AFTER the last font face to extract
 *   characters. This avoids the unbounded decodeRawUTF16 from a pre-font-face
 *   sentinel consuming through font name strings.
 */
export function tryParseTextInstanceAt(
  data: Uint8Array,
  bodyStart: number,
  recoveredVia: 'class_decl' | 'backref'
): DecodedInstance | null {
  try {
    const r = new ByteReader(data);
    r.pos = bodyStart;
    const maxScan = Math.min(data.length - bodyStart, 2000);

    // ── CPicObj base (same as CPicSprite/CPicButton) ──
    const schema = r.u8();
    const flags = r.u8();
    if (schema < 1 || schema > 30 || flags > 0x40) return null;

    const childTag = r.u16();
    if (childTag !== 0x0000) return null;

    r.s32(); // regPoint.x (INT_MIN sentinel)
    r.s32(); // regPoint.y (INT_MIN sentinel)
    if (schema >= 3) r.u8(); // extra1
    if (schema >= 4) r.u8(); // extra2
    if (schema >= 6) r.u8(); // extra3

    const baseEnd = r.pos;

    // ── Read structured formatting fields from fixed offsets ──
    // Verified for schema=5: width/fontSize/height at body+43/+44/+51/+52.
    const fmtAvailable = bodyStart + 60 <= data.length;
    let fontSize: number | undefined;
    let width: number | undefined;
    let height: number | undefined;
    if (fmtAvailable) {
      const rawSize = data[bodyStart + 44];
      if (rawSize > 0 && rawSize < 300) fontSize = rawSize;
      const rawW = (data[bodyStart + 44] << 8) | data[bodyStart + 43];
      if (rawW > 0 && rawW < 100000) width = rawW / TWIPS_PER_PX;
      const rawH = (data[bodyStart + 52] << 8) | data[bodyStart + 51];
      if (rawH > 0 && rawH < 100000) height = rawH / TWIPS_PER_PX;
    }

    // ── Phase 1: Scan Flash strings (non-zero len) for font faces and instance name ──
    let fontFace: string | undefined;
    let instanceName = '';
    let lastFontFaceEnd = baseEnd;
    let instanceNameEnd = baseEnd;

    for (let p = baseEnd; p + 4 < bodyStart + maxScan; p++) {
      if (data[p] !== 0xff || data[p + 1] !== 0xfe || data[p + 2] !== 0xff) continue;
      if (data[p + 3] === 0) continue; // skip sentinels in Phase 1

      const decoded = readFlashStringAt(data, p, { maxChars: 100 });
      if (!decoded) continue;

      // Font faces start with $ or look like font names (e.g., "_sans")
      if (decoded.value.startsWith('$') || decoded.value === '_sans' || decoded.value === '_serif' || decoded.value === '_typewriter' || decoded.value.endsWith('Font*') || decoded.value.endsWith('MT')) {
        if (!fontFace) fontFace = decoded.value;
        lastFontFaceEnd = decoded.end;
        continue;
      }
      // Instance name: looks like a valid AS identifier
      if (!instanceName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(decoded.value) && !decoded.value.startsWith('$') && !decoded.value.endsWith('MT') && decoded.value.length > 1) {
        instanceName = decoded.value;
        instanceNameEnd = decoded.end;
        continue;
      }
    }

    // ── Phase 2: Scan for text sentinel (len=0) AFTER last font face ──
    let characters = '';
    let textEnd = baseEnd;

    for (let p = Math.max(baseEnd, lastFontFaceEnd); p + 4 < bodyStart + maxScan; p++) {
      if (data[p] !== 0xff || data[p + 1] !== 0xfe || data[p + 2] !== 0xff) continue;
      if (data[p + 3] !== 0) continue; // only sentinels

      const rawText = decodeRawUtf16UntilNull(data, p + 4);
      if (rawText && rawText.value.length > 0) {
        // Only accept if the text starts with printable content (rejects
        // formatting bytes that happen to not contain 00 00 in between).
        const first = rawText.value.charCodeAt(0);
        if (first >= 0x20 && first <= 0x7e || first > 0xa0) {
          characters = rawText.value;
          textEnd = rawText.end;
        }
      }
    }

    // ── Fill color extraction ──
    // After the last font face Flash string, there is 4-byte zero padding
    // followed by 4 bytes ABGR color (memory: B G R A, u32 LE = 0xAABBGGRR).
    // Verified against XFL values (#FFFFFF, #999999, #9A9A9A).
    let fillColor = '#000000';
    if (lastFontFaceEnd > baseEnd) {
      for (let p = lastFontFaceEnd; p + 8 <= bodyStart + maxScan; p++) {
        if (data[p] === 0 && data[p + 1] === 0 && data[p + 2] === 0 && data[p + 3] === 0) {
          const r = data[p + 6];
          const g = data[p + 5];
          const b = data[p + 4];
          const a = data[p + 7];
          if (a === 0xff && (r | g | b) !== 0) {
            fillColor = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
          }
          break;
        }
      }
    }

    const matrix: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };

    return {
      className: 'CPicText',
      mediaRef: 0,
      instanceName,
      matrix,
      recoveredVia,
      bodyStart,
      endPos: Math.max(textEnd, instanceNameEnd),
      altMediaRef: 0,
      textData: {
        characters,
        fontFace,
        fontSize,
        fillColor,
        width,
        height,
      },
    };
  } catch (err) {
    if (err instanceof EndOfStreamError || err instanceof Error) return null;
    throw err;
  }
}

/**
 * Scan a stream for every NEWCLASS declaration in stream order and return the
 * combined class+object table (each NEWCLASS allocates two slots — class then
 * object — so a 1-based back-ref index maps to `combined[idx-1]`). Mirrors the
 * `ArchiveReader` table semantics (FORMAT.md §2) but built by a forward scan,
 * not a structured walk, so it never desyncs on CPicFrame's tail.
 */
export function buildCombinedClassTable(data: Uint8Array): string[] {
  return buildArchiveCombinedClassTable(data);
}

const PLACEMENT_CLASSES = new Set(["CPicSprite", "CPicShapeObj", "CPicButton", "CPicText"]);
const KNOWN_CLASSES = new Set([
  "CPicPage", "CPicLayer", "CPicFrame", "CPicSprite", "CPicShape", 
  "CPicShapeObj", "CPicButton", "CPicText", "CPicBitmap", "CPicObj", 
  "CPicSymbol", "CStrokeStyle", "CFillStyle"
]);

/** Known classes that are NOT placement classes — serve as range boundaries. */
const BOUNDARY_CLASSES = new Set([...KNOWN_CLASSES].filter(c => !PLACEMENT_CLASSES.has(c)));

/** 100% native simulation of MFC CArchive load array. */
function simulateCArchivePlacements(data: Uint8Array): Array<{ pos: number; cls: string; recoveredVia: 'class_decl' | 'backref' }> {
  return scanCArchiveObjectStarts(data, KNOWN_CLASSES).map((s) => ({
    pos: s.bodyStart,
    cls: s.className,
    recoveredVia: s.recoveredVia,
  }));
}

export function scanForInstances(data: Uint8Array): DecodedInstance[] {
  const starts = simulateCArchivePlacements(data);
  const found: DecodedInstance[] = [];
  for (let s = 0; s < starts.length; s++) {
    const { pos, cls, recoveredVia } = starts[s];
    if (BOUNDARY_CLASSES.has(cls)) continue;
    
    if (cls === 'CPicText') {
      const inst = tryParseTextInstanceAt(data, pos, recoveredVia);
      if (inst) {
        found.push(inst);
      }
      continue;
    }
    
    const inst = tryParseInstanceAt(data, pos, cls, recoveredVia);
    if (inst) {
      found.push(inst);
    }
  }
  return found;
}

/**
 * De-duplicate placements that are identical in (mediaRef + rounded matrix).
 *
 * The recovery scanner walks the WHOLE stream, so an animated scene that places
 * the same symbol at the same spot across several keyframes yields several
 * identical placements. Because we cannot reliably attribute placements to
 * individual frames (the CPicFrame tail is unparsed — see module docstring), we
 * composite all recovered placements into one frame; collapsing exact duplicates
 * avoids stacking many identical copies. Distinct positions are preserved.
 */
export function dedupeInstances(insts: DecodedInstance[]): DecodedInstance[] {
  const seen = new Set<string>();
  const out: DecodedInstance[] = [];
  const r4 = (n: number) => Math.round(n * 1000) / 1000;
  const r1 = (n: number) => Math.round(n * 10) / 10;
  for (const inst of insts) {
    const m = inst.matrix;
    const key = [
      inst.mediaRef,
      r4(m.a),
      r4(m.b),
      r4(m.c),
      r4(m.d),
      r1(m.tx),
      r1(m.ty),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(inst);
  }
  return out;
}

/**
 * Fill in MISSING instance names on decoded placements using the higher-recall
 * names from {@link scanNamedInstances} (pre-scanned by the caller and passed in
 * as `named`, so the stream is scanned once and the same list also drives the
 * unjoined-name "ghost" elements).
 *
 * `scanForInstances` reads each placement's instance name from a fixed
 * structural offset, which the version-specific `field_90` layout often makes it
 * read as empty even when the file does carry a name. `scanNamedInstances` finds
 * those names robustly. Both scanners anchor a placement at the SAME `bodyStart`
 * (the byte just past the placement's class tag), so a name is attached to a
 * placement ONLY when their byte offsets match exactly. This never creates,
 * drops, or reorders placements, and never overwrites a name the structural read
 * already recovered — so callers' frame-content shape is unchanged; only an
 * otherwise-empty `instanceName` becomes populated. Returns a new array; the
 * input placements are not mutated.
 */
export function attachInstanceNames(
  insts: DecodedInstance[],
  named: NamedInstance[]
): DecodedInstance[] {
  if (insts.length === 0 || named.length === 0 || !insts.some((i) => !i.instanceName)) {
    return insts;
  }
  const nameAt = new Map<number, string>();
  for (const n of named) {
    if (!nameAt.has(n.bodyStart)) nameAt.set(n.bodyStart, n.name);
  }
  if (nameAt.size === 0) return insts;
  return insts.map((inst) => {
    if (inst.instanceName) return inst;
    const name = nameAt.get(inst.bodyStart);
    return name ? { ...inst, instanceName: name } : inst;
  });
}

/**
 * The named instances that {@link attachInstanceNames} could NOT attach to a
 * decoded placement — i.e. names whose `bodyStart` matches no entry in `insts`.
 * These are FP8 placements (mostly text fields) that {@link scanForInstances}
 * does not geometry-decode, so there is no placement to carry their name. A
 * caller surfaces them as name-only "ghost" timeline elements (real name + kind,
 * no geometry) so their instance names still reach the timeline for tooling.
 */
export function unjoinedNames(
  named: NamedInstance[],
  insts: DecodedInstance[]
): NamedInstance[] {
  if (named.length === 0) return named;
  const placed = new Set(insts.map((i) => i.bodyStart));
  return named.filter((n) => !placed.has(n.bodyStart));
}

/**
 * Flag placements whose `mediaRef` can't be trusted. A placement using the FP8
 * float32-matrix layout mis-decodes through {@link tryParseInstanceAt} (built for
 * the 16.16/ASCII layout): its `mediaRef` field lands on a constant (observed:
 * 1). The reliable signal for such a placement is its NAME (recovered by the
 * byte-offset join), not its reference. So when 2+ NAMED placements in one stream
 * share a single `mediaRef`, they cannot all be that one symbol — the ref is a
 * misread and is flagged `unreliableRef`, so the parser emits those named
 * children without a (wrong) `libraryItemName` rather than inheriting whatever
 * symbol the constant resolves to (e.g. the document/root class). A lone named
 * placement (e.g. a real scene instance) keeps its reference.
 */
/**
 * Correct the mis-read `mediaRef` of FP8 (float32-matrix) placements. The 16.16
 * reader in {@link tryParseInstanceAt} lands `mediaRef` on a constant for these,
 * so a container instance would reference the wrong (often root) symbol. The real
 * symbol number is `altMediaRef` (the u32 at `bodyStart + 72`).
 *
 * A placement is FP8 when its STRUCTURAL name read empty — the FP8 name lives in a
 * `FF FE FF` field the 16.16 reader skips, so it reads `instanceName === ''`
 * (whereas a 16.16 placement reads its real name there). For those we swap in
 * `altMediaRef` when it is an actual symbol-stream number. Genuine 16.16
 * placements keep their decoded `mediaRef`: either their structural name is
 * non-empty, or their `altMediaRef` is out of range (e.g. btnstrob's `+72 = 0`).
 *
 * MUST run before {@link attachInstanceNames} (which fills `instanceName` from the
 * byte-offset join and would defeat the empty-name FP8 test).
 */
export function correctFp8Refs(
  insts: DecodedInstance[],
  symbolNumbers: Set<number>,
  aliasToContent?: Map<number, number>
): DecodedInstance[] {
  return insts.map((i) => {
    if (i.instanceName !== '') return i;
    // The placement-id `altMediaRef` resolves to a content stream either directly
    // (it IS a stream) or, in dual-numbered files, via the alias map (its u32
    // placement-id may have no stream of its own — inventorylists itemList 46→36).
    const target = aliasToContent?.get(i.altMediaRef) ??
      (symbolNumbers.has(i.altMediaRef) ? i.altMediaRef : undefined);
    return target !== undefined && target !== i.mediaRef
      ? { ...i, mediaRef: target, refCorrected: true }
      : i;
  });
}

export function markUnreliableRefs(insts: DecodedInstance[]): DecodedInstance[] {
  // A ref corrected by correctFp8Refs is validated (a real symbol number), so it
  // is trusted even when shared by repeated instances — only the UN-corrected
  // FP8 misreads (still the constant ref) are candidates for the shared-ref test.
  const namedPerRef = new Map<number, number>();
  for (const i of insts) {
    if (i.instanceName && !i.refCorrected) {
      namedPerRef.set(i.mediaRef, (namedPerRef.get(i.mediaRef) ?? 0) + 1);
    }
  }
  return insts.map((i) =>
    i.instanceName && !i.refCorrected && (namedPerRef.get(i.mediaRef) ?? 0) >= 2
      ? { ...i, unreliableRef: true }
      : i
  );
}

/** A named placement recovered from a stream (instance name + kind only). */
export interface NamedInstance {
  /** Authoring instance name — the AS identifier on the timeline. */
  name: string;
  /** Element kind, from the placement class. */
  type: 'symbol' | 'text';
  /** For symbol instances, the symbol kind. */
  symbolType?: 'movieclip' | 'button' | 'graphic';
  /** Byte offset of the placement, to match a decoded geometry instance / frame. */
  bodyStart: number;
}

function placementKind(cls: string): Pick<NamedInstance, 'type' | 'symbolType'> {
  switch (cls) {
    case 'CPicText':
      return { type: 'text' };
    case 'CPicButton':
      return { type: 'symbol', symbolType: 'button' };
    case 'CPicShapeObj':
      return { type: 'symbol', symbolType: 'graphic' };
    case 'CPicSprite':
    default:
      return { type: 'symbol', symbolType: 'movieclip' };
  }
}

const NAMED_INSTANCE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Flash device-font aliases — these are font names, never instance names. */
const DEVICE_FONTS = new Set(['_sans', '_serif', '_typewriter']);


/** Embedded-font face names (e.g. TimesNewRomanPSMT, ArialMT) — never instances. */
const FONT_NAME_RE = /MT$/;

/** Whether a clean identifier string is a plausible instance name. */
function isInstanceName(s: string, classRefs: Set<string>): boolean {
  if (!NAMED_INSTANCE_RE.test(s)) return false;
  if (s.startsWith('$') || DEVICE_FONTS.has(s) || FONT_NAME_RE.test(s)) return false; // fonts
  if (classRefs.has(s)) return false;
  return true;
}

/**
 * The instance name within a placement body [start, end): the first identifier-
 * like Flash string (`FF FE FF <u8 len> <UTF-16LE>`), excluding font tokens
 * (`$…*`) and MFC class refs. Returns '' for an unnamed placement.
 */
function placementName(data: Uint8Array, start: number, end: number, classRefs: Set<string>): string {
  for (let p = start; p + 4 <= end; p++) {
    const decoded = readFlashStringAt(data, p, { maxChars: 40 });
    if (!decoded || decoded.end > end) continue;
    p = decoded.end - 1;
    let ok = true;
    for (let i = 0; i < decoded.value.length; i++) {
      const c = decoded.value.charCodeAt(i);
      if (c < 0x20 || c > 0x7e) { ok = false; break; }
    }
    if (!ok || !isInstanceName(decoded.value, classRefs)) continue;
    return decoded.value;
  }
  return '';
}

/**
 * Recover NAMED placements (instance name + kind) from one `Symbol N` / `Page N`
 * stream. Complements {@link scanForInstances}, which decodes placement geometry
 * (matrix + media_ref) for the older 16.16/ASCII format but rejects the FP8
 * variant (float32 matrix + `FF FE FF` UTF-16 name) used by newer files — which
 * drops the instance names a language tool needs.
 *
 * Locates each placement by its CArchive class tag (NEWCLASS declaration or
 * 0x80NN back-reference) and reads the instance name from the placement body,
 * skipping the version-specific matrix entirely. Unnamed placements are omitted.
 */
export function scanNamedInstances(data: Uint8Array): NamedInstance[] {
  const starts = simulateCArchivePlacements(data);
  const classRefs = new Set(buildCombinedClassTable(data));

  const out: NamedInstance[] = [];
  const seen = new Set<string>();
  for (let s = 0; s < starts.length; s++) {
    const { pos, cls } = starts[s];
    const end = s + 1 < starts.length ? starts[s + 1].pos : data.length;
    if (!PLACEMENT_CLASSES.has(cls)) continue;
    const name = placementName(data, pos, end, classRefs);
    if (name && !seen.has(name)) {
      seen.add(name);
      const kind = placementKind(cls);
      out.push({ type: kind.type, name, symbolType: kind.symbolType, bodyStart: pos });
    }
  }

  return out;
}
