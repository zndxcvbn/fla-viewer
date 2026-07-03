import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseBinaryFLA } from '../src/binary-fla-parser';
import type {
  DisplayElement,
  FLADocument,
  Frame,
  Layer,
  Symbol as FlaSymbol,
  Timeline,
} from '../src/types';

type Format = 'json' | 'tree' | 'txt';

interface Args {
  fla: string;
  out?: string;
  format: Format;
  symbol?: string;
}

const DEFAULT_FLA = path.resolve('src/__tests__/fixtures/cs4/itemcard.fla');

function usage(): never {
  console.error([
    'Usage:',
    '  bun scripts/dump-parsed-binary-fla-tree.ts [fla] [--format json|tree|txt] [--symbol <name>] [--out <file>]',
    '',
    'Examples:',
    '  bun scripts/dump-parsed-binary-fla-tree.ts',
    '  bun scripts/dump-parsed-binary-fla-tree.ts --format txt --symbol ItemCard',
    '  bun scripts/dump-parsed-binary-fla-tree.ts --format tree --symbol ItemCard',
    '  bun scripts/dump-parsed-binary-fla-tree.ts --out itemcard.parsed.json',
  ].join('\n'));
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  let fla = DEFAULT_FLA;
  let out: string | undefined;
  let format: Format = 'json';
  let symbol: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[++i];
      if (!out) usage();
    } else if (arg === '--format') {
      const raw = argv[++i];
      if (raw !== 'json' && raw !== 'tree' && raw !== 'txt') usage();
      format = raw;
    } else if (arg === '--symbol') {
      symbol = argv[++i];
      if (!symbol) usage();
    } else if (arg.startsWith('--')) {
      usage();
    } else {
      fla = arg;
    }
  }

  return {
    fla: path.resolve(fla),
    ...(out ? { out: path.resolve(out) } : {}),
    format,
    ...(symbol ? { symbol } : {}),
  };
}

function sortedObject<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const field = value[key];
    if (field !== undefined) out[key] = field;
  }
  return out as T;
}

function serialize(value: unknown): unknown {
  if (value instanceof Map) {
    return [...value.entries()].map(([key, entry]) => ({ key, value: serialize(entry) }));
  }
  if (value instanceof Set) {
    return [...value.values()].map(serialize);
  }
  if (Array.isArray(value)) {
    return value.map(serialize);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = serialize(entry);
    }
    return out;
  }
  return value;
}

function elementKind(element: DisplayElement): string {
  if (element.type === 'symbol') {
    return `${element.type}:${element.libraryItemName}${element.name ? `#${element.name}` : ''}`;
  }
  if (element.type === 'text') {
    return `${element.type}${element.name ? `#${element.name}` : ''}`;
  }
  if (element.type === 'bitmap') {
    return `${element.type}:${element.libraryItemName}`;
  }
  if (element.type === 'video') {
    return `${element.type}:${element.libraryItemName}`;
  }
  return element.type;
}

function summarizeElement(element: DisplayElement): Record<string, unknown> {
  if (element.type === 'shape') {
    return sortedObject({
      type: element.type,
      matrix: element.matrix,
      fills: element.fills.length,
      strokes: element.strokes.length,
      edges: element.edges.length,
      fillStyles: element.fills,
      strokeStyles: element.strokes,
      edgeData: element.edges,
    });
  }
  return sortedObject(serialize(element) as Record<string, unknown>);
}

function frameToTree(frame: Frame): Record<string, unknown> {
  return sortedObject({
    index: frame.index,
    duration: frame.duration,
    keyMode: frame.keyMode,
    label: frame.label,
    labelType: frame.labelType,
    tweenType: frame.tweenType,
    acceleration: frame.acceleration,
    motionTweenRotate: frame.motionTweenRotate,
    motionTweenRotateTimes: frame.motionTweenRotateTimes,
    motionTweenScale: frame.motionTweenScale,
    motionTweenOrientToPath: frame.motionTweenOrientToPath,
    actionScript: frame.actionScript,
    sound: frame.sound,
    morphShape: frame.morphShape,
    tweens: frame.tweens,
    elements: frame.elements.map((element, elementIndex) => ({
      elementIndex,
      kind: elementKind(element),
      attributes: summarizeElement(element),
    })),
  });
}

