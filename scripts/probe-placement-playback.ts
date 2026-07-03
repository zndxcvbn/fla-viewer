import { readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { CArchiveReader, scanCArchiveObjectStarts } from '../src/binary-carchive';
import type { CArchiveObjectHeader } from '../src/binary-carchive';
import { readCPicPlacement } from '../src/binary-cpic-placement';
import { readCPicObjLeafBase } from '../src/binary-cpic-object';
import { extractBinaryFLAInfo } from '../src/binary-fla-parser';
import { OLE2File } from '../src/ole2-reader';

interface Pair {
  fla: string;
  xfl: string;
  name: string;
}

interface XflPlacement {
  file: string;
  tag: 'DOMSymbolInstance' | 'DOMComponentInstance';
  libraryItemName: string;
  name: string;
  symbolType: string;
  loop: string;
  firstFrame?: number;
  lastFrame?: number;
  centerPoint3DX?: number;
  centerPoint3DY?: number;
  transformationPoint?: { x: number; y: number };
}

interface BinaryPlacementProbe {
  stream: string;
  className: string;
  bodyStart: number;
  baseSchema: number;
  baseFlags: number;
  registrationPoint?: { x: number; y: number };
  symbolSchema: number;
  matrixTx: number;
  matrixTy: number;
  fieldB0: number;
  fieldCc: number;
  marker: number;
  words: number[];
  instanceName: string;
  mediaRef?: number;
  markerTarget?: number;
  libraryName?: string;
  tailHex: string;
}

const INSTANCE_CLASSES = new Set(['CPicSprite', 'CPicShapeObj', 'CPicButton']);
const TWIPS_PER_PX = 20;
const MAX_NAME_LEN = 0x40;
const FIXTURE_ROOT = path.resolve('src/__tests__/fixtures');

const defaultPairs: Pair[] = [
  ['itemcard', 'cs4/itemcard.fla', 'cs6/itemcard'],
  ['inventorylists', 'cs4/inventorylists.fla', 'cs6/inventorylists'],
  ['favoritesmenu', 'cs4/favoritesmenu.fla', 'cs6/favoritesmenu'],
  ['magicmenu', 'cs4/magicmenu.fla', 'cs6/magicmenu'],
  ['map', 'cs4/map.fla', 'cs6/map'],
  ['configpanel', 'cs4/configpanel.fla', 'cs6/configpanel'],
].map(([name, fla, xfl]) => ({
  name,
  fla: path.join(FIXTURE_ROOT, fla),
  xfl: path.join(FIXTURE_ROOT, xfl),
}));

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function numberAttr(tag: string, name: string): number | undefined {
  const raw = attr(tag, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'g'))].map((m) => m[0]);
}

function openingTag(block: string, tag: string): string {
  return block.match(new RegExp(`<${tag}\\b[^>]*>`))?.[0] ?? '';
}

function parseTransformationPoint(block: string): { x: number; y: number } | undefined {
  const point = block.match(/<transformationPoint>\s*<Point\b([^>]*)\/>\s*<\/transformationPoint>/);
  if (!point) return undefined;
  return {
    x: numberAttr(point[1], 'x') ?? 0,
    y: numberAttr(point[1], 'y') ?? 0,
  };
}

async function listXmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) out.push(full);
    }
  }
  await walk(root);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function readXflPlacements(root: string): Promise<XflPlacement[]> {
  const placements: XflPlacement[] = [];
  for (const file of await listXmlFiles(root)) {
    const xml = await readFile(file, 'utf8');
    for (const tagName of ['DOMSymbolInstance', 'DOMComponentInstance'] as const) {
      for (const block of blocks(xml, tagName)) {
        const tag = openingTag(block, tagName);
        placements.push({
          file: path.relative(root, file),
          tag: tagName,
          libraryItemName: attr(tag, 'libraryItemName') ?? '',
          name: attr(tag, 'name') ?? '',
          symbolType: attr(tag, 'symbolType') ?? (tagName === 'DOMComponentInstance' ? 'movieclip' : 'graphic'),
          loop: attr(tag, 'loop') ?? 'loop',
          firstFrame: numberAttr(tag, 'firstFrame'),
          lastFrame: numberAttr(tag, 'lastFrame'),
          centerPoint3DX: numberAttr(tag, 'centerPoint3DX'),
          centerPoint3DY: numberAttr(tag, 'centerPoint3DY'),
          transformationPoint: parseTransformationPoint(block),
        });
      }
    }
  }
  return placements;
}

function readU16(data: Uint8Array, pos: number): number {
  return data[pos] | (data[pos + 1] << 8);
}

function readS32(data: Uint8Array, pos: number): number {
  return data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24);
}

function readU32(data: Uint8Array, pos: number): number {
  return (data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] * 0x1000000)) >>> 0;
}

