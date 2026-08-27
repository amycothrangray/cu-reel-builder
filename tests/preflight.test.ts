import { describe, expect, it } from 'vitest';
import { estimateFileSizeBytes, preflightPasses, runPreflight } from '../src/lib/engine/export/preflight';
import { TEMPLATES } from '../src/lib/engine/templates';
import { defaultBrand, type PhotoRecord, type ReelRecord } from '../src/lib/types';
import { face, makePhoto, makeStats } from './helpers';
import type { TemplateContext } from '../src/lib/engine/templates/shared';

const buildTimeline = () => {
  const ctx: TemplateContext = {
    durationMs: 9000,
    text: { title: 't', caption: '', cta: 'Book', showHandle: false },
    brand: defaultBrand(),
    beats: [],
    audio: null,
    seed: 1,
  };
  const photos = Array.from({ length: 6 }, () =>
    makePhoto({ faces: [face(0.3, 0.25, 0.2, 0.25)] }),
  );
  return { timeline: TEMPLATES[0].build(photos, ctx), photos };
};

const reelOf = (over: Partial<ReelRecord> = {}): ReelRecord => ({
  id: 'r1',
  name: 'Test',
  createdAt: 0,
  updatedAt: 0,
  status: 'ready',
  templateId: 'signature-energy',
  durationSec: 9,
  text: { title: '', caption: '', cta: '', showHandle: false },
  musicAssetKey: null,
  musicName: null,
  versions: [],
  activeVersionId: null,
  manualOrder: null,
  ...over,
});

const photoRecordFor = (
  id: string,
  flags: PhotoRecord['restrictedFlags'] = [],
): PhotoRecord => ({
  id,
  reelId: 'r1',
  hash: id,
  fileName: `${id}.jpg`,
  mimeType: 'image/jpeg',
  bytes: 1,
  width: 2000,
  height: 3000,
  addedAt: 0,
  order: 0,
  exif: {},
  correctionEnabled: false,
  hasCorrected: false,
  included: true,
  restrictedFlags: flags,
  status: 'ready',
  analysis: {
    stats: makeStats(),
    faces: [],
    phash: '0',
    classification: { label: 'pro', confidence: 0.9, reasons: [] },
    score: 0.5,
    analyzedAt: 0,
    version: 1,
  },
});

describe('preflight', () => {
  it('passes a healthy reel', () => {
    const { timeline, photos } = buildTimeline();
    const records = photos.map((p) => photoRecordFor(p.id));
    const findings = runPreflight({
      reel: reelOf(),
      timeline,
      photos: records,
      brand: defaultBrand(),
      availablePhotoIds: new Set(photos.map((p) => p.id)),
      audioAvailable: false,
      fontsAvailable: true,
      logoAvailable: false,
    });
    expect(preflightPasses(findings)).toBe(true);
  });

  it('blocks on unreviewed restricted flags', () => {
    const { timeline, photos } = buildTimeline();
    const records = photos.map((p, i) =>
      photoRecordFor(
        p.id,
        i === 0
          ? [{ profileId: 'x', profileLabel: 'Student A', face: face(0, 0, 0.1, 0.1), distance: 0.5, status: 'pending' }]
          : [],
      ),
    );
    const findings = runPreflight({
      reel: reelOf(),
      timeline,
      photos: records,
      brand: defaultBrand(),
      availablePhotoIds: new Set(photos.map((p) => p.id)),
      audioAvailable: false,
      fontsAvailable: true,
      logoAvailable: false,
    });
    expect(preflightPasses(findings)).toBe(false);
    expect(findings.find((f) => f.id === 'restricted-pending')).toBeDefined();
  });

  it('blocks when a used photo is missing', () => {
    const { timeline, photos } = buildTimeline();
    const records = photos.map((p) => photoRecordFor(p.id));
    const findings = runPreflight({
      reel: reelOf(),
      timeline,
      photos: records,
      brand: defaultBrand(),
      availablePhotoIds: new Set(), // nothing loadable
      audioAvailable: false,
      fontsAvailable: true,
      logoAvailable: false,
    });
    expect(preflightPasses(findings)).toBe(false);
    expect(findings.find((f) => f.id === 'missing-images')).toBeDefined();
  });

  it('blocks when selected music cannot load', () => {
    const { timeline, photos } = buildTimeline();
    const records = photos.map((p) => photoRecordFor(p.id));
    const findings = runPreflight({
      reel: reelOf({ musicAssetKey: 'music:gone', musicName: 'Track' }),
      timeline,
      photos: records,
      brand: defaultBrand(),
      availablePhotoIds: new Set(photos.map((p) => p.id)),
      audioAvailable: false,
      fontsAvailable: true,
      logoAvailable: false,
    });
    expect(findings.find((f) => f.id === 'audio-missing')?.level).toBe('block');
  });

  it('estimates a plausible file size', () => {
    const { timeline } = buildTimeline();
    const bytes = estimateFileSizeBytes(timeline);
    expect(bytes).toBeGreaterThan(5_000_000);
    expect(bytes).toBeLessThan(30_000_000);
  });
});
