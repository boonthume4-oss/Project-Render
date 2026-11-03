import { describe, expect, it } from 'vitest';
import {
  UNKNOWN,
  clampConfidence,
  list,
  normalizeAnalysis,
  normalizeObjects,
  normalizeReference,
  objectType,
  sanitizeCategories,
  text,
  listTh,
  textTh,
} from './normalize';
import { decodedBase64Bytes, parseImageBody } from './validation';
import { AdapterError } from './adapters/types';

const meta = { provider: 'anthropic', model: 'test-model', analyzedAt: '2026-01-01T00:00:00.000Z' };

describe('clampConfidence', () => {
  it('keeps 0..1 values and clamps out-of-range', () => {
    expect(clampConfidence(0.42)).toBe(0.42);
    expect(clampConfidence(-0.3)).toBe(0);
    expect(clampConfidence(250)).toBe(1);
  });
  it('treats 1..100 as a percentage', () => {
    expect(clampConfidence(85)).toBe(0.85);
    expect(clampConfidence('70%')).toBe(0.7);
  });
  it('returns null for non-numbers', () => {
    expect(clampConfidence(undefined)).toBeNull();
    expect(clampConfidence('high')).toBeNull();
    expect(clampConfidence(Number.NaN)).toBeNull();
  });
});

describe('text / list', () => {
  it('fills missing values with Unknown', () => {
    expect(text(undefined)).toBe(UNKNOWN);
    expect(text('   ')).toBe(UNKNOWN);
    expect(text('N/A')).toBe(UNKNOWN);
    expect(text({})).toBe(UNKNOWN);
  });
  it('keeps prefixes and collapses whitespace', () => {
    expect(text('  Estimate:   35mm ')).toBe('Estimate: 35mm');
    expect(text(3)).toBe('3');
  });
  it('normalizes lists, dedupes and drops unknowns', () => {
    expect(list(['concrete', 'concrete', '', null, 'glass'])).toEqual(['concrete', 'glass']);
    expect(list('timber')).toEqual(['timber']);
    expect(list(42)).toEqual([]);
  });
});

describe('objects', () => {
  it('maps type aliases and assigns ids', () => {
    expect(objectType('Car')).toBe('vehicle');
    expect(objectType('pedestrian')).toBe('person');
    expect(objectType('spaceship')).toBe('other');
    const objs = normalizeObjects([{ type: 'car', position: 'left foreground', confidence: 0.9 }, 'junk']);
    expect(objs).toHaveLength(1);
    expect(objs[0]).toEqual({
      id: 'obj_1',
      type: 'vehicle',
      description: UNKNOWN,
      position: 'left foreground',
      orientation: UNKNOWN,
      scale: UNKNOWN,
      confidence: 0.9,
    });
  });
});

describe('normalizeAnalysis', () => {
  it('returns a complete shape for garbage input', () => {
    const r = normalizeAnalysis('not json', meta);
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('test-model');
    expect(r.analyzedAt).toBe(meta.analyzedAt);
    expect(r.camera.position).toBe(UNKNOWN);
    expect(r.camera.confidence).toBeNull();
    expect(r.architecture.materials).toEqual([]);
    expect(r.environment.time_of_day).toBe(UNKNOWN);
    expect(r.objects).toEqual([]);
    expect(r.uncertainties).toEqual([]);
    expect(r.summary).toBe('');
  });

  it('keeps provided values and clamps confidences', () => {
    const r = normalizeAnalysis(
      {
        summary: 'Two-storey house.',
        camera: { position: 'street level', focal_length_estimate: 'Estimate: 24mm', confidence: 1.4 },
        architecture: { style: 'Tropical Modern', floor_count: 2, materials: ['concrete', 'teak'], confidence: '80' },
        environment: { road: 'Needs confirmation: asphalt road', landscape: 'lawn', confidence: 0.5 },
        objects: [{ type: 'person', description: 'pedestrian', position: 'right midground' }],
        uncertainties: ['Focal length estimated'],
        extra: 'ignored',
      },
      meta,
    );
    expect(r.camera.position).toBe('street level');
    expect(r.camera.focal_length_estimate).toBe('Estimate: 24mm');
    expect(r.camera.confidence).toBe(1);
    expect(r.architecture.floor_count).toBe('2');
    expect(r.architecture.materials).toEqual(['concrete', 'teak']);
    expect(r.architecture.confidence).toBe(0.8);
    expect(r.environment.road).toBe('Needs confirmation: asphalt road');
    expect(r.environment.landscape).toEqual(['lawn']);
    expect(r.objects[0].type).toBe('person');
    expect(r.uncertainties).toEqual(['Focal length estimated']);
    expect(r.summary).toBe('Two-storey house.');
    expect('extra' in r).toBe(false);
  });
});

