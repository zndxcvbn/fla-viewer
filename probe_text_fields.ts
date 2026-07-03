import { readFileSync } from 'fs';
import { OLE2File } from './src/ole2-reader';
import { scanForInstances, scanNamedInstances } from './src/binary-instance-decoder';

function hex(v: number, w = 2): string {
  return v.toString(16).padStart(w, '0');
}

function dumpBody(data: Uint8Array, bodyStart: number, label: string) {
  const start = bodyStart;
  const end = Math.min(bodyStart + 250, data.length);
  console.log(`\n=== ${label} (bodyStart=${bodyStart}, len=${end - start}) ===`);
  for (let off = 0; off < end - start; off += 16) {
    const addr = start + off;
    const slice = data.slice(addr, Math.min(addr + 16, end));
    const hexStr = [...slice].map(b => hex(b)).join(' ');
    const ascii = [...slice].map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
    console.log(`  ${hex(addr, 4)}: ${hexStr.padEnd(48)}  ${ascii}`);
  }
}

const flaPath = 'src/__tests__/fixtures/cs4/itemcard.fla';
const bytes = readFileSync(flaPath);
const ole = new OLE2File(new Uint8Array(bytes));

const streams = ole.listStreams();

// Scan ALL streams for CPicText instances
for (const entry of streams) {
  const name = entry.name;
  const data = ole.readStream(name);

  const instances = scanForInstances(data);
  const texts = instances.filter(i => i.className === 'CPicText');
  if (texts.length === 0) continue;

  const named = scanNamedInstances(data);
  for (const t of texts) {
    const match = named.find(n => n.bodyStart === t.bodyStart);
    const label = match
      ? `${name} [${match.type}] "${match.name}"`
      : `${name} [unnamed text]`;
    dumpBody(data, t.bodyStart, label);
  }
}

console.log('\nDone.');
