// Validation / normalization of model output. The client must always receive the exact
// AnalysisResult / ReferenceAnalysis shape, even if the model omits or mistypes fields.
// Missing information is filled with 'Unknown' — never with invented content.

import type { AnalysisObject, AnalysisResult, AnalysisTextTh, ReferenceAnalysis } from '../src/types/index';

export const UNKNOWN = 'Unknown';
const MAX_TEXT = 600;
/** Reference category descriptions are the only carrier of a reference into a text prompt, so allow more. */
const MAX_REF_TEXT = 1600;
const MAX_LIST = 24;
const MAX_OBJECTS = 40;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Clamp to 0..1. Accepts 0..100 percentages. Returns null when not a finite number. */
export function clampConfidence(v: unknown): number | null {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v.replace('%', '')))) {
    n = Number(v.replace('%', ''));
  } else return null;
  if (!Number.isFinite(n)) return null;
  // Values like 85 or "70%" are percentages; slightly-over-1 values (1.2) are just clamped.
  if (n >= 2 && n <= 100) n = n / 100;
  const c = Math.min(1, Math.max(0, n));
  return Math.round(c * 1000) / 1000;
}

/** Non-empty trimmed string or 'Unknown'. Numbers are stringified. */
export function text(v: unknown, max = MAX_TEXT): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return UNKNOWN;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || /^(n\/a|none|null|undefined|-)$/i.test(s)) return UNKNOWN;
  if (s.length <= max) return s;
  // Cut at the last sentence end that keeps most of the text, so no clause is left half-written.
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return end > max * 0.6 ? cut.slice(0, end + 1) : cut.slice(0, max - 1) + '…';
}

/** List of non-empty strings; a single string becomes a one-item list. Unknown-only entries are dropped. */
export function list(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const out: string[] = [];
  for (const item of arr) {
    const s = text(item);
    if (s !== UNKNOWN && !out.includes(s)) out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Thai mirror                                                          */
/* ------------------------------------------------------------------ */
// The Thai text is optional: anything missing or invalid stays undefined (never 'Unknown'),
// and the client falls back to the English text for that key.

/**
 * Thai text with the same length rule as text(). Thai rarely uses '. ', so an overlong text is cut
 * at a sentence end when possible, else at the last space (Thai separates phrases with spaces),
 * else hard. Returns undefined for missing / empty / placeholder values.
 */
export function textTh(v: unknown, max = MAX_TEXT): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s || /^(n\/a|none|null|undefined|-)$/i.test(s)) return undefined;
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  if (end > max * 0.6) return cut.slice(0, end + 1);
  const space = cut.lastIndexOf(' ');
  if (space > max * 0.6) return cut.slice(0, space) + '…';
  return cut.slice(0, max - 1) + '…';
}

const TH_UNKNOWN_RE = /^(ไม่ทราบ|unknown)$/i;

/** Thai list; undefined when not provided or empty. Unknown-only entries are dropped (like list()). */
export function listTh(v: unknown): string[] | undefined {
  if (!Array.isArray(v) && typeof v !== 'string') return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of arr) {
    const s = textTh(item);
    if (s && !TH_UNKNOWN_RE.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX_LIST) break;
  }
  // An empty Thai list carries no Thai text: leave it undefined so "has Thai" checks and the
  // English fallback agree.
  return out.length ? out : undefined;
}

/** Copy only defined values; returns undefined when nothing is left. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> | undefined {
  const out: Partial<T> = {};
  let any = false;
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) {
      (out as Record<string, unknown>)[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

const TH_CAMERA_KEYS = [
  'position', 'height', 'angle', 'direction', 'focal_length_estimate', 'perspective', 'horizon',
  'vanishing_points', 'aspect_ratio', 'composition',
] as const;
const TH_ARCH_TEXT_KEYS = ['style', 'geometry', 'massing', 'roof', 'floor_count', 'structure', 'openings', 'facade'] as const;
const TH_ARCH_LIST_KEYS = ['materials', 'colors', 'details'] as const;
const TH_ENV_TEXT_KEYS = ['road', 'sidewalk', 'terrain', 'sky', 'lighting', 'sun_direction', 'shadows', 'weather', 'time_of_day'] as const;
const TH_ENV_LIST_KEYS = ['landscape', 'hardscape'] as const;
const TH_OBJECT_KEYS = ['description', 'position', 'orientation', 'scale'] as const;

function pickTh(src: unknown, textKeys: readonly string[], listKeys: readonly string[] = []) {
  const r = isRec(src) ? src : {};
  const o: Record<string, unknown> = {};
  for (const k of textKeys) o[k] = textTh(r[k]);
  for (const k of listKeys) o[k] = listTh(r[k]);
  return compact(o);
}

/**
 * Normalize the model's `th` object. `objectIds` maps the RAW English objects index → normalized id,
 * because the Thai objects array is aligned with the English array the model returned.
 * An object map keyed by id ({obj_1: {...}}) is accepted too.
 */
