/**
 * Parser for pre-CS5 *binary* `.fla` files (GitHub issue #8).
 *
 * Unlike CS5+ FLAs (ZIP archives containing XFL/XML), Flash 5 .. CS4 saved
 * `.fla` files as OLE2 compound documents whose streams hold MFC `CArchive`
 * object trees. This module reads the OLE2 container (via {@link OLE2File})
 * and extracts the document-level data the format reliably yields:
 *
 *   - background color + frame rate  (binary pattern in the `Contents` stream)
 *   - stage width/height             (HTML publish-settings strings)
 *   - the symbol library table       (symbol number → name + type)
 *
 * The extraction logic mirrors the reverse-engineered fla-decoder reference
 * (https://github.com/eddiemoore/fla-decoder), specifically
 * `scripts/extract_library.py` and `scripts/extract_all.py`, and is validated
 * byte-for-byte against real Flash MX 2004 sample FLAs (see
 * `src/__tests__/binary-fla-parser.test.ts`).
 *
 * The stream body path is native-first: `CPicPage → CPicLayer → CPicFrame`
 * is walked by {@link ./binary-native-timeline}, and shapes / placements /
 * text / frame labels come from that tree. Whole-stream recovery scanners are
 * no longer used as production fallbacks; when a native stream fails, the
 * migration diagnostics surface it instead of silently substituting guessed
 * content.
 *
 * What is still NOT fully decoded here: exact compact button frame splitting,
 * sounds, and some per-frame placement table details. We never silently swallow
 * errors (project rule).
 */
import { OLE2File } from './ole2-reader';
import { collectFlashStrings } from './binary-flash-string';
import {
  type BinaryLayerInfo,
  type BinaryLayerType,
} from './binary-fla-structure';
import type { DecodedShape } from './binary-shape-decoder';
import {
  dedupeInstances,
  instanceSymbolType,
  scanNamedInstances,
  unjoinedNames,
  type DecodedInstance,
  type NamedInstance,
} from './binary-instance-decoder';
import {
  attributeToFrames,
  extractFrameLabelsAll,
  extractFrameScripts,
  type DecodedFrameLabel,
  type DecodedFrameScript,
  type DecodedStreamTimeline,
} from './binary-timeline-decoder';
import {
  decodeNativeTimelineTreeDetailed,
  extractNativeInstances,
  extractNativeShapes,
  type NativeCPicPage,
  nativeTimelineToDecodedTimeline,
} from './binary-native-timeline';
import {
  readNativeContents,
  type BinaryLibraryEntry,
} from './binary-native-contents';
import type {
  BinaryLinkage,
  FLADocument,
  Frame,
  Layer,
  DisplayElement,
  Matrix,
  Shape,
  Symbol,
  SymbolInstance,
  TextInstance,
  Timeline,
} from './types';

export type { BinaryLibraryEntry, BinarySymbolType } from './binary-native-contents';

export interface BinaryFLAInfo {
  width: number;
  height: number;
  frameRate: number;
  backgroundColor: string;
  /** Target Flash Player version extracted from publish settings, e.g. 8, 9, 10. */
  flashVersion?: number;
  /** Stream names found in the OLE2 container (Contents, Page N, Symbol N…). */
  streams: string[];
  /** Decoded symbol library table. */
  library: BinaryLibraryEntry[];
  /**
   * ActionScript linkage table from the `Contents` stream (export id → AS class
   * + document/library/import kind). Some records do not have a local symbol
   * stream (runtime-shared imports or document/root bindings), so the raw table
   * remains available even when {@link linkageBySymbol} resolves most library
   * records directly.
   */
  linkage: BinaryLinkage[];
  /**
   * Per-symbol resolution of {@link linkage}: `symbolNumber → linkage record`,
   * joined via the u32 the library-item record writes after the item name (see
   * {@link readNativeContents}). Lets the parser set per-symbol
   * `linkageClassName` directly — the binary path then matches the XFL shape with
   * no SWF. Imported/shared classes with no local symbol stream are absent.
   */
  linkageBySymbol: Map<number, BinaryLinkage>;
  /** True when stage dimensions came from publish settings (else defaults). */
  dimensionsFromPublishSettings: boolean;
  /**
   * Layer list decoded from each scene's `Page N` stream. The N (scene number)
   * maps to the OLE2 stream `Page N`. Layers are RELIABLE (name/type/locked/
   * visible); frame content is not decoded (see binary-fla-structure docstring).
   */
  scenes: { scene: number; layers: BinaryLayerInfo[] }[];
  /** Layer list decoded from each `Symbol N` stream, keyed by symbol number. */
  symbolLayers: Map<number, BinaryLayerInfo[]>;
  /**
   * Vector shapes decoded from each scene's `Page N` stream, keyed by scene
   * number. Shapes come from the native CPic walk; compact legacy shape payloads
   * are bounded to native frame ranges before they are exposed here.
   */
  sceneShapes: Map<number, Shape[]>;
  /** Vector shapes decoded from each `Symbol N` stream, keyed by symbol number. */
  symbolShapes: Map<number, Shape[]>;
  /**
   * The same decoded shapes WITH their stream byte offsets, in stream order, so
   * per-frame timeline attribution ({@link ./binary-timeline-decoder}) can map
   * each shape to its keyframe. Keyed by scene / symbol number.
   */
  sceneShapesDecoded: Map<number, DecodedShape[]>;
  symbolShapesDecoded: Map<number, DecodedShape[]>;
  /**
   * Native per-layer / per-frame timeline structure decoded from
   * `CPicPage → CPicLayer → CPicFrame`. Absent only when the native walk fails.
   * Keyed by scene / symbol number.
   */
  sceneTimelines: Map<number, DecodedStreamTimeline>;
  symbolTimelines: Map<number, DecodedStreamTimeline>;
  /**
   * Frame ActionScript recovered from each scene / symbol stream (with byte
   * offsets, for keyframe attribution). Keyed by scene / symbol number.
   */
  sceneScripts: Map<number, DecodedFrameScript[]>;
  symbolScripts: Map<number, DecodedFrameScript[]>;
  /**
   * Frame labels independently extracted from each scene / symbol stream by
   * scanning for the label signature (safe from position 0 — never false-positive
   * in page body data). Always available even when the structural timeline walk
   * (`sceneTimelines` / `symbolTimelines`) fails, so frame label names still
   * surface for AS2 linting / ghost filtering. Keyed by scene / symbol number.
   */
  sceneFrameLabels: Map<number, DecodedFrameLabel[]>;
  symbolFrameLabels: Map<number, DecodedFrameLabel[]>;
  /**
   * Symbol-instance placements decoded from each scene's `Page N` stream, keyed
   * by scene number. Each placement references a library item by `mediaRef` and
   * carries its matrix, so the renderer composites the library symbol onto the
   * stage.
   */
  sceneInstances: Map<number, DecodedInstance[]>;
  /** Symbol-instance placements recovered from each `Symbol N` stream. */
  symbolInstances: Map<number, DecodedInstance[]>;
  /**
   * All recovered NAMED instances (name + kind + byte offset) per scene /
   * symbol stream. Names that do not join to a native placement become
   * name-only "ghost" timeline elements (see {@link unjoinedNames}) so every
   * script-visible instance name reaches the timeline for tooling. Keyed by
   * scene / symbol number.
   */
  sceneNamed: Map<number, NamedInstance[]>;
  symbolNamed: Map<number, NamedInstance[]>;
}

