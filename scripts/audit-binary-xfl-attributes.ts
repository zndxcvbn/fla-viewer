import { readdir, readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';

type Coverage = 'parsed' | 'partial' | 'missing' | 'not-modeled' | 'editor-only';

interface AttrStat {
  tag: string;
  attr: string;
  count: number;
  files: Set<string>;
}

interface CoverageInfo {
  status: Coverage;
  note: string;
}

const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*"[^"]*"/g;
const TAG_RE = /<([A-Za-z_][\w:.-]*)\b([^<>]*?)(?:\/?)>/g;

const coverage = new Map<string, CoverageInfo>();

function key(tag: string, attr: string): string {
  return `${tag}.${attr}`;
}

function set(tag: string, attrs: string[], status: Coverage, note: string): void {
  for (const attr of attrs) coverage.set(key(tag, attr), { status, note });
}

function initCoverage(): void {
  set('DOMDocument', ['width', 'height', 'frameRate', 'backgroundColor'], 'parsed', 'Contents/publish settings -> FLADocument');
  set('DOMDocument', ['currentTimeline'], 'missing', 'main timeline selection not decoded from binary');
  set('DOMDocument', ['xflVersion', 'creatorInfo', 'platform', 'versionInfo'], 'editor-only', 'not used by viewer/runtime model');
  set('DOMDocument', ['xmlns', 'xmlns:xsi', 'buildNumber', 'majorVersion', 'nextSceneIdentifier'], 'editor-only', 'CS6/editor metadata');
  set('DOMDocument', ['gridColor', 'gridSnapAccuracy', 'gridSnapTo', 'gridSpacingX', 'gridSpacingY', 'guidesColor', 'guidesSnapAccuracy', 'guidesSnapTo', 'guidesVisible', 'objectsSnapTo', 'snapAlignBorderSpacing', 'snapAlignHorizontalSpacing', 'snapAlignVerticalSpacing', 'timelineLabelWidth', 'viewOptionsLivePreview'], 'editor-only', 'authoring UI settings, not runtime timeline content');
  set('DOMDocument', ['playOptionsPlayFrameActions', 'playOptionsPlayLoop', 'playOptionsPlayPages', 'useCarbonLineSpacing', 'sharedLibraryURL'], 'not-modeled', 'publish/editor option not represented in current FLADocument model');
  set('DOMDocument', ['vanishingPoint3DX', 'vanishingPoint3DY', 'viewAngle3D'], 'missing', '3D document view fields are not decoded');

  set('DOMTimeline', ['name'], 'parsed', 'scene/library timeline name');

  set('DOMLayer', ['name', 'visible', 'locked', 'layerType', 'parentLayerIndex'], 'parsed', 'native CPicLayer + parent layer refs');
  set('DOMLayer', ['color', 'outline', 'height'], 'editor-only', 'timeline authoring UI state, not runtime timeline content');
  set('DOMLayer', ['autoNamed', 'current', 'isSelected', 'useOutlineView', 'animationType'], 'editor-only', 'authoring UI state');

  set('DOMFrame', ['index', 'duration', 'name'], 'parsed', 'native CPicFrame duration + label');
  set('DOMFrame', ['tweenType', 'acceleration', 'motionTweenRotate', 'motionTweenRotateTimes', 'motionTweenScale', 'motionTweenOrientToPath'], 'partial', 'tail fields are read, but easing/custom tween attrs are not complete');
  set('DOMFrame', ['keyMode'], 'parsed', 'native CPicFrame key-mode word is propagated to Frame.keyMode');
  set('DOMFrame', ['labelType'], 'partial', 'binary path emits name labels; anchor/comment typing not proven');
  set('DOMFrame', ['easeMethodName', 'customEase', 'useSingleEaseCurve'], 'missing', 'not decoded from CPicFrame tween/ease blocks');
  set('DOMFrame', ['soundName', 'soundSync', 'soundLoop', 'soundLoopMode'], 'missing', 'soundRef raw field exists; FrameSound join is not decoded');
  set('DOMFrame', ['bookmark', 'isMotionObject', 'motionTweenSnap', 'motionTweenSync', 'visibleAnimationKeyframes'], 'missing', 'motion object/editor tween flags not decoded');

  set('DOMSymbolItem', ['name', 'itemID', 'symbolType', 'linkageIdentifier', 'linkageClassName', 'linkageExportForAS', 'linkageExportForRS', 'linkageImportForRS', 'linkageURL'], 'parsed', 'Contents library/linkage path');
  set('DOMSymbolItem', ['linkageBaseClass'], 'missing', 'base class not decoded from binary Contents');
  set('DOMSymbolItem', ['sourceFlashFilepath', 'sourceLibraryItemHRef'], 'missing', 'CS6 import/source metadata not decoded from binary');
  set('DOMSymbolItem', ['scaleGridLeft', 'scaleGridRight', 'scaleGridTop', 'scaleGridBottom', 'scalingGrid'], 'missing', 'scale9Grid not decoded from binary symbol metadata');

  set('DOMComponentItem', ['name', 'itemID', 'symbolType', 'linkageIdentifier', 'linkageClassName', 'linkageExportForAS', 'linkageExportForRS', 'linkageImportForRS', 'linkageURL'], 'partial', 'often joins through Contents, but component item metadata is not fully typed');
  set('DOMComponentItem', ['linkageBaseClass', 'sourceFlashFilepath', 'sourceLibraryItemHRef'], 'missing', 'not decoded from binary component metadata');
  set('DOMComponentItem', ['xmlns', 'xmlns:xsi', 'customIconID', 'displayAsComponent', 'editFrameIndex', 'lastModified', 'lastUniqueIdentifier', 'parametersAreNew', 'persistLivePreview11', 'requiredMinimumASVersion', 'requiredMinimumPlayerVersion', 'sourceItemID', 'sourceLastModified'], 'editor-only', 'component library/editor metadata');
  set('DOMComponentItem', ['parametersAreLocked', 'actionscriptClass'], 'missing', 'component definition metadata not decoded');

  set('DOMSymbolInstance', ['libraryItemName', 'name'], 'parsed', 'native CPicPlacement mediaRef/name');
  set('DOMSymbolInstance', ['matrix'], 'parsed', 'child Matrix node maps to decoded matrix');
  set('DOMSymbolInstance', ['centerPoint3DX', 'centerPoint3DY', 'transformationPoint'], 'missing', 'transformation point defaults to 0,0');
  set('DOMSymbolInstance', ['symbolType'], 'partial', 'inferred from library entry/class when present');
  set('DOMSymbolInstance', ['loop'], 'partial', 'binary output now uses the XFL default loop mode; explicit single-frame/play-once tail fields are not decoded');
  set('DOMSymbolInstance', ['firstFrame', 'lastFrame'], 'missing', 'graphic playback range properties not decoded');
  set('DOMSymbolInstance', ['blendMode'], 'partial', 'schema-22 placement tail code 2 is decoded as layer; other blend modes are not proven');
  set('DOMSymbolInstance', ['isVisible', 'cacheAsBitmap'], 'missing', 'not read from placement tail');
  set('DOMSymbolInstance', ['colorMode', 'alphaMultiplier', 'redMultiplier', 'greenMultiplier', 'blueMultiplier', 'alphaOffset', 'redOffset', 'greenOffset', 'blueOffset'], 'partial', 'legacy CXForm is read for some CPicSprite/CPicButton tails');
  set('DOMSymbolInstance', ['filters'], 'partial', 'native parser decodes the observed SWF Blur/Glow/DropShadow subset');
  set('DOMSymbolInstance', ['rotationX', 'rotationY', 'rotationZ', 'z'], 'missing', 'CS4 3D placement fields not decoded');

  set('DOMComponentInstance', ['libraryItemName', 'name', 'matrix'], 'parsed', 'same CPicPlacement path as symbols');
  set('DOMComponentInstance', ['componentParameters', 'parametersAreLocked'], 'missing', 'componentDataBinding XML is captured but PD/componentParameters are not parsed');
  set('DOMComponentInstance', ['centerPoint3DX', 'centerPoint3DY'], 'missing', 'transformation point defaults to 0,0');
  set('DOMComponentInstance', ['selected', 'uniqueID'], 'editor-only', 'authoring selection/id metadata');
  set('DOMComponentInstance', ['loop'], 'partial', 'binary output now uses the XFL default loop mode; explicit playback fields are not decoded');
  set('DOMComponentInstance', ['blendMode'], 'partial', 'same schema-22 placement tail path as DOMSymbolInstance');
  set('DOMComponentInstance', ['firstFrame', 'lastFrame', 'isVisible', 'cacheAsBitmap'], 'missing', 'same gaps as DOMSymbolInstance');

  set('DOMStaticText', ['name', 'width', 'height', 'left'], 'partial', 'native CPicText recovers bounds/name for observed fields');
  set('DOMDynamicText', ['name', 'width', 'height', 'left'], 'partial', 'native CPicText recovers bounds/name for observed fields');
  set('DOMInputText', ['name', 'width', 'height', 'left'], 'partial', 'same CPicText path; input-vs-dynamic typing not proven');
  for (const tag of ['DOMStaticText', 'DOMDynamicText', 'DOMInputText']) {
    set(tag, ['matrix'], 'missing', 'CPicText currently emits identity matrix');
    set(tag, ['isSelectable', 'lineType', 'renderAsHTML', 'border', 'maxCharacters', 'variableName'], 'missing', 'text field flags not decoded');
    set(tag, ['fontRenderingMode', 'includeOutlines', 'scrollable'], 'missing', 'text rendering/export flags not decoded');
    set(tag, ['selected'], 'editor-only', 'authoring selection metadata');
    set(tag, ['filters'], 'partial', 'only if placement/text tail provides parsed filters');
  }

  set('DOMTextAttrs', ['bold'], 'parsed', 'native CPicText format marker is decoded and propagated to TextRun');
  set('DOMTextAttrs', ['face', 'size', 'fillColor', 'alignment'], 'partial', 'font/size/color/alignment recovered for observed CPicText bodies');
  set('DOMTextAttrs', ['italic', 'underline', 'lineSpacing', 'letterSpacing', 'autoKern', 'indent', 'leftMargin', 'rightMargin', 'url', 'target', 'characterPosition', 'alpha'], 'missing', 'not located in binary CPicText yet');
  set('DOMTextAttrs', ['aliasText', 'bitmapSize'], 'missing', 'text rendering/export flags not decoded');

  set('DOMShape', ['matrix'], 'parsed', 'native CPicShape matrix');
  set('DOMShape', ['isDrawingObject', 'isFloating'], 'missing', 'shape authoring/object flags not decoded');
  set('DOMShape', ['selected'], 'editor-only', 'authoring selection metadata');
  set('FillStyle', ['index'], 'parsed', 'shape fill style index');
  set('SolidColor', ['color', 'alpha'], 'parsed', 'shape solid fill color');
  set('LinearGradient', ['spreadMethod', 'interpolationMethod'], 'missing', 'gradient extras are not decoded');
  set('RadialGradient', ['spreadMethod', 'interpolationMethod', 'focalPointRatio'], 'missing', 'gradient extras are not decoded');
  set('GradientEntry', ['color', 'alpha', 'ratio'], 'parsed', 'shape gradient stops');
  set('BitmapFill', ['bitmapPath', 'bitmapIsClipped', 'bitmapIsSmoothed'], 'partial', 'bitmap id is exposed as Media N; flags are not fully decoded');
  set('SolidStroke', ['weight', 'color', 'alpha', 'caps', 'joints', 'miterLimit'], 'partial', 'stroke basics decoded; full stroke style flags are incomplete');
  set('SolidStroke', ['scaleMode', 'pixelHinting'], 'missing', 'not decoded');
  set('StrokeStyle', ['index'], 'parsed', 'shape stroke style index');
  set('LinearGradientStroke', ['spreadMethod', 'interpolationMethod'], 'missing', 'gradient stroke extras are not decoded');
  set('RadialGradientStroke', ['spreadMethod', 'interpolationMethod', 'focalPointRatio'], 'missing', 'gradient stroke extras are not decoded');

  set('Matrix', ['a', 'b', 'c', 'd', 'tx', 'ty'], 'parsed', 'covered where parent element matrix is parsed');
  set('Point', ['x', 'y'], 'missing', 'transformation/center points are not decoded for instances');
  set('Color', ['alphaMultiplier', 'redMultiplier', 'greenMultiplier', 'blueMultiplier', 'alphaOffset', 'redOffset', 'greenOffset', 'blueOffset', 'tintColor', 'tintMultiplier'], 'partial', 'legacy CXForm is partially decoded; tint/colorMode mapping is incomplete');
  set('Edge', ['edges', 'cubics', 'fillStyle0', 'fillStyle1', 'strokeStyle'], 'parsed', 'shape edge stream is decoded to path commands/styles');

  for (const tag of ['DropShadowFilter', 'GlowFilter', 'BlurFilter', 'BevelFilter', 'GradientGlowFilter', 'GradientBevelFilter']) {
    set(tag, ['blurX', 'blurY', 'quality', 'color', 'alpha', 'strength', 'distance', 'angle', 'inner', 'knockout', 'hideObject', 'type'], 'partial', 'not all SWF filter ids are decoded from binary placement tails');
  }
  set('BlurFilter', ['blurX', 'blurY', 'quality'], 'parsed', 'native placement parser decodes the SWF BlurFilter body');
  set('GlowFilter', ['blurX', 'blurY', 'quality', 'color', 'alpha', 'strength', 'inner', 'knockout'], 'parsed', 'native placement parser decodes the SWF GlowFilter body');
  set('DropShadowFilter', ['blurX', 'blurY', 'quality', 'color', 'alpha', 'strength', 'distance', 'angle', 'inner', 'knockout', 'hideObject'], 'parsed', 'native placement parser decodes the SWF DropShadowFilter body');

  set('PD', ['n', 't', 'v', 'name', 'type', 'value'], 'missing', 'persistentData/component parameters not decoded into ComponentParameter[]');
  set('Actionscript', ['script'], 'parsed', 'frame scripts are extracted and attributed where possible');
  set('Include', ['href', 'itemIcon', 'itemID', 'lastModified', 'loadImmediate'], 'editor-only', 'XFL include manifest metadata');
  set('DOMFolderItem', ['name', 'itemID', 'isExpanded'], 'editor-only', 'library folder metadata');
  set('DOMFontItem', ['name', 'itemID', 'font', 'id', 'size', 'bold', 'embedRanges', 'linkageExportInFirstFrame', 'linkageIdentifier', 'linkageImportForRS', 'linkageURL', 'sourceLastImported'], 'missing', 'font library items are not decoded from binary');
  set('DOMBitmapItem', ['name', 'itemID', 'href', 'bitmapDataHRef', 'frameRight', 'frameBottom', 'compressionType', 'originalCompressionType', 'quality', 'sourceExternalFilepath', 'sourceLastImported', 'useImportedJPEGData'], 'missing', 'bitmap library/media records are not decoded from binary');
  set('Inspectable', ['name', 'variable', 'type', 'defaultValue', 'category', 'verbose'], 'missing', 'component inspectable definitions are not decoded');
  set('property', ['id'], 'editor-only', 'component definition metadata');
  set('class', ['id'], 'editor-only', 'component definition metadata');
  set('Property', ['id', 'enabled', 'ignoreTimeMap', 'readonly', 'visible'], 'missing', 'motion object property metadata not decoded');
  set('PropertyContainer', ['id'], 'missing', 'motion object property metadata not decoded');
  set('Keyframe', ['anchor', 'next', 'previous', 'roving', 'timevalue'], 'missing', 'motion object keyframe metadata not decoded');
  set('Settings', ['orientToPath', 'xformPtXOffsetPct', 'xformPtYOffsetPct', 'xformPtZOffsetPixels'], 'missing', 'motion object settings not decoded');
  set('TimeMap', ['strength', 'type'], 'missing', 'custom ease time map not decoded');
  set('AnimationCore', ['duration', 'TimeScale', 'Version'], 'missing', 'motion object animation core not decoded');
  set('DOMTimeline', ['currentFrame'], 'editor-only', 'authoring UI playhead state');
  set('DOMSymbolInstance', ['selected', 'uniqueID'], 'editor-only', 'authoring selection/id metadata');
  set('DOMSymbolItem', ['xmlns', 'xmlns:xsi', 'lastModified', 'lastUniqueIdentifier', 'sourceItemID', 'sourceLastModified', 'hasValidCenterPoint', 'transformCenterPoint', 'linkageExportInFirstFrame'], 'editor-only', 'symbol library/editor metadata');
  set('DOMComponentItem', ['scaleGridLeft', 'scaleGridRight', 'scaleGridTop', 'scaleGridBottom'], 'missing', 'scale9Grid not decoded from binary component metadata');
  set('feature', ['name', 'majorVersion', 'minorVersion', 'build'], 'editor-only', 'XFL feature metadata');
  set('flash_profile', ['name', 'current', 'version'], 'editor-only', 'publish profile metadata');
  set('linkage', ['usesDefault'], 'editor-only', 'publish profile metadata');
  set('name', ['langID', 'value'], 'editor-only', 'publish profile metadata');
  set('PublishFlashProperties', ['enabled'], 'editor-only', 'publish profile metadata');
  set('PublishFormatProperties', ['enabled'], 'editor-only', 'publish profile metadata');
  set('PublishGifProperties', ['enabled'], 'editor-only', 'publish profile metadata');
  set('PublishHtmlProperties', ['enabled'], 'editor-only', 'publish profile metadata');
  set('PublishItem', ['publishSize', 'publishTime'], 'editor-only', 'publish profile metadata');
  set('PublishJpegProperties', ['enabled'], 'editor-only', 'publish profile metadata');
  set('PublishPNGProperties', ['enabled'], 'editor-only', 'publish profile metadata');
  set('PublishQTProperties', ['enabled'], 'editor-only', 'publish profile metadata');
  set('PublishRNWKProperties', ['enabled'], 'editor-only', 'publish profile metadata');
  set('rdf:Description', ['rdf:about', 'xmlns:dc', 'xmlns:stEvt', 'xmlns:stRef', 'xmlns:xmp', 'xmlns:xmpMM'], 'editor-only', 'XMP metadata');
  set('rdf:li', ['rdf:parseType'], 'editor-only', 'XMP metadata');
  set('rdf:RDF', ['xmlns:rdf'], 'editor-only', 'XMP metadata');
  set('x:xmpmeta', ['x:xmptk', 'xmlns:x'], 'editor-only', 'XMP metadata');
  set('xmpMM:DerivedFrom', ['rdf:parseType'], 'editor-only', 'XMP metadata');
}

