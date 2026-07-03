import { readFileSync } from 'fs';
import { OLE2File } from './src/ole2-reader';
import { scanForInstances, scanNamedInstances, tryParseInstanceAt } from './src/binary-instance-decoder';

function hex(v: number, w = 2): string {
  return v.toString(16).padStart(w, '0');
}

function findColorTransform(className: string, data: Uint8Array, bodyStart: number): { hasCT: boolean; afterCT: number } | null {
  const rStart = bodyStart + 72;
  if (rStart + 5 > data.length) return null;
  const mediaRef = data[rStart] | (data[rStart+1] << 8) | (data[rStart+2] << 16) | (data[rStart+3] << 24);
  const hasCT = data[rStart + 4];
  const afterCT = rStart + (hasCT ? 19 : 5);
  return { hasCT: hasCT !== 0, afterCT };
}

function getBodyEnd(data: Uint8Array, bodyStart: number): number {
  // Try parsing to get the real endPos
  const result = tryParseInstanceAt(data, bodyStart, 'CPicSprite', 'class_decl');
  if (result) return result.endPos;
  return 0;
}

const flaPath = 'src/__tests__/fixtures/cs4/itemcard.fla';
const bytes = readFileSync(flaPath);
const ole = new OLE2File(new Uint8Array(bytes));
const streams = ole.listStreams();

// Scan Symbol 2 - list all instances with hasCT=1 and their tails
const sym2 = ole.readStream('Symbol 2');
const instances = scanForInstances(sym2);
const named = scanNamedInstances(sym2);

console.log(`Symbol 2: ${instances.length} instances, ${named.length} named\n`);

// Show summary table
console.log("bodyStart  className     mediaRef name                  hasCT  endPos  afterCT");
console.log("---------  ------------  -------  --------------------  -----  ------  -------");
for (const inst of instances) {
  const ct = findColorTransform(inst.className, sym2, inst.bodyStart);
  const match = named.find(n => n.bodyStart === inst.bodyStart);
  const name = match ? match.name : '';
  const hasCT = ct ? ct.hasCT : false;
  // Check if there's data after the expected end
  const scanEnd = getBodyEnd(sym2, inst.bodyStart);
  if (ct) {
    const remainingAfterCT = scanEnd - ct.afterCT;
    console.log(`${inst.bodyStart.toString().padStart(7)}  ${(inst.className as string).padEnd(12)}  ${String(inst.mediaRef).padStart(5)}  ${name.padEnd(22)}  ${hasCT ? 'YES ' : 'no  '}  ${scanEnd > 0 ? String(scanEnd).padStart(5) : '     '}  ${remainingAfterCT > 0 ? String(remainingAfterCT) : ''}`);
  }
}

// For instances with hasCT=1, show full tail dump
console.log("\n\n=== INSTANCES WITH hasCT=1 ===");
for (const inst of instances) {
  const ct = findColorTransform(inst.className, sym2, inst.bodyStart);
  if (!ct || !ct.hasCT) continue;
  const match = named.find(n => n.bodyStart === inst.bodyStart);
  const name = match ? match.name : 'unnamed';
  
  // Show from after colorTransform to endPos
  const endPos = getBodyEnd(sym2, inst.bodyStart);
  const start = ct.afterCT;
  const dumpEnd = endPos > start ? endPos : Math.min(ct.afterCT + 48, sym2.length);
  
  console.log(`\n--- ${name} [${inst.className}] bodyStart=${inst.bodyStart}, afterCT=${start}, endPos=${endPos} ---`);
  for (let off = start; off < dumpEnd; off += 16) {
    const slice = sym2.slice(off, Math.min(off + 16, dumpEnd));
    const hexStr = [...slice].map(b => hex(b)).join(' ');
    const ascii = [...slice].map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
    console.log(`  ${hex(off, 4)}: ${hexStr.padEnd(48)}  ${ascii}`);
  }
}

// Also check if any CPicText has extra data beyond what tryParseTextInstanceAt returns
console.log("\n\n=== CPicText REMAINING DATA ===");
import { tryParseTextInstanceAt } from './src/binary-instance-decoder';
import type { DecodedInstance } from './src/binary-instance-decoder';
const texts = instances.filter(i => i.className === 'CPicText');
for (const inst of texts) {
  const match = named.find(n => n.bodyStart === inst.bodyStart);
  const name = match ? match.name : 'unnamed';
  const endPos = inst.endPos || 0;
  if (endPos <= inst.bodyStart) continue;
  // Show 48 bytes after endPos
  const start = endPos;
  const dumpEnd = Math.min(endPos + 48, sym2.length);
  if (start >= sym2.length) continue;
  const nextBytes = sym2.slice(start, dumpEnd);
  // Only print if there's non-zero data
  const hasNonZero = [...nextBytes].some(b => b !== 0);
  if (!hasNonZero) continue;
  
  console.log(`\n--- ${name} [CPicText] bodyStart=${inst.bodyStart}, endPos=${endPos} ---`);
  for (let off = start; off < dumpEnd; off += 16) {
    const slice = sym2.slice(off, Math.min(off + 16, dumpEnd));
    const hexStr = [...slice].map(b => hex(b)).join(' ');
    const ascii = [...slice].map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
    console.log(`  ${hex(off, 4)}: ${hexStr.padEnd(48)}  ${ascii}`);
  }
}

console.log('\nDone.');