export function normalizeTh(raw: unknown, objectIds: Map<number, string>): AnalysisTextTh | undefined {
  if (!isRec(raw)) return undefined;
  const objects: NonNullable<AnalysisTextTh['objects']> = {};
  const ids = new Set(objectIds.values());
  if (Array.isArray(raw.objects)) {
    raw.objects.forEach((o, i) => {
      const id = objectIds.get(i);
      const t = id ? pickTh(o, TH_OBJECT_KEYS) : undefined;
      if (id && t) objects[id] = t;
    });
  } else if (isRec(raw.objects)) {
    for (const [id, o] of Object.entries(raw.objects)) {
      const t = ids.has(id) ? pickTh(o, TH_OBJECT_KEYS) : undefined;
      if (t) objects[id] = t;
    }
  }
  const th: AnalysisTextTh = {};
  const camera = pickTh(raw.camera, TH_CAMERA_KEYS);
  const architecture = pickTh(raw.architecture, TH_ARCH_TEXT_KEYS, TH_ARCH_LIST_KEYS);
  const environment = pickTh(raw.environment, TH_ENV_TEXT_KEYS, TH_ENV_LIST_KEYS);
  if (camera) th.camera = camera;
  if (architecture) th.architecture = architecture as AnalysisTextTh['architecture'];
  if (environment) th.environment = environment as AnalysisTextTh['environment'];
  if (Object.keys(objects).length) th.objects = objects;
  const unc = listTh(raw.uncertainties);
  if (unc) th.uncertainties = unc;
  const summary = textTh(raw.summary);
  if (summary && !TH_UNKNOWN_RE.test(summary)) th.summary = summary;
  return Object.keys(th).length ? th : undefined;
}

const OBJECT_TYPES: AnalysisObject['type'][] = ['vehicle', 'person', 'animal', 'tree', 'furniture', 'other'];
const TYPE_ALIASES: Record<string, AnalysisObject['type']> = {
  car: 'vehicle', truck: 'vehicle', van: 'vehicle', motorcycle: 'vehicle', bicycle: 'vehicle', bus: 'vehicle',
  suv: 'vehicle', people: 'person', human: 'person', pedestrian: 'person', man: 'person', woman: 'person',
  child: 'person', dog: 'animal', cat: 'animal', bird: 'animal', palm: 'tree', plant: 'tree', shrub: 'tree',
  chair: 'furniture', table: 'furniture', bench: 'furniture', umbrella: 'furniture',
};

export function objectType(v: unknown): AnalysisObject['type'] {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if ((OBJECT_TYPES as string[]).includes(s)) return s as AnalysisObject['type'];
  return TYPE_ALIASES[s] ?? 'other';
}

export function normalizeObjects(v: unknown): AnalysisObject[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isRec)
    .slice(0, MAX_OBJECTS)
    .map((o, i) => ({
      id: `obj_${i + 1}`,
      type: objectType(o.type),
      description: text(o.description),
      position: text(o.position),
      orientation: text(o.orientation),
      scale: text(o.scale),
      confidence: clampConfidence(o.confidence),
    }));
}

/** Raw objects-array index → id assigned by normalizeObjects (same filtering and limit). */
export function objectIdMap(v: unknown): Map<number, string> {
  const map = new Map<number, string>();
  if (!Array.isArray(v)) return map;
  let k = 0;
  v.forEach((o, i) => {
    if (isRec(o) && k < MAX_OBJECTS) map.set(i, `obj_${++k}`);
  });
  return map;
}

export interface ResultMeta {
  provider: string;
  model: string;
  analyzedAt?: string;
}

