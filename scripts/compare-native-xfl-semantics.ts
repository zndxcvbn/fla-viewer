import { readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { OLE2File } from '../src/ole2-reader';
import { extractBinaryFLAInfo, type BinaryFLAInfo } from '../src/binary-fla-parser';
import {
  decodeNativeTimelineTreeDetailed,
  nativeTimelineToDecodedTimeline,
  type NativeCPicPage,
} from '../src/binary-native-timeline';

interface Args {
  fla: string;
  xfl: string;
  json: boolean;
  onlyMismatches: boolean;
}

interface XflFrameSummary {
  index: number;
  duration: number;
  label?: string;
  labelType?: string;
  elements: number;
  symbols: number;
  shapes: number;
  texts: number;
  bitmaps: number;
  hasActionScript: boolean;
}

interface XflLayerSummary {
  name: string;
  layerType: string;
  parentLayerIndex?: number;
  visible: boolean;
  locked: boolean;
  frames: XflFrameSummary[];
}

interface XflTimelineSummary {
  file: string;
  itemName: string;
  timelineName: string;
  kind: 'document' | 'symbol';
  linkageIdentifier?: string;
  linkageClassName?: string;
  sourceFlashFilepath?: string;
  sourceLibraryItemHRef?: string;
  layers: XflLayerSummary[];
}

interface NativeFrameSummary {
  index: number;
  duration: number;
  label?: string;
  elements: number;
  placements: number;
  shapes: number;
  texts: number;
  shells: number;
}

interface NativeLayerSummary {
  name: string;
  layerType: string;
  visible: boolean;
  locked: boolean;
  frames: NativeFrameSummary[];
}

interface NativeTimelineSummary {
  stream: string;
  ok: boolean;
  error?: string;
  layers: NativeLayerSummary[];
}

interface TimelineComparison {
  xflFile: string;
  xflTimeline: string;
  stream?: string;
  matchReason?: string;
  status: 'matched' | 'unmatched' | 'missing-stream' | 'native-error';
  mismatches: string[];
}

const ELEMENT_TAGS = [
  'DOMSymbolInstance',
  'DOMComponentInstance',
  'DOMShape',
  'DOMDynamicText',
  'DOMStaticText',
  'DOMInputText',
  'DOMBitmapInstance',
];

function usage(): never {
  console.error(
    [
      'Usage:',
      '  npx tsx scripts/compare-native-xfl-semantics.ts <fla> --xfl <xfl-dir> [--json] [--only-mismatches]',
      '',
      'Example:',
      '  npx tsx scripts/compare-native-xfl-semantics.ts src\\__tests__\\fixtures\\cs4\\itemcard.fla --xfl src\\__tests__\\fixtures\\cs6\\itemcard',
    ].join('\n')
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const fla = argv[0];
  if (!fla) usage();

  let xfl = '';
  let json = false;
  let onlyMismatches = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--xfl') {
      xfl = argv[++i] ?? '';
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--only-mismatches') {
      onlyMismatches = true;
    } else {
      usage();
    }
  }
  if (!xfl) usage();
  return { fla: path.resolve(fla), xfl: path.resolve(xfl), json, onlyMismatches };
}

function attr(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1];
}

function boolAttr(tag: string, name: string, defaultValue: boolean): boolean {
  const raw = attr(tag, name);
  return raw === undefined ? defaultValue : raw !== 'false';
}

function numberAttr(tag: string, name: string, defaultValue: number): number {
  const raw = attr(tag, name);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  return Number.isFinite(value) ? value : defaultValue;
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'g'))].map((m) => m[0]);
}

function openingTag(block: string, tag: string): string {
  return block.match(new RegExp(`<${tag}\\b[^>]*>`))?.[0] ?? '';
}

