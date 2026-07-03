import { ByteReader, readShapeData } from './binary-shape-decoder';
import { extractLayers, type BinaryLayerInfo } from './binary-fla-structure';
import { scanCArchiveObjectStarts } from './binary-carchive';
import {
  FLASH_STRING_BOM,
  decodeUtf16Le,
  readFlashStringAt,
} from './binary-flash-string';

export interface DecodedKeyframe {
  startIndex: number;
  duration: number;
  keyMode?: number;
  bodyStart: number;
  bodyEnd: number;
  label?: string;
  acceleration?: number;
  tweenType?: 'motion' | 'shape' | 'none';
  motionTweenRotate?: 'cw' | 'ccw' | 'none';
  motionTweenRotateTimes?: number;
  motionTweenScale?: boolean;
  motionTweenOrientToPath?: boolean;
  soundRef?: number;
}

export interface DecodedTimelineLayer {
  name: string;
  schema: number;
  /** Original CPicLayer index in the native CArchive order, when available. */
  sourceLayerIndex?: number;
  typeByte?: number;
  locked: boolean;
  visible: boolean;
  parentLayerIndex?: number;
  keyframes: DecodedKeyframe[];
}

export interface DecodedFrameLabel {
  label: string;
  id: number;
  /** Byte offset of the label signature in the stream (for per-keyframe attribution). */
  bodyStart: number;
}

export interface DecodedStreamTimeline {
  layers: DecodedTimelineLayer[];
  totalFrames: number;
  frameLabels?: DecodedFrameLabel[];
}

export interface DecodedFrameScript {
  bodyStart: number;
  source: string;
}

interface ScannedTimelineObj {
  cls: string;
  bodyStart: number;
}

// Линейный сканер: находит точные границы кадров и слоев в файле
function scanTimelineObjects(data: Uint8Array): ScannedTimelineObj[] {
  return scanCArchiveObjectStarts(data)
    .filter((o) => o.className === 'CPicLayer' || o.className === 'CPicFrame')
    .map((o) => ({ cls: o.className, bodyStart: o.bodyStart }));
}

// Извлекает длительность кадра, твин-свойства, звук и лейбл в пределах body range
function getFrameDurationAndLabel(data: Uint8Array, bodyStart: number, bodyEnd: number): {
  duration: number;
  label?: string;
  acceleration?: number;
  tweenType?: 'motion' | 'shape' | 'none';
  motionTweenRotate?: 'cw' | 'ccw' | 'none';
  motionTweenRotateTimes?: number;
  motionTweenScale?: boolean;
  motionTweenOrientToPath?: boolean;
  soundRef?: number;
} {
  const schema = data[bodyStart];
  if (schema !== 0x05 && schema !== 0x02) return { duration: 1 };

  const sentinel = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80]);
  const limit = Math.min(data.length - 20, bodyStart + 5000, bodyEnd);

  // Находим первый сентинел в пределах body range
  for (let i = bodyStart; i < limit; i++) {
    let match = true;
    for (let j = 0; j < 10; j++) {
      if (data[i + j] !== sentinel[j]) { match = false; break; }
    }
    if (!match) continue;

    let pos = i + 10;
    if (schema >= 3) pos += 1;
    if (schema >= 4) pos += 1;
    if (pos + 30 > data.length) break;

    try {
      const r = new ByteReader(data);
      r.pos = pos;
      const shapeSchema = r.u8();
      if (shapeSchema !== 0 && shapeSchema !== 0xff && (shapeSchema < 1 || shapeSchema > 20)) continue;
      
      if (shapeSchema !== 0xff && shapeSchema !== 0) {
        for (let j = 0; j < 6; j++) r.u32();
        const sd = readShapeData(r, shapeSchema > 2);
        if (sd.shapeDataSchema > 4) {
          const cubicCount = r.s32();
          if (cubicCount > 0 && cubicCount < 100000) r.pos += cubicCount * 32;
        }
      }

      const frameSchema = r.u8();
      const duration = r.u16();
      if (duration < 1 || duration >= 16000) continue;

      // Читаем schema-зависимый хвост CPicFrame (FORMAT.md §4 / §10)
      let acceleration: number | undefined;
      let tweenType: 'motion' | 'shape' | 'none' | undefined;
      let motionTweenRotate: 'cw' | 'ccw' | 'none' | undefined;
      let motionTweenRotateTimes: number | undefined;
      let motionTweenScale: boolean | undefined;
      let motionTweenOrientToPath: boolean | undefined;
      let soundRef: number | undefined;

      if (frameSchema >= 10) {
        const tweenByte = r.u8();
        if (tweenByte === 1) tweenType = 'motion';
        else if (tweenByte === 2) tweenType = 'shape';
        else tweenType = 'none';
      }
      if (frameSchema >= 12) {
        const easeRaw = r.s32();
        acceleration = easeRaw / 65536;
      }
      if (frameSchema >= 14) {
        const rotByte = r.u8();
        if (rotByte === 1) motionTweenRotate = 'cw';
        else if (rotByte === 2) motionTweenRotate = 'ccw';
        else motionTweenRotate = 'none';
        motionTweenRotateTimes = r.u16();
        motionTweenScale = r.u8() !== 0;
      }
      if (frameSchema >= 16) {
        motionTweenOrientToPath = r.u8() !== 0;
      }
      if (frameSchema >= 18) {
        soundRef = r.u32();
      }

      // Читаем лейбл кадра из хвоста (после структурированных полей)
      let label: string | undefined;
      try {
        const labelLimit = Math.min(data.length - 4, r.pos + 120);
        for (let p = r.pos; p < labelLimit; p++) {
          if (data[p] === 0xff && data[p+1] === 0xfe && data[p+2] === 0xff) {
            const len = data[p+3];
            if (len > 0 && len < 64 && p + 4 + len * 2 <= labelLimit) {
              let valid = true;
              for (let j = 0; j < len; j++) {
                const c = data[p + 4 + j * 2] | (data[p + 4 + j * 2 + 1] << 8);
                if (c < 0x20 || c > 0x7e) { valid = false; break; }
              }
              if (valid) {
                label = decodeUtf16Le(data, p + 4, len * 2);
                break;
              }
            }
          }
        }
      } catch (e) { /* ignore */ }

      return { duration, label, acceleration, tweenType, motionTweenRotate, motionTweenRotateTimes, motionTweenScale, motionTweenOrientToPath, soundRef };
    } catch (e) {
      continue;
    }
  }

  return { duration: 1 };
}

