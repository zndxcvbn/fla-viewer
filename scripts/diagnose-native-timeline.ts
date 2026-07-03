import { readFile, readdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { OLE2File } from '../src/ole2-reader';
import { decodeStreamTimeline } from '../src/binary-timeline-decoder';
import {
  decodeNativeTimelineTreeDetailed,
  nativeFrameCount,
  nativeLabelCount,
  nativeLayerNames,
  nativeTotalFrames,
} from '../src/binary-native-timeline';

interface StreamReport {
  file: string;
  stream: string;
  recoveryLayers: number;
  recoveryFrames: number;
  recoveryTotalFrames: number;
  nativeOk: boolean;
  nativeLayers: number;
  nativeFrames: number;
  nativeTotalFrames: number;
  nativeLabels: number;
  error?: string;
}

interface XflTimelineSummary {
  file: string;
  layers: number;
  frames: number;
  layerNames: string[];
}

function usage(): never {
  console.error(
    [
      'Usage:',
      '  npx tsx scripts/diagnose-native-timeline.ts <file-or-dir> [--xfl <xfl-dir>] [--limit N] [--json]',
      '',
      'Examples:',
      '  npx tsx scripts/diagnose-native-timeline.ts src\\__tests__\\fixtures\\cs4\\itemcard.fla --xfl src\\__tests__\\fixtures\\cs6\\itemcard',
      '  npx tsx scripts/diagnose-native-timeline.ts src\\__tests__\\fixtures\\cs4 --limit 5',
    ].join('\n')
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { target: string; xfl?: string; limit?: number; json: boolean } {
  const target = argv[0];
  if (!target) usage();

  let xfl: string | undefined;
  let limit: number | undefined;
  let json = false;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--xfl') {
      xfl = argv[++i];
      if (!xfl) usage();
    } else if (arg === '--limit') {
      const raw = argv[++i];
      if (!raw) usage();
      limit = Number(raw);
      if (!Number.isFinite(limit) || limit < 1) usage();
    } else if (arg === '--json') {
      json = true;
    } else {
      usage();
    }
  }

  return { target, xfl, limit, json };
}

async function findFlaFiles(target: string, limit?: number): Promise<string[]> {
  const full = path.resolve(target);
  const st = statSync(full);
  if (st.isFile()) return [full];

  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (limit && out.length >= limit) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (limit && out.length >= limit) break;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.fla')) out.push(p);
    }
  }

  await walk(full);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function countRecoveryFrames(timeline: ReturnType<typeof decodeStreamTimeline>): {
  layers: number;
  frames: number;
  totalFrames: number;
} {
  if (!timeline) return { layers: 0, frames: 0, totalFrames: 0 };
  let frames = 0;
  for (const layer of timeline.layers) frames += layer.keyframes.length;
  return {
    layers: timeline.layers.length,
    frames,
    totalFrames: timeline.totalFrames,
  };
}

async function analyzeFla(file: string): Promise<StreamReport[]> {
  const bytes = new Uint8Array(await readFile(file));
  const ole = new OLE2File(bytes);
  const streams = ole
    .listStreams()
    .map((entry) => entry.name)
    .filter((name) => /^(Page|Symbol) \d+$/.test(name))
    .sort(compareStreamNames);

  const reports: StreamReport[] = [];
  for (const stream of streams) {
    const data = ole.readStream(stream);
    const recovery = countRecoveryFrames(decodeStreamTimeline(data));
    const native = decodeNativeTimelineTreeDetailed(data);
    const page = native.page;

    reports.push({
      file,
      stream,
      recoveryLayers: recovery.layers,
      recoveryFrames: recovery.frames,
      recoveryTotalFrames: recovery.totalFrames,
      nativeOk: native.ok,
      nativeLayers: page ? page.layers.length : 0,
      nativeFrames: page ? nativeFrameCount(page) : 0,
      nativeTotalFrames: page ? nativeTotalFrames(page) : 0,
      nativeLabels: page ? nativeLabelCount(page) : 0,
      error: native.error,
    });
  }
  return reports;
}

function compareStreamNames(a: string, b: string): number {
  const ap = a.startsWith('Page') ? 0 : 1;
  const bp = b.startsWith('Page') ? 0 : 1;
  if (ap !== bp) return ap - bp;
  const an = Number(a.split(' ')[1] ?? 0);
  const bn = Number(b.split(' ')[1] ?? 0);
  return an - bn;
}

async function readText(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

function attr(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1];
}