function layerToTree(layer: Layer, layerIndex: number): Record<string, unknown> {
  return sortedObject({
    layerIndex,
    name: layer.name,
    color: layer.color,
    visible: layer.visible,
    locked: layer.locked,
    outline: layer.outline,
    transparent: layer.transparent,
    alphaPercent: layer.alphaPercent,
    layerType: layer.layerType,
    parentLayerIndex: layer.parentLayerIndex,
    maskLayerIndex: layer.maskLayerIndex,
    frames: layer.frames.map(frameToTree),
  });
}

function timelineToTree(timeline: Timeline): Record<string, unknown> {
  return sortedObject({
    name: timeline.name,
    totalFrames: timeline.totalFrames,
    cameraLayerIndex: timeline.cameraLayerIndex,
    referenceLayers: serialize(timeline.referenceLayers),
    layers: timeline.layers.map(layerToTree),
  });
}

function symbolToTree(name: string, symbol: FlaSymbol): Record<string, unknown> {
  return sortedObject({
    mapKey: name,
    name: symbol.name,
    itemID: symbol.itemID,
    symbolType: symbol.symbolType,
    scale9Grid: symbol.scale9Grid,
    hitAreaFrame: symbol.hitAreaFrame,
    linkageExportForAS: symbol.linkageExportForAS,
    linkageExportForRS: symbol.linkageExportForRS,
    linkageImportForRS: symbol.linkageImportForRS,
    linkageURL: symbol.linkageURL,
    linkageClassName: symbol.linkageClassName,
    linkageIdentifier: symbol.linkageIdentifier,
    linkageBaseClass: symbol.linkageBaseClass,
    timeline: timelineToTree(symbol.timeline),
  });
}

function documentToTree(doc: FLADocument, source: string, symbolFilter?: string): Record<string, unknown> {
  const displaySource = path.relative(process.cwd(), source) || source;
  const symbols = [...doc.symbols.entries()]
    .filter(([name, symbol]) => !symbolFilter || name === symbolFilter || symbol.name === symbolFilter || symbol.linkageClassName === symbolFilter)
    .map(([name, symbol]) => symbolToTree(name, symbol));

  return sortedObject({
    source: displaySource,
    document: sortedObject({
      width: doc.width,
      height: doc.height,
      frameRate: doc.frameRate,
      backgroundColor: doc.backgroundColor,
      flashVersion: doc.flashVersion,
      documentClass: doc.documentClass,
      linkage: doc.linkage,
    }),
    counts: sortedObject({
      timelines: doc.timelines.length,
      symbols: doc.symbols.size,
      dumpedSymbols: symbols.length,
      bitmaps: doc.bitmaps.size,
      sounds: doc.sounds.size,
      videos: doc.videos.size,
    }),
    timelines: symbolFilter ? [] : doc.timelines.map(timelineToTree),
    symbols,
    bitmaps: symbolFilter ? [] : serialize(doc.bitmaps),
    sounds: symbolFilter ? [] : serialize(doc.sounds),
    videos: symbolFilter ? [] : serialize(doc.videos),
  });
}

function shortJson(value: unknown): string {
  return JSON.stringify(value);
}

function compactAttrs(value: Record<string, unknown>): string {
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  if (entries.length === 0) return '';
  return ` ${entries.map(([key, entry]) => `${key}=${JSON.stringify(entry)}`).join(' ')}`;
}

function shortElementAttributes(element: DisplayElement): Record<string, unknown> {
  if (element.type === 'symbol') {
    return {
      libraryItemName: element.libraryItemName,
      symbolType: element.symbolType,
      name: element.name,
      loop: element.loop,
      firstFrame: element.firstFrame,
      lastFrame: element.lastFrame,
      blendMode: element.blendMode,
      isVisible: element.isVisible,
      matrix: element.matrix,
      colorTransform: element.colorTransform,
      filters: element.filters,
      componentParameters: element.componentParameters,
    };
  }
  if (element.type === 'text') {
    return {
      name: element.name,
      textType: element.textType,
      left: element.left,
      width: element.width,
      height: element.height,
      matrix: element.matrix,
      filters: element.filters,
      textRuns: element.textRuns.map((run) => ({
        characters: run.characters,
        face: run.face,
        size: run.size,
        fillColor: run.fillColor,
        bold: run.bold,
        italic: run.italic,
        underline: run.underline,
        alignment: run.alignment,
        letterSpacing: run.letterSpacing,
        lineSpacing: run.lineSpacing,
        autoKern: run.autoKern,
      })),
    };
  }
  if (element.type === 'shape') {
    return {
      matrix: element.matrix,
      fills: element.fills.length,
      strokes: element.strokes.length,
      edges: element.edges.length,
    };
  }
  return summarizeElement(element);
}