/**
 * Return the scene number for an OLE2 stream name, or null. Handles both the
 * `Page N` (Flash 5..MX 2004) and `P N <timestamp>` (Flash 8 / CS3+) naming.
 */
function parseSceneStreamNumber(name: string): number | null {
  const m = /^(?:Page|P) (\d+)(?: \d+)?$/.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Return the symbol number for an OLE2 stream name, or null. Handles both the
 * `Symbol N` and `S N <timestamp>` naming.
 */
function parseSymbolStreamNumber(name: string): number | null {
  const m = /^(?:Symbol|S) (\d+)(?: \d+)?$/.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract background color + frame rate from the binary RGBA/RGBA/u16/u16
 * pattern in `Contents` (fla-decoder extract_all.py): two RGBA quads (both
 * with alpha 0xFF), a u16 zero pad, then the frame rate as a u16 in 10..60.
 */
function extractColorAndFrameRate(
  contents: Uint8Array
): { backgroundColor?: string; frameRate?: number } {
  const dv = new DataView(
    contents.buffer,
    contents.byteOffset,
    contents.byteLength
  );
  for (let ci = 100; ci < contents.length - 14; ci++) {
    const a1 = contents[ci + 3];
    const a2 = contents[ci + 7];
    if (a1 !== 0xff || a2 !== 0xff) continue;
    const pad = dv.getUint16(ci + 8, true);
    const fps = dv.getUint16(ci + 10, true);
    if (pad === 0 && fps >= 10 && fps <= 60) {
      const r = contents[ci];
      const g = contents[ci + 1];
      const b = contents[ci + 2];
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      return {
        backgroundColor: `#${hex(r)}${hex(g)}${hex(b)}`,
        frameRate: fps,
      };
    }
  }
  return {};
}

/**
 * Extract stage dimensions from the HTML publish-settings strings (keys
 * "…Html…::Width" / "::Height" with a numeric value string immediately after).
 */
function extractDimensions(
  strings: string[]
): { width?: number; height?: number } {
  const out: { width?: number; height?: number } = {};
  for (let i = 0; i < strings.length - 1; i++) {
    const key = strings[i];
    const val = strings[i + 1];
    if (key.endsWith('::Width') && key.includes('Html') && /^\d+$/.test(val)) {
      out.width = parseInt(val, 10);
    }
    if (key.endsWith('::Height') && key.includes('Html') && /^\d+$/.test(val)) {
      out.height = parseInt(val, 10);
    }
  }
  return out;
}

/**
 * Extract the target Flash Player version from publish-settings strings.
 * Searches for a "FlashPlayerN" pattern (e.g. "FlashPlayer10", "FlashPlayer8")
 * among the collected Flash strings and returns the numeric version.
 */
function extractFlashVersion(strings: string[]): number | undefined {
  for (const s of strings) {
    const m = /^FlashPlayer(\d+)$/.exec(s);
    if (m) return parseInt(m[1], 10);
  }
  return undefined;
}

function normalizeNativeInstanceRefs(
  insts: DecodedInstance[],
  placementIdToStream: ReadonlyMap<number, number>
): DecodedInstance[] {
  if (placementIdToStream.size === 0) return insts;
  return insts.map((inst) => {
    const mediaRef = placementIdToStream.get(inst.mediaRef) ?? inst.mediaRef;
    const altMediaRef = placementIdToStream.get(inst.altMediaRef) ?? inst.altMediaRef;
    return mediaRef !== inst.mediaRef || altMediaRef !== inst.altMediaRef
      ? { ...inst, mediaRef, altMediaRef, refCorrected: true }
      : inst;
  });
}

/**
 * Read a binary FLA's OLE2 container and extract document-level info.
 * Throws (never silently fails) if the `Contents` stream is missing — that
 * would mean the file is not a recognizable binary FLA.
 */
export function extractBinaryFLAInfo(bytes: Uint8Array): BinaryFLAInfo {
  const ole = new OLE2File(bytes);
  const streams = ole.listStreams().map((s) => s.name);

  if (!ole.hasStream('Contents')) {
    throw new Error(
      'Binary FLA is missing its "Contents" stream; cannot read document data. ' +
        `Streams present: ${streams.join(', ') || '(none)'}`
    );
  }

  const contents = ole.readStream('Contents');
  const strings = collectFlashStrings(contents);

  const flashVersion = extractFlashVersion(strings);
  const { backgroundColor, frameRate } = extractColorAndFrameRate(contents);
  const dims = extractDimensions(strings);

  // The set of library symbol stream numbers, used both to correct FP8
  // placement mediaRefs and to join the linkage table to symbol numbers.
  const symbolNumbers = new Set<number>();
  for (const name of streams) {
    const n = parseSymbolStreamNumber(name);
    if (n !== null) symbolNumbers.add(n);
  }

  const contentsInfo = readNativeContents(contents, symbolNumbers);
  const { library, linkage, linkageBySymbol, placementIdToStream } = contentsInfo;

  // `placementIdToStream` is owned by binary-native-contents.ts, next to the
  // library-item record reader that observes dual-numbered placement ids.

  // ── Decode every scene (`Page N`) and library item (`Symbol N`) stream.
  // Native CPic walking is the production source for timeline, layers, shapes
  // and placements. Streams without a valid native page stay empty here so
  // diagnostics expose the gap instead of masking it with recovery scans.
  const scenes: { scene: number; layers: BinaryLayerInfo[] }[] = [];
  const symbolLayers = new Map<number, BinaryLayerInfo[]>();
  const sceneShapes = new Map<number, Shape[]>();
  const symbolShapes = new Map<number, Shape[]>();
  const sceneShapesDecoded = new Map<number, DecodedShape[]>();
  const symbolShapesDecoded = new Map<number, DecodedShape[]>();
  const sceneInstances = new Map<number, DecodedInstance[]>();
  const symbolInstances = new Map<number, DecodedInstance[]>();
  const sceneNamed = new Map<number, NamedInstance[]>();
  const symbolNamed = new Map<number, NamedInstance[]>();
  const sceneTimelines = new Map<number, DecodedStreamTimeline>();
  const symbolTimelines = new Map<number, DecodedStreamTimeline>();
  const sceneScripts = new Map<number, DecodedFrameScript[]>();
  const symbolScripts = new Map<number, DecodedFrameScript[]>();
  const sceneFrameLabels = new Map<number, DecodedFrameLabel[]>();
  const symbolFrameLabels = new Map<number, DecodedFrameLabel[]>();
  for (const name of streams) {
    // Scene streams are named `Page N` (Flash 5..MX 2004) or `P N <timestamp>`
    // (Flash 8 / CS3+); symbol streams `Symbol N` or `S N <timestamp>`. Both
    // are the same MFC object tree — only the OLE2 stream label differs.
    const pageNum = parseSceneStreamNumber(name);
    if (pageNum !== null) {
      const streamData = ole.readStream(name);
      const named = scanNamedInstances(streamData);
      if (named.length > 0) sceneNamed.set(pageNum, named);

      const nativeResult = decodeNativeTimelineTreeDetailed(streamData);
      scenes.push({
        scene: pageNum,
        layers: nativeResult.ok && nativeResult.page
          ? binaryLayersFromNativePage(nativeResult.page)
          : [],
      });

      // Shapes: native only. Missing native decode is surfaced by migration
      // diagnostics instead of being masked by whole-stream recovery scans.
      if (nativeResult.ok && nativeResult.page) {
        const nativeS = extractNativeShapes(nativeResult.page);
        if (nativeS.length > 0) {
          sceneShapes.set(pageNum, nativeS.map((d) => d.shape));
          sceneShapesDecoded.set(pageNum, nativeS);
        }
      }

      // Timeline: native only.
      const tl = nativeResult.ok && nativeResult.page
        ? nativeTimelineToDecodedTimeline(nativeResult.page)
        : null;
      if (tl) sceneTimelines.set(pageNum, tl);

      // Instances: native only.
      if (nativeResult.ok && nativeResult.page) {
        const nativeInsts = normalizeNativeInstanceRefs(
          extractNativeInstances(nativeResult.page),
          placementIdToStream
        );
        if (nativeInsts.length > 0) sceneInstances.set(pageNum, nativeInsts);
      }

      const scripts = extractFrameScripts(streamData);
      if (scripts.length > 0) sceneScripts.set(pageNum, scripts);
      const frameLabels = extractFrameLabelsAll(streamData);
      if (frameLabels.length > 0) sceneFrameLabels.set(pageNum, frameLabels);
      continue;
    }
    const symNum = parseSymbolStreamNumber(name);
    if (symNum !== null) {
      const streamData = ole.readStream(name);
      const named = scanNamedInstances(streamData);
      if (named.length > 0) symbolNamed.set(symNum, named);

      const nativeResult = decodeNativeTimelineTreeDetailed(streamData);
      symbolLayers.set(
        symNum,
        nativeResult.ok && nativeResult.page
          ? binaryLayersFromNativePage(nativeResult.page)
          : []
      );

      // Shapes: native only. Missing native decode is surfaced by migration
      // diagnostics instead of being masked by whole-stream recovery scans.
      if (nativeResult.ok && nativeResult.page) {
        const nativeS = extractNativeShapes(nativeResult.page);
        if (nativeS.length > 0) {
          symbolShapes.set(symNum, nativeS.map((d) => d.shape));
          symbolShapesDecoded.set(symNum, nativeS);
        }
      }

      // Timeline: native only.
      const tl = nativeResult.ok && nativeResult.page
        ? nativeTimelineToDecodedTimeline(nativeResult.page)
        : null;
      if (tl) symbolTimelines.set(symNum, tl);

      // Instances: native only.
      if (nativeResult.ok && nativeResult.page) {
        const nativeInsts = normalizeNativeInstanceRefs(
          extractNativeInstances(nativeResult.page),
          placementIdToStream
        );
        if (nativeInsts.length > 0) symbolInstances.set(symNum, nativeInsts);
      }

      const scripts = extractFrameScripts(streamData);
      if (scripts.length > 0) symbolScripts.set(symNum, scripts);
      const frameLabels = extractFrameLabelsAll(streamData);
      if (frameLabels.length > 0) symbolFrameLabels.set(symNum, frameLabels);
    }
  }
  scenes.sort((a, b) => a.scene - b.scene);

  return {
    // Flash's default stage is 550×400 @ 24fps on a white stage — apply these
    // as fallbacks when a value could not be recovered.
    width: dims.width ?? 550,
    height: dims.height ?? 400,
    frameRate: frameRate ?? 24,
    backgroundColor: backgroundColor ?? '#FFFFFF',
    ...(flashVersion !== undefined && { flashVersion }),
    streams,
    library,
    linkage,
    linkageBySymbol,
    dimensionsFromPublishSettings:
      dims.width !== undefined && dims.height !== undefined,
    scenes,
    symbolLayers,
    sceneShapes,
    symbolShapes,
    sceneShapesDecoded,
    symbolShapesDecoded,
    sceneInstances,
    symbolInstances,
    sceneNamed,
    symbolNamed,
    sceneTimelines,
    symbolTimelines,
    sceneScripts,
    symbolScripts,
    sceneFrameLabels,
    symbolFrameLabels,
  };
}

/**
 * Build a viewer {@link SymbolInstance} for one decoded placement, or null when
 * its `mediaRef` does not resolve to a known library symbol (we never fabricate
 * a placement for an unknown reference). `libraryByNumber` maps a library item
 * id to its display name (the key under which the symbol lives in
 * `FLADocument.symbols`).
 */
/**
 * Convert a decoded CPicText placement into a viewer {@link TextInstance}.
 */
function buildTextInstance(inst: DecodedInstance): TextInstance | null {
  const td = inst.textData;
  if (!td || !td.characters) return null;
  return {
    type: 'text',
    ...(inst.instanceName && { name: inst.instanceName }),
    textType: inst.instanceName ? 'dynamic' : 'static',
    matrix: inst.matrix,
    left: td.width !== undefined ? td.width / 2 : 0,
    width: td.width ?? 100,
    height: td.height ?? 20,
    ...(inst.filters && { filters: inst.filters }),
    textRuns: [{
      characters: td.characters,
      size: td.fontSize ?? 12,
      fillColor: td.fillColor ?? '#000000',
      ...(td.fontFace && { face: td.fontFace }),
      ...(td.bold !== undefined && { bold: td.bold }),
      ...(td.alignment && { alignment: td.alignment }),
      ...(td.letterSpacing !== undefined && { letterSpacing: td.letterSpacing }),
    }],
  };
}

function buildSymbolInstance(
  inst: DecodedInstance,
  libraryByNumber: Map<number, BinaryLibraryEntry>
): SymbolInstance | null {
  const entry = libraryByNumber.get(inst.mediaRef);
  // No resolvable library item: for an unnamed placement we drop it (never
  // fabricate a reference); for a named one we still emit a name-only element so
  // its instance name reaches the timeline for tooling.
  if (inst.unreliableRef || !entry) {
    if (!inst.instanceName) return null;
    return {
      type: 'symbol',
      libraryItemName: '',
      name: inst.instanceName,
      symbolType: instanceSymbolType(inst.className),
      matrix: inst.matrix,
      transformationPoint: { x: 0, y: 0 },
      loop: 'loop',
      ...(inst.colorTransform && { colorTransform: inst.colorTransform }),
      ...(inst.filters && { filters: inst.filters }),
      ...(inst.blendMode && { blendMode: inst.blendMode }),
      ...(inst.componentParameters && { componentParameters: inst.componentParameters }),
    };
  }
  // Prefer the library item's real kind; when the library type is unknown,
  // fall back to the kind implied by the placement's class.
  const symbolType: SymbolInstance['symbolType'] =
    entry.symbolType === 'unknown'
      ? instanceSymbolType(inst.className)
      : entry.symbolType;
  return {
    type: 'symbol',
    libraryItemName: entry.name,
    // Propagate the decoded authoring instance name (the AS identifier). The
    // decoder reads it (u8 len + ASCII) but it was previously dropped here.
    ...(inst.instanceName && { name: inst.instanceName }),
    symbolType,
    matrix: inst.matrix,
    // The matrix tx/ty already place the instance; the transformation point is
    // metadata we cannot reliably recover from the binary frame, so use origin.
    transformationPoint: { x: 0, y: 0 },
    // XFL defaults omitted DOMSymbolInstance.loop to "loop"; explicit graphic
    // playback fields still need a proven CPicSymbol tail mapping.
    loop: 'loop',
    ...(inst.colorTransform && { colorTransform: inst.colorTransform }),
    ...(inst.filters && { filters: inst.filters }),
    ...(inst.blendMode && { blendMode: inst.blendMode }),
    ...(inst.componentParameters && { componentParameters: inst.componentParameters }),
  };
}

/**
 * Convert decoded placements into viewer {@link SymbolInstance}s, dropping any
 * whose `mediaRef` does not resolve to a library symbol. Also converts
 * CPicText placements to {@link TextInstance}s.
 */
function buildSymbolInstances(
  insts: DecodedInstance[],
  libraryByNumber: Map<number, BinaryLibraryEntry>
): (SymbolInstance | TextInstance)[] {
  const out: (SymbolInstance | TextInstance)[] = [];
  for (const inst of insts) {
    if (inst.textData) {
      const built = buildTextInstance(inst);
      if (built) out.push(built);
    } else {
      const built = buildSymbolInstance(inst, libraryByNumber);
      if (built) out.push(built);
    }
  }
  return out;
}

/**
 * Build a name-only "ghost" element for a recovered instance name that has no
 * joined native placement. It carries the real instance name + kind so tooling
 * sees it on the timeline; geometry is a zero placeholder (identity matrix at
 * origin). A symbol ghost gets an empty `libraryItemName` because the binary did
 * not give us a trustworthy library reference for that orphaned name.
 */
function ghostElement(n: NamedInstance): SymbolInstance | TextInstance {
  const matrix: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
  if (n.type === 'text') {
    return {
      type: 'text',
      name: n.name,
      // A named text field is script-accessible (dynamic/input), never static.
      textType: 'dynamic',
      matrix,
      left: 0,
      width: 0,
      height: 0,
      textRuns: [],
    };
  }
  return {
    type: 'symbol',
    name: n.name,
    libraryItemName: '',
    symbolType: n.symbolType ?? 'movieclip',
    matrix,
    transformationPoint: { x: 0, y: 0 },
    loop: 'loop',
  };
}

/**
 * Host name-only "ghost" elements on a timeline. They carry an instance name +
 * kind for tooling but no geometry, so the exact layer/frame is immaterial — we
 * place them all on the first frame of the first NON-reference layer (or the
 * first layer, or a synthetic layer if the timeline has none) so they appear in
 * the timeline's elements like any other. Mutates and returns `tl`.
 */
function hostGhosts(tl: Timeline, ghosts: (SymbolInstance | TextInstance)[]): Timeline {
  if (ghosts.length === 0) return tl;
  let host =
    tl.layers.find((_, i) => !tl.referenceLayers.has(i)) ?? tl.layers[0];
  if (!host) {
    tl.layers.push({
      name: 'Recovered Names',
      color: '#4FFF4F',
      visible: true,
      locked: false,
      outline: false,
      layerType: 'normal',
      frames: [{ index: 0, duration: 1, keyMode: 0, elements: [...ghosts] }],
    });
    return tl;
  }
  if (host.frames.length === 0) {
    host.frames.push({ index: 0, duration: 1, keyMode: 0, elements: [] });
  }
  host.frames[0].elements.push(...ghosts);
  return tl;
}

/** Map a decoded binary layer type to the viewer's narrower Layer.layerType. */
function applyMaskRelationships(layers: Layer[]): void {
  let currentMask: number | undefined;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer.layerType === 'mask') {
      currentMask = i;
      continue;
    }
    if (layer.layerType === 'masked' && currentMask !== undefined) {
      layer.parentLayerIndex = currentMask;
      layer.maskLayerIndex = currentMask;
      continue;
    }
    currentMask = undefined;
  }
}

