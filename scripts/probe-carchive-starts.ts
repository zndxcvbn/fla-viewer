import fs from 'node:fs';
import { OLE2File } from '../src/ole2-reader';
import { scanCArchiveObjectStarts } from '../src/binary-carchive';

const [,, flaPath, streamName, startArg, endArg] = process.argv;
if (!flaPath || !streamName || !startArg || !endArg) {
  throw new Error('usage: tsx scripts/probe-carchive-starts.ts <fla> <stream> <start> <end>');
}

const data = new OLE2File(new Uint8Array(fs.readFileSync(flaPath))).readStream(streamName);
const start = Number(startArg);
const end = Number(endArg);
const classes = new Set(['CPicPage', 'CPicLayer', 'CPicFrame', 'CPicShape', 'CPicSprite', 'CPicSymbol', 'CPicButton', 'CPicShapeObj', 'CPicText']);
const starts = scanCArchiveObjectStarts(data, classes).filter((object) => object.bodyStart >= start && object.bodyStart <= end);
for (const object of starts) {
  console.log(`${object.bodyStart}: ${object.className} via=${object.recoveredVia}`);
}