interface LayerRecord {
  name: string;
  pos: number;
  schema: number;
}

function findLayerRecords(data: Uint8Array): LayerRecord[] {
  const sig = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00, 0x00, 0x80]);
  const results: LayerRecord[] = [];
  
  for (let pos = 0; pos <= data.length - sig.length; pos++) {
    let schemaPos: number | null = null;
    if (matchesAt(data, sig, pos)) {
      schemaPos = pos + sig.length;
    } else if (data[pos] === 0x00 && data[pos + 1] === 0x00) {
      const maybeSchema = data[pos + 10];
      const maybeBom = data[pos + 11];
      if (maybeSchema >= 1 && maybeSchema <= 63 && maybeBom === 0xff) {
        schemaPos = pos + 10;
      }
    }
    if (schemaPos === null) continue;
    
    const schema = data[schemaPos];
    const bomPos = schemaPos + 1;
    if (schema < 1 || schema > 63 || !matchesAt(data, FLASH_STRING_BOM, bomPos)) continue;
    
    const lenPos = bomPos + FLASH_STRING_BOM.length;
    const charLen = data[lenPos];
    const nameStart = lenPos + 1;
    const nameEnd = nameStart + charLen * 2;
    if (charLen === 0 || nameEnd > data.length) continue;
    
    const name = decodeUtf16Le(data, nameStart, charLen * 2);
    results.push({ name, pos, schema });
    pos = nameEnd;
  }
  return results;
}

function matchesAt(hay: Uint8Array, needle: Uint8Array, at: number): boolean {
  if (at < 0 || at + needle.length > hay.length) return false;
  for (let j = 0; j < needle.length; j++) {
    if (hay[at + j] !== needle[j]) return false;
  }
  return true;
}

function trimOutlierLayers(layers: DecodedTimelineLayer[]): DecodedTimelineLayer[] {
  if (layers.length < 3) return layers;

  const totals = layers.map(l => {
    if (l.keyframes.length === 0) return 0;
    const last = l.keyframes[l.keyframes.length - 1];
    return last.startIndex + last.duration;
  });

  // Find mode total
  const freq = new Map<number, number>();
  for (const t of totals) {
    if (t === 0) continue;
    freq.set(t, (freq.get(t) || 0) + 1);
  }
  if (freq.size === 0) return layers;

  let modeTotal = 0;
  let modeCount = 0;
  for (const [t, c] of freq) {
    if (c > modeCount) { modeTotal = t; modeCount = c; }
  }

  const maxTotal = Math.max(...totals);
  if (modeTotal >= maxTotal) return layers;

  // Only trim if mode appears in >= 80% of layers
  if (modeCount < layers.length * 0.8) return layers;

  const tolerance = 0;

  return layers.map(l => {
    if (l.keyframes.length === 0) return l;
    const last = l.keyframes[l.keyframes.length - 1];
    const currentTotal = last.startIndex + last.duration;
    if (currentTotal <= modeTotal + tolerance) return l;

    const trimmed = [...l.keyframes];
    while (trimmed.length > 0) {
      const tLast = trimmed[trimmed.length - 1];
      if (tLast.startIndex + tLast.duration > modeTotal + tolerance && !tLast.label) {
        trimmed.pop();
      } else {
        break;
      }
    }
    if (trimmed.length === 0) return l;

    return { ...l, keyframes: trimmed };
  });
}