function toViewerLayerType(
  t: BinaryLayerType
): Layer['layerType'] {
  // The viewer's Layer.layerType union is exactly these values.
  switch (t) {
    case 'guide':
      return 'guide';
    case 'folder':
      return 'folder';
    case 'mask':
      return 'mask';
    case 'masked':
      return 'masked';
    default:
      return 'normal';
  }
}

function nativeTypeByteToBinaryLayerType(typeByte: number | undefined): BinaryLayerType {
  if (typeByte === 3) return 'mask';
  if (typeByte === 4) return 'masked';
  return 'normal';
}

function binaryLayersFromNativePage(page: NativeCPicPage): BinaryLayerInfo[] {
  const timeline = nativeTimelineToDecodedTimeline(page);
  return timeline.layers.map((layer) => ({
    name: layer.name,
    schema: layer.schema,
    layerType: nativeTypeByteToBinaryLayerType(layer.typeByte),
    locked: layer.locked,
    visible: layer.visible,
  }));
}

/**
 * Build a single-frame host timeline from decoded layer metadata and already
 * decoded native content. This is no longer a scanner fallback; it is only the
 * final display host when a stream has no usable native keyframe attribution.
 */
function buildLayers(
  binaryLayers: BinaryLayerInfo[],
  shapes: Shape[] = [],
  instances: (SymbolInstance | TextInstance)[] = []
): { layers: Layer[]; referenceLayers: Set<number> } {
  const referenceLayers = new Set<number>();
  const content: DisplayElement[] = [...shapes, ...instances];

  // Prefer a host layer the renderer will actually draw: visible AND not a
  // guide/folder reference layer. Fall back to the first non-guide/folder
  // layer even if hidden, then to none (handled by the synthetic layer below).
  const renderable = (bl: BinaryLayerInfo) => {
    const t = toViewerLayerType(bl.layerType);
    return t !== 'guide' && t !== 'folder';
  };
  let hostLayerIndex = binaryLayers.findIndex(
    (bl) => renderable(bl) && bl.visible
  );

  const layers: Layer[] = binaryLayers.map((bl, index) => {
    const layerType = toViewerLayerType(bl.layerType);
    if (layerType === 'guide' || layerType === 'folder') {
      referenceLayers.add(index);
    }
    const elements =
      index === hostLayerIndex && content.length > 0 ? [...content] : [];
    return {
      name: bl.name,
      color: '#4FFF4F',
      visible: bl.visible,
      locked: bl.locked,
      outline: false,
      layerType,
      frames: [
        {
          index: 0,
          duration: 1,
          keyMode: 0,
          elements,
        },
      ],
    };
  });

  // If there is content but no decoded layer the renderer would draw (all
  // hidden/guide/folder, or no layer records at all), host the content on a
  // synthetic always-visible "normal" layer so the artwork is not dropped.
  if (content.length > 0 && hostLayerIndex < 0) {
    layers.push({
      name: binaryLayers.length === 0 ? 'Layer 1' : 'Recovered Content',
      color: '#4FFF4F',
      visible: true,
      locked: false,
      outline: false,
      layerType: 'normal',
      frames: [{ index: 0, duration: 1, keyMode: 0, elements: [...content] }],
    });
  }
  applyMaskRelationships(layers);
  return { layers, referenceLayers };
}