function countTag(block: string, tag: string): number {
  return (block.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length;
}

function parseFrame(frameBlock: string): XflFrameSummary {
  const tag = openingTag(frameBlock, 'DOMFrame');
  const symbols = countTag(frameBlock, 'DOMSymbolInstance');
  const shapes = countTag(frameBlock, 'DOMShape');
  const texts =
    countTag(frameBlock, 'DOMDynamicText') +
    countTag(frameBlock, 'DOMStaticText') +
    countTag(frameBlock, 'DOMInputText');
  const bitmaps = countTag(frameBlock, 'DOMBitmapInstance');
  const elements = ELEMENT_TAGS.reduce((sum, elementTag) => sum + countTag(frameBlock, elementTag), 0);
  return {
    index: numberAttr(tag, 'index', 0),
    duration: numberAttr(tag, 'duration', 1),
    label: attr(tag, 'name'),
    labelType: attr(tag, 'labelType'),
    elements,
    symbols,
    shapes,
    texts,
    bitmaps,
    hasActionScript: frameBlock.includes('<Actionscript>'),
  };
}

function parseLayer(layerBlock: string): XflLayerSummary {
  const tag = openingTag(layerBlock, 'DOMLayer');
  const parentLayerIndex = attr(tag, 'parentLayerIndex');
  const explicitLayerType = attr(tag, 'layerType');
  return {
    name: attr(tag, 'name') ?? '',
    layerType: parentLayerIndex !== undefined ? 'masked' : explicitLayerType ?? 'normal',
    ...(parentLayerIndex !== undefined && { parentLayerIndex: Number(parentLayerIndex) }),
    visible: boolAttr(tag, 'visible', true),
    locked: boolAttr(tag, 'locked', false),
    frames: blocks(layerBlock, 'DOMFrame').map(parseFrame),
  };
}

function parseXflTimeline(file: string, xml: string): XflTimelineSummary | null {
  const documentTag = xml.match(/<DOMDocument\b[^>]*>/)?.[0];
  const symbolTag = xml.match(/<DOMSymbolItem\b[^>]*>/)?.[0];
  const componentTag = xml.match(/<DOMComponentItem\b[^>]*>/)?.[0];
  const timelineBlock = blocks(xml, 'DOMTimeline')[0];
  if (!timelineBlock) return null;

  const timelineTag = openingTag(timelineBlock, 'DOMTimeline');
  const ownerTag = symbolTag ?? componentTag ?? documentTag ?? '';
  const itemName = attr(ownerTag, 'name') ?? attr(timelineTag, 'name') ?? path.basename(file, '.xml');

  return {
    file,
    itemName,
    timelineName: attr(timelineTag, 'name') ?? itemName,
    kind: symbolTag || componentTag ? 'symbol' : 'document',
    linkageIdentifier: attr(ownerTag, 'linkageIdentifier'),
    linkageClassName: attr(ownerTag, 'linkageClassName'),
    sourceFlashFilepath: attr(ownerTag, 'sourceFlashFilepath'),
    sourceLibraryItemHRef: attr(ownerTag, 'sourceLibraryItemHRef'),
    layers: blocks(timelineBlock, 'DOMLayer').map(parseLayer),
  };
}

async function listXmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) out.push(full);
    }
  }
  if (statSync(root).isDirectory()) await walk(root);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function readXflTimelines(root: string): Promise<XflTimelineSummary[]> {
  const timelines: XflTimelineSummary[] = [];
  for (const file of await listXmlFiles(root)) {
    if (/[\\/]LIBRARY[\\/]Shapes[\\/]/i.test(file)) continue;
    const parsed = parseXflTimeline(file, await readFile(file, 'utf8'));
    if (parsed && parsed.layers.length > 0) timelines.push(parsed);
  }
  return timelines;
}

function streamNumber(stream: string): number | null {
  const match = /^(?:Symbol|Page) (\d+)$/.exec(stream);
  return match ? Number(match[1]) : null;
}

function layerTypeFromNative(typeByte: number | undefined): string {
  if (typeByte === 3) return 'mask';
  if (typeByte === 4) return 'masked';
  return 'normal';
}

