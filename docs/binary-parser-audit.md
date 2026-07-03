# Binary FLA Parser Architecture Audit

Scope: `src/binary-fla-parser.ts`, `src/binary-timeline-decoder.ts`,
`src/binary-instance-decoder.ts`, `src/binary-shape-decoder.ts`,
`src/binary-fla-structure.ts`.

Reference XFL fixture: `src\__tests__\fixtures\cs6\itemcard`.

## Executive Summary

The current binary parser is a working recovery parser, not a clean native
MFC/CArchive parser. It repeatedly scans the same stream for class tags,
sentinels, Flash strings, frame labels, scripts, shapes, placements and layer
records, then joins those partial results by byte offsets. That design was
introduced to keep coverage high while individual CPic* body layouts were
unknown. It is useful for reverse engineering, but it cannot guarantee XFL-grade
frame/layer attribution.

The first safe refactor is now in place: shared CArchive tag scanning and a
stateful `CArchiveReader` live in `src/binary-carchive.ts`, and
`binary-instance-decoder.ts` / `binary-timeline-decoder.ts` use the shared
scanner for class/backref discovery. Shared `CPicObj::Serialize` base reading
now lives in `src/binary-cpic-object.ts`. This removes one major duplicated
mechanism and starts the native object-walk path.

Production timeline selection now prefers the native stream decoder:
`decodeNativeStreamTimeline(streamData) ?? decodeStreamTimeline(streamData)`.
The recovery decoder remains the fallback for streams whose CPic tree is not
yet fully understood. On the SkyUI `itemcard.fla` reference this switches the
final `parseBinaryFLA()` output for `ItemCard` to the XFL-aligned native shape:
31 layers, 255 keyframes, 201 total frames.

The next architectural step should not be more scans. It should be a native
object event stream:

```ts
ArchiveReader -> CArchiveObjectEvent[] -> CPicPageTree -> XflTimelineBuilder
```

Every CPic object body should be parsed once and should carry:

```ts
{
  className,
  bodyStart,
  bodyEnd,
  parentPath,
  parsed: CPicPage | CPicLayer | CPicFrame | CPicText | CPicSymbol | CPicShape
}
```

Only fields that are actually read from the binary stream should be emitted into
the XFL-facing `Timeline`, `Layer`, `Frame`, `SymbolInstance`, `TextInstance`,
and `Shape` model.

## XFL Baseline Observations

The CS6 XFL reference contains, across document/library XML files:

- 99 XML files
- 219 `DOMLayer`
- 558 `DOMFrame`
- 144 `DOMSymbolInstance`
- 10 `DOMComponentInstance`
- 127 text objects
- 69 shape objects
- 136 filters
- 1 mask layer, 0 explicit `layerType="masked"` layers in the inspected XFL set
- 6 locked layers
- 5 layers with `parentLayerIndex`

`LIBRARY/Sprites/ItemCard.xml` is the key timeline reference. Its first layer
(`Labels Layer`) has explicit label frames:

- `Weapons_reg`: index 0, duration 9
- `Weapons_Enchanted`: index 9, duration 10
- `Apparel_reg`: index 19, duration 10
- ...

This matters because current binary code extracts some labels via independent
global label scans rather than as fields of the same parsed CPicFrame object.
That can produce apparently correct label names while still placing them on the
wrong frame/layer.

## File Findings

### `binary-fla-parser.ts`

Main smell: orchestration has become a merge layer for unrelated recovery
channels.

Problem areas:

- `extractBinaryFLAInfo()` scans every scene/symbol stream multiple times:
  layers, shapes, timeline, scripts, labels, named instances, placements.
- `buildStreamTimeline()` merges `fallbackLayers` into `streamTimeline` after
  both were independently recovered. This is a symptom of missing native
  CPicLayer parsing.
- `buildAttributedLayers()` assigns all decoded shapes/instances globally over
  all keyframes, then rehydrates per layer. This can leak content when a
  placement body offset lands in a keyframe byte range that is only approximate.
- `hostGhosts()` and `ghostElement()` create XFL-visible elements that do not
  exist as parsed placements. This was added to preserve AS2 tooling names when
  FP8 placements could not be geometry-decoded. It should be kept only as a
  diagnostic side channel, not as normal `Frame.elements`.
- Defaults such as layer color `#4FFF4F`, text fill `#000000`, text size `12`,
  text bounds `100x20`, synthetic layer names and fallback totalFrames are not
  native parse results.

Native rewrite:

- Replace `BinaryFLAInfo` maps for layers/shapes/instances/scripts/labels with a
  single `DecodedStream`:

```ts
interface DecodedStream {
  name: string;
  root: CPicPage;
  diagnostics: DecodeDiagnostic[];
}
```

- Build viewer timelines from `CPicPage.layers[].frames[].children[]`, never by
  joining independent byte buckets.
- Put unresolved/recovered-only names into `diagnostics.recoveredNames`, not
  `Frame.elements`.

### `binary-timeline-decoder.ts`

Main smell: this file pretends to decode timeline structure but still depends on
scans.

Problem areas:

- `scanTimelineObjects()` was a duplicate CArchive loadArray simulation. It now
  uses `binary-carchive.ts`, but frame attribution is still scan-based.
- `getFrameDurationAndLabel()` searches for the first layer/frame sentinel
  inside a CPicFrame body and then reads from guessed offsets.
