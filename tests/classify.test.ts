import { describe, expect, it } from 'vitest';
import { classifyPhoto, correctionDefault } from '../src/lib/classify/classify';
import { effectiveClassification, correctionAllowed, type PhotoRecord } from '../src/lib/types';
import { makeStats } from './helpers';

const opts = { width: 6000, height: 4000, mimeType: 'image/jpeg' };

describe('EXIF classification', () => {
  it('classifies iPhone EXIF as mobile with high confidence', () => {
    const c = classifyPhoto({ make: 'Apple', model: 'iPhone 15 Pro' }, makeStats(), {
      ...opts,
      mimeType: 'image/heic',
    });
    expect(c.label).toBe('mobile');
    expect(c.confidence).toBeGreaterThan(0.9);
  });

  it('classifies a Canon body as pro', () => {
    const c = classifyPhoto(
      { make: 'Canon', model: 'EOS R5', lensModel: 'RF 50mm F1.2', fNumber: 1.8 },
      makeStats(),
      opts,
    );
    expect(c.label).toBe('pro');
    expect(c.confidence).toBeGreaterThan(0.9);
  });

  it('a Sony phone model string is not mistaken for a pro camera', () => {
    const c = classifyPhoto({ make: 'samsung', model: 'SM-G998B' }, makeStats(), opts);
    expect(c.label).toBe('mobile');
  });

  it('stripped EXIF with restrained tonality leans pro (soft confidence)', () => {
    const c = classifyPhoto(
      { software: 'Adobe Lightroom Classic 13.0' },
      makeStats({ highlightClip: 0.001, saturation: 0.3, contrast: 0.18 }),
      opts,
    );
    expect(c.label).toBe('pro');
    expect(c.confidence).toBeLessThan(0.9);
  });

  it('stripped EXIF with HDR fingerprints leans mobile', () => {
    const c = classifyPhoto(
      {},
      makeStats({
        contrast: 0.3,
        saturation: 0.5,
        highlightClip: 0.03,
        skinWarmthExcess: 0.06,
        skinFraction: 0.1,
      }),
      { width: 4032, height: 3024, mimeType: 'image/jpeg' },
    );
    expect(c.label).toBe('mobile');
  });

  it('returns uncertain when nothing is conclusive', () => {
    const c = classifyPhoto({}, makeStats(), { width: 2000, height: 1500, mimeType: 'image/jpeg' });
    expect(c.label).toBe('uncertain');
    expect(c.confidence).toBeLessThan(0.5);
  });
});

describe('correction defaults and overrides', () => {
  it('never defaults correction on for pro or uncertain photos', () => {
    const stats = makeStats({ contrast: 0.4, highlightClip: 0.1 });
    expect(correctionDefault({ label: 'pro', confidence: 0.95, reasons: [] }, stats)).toBe(false);
    expect(correctionDefault({ label: 'uncertain', confidence: 0.3, reasons: [] }, stats)).toBe(false);
  });

  it('defaults correction on only when a mobile photo shows real issues', () => {
    const clean = makeStats({ contrast: 0.18, highlightClip: 0.001, skinWarmthExcess: 0, warmth: 0.02, saturation: 0.3 });
    const harsh = makeStats({ contrast: 0.3 });
    const mobile = { label: 'mobile' as const, confidence: 0.9, reasons: [] };
    expect(correctionDefault(mobile, clean)).toBe(false);
    expect(correctionDefault(mobile, harsh)).toBe(true);
  });

  const basePhoto = (over: Partial<PhotoRecord>): PhotoRecord => ({
    id: 'p1',
    reelId: 'r1',
    hash: 'h',
    fileName: 'f.jpg',
    mimeType: 'image/jpeg',
    bytes: 1,
    width: 100,
    height: 100,
    addedAt: 0,
    order: 0,
    exif: {},
    correctionEnabled: false,
    hasCorrected: false,
    included: true,
    restrictedFlags: [],
    status: 'ready',
    analysis: {
      stats: makeStats(),
      faces: [],
      phash: '0',
      classification: { label: 'mobile', confidence: 0.9, reasons: [] },
      score: 0.5,
      analyzedAt: 0,
      version: 1,
    },
    ...over,
  });

  it('manual override always wins over automatic classification', () => {
    const photo = basePhoto({ overrideClassification: 'pro' });
    expect(effectiveClassification(photo)).toBe('pro');
    expect(correctionAllowed(photo)).toBe(false);

    const back = basePhoto({ overrideClassification: 'mobile' });
    expect(effectiveClassification(back)).toBe('mobile');
    expect(correctionAllowed(back)).toBe(true);
  });
});