function summarizeNativePage(stream: string, page: NativeCPicPage): NativeTimelineSummary {
  const decoded = nativeTimelineToDecodedTimeline(page);
  return {
    stream,
    ok: true,
    layers: decoded.layers.map((decodedLayer, decodedLayerIndex) => {
      const layer = page.layers[decodedLayer.sourceLayerIndex ?? decodedLayerIndex];
      return {
        name: decodedLayer.name,
        layerType: layerTypeFromNative(decodedLayer?.typeByte),
        visible: decodedLayer.visible,
        locked: decodedLayer.locked,
        frames: (decodedLayer?.keyframes ?? []).map((decodedFrame) => {
          const counts = { placements: 0, shapes: 0, texts: 0, shells: 0 };
          for (const frame of layer.frames) {
            if (frame.header.bodyStart < decodedFrame.bodyStart || frame.header.bodyStart >= decodedFrame.bodyEnd) continue;
            if (frame.hasShapeTail) counts.shapes += 1;
            for (const child of frame.base.children) {
              if (child.value.kind === 'placement') counts.placements += 1;
              else if (child.value.kind === 'shape') counts.shapes += 1;
              else if (child.value.kind === 'text') counts.texts += 1;
              else if (child.value.kind === 'placementShell') counts.shells += 1;
            }
          }
          for (const frame of layer.frames) {
            for (const segment of frame.inlineSegments ?? []) {
              if (layer.frames.some((other) =>
                other !== frame &&
                segment.bodyStart >= other.header.bodyStart &&
                segment.bodyStart < other.bodyEnd
              )) {
                continue;
              }
              if (segment.bodyStart < decodedFrame.bodyStart || segment.bodyStart >= decodedFrame.bodyEnd) continue;
              for (const child of segment.children) {
                if (child.value.kind === 'placement') counts.placements += 1;
                else if (child.value.kind === 'shape') counts.shapes += 1;
                else if (child.value.kind === 'text') counts.texts += 1;
                else if (child.value.kind === 'placementShell') counts.shells += 1;
              }
            }
          }
          return {
            index: decodedFrame.startIndex,
            duration: decodedFrame.duration,
            label: decodedFrame?.label,
            elements: counts.placements + counts.shapes + counts.texts + counts.shells,
            ...counts,
          };
        }),
      };
    }),
  };
}

function summarizeNativeStreams(bytes: Uint8Array): Map<string, NativeTimelineSummary> {
  const ole = new OLE2File(bytes);
  const summaries = new Map<string, NativeTimelineSummary>();
  for (const entry of ole.listStreams()) {
    if (!/^(Page|Symbol) \d+$/.test(entry.name)) continue;
    const native = decodeNativeTimelineTreeDetailed(ole.readStream(entry.name));
    summaries.set(entry.name, native.page
      ? summarizeNativePage(entry.name, native.page)
      : { stream: entry.name, ok: false, error: native.error, layers: [] });
  }
  return summaries;
}

function symbolRefNumber(value: string | undefined): number | null {
  if (!value) return null;
  const match = /(?:^|[\\/ ])(?:Symbol|Sprite|Shape) (\d+)$/i.exec(value);
  return match ? Number(match[1]) : null;
}

function pageRefNumber(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^Page (\d+)$/i.exec(value);
  return match ? Number(match[1]) : null;
}

function libraryBasename(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name;
}

