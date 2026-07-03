import { readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { extractBinaryFLAInfo } from '../src/binary-fla-parser';
import type { DecodedInstance } from '../src/binary-instance-decoder';

interface Args {
  fla: string;
  xfl: string;
}

interface XflText {
  file: string;
  itemName: string;
  ordinal: number;
  name?: string;
  characters: string;
  attrs: Record<string, string>;
}

interface BinaryText {
  stream: string;
  symbolName: string;
  ordinal: number;
  name?: string;
  characters: string;
  attrs: Record<string, string | number | boolean>;
}

const TEXT_TAGS = ['DOMStaticText', 'DOMDynamicText', 'DOMInputText'];

function usage(): never {
  console.error('Usage: npx tsx scripts/probe-text-attrs.ts <fla> --xfl <xfl-dir>');
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const fla = argv[0];
  if (!fla) usage();
  let xfl = '';
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--xfl') xfl = argv[++i] ?? '';
    else usage();
  }
  if (!xfl) usage();
  return { fla: path.resolve(fla), xfl: path.resolve(xfl) };
}

function attr(tag: string | undefined, name: string): string | undefined {
  return tag?.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    out[match[1]] = match[2];
  }
  return out;
}

function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'g'))].map((m) => m[0]);
}

function openingTag(block: string, tag: string): string {
  return block.match(new RegExp(`<${tag}\\b[^>]*>`))?.[0] ?? '';
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function textContent(block: string, tag: string): string | undefined {
  return block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1];
}

function libraryBasename(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name;
}

async function listXmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase() === 'nul') continue;
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) out.push(full);
    }
  }
  if (statSync(root).isDirectory()) await walk(root);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function parseOwnerName(file: string, xml: string): string {
  const documentTag = xml.match(/<DOMDocument\b[^>]*>/)?.[0];
  const symbolTag = xml.match(/<DOMSymbolItem\b[^>]*>/)?.[0];
  const componentTag = xml.match(/<DOMComponentItem\b[^>]*>/)?.[0];
  const timelineTag = xml.match(/<DOMTimeline\b[^>]*>/)?.[0];
  const ownerTag = symbolTag ?? componentTag ?? documentTag ?? timelineTag ?? '';
  return attr(ownerTag, 'name') ?? attr(timelineTag, 'name') ?? path.basename(file, '.xml');
}

function parseXflTexts(file: string, xml: string): XflText[] {
  const itemName = parseOwnerName(file, xml);
  const out: XflText[] = [];
  for (const tag of TEXT_TAGS) {
    for (const block of blocks(xml, tag)) {
      const textTag = openingTag(block, tag);
      const runBlock = blocks(block, 'DOMTextRun')[0] ?? '';
      const attrsTag = openingTag(runBlock, 'DOMTextAttrs');
      const charsRaw = attr(openingTag(runBlock, 'characters'), 'characters') ?? textContent(runBlock, 'characters') ?? '';
      out.push({
        file,
        itemName,
        ordinal: out.length,
        name: attr(textTag, 'name'),
        characters: decodeXmlText(charsRaw),
        attrs: attrs(attrsTag),
      });
    }
  }
  return out;
}

async function readXflTexts(root: string): Promise<XflText[]> {
  const texts: XflText[] = [];
  for (const file of await listXmlFiles(root)) {
    texts.push(...parseXflTexts(path.relative(root, file), await readFile(file, 'utf8')));
  }
  return texts;
}

function binaryTextAttrs(inst: DecodedInstance): Record<string, string | number | boolean> {
  const td = inst.textData;
  if (!td) return {};
  return {
    ...(td.fontFace !== undefined ? { face: td.fontFace } : {}),
    ...(td.fontSize !== undefined ? { size: td.fontSize } : {}),
    ...(td.fillColor !== undefined ? { fillColor: td.fillColor } : {}),
    ...(td.bold !== undefined ? { bold: td.bold } : {}),
    ...(td.alignment !== undefined ? { alignment: td.alignment } : {}),
    ...(td.letterSpacing !== undefined ? { letterSpacing: td.letterSpacing } : {}),
  };
}