export function normalizeAnalysis(raw: unknown, meta: ResultMeta): AnalysisResult {
  const r = isRec(raw) ? raw : {};
  const cam = isRec(r.camera) ? r.camera : {};
  const arch = isRec(r.architecture) ? r.architecture : {};
  const env = isRec(r.environment) ? r.environment : {};
  const summary = text(r.summary);
  const th = normalizeTh(r.th, objectIdMap(r.objects));
  return {
    provider: meta.provider,
    model: meta.model,
    analyzedAt: meta.analyzedAt ?? new Date().toISOString(),
    camera: {
      position: text(cam.position),
      height: text(cam.height),
      angle: text(cam.angle),
      direction: text(cam.direction),
      focal_length_estimate: text(cam.focal_length_estimate),
      perspective: text(cam.perspective),
      horizon: text(cam.horizon),
      vanishing_points: text(cam.vanishing_points),
      aspect_ratio: text(cam.aspect_ratio),
      composition: text(cam.composition),
      confidence: clampConfidence(cam.confidence),
    },
    architecture: {
      style: text(arch.style),
      geometry: text(arch.geometry),
      massing: text(arch.massing),
      roof: text(arch.roof),
      floor_count: text(arch.floor_count),
      structure: text(arch.structure),
      openings: text(arch.openings),
      facade: text(arch.facade),
      materials: list(arch.materials),
      colors: list(arch.colors),
      details: list(arch.details),
      confidence: clampConfidence(arch.confidence),
    },
    environment: {
      road: text(env.road),
      sidewalk: text(env.sidewalk),
      terrain: text(env.terrain),
      landscape: list(env.landscape),
      hardscape: list(env.hardscape),
      sky: text(env.sky),
      lighting: text(env.lighting),
      sun_direction: text(env.sun_direction),
      shadows: text(env.shadows),
      weather: text(env.weather),
      time_of_day: text(env.time_of_day),
      confidence: clampConfidence(env.confidence),
    },
    objects: normalizeObjects(r.objects),
    uncertainties: list(r.uncertainties),
    summary: summary === UNKNOWN ? '' : summary,
    ...(th ? { th } : {}),
  };
}

/**
 * Accepts either `categories: [{category, description, confidence}]` (the schema we request)
 * or `categories: {id: {description, confidence}}`. Only requested categories are kept.
 */
export function normalizeReference(raw: unknown, requested: string[], meta: ResultMeta): ReferenceAnalysis {
  const r = isRec(raw) ? raw : {};
  const byId = new Map<string, Rec>();
  if (Array.isArray(r.categories)) {
    for (const c of r.categories) if (isRec(c) && typeof c.category === 'string') byId.set(c.category.trim(), c);
  } else if (isRec(r.categories)) {
    for (const [k, c] of Object.entries(r.categories)) if (isRec(c)) byId.set(k, c);
  }
  const categories: ReferenceAnalysis['categories'] = {};
  for (const id of requested) {
    const c = byId.get(id);
    if (!c) {
      categories[id] = { description: UNKNOWN, confidence: null };
      continue;
    }
    const descriptionTh = textTh(c.description_th ?? c.descriptionTh, MAX_REF_TEXT);
    categories[id] = {
      description: text(c.description, MAX_REF_TEXT),
      ...(descriptionTh ? { descriptionTh } : {}),
      confidence: clampConfidence(c.confidence),
    };
  }
  const summary = text(r.summary);
  const summaryTh = textTh(r.summary_th ?? r.summaryTh);
  const uncertaintiesTh = listTh(r.uncertainties_th ?? r.uncertaintiesTh);
  return {
    provider: meta.provider,
    model: meta.model,
    analyzedAt: meta.analyzedAt ?? new Date().toISOString(),
    summary: summary === UNKNOWN ? '' : summary,
    categories,
    uncertainties: list(r.uncertainties),
    ...(summaryTh && !TH_UNKNOWN_RE.test(summaryTh) ? { summaryTh } : {}),
    ...(uncertaintiesTh ? { uncertaintiesTh } : {}),
  };
}

/** Sanitize requested reference categories: unique, simple ids, bounded. */
export function sanitizeCategories(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v) {
    if (typeof c !== 'string') continue;
    const s = c.trim();
    if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= 40) break;
  }
  return out;
}