describe('normalizeReference', () => {
  it('keeps only requested categories and fills missing ones', () => {
    const r = normalizeReference(
      {
        summary: 'Warm stone villa',
        categories: [
          { category: 'material', description: 'travertine cladding', confidence: 0.9 },
          { category: 'architectural-style', description: 'should be dropped', confidence: 1 },
        ],
      },
      ['material', 'lighting'],
      meta,
    );
    expect(Object.keys(r.categories)).toEqual(['material', 'lighting']);
    expect(r.categories.material).toEqual({ description: 'travertine cladding', confidence: 0.9 });
    expect(r.categories.lighting).toEqual({ description: UNKNOWN, confidence: null });
    expect(r.summary).toBe('Warm stone villa');
  });

  it('accepts an object map of categories', () => {
    const r = normalizeReference({ categories: { sky: { description: 'clear blue', confidence: 60 } } }, ['sky'], meta);
    expect(r.categories.sky).toEqual({ description: 'clear blue', confidence: 0.6 });
  });

  it('sanitizes requested category ids', () => {
    expect(sanitizeCategories(['material', 'material', 'bad id!', 3, 'color-palette'])).toEqual([
      'material',
      'color-palette',
    ]);
    expect(sanitizeCategories('material')).toEqual([]);
  });
});

describe('Thai mirror', () => {
  it('textTh / listTh leave missing values undefined (never Unknown)', () => {
    expect(textTh(undefined)).toBeUndefined();
    expect(textTh('   ')).toBeUndefined();
    expect(textTh({})).toBeUndefined();
    expect(textTh('  ประมาณการ:   35mm ')).toBe('ประมาณการ: 35mm');
    expect(listTh(undefined)).toBeUndefined();
    expect(listTh([])).toBeUndefined();
    expect(listTh(['ไม่ทราบ', ''])).toBeUndefined();
    expect(listTh(['คอนกรีต', 'คอนกรีต', '', 'ไม่ทราบ', 'กระจก'])).toEqual(['คอนกรีต', 'กระจก']);
    expect(listTh('ไม้สัก')).toEqual(['ไม้สัก']);
  });

  it('cuts overlong Thai text at a space boundary', () => {
    const word = 'ผนังคอนกรีตเปลือย';
    const long = Array.from({ length: 80 }, () => word).join(' ');
    const out = textTh(long, 100)!;
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('…')).toBe(true);
    // never cuts in the middle of a word
    expect(out.slice(0, -1).split(' ').every((w) => w === word)).toBe(true);
    // without spaces it still respects the limit
    expect(textTh('ก'.repeat(700))!.length).toBe(600);
  });

  it('returns no th when the model omitted it', () => {
    const r = normalizeAnalysis({ summary: 'House.', camera: { position: 'street level' } }, meta);
    expect(r.th).toBeUndefined();
    expect('th' in r).toBe(false);
    expect(normalizeAnalysis({ th: 'garbage' }, meta).th).toBeUndefined();
    expect(normalizeAnalysis({ th: {} }, meta).th).toBeUndefined();
  });

  it('keeps a partial th and leaves the rest undefined', () => {
    const r = normalizeAnalysis(
      {
        summary: 'Two-storey house.',
        camera: { position: 'street level', angle: 'frontal' },
        architecture: { materials: ['concrete', 'teak'] },
        th: {
          summary: 'บ้านสองชั้น',
          camera: { position: 'ระดับถนน', angle: '', height: null },
          architecture: { materials: ['คอนกรีต', 'ไม้สัก'], style: 42 },
          uncertainties: 'ประมาณการทางยาวโฟกัส',
        },
      },
      meta,
    );
    expect(r.th).toEqual({
      summary: 'บ้านสองชั้น',
      camera: { position: 'ระดับถนน' },
      architecture: { materials: ['คอนกรีต', 'ไม้สัก'], style: '42' },
      uncertainties: ['ประมาณการทางยาวโฟกัส'],
    });
    expect(r.th!.camera!.angle).toBeUndefined();
    expect(r.th!.environment).toBeUndefined();
    // English stays canonical
    expect(r.camera.angle).toBe('frontal');
    expect(r.camera.height).toBe(UNKNOWN);
  });

  it('keys Thai objects by the normalized object id (aligned with the raw English array)', () => {
    const r = normalizeAnalysis(
      {
        objects: ['junk', { type: 'car', description: 'white sedan' }, { type: 'person', description: 'pedestrian' }],
        th: { objects: ['ขยะ', { description: 'รถเก๋งสีขาว', position: 'ด้านซ้าย' }, { description: '' }] },
      },
      meta,
    );
    expect(r.objects.map((o) => o.id)).toEqual(['obj_1', 'obj_2']);
    expect(r.th!.objects).toEqual({ obj_1: { description: 'รถเก๋งสีขาว', position: 'ด้านซ้าย' } });
  });

  it('normalizes overlong Thai fields with the same limits as English', () => {
    const r = normalizeAnalysis({ th: { environment: { lighting: 'แสง '.repeat(400) } } }, meta);
    expect(r.th!.environment!.lighting!.length).toBeLessThanOrEqual(600);
  });

  it('reference: descriptionTh / summaryTh / uncertaintiesTh are optional', () => {
    const r = normalizeReference(
      {
        summary: 'Warm stone villa',
        summary_th: 'วิลล่าหินโทนอุ่น',
        categories: [
          { category: 'material', description: 'travertine cladding', description_th: 'ผนังกรุหินทรายเวอร์ทีน', confidence: 0.9 },
          { category: 'lighting', description: 'soft light', description_th: '   ', confidence: 0.5 },
        ],
        uncertainties: ['finish unclear'],
        uncertainties_th: ['ผิวสัมผัสไม่ชัดเจน'],
      },
      ['material', 'lighting', 'sky'],
      meta,
    );
    expect(r.categories.material).toEqual({
      description: 'travertine cladding',
      descriptionTh: 'ผนังกรุหินทรายเวอร์ทีน',
      confidence: 0.9,
    });
    expect('descriptionTh' in r.categories.lighting).toBe(false);
    expect('descriptionTh' in r.categories.sky).toBe(false);
    expect(r.summaryTh).toBe('วิลล่าหินโทนอุ่น');
    expect(r.uncertaintiesTh).toEqual(['ผิวสัมผัสไม่ชัดเจน']);

    const old = normalizeReference({ summary: 'x', categories: [] }, ['material'], meta);
    expect('summaryTh' in old).toBe(false);
    expect('uncertaintiesTh' in old).toBe(false);
  });

  it('reference: overlong Thai description is capped like the English one', () => {
    const r = normalizeReference(
      { categories: [{ category: 'material', description: 'x', description_th: 'หินอ่อน '.repeat(400), confidence: 1 }] },
      ['material'],
      meta,
    );
    expect(r.categories.material.descriptionTh!.length).toBeLessThanOrEqual(1600);
  });
});

