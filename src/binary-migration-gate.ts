import { decodeStreamTimeline } from './binary-timeline-decoder';
import { decodeStreamShapes, type DecodedShape } from './binary-shape-decoder';
import { OLE2File } from './ole2-reader';
import {
  scanForInstances,
  correctFp8Refs,
  attachInstanceNames,
  markUnreliableRefs,
  dedupeInstances,
  scanNamedInstances,
  type DecodedInstance,
} from './binary-instance-decoder';
import {
  decodeNativeTimelineTreeDetailed,
  extractNativeInstances,
  extractNativeShapes,
  nativeTotalFrames,
} from './binary-native-timeline';
import { extractFrameLabelsAll, type DecodedFrameLabel } from './binary-timeline-decoder';

export interface StreamComparison {
  streamName: string;
  nativeOk: boolean;
  nativeError?: string;
  metrics: {
    totalFrames: { native: number; heuristic: number };
    layers: { native: number; heuristic: number };
    instances: { native: number; heuristic: number };
    shapes: { native: number; heuristic: number };
    frameLabels: { native: number; heuristic: number };
  };
  diffs: string[];
}

export interface FLAMigrationReport {
  totalStreams: number;
  nativeFailures: number;
  streamsWithDiffs: number;
  streams: StreamComparison[];
}

function summarizeInstances(insts: DecodedInstance[]): string[] {
  return insts.map(
    (i) => `${i.className}#${i.mediaRef}@${i.bodyStart}${i.instanceName ? `("${i.instanceName}")` : ''}`
  );
}

function summarizeShapes(shapes: DecodedShape[]): string[] {
  return shapes.map((s) => `shape@${s.bodyStart}-${s.endPos}(${s.edgeCount}edges)`);
}

function compareInstances(a: DecodedInstance[], b: DecodedInstance[]): string[] {
  const diffs: string[] = [];
  if (a.length !== b.length) {
    diffs.push(`instance count: native=${a.length}, heuristic=${b.length}`);
  }
  const aSummary = summarizeInstances(a);
  const bSummary = summarizeInstances(b);
  const aOnly = aSummary.filter((s) => !bSummary.includes(s));
  const bOnly = bSummary.filter((s) => !aSummary.includes(s));
  if (aOnly.length > 0) diffs.push(`instances only in native: ${aOnly.join(', ')}`);
  if (bOnly.length > 0) diffs.push(`instances only in heuristic: ${bOnly.join(', ')}`);
  return diffs;
}

function compareShapes(a: DecodedShape[], b: DecodedShape[]): string[] {
  const diffs: string[] = [];
  if (a.length !== b.length) {
    diffs.push(`shape count: native=${a.length}, heuristic=${b.length}`);
  }
  const aSummary = summarizeShapes(a);
  const bSummary = summarizeShapes(b);
  const aOnly = aSummary.filter((s) => !bSummary.includes(s));
  const bOnly = bSummary.filter((s) => !aSummary.includes(s));
  if (aOnly.length > 0) diffs.push(`shapes only in native: ${aOnly.join(', ')}`);
  if (bOnly.length > 0) diffs.push(`shapes only in heuristic: ${bOnly.join(', ')}`);
  return diffs;
}

export function compareStreamPipelines(
  data: Uint8Array,
  streamName: string,
  symbolNumbers?: Set<number>,
  placementIdToStream?: Map<number, number>
): StreamComparison {
  const diffs: string[] = [];

  const nativeResult = decodeNativeTimelineTreeDetailed(data);
  const nativeOk = nativeResult.ok && nativeResult.page !== null;
  const page = nativeResult.page;

  const heuristicTl = decodeStreamTimeline(data);

  // Heuristic metrics
  const heuristicTotalFrames = heuristicTl?.totalFrames ?? 0;
  const heuristicLayerCount = heuristicTl?.layers.length ?? 0;
  const named = scanNamedInstances(data);
  const heuristicInsts = dedupeInstances(
    markUnreliableRefs(
      attachInstanceNames(
        correctFp8Refs(scanForInstances(data), symbolNumbers ?? new Set(), placementIdToStream),
        named
      )
    )
  );
  const heuristicShapes = decodeStreamShapes(data).decoded;
  const heuristicLabels = extractFrameLabelsAll(data);

  // Native metrics
  let nativeTotalFramesVal = 0;
  let nativeLayerCount = 0;
  let nativeInsts: DecodedInstance[] = [];
  let nativeShapes: DecodedShape[] = [];
  let nativeLabels: DecodedFrameLabel[] = [];

  if (nativeOk && page) {
    nativeTotalFramesVal = nativeTotalFrames(page);
    nativeLayerCount = page.layers.length;
    nativeInsts = extractNativeInstances(page);
    nativeShapes = extractNativeShapes(page);
    nativeLabels = extractFrameLabelsAll(data);
  }

  const metrics = {
    totalFrames: { native: nativeTotalFramesVal, heuristic: heuristicTotalFrames },
    layers: { native: nativeLayerCount, heuristic: heuristicLayerCount },
    instances: { native: nativeInsts.length, heuristic: heuristicInsts.length },
    shapes: { native: nativeShapes.length, heuristic: heuristicShapes.length },
    frameLabels: { native: nativeLabels.length, heuristic: heuristicLabels.length },
  };

  if (!nativeOk) {
    diffs.push(`native walk failed${nativeResult.error ? ': ' + nativeResult.error : ''}`);
    return { streamName, nativeOk, nativeError: nativeResult.error, metrics, diffs };
  }

  if (metrics.totalFrames.native !== metrics.totalFrames.heuristic) {
    diffs.push(
      `totalFrames: native=${metrics.totalFrames.native}, heuristic=${metrics.totalFrames.heuristic}`
    );
  }

  if (metrics.layers.native !== metrics.layers.heuristic) {
    diffs.push(
      `layer count: native=${metrics.layers.native}, heuristic=${metrics.layers.heuristic}`
    );
  }

  diffs.push(...compareInstances(nativeInsts, heuristicInsts));
  diffs.push(...compareShapes(nativeShapes, heuristicShapes));

  if (metrics.frameLabels.native !== metrics.frameLabels.heuristic) {
    diffs.push(
      `frame label count: native=${metrics.frameLabels.native}, heuristic=${metrics.frameLabels.heuristic}`
    );
  }

  return { streamName, nativeOk, metrics, diffs };
}

export function compareWholeFLA(data: Uint8Array): FLAMigrationReport {
  const ole = new OLE2File(data);
  const streams = ole.listStreams();

  const symbolNumbers = new Set<number>();
  for (const s of streams) {
    const m = s.name.match(/^(?:Symbol|S)\s+(\d+)/i);
    if (m) symbolNumbers.add(parseInt(m[1], 10));
  }

  const streamComparisons: StreamComparison[] = [];
  let nativeFailures = 0;
  let streamsWithDiffs = 0;

  for (const stream of streams) {
    const streamData = ole.readStream(stream.name);
    const comparison = compareStreamPipelines(streamData, stream.name, symbolNumbers);
    streamComparisons.push(comparison);
    if (!comparison.nativeOk) nativeFailures++;
    if (comparison.diffs.length > 0) streamsWithDiffs++;
  }

  return { totalStreams: streams.length, nativeFailures, streamsWithDiffs, streams: streamComparisons };
}