interface TxtNode {
  label: string;
  children?: TxtNode[];
}

function renderTxtNode(node: TxtNode, prefix = '', isLast = true, isRoot = false): string[] {
  const lines = [isRoot ? node.label : `${prefix}${isLast ? '└─ ' : '├─ '}${node.label}`];
  const childPrefix = isRoot ? '' : `${prefix}${isLast ? '   ' : '│  '}`;
  const children = node.children ?? [];
  for (let i = 0; i < children.length; i++) {
    lines.push(...renderTxtNode(children[i], childPrefix, i === children.length - 1));
  }
  return lines;
}

function elementToTxtNode(element: DisplayElement, elementIndex: number): TxtNode {
  return {
    label: `Element[${elementIndex}] ${elementKind(element)}${compactAttrs(shortElementAttributes(element))}`,
  };
}

function frameToTxtNode(frame: Frame): TxtNode {
  return {
    label: `Frame[${frame.index}]${compactAttrs({
      duration: frame.duration,
      keyMode: frame.keyMode,
      label: frame.label,
      labelType: frame.labelType,
      tweenType: frame.tweenType,
      acceleration: frame.acceleration,
      rotate: frame.motionTweenRotate,
      rotateTimes: frame.motionTweenRotateTimes,
      scale: frame.motionTweenScale,
      orientToPath: frame.motionTweenOrientToPath,
      actionScript: frame.actionScript,
      elements: frame.elements.length,
    })}`,
    children: frame.elements.map(elementToTxtNode),
  };
}

function layerToTxtNode(layer: Layer, layerIndex: number): TxtNode {
  return {
    label: `Layer[${layerIndex}]${compactAttrs({
      name: layer.name,
      layerType: layer.layerType,
      visible: layer.visible,
      locked: layer.locked,
      outline: layer.outline,
      parentLayerIndex: layer.parentLayerIndex,
      maskLayerIndex: layer.maskLayerIndex,
      frames: layer.frames.length,
    })}`,
    children: layer.frames.map(frameToTxtNode),
  };
}

function timelineToTxtNode(timeline: Timeline): TxtNode {
  return {
    label: `Timeline "${timeline.name}"${compactAttrs({
      totalFrames: timeline.totalFrames,
      layers: timeline.layers.length,
      cameraLayerIndex: timeline.cameraLayerIndex,
      referenceLayers: [...timeline.referenceLayers],
    })}`,
    children: timeline.layers.map(layerToTxtNode),
  };
}

function symbolToTxtNode(mapKey: string, symbol: FlaSymbol): TxtNode {
  return {
    label: `Symbol "${mapKey}"${compactAttrs({
      name: symbol.name,
      itemID: symbol.itemID,
      symbolType: symbol.symbolType,
      linkageClassName: symbol.linkageClassName,
      linkageIdentifier: symbol.linkageIdentifier,
      linkageURL: symbol.linkageURL,
      scale9Grid: symbol.scale9Grid,
    })}`,
    children: [timelineToTxtNode(symbol.timeline)],
  };
}