async function listXmlFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.xml')) out.push(full);
    }
  }
  if (statSync(root).isDirectory()) await walk(root);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function scanXml(xml: string, file: string, stats: Map<string, AttrStat>): void {
  for (const match of xml.matchAll(TAG_RE)) {
    const tag = match[1];
    if (tag.startsWith('?') || tag.startsWith('!')) continue;
    const attrText = match[2] ?? '';
    for (const attrMatch of attrText.matchAll(ATTR_RE)) {
      const attr = attrMatch[1];
      const k = key(tag, attr);
      let stat = stats.get(k);
      if (!stat) {
        stat = { tag, attr, count: 0, files: new Set() };
        stats.set(k, stat);
      }
      stat.count += 1;
      stat.files.add(file);
    }
  }
}

function coverageFor(stat: AttrStat): CoverageInfo {
  return coverage.get(key(stat.tag, stat.attr)) ?? {
    status: 'missing',
    note: 'not mapped to current binary parser/types coverage table',
  };
}

function statusOrder(status: Coverage): number {
  return { missing: 0, partial: 1, 'not-modeled': 2, parsed: 3, 'editor-only': 4 }[status];
}

async function main(): Promise<void> {
  initCoverage();
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    console.error('Usage: npx tsx scripts/audit-binary-xfl-attributes.ts <xfl-dir> [more-xfl-dirs...]');
    process.exit(2);
  }

  const stats = new Map<string, AttrStat>();
  for (const rootArg of roots) {
    const root = path.resolve(rootArg);
    for (const file of await listXmlFiles(root)) {
      scanXml(await readFile(file, 'utf8'), path.relative(root, file), stats);
    }
  }

  const rows = [...stats.values()].sort((a, b) => {
    const ca = coverageFor(a);
    const cb = coverageFor(b);
    return statusOrder(ca.status) - statusOrder(cb.status) ||
      a.tag.localeCompare(b.tag) ||
      a.attr.localeCompare(b.attr);
  });

  const totals = new Map<Coverage, number>();
  const tagTotals = new Map<string, Map<Coverage, number>>();
  for (const row of rows) {
    const info = coverageFor(row);
    totals.set(info.status, (totals.get(info.status) ?? 0) + 1);
    let byStatus = tagTotals.get(row.tag);
    if (!byStatus) {
      byStatus = new Map<Coverage, number>();
      tagTotals.set(row.tag, byStatus);
    }
    byStatus.set(info.status, (byStatus.get(info.status) ?? 0) + 1);
  }

  console.log('# Binary vs XFL Attribute Coverage');
  console.log('');
  console.log(`XFL roots: ${roots.map((r) => path.resolve(r)).join(', ')}`);
  console.log(`Unique tag attributes: ${rows.length}`);
  console.log(
    `Status totals: parsed=${totals.get('parsed') ?? 0}, partial=${totals.get('partial') ?? 0}, ` +
    `missing=${totals.get('missing') ?? 0}, not-modeled=${totals.get('not-modeled') ?? 0}, ` +
    `editor-only=${totals.get('editor-only') ?? 0}`
  );
  console.log('');
  console.log('## Tag Coverage Summary');
  console.log('');
  console.log('| Tag | Parsed | Partial | Missing | Not modeled | Editor-only | Total |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  const tagRows = [...tagTotals.entries()].sort((a, b) => {
    const missingA = a[1].get('missing') ?? 0;
    const missingB = b[1].get('missing') ?? 0;
    return missingB - missingA || a[0].localeCompare(b[0]);
  });
  for (const [tag, byStatus] of tagRows) {
    const parsed = byStatus.get('parsed') ?? 0;
    const partial = byStatus.get('partial') ?? 0;
    const missing = byStatus.get('missing') ?? 0;
    const notModeled = byStatus.get('not-modeled') ?? 0;
    const editorOnly = byStatus.get('editor-only') ?? 0;
    const total = parsed + partial + missing + notModeled + editorOnly;
    console.log(`| \`${tag}\` | ${parsed} | ${partial} | ${missing} | ${notModeled} | ${editorOnly} | ${total} |`);
  }
  console.log('');
  console.log('## Attribute Details');
  console.log('');
  console.log('| Status | Tag.attr | Count | Files | Note |');
  console.log('|---|---:|---:|---:|---|');
  for (const row of rows) {
    const info = coverageFor(row);
    console.log(`| ${info.status} | \`${row.tag}.${row.attr}\` | ${row.count} | ${row.files.size} | ${info.note.replace(/\|/g, '/')} |`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