function readBinaryTexts(fla: Uint8Array): BinaryText[] {
  const info = extractBinaryFLAInfo(fla);
  const libraryByNumber = new Map(info.library.map((entry) => [entry.symbolNumber, entry.name]));
  const out: BinaryText[] = [];
  for (const [symbolNumber, insts] of info.symbolInstances.entries()) {
    const symbolName = libraryByNumber.get(symbolNumber) ?? `Symbol ${symbolNumber}`;
    let ordinal = 0;
    for (const inst of insts) {
      if (!inst.textData) continue;
      out.push({
        stream: `Symbol ${symbolNumber}`,
        symbolName,
        ordinal: ordinal++,
        name: inst.instanceName || undefined,
        characters: inst.textData.characters,
        attrs: binaryTextAttrs(inst),
      });
    }
  }
  for (const [pageNumber, insts] of info.sceneInstances.entries()) {
    let ordinal = 0;
    for (const inst of insts) {
      if (!inst.textData) continue;
      out.push({
        stream: `Page ${pageNumber}`,
        symbolName: `Page ${pageNumber}`,
        ordinal: ordinal++,
        name: inst.instanceName || undefined,
        characters: inst.textData.characters,
        attrs: binaryTextAttrs(inst),
      });
    }
  }
  return out;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeAttrValue(name: string, value: string | number | boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number(value.toFixed(4)).toString();
  if (/^(?:size|letterSpacing|lineSpacing|indent|alpha|bitmapSize)$/.test(name)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Number(numeric.toFixed(4)).toString();
  }
  if (/color/i.test(name)) return String(value).toUpperCase();
  return String(value);
}

function sameItem(xfl: XflText, binary: BinaryText): boolean {
  const itemBase = libraryBasename(xfl.itemName);
  return binary.symbolName === xfl.itemName || libraryBasename(binary.symbolName) === itemBase;
}

function matchBinaryText(xfl: XflText, binary: BinaryText[]): { match: BinaryText; reason: string } | undefined {
  const chars = normalizeText(xfl.characters);
  const symbolNameText = binary.find((b) =>
    sameItem(xfl, b) &&
    (xfl.name ? b.name === xfl.name : true) &&
    normalizeText(b.characters) === chars
  );
  if (symbolNameText) return { match: symbolNameText, reason: 'symbol/name/text' };
  const symbolText = binary.find((b) =>
    sameItem(xfl, b) &&
    normalizeText(b.characters) === chars
  );
  if (symbolText) return { match: symbolText, reason: 'symbol/text' };
  const symbolName = binary.find((b) => sameItem(xfl, b) && xfl.name && b.name === xfl.name);
  if (symbolName) return { match: symbolName, reason: 'symbol/name' };
  const symbolOrdinal = binary.find((b) => sameItem(xfl, b) && b.ordinal === xfl.ordinal);
  if (symbolOrdinal) return { match: symbolOrdinal, reason: 'symbol/ordinal' };
  const nameText = binary.find((b) =>
    (xfl.name ? b.name === xfl.name : true) &&
    normalizeText(b.characters) === chars
  );
  if (nameText) return { match: nameText, reason: 'name/text' };
  const text = binary.find((b) =>
    normalizeText(b.characters) === chars
  );
  if (text) return { match: text, reason: 'text' };
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const xflTexts = await readXflTexts(args.xfl);
  const binaryTexts = readBinaryTexts(new Uint8Array(await readFile(args.fla)));
  const attrStats = new Map<string, Map<string, number>>();
  const mismatches = new Map<string, number>();
  const reasons = new Map<string, number>();
  let matched = 0;

  for (const xfl of xflTexts) {
    const matchedBinary = matchBinaryText(xfl, binaryTexts);
    const binary = matchedBinary?.match;
    if (matchedBinary) {
      matched += 1;
      reasons.set(matchedBinary.reason, (reasons.get(matchedBinary.reason) ?? 0) + 1);
    }
    for (const [name, value] of Object.entries(xfl.attrs)) {
      let values = attrStats.get(name);
      if (!values) {
        values = new Map();
        attrStats.set(name, values);
      }
      values.set(value, (values.get(value) ?? 0) + 1);
      if (binary) {
        const b = normalizeAttrValue(name, binary.attrs[name]);
        const x = normalizeAttrValue(name, value);
        if (b !== undefined && b !== x) {
          mismatches.set(name, (mismatches.get(name) ?? 0) + 1);
        }
      }
    }
  }

  console.log(`# CPicText / XFL DOMTextAttrs probe`);
  console.log(`XFL texts: ${xflTexts.length}`);
  console.log(`Binary CPicText: ${binaryTexts.length}`);
  console.log(`Matched: ${matched}`);
  console.log(`Match reasons: ${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log('');
  console.log('| Attr | Values | Binary mismatches when parsed |');
  console.log('|---|---:|---:|');
  for (const [name, values] of [...attrStats.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const renderedValues = [...values.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([value, count]) => `${JSON.stringify(value)}:${count}`)
      .join(', ');
    console.log(`| \`${name}\` | ${renderedValues} | ${mismatches.get(name) ?? 0} |`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