- `bodyStart + 5000`, label scan `r.pos + 120`, duration `< 16000`, cubic count
  `< 100000`, frame label signature and `trimOutlierLayers()` are confidence
  heuristics.
- `findLayerRecords()` duplicates `binary-fla-structure.ts` layer sentinel scan.
- Frame-to-layer mapping by layer record byte ranges is a workaround. In native
  CArchive, CPicFrame objects are children of a CPicLayer. The parent relation
  should be known from the object walk, not inferred from byte containment.
- `extractFrameLabelsAll()` scans labels from position 0. This is useful as a
  validation probe, but should not be the production path for `Frame.label`.

Native rewrite:

- Implement `readCPicPage(reader)`:

```ts
CPicPage {
  children: CPicLayer[]
}

CPicLayer {
  base: CPicObjBase;
  schema: number;
  name: string;
  typeByte: number;
  locked: boolean;
  visible: boolean;
  parent?: CPicLayerRef;
  frames: CPicFrame[];
}

CPicFrame {
  base: CPicObjBase;
  shape: CPicShapeTail;
  frameSchema: number;
  duration: number;
  label?: FrameLabel;
  tween?: TweenTail;
  soundRef?: number;
  children: CPicChild[];
}
```

- Frame labels should be parsed from CPicFrame tail or the frame timeline
  sub-object. The global label scanner should become an assertion:
  `assertSameLabels(parsedFrameLabels, scannedFrameLabels)`.

### `binary-instance-decoder.ts`

Main smell: two different placement decoders exist: one for geometry, one for
names.

Problem areas:

- `tryParseInstanceAt()` decodes a 16.16 matrix layout and then uses
  `bodyStart + 72` to compensate for FP8 layout. That is a layout fork expressed
  as a hardcoded offset.
- `attachInstanceNames()`, `unjoinedNames()`, `markUnreliableRefs()`, and
  `correctFp8Refs()` are all repair passes caused by not having a versioned
  CPicSymbol parser.
- `tryParseTextInstanceAt()` uses fixed offsets (`+43`, `+44`, `+51`, `+52`) and
  two-phase string/sentinel scanning. It successfully recovers SkyUI text but is
  not a native CPicText parser.
- `placementName()` scans for identifier-like Flash strings and filters fonts,
  class refs and labels. This is useful for diagnostics, not production element
  construction.
- Filter parsing recently added for Blur/Glow/DropShadow is SWF-style and gated.
  It should remain gated until cross-checked against multiple binary FLA bodies.
- Component parameters are not decoded natively. The XFL reference has
  `DOMComponentInstance` with `Inspectable` metadata, but the binary layout for
  per-instance parameter values is not proven.

Native rewrite:

- Replace `tryParseInstanceAt()` with a version-dispatched parser:

```ts
readCPicSymbolPlacement(reader, className, schema): CPicPlacement {
  const base = readCPicObjBase(reader);
  const symbolSchema = reader.u8();
  const layout = resolvePlacementLayout(className, base.schema, symbolSchema);
  return layout.read(reader);
}
```

- The parser should return exact `bodyEnd`, `matrix`, 
ame`, `mediaRef`,
  `colorTransform`, `filters`, `blendMode`, `visibility`, `loop` and component
  parameters only when read from known fields.
- Keep the current string scanner as `recoverPlacementNamesForDiagnostics()`.

### `binary-shape-decoder.ts`

Main smell: shape geometry is the most structured part, but it still uses
recovery scanning for body starts and geometric repair heuristics.

Problem areas:

- `decodeStreamShapes()` scans for likely CPicShape bodies rather than receiving
  CPicShape children from a CPicFrame/CPicSymbol walk.
- `recoverFillStyle0FromGeometry()` is explicitly a geometric heuristic.
- `decodeShapeAt()` accepts candidates by plausibility checks (`minEdges`,
  `r.pos <= bodyStart + 30`, `edgeCount * 12 + 1000` regions). These are recovery
  guards, not native parsing.

Native rewrite:

- Keep `readShapeData()` and edge decoding; they are real binary structure
  readers.
- Remove `decodeStreamShapes()` from production once CPicFrame children are
  parsed natively.
- Convert geometry recovery into a fallback diagnostic command:
  `recoverOrphanShapes(stream): DecodedShape[]`.

### `binary-fla-structure.ts`

Main smell: this duplicates layer parsing by sentinel scan.

Problem areas:

- `extractLayers()` scans for `LAYER_SIG`, then reads schema/name/type/locked/
  visible. It does not know the CPicLayer object parent or child frame list.
- Relaxed sentinel matching (`00 00` with any point and schema at `+10`) is a
  heuristic for newer files.
- Name prefix rules (`Guide: `, `Folder `) override type bytes. XFL alignment
  should prefer native type byte when known; name prefixes are diagnostics only.

Native rewrite:

- Delete this file's production role after native `readCPicLayer()` exists.
- Preserve it as `recoverLayerRecords()` only for comparing parsed layers with
  scan-derived layer metadata during migration.

## Type/XFL Alignment Gaps

Binary output currently under-populates or synthesizes these XFL-facing fields:

- `Layer.color`: hardcoded; XFL has real layer color.
- `Layer.parentLayerIndex` / `maskLayerIndex`: currently inferred from adjacent
  mask/masked sequence, not read from parent object.
- `Frame.keyMode`: always `0` in binary output, while XFL often has `8704`.
- `Frame.labelType`: binary fallback always uses 
ame`; XFL can use `anchor`.
- `SymbolInstance.loop`, `firstFrame`, `lastFrame`, `blendMode`, `isVisible`,
  `componentParameters`: mostly absent or defaults.