async function summarizeXflTimeline(file: string): Promise<XflTimelineSummary> {
  const xml = await readText(file);
  const layerTags = [...xml.matchAll(/<DOMLayer\b[^>]*>/g)].map((m) => m[0]);
  const frameCount = (xml.match(/<DOMFrame\b/g) ?? []).length;
  return {
    file,
    layers: layerTags.length,
    frames: frameCount,
    layerNames: layerTags.map((tag) => attr(tag, 'name') ?? ''),
  };
}

async function summarizeXflDir(dir: string): Promise<XflTimelineSummary[]> {
  const root = path.resolve(dir);
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) files.push(p);
    }
  }
  await walk(root);
  files.sort((a, b) => a.localeCompare(b));

  const summaries: XflTimelineSummary[] = [];
  for (const file of files) {
    const summary = await summarizeXflTimeline(file);
    if (summary.layers > 0 || summary.frames > 0) summaries.push(summary);
  }
  return summaries;
}

function printHuman(reports: StreamReport[], xfl?: XflTimelineSummary[]): void {
  const totalStreams = reports.length;
  const nativeOk = reports.filter((r) => r.nativeOk).length;
  const recoveryOk = reports.filter((r) => r.recoveryLayers > 0 || r.recoveryFrames > 0).length;
  console.log(`FLA streams: ${totalStreams}`);
  console.log(`Recovery timelines: ${recoveryOk}`);
  console.log(`Native timelines: ${nativeOk}`);

  const errorCounts = new Map<string, number>();
  for (const report of reports) {
    if (!report.error) continue;
    const key = report.error.replace(/0x[0-9a-f]+/gi, '0x...');
    errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
  }
  const commonErrors = [...errorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([error, count]) => ({ count, error }));
  if (commonErrors.length > 0) {
    console.log('\nNative error groups:');
    console.table(commonErrors);
  }

  const successful = reports
    .filter((r) => r.nativeOk)
    .slice(0, 20)
    .map((r) => ({
      file: path.basename(r.file),
      stream: r.stream,
      recoveryLayers: r.recoveryLayers,
      nativeLayers: r.nativeLayers,
      recoveryFrames: r.recoveryFrames,
      nativeFrames: r.nativeFrames,
      nativeTotalFrames: r.nativeTotalFrames,
    }));
  if (successful.length > 0) {
    console.log('\nNative successes:');
    console.table(successful);
  }

  const failures = reports
    .filter((r) => !r.nativeOk)
    .slice(0, 20)
    .map((r) => ({
      file: path.basename(r.file),
      stream: r.stream,
      recoveryLayers: r.recoveryLayers,
      recoveryFrames: r.recoveryFrames,
      error: r.error,
    }));
  if (failures.length > 0) {
    console.log('\nNative first failures:');
    console.table(failures);
  }

  if (xfl && xfl.length > 0) {
    const symbol2 = reports.find((r) => /itemcard\.fla$/i.test(r.file) && r.stream === 'Symbol 2');
    const itemCard = xfl.find((s) => /LIBRARY[\\/]+Sprites[\\/]+ItemCard\.xml$/i.test(s.file));
    if (symbol2 && itemCard) {
      console.log('\nItemCard baseline:');
      console.table([
        {
          source: 'binary itemcard.fla Symbol 2 recovery',
          layers: symbol2.recoveryLayers,
          frames: symbol2.recoveryFrames,
          totalFrames: symbol2.recoveryTotalFrames,
        },
        {
          source: 'binary itemcard.fla Symbol 2 native',
          layers: symbol2.nativeLayers,
          frames: symbol2.nativeFrames,
          totalFrames: symbol2.nativeTotalFrames,
          error: symbol2.error,
        },
        {
          source: 'XFL LIBRARY/Sprites/ItemCard.xml',
          layers: itemCard.layers,
          frames: itemCard.frames,
          totalFrames: '',
        },
      ]);
    }

    console.log('\nXFL timelines:');
    console.table(
      xfl
        .filter((s) => /ItemCard\.xml$|DOMDocument\.xml$/i.test(s.file))
        .concat(xfl.filter((s) => !/ItemCard\.xml$|DOMDocument\.xml$/i.test(s.file)).slice(0, 8))
        .map((s) => ({
          file: path.relative(process.cwd(), s.file),
          layers: s.layers,
          frames: s.frames,
          firstLayers: s.layerNames.slice(0, 5).join(' | '),
        }))
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const files = await findFlaFiles(args.target, args.limit);
  const reports = (await Promise.all(files.map(analyzeFla))).flat();
  const xfl = args.xfl ? await summarizeXflDir(args.xfl) : undefined;

  if (args.json) {
    console.log(JSON.stringify({ reports, xfl }, null, 2));
  } else {
    printHuman(reports, xfl);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
