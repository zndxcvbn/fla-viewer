import { describe, expect, it } from 'vitest';
import {
  collectSymbolNumberAliases,
  joinLinkageToLibrary,
  readNativeContents,
  type BinaryLibraryEntry,
} from '../binary-native-contents';
import type { BinaryLinkage } from '../types';

function u8(...values: number[]): number[] {
  return values.map((value) => value & 0xff);
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function utf16(value: string): number[] {
  const out: number[] = [];
  for (const char of value) out.push(char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8);
  return out;
}

function flashStr(value: string): number[] {
  return [0xff, 0xfe, 0xff, value.length, ...utf16(value)];
}

function cString(value: string): number[] {
  return [value.length, ...utf16(value)];
}

function linkageRecord(identifier: string, className: string): number[] {
  return [...flashStr(identifier), ...flashStr('.'), ...flashStr(className), 0x07, 0x02, 0x00, 0x00, 0x00];
}

describe('readNativeContents', () => {
  it('collects library, linkage joins and placement aliases from one Contents pass', () => {
    const contents = new Uint8Array([
      ...cString('Symbol 23'),
      ...u8(0, 0, 0, 0),
      ...flashStr('InventoryListsTweener'),
      ...u32le(28),
      0x02,
      ...u8(0, 0, 0, 0),
      ...linkageRecord('InventoryListsTweener', 'InventoryListsTweener'),
    ]);

    const result = readNativeContents(contents, new Set([23]));

    expect(result.library).toEqual([
      {
        symbolNumber: 23,
        name: 'InventoryListsTweener',
        symbolType: 'movieclip',
        placementId: 28,
      },
    ]);
    expect(result.placementIdToStream).toEqual(new Map([[28, 23]]));
    expect(result.linkageBySymbol.get(23)?.identifier).toBe('InventoryListsTweener');
    expect(result.linkageBySymbol.get(23)?.className).toBe('InventoryListsTweener');
  });
});

describe('joinLinkageToLibrary', () => {
  const library: BinaryLibraryEntry[] = [
    { symbolNumber: 64, name: 'Sprite 43', symbolType: 'movieclip', placementId: 64 },
    { symbolNumber: 254, name: 'MyButton', symbolType: 'button', placementId: 254 },
    { symbolNumber: 677, name: 'MyClip', symbolType: 'movieclip', placementId: 677 },
  ];

  it('joins linkage identifiers to already-decoded library entries', () => {
    const links: BinaryLinkage[] = [
      { identifier: 'MyClip', className: 'com.MyClip', kind: 'library' },
      { identifier: 'MyButton', className: 'skyui.MyButton', kind: 'library' },
    ];

    const join = joinLinkageToLibrary(links, library, new Set([677, 254]));

    expect(join.get(677)?.identifier).toBe('MyClip');
    expect(join.get(677)?.className).toBe('com.MyClip');
    expect(join.get(254)?.identifier).toBe('MyButton');
    expect(join.size).toBe(2);
  });

  it('does not join a record without a local library item', () => {
    const links: BinaryLinkage[] = [
      { identifier: 'Imported', className: 'shared.Imported', kind: 'library' },
    ];

    expect(joinLinkageToLibrary(links, library, new Set([64, 254, 677])).size).toBe(0);
  });

  it('resolves component-only records through a Sprite edit-name fallback', () => {
    const links: BinaryLinkage[] = [
      {
        identifier: 'GamepadButton',
        className: 'Components.CrossPlatformButtons',
        kind: 'library',
        boundName: 'Sprite 43',
      },
    ];

    const join = joinLinkageToLibrary(links, library, new Set([64]));

    expect(join.get(64)?.identifier).toBe('GamepadButton');
    expect(join.get(64)?.className).toBe('Components.CrossPlatformButtons');
  });

  it('collects dual-numbered placement aliases from decoded library entries', () => {
    expect(collectSymbolNumberAliases([
      { symbolNumber: 23, name: 'InventoryListsTweener', symbolType: 'movieclip', placementId: 28 },
    ])).toEqual(new Map([[28, 23]]));
  });
});