- `TextInstance.left`, `width`, `height`, text attrs: partially decoded; several
  values are defaults.
- `Shape` lacks item/library identity. XFL shape library items appear as symbols
  with timelines; binary currently often emits inline shapes.

## Refactoring Plan

### Phase A: Shared Primitives

Done:

- Add `binary-carchive.ts`.
- Use it for class/backref scans in instance and timeline decoders.
- Add shared `binary-flash-string.ts` for `FF FE FF` UTF-16 strings and MFC
  CStrings.

Still needed:
- Add shared constants/enums:
  `CPIC_LAYER_TYPE`, `CPIC_SYMBOL_CLASS`, `FLASH_DEFAULTS`, `TWIPS_PER_PX`.

### Phase B: Native Object Walk

Started:

- `CArchiveReader.readObjectHeader()` reads null/new-class/backref/long-backref
  tags and maintains the combined CArchive class/object load array.
- `CArchiveReader.readObject()` wraps typed body parsing and records `bodyEnd`.
- `readCPicObjBase()` reads the shared CPicObj schema/flags/children-loop/
  registration-point/extras structure without sentinel scans.
- `decodeNativeTimelineTree()` in `src/binary-native-timeline.ts` now walks
  synthetic `CPicPage -> CPicLayer -> CPicFrame -> CPicShape` streams through
  CArchive child lists and keeps frame labels on the owning `CPicFrame`.

Still needed: use these pieces to build a single page/tree reader:

```ts
class CArchiveReader {
  readObject(): CArchiveObject | null;
  readObjectChildren(): CArchiveObject[];
}
```

The reader should preserve parent/child relationships and exact byte ranges.
Unknown classes should become `UnknownCArchiveObject` with byte ranges, not
cause resync scans.

### Phase C: CPic Typed Parsers

Implement typed body readers:

- `readCPicObjBase`
- `readCPicPage`
- `readCPicLayer`
- `readCPicFrame`
- `readCPicShape`
- `readCPicSymbolPlacement`
- `readCPicText`
- `readFilters`
- `readComponentParameters` after binary samples confirm layout

### Phase D: XFL Builder

Create one builder:

```ts
function buildTimelineFromCPicPage(page: CPicPage, library: BinaryLibrary): Timeline
```

Rules:

- One CPicLayer -> one Layer.
- One CPicFrame -> one Frame.
- CPicFrame children -> Frame.elements.
- No global bucket attribution.
- No ghost elements in normal output.
- Recovery diagnostics are separate from render/tooling model.

### Phase E: Migration Gates

For every stream, compare:

- native parsed layer count vs `recoverLayerRecords()`
- native parsed frame labels vs `extractFrameLabelsAll()`
- native placements vs current `scanForInstances()`
- native text fields vs current `tryParseTextInstanceAt()`

Only remove the recovery path for a class of data when native and recovered
results agree on real SkyUI samples.

## Immediate Code Change Made

Added `src/binary-carchive.ts` and replaced duplicate loadArray simulation in:

- `binary-instance-decoder.ts`
- `binary-timeline-decoder.ts`

Added `src/binary-flash-string.ts` and moved repeated `FF FE FF` / UTF-16LE
string decoding out of:

- `binary-instance-decoder.ts`
- `binary-timeline-decoder.ts`
- `binary-fla-parser.ts`
- `binary-fla-structure.ts`

These changes are intentionally behavior-preserving. They are the first cleanup
layer before larger parser surgery.

Added native Phase B foundations:

- `CArchiveReader` in `src/binary-carchive.ts`
- `readCPicObjBase()` / `readCPicObjLeafBase()` in
  `src/binary-cpic-object.ts`
- diagnostic `decodeNativeTimelineTree()` in `src/binary-native-timeline.ts`
- unit coverage in `binary-carchive.test.ts` and `binary-cpic-object.test.ts`
  plus native timeline coverage in `binary-timeline-decoder.test.ts`

This also fixed `scanCArchiveObjectStarts()` long-backref body offsets
(`0x7FFF + u32 index` now reports `bodyStart = tagStart + 6`).

Added `scripts/diagnose-native-timeline.ts` (`npm run diagnose:native-timeline -- ...`)
to compare recovery timeline decoding against the native tree walk on real FLA
streams and optional XFL directories.

First real SkyUI run:

```txt
npx tsx scripts/diagnose-native-timeline.ts \
  src\__tests__\fixtures\cs4\itemcard.fla \
  --xfl src\__tests__\fixtures\cs6\itemcard
```

Result:

- `itemcard.fla`: 99 timeline streams, 99 recovery timelines, 0 native timelines.
- `Symbol 2` recovery: 31 layers, 282 keyframes, totalFrames 302.
- XFL `LIBRARY/Sprites/ItemCard.xml`: 31 layers, 255 `DOMFrame`.
- Main native blockers:
  - `CPicSprite`/component metadata tail: native child parsing reaches XML-like
    component metadata and then reads a bogus CArchive backref (`0x8a/0x8b`).
  - shape tail desync around cubic edge count.
  - nested `CPicPage` children in symbol-like frame content.

