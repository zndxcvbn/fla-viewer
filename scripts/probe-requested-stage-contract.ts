import fs from 'node:fs';
import path from 'node:path';
import { DOMParser } from 'linkedom';
import { FLAParser } from '../src/fla-parser';

type ElementInfo = {
  type: string;
  name?: string;
  libraryItemName?: string;
  frame: number;
  layer: string;
  text?: string;
};

type LabelInfo = {
  label: string;
  frame: number;
  layer: string;
};

const CS4_FIXTURES = path.resolve('src/__tests__/fixtures/cs4');

function walkTimeline(timeline: any): { elements: ElementInfo[]; labels: LabelInfo[] } {
  const elements: ElementInfo[] = [];
  const labels: LabelInfo[] = [];
  for (const layer of timeline.layers ?? []) {
    for (const frame of layer.frames ?? []) {
      if (frame.label) {
        labels.push({ label: frame.label, frame: frame.index, layer: layer.name });
      }
      for (const element of frame.elements ?? []) {
        elements.push({
          type: element.type,
          name: element.name,
          libraryItemName: element.libraryItemName,
          frame: frame.index,
          layer: layer.name,
          text: element.type === 'text'
            ? element.textRuns?.map((run: any) => run.characters).join('')
            : undefined,
        });
      }
    }
  }
  return { elements, labels };
}

const cases = [
  {
    key: 'favorites',
    fla: path.join(CS4_FIXTURES, 'favoritesmenu.fla'),
    symbolHints: ['FavoritesMenu'],
    expected: ['itemList'],
  },
  {
    key: 'itemcard',
    fla: path.join(CS4_FIXTURES, 'itemcard.fla'),
    symbolHints: ['ItemCard', 'Sprite 2', 'Symbol 2'],
    expected: ['WeaponDamageValue', 'BookDescriptionLabel'],
  },
  {
    key: 'configpanel',
    fla: path.join(CS4_FIXTURES, 'configpanel.fla'),
    symbolHints: ['SubListFader'],
    expected: ['show', 'hide'],
  },
  {
    key: 'quest',
    fla: path.join(CS4_FIXTURES, 'quest_journal.fla'),
    symbolHints: ['Quest_Journal'],
    expected: ['QuestsTab', 'StatsTab', 'SystemTab'],
  },
] as const;

for (const c of cases) {
  console.log(`\n## ${c.key}`);
  const doc = await new FLAParser({ DOMParser: DOMParser as any }).parse(
    new Uint8Array(fs.readFileSync(c.fla)),
    undefined,
    undefined,
    { structureOnly: true }
  );
  console.log(`symbols=${doc.symbols.size} timelines=${doc.timelines.length} docClass=${doc.documentClass ?? ''}`);

  for (const [name, symbol] of doc.symbols) {
    const { elements, labels } = walkTimeline(symbol.timeline);
    const hit =
      c.symbolHints.some((hint) => name.includes(hint) || symbol.linkageClassName?.includes(hint)) ||
      c.expected.some((expected) =>
        elements.some((element) => element.name === expected) ||
        labels.some((label) => label.label === expected)
      );
    if (!hit) continue;
    console.log(`SYM ${name} class=${symbol.linkageClassName ?? ''}`);
    console.log(
      ` children=${elements
        .filter((element) => element.name)
        .map((element) => `${element.name}:${element.type}:${element.libraryItemName ?? ''}`)
        .join(', ')}`
    );
    console.log(` labels=${labels.map((label) => `${label.label}@${label.frame}/${label.layer}`).join(', ')}`);
  }

  for (const [index, timeline] of doc.timelines.entries()) {
    const { elements, labels } = walkTimeline(timeline);
    const hits = c.expected.filter((expected) =>
      elements.some((element) => element.name === expected) ||
      labels.some((label) => label.label === expected)
    );
    if (hits.length === 0) continue;
    console.log(`ROOT ${index} hits=${hits.join(',')}`);
    console.log(
      ` children=${elements
        .filter((element) => element.name)
        .map((element) => `${element.name}:${element.type}:${element.libraryItemName ?? ''}`)
        .join(', ')}`
    );
    console.log(` labels=${labels.map((label) => label.label).join(', ')}`);
  }
}