export function decodeStreamTimeline(data: Uint8Array): DecodedStreamTimeline | null {
  const objects = scanTimelineObjects(data);
  if (objects.length === 0) return null;
  
  const fallbackLayers = extractLayers(data);
  if (fallbackLayers.length === 0) return null;
  
  const layerRecords = findLayerRecords(data);
  if (layerRecords.length === 0) return fallbackToSingleFrame(data, fallbackLayers);
  
  // Assign frames to layers by byte-range containment.
  // Layer N's byte range: [layerRecords[N-1].pos, layerRecords[N].pos) with N=0 as [0, layerRecords[0].pos)
  const framePositions = objects.filter(o => o.cls === 'CPicFrame').map(o => o.bodyStart);
  
  const layers: DecodedTimelineLayer[] = layerRecords.map((lr, li) => {
    const layerName = li < fallbackLayers.length ? fallbackLayers[li].name : lr.name;
    const fl = li < fallbackLayers.length ? fallbackLayers[li] : null;
    return {
      name: layerName,
      schema: lr.schema,
      typeByte: fl ? layerTypeByte(fl.layerType) : 0,
      locked: fl ? fl.locked : false,
      visible: fl ? fl.visible : true,
      keyframes: []
    };
  });
  
  // Assign frames to layers by byte position
  for (let fi = 0; fi < framePositions.length; fi++) {
    const framePos = framePositions[fi];
    const bodyEnd = fi + 1 < framePositions.length ? framePositions[fi + 1] : data.length;
    
    // Find which layer this frame belongs to
    let layerIdx = -1;
    if (framePos < layerRecords[0].pos) {
      layerIdx = 0; // Before first record → first layer
    } else {
      for (let li = 0; li < layerRecords.length - 1; li++) {
        if (framePos >= layerRecords[li].pos && framePos < layerRecords[li + 1].pos) {
          layerIdx = li + 1;
          break;
        }
      }
      if (layerIdx === -1 && framePos >= layerRecords[layerRecords.length - 1].pos) {
        layerIdx = layerRecords.length - 1; // Past last record → last layer
      }
    }
    
    if (layerIdx === -1 || layerIdx >= layers.length) continue;
    
    const frameInfo = getFrameDurationAndLabel(data, framePos, bodyEnd);
    
    const layer = layers[layerIdx];
    const startIndex = layer.keyframes.length > 0 
      ? layer.keyframes[layer.keyframes.length - 1].startIndex + layer.keyframes[layer.keyframes.length - 1].duration 
      : 0;
    
    if (startIndex + frameInfo.duration > 10000) continue; // Sanity check
    
    layer.keyframes.push({
      startIndex,
      duration: frameInfo.duration,
      bodyStart: framePos,
      bodyEnd,
      label: frameInfo.label,
      acceleration: frameInfo.acceleration,
      tweenType: frameInfo.tweenType,
      motionTweenRotate: frameInfo.motionTweenRotate,
      motionTweenRotateTimes: frameInfo.motionTweenRotateTimes,
      motionTweenScale: frameInfo.motionTweenScale,
      motionTweenOrientToPath: frameInfo.motionTweenOrientToPath,
      soundRef: frameInfo.soundRef,
    });
  }
  
  // Remove layers with no frames
  let validLayers = layers.filter(l => l.keyframes.length > 0);
  if (validLayers.length === 0) return fallbackToSingleFrame(data, fallbackLayers);
  
  // Normalize layer totals: if the vast majority of layers agree on a total,
  // trim outlier layers whose total exceeds the consensus (likely false-positive backrefs)
  validLayers = trimOutlierLayers(validLayers);
  
  let totalFrames = 1;
  for (const layer of validLayers) {
    if (layer.keyframes.length > 0) {
      const last = layer.keyframes[layer.keyframes.length - 1];
      totalFrames = Math.max(totalFrames, last.startIndex + last.duration);
    }
  }
  
  const labels = extractFrameLabelsAll(data);
  let frameLabels: DecodedFrameLabel[] | undefined;
  if (labels.length > 0) frameLabels = labels;
  
  return { layers: validLayers, totalFrames, frameLabels };
}