The `CPicObj` base reader was extended for real `schema=6` placement bodies:
schema 5 has two post-point extra bytes, while schema 6 adds a third byte before
the symbol placement tail.

Next update: schema>=22 placement decoding now consumes the observed
`dataBindingXML` component metadata Flash string (`<component ...</component>`)
and recovers the Flash-string instance name before it (for example `animate`).
The `itemcard.fla` native blocker moved from bogus CArchive backrefs to
`CPicFrame: unsupported timeline format 5`, meaning the native reader now gets
past the first component placement tail and reaches the real frame tail variant.
Full `parametersAsXML` / Inspectable records are still not decoded; in binary
they appear as a sequence of property records, not as one XML string.

Next update: `CPicFrame` schema 29 / timeline `formatType=1` is now decoded
well enough to walk the real `itemcard.fla` `Page 0` stream natively:

- recovery: 1 layer, 1 keyframe, totalFrames 1
- native: 1 layer, 1 keyframe, totalFrames 1

The fix is structural:

- schema>=23 frames may carry an empty Flash string immediately before the
  timeline sub-object.
- `formatType=1` consumes its observed fixed fields and leaves the layer
  child-list null terminator in place.

The main `Symbol 2` blocker is now deeper in multi-frame/component content:
`CArchive: invalid backref index 768`, caused after many decoded frames by a
remaining placement/component parameter tail gap.

Next update: native CPicText child consumption is now parent-frame aware for
text fields that carry internal sentinels and Flash strings. The previous text
end position could stop inside CPicText formatting/name data, causing the owning
CPicFrame to read a bogus duration (`16384`). The native walker now identifies
the following real frame tail and backs up over the owning frame's CPicObj
post-children fields plus the empty own-shape tail.

This made the key SkyUI reference stream decode natively:

- `itemcard.fla` `Symbol 2` native: 31 layers, 255 frames, totalFrames 201
- XFL `LIBRARY/Sprites/ItemCard.xml`: 31 layers, 255 `DOMFrame`
- recovery path for the same stream still reports 31 layers, 282 keyframes,
  totalFrames 302, showing exactly why native tree walk should replace
  range/sentinel recovery for production timeline attribution.

Next update: `CPicSymbol` schema>=22 placement tails are now consumed natively.
The common `CPicFrame: unsupported child CPicPage` failure was a desync:
`tryParseInstanceAt()` stopped at `mediaRef`, then the remaining CPicSymbol tail
bytes were read as another CArchive child. The parser now validates the observed
128-byte tail (`u32 1`, empty marker, target symbol id, identity float anchors)
and advances `endPos` over it.

This raised `itemcard.fla` native timeline coverage from 17/99 streams to 48/99
streams. The next high-value blocker is `CPicShape` schema 6 /
`shapeDataSchema=5` tail consumption. The old assumption that the post-edge data
is an `s32 cubicCount` is false for these streams: reading it as a count produces
values such as `262160`, `16318480`, and `16777440`.

Next update: the native frame walker no longer treats `shapeDataSchema=5`
post-edge bytes as a mandatory `s32 cubicCount` when consuming a CPicFrame's own
shape canvas. For timeline walking, the required native boundary is the owning
`CPicFrame` tail, so the reader now validates the next plausible frame-tail
signature and advances to it only in that context. Child `CPicShape` parsing
keeps the stricter path.

This raised `itemcard.fla` native timeline coverage from 48/99 streams to 77/99
streams. The remaining largest blocker groups are now truncated tail reads,
invalid CArchive backrefs around component/sprite child tails, and a few
unsupported timeline-format values caused by still-unconsumed placement tails.

Next update: schema>=22 placement tails are now handled for both the simple
legacy `name/mediaRef` layout and the variant where those fields are replaced by
transform/metadata records before the `FF FF FE FF 00` marker. The decoder uses
the marker's target symbol id as the trusted reference when the legacy fields are
absent, and the native walker can extend a decoded placement to the owning
frame-tail boundary when inline metadata would otherwise be read as an
implausible CArchive object tag (`0x0508` / backref index 1288).

This raised `itemcard.fla` native timeline coverage from 77/99 streams to 85/99
streams. Remaining failures are now mostly truncated end-of-stream variants,
unsupported timeline-format tails, and one deeper `CPicSprite` child body in
`Symbol 59`.

Next update: frame-tail boundary validation now checks the following timeline
sub-object instead of accepting only `frameSchema/duration/keyMode`-looking
bytes. The previous boundary finder could lock onto edge-stream bytes that
looked like a CPicFrame header, then report bogus timeline formats such as
`41824256`, `4278190655`, and `1342181630`. The stronger validator requires the
computed timeline `formatType` to be one of the decoded native variants
(`0`, `1`, or `2`).

This raised `itemcard.fla` native timeline coverage from 85/99 streams to 89/99
streams and removed the unsupported timeline-format blocker group.

Next update: the native walker now decodes all 99 timeline streams in the real
SkyUI `itemcard.fla` fixture. The remaining blockers were not new sentinel
scans; they were small native boundary variants:

- `CPicShape` timeline consumption now recovers to the owning `CPicFrame` tail
  when full geometry decode hits EOF/overshoots in frame-walk context.
- Frame-tail search prefers keyframe tails (`field188=0x2200`) before the broad
  fallback, avoiding false positives inside edge data.
- `CArchiveReader` gained checkpoint/peek support so nullable object fields can
  detect a following `CPicLayer` boundary without mutating the load array.