/**
 * Build viewer {@link Layer}s with native per-layer / per-frame attribution.
 * Native shapes/instances carry byte offsets and are assigned to the decoded
 * keyframe whose body range contains them. Returns `null` only when a stream has
 * content but no attributed keyframe, in which case {@link buildLayers} hosts the
 * same native content on a single frame rather than rendering an empty symbol.
 */
function buildAttributedLayers(
  timeline: DecodedStreamTimeline,
  decodedShapes: DecodedShape[],
  decodedInstances: DecodedInstance[],
  libraryByNumber: Map<number, BinaryLibraryEntry>,
  scripts: DecodedFrameScript[]
): { layers: Layer[]; referenceLayers: Set<number>; totalFrames: number } | null {
  const referenceLayers = new Set<number>();
  let attributedAny = false;

  // 1. Глобальное распределение контента по ВСЕМ ключевым кадрам ВСЕХ слоев (1 раз)
  const allKeyframes = timeline.layers.flatMap((l) => l.keyframes);
  const shapeBuckets = attributeToFrames(allKeyframes, decodedShapes);
  const instBuckets = attributeToFrames(allKeyframes, decodedInstances);
  const scriptBuckets = attributeToFrames(allKeyframes, scripts);
  const labelBuckets = timeline.frameLabels
    ? attributeToFrames(allKeyframes, timeline.frameLabels)
    : undefined;

  let globalKfIdx = 0; // Трекаем индекс в глобальном массиве allKeyframes

  const layers: Layer[] = timeline.layers.map((dl, index) => {
    const layerType =
      dl.typeByte === LAYER_TYPE_GUIDE_BYTE ? 'guide' :
      dl.typeByte === LAYER_TYPE_MASK_BYTE ? 'mask' :
      dl.typeByte === LAYER_TYPE_MASKED_BYTE ? 'masked' :
      dl.typeByte === LAYER_TYPE_FOLDER_BYTE ? 'folder' : 'normal';
      
    if (layerType === 'guide' || layerType === 'folder') {
      referenceLayers.add(index);
    }

    const frames: Frame[] = dl.keyframes.flatMap((kf) => {
      const ki = globalKfIdx++;
      const shapes = shapeBuckets.perKeyframe[ki].map((d) => d.shape);
      const instances = buildSymbolInstances(instBuckets.perKeyframe[ki], libraryByNumber);
      const elems = [...shapes, ...instances] as Frame['elements'];
      
      // Pick label: prefer byte-range attributed label, fall back to the keyframe's own label
      const attributedLabels = labelBuckets ? labelBuckets.perKeyframe[ki] : [];
      const label = attributedLabels.length > 0 ? attributedLabels[0].label : kf.label;
      
      if (shapes.length > 0 || instances.length > 0 || label) attributedAny = true;
      
      const frameScripts = scriptBuckets.perKeyframe[ki];
      const uniqueScripts = [...new Set(frameScripts.map((s) => s.source))];
      
      if (uniqueScripts.length <= 1) {
        const f: Frame = {
          index: kf.startIndex,
          duration: kf.duration,
          keyMode: kf.keyMode ?? 0,
          elements: elems,
        };
        if (label) { f.label = label; f.labelType = 'name'; }
        if (uniqueScripts.length > 0) f.actionScript = uniqueScripts[0];
        if (kf.tweenType) f.tweenType = kf.tweenType;
        if (kf.acceleration) f.acceleration = kf.acceleration;
        if (kf.motionTweenRotate) f.motionTweenRotate = kf.motionTweenRotate;
        if (kf.motionTweenRotateTimes !== undefined) f.motionTweenRotateTimes = kf.motionTweenRotateTimes;
        if (kf.motionTweenScale !== undefined) f.motionTweenScale = kf.motionTweenScale;
        if (kf.motionTweenOrientToPath !== undefined) f.motionTweenOrientToPath = kf.motionTweenOrientToPath;
        return [f];
      }
      
      attributedAny = true;
      const totalDuration = kf.duration;
      const perFrameDuration = Math.max(1, Math.floor(totalDuration / uniqueScripts.length));
      return uniqueScripts.map((src, i) => ({
        index: kf.startIndex + i * perFrameDuration,
        duration: i === uniqueScripts.length - 1 ? totalDuration - i * perFrameDuration : perFrameDuration,
        keyMode: i === 0 ? kf.keyMode ?? 0 : 0,
        elements: [...elems],
        ...(i === 0 && label ? { label, labelType: 'name' as const } : {}),
        actionScript: src,
        ...(i === 0 && kf.tweenType ? { tweenType: kf.tweenType } : {}),
        ...(i === 0 && kf.acceleration ? { acceleration: kf.acceleration } : {}),
        ...(i === 0 && kf.motionTweenRotate ? { motionTweenRotate: kf.motionTweenRotate } : {}),
        ...(i === 0 && kf.motionTweenRotateTimes !== undefined ? { motionTweenRotateTimes: kf.motionTweenRotateTimes } : {}),
        ...(i === 0 && kf.motionTweenScale !== undefined ? { motionTweenScale: kf.motionTweenScale } : {}),
        ...(i === 0 && kf.motionTweenOrientToPath !== undefined ? { motionTweenOrientToPath: kf.motionTweenOrientToPath } : {}),
      }));
    });

    return {
      name: dl.name,
      color: '#4FFF4F',
      visible: dl.visible,
      locked: dl.locked,
      outline: false,
      layerType,
      ...(dl.parentLayerIndex !== undefined
        ? { parentLayerIndex: dl.parentLayerIndex, maskLayerIndex: dl.parentLayerIndex }
        : {}),
      frames,
    };
  });

  // Элементы-сироты добавляются СТРОГО 1 раз в Слой 0 (убирает дублирование)
  const orphanShapes = shapeBuckets.unattributed.map((d) => d.shape);
  const orphanInstances = buildSymbolInstances(instBuckets.unattributed, libraryByNumber);
  const orphanLabels = labelBuckets ? labelBuckets.unattributed : [];
  
  if (orphanShapes.length > 0 || orphanInstances.length > 0 || orphanLabels.length > 0) {
    if (layers.length > 0) {
      let f0 = layers[0].frames.find(f => f.index === 0);
      if (!f0) {
        layers[0].frames.unshift({ index: 0, duration: 1, keyMode: 0, elements: [] });
        f0 = layers[0].frames[0];
      }
      f0.elements.push(
        ...(orphanShapes as Frame['elements']),
        ...(orphanInstances as Frame['elements'])
      );
      if (orphanLabels.length > 0 && !f0.label) {
        f0.label = orphanLabels[0].label;
        f0.labelType = 'name';
      }
    }
  }

  if (scripts.length > 0 && layers.length > 0 && layers[0].frames.length > 0) {
    const orphanScripts = scriptBuckets.unattributed;
    if (orphanScripts.length > 0) {
      const f0 = layers[0].frames[0];
      const src = [...new Set(orphanScripts.map((s) => s.source))].join('\n\n');
      f0.actionScript = f0.actionScript ? `${f0.actionScript}\n\n${src}` : src;
    }
    attributedAny = true;
  }

  // Честный расчет totalFrames по всем созданным кадрам
  let maxGeneratedFrame = timeline.totalFrames;
  for (const layer of layers) {
    for (const f of layer.frames) {
      maxGeneratedFrame = Math.max(maxGeneratedFrame, f.index + f.duration);
    }
  }
  // Убедимся, что totalFrames >= 1
  if (maxGeneratedFrame < 1) maxGeneratedFrame = 1;

  if (!attributedAny) return null;
  applyMaskRelationships(layers);
  return { layers, referenceLayers, totalFrames: maxGeneratedFrame };
}

