import { describe, expect, it } from 'vitest';
import {
  CArchiveReader,
  buildCombinedClassTable,
  readNewClassNameAt,
  scanCArchiveObjectStarts,
} from '../binary-carchive';

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

function ascii(value: string): number[] {
  return [...value].map((c) => c.charCodeAt(0));
}

function classDecl(name: string, schema = 1): number[] {
  return [0xff, 0xff, ...u16le(schema), ...u16le(name.length), ...ascii(name)];
}

function backref(index: number): number[] {
  return u16le(0x8000 | index);
}

function longBackref(index: number): number[] {
  return [0xff, 0x7f, ...u32le(index)];
}

describe('binary-carchive: readNewClassNameAt', () => {
  it('reads a NEWCLASS declaration body start', () => {
    const data = Uint8Array.from([...classDecl('CPicLayer', 11), 0xaa]);
    expect(readNewClassNameAt(data, 0)).toEqual({
      className: 'CPicLayer',
      bodyStart: 6 + 'CPicLayer'.length,
    });
  });
});

describe('binary-carchive: CArchiveReader', () => {
  it('reads NEWCLASS headers and tracks the combined class table', () => {
    const data = Uint8Array.from([...classDecl('CPicPage', 2), 0x00]);
    const reader = new CArchiveReader(data);

    const header = reader.readObjectHeader();
    expect(header).toEqual({
      tagStart: 0,
      bodyStart: 6 + 'CPicPage'.length,
      className: 'CPicPage',
      schema: 2,
      referenceKind: 'new_class',
      objectIndex: 2,
    });
    expect(reader.combinedClassTable()).toEqual(['CPicPage', 'CPicPage']);
    expect(reader.pos).toBe(header!.bodyStart);
  });

  it('resolves class backrefs and appends an object slot', () => {
    const data = Uint8Array.from([
      ...classDecl('CPicFrame', 1),
      0xaa,
      ...backref(1),
      0xbb,
    ]);
    const reader = new CArchiveReader(data);

    const first = reader.readObjectHeader()!;
    reader.pos += 1;
    const second = reader.readObjectHeader()!;

    expect(first.referenceKind).toBe('new_class');
    expect(second).toMatchObject({
      tagStart: first.bodyStart + 1,
      bodyStart: first.bodyStart + 3,
      className: 'CPicFrame',
      referenceKind: 'class_backref',
      objectIndex: 3,
      referenceIndex: 1,
    });
    expect(reader.combinedClassTable()).toEqual(['CPicFrame', 'CPicFrame', 'CPicFrame']);
  });

  it('resolves object backrefs without appending another object slot', () => {
    const data = Uint8Array.from([
      ...classDecl('CPicFrame', 1),
      0xaa,
      ...backref(2),
      0xbb,
    ]);
    const reader = new CArchiveReader(data);

    const first = reader.readObjectHeader()!;
    reader.pos += 1;
    const second = reader.readObjectHeader()!;

    expect(second).toMatchObject({
      tagStart: first.bodyStart + 1,
      bodyStart: first.bodyStart + 3,
      className: 'CPicFrame',
      referenceKind: 'object_backref',
      objectIndex: 2,
      referenceIndex: 2,
    });
    expect(reader.combinedClassTable()).toEqual(['CPicFrame', 'CPicFrame']);
  });

  it('supports long-form backrefs', () => {
    const data = Uint8Array.from([
      ...classDecl('CPicShape', 1),
      0xaa,
      ...longBackref(1),
      0xbb,
    ]);
    const reader = new CArchiveReader(data);

    const first = reader.readObjectHeader()!;
    reader.pos += 1;
    const second = reader.readObjectHeader()!;

    expect(second).toMatchObject({
      tagStart: first.bodyStart + 1,
      bodyStart: first.bodyStart + 7,
      className: 'CPicShape',
      referenceKind: 'class_backref',
      objectIndex: 3,
      referenceIndex: 1,
    });
  });

  it('returns null for a null object tag', () => {
    const reader = new CArchiveReader(Uint8Array.from([0x00, 0x00]));
    expect(reader.readObjectHeader()).toBeNull();
    expect(reader.pos).toBe(2);
  });

  it('peeks object headers without consuming position or load-array state', () => {
    const data = Uint8Array.from([...classDecl('CPicLayer', 1), ...backref(1)]);
    const reader = new CArchiveReader(data);

    const first = reader.peekObjectHeader();
    expect(first).toMatchObject({
      tagStart: 0,
      className: 'CPicLayer',
      referenceKind: 'new_class',
    });
    expect(reader.pos).toBe(0);
    expect(reader.combinedClassTable()).toEqual([]);

    reader.readObjectHeader();
    const second = reader.peekObjectHeader();
    expect(second).toMatchObject({
      tagStart: 6 + 'CPicLayer'.length,
      className: 'CPicLayer',
      referenceKind: 'class_backref',
      objectIndex: 3,
      referenceIndex: 1,
    });
    expect(reader.combinedClassTable()).toEqual(['CPicLayer', 'CPicLayer']);
  });

  it('wraps typed body parsing with exact bodyEnd', () => {
    const data = Uint8Array.from([...classDecl('CPicLayer', 11), 0x12, 0x34]);
    const reader = new CArchiveReader(data);

    const object = reader.readObject((header, r) => {
      expect(header.className).toBe('CPicLayer');
      const value = r.data[r.pos];
      r.pos += 1;
      return value;
    });

    expect(object).toEqual({
      header: {
        tagStart: 0,
        bodyStart: 6 + 'CPicLayer'.length,
      className: 'CPicLayer',
      schema: 11,
      referenceKind: 'new_class',
      objectIndex: 2,
    },
      bodyEnd: 6 + 'CPicLayer'.length + 1,
      value: 0x12,
    });
  });
});

describe('binary-carchive: recovery scanners', () => {
  it('keeps scanCArchiveObjectStarts behavior aligned with the reader table rules', () => {
    const data = Uint8Array.from([
      ...classDecl('CPicLayer', 11),
      0xaa,
      ...backref(1),
      0xbb,
      ...longBackref(1),
      0xcc,
    ]);

    expect(buildCombinedClassTable(data)).toEqual(['CPicLayer', 'CPicLayer']);
    expect(scanCArchiveObjectStarts(data).map((s) => ({
      bodyStart: s.bodyStart,
      className: s.className,
      recoveredVia: s.recoveredVia,
    }))).toEqual([
      { bodyStart: 6 + 'CPicLayer'.length, className: 'CPicLayer', recoveredVia: 'class_decl' },
      { bodyStart: 6 + 'CPicLayer'.length + 3, className: 'CPicLayer', recoveredVia: 'backref' },
      { bodyStart: 6 + 'CPicLayer'.length + 10, className: 'CPicLayer', recoveredVia: 'backref' },
    ]);
  });
});