- `CPicLayer` can stop at a following `CPicLayer` boundary when optional parent
  or shell-layer fields are omitted, including observed `schema=1, flags=1`
  layer shells with a single pre-children zero byte.
- Empty Flash strings are accepted as native layer names.

Validation:

- `itemcard.fla` native timelines: 99/99
- `ItemCard` production parse remains aligned with XFL: 31 layers, 255 frames,
  totalFrames 201.

Next update: `Symbol 18` was cross-checked against the correct XFL item,
`LIBRARY/Sprites/Sprite 70.xml` (`Symbol 18` library name is `Sprite 70`, not
`Sprite 18`). Native decoding now matches the XFL timeline shape:

- XFL `Sprite 70`: 8 `DOMLayer`, 12 `DOMFrame`, total span 200.
- Native `Symbol 18`: 8 layers, 12 frames, totalFrames 200.
- Motion-keyframe tails use `field188/keyMode=0x4601`; accepting this value
  prevents motion layers (`Layer 8`, `Layer 9`, `Layer 11`) from being swallowed
  by the previous layer's frame.
- `CPicLayer` schema>=8 parent fields can carry `CPicLayer` object-backrefs for
  masked-layer parent relationships; class-backrefs still start the next layer.
- The unnamed mask layer is real XFL semantics, so fallback layer-name merge now
  only fills empty names for legacy `schema=0` timeline layers.

Next update: mask/masked metadata is now propagated into viewer timelines.
CArchive object headers carry their load-array `objectIndex/referenceIndex`, so
native `CPicLayer` parent object-backrefs can be mapped to concrete layer
indices instead of byte offsets. The decoded timeline marks the parent layer as
`mask`, referenced children as `masked`, and performs the observed XFL group
inference for the one immediately lower sibling (`Layer 2`) that belongs to the
mask group without its own explicit parent ref.

Validation against `Sprite 70`:

- viewer timeline: 8 layers, 12 frames, totalFrames 200.
- unnamed layer is preserved as the `mask` layer.
- `Layer 2`, `Layer 6`, `Layer 8`, `Layer 9`, `Layer 11` are `masked` with
  `parentLayerIndex=2` / `maskLayerIndex=2` in the then-current bottom-up
  viewer order.
- `Labels Layer` remains `guide`.

Next update: frame-tail detection and native layer ordering were centralized.

- `CPicFrame` tail validation now lives in `binary-cpic-frame-tail.ts`, with a
  single known-key-mode table shared by shape-tail, inline-frame and CPicText
  boundary readers.
- `keyMode=0x2600` is accepted as an observed frame-tail variant; this fixes the
  `favoritesmenu.fla` `FavoritesMenu` timeline that previously stopped after 5
  of the 7 XFL layers.
- CPicText frame-tail boundary handling now only controls the parent
  `CPicFrame` reader position. The CPicText payload scan is intentionally not
  clamped to that boundary, because real text-field instance names can appear
  later in the text payload.
- `nativeTimelineToDecodedTimeline()` now emits layers in XFL/display order
  instead of raw CArchive order and remaps `parentLayerIndex` to that emitted
  order. The original native layer index is preserved as `sourceLayerIndex` for
  diagnostics.
- `compare-native-xfl-semantics.ts` now consumes the same decoded layer order as
  production instead of maintaining a separate mask-group reordering path.

Validation across current SkyUI XFL references:

- `favoritesmenu`: matched 4, clean 4, mismatched 0.
- `itemcard`: matched 57, clean 57, mismatched 0.
- `inventorylists`: matched 20, clean 20, mismatched 0.
- `magicmenu`: matched 5, clean 5, mismatched 0.
- `map`: matched 10, clean 10, mismatched 0.
- `configpanel`: matched 3, clean 3, mismatched 0.

Next update: the F1-F4 native timeline semantics now have regression coverage.

- `migration-gate.test.ts` asserts that binary `favoritesmenu.fla` decodes the
  full `FavoritesMenu` layer stack in XFL order:
  `navpanel`, `button`, `text`, `cat btns`, `group btns`, `list`, `background`.
- The same test file asserts that `itemcard.fla` `Symbol 18` / `Sprite 70`
  emits the mask group in display order and that all masked children point to
  the emitted mask layer index.
- This locks the two recent real blockers: CPicText/frame-tail overrun causing
  missing layers, and raw CArchive layer order leaking into the public
  `FLADocument` timeline.

Next update: F5 linkage / Contents audit.

Files audited:

- `src/binary-linkage-decoder.ts`
- `src/binary-fla-parser.ts` Contents orchestration
- `src/__tests__/binary-linkage-decoder.test.ts`

Current native Contents path:

- `extractLinkage(contents)` reads linkage table records structurally from the
  observed Contents layout: `<identifier> <separator> <className>
  <schema:u8> 02 00 00 00`. It accepts both `.` and empty separator records and
  classless RS-only exports.
- `extractImports(contents)` reads adjacent `<className> <*.swf url>` Flash
  strings as runtime-shared imports and surfaces them as `kind: "import"`.
- `binary-native-contents.ts` resolves most local linkage records to concrete
  symbol streams after the library table has been decoded. Exact joins use the
  decoded library item name; component-only records can still resolve through
  the linkage table's nearest `"Symbol N"` / `"Sprite N"` binding.