function mergeExternalFrameLabels(
  timeline: DecodedStreamTimeline | undefined,
  frameLabels: DecodedFrameLabel[]
): DecodedStreamTimeline | undefined {
  if (!timeline || frameLabels.length === 0) return timeline;

  const existing = new Set<string>();
  for (const layer of timeline.layers) {
    for (const keyframe of layer.keyframes) {
      if (keyframe.label) existing.add(keyframe.label);
    }
  }

  const missing = frameLabels.filter((label) => !existing.has(label.label));
  if (missing.length === 0) return timeline;

  const layers = timeline.layers.map((layer) => ({
    ...layer,
    keyframes: layer.keyframes.map((keyframe) => ({ ...keyframe })),
  }));
  const targetLayer =
    layers.find((layer) => /label/i.test(layer.name)) ??
    layers.find((layer) => layer.keyframes.length > 0);
  if (!targetLayer) {
    return {
      ...timeline,
      frameLabels: [...(timeline.frameLabels ?? []), ...missing],
    };
  }

  let labelIndex = 0;
  for (const keyframe of targetLayer.keyframes) {
    if (labelIndex >= missing.length) break;
    if (keyframe.label) continue;
    keyframe.label = missing[labelIndex++].label;
  }

  while (labelIndex < missing.length) {
    const prior = targetLayer.keyframes[targetLayer.keyframes.length - 1];
    const startIndex = prior ? prior.startIndex + Math.max(1, prior.duration) : 0;
    targetLayer.keyframes.push({
      startIndex,
      duration: 1,
      keyMode: 0,
      bodyStart: missing[labelIndex].bodyStart,
      bodyEnd: missing[labelIndex].bodyStart,
      label: missing[labelIndex].label,
    });
    labelIndex += 1;
  }

  const mergedLabels: DecodedFrameLabel[] = [];
  for (const layer of layers) {
    for (const keyframe of layer.keyframes) {
      if (!keyframe.label) continue;
      mergedLabels.push({
        label: keyframe.label,
        id: keyframe.startIndex,
        bodyStart: keyframe.bodyStart,
      });
    }
  }

  return {
    ...timeline,
    layers,
    frameLabels: mergedLabels,
  };
}

