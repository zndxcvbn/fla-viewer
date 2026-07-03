import fs from 'node:fs';
import path from 'node:path';
import { extractBinaryFLAInfo } from '../src/binary-fla-parser';

const CS4_FIXTURES = path.resolve('src/__tests__/fixtures/cs4');

const cases = [
  {
    key: 'favorites',
    fla: path.join(CS4_FIXTURES, 'favoritesmenu.fla'),
    needles: ['FavoritesMenu', 'itemList', 'navPanel', 'filterFlag', 'true', 'false'],
  },
  {
    key: 'itemcard',
    fla: path.join(CS4_FIXTURES, 'itemcard.fla'),
    needles: ['ItemCard', 'WeaponDamageValue', 'BookDescriptionLabel', 'WeaponDamageLabel'],
  },
  {
    key: 'configpanel',
    fla: path.join(CS4_FIXTURES, 'configpanel.fla'),
    needles: ['SubListFader', 'ModListFader', 'show', 'hide', 'fadeIn', 'fadeOut'],
  },
  {
    key: 'quest',
    fla: path.join(CS4_FIXTURES, 'quest_journal.fla'),
    needles: ['Quest_Journal', 'QuestsTab', 'StatsTab', 'SystemTab', 'true'],
  },
] as const;

for (const c of cases) {
  console.log(`\n## ${c.key}`);
  const info = extractBinaryFLAInfo(new Uint8Array(fs.readFileSync(c.fla)));
  const libs = info.library.filter((entry) =>
    c.needles.some((needle) => entry.name.includes(needle)) ||
    c.needles.some((needle) => info.linkageBySymbol.get(entry.symbolNumber)?.className.includes(needle))
  );
  console.log('library hits', libs.map((entry) =>
    `${entry.symbolNumber}:${entry.name}:${entry.symbolType}:${info.linkageBySymbol.get(entry.symbolNumber)?.className ?? ''}`
  ).join(' | '));
  const libNums = new Set(libs.map((entry) => entry.symbolNumber));
  for (const [num, linkage] of info.linkageBySymbol) {
    if (c.needles.some((needle) => linkage.className.includes(needle) || linkage.identifier.includes(needle) || linkage.boundName?.includes(needle))) {
      libNums.add(num);
      console.log('linkage hit', num, linkage);
    }
  }

  const inspectNums = new Set<number>(libNums);
  for (const [num, named] of info.symbolNamed) {
    if (named.some((entry) => c.needles.includes(entry.name))) inspectNums.add(num);
  }
  for (const [num, insts] of info.symbolInstances) {
    if (insts.some((inst) => c.needles.includes(inst.instanceName) || c.needles.includes(inst.textData?.characters ?? ''))) {
      inspectNums.add(num);
    }
  }
  for (const [num, timeline] of info.symbolTimelines) {
    if (timeline.frameLabels?.some((label) => c.needles.includes(label.label))) inspectNums.add(num);
  }

  for (const num of [...inspectNums].sort((a, b) => a - b)) {
    const entry = info.library.find((candidate) => candidate.symbolNumber === num);
    console.log(`SYM#${num} ${entry?.name ?? ''} class=${info.linkageBySymbol.get(num)?.className ?? ''}`);
    const named = info.symbolNamed.get(num) ?? [];
    const insts = info.symbolInstances.get(num) ?? [];
    const tl = info.symbolTimelines.get(num);
    console.log(' named', named.filter((entry) => c.needles.includes(entry.name)).map((entry) => `${entry.name}@${entry.bodyStart}:${entry.className}`).join(', '));
    console.log(' insts', insts
      .filter((inst) => c.needles.includes(inst.instanceName) || c.needles.includes(inst.textData?.characters ?? ''))
      .map((inst) => `${inst.instanceName || '(blank)'}:${inst.className}:ref=${inst.mediaRef}:alt=${inst.altMediaRef}:text=${inst.textData?.characters ?? ''}@${inst.bodyStart}-${inst.endPos}`)
      .join(', '));
    console.log(' allInstNames', insts.filter((inst) => inst.instanceName).map((inst) => inst.instanceName).join(', '));
    console.log(' labels', tl?.frameLabels?.map((label) => `${label.label}@${label.id}/${label.bodyStart}`).join(', ') ?? '');
  }
}
