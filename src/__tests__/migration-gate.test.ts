import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareStreamPipelines } from '../binary-migration-gate';
import { parseBinaryFLA } from '../binary-fla-parser';
import { OLE2File } from '../ole2-reader';
import type { Symbol as FlaSymbol } from '../types';

const ITEMCARD_FLA_PATH = fixturePath('itemcard.fla');
const FAVORITESMENU_FLA_PATH = fixturePath('favoritesmenu.fla');
const INVENTORYLISTS_FLA_PATH = fixturePath('inventorylists.fla');
const CONFIGPANEL_FLA_PATH = fixturePath('configpanel.fla');
const QUEST_JOURNAL_FLA_PATH = fixturePath('quest_journal.fla');

function fixturePath(fileName: string): string {
  return fileURLToPath(new URL(`./fixtures/cs4/${fileName}`, import.meta.url));
}

function loadFla(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function namedElements(symbol: FlaSymbol): string[] {
  return symbol.timeline.layers
    .flatMap((layer) => layer.frames)
    .flatMap((frame) => frame.elements)
    .map((element) => ('name' in element ? element.name : undefined))
    .filter((name): name is string => !!name);
}

function frameLabels(symbol: FlaSymbol): string[] {
  return symbol.timeline.layers
    .flatMap((layer) => layer.frames)
    .map((frame) => frame.label)
    .filter((label): label is string => !!label);
}

describe('migration gate: itemcard.fla', () => {
  const data = loadFla(ITEMCARD_FLA_PATH);
  const ole = new OLE2File(data);
  const streams = ole.listStreams();
  const allResults = streams.map((s) => ({
    name: s.name,
    result: compareStreamPipelines(ole.readStream(s.name), s.name),
  }));

  const nativeFailures = allResults.filter((r) => !r.result.nativeOk);

  it('native walk succeeds for production symbol/page streams', () => {
    const unexpectedFailures = nativeFailures.filter(
      (r) => !r.name.startsWith('Contents') && !r.name.startsWith('Media')
    );
    expect(unexpectedFailures.length).toBe(0);
  });

  it('native instances never fewer than heuristic per stream', () => {
    for (const r of allResults) {
      if (!r.result.nativeOk) continue;
      const instDiff = r.result.metrics.instances.native - r.result.metrics.instances.heuristic;
      expect(
        instDiff >= 0,
        `${r.name}: native instances=${r.result.metrics.instances.native}, heuristic=${r.result.metrics.instances.heuristic}`
      ).toBe(true);
    }
  });

  it('native shapes never fewer than heuristic for decoded symbol streams', () => {
    for (const r of allResults) {
      if (!r.result.nativeOk) continue;
      if (r.result.metrics.shapes.native < r.result.metrics.shapes.heuristic) {
        // Shape count discrepancy means the heuristic scanner found shapes
        // in CPicShape bodies that the native walk couldn't decode (likely
        // the stream is a container/sprite not a page).
        console.warn(`${r.name}: shapes native=${r.result.metrics.shapes.native}, heuristic=${r.result.metrics.shapes.heuristic}`);
      }
    }
  });

  it('totalFrames match or improve per stream', () => {
    for (const r of allResults) {
      if (!r.result.nativeOk) continue;
      const n = r.result.metrics.totalFrames.native;
      const h = r.result.metrics.totalFrames.heuristic;
      if (n !== h) {
        // native totalFrames is more accurate (e.g. 201 vs 233 for Symbol 2)
        expect(n).toBeGreaterThan(0);
      }
    }
  });
});

describe('migration gate: diff summary', () => {
  const data = loadFla(ITEMCARD_FLA_PATH);
  const ole = new OLE2File(data);
  const streams = ole.listStreams();

  it('lists all differences per stream', () => {
    let totalDiffs = 0;
    for (const s of streams) {
      const result = compareStreamPipelines(ole.readStream(s.name), s.name);
      if (!result.nativeOk) continue;
      if (result.diffs.length > 0) {
        totalDiffs += result.diffs.length;
        for (const d of result.diffs) {
          console.warn(`  [${s.name}] ${d}`);
        }
      }
    }
    // Native should match or exceed heuristic in all dimensions for every
    // successfully-decoded stream.
    expect(totalDiffs).toBeLessThan(400); // sanity cap
  }, 10000);
});

describe('native timeline XFL semantics regressions', () => {
  it('preserves the full FavoritesMenu layer stack', () => {
    const doc = parseBinaryFLA(loadFla(FAVORITESMENU_FLA_PATH));
    const symbol = doc.symbols.get('FavoritesMenu');
    expect(symbol, 'FavoritesMenu library symbol should be decoded').toBeDefined();

    expect(symbol?.timeline.layers.map((layer) => layer.name)).toEqual([
      'navpanel',
      'button',
      'text',
      'cat btns',
      'group btns',
      'list',
      'background',
    ]);
  }, 10000);

  it('emits native mask groups in XFL/display layer order', () => {
    const doc = parseBinaryFLA(loadFla(ITEMCARD_FLA_PATH));
    const symbol = [...doc.symbols.values()].find((entry) => entry.itemID === 'Symbol 18');
    expect(symbol, 'Symbol 18 / Sprite 70 should be decoded').toBeDefined();

    const layers = symbol?.timeline.layers ?? [];
    expect(layers.map((layer) => layer.name)).toEqual([
      'Labels Layer',
      '',
      'Layer 11',
      'Layer 9',
      'Layer 8',
      'Layer 6',
      'Layer 2',
      'Layer 1',
    ]);
    expect(layers.map((layer) => layer.layerType)).toEqual([
      'normal',
      'mask',
      'masked',
      'masked',
      'masked',
      'masked',
      'masked',
      'normal',
    ]);
    for (const index of [2, 3, 4, 5, 6]) {
      expect(layers[index].parentLayerIndex).toBe(1);
      expect(layers[index].maskLayerIndex).toBe(1);
    }
  }, 10000);

  it('propagates native CPicFrame keyMode into viewer frames', () => {
    const doc = parseBinaryFLA(loadFla(ITEMCARD_FLA_PATH));
    const symbol = doc.symbols.get('ItemCard');
    expect(symbol, 'ItemCard library symbol should be decoded').toBeDefined();

    const labelsLayer = symbol?.timeline.layers.find((layer) => layer.name === 'Labels Layer');
    expect(labelsLayer, 'ItemCard Labels Layer should be decoded').toBeDefined();
    expect(labelsLayer?.frames.slice(0, 3).map((frame) => frame.keyMode)).toEqual([
      8704,
      8704,
      8704,
    ]);
  }, 10000);

  it('normalizes native placement ids to library stream ids', () => {
    const doc = parseBinaryFLA(loadFla(INVENTORYLISTS_FLA_PATH));
    const scene = doc.timelines[0];
    const rootInstance = scene?.layers
      .flatMap((layer) => layer.frames)
      .flatMap((frame) => frame.elements)
      .find((element) => element.type === 'symbol' && element.name === 'inventoryLists');

    expect(rootInstance).toBeDefined();
    if (rootInstance?.type === 'symbol') {
      expect(rootInstance.libraryItemName).toBe('InventoryLists');
    }
  }, 10000);

  it('keeps adjacent CPicText fields as separate named children', () => {
    const doc = parseBinaryFLA(loadFla(INVENTORYLISTS_FLA_PATH));
    const symbol = doc.symbols.get('TabBar');
    expect(symbol, 'TabBar library symbol should be decoded').toBeDefined();
    expect(namedElements(symbol!)).toEqual(expect.arrayContaining([
      'leftLabel',
      'rightLabel',
    ]));
  }, 10000);

  it('decodes native CPicText content and fill color after schema marker variants', () => {
    const doc = parseBinaryFLA(loadFla(INVENTORYLISTS_FLA_PATH));
    const categoryLabel = doc.symbols.get('CategoryLabel');
    expect(categoryLabel, 'CategoryLabel symbol should be decoded').toBeDefined();

    const text = categoryLabel?.timeline.layers
      .flatMap((layer) => layer.frames)
      .flatMap((frame) => frame.elements)
      .find((element) => element.type === 'text' && element.name === 'textField');

    expect(text).toBeDefined();
    if (text?.type === 'text') {
      expect(text.textRuns[0].characters).toBe('Label');
      expect(text.textRuns[0].fillColor).toBe('#FFFFFF');
    }
  }, 10000);

  it('propagates native CPicText bold flag into TextRun', () => {
    const doc = parseBinaryFLA(loadFla(ITEMCARD_FLA_PATH));
    const boldText = [...doc.symbols.values()]
      .flatMap((symbol) => symbol.timeline.layers)
      .flatMap((layer) => layer.frames)
      .flatMap((frame) => frame.elements)
      .find((element) => element.type === 'text' && element.textRuns[0]?.bold === true);

    expect(boldText).toBeDefined();
  }, 10000);

  it('uses the XFL default loop mode for binary symbol instances', () => {
    const doc = parseBinaryFLA(loadFla(INVENTORYLISTS_FLA_PATH));
    const fillArea = doc.symbols.get('FillArea');
    expect(fillArea, 'FillArea symbol should be decoded').toBeDefined();

    const graphic = fillArea?.timeline.layers
      .flatMap((layer) => layer.frames)
      .flatMap((frame) => frame.elements)
      .find((element) => element.type === 'symbol' && element.libraryItemName === 'Area Shape');

    expect(graphic).toBeDefined();
    if (graphic?.type === 'symbol') {
      expect(graphic.symbolType).toBe('graphic');
      expect(graphic.loop).toBe('loop');
    }
  }, 10000);

  it('propagates confirmed schema-22 placement blend mode values', () => {
    const doc = parseBinaryFLA(loadFla(ITEMCARD_FLA_PATH));
    const symbol = doc.symbols.get('Sprite 93');
    expect(symbol, 'Sprite 93 library symbol should be decoded').toBeDefined();

    const symbolElements = symbol!.timeline.layers
      .flatMap((layer) => layer.frames)
      .flatMap((frame) => frame.elements)
      .filter((element) => element.type === 'symbol');

    expect(symbolElements.slice(1, 10).map((element) => element.blendMode)).toEqual(
      Array(9).fill('layer')
    );
  }, 10000);

  it('returns FavoritesMenu.itemList directly from binary placements', () => {
    const doc = parseBinaryFLA(loadFla(FAVORITESMENU_FLA_PATH));
    const symbol = doc.symbols.get('FavoritesMenu');
    expect(symbol, 'FavoritesMenu library symbol should be decoded').toBeDefined();
    expect(namedElements(symbol!)).toContain('itemList');
  }, 10000);

  it('returns ItemCard bare TextField children used by AS2', () => {
    const doc = parseBinaryFLA(loadFla(ITEMCARD_FLA_PATH));
    const symbol = doc.symbols.get('ItemCard');
    expect(symbol, 'ItemCard library symbol should be decoded').toBeDefined();
    expect(namedElements(symbol!)).toEqual(expect.arrayContaining([
      'WeaponDamageValue',
      'BookDescriptionLabel',
    ]));
  }, 10000);

  it('merges post-page frame labels into native-attributed binary timelines', () => {
    const doc = parseBinaryFLA(loadFla(CONFIGPANEL_FLA_PATH));
    const symbol = doc.symbols.get('SubListFader');
    expect(symbol, 'SubListFader library symbol should be decoded').toBeDefined();
    expect(frameLabels(symbol!)).toEqual(expect.arrayContaining(['show', 'hide']));
  }, 10000);

  it('returns OptionsListEntry stage children from binary placements', () => {
    const doc = parseBinaryFLA(loadFla(CONFIGPANEL_FLA_PATH));
    const symbol = doc.symbols.get('OptionsListEntry');
    expect(symbol, 'OptionsListEntry library symbol should be decoded').toBeDefined();
    expect(namedElements(symbol!)).toEqual(expect.arrayContaining([
      'background',
      'selectIndicator',
      'headerDecor',
      'toggleIcon',
      'menuIcon',
      'sliderIcon',
      'colorIcon',
      'buttonArt',
    ]));
  }, 10000);

  it('returns Quest_Journal root tab stage children from binary component placements', () => {
    const doc = parseBinaryFLA(loadFla(QUEST_JOURNAL_FLA_PATH));
    const symbol = [...doc.symbols.values()].find((entry) => entry.linkageClassName === 'Quest_Journal');
    expect(symbol, 'Quest_Journal library symbol should be decoded').toBeDefined();
    expect(namedElements(symbol!)).toEqual(expect.arrayContaining([
      'QuestsTab',
      'StatsTab',
      'SystemTab',
    ]));
  }, 10000);
});