function findSymbolMatch(
  xfl: XflTimelineSummary,
  info: BinaryFLAInfo,
  native: Map<string, NativeTimelineSummary>
): { stream: string; reason: string } | null {
  const symbolNumbers = new Set(
    [...native.keys()]
      .filter((stream) => stream.startsWith('Symbol '))
      .map((stream) => streamNumber(stream))
      .filter((n): n is number => n !== null)
  );

  const xflBaseName = libraryBasename(xfl.itemName);
  const libraryMatch = info.library.find((entry) => entry.name === xfl.itemName || entry.name === xflBaseName);
  if (libraryMatch && native.has(`Symbol ${libraryMatch.symbolNumber}`)) {
    return { stream: `Symbol ${libraryMatch.symbolNumber}`, reason: `library-name:${libraryMatch.name}` };
  }
  if (libraryMatch) {
    return {
      stream: `Symbol ${libraryMatch.symbolNumber}`,
      reason: `library-missing-stream:${libraryMatch.name}`,
    };
  }

  if (xfl.linkageIdentifier) {
    for (const [num, linkage] of info.linkageBySymbol.entries()) {
      if (xfl.linkageIdentifier !== linkage.identifier) continue;
      const stream = `Symbol ${num}`;
      if (native.has(stream)) return { stream, reason: `linkage:${linkage.identifier}` };
      return { stream, reason: `linkage-missing-stream:${linkage.identifier}` };
    }
  }

  for (const [label, value] of [
    ['sourceFlashFilepath', xfl.sourceFlashFilepath],
    ['sourceLibraryItemHRef', xfl.sourceLibraryItemHRef],
  ] as const) {
    const num = symbolRefNumber(value);
    if (num !== null && symbolNumbers.has(num)) return { stream: `Symbol ${num}`, reason: `${label}:${value}` };
    if (num !== null) return { stream: `Symbol ${num}`, reason: `${label}-missing-stream:${value}` };
  }

  if (xfl.linkageClassName) {
    const classMatches = [...info.linkageBySymbol.entries()].filter(([, linkage]) =>
      linkage.className === xfl.linkageClassName
    );
    if (classMatches.length === 1) {
      const [num, linkage] = classMatches[0];
      const stream = `Symbol ${num}`;
      if (native.has(stream)) return { stream, reason: `linkage-class:${linkage.className}` };
      return { stream, reason: `linkage-class-missing-stream:${linkage.className}` };
    }
  }

  return null;
}

function findMatch(
  xfl: XflTimelineSummary,
  info: BinaryFLAInfo,
  native: Map<string, NativeTimelineSummary>
): { stream: string; reason: string } | null {
  if (xfl.kind === 'document') {
    const pageNum = pageRefNumber(xfl.timelineName) ?? 1;
    const stream = `Page ${pageNum}`;
    if (native.has(stream)) return { stream, reason: `document:${xfl.timelineName}` };
    const firstPage = [...native.keys()].find((name) => name.startsWith('Page '));
    return firstPage ? { stream: firstPage, reason: 'document:first-page' } : null;
  }
  return findSymbolMatch(xfl, info, native);
}