function layerTypeByte(layerType: BinaryLayerInfo['layerType']): number {
  switch (layerType) {
    case 'guide': return 1;
    case 'mask': return 3;
    case 'masked': return 4;
    case 'folder': return 5;
    default: return 0;
  }
}

function fallbackToSingleFrame(data: Uint8Array, fallbackLayers: BinaryLayerInfo[]): DecodedStreamTimeline | null {
  const layers: DecodedTimelineLayer[] = fallbackLayers.map(fl => ({
    name: fl.name,
    schema: fl.schema,
    typeByte: layerTypeByte(fl.layerType),
    locked: fl.locked,
    visible: fl.visible,
    keyframes: [{ startIndex: 0, duration: 1, bodyStart: 0, bodyEnd: data.length }]
  }));
  const labels = extractFrameLabelsAll(data);
  return { layers, totalFrames: 1, frameLabels: labels.length > 0 ? labels : undefined };
}

export function attributeToFrames<T extends { bodyStart: number }>(
  keyframes: DecodedKeyframe[],
  items: T[]
): { perKeyframe: T[][]; unattributed: T[] } {
  const perKeyframe: T[][] = keyframes.map(() => []);
  const unattributed: T[] = [];
  for (const item of items) {
    let placed = false;
    for (let i = 0; i < keyframes.length; i++) {
      const kf = keyframes[i];
      if (item.bodyStart >= kf.bodyStart && item.bodyStart < kf.bodyEnd) {
        perKeyframe[i].push(item);
        placed = true;
        break;
      }
    }
    if (!placed) unattributed.push(item);
  }
  return { perKeyframe, unattributed };
}

export function extractFrameLabelsAll(data: Uint8Array): DecodedFrameLabel[] {
  return extractFrameLabels(data, 0);
}

export function extractFrameLabels(data: Uint8Array, pageEnd: number): DecodedFrameLabel[] {
  const labels: DecodedFrameLabel[] = [];
  const headFixed: [number, number][] = [[0, 0xFF], [1, 0xFF], [2, 0xFF], [3, 0x3F], [6, 0xFF], [7, 0xFE], [8, 0xFF]];
  const TAIL = [0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00];
  
  for (let i = pageEnd; i + 11 <= data.length; i++) {
    let match = true;
    for (const [pos, val] of headFixed) {
      if (data[i + pos] !== val) { match = false; break; }
    }
    if (!match) continue;
    
    const len = data[i + 9];
    const textEnd = i + 10 + len * 2;
    if (len < 1 || len > 50 || textEnd + 1 + TAIL.length > data.length) continue;
    
    let valid = true;
    for (let j = 0; j < len; j++) {
      const c = data[i + 10 + j * 2] | (data[i + 11 + j * 2] << 8);
      if (c < 0x20 || c > 0x7e) { valid = false; break; }
    }
    if (!valid) continue;
    
    let tailOk = true;
    for (let j = 0; j < TAIL.length; j++) {
      if (data[textEnd + 1 + j] !== TAIL[j]) { tailOk = false; break; }
    }
    if (!tailOk) continue;
    
    const text = decodeUtf16Le(data, i + 10, len * 2);
    if (labels.some((l) => l.label === text)) continue;
    
    const idOffset = textEnd + 1 + TAIL.length;
    const id = idOffset + 4 <= data.length
      ? data[idOffset] | (data[idOffset + 1] << 8) | (data[idOffset + 2] << 16) | (data[idOffset + 3] << 24)
      : 0;
    labels.push({ label: text, id: id >>> 0, bodyStart: i });
  }
  return labels;
}

const AS_SOURCE_HINT = /\bfunction\b|\bimport\b|#initclip|gotoAnd|\btrace\(|\bstop\(|\breturn\b|\bvar\b|;\s/;
const SHORT_SCRIPT_RE = /[A-Za-z_$][\w$.]*\s*\([^)]*\)\s*;/;

export function extractFrameScripts(data: Uint8Array): DecodedFrameScript[] {
  const out: DecodedFrameScript[] = [];
  for (let p = 0; p + 4 <= data.length; p++) {
    const decoded = readFlashStringAt(data, p, { allowExtended: true });
    if (!decoded || decoded.charLength < 4) continue;
    
    if (decoded.extended ? AS_SOURCE_HINT.test(decoded.value) : SHORT_SCRIPT_RE.test(decoded.value)) {
      out.push({ bodyStart: p, source: decoded.value });
    }
    p = decoded.end - 1;
  }
  return out;
}
