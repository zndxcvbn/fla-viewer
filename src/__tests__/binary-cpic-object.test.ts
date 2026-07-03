import { describe, expect, it } from 'vitest';
import { CArchiveReader } from '../binary-carchive';
import {
  readCPicObjBase,
  readCPicObjLeafBase,
} from '../binary-cpic-object';

function u8(...values: number[]): number[] {
  return values.map((value) => value & 0xff);
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function s32le(value: number): number[] {
  const n = value < 0 ? value + 0x100000000 : value;
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

function ascii(value: string): number[] {
  return [...value].map((c) => c.charCodeAt(0));
}

function classDecl(name: string, schema = 1): number[] {
  return [0xff, 0xff, ...u16le(schema), ...u16le(name.length), ...ascii(name)];
}

const NULL_OBJECT = [0x00, 0x00];

describe('binary-cpic-object: readCPicObjLeafBase', () => {
  it('reads a leaf CPicObj base with registration point and schema extras', () => {
    const data = Uint8Array.from([
      ...u8(4, 0x12),
      ...NULL_OBJECT,
      ...s32le(6000),
      ...s32le(-3000),
      ...u8(0xaa, 0xbb),
    ]);
    const reader = new CArchiveReader(data);

    expect(readCPicObjLeafBase(reader)).toEqual({
      bodyStart: 0,
      bodyEnd: data.length,
      schema: 4,
      flags: 0x12,
      children: [],
      registrationPoint: { x: 6000, y: -3000 },
      extra1: 0xaa,
      extra2: 0xbb,
    });
    expect(reader.pos).toBe(data.length);
  });

  it('reads the additional schema 6 extra byte observed in real CPicSprite bodies', () => {
    const data = Uint8Array.from([
      ...u8(6, 0x02),
      ...NULL_OBJECT,
      ...s32le(6553),
      ...s32le(7111),
      ...u8(0x00, 0x00, 0x00),
    ]);
    const reader = new CArchiveReader(data);

    expect(readCPicObjLeafBase(reader)).toEqual({
      bodyStart: 0,
      bodyEnd: data.length,
      schema: 6,
      flags: 0x02,
      children: [],
      registrationPoint: { x: 6553, y: 7111 },
      extra1: 0,
      extra2: 0,
      extra3: 0,
    });
  });

  it('throws when a leaf parser sees a child object', () => {
    const data = Uint8Array.from([
      ...u8(2, 0),
      ...classDecl('CPicFrame', 1),
      0x99,
    ]);
    const reader = new CArchiveReader(data);

    expect(() => readCPicObjLeafBase(reader)).toThrow(/expected leaf/);
  });
});

describe('binary-cpic-object: readCPicObjBase', () => {
  it('preserves child object headers, values and body ranges', () => {
    const data = Uint8Array.from([
      ...u8(2, 0x01),
      ...classDecl('CPicFrame', 7),
      0x42,
      ...NULL_OBJECT,
      ...s32le(10),
      ...s32le(20),
    ]);
    const reader = new CArchiveReader(data);

    const base = readCPicObjBase(reader, (header, r) => {
      expect(header.className).toBe('CPicFrame');
      const value = r.readU8();
      return { marker: value };
    });

    expect(base.schema).toBe(2);
    expect(base.flags).toBe(0x01);
    expect(base.registrationPoint).toEqual({ x: 10, y: 20 });
    expect(base.bodyEnd).toBe(data.length);
    expect(base.children).toEqual([
      {
        header: {
          tagStart: 2,
          bodyStart: 2 + 6 + 'CPicFrame'.length,
          className: 'CPicFrame',
          schema: 7,
          referenceKind: 'new_class',
          objectIndex: 2,
        },
        bodyEnd: 2 + 6 + 'CPicFrame'.length + 1,
        value: { marker: 0x42 },
      },
    ]);
  });

  it('supports typed pre-children bytes before the CArchive child loop', () => {
    const data = Uint8Array.from([
      ...u8(1, 1, 0),
      ...classDecl('CPicFrame', 7),
      0x42,
      ...NULL_OBJECT,
      ...s32le(10),
      ...s32le(20),
    ]);
    const reader = new CArchiveReader(data);

    const base = readCPicObjBase(
      reader,
      (_header, r) => ({ marker: r.readU8() }),
      {
        readPreChildren: (_schema, _flags, r) => {
          expect(r.readU8()).toBe(0);
        },
      }
    );

    expect(base.children).toHaveLength(1);
    expect(base.children[0].value).toEqual({ marker: 0x42 });
    expect(base.registrationPoint).toEqual({ x: 10, y: 20 });
  });

  it('can stop before a boundary child class without consuming it', () => {
    const data = Uint8Array.from([
      ...classDecl('CPicLayer', 1),
      ...u8(1, 1, 0),
      ...u16le(0x8001),
    ]);
    const reader = new CArchiveReader(data);
    reader.readObjectHeader();

    const base = readCPicObjBase(
      reader,
      () => {
        throw new Error('boundary child should not be consumed');
      },
      {
        readPreChildren: (_schema, _flags, r) => {
          r.readU8();
        },
        stopBeforeChildClasses: ['CPicLayer'],
      }
    );

    expect(base.children).toEqual([]);
    expect(reader.peekObjectHeader()).toMatchObject({
      className: 'CPicLayer',
      referenceKind: 'class_backref',
    });
  });
});