function hex(data: Uint8Array, start: number, length: number): string {
  return [...data.slice(start, Math.min(data.length, start + length))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function findMarkerTarget(data: Uint8Array, start: number, end: number): number | undefined {
  const limit = Math.min(data.length - 9, end);
  for (let p = start; p <= limit; p++) {
    if (
      data[p] === 0xff &&
      data[p + 1] === 0xff &&
      data[p + 2] === 0xfe &&
      data[p + 3] === 0xff &&
      data[p + 4] === 0x00
    ) {
      const target = readU32(data, p + 5);
      if (target > 0 && target < 10000) return target;
    }
  }
  return undefined;
}

function readBinaryPlacement(
  data: Uint8Array,
  stream: string,
  bodyStart: number,
  className: string,
  libraryByNumber: Map<number, string>
): BinaryPlacementProbe | null {
  try {
    const header: CArchiveObjectHeader = {
      tagStart: Math.max(0, bodyStart - 2),
      bodyStart,
      className,
      referenceKind: 'class_backref',
    };
    const placement = readCPicPlacement(new CArchiveReader(data, bodyStart), header);
    if (!placement) return null;

    const reader = new CArchiveReader(data, bodyStart);
    const base = readCPicObjLeafBase(reader);
    const symbolSchema = reader.readU8();
    let pos = reader.pos;
    if (pos + 24 + 11 > data.length) return null;

    pos += 16;
    const matrixTx = readS32(data, pos) / TWIPS_PER_PX;
    pos += 4;
    const matrixTy = readS32(data, pos) / TWIPS_PER_PX;
    pos += 4;

    const fieldB0 = readU16(data, pos); pos += 2;
    const fieldCc = readU16(data, pos); pos += 2;
    const marker = data[pos++];
    const words = [readU16(data, pos), readU16(data, pos + 2), readU16(data, pos + 4), readU16(data, pos + 6)];
    pos += 8;

    const nameLen = data[pos++];
    let instanceName = '';
    let directMediaRef: number | undefined;
    if (nameLen <= MAX_NAME_LEN && pos + nameLen + 4 <= data.length) {
      let validName = true;
      for (let i = 0; i < nameLen; i++) {
        const ch = data[pos++];
        if (ch < 9) validName = false;
        instanceName += String.fromCharCode(ch);
      }
      if (validName) {
        const ref = readU32(data, pos);
        pos += 4;
        if (ref > 0 && ref < 10000) directMediaRef = ref;
      }
    }
    const markerTarget = findMarkerTarget(data, pos, bodyStart + 220);

    return {
      stream,
      className,
      bodyStart,
      baseSchema: base.schema,
      baseFlags: base.flags,
      registrationPoint: base.registrationPoint,
      symbolSchema,
      matrixTx: placement.matrix.tx,
      matrixTy: placement.matrix.ty,
      fieldB0,
      fieldCc,
      marker,
      words,
      instanceName: placement.instanceName || instanceName,
      mediaRef: placement.mediaRef || directMediaRef,
      markerTarget,
      libraryName: libraryByNumber.get(placement.mediaRef || directMediaRef || 0),
      tailHex: hex(data, pos, 32),
    };
  } catch {
    return null;
  }
}

async function readBinaryPlacements(fla: string): Promise<BinaryPlacementProbe[]> {
  const bytes = new Uint8Array(await readFile(fla));
  const info = extractBinaryFLAInfo(bytes);
  const libraryByNumber = new Map<number, string>();
  for (const entry of info.library) {
    libraryByNumber.set(entry.symbolNumber, entry.name);
    if (entry.placementId !== undefined) libraryByNumber.set(entry.placementId, entry.name);
  }
  const ole = new OLE2File(bytes);
  const placements: BinaryPlacementProbe[] = [];
  for (const entry of ole.listStreams()) {
    if (!/^(Page|Symbol) \d+$/.test(entry.name)) continue;
    const data = ole.readStream(entry.name);
    for (const start of scanCArchiveObjectStarts(data, INSTANCE_CLASSES)) {
      const placement = readBinaryPlacement(data, entry.name, start.bodyStart, start.className, libraryByNumber);
      if (placement) placements.push(placement);
    }
  }
  return placements;
}

function inc(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function printCountMap(title: string, map: Map<string, number>): void {
  console.log(title);
  for (const [key, count] of [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${key}: ${count}`);
  }
}

function keyFor(libraryName: string, instanceName: string): string {
  return `${libraryLeafName(libraryName)}\u0000${instanceName}`;
}

function libraryLeafName(libraryName: string): string {
  const normalized = libraryName.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function placementSignature(p: BinaryPlacementProbe): string {
  return `${p.className} schema=${p.symbolSchema} fixed=${p.fieldB0}/${p.fieldCc}/${p.marker}/${p.words.join(',')}`;
}

function summarizePair(pair: Pair, xfl: XflPlacement[], binary: BinaryPlacementProbe[]): void {
  const loops = new Map<string, number>();
  const fields = new Map<string, number>();
  const xflByKey = new Map<string, XflPlacement[]>();
  for (const p of xfl) {
    inc(loops, p.loop);
    const key = keyFor(p.libraryItemName, p.name);
    const list = xflByKey.get(key) ?? [];
    list.push(p);
    xflByKey.set(key, list);
  }

  let centerPoints = 0;
  let transformPoints = 0;
  let frameRanges = 0;
  for (const p of xfl) {
    if (p.centerPoint3DX !== undefined || p.centerPoint3DY !== undefined) centerPoints++;
    if (p.transformationPoint) transformPoints++;
    if (p.firstFrame !== undefined || p.lastFrame !== undefined) frameRanges++;
  }

  const matchedByLoop = new Map<string, number>();
  const matchedSignaturesByLoop = new Map<string, number>();
  const matchedCenters = new Map<string, number>();
  const matchedTransformPoints = new Map<string, number>();
  const matchedRegistrationPoints = new Map<string, number>();
  const unmatched: BinaryPlacementProbe[] = [];
  for (const p of binary) {
    const signature = placementSignature(p);
    inc(fields, signature);
    const candidates = xflByKey.get(keyFor(p.libraryName ?? '', p.instanceName));
    if (candidates?.length) {
      const loop = candidates[0].loop;
      inc(matchedByLoop, loop);
      inc(matchedSignaturesByLoop, `${loop} <= ${signature}`);
      const centerKey = candidates[0].centerPoint3DX !== undefined || candidates[0].centerPoint3DY !== undefined
        ? `${candidates[0].centerPoint3DX ?? 0},${candidates[0].centerPoint3DY ?? 0}`
        : '(none)';
      const tp = candidates[0].transformationPoint;
      const tpKey = tp ? `${tp.x},${tp.y}` : '(none)';
      const reg = p.registrationPoint;
      inc(matchedCenters, centerKey);
      inc(matchedTransformPoints, tpKey);
      inc(matchedRegistrationPoints, reg ? `${reg.x},${reg.y}` : '(none)');
    } else {
      unmatched.push(p);
    }
  }

  console.log(`\n## ${pair.name}`);
  console.log(`FLA: ${pair.fla}`);
  console.log(`XFL: ${pair.xfl}`);
  console.log(`XFL placements: ${xfl.length}; binary placement probes: ${binary.length}`);
  console.log(`XFL centerPoint3D attrs: ${centerPoints}; transformationPoint nodes: ${transformPoints}; first/lastFrame attrs: ${frameRanges}`);
  printCountMap('XFL loop values:', loops);
  printCountMap('Binary fixed-field signatures:', fields);
  printCountMap('Name+library matched binary placements by XFL loop:', matchedByLoop);
  printCountMap('Matched fixed-field signatures by XFL loop:', matchedSignaturesByLoop);
  printCountMap('Matched XFL centerPoint3D values:', matchedCenters);
  printCountMap('Matched XFL transformationPoint values:', matchedTransformPoints);
  printCountMap('Matched binary CPicObj registrationPoint values:', matchedRegistrationPoints);

  const samples = binary
    .filter((p) => p.instanceName || p.libraryName)
    .slice(0, 12);
  console.log('Binary samples:');
  for (const p of samples) {
    console.log(
      `  ${p.stream} @0x${p.bodyStart.toString(16)} ${p.className} ref=${p.mediaRef ?? '-'} lib="${p.libraryName ?? ''}" ` +
      `markerTarget=${p.markerTarget ?? '-'} name="${p.instanceName}" reg=${p.registrationPoint ? `${p.registrationPoint.x},${p.registrationPoint.y}` : '-'} ` +
      `schema=${p.symbolSchema} fixed=${p.fieldB0}/${p.fieldCc}/${p.marker}/${p.words.join(',')} tail=${p.tailHex}`
    );
  }
  if (unmatched.length) console.log(`Unmatched by exact library+name: ${unmatched.length}`);
}

function parsePairs(argv: string[]): Pair[] {
  if (argv.length === 0) {
    return defaultPairs.filter((pair) => existsSync(pair.fla) && existsSync(pair.xfl) && statSync(pair.xfl).isDirectory());
  }
  const pairs: Pair[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--pair') {
      throw new Error('Usage: npx tsx scripts/probe-placement-playback.ts [--pair <fla> <xfl>]...');
    }
    const fla = argv[++i];
    const xfl = argv[++i];
    if (!fla || !xfl) throw new Error('Missing --pair arguments');
    pairs.push({ name: path.basename(fla, '.fla'), fla: path.resolve(fla), xfl: path.resolve(xfl) });
  }
  return pairs;
}

async function main(): Promise<void> {
  const pairs = parsePairs(process.argv.slice(2));
  console.log('# Placement Playback / Center Probe');
  console.log(`Pairs: ${pairs.length}`);
  for (const pair of pairs) {
    const [xfl, binary] = await Promise.all([
      readXflPlacements(pair.xfl),
      readBinaryPlacements(pair.fla),
    ]);
    summarizePair(pair, xfl, binary);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