// CPicLayer.type byte values used by the structural walk (FORMAT.md §4).
const LAYER_TYPE_GUIDE_BYTE = 1;
const LAYER_TYPE_MASK_BYTE = 3;
const LAYER_TYPE_MASKED_BYTE = 4;
const LAYER_TYPE_FOLDER_BYTE = 5;

/**
 * Parse a binary FLA into a {@link FLADocument} the existing viewer/renderer
 * can consume.
 *
 * Decoded and populated: document properties, the symbol library, the LAYER
 * STRUCTURE of every scene and library item (names, types, locked/visible
 * flags), the vector SHAPE geometry of each symbol, and the symbol-INSTANCE
 * PLACEMENTS that compose a scene — each placement is emitted as a
 * `SymbolInstance` referencing a decoded library symbol with its transform
 * matrix, so a scene composites its symbols onto the stage. Per-LAYER /
 * per-FRAME attribution (issue #8 timeline) is decoded for streams that walk
 * cleanly: content lands in its real keyframe (index + duration) so the
 * timeline animates; streams that fail the confidence gate keep the
 * single-frame fallback. NOT decoded: tweens, frame labels, sounds, and
 * per-frame placement matrices. Nothing is fabricated: a placement whose
 * reference does not resolve is dropped.
 */
export function parseBinaryFLA(bytes: Uint8Array): FLADocument {
  const info = extractBinaryFLAInfo(bytes);

  // Library id (the N in "Symbol N") → entry, so a placement's `mediaRef`
  // resolves to the library item it references.
  const libraryByNumber = new Map<number, BinaryLibraryEntry>();
  for (const entry of info.library) libraryByNumber.set(entry.symbolNumber, entry);

  const docLink = info.linkage.find(l => l.kind === 'document');
  const documentClass = docLink ? docLink.className : undefined;

  // Some FLAs (Flash 8 / CS3+ with NAMED library items) write a library table
  // we do not yet parse, so `info.library` is empty even though the `Symbol N`
  // streams carry decodable content. So that placements still resolve, we
  // synthesise a `"Symbol N"` library entry for every symbol stream number that
  // has decoded content (shapes / layers / nested placements) but no
  // library-table entry. The placement's `mediaRef` is exactly that stream
  // number, so this is a faithful reference — not a fabricated symbol.
  const contentStreamNumbers = new Set<number>([
    ...info.symbolShapes.keys(),
    ...info.symbolLayers.keys(),
    ...info.symbolInstances.keys(),
  ]);
  for (const num of contentStreamNumbers) {
    if (libraryByNumber.has(num)) continue;
    const hasShapes = (info.symbolShapes.get(num)?.length ?? 0) > 0;
    const hasInstances = (info.symbolInstances.get(num)?.length ?? 0) > 0;
    // Only synthesise when there is renderable content to reference.
    if (!hasShapes && !hasInstances) continue;
    libraryByNumber.set(num, {
      symbolNumber: num,
      name: `Symbol ${num}`,
      symbolType: 'unknown',
    });
  }

  // A symbol that a linkage record resolves to is a REAL library item (it has an
  // AS class) even when we decoded no renderable content for it — synthesise an
  // entry so its `linkageClassName` is still surfaced (the class is the point for
  // tooling, not the geometry). This faithfully references the joined symbol
  // number; nothing is fabricated.
  for (const num of info.linkageBySymbol.keys()) {
    if (!libraryByNumber.has(num)) {
      libraryByNumber.set(num, {
        symbolNumber: num,
        name: `Symbol ${num}`,
        symbolType: 'unknown',
      });
    }
  }

  // A placement's (FP8-corrected) mediaRef references a real library symbol even
  // when we decoded no renderable content for it — synthesise an entry so the
  // instance keeps its libraryItemName and a consumer can descend into the
  // container (e.g. panelContainer → its children). The ref is a real symbol
  // stream number, so this is faithful, not fabricated.
  for (const insts of [...info.sceneInstances.values(), ...info.symbolInstances.values()]) {
    for (const inst of insts) {
      if (inst.refCorrected && !libraryByNumber.has(inst.mediaRef)) {
        libraryByNumber.set(inst.mediaRef, {
          symbolNumber: inst.mediaRef,
          name: `Symbol ${inst.mediaRef}`,
          symbolType: 'unknown',
        });
      }
    }
  }

  // Build one stream's viewer timeline: prefer confident per-frame attribution
  // (issue #8 timeline), else the existing single-frame fallback (#22/#24).
  const buildStreamTimeline = (
    name: string,
    fallbackLayers: BinaryLayerInfo[],
    streamTimeline: DecodedStreamTimeline | undefined,
    decodedShapes: DecodedShape[],
    decodedInstances: DecodedInstance[],
    dedupedInstances: DecodedInstance[],
    scripts: DecodedFrameScript[],
    named: NamedInstance[],
    frameLabels: DecodedFrameLabel[]
  ): Timeline => {
    // Build ghost elements from ALL named instances first — we filter out frame
    // label names only when the attributed path succeeds (they're already on
    // keyframes via kf.label). When the attributed path fails and we fall back,
    // ghost elements are the ONLY source of frame labels, so filtering would
    // silently drop them.
    const ghostEls = unjoinedNames(named, decodedInstances).map(ghostElement);
    const effectiveStreamTimeline = mergeExternalFrameLabels(streamTimeline, frameLabels);

    const doFilterFrameLabels = (ghosts: (SymbolInstance | TextInstance)[]): (SymbolInstance | TextInstance)[] => {
      if (!effectiveStreamTimeline) return ghosts;
      const frameLabelNames = new Set<string>();
      for (const layer of effectiveStreamTimeline.layers) {
        for (const kf of layer.keyframes) {
          if (kf.label) frameLabelNames.add(kf.label);
        }
      }
      if (frameLabelNames.size === 0) return ghosts;
      return ghosts.filter((g) => {
        const n = 'name' in g ? g.name : undefined;
        return n === undefined || !frameLabelNames.has(n);
      });
    };

    // Merge layer names from post-page sentinel records into timeline layers
    // that have empty names (schema=0 — MX2004 doesn't write names inline).
    // When the post-page data has more layers than the structural walk found,
    // append the extras as empty keyframe-less layers (they carry name metadata
    // only — content was already attributed to the structural layer).
    if (effectiveStreamTimeline) {
      const tlLen = effectiveStreamTimeline.layers.length;
      for (let i = 0; i < tlLen && i < fallbackLayers.length; i++) {
        const tlLayer = effectiveStreamTimeline.layers[i];
        if (tlLayer.schema === 0 && tlLayer.name === '' && fallbackLayers[i].name) {
          effectiveStreamTimeline.layers[i] = { ...tlLayer, name: fallbackLayers[i].name };
        }
      }
      // Append any extra layers from post-page data as empty keyframe-less layers
      if (fallbackLayers.length > tlLen) {
        for (let i = tlLen; i < fallbackLayers.length; i++) {
          effectiveStreamTimeline.layers.push({
            name: fallbackLayers[i].name,
            schema: fallbackLayers[i].schema,
            typeByte: 0, // normal
            locked: fallbackLayers[i].locked,
            visible: fallbackLayers[i].visible,
            keyframes: [],
          });
        }
      }
    }

    const tl = ((): Timeline => {
      if (effectiveStreamTimeline) {
        const attributed = buildAttributedLayers(
          effectiveStreamTimeline,
          decodedShapes,
          decodedInstances,
          libraryByNumber,
          scripts
        );
        if (attributed) {
          // Frame labels are already on keyframes via kf.label, so remove
          // duplicate ghost elements that would shadow them.
          return hostGhosts(
            {
              name,
              layers: attributed.layers,
              totalFrames: attributed.totalFrames,
              referenceLayers: attributed.referenceLayers,
            },
            doFilterFrameLabels(ghostEls)
          );
        }
      }
      // Fallback: everything into one frame on a host layer (pre-issue-8 behaviour).
      const { layers, referenceLayers } = buildLayers(
        fallbackLayers,
        decodedShapes.map((d) => d.shape),
        buildSymbolInstances(dedupedInstances, libraryByNumber)
      );
      // The structural walk failed, so we can't place scripts per keyframe — host
      // them all on the single fallback frame rather than drop them.
      if (scripts.length > 0 && layers[0]?.frames[0]) {
        layers[0].frames[0].actionScript = [...new Set(scripts.map((s) => s.source))].join('\n\n');
      }

      let totalFrames = 1;
      // Inject independently-extracted frame labels into the fallback path by creating
      // a frame for each label. This ensures all labels are indexed for AS2 linting.
      if (frameLabels.length > 0) {
        const hostLayer = layers.find(l => l.frames.length > 0 && l.frames[0].elements.length > 0) || layers[0];
        if (hostLayer && hostLayer.frames[0]) {
          const firstFrame = hostLayer.frames[0];
          const elements = firstFrame.elements;
          const actionScript = firstFrame.actionScript;
          
          const newFrames: Frame[] = [];
          for (let i = 0; i < frameLabels.length; i++) {
            newFrames.push({
              index: i,
              duration: 1,
              keyMode: 0,
              elements: [...elements], // Share elements across all frames so they are always visible
              label: frameLabels[i].label,
              labelType: 'name',
              ...(i === 0 && actionScript ? { actionScript } : {})
            });
          }
          hostLayer.frames = newFrames;
          totalFrames = frameLabels.length;
        }
      } else if (layers[0]?.frames[0]) {
        // Fallback if no frame labels are found but we have a frame
        totalFrames = 1;
      }

      // Don't filter frame labels from ghosts in the fallback path — ghost
      // elements (and the label we just set) are the surviving sources of frame
      // labels here. Ghosts still needed for multi-frame label coverage.
      return hostGhosts({ name, layers, totalFrames, referenceLayers }, ghostEls);
    })();
    return tl;
  };

  const symbols = new Map<string, Symbol>();
  // Linkage records already bound by the u32 symbol-number join — excluded from the
  // name fallback below so a record never binds two symbols.
  const numberJoinedIds = new Set(
    [...info.linkageBySymbol.values()].map((l) => l.identifier)
  );
  for (const entry of libraryByNumber.values()) {
    const symbolType =
      entry.symbolType === 'unknown' ? 'graphic' : entry.symbolType;
    const num = entry.symbolNumber;
    const timeline = buildStreamTimeline(
      entry.name,
      info.symbolLayers.get(num) ?? [],
      info.symbolTimelines.get(num),
      info.symbolShapesDecoded.get(num) ?? [],
      info.symbolInstances.get(num) ?? [],
      dedupeInstances(info.symbolInstances.get(num) ?? []),
      info.symbolScripts.get(num) ?? [],
      info.symbolNamed.get(num) ?? [],
      info.symbolFrameLabels.get(num) ?? []
    );
    const symbol: Symbol = {
      name: entry.name,
      itemID: `Symbol ${num}`,
      symbolType,
      timeline,
    };
    // Apply the resolved AS linkage to this symbol — per-symbol class +
    // identifier, exactly like the XFL path (Symbol.linkageClassName). The join
    // is u32-by-symbol-number, so it sets the class on the right library item.
    // u32-by-symbol-number join (the normal library-item case).
    let link = info.linkageBySymbol.get(num);
    // Name fallback — a container/document symbol (e.g. "InventoryLists") whose linkage
    // record's u32 lands in a stream-number gap (no S/Symbol stream): its library NAME
    // equals the class, so match it by name. Only records NOT already number-joined, and
    // an exact name match, so a record never mis-binds to the wrong symbol.
    if (!link) {
      link = info.linkage.find(
        (l) =>
          !numberJoinedIds.has(l.identifier) &&
          (l.className === entry.name || l.identifier === entry.name)
      );
    }
    if (link) {
      symbol.linkageIdentifier = link.identifier;
      if (link.kind === 'import') {
        symbol.linkageImportForRS = true;
        symbol.linkageURL = link.linkageURL;
      } else {
        if (link.className) {
          symbol.linkageExportForAS = true;
        }
        symbol.linkageExportForRS = true;
      }
      if (link.className) symbol.linkageClassName = link.className;
    }
    symbols.set(entry.name, symbol);
  }

  // Repair split symbols: the u32 number-join can land a linkage on an EMPTY "Symbol N" library
  // stub while that symbol's real content lives under a separate library item named by its class
  // (observed in inventorylists.fla: linkage CategoryList → empty "Symbol 22", content in
  // "CategoryList"). Move the linkage to the content-bearing symbol whose name == the class, so a
  // consumer can both type it AND descend into it. Only when the bound symbol is content-less and
  // the target has content and no linkage of its own, so a real binding is never disturbed.
  const hasContent = (s: Symbol): boolean =>
    s.timeline.layers.some((l) => l.frames.some((f) => f.elements.length > 0));
  for (const sym of symbols.values()) {
    if (!sym.linkageClassName || hasContent(sym)) continue;
    const target = symbols.get(sym.linkageClassName);
    if (target && target !== sym && !target.linkageClassName && hasContent(target)) {
      target.linkageClassName = sym.linkageClassName;
      target.linkageIdentifier = sym.linkageIdentifier;
      target.linkageExportForAS = sym.linkageExportForAS;
      target.linkageExportForRS = sym.linkageExportForRS;
      sym.linkageClassName = undefined;
      sym.linkageIdentifier = undefined;
      sym.linkageExportForAS = undefined;
      sym.linkageExportForRS = undefined;
    }
  }

  // One timeline per scene (`Page N`). If no scene streams were found, fall
  // back to a single empty "Scene 1" so the document still opens.
  const timelines: Timeline[] =
    info.scenes.length > 0
      ? info.scenes.map((s) =>
          buildStreamTimeline(
            `Scene ${s.scene}`,
            s.layers,
            info.sceneTimelines.get(s.scene),
            info.sceneShapesDecoded.get(s.scene) ?? [],
            info.sceneInstances.get(s.scene) ?? [],
            dedupeInstances(info.sceneInstances.get(s.scene) ?? []),
            info.sceneScripts.get(s.scene) ?? [],
            info.sceneNamed.get(s.scene) ?? [],
            info.sceneFrameLabels.get(s.scene) ?? []
          )
        )
      : [
          {
            name: 'Scene 1',
            layers: [],
            totalFrames: 1,
            referenceLayers: new Set<number>(),
          },
        ];

  return {
    width: info.width,
    height: info.height,
    frameRate: info.frameRate,
    backgroundColor: info.backgroundColor,
    timelines,
    symbols,
    bitmaps: new Map(),
    sounds: new Map(),
    videos: new Map(),
    // The binary linkage table — surfaced on the document so a consumer that
    // owns the SWF join can assign per-symbol classes (the join is not in the
    // .fla bytes). Omitted when empty so XFL/older binaries are unaffected.
    ...(info.linkage.length > 0 && { linkage: info.linkage }),
    ...(info.flashVersion !== undefined && { flashVersion: info.flashVersion }),
    ...(documentClass && { documentClass }),
  };
}