- `parseBinaryFLA()` applies the resolved linkage to `Symbol.linkageClassName`,
  `linkageIdentifier`, import flags and `linkageURL`, while preserving the full
  document-level linkage table for document/root and imported records.

Audit findings:

- The old top-level comment in `binary-linkage-decoder.ts` still claimed that
  joining linkage to symbol numbers was impossible from binary bytes. That was
  stale: the current Contents path already performs a structural join for the
  real SkyUI corpus. The comment was updated to describe the current u32 /
  edit-name / fallback join.
- `BinaryFLAInfo.linkage` had the same stale wording. It now documents that the
  raw table remains because some records have no local symbol stream, not
  because all joins are impossible.
- `extractLinkageClassNames()` was dead legacy code from the old issue-42
  side-channel. It duplicated import scanning against a full OLE2 file and was
  unused by production; it was removed.
- Placement aliases are now derived from decoded `BinaryLibraryEntry`
  records, not by rescanning Contents from the linkage decoder.

Validation before Contents centralization:

- `binary-linkage-decoder.test.ts`: 13/13 passing.
- New coverage locks import record extraction, `Sprite N` fallback joins, and
  dual-numbered placement aliases. These assertions were later split between
  `binary-linkage-decoder.test.ts` and `binary-native-contents.test.ts` when the
  join moved out of the linkage decoder.
- Real SkyUI spot check before the join moved to decoded library entries:
  - `itemcard.fla`: library 98, linkage 28, joined 11.
  - `inventorylists.fla`: library 81, linkage 23, joined 21.
  - `favoritesmenu.fla`: library 122, linkage 18, joined 13.
  - `configpanel.fla`: library 94, linkage 37, joined 28.

Remaining F5 technical debt:

- Contents is still not represented as a typed CArchive object graph. The
  linkage/library readers are structural field readers over observed Contents
  records. That is much narrower than old whole-stream heuristics, but the next
  cleanup step should type the individual Contents record variants instead of
  letting each reader rediscover adjacent fields.

Next update: Contents orchestration was centralized in `binary-native-contents.ts`.

- `binary-native-contents.ts` now owns:
  - `BinaryLibraryEntry` / `BinarySymbolType`;
  - library item extraction from Contents;
  - linkage + import aggregation;
  - placement-id to content-stream aliases;
  - linkage-to-symbol joins.
- `binary-fla-parser.ts` now calls `readNativeContents(contents, symbolNumbers)`
  once and consumes the returned `library`, `linkage`, `linkageBySymbol` and
  `placementIdToStream`. This removes the parser-local `extractLibrary()`
  implementation and keeps alias/join decisions next to the Contents field
  readers.
- `binary-native-contents.test.ts` covers the integrated Contents path with a
  dual-numbered synthetic library item: library extraction, `28 -> 23`
  placement alias and linkage join all come from one call.

Validation:

- `binary-native-contents.test.ts`: 5/5 passing.
- `binary-linkage-decoder.test.ts`: 8/8 passing.
- `migration-gate.test.ts`: 7/7 passing.
- `tsc --noEmit --noUnusedLocals false --noUnusedParameters false`: passing.
- Real SkyUI linkage metrics after the move:
  - `itemcard.fla`: library 98, linkage 28, joined 12. The extra join is the
    valid classless RS-only `Enter` export bound to `Sprite 14` / stream 88.
  - `inventorylists.fla`: library 81, linkage 23, joined 21.
  - `favoritesmenu.fla`: library 122, linkage 18, joined 13.
  - `configpanel.fla`: library 94, linkage 37, joined 28.

Next update: linkage joins and placement aliases no longer rescan library-item
records in `binary-linkage-decoder.ts`.

- `binary-linkage-decoder.ts` now only extracts linkage/import records and their
  nearest edit-name binding.
- `joinLinkageToLibrary()` in `binary-native-contents.ts` joins linkage records
  against the decoded `BinaryLibraryEntry[]`.
- `collectSymbolNumberAliases()` now consumes decoded library entries directly.
- The old `symbolNumberFor()` / `libraryItemNumbersFor()` duplicate scanner was
  removed, eliminating the second independent interpretation of library-item
  records.
- Current validation for this split is:
  - `binary-native-contents.test.ts`: 5/5 passing.
  - `binary-linkage-decoder.test.ts`: 8/8 passing.
  - `migration-gate.test.ts`: 7/7 passing.
  - `tsc --noEmit --noUnusedLocals false --noUnusedParameters false`: passing.

Next update: XFL attribute coverage audit was added.

- `scripts/audit-binary-xfl-attributes.ts` walks one or more CS6 XFL folders,
  counts every observed `tag.attribute`, and classifies current binary coverage
  as `parsed`, `partial`, `missing`, `not-modeled`, or `editor-only`.
- Current command used for the SkyUI references:

```powershell
npx tsx scripts\audit-binary-xfl-attributes.ts `
  src\__tests__\fixtures\cs6\itemcard `
  src\__tests__\fixtures\cs6\inventorylists `
  src\__tests__\fixtures\cs6\favoritesmenu `
  src\__tests__\fixtures\cs6\magicmenu `
  src\__tests__\fixtures\cs6\map `
  src\__tests__\fixtures\cs6\configpanel
```

Coverage snapshot across the six XFL folders before the keyMode propagation fix:

- Unique XFL `tag.attribute` pairs: 287.
- `parsed`: 42.
- `partial`: 39.
- `missing`: 103.
- `not-modeled`: 5.
- `editor-only`: 98.

Highest-priority runtime gaps found by the audit at that point:

- `DOMFrame.keyMode`: 1909 occurrences / 425 files. The native frame tail knows
  the key-mode word, but `Frame.keyMode` is still emitted as `0`.
- `DOMLayer.color`: 906 occurrences / 425 files. Binary output still hardcodes
  layer color.
- `DOMSymbolInstance.centerPoint3DX/Y` and `DOMComponentInstance.centerPoint3DX/Y`:
  transformation points default to `{0,0}`.
- `DOMSymbolInstance.loop`: 150 occurrences / 95 files. Graphic playback
  properties (`loop`, `firstFrame`, `lastFrame`) are not decoded.
- `DropShadowFilter.*`: heavily used on text; native placement filter parsing
  still has placeholder objects for several filter ids.
- `DOMDynamicText` field flags (`isSelectable`, `lineType`, `renderAsHTML`,
  `scrollable`, `fontRenderingMode`, `includeOutlines`) and `DOMTextAttrs`
  details (`letterSpacing`, `lineSpacing`, `autoKern`, `alpha`, margins) are not
  decoded.
- `DOMComponentItem` / `DOMComponentInstance` component metadata and
  `PD`/`Inspectable` data are not decoded into `ComponentParameter[]`.
- `DOMSymbolItem` / `DOMComponentItem` scale-grid attributes are not decoded
  into `scale9Grid`.
- Bitmap and font library items (`DOMBitmapItem`, `DOMFontItem`) are not decoded
  from binary media/library records.
- Motion object/easing tags (`AnimationCore`, `Keyframe`, `Settings`,
  `TimeMap`, `easeMethodName`, `customEase`) are not decoded.

Recommended next phase order from that snapshot:

1. Propagate native `keyMode` and exact frame-tail fields into `Frame`.
2. Replace the placeholder filter reader in `binary-cpic-placement.ts` with the
   fuller SWF filter reader from the old decoder path, then validate against
   XFL `DropShadowFilter`.
3. Decode graphic playback / placement tail attributes: `loop`, `firstFrame`,
   `lastFrame`, `blendMode`, `isVisible`, transformation point.
4. Decode text field flags and remaining `DOMTextAttrs` fields.
5. Decode component parameters / persistent data.
6. Decode scale9Grid, bitmap/font library records, and then the lower-priority
   motion-object / 3D metadata.

Next update: native `DOMFrame.keyMode` propagation is complete.

- `NativeCPicFrame` now stores the modern CPicFrame key-mode word read from the
  native frame tail.
- `nativeTimelineToDecodedTimeline()` carries it into `DecodedKeyframe.keyMode`.
- `buildAttributedLayers()` emits `Frame.keyMode = kf.keyMode ?? 0` for native
  attributed frames.
- Legacy/compact tails still emit `0` until their equivalent key-mode field is
  proven.
- `migration-gate.test.ts` now asserts that `itemcard.fla` `ItemCard` /
  `Labels Layer` frames expose `8704`, matching the XFL key-mode value.
- `scripts/audit-binary-xfl-attributes.ts` now marks `DOMFrame.keyMode` as
  `parsed`.
- Updated coverage totals across the six XFL folders: `parsed=43`,
  `partial=39`, `missing=102`, `not-modeled=5`, `editor-only=98`.

Next update: native placement filter placeholders were removed.

Next update: placement playback and center diagnostics.

- Native schema>=22 placement references now use the validated transform-tail
  target id, including both observed marker variants (`FF FF FE FF 00` and
  `FF FF FF FF FF FE FF 00`), then normalize placement ids through the
  `Contents` alias map before building `libraryItemName`.
- Binary `SymbolInstance.loop` now follows the XFL default (`loop`) when no
  explicit CPicSymbol playback field has been proven. Explicit `single frame`,
  `play once`, `firstFrame`, and `lastFrame` remain undecoded.
- `scripts/probe-placement-playback.ts` now reports matched XFL loop,
  `centerPoint3D`, `transformationPoint`, and binary CPicObj
  `registrationPoint` distributions.
- Probe evidence across `inventorylists`, `favoritesmenu`, and `configpanel`
  shows CPicObj `registrationPoint` does not match XFL `centerPoint3DX/Y` or
  `transformationPoint`. Do not map it to viewer pivot/center fields without
  additional binary evidence.
- Updated coverage totals across the six XFL folders after loop default
  alignment: `parsed=50`, `partial=33`, `missing=101`, `not-modeled=5`,
  `editor-only=98`.

- `src/binary-swf-filters.ts` now owns the SWF-style placement filter stack
  decoder.
- `binary-cpic-placement.ts` and the legacy `binary-instance-decoder.ts` both
  call the same decoder, so native and diagnostic paths no longer interpret
  filter ids independently.
- The validated binary subset is:
  - id `0`: `DropShadowFilter`;
  - id `1`: `BlurFilter`;
  - id `2`: `GlowFilter`.
- The native path now returns complete typed filter objects for those ids
  instead of placeholder objects such as `{ type: "dropShadow" } as any`.
- Other SWF filter ids still return `null` until Bevel / GradientGlow /
  GradientBevel / ColorMatrix / Convolution layouts are validated against real
  binary FLA/XFL pairs.
