import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseBinaryFLA } from '../binary-fla-parser';

const INV_FLA_PATH = fileURLToPath(new URL('./fixtures/cs4/inventorylists.fla', import.meta.url));

describe('binary-fla-parser: frame labels from post-page data', () => {
  it('flow into attributed frames so AS2 gotoAndPlay("PanelShow") resolves', () => {
    const bytes = readFileSync(INV_FLA_PATH);
    const doc = parseBinaryFLA(new Uint8Array(bytes));

    const found: { symbol: string; label: string }[] = [];
    for (const [symName, sym] of doc.symbols) {
      for (const layer of sym.timeline.layers) {
        for (const frame of layer.frames) {
          if (frame.label) found.push({ symbol: symName, label: frame.label });
        }
      }
    }

    const panelShow = found.filter((f) => f.label === 'PanelShow');
    expect(panelShow.length).toBeGreaterThan(0);
  });
});

describe('binary-fla-parser: layer name recovery (Phase 2.2)', () => {
  it('recovers real layer names for schema=0 layers via post-page sentinel records', () => {
    const bytes = readFileSync(INV_FLA_PATH);
    const doc = parseBinaryFLA(new Uint8Array(bytes));

    // Check at least one schema=0 symbol has its layer names recovered
    const symNames = [...doc.symbols.keys()];
    expect(symNames.length).toBeGreaterThan(0);

    // Find symbols whose Timeline layers have recovered names
    const symbolsWithMultiLayers = symNames.filter((n) => {
      const s = doc.symbols.get(n)!;
      const names = s.timeline.layers.map((l) => l.name);
      return names.length > 3 && names[0] !== '' && names[0].length > 0;
    });
    expect(symbolsWithMultiLayers.length).toBeGreaterThanOrEqual(1);

    // Verify specific known layer names exist in a multi-layer symbol
    const allLayerNames = new Set<string>();
    for (const n of symNames) {
      const s = doc.symbols.get(n)!;
      for (const l of s.timeline.layers) allLayerNames.add(l.name);
    }
    expect(allLayerNames.has('background')).toBe(true);
    expect(allLayerNames.has('actions')).toBe(true);
    expect(allLayerNames.has('labels')).toBe(true);
    expect(allLayerNames.has('Label Layer')).toBe(true);
    expect(allLayerNames.has('Action Layer')).toBe(true);
  });
});
