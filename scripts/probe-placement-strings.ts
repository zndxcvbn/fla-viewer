import fs from 'node:fs';
import { OLE2File } from '../src/ole2-reader';
import { readFlashStringAt } from '../src/binary-flash-string';

const [,, flaPath, streamName, startArg, endArg] = process.argv;
if (!flaPath || !streamName || !startArg) {
  throw new Error('usage: tsx scripts/probe-placement-strings.ts <fla> <stream> <start> [end]');
}

const ole = new OLE2File(new Uint8Array(fs.readFileSync(flaPath)));
const data = ole.readStream(streamName);
const start = Number(startArg);
const end = endArg ? Number(endArg) : Math.min(data.length, start + 1800);

console.log(`${streamName} ${start}-${end}`);

for (let p = Math.max(0, start); p < Math.min(data.length - 4, end); p++) {
  const decoded = readFlashStringAt(data, p, {
    allowEmpty: true,
    allowExtended: true,
    maxChars: 4096,
  });
  if (!decoded) continue;
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(decoded.value)) continue;
  console.log(`${p}: "${decoded.value}" end=${decoded.end}`);
  p = decoded.end - 1;
}

function findAscii(needle: string): void {
  const bytes = [...needle].map((ch) => ch.charCodeAt(0));
  for (let p = 0; p <= data.length - bytes.length; p++) {
    let ok = true;
    for (let i = 0; i < bytes.length; i++) {
      if (data[p + i] !== bytes[i]) { ok = false; break; }
    }
    if (ok) console.log(`ascii ${needle}@${p}`);
  }
}

function findUtf16(needle: string): void {
  const bytes = [...needle].flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8]);
  for (let p = 0; p <= data.length - bytes.length; p++) {
    let ok = true;
    for (let i = 0; i < bytes.length; i++) {
      if (data[p + i] !== bytes[i]) { ok = false; break; }
    }
    if (ok) console.log(`utf16 ${needle}@${p}`);
  }
}

for (const needle of ['itemList', 'QuestsTab', 'StatsTab', 'SystemTab', 'BookDescriptionLabel', 'WeaponDamageValue', 'true', 'false']) {
  findAscii(needle);
  findUtf16(needle);
}