describe('parseImageBody', () => {
  const tiny = Buffer.from('hello image').toString('base64');

  it('accepts valid jpeg/png/webp payloads and data URLs', () => {
    expect(parseImageBody({ imageBase64: tiny, mediaType: 'image/png' })).toEqual({
      base64: tiny,
      mediaType: 'image/png',
    });
    expect(parseImageBody({ imageBase64: `data:image/jpeg;base64,${tiny}` }).mediaType).toBe('image/jpeg');
    expect(parseImageBody({ imageBase64: tiny, mediaType: 'image/jpg' }).mediaType).toBe('image/jpeg');
  });

  it('rejects unsupported media types and invalid base64', () => {
    expect(() => parseImageBody({ imageBase64: tiny, mediaType: 'image/gif' })).toThrow(AdapterError);
    expect(() => parseImageBody({ imageBase64: '###', mediaType: 'image/png' })).toThrow(/base64/);
    expect(() => parseImageBody({})).toThrow(/required/);
  });

  it('rejects images over 5 MB with 413', () => {
    const big = 'A'.repeat(Math.ceil(((5 * 1024 * 1024 + 10) * 4) / 3 / 4) * 4);
    try {
      parseImageBody({ imageBase64: big, mediaType: 'image/jpeg' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterError);
      expect((e as AdapterError).status).toBe(413);
      expect((e as AdapterError).code).toBe('image_too_large');
    }
  });

  it('computes decoded size', () => {
    expect(decodedBase64Bytes(Buffer.from('abcd').toString('base64'))).toBe(4);
    expect(decodedBase64Bytes(Buffer.from('abcde').toString('base64'))).toBe(5);
  });
});