function documentToCompactTxt(doc: FLADocument, source: string, symbolFilter?: string): string {
  const displaySource = path.relative(process.cwd(), source) || source;
  const root: TxtNode = {
    label: `FLADocument${compactAttrs({
      source: displaySource,
      symbolFilter,
      width: doc.width,
      height: doc.height,
      frameRate: doc.frameRate,
      backgroundColor: doc.backgroundColor,
      flashVersion: doc.flashVersion,
      documentClass: doc.documentClass,
    })}`,
    children: [],
  };

  if (!symbolFilter) {
    root.children?.push({
      label: `DocumentTimelines count=${doc.timelines.length}`,
      children: doc.timelines.map(timelineToTxtNode),
    });
  }

  const symbolNodes = [...doc.symbols.entries()]
    .filter(([name, symbol]) => !symbolFilter || name === symbolFilter || symbol.name === symbolFilter || symbol.linkageClassName === symbolFilter)
    .map(([name, symbol]) => symbolToTxtNode(name, symbol));
  root.children?.push({
    label: `Symbols count=${doc.symbols.size} dumped=${symbolNodes.length}`,
    children: symbolNodes,
  });

  if (!symbolFilter) {
    root.children?.push({
      label: `Assets bitmaps=${doc.bitmaps.size} sounds=${doc.sounds.size} videos=${doc.videos.size}`,
    });
  }

  return `${renderTxtNode(root, '', true, true).join('\n')}\n`;
}

function pushTimeline(lines: string[], timeline: Timeline, prefix: string): void {
  lines.push(`${prefix}Timeline "${timeline.name}" totalFrames=${timeline.totalFrames} layers=${timeline.layers.length}`);
  for (const [layerIndex, layer] of timeline.layers.entries()) {
    lines.push(
      `${prefix}  Layer[${layerIndex}] ${shortJson({
        name: layer.name,
        layerType: layer.layerType,
        visible: layer.visible,
        locked: layer.locked,
        parentLayerIndex: layer.parentLayerIndex,
        maskLayerIndex: layer.maskLayerIndex,
        frames: layer.frames.length,
      })}`
    );
    for (const frame of layer.frames) {
      lines.push(
        `${prefix}    Frame[${frame.index}] ${shortJson({
          duration: frame.duration,
          keyMode: frame.keyMode,
          label: frame.label,
          labelType: frame.labelType,
          tweenType: frame.tweenType,
          acceleration: frame.acceleration,
          elements: frame.elements.length,
          actionScript: frame.actionScript,
        })}`
      );
      for (const [elementIndex, element] of frame.elements.entries()) {
        lines.push(`${prefix}      Element[${elementIndex}] ${elementKind(element)} ${shortJson(summarizeElement(element))}`);
      }
    }
  }
}

function documentToTextTree(doc: FLADocument, source: string, symbolFilter?: string): string {
  const displaySource = path.relative(process.cwd(), source) || source;
  const lines: string[] = [];
  lines.push(`# Parsed Binary FLA Tree`);
  lines.push(`source=${displaySource}`);
  lines.push(`document=${shortJson({
    width: doc.width,
    height: doc.height,
    frameRate: doc.frameRate,
    backgroundColor: doc.backgroundColor,
    flashVersion: doc.flashVersion,
    documentClass: doc.documentClass,
    linkageRecords: doc.linkage?.length ?? 0,
  })}`);
  lines.push(`counts=${shortJson({
    timelines: doc.timelines.length,
    symbols: doc.symbols.size,
    bitmaps: doc.bitmaps.size,
    sounds: doc.sounds.size,
    videos: doc.videos.size,
  })}`);

  if (!symbolFilter) {
    lines.push('');
    lines.push('## Document Timelines');
    doc.timelines.forEach((timeline) => pushTimeline(lines, timeline, ''));
  }

  lines.push('');
  lines.push('## Symbols');
  for (const [name, symbol] of doc.symbols.entries()) {
    if (symbolFilter && name !== symbolFilter && symbol.name !== symbolFilter && symbol.linkageClassName !== symbolFilter) continue;
    lines.push(`Symbol ${shortJson({
      mapKey: name,
      name: symbol.name,
      itemID: symbol.itemID,
      symbolType: symbol.symbolType,
      linkageClassName: symbol.linkageClassName,
      linkageIdentifier: symbol.linkageIdentifier,
      linkageURL: symbol.linkageURL,
      scale9Grid: symbol.scale9Grid,
    })}`);
    pushTimeline(lines, symbol.timeline, '  ');
  }

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const doc = parseBinaryFLA(new Uint8Array(await readFile(args.fla)));
  const output =
    args.format === 'txt'
      ? documentToCompactTxt(doc, args.fla, args.symbol)
      : args.format === 'tree'
        ? documentToTextTree(doc, args.fla, args.symbol)
        : `${JSON.stringify(documentToTree(doc, args.fla, args.symbol), null, 2)}\n`;

  if (args.out) {
    await writeFile(args.out, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
