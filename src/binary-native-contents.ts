import { decodeUtf16Le, readFlashStringAt } from './binary-flash-string';
import {
  extractImports,
  extractLinkage,
} from './binary-linkage-decoder';
import type { BinaryLinkage } from './types';

export type BinarySymbolType = 'graphic' | 'button' | 'movieclip' | 'unknown';

export interface BinaryLibraryEntry {
  /** OLE2 stream number (the N in "Symbol N") where this item's content lives. */
  symbolNumber: number;
  /** Library display name. */
  name: string;
  /** Symbol kind decoded from the type byte after the name. */
  symbolType: BinarySymbolType;
  /**
   * The u32 written immediately after the name in the library-item record: the
   * id that placements reference (`mediaRef` / `altMediaRef`). Equals
   * `symbolNumber` for single-numbered items and differs in dual-numbered files.
   */
  placementId?: number;
}

export interface NativeContentsInfo {
  library: BinaryLibraryEntry[];
  linkage: BinaryLinkage[];
  linkageBySymbol: Map<number, BinaryLinkage>;
  placementIdToStream: Map<number, number>;
}

const SYMBOL_TYPE_NAMES: Record<number, BinarySymbolType> = {
  0: 'graphic',
  1: 'button',
  2: 'movieclip',
};

/** Find the first index >= `from` where `needle` occurs in `hay`, or -1. */
function indexOf(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Extract the symbol library table from the `Contents` stream.
 *
 * Mirrors fla-decoder `extract_library.extract_library_table`: each library
 * record holds a `"Symbol N"` / `"S N ..."` MFC CString followed, within the
 * same record, by a Flash string with the library name and then `u32 id + u8
 * type`.
 */
export function extractLibrary(contents: Uint8Array): BinaryLibraryEntry[] {
  const symbolPrefix = new Uint8Array([
    0x53, 0x00, 0x79, 0x00, 0x6d, 0x00, 0x62, 0x00, 0x6f, 0x00, 0x6c, 0x00,
    0x20, 0x00,
  ]);
  const sPrefix = new Uint8Array([0x53, 0x00, 0x20, 0x00]);

  // Keyed by symbol number. If Flash writes multiple records for the same
  // symbol, the last record is authoritative, matching fla-decoder's dict write.
  const byNumber = new Map<number, BinaryLibraryEntry>();
  let pos = 0;
  while (pos < contents.length) {
    let idx = indexOf(contents, symbolPrefix, pos);
    let isS = false;
    const sIdx = indexOf(contents, sPrefix, pos);
    if (sIdx >= 0 && (idx < 0 || sIdx < idx)) {
      idx = sIdx;
      isS = true;
    }
    if (idx < 0) break;

    const strLen = idx > 0 ? contents[idx - 1] : 0;
    if (strLen > 0 && idx + strLen * 2 <= contents.length) {
      const value = decodeUtf16Le(contents, idx, strLen * 2);
      const match = isS ? /^S (\d+)(?: \d+)?$/.exec(value) : /^Symbol (\d+)$/.exec(value);
      if (match) {
        const symNum = parseInt(match[1], 10);
        const strEnd = idx + strLen * 2;
        let search = strEnd;
        const limit = Math.min(contents.length - 4, strEnd + 100);
        while (search < limit) {
          const libraryName = readFlashStringAt(contents, search, { maxChars: 255 });
          if (!libraryName) {
            search += 1;
            continue;
          }

          const name = libraryName.value;
          if (!name.includes('/') && !name.startsWith('.\\')) {
            const nameEnd = libraryName.end;
            let symbolType: BinarySymbolType = 'unknown';
            let placementId = symNum;
            if (nameEnd + 5 <= contents.length) {
              placementId =
                contents[nameEnd] |
                (contents[nameEnd + 1] << 8) |
                (contents[nameEnd + 2] << 16) |
                contents[nameEnd + 3] * 0x1000000;
              symbolType = SYMBOL_TYPE_NAMES[contents[nameEnd + 4]] ?? 'unknown';
            }
            byNumber.set(symNum, {
              symbolNumber: symNum,
              name,
              symbolType,
              placementId,
            });
            break;
          }
          search = libraryName.end;
        }
      }
    }
    pos = idx + 1;
  }

  return [...byNumber.values()].sort((a, b) => a.symbolNumber - b.symbolNumber);
}

export function collectSymbolNumberAliases(library: readonly BinaryLibraryEntry[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const entry of library) {
    const placementId = entry.placementId ?? entry.symbolNumber;
    if (placementId !== entry.symbolNumber && !out.has(placementId)) {
      out.set(placementId, entry.symbolNumber);
    }
  }
  return out;
}

export function joinLinkageToLibrary(
  linkage: readonly BinaryLinkage[],
  library: readonly BinaryLibraryEntry[],
  symbolNumbers: ReadonlySet<number>
): Map<number, BinaryLinkage> {
  const out = new Map<number, BinaryLinkage>();
  const nameToStream = new Map<string, number>();
  for (const entry of library) {
    if (!nameToStream.has(entry.name)) nameToStream.set(entry.name, entry.symbolNumber);
  }

  const pending: BinaryLinkage[] = [];
  for (const rec of linkage) {
    if (rec.kind === 'document') continue;
    const num = nameToStream.get(rec.identifier);
    if (num !== undefined && symbolNumbers.has(num) && !out.has(num)) {
      out.set(num, rec);
    } else {
      pending.push(rec);
    }
  }

  for (const rec of pending) {
    let num = rec.boundName !== undefined ? nameToStream.get(rec.boundName) : undefined;
    if (num === undefined && rec.boundName !== undefined) {
      const match = /^Symbol (\d+)$/.exec(rec.boundName);
      if (match) {
        const direct = parseInt(match[1], 10);
        if (symbolNumbers.has(direct)) num = direct;
      }
    }
    if (num === undefined) num = nameToStream.get(rec.identifier);
    if (num !== undefined && symbolNumbers.has(num) && !out.has(num)) {
      out.set(num, rec);
    }
  }

  return out;
}

export function readNativeContents(contents: Uint8Array, symbolNumbers: Set<number>): NativeContentsInfo {
  const library = extractLibrary(contents);
  const linkage = [
    ...extractLinkage(contents),
    ...extractImports(contents),
  ];

  const placementIdToStream = collectSymbolNumberAliases(library);
  const linkageBySymbol = joinLinkageToLibrary(linkage, library, symbolNumbers);

  return {
    library,
    linkage,
    linkageBySymbol,
    placementIdToStream,
  };
}