- `binary-cpic-placement.test.ts` covers Blur and DropShadow in the native
  `readCPicPlacement()` path.
- `binary-instance-decoder.test.ts -t Filter` confirms the legacy path still
  decodes Blur and DropShadow through the shared reader.
- Updated coverage totals across the six XFL folders: `parsed=50`,
  `partial=32`, `missing=102`, `not-modeled=5`, `editor-only=98`.

Next update: `DOMLayer` authoring attributes separated from runtime coverage.

- Rechecked `CPicLayer` against `inventorylists` and `favoritesmenu` XFL
  timelines. The current native field interpretation for layer `name`,
  `visible`, `locked`, mask parent refs, and derived `mask`/`masked` layer
  types remains clean for all matched streams:
  - `inventorylists`: 20 matched timelines, 20 clean;
  - `favoritesmenu`: 4 matched timelines, 4 clean.
- A direct `type, locked, visible` reinterpretation of the three bytes after
  the layer name was tested and rejected: it turns many XFL-visible layers into
  hidden layers and marks normal layers as guide layers. Do not switch to that
  layout without stronger binary evidence.
- `DOMLayer.color`, `DOMLayer.outline`, and `DOMLayer.height` are now classified
  as authoring/timeline UI state rather than missing runtime parser fields.
  In the observed XFL set, `outline` is paired with `useOutlineView`; `color`
  is the layer UI swatch; `height` does not appear in the six SkyUI comparison
  folders.
- Updated coverage totals across the six XFL folders:
  `parsed=50`, `partial=33`, `missing=99`, `not-modeled=5`,
  `editor-only=100`.

Next update: CPicText sentinel validation and color marker variant.

- Added `scripts/probe-text-attrs.ts` to compare XFL `DOMTextAttrs` against
  decoded binary CPicText instances. The probe reports XFL attr value
  distributions and matched binary mismatches, which is useful before promoting
  a text attr from `missing`/`partial` to `parsed`.
- Fixed native CPicText raw text extraction: the sentinel scanner now rejects
  UTF-16 BOM/control/service fragments such as `ā` or `\uFEFF...` and keeps the
  real authoring text (`Label`, `SELECTED  TEXT`, `$FILTER`, etc.).
- Fixed CPicText fill color extraction for the observed CS4 style marker
  variant `01 00 00 00 <ABGR>`. The older path only accepted
  `00 00 00 00 <ABGR>`, so `inventorylists.fla` text fields defaulted to
  `#000000` despite carrying `#FFFFFF` in the binary stream.
- `migration-gate.test.ts` now covers `inventorylists.fla` /
  `CategoryLabel`: native binary parsing must emit text `Label` and
  fill color `#FFFFFF`.
- Remaining text coverage gaps are still real:
  - `letterSpacing`, `lineSpacing`, `autoKern`, `aliasText`, and similar fields
    are visible in XFL, but no native CPicText byte mapping has been proven.
  - `fontSize`/`alignment` offsets work for some itemcard bodies but diverge on
    inventorylists/favorites examples; do not promote them to `parsed` until the
    format block is decoded structurally rather than by fixed offsets.

Next update: CPicText bold propagation.

- The native CPicText parser already decoded the `22 00` format marker into a
  `bold` boolean, but the value stopped at `CPicTextResult` and was not exposed
  in `DecodedTextData` or `TextRun`.
- `DecodedTextData.bold` now carries the value through
  `decodedInstanceFromCPicText()` and `buildTextInstance()`, so binary
  `TextRun.bold` is populated for native text fields.
- `scripts/probe-text-attrs.ts` now includes `bold` in binary attr comparisons
  and reports match reasons (`symbol/name/text`, `symbol/ordinal`, etc.) so text
  attr probes can distinguish exact text matches from order-based fallback
  matches.
- `migration-gate.test.ts` now asserts that itemcard binary parsing produces at
  least one native text run with `bold === true`.
- Updated coverage totals across the six XFL folders:
  `parsed=51`, `partial=32`, `missing=99`, `not-modeled=5`,
  `editor-only=100`. `DOMTextAttrs` is now `parsed=1`, `partial=4`,
  `missing=7`.

Stop point summary before squash.

- The six comparison XFL folders are now checked into repo-local fixtures under
  `src/__tests__/fixtures/cs6/*`; the CS4 binary FLA regression corpus is under
  `src/__tests__/fixtures/cs4/*.fla`. Diagnostic scripts and tests no longer
  require a developer-local SkyUI checkout for their default runs.
- Local user paths were removed from runnable scripts, tests, docs, and copied
  XFL `PublishSettings.xml` files.
- `DOMSymbolInstance.blendMode` is now partially covered. The only validated
  binary mapping is schema-22 placement tail code `2 -> layer`, observed on
  `itemcard/Sprite 93`; other blend modes stay unpromoted until proven with
  binary/XFL pairs.
- Current fixture coverage totals:
  `parsed=51`, `partial=33`, `missing=98`, `not-modeled=5`,
  `editor-only=100`.
- The main remaining binary-code cleanup target is the legacy recovery layer in
  `binary-timeline-decoder.ts` / `binary-instance-decoder.ts`. Production
  parsing now uses the native `CPicPage` walk in `binary-native-timeline.ts`,
  while the recovery modules still exist for migration-gate comparison and
  historical tests. Do not delete them without first narrowing
  `binary-migration-gate.ts` to explicit diagnostic-only usage.