function compareTimeline(xfl: XflTimelineSummary, native?: NativeTimelineSummary): string[] {
  const mismatches: string[] = [];
  if (!native) return ['no native stream match'];
  if (!native.ok) return [`native decode failed: ${native.error ?? 'unknown error'}`];

  if (xfl.layers.length !== native.layers.length) {
    mismatches.push(`layer-count xfl=${xfl.layers.length} native=${native.layers.length}`);
  }

  const layerCount = Math.min(xfl.layers.length, native.layers.length);
  for (let li = 0; li < layerCount; li++) {
    const xl = xfl.layers[li];
    const nl = native.layers[li];
    const prefix = `layer[${li}]`;
    if (xl.name !== nl.name) mismatches.push(`${prefix}.name xfl=${JSON.stringify(xl.name)} native=${JSON.stringify(nl.name)}`);
    if (xl.layerType !== nl.layerType) mismatches.push(`${prefix}.type xfl=${xl.layerType} native=${nl.layerType}`);
    if (xl.visible !== nl.visible) mismatches.push(`${prefix}.visible xfl=${xl.visible} native=${nl.visible}`);
    if (xl.locked !== nl.locked) mismatches.push(`${prefix}.locked xfl=${xl.locked} native=${nl.locked}`);
    if (xl.frames.length !== nl.frames.length) {
      mismatches.push(`${prefix}.frame-count xfl=${xl.frames.length} native=${nl.frames.length}`);
    }

    const frameCount = Math.min(xl.frames.length, nl.frames.length);
    for (let fi = 0; fi < frameCount; fi++) {
      const xf = xl.frames[fi];
      const nf = nl.frames[fi];
      const framePrefix = `${prefix}.frame[${fi}]`;
      if (xf.index !== nf.index) mismatches.push(`${framePrefix}.index xfl=${xf.index} native=${nf.index}`);
      if (xf.duration !== nf.duration) mismatches.push(`${framePrefix}.duration xfl=${xf.duration} native=${nf.duration}`);
      if ((xf.label ?? '') !== (nf.label ?? '')) {
        mismatches.push(`${framePrefix}.label xfl=${JSON.stringify(xf.label ?? '')} native=${JSON.stringify(nf.label ?? '')}`);
      }
      if (xf.elements !== nf.elements) {
        mismatches.push(`${framePrefix}.elements xfl=${xf.elements} native=${nf.elements}`);
      }
    }
  }

  return mismatches;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bytes = new Uint8Array(await readFile(args.fla));
  const info = extractBinaryFLAInfo(bytes);
  const native = summarizeNativeStreams(bytes);
  const xflTimelines = await readXflTimelines(args.xfl);

  const comparisons: TimelineComparison[] = [];
  for (const xfl of xflTimelines) {
    const match = findMatch(xfl, info, native);
    const nativeTimeline = match ? native.get(match.stream) : undefined;
    const missingStream = match !== null && nativeTimeline === undefined;
    const mismatches = missingStream ? [] : compareTimeline(xfl, nativeTimeline);
    const status: TimelineComparison['status'] = !match
      ? 'unmatched'
      : missingStream
        ? 'missing-stream'
      : nativeTimeline?.ok
        ? 'matched'
        : 'native-error';
    comparisons.push({
      xflFile: path.relative(args.xfl, xfl.file),
      xflTimeline: xfl.timelineName,
      stream: match?.stream,
      matchReason: match?.reason,
      status,
      mismatches,
    });
  }

  const filtered = args.onlyMismatches
    ? comparisons.filter((c) => c.status !== 'matched' || c.mismatches.length > 0)
    : comparisons;

  if (args.json) {
    console.log(JSON.stringify({ fla: args.fla, xfl: args.xfl, comparisons: filtered }, null, 2));
    return;
  }

  const matched = comparisons.filter((c) => c.status === 'matched').length;
  const clean = comparisons.filter((c) => c.status === 'matched' && c.mismatches.length === 0).length;
  const unmatched = comparisons.filter((c) => c.status === 'unmatched').length;
  const missingStream = comparisons.filter((c) => c.status === 'missing-stream').length;
  const nativeErrors = comparisons.filter((c) => c.status === 'native-error').length;
  const mismatched = comparisons.filter((c) => c.mismatches.length > 0).length;
  console.log(`XFL timelines: ${comparisons.length}`);
  console.log(
    `Matched: ${matched}, clean: ${clean}, mismatched: ${mismatched}, ` +
    `unmatched: ${unmatched}, missingStream: ${missingStream}, nativeErrors: ${nativeErrors}`
  );

  for (const c of filtered) {
    const label = `${c.xflFile} -> ${c.stream ?? '(unmatched)'}`;
    const suffix = c.matchReason ? ` [${c.matchReason}]` : '';
    if (c.mismatches.length === 0 && c.status === 'matched') {
      console.log(`OK ${label}${suffix}`);
      continue;
    }
    if (c.status === 'missing-stream') {
      console.log(`SKIP ${label}${suffix}`);
      continue;
    }
    console.log(`DIFF ${label}${suffix}`);
    for (const mismatch of c.mismatches.slice(0, 20)) console.log(`  - ${mismatch}`);
    if (c.mismatches.length > 20) console.log(`  ... ${c.mismatches.length - 20} more`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
