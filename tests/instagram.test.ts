import { describe, expect, it } from 'vitest';
import {
  formatTimestamp,
  sliceMusicAnalysis,
  suggestSections,
  syncCue,
} from '../src/lib/audio/segments';
import { buildTimeline } from '../src/lib/engine/buildReel';
import { defaultBrand, type PhotoRecord, type ReelRecord } from '../src/lib/types';
import { makeStats } from './helpers';

describe('music section slicing', () => {
  const analysis = {
    beats: [500, 1500, 2500, 10500, 11500, 12500, 20000],
    strongBeats: [1500, 11500],
    intensity: Array.from({ length: 60 }, (_, i) => i / 60), // 30s ramp
  };

  it('re-bases beats and intensity to the chosen section', () => {
    const sliced = sliceMusicAnalysis(analysis, 10000, 5000);
    expect(sliced.beats).toEqual([500, 1500, 2500]);
    expect(sliced.strongBeats).toEqual([1500]);
    // 10s → window 20; 15s → window 30.
    expect(sliced.intensity).toHaveLength(10);
    expect(sliced.intensity[0]).toBeCloseTo(20 / 60);
  });

  it('excludes beats outside the section', () => {
    const sliced = sliceMusicAnalysis(analysis, 0, 3000);
    expect(sliced.beats).toEqual([500, 1500, 2500]);
    expect(sliced.beats.every((b) => b < 3000)).toBe(true);
  });
});

describe('section suggestions', () => {
  // 60s song: quiet 0–20s, building 20–35s, loud 35–50s, quiet outro.
  const intensity = Array.from({ length: 120 }, (_, i) => {
    const s = i / 2;
    if (s < 20) return 0.2;
    if (s < 35) return 0.2 + ((s - 20) / 15) * 0.7;
    if (s < 50) return 0.95;
    return 0.3;
  });
  const analysis = { strongBeats: [21000, 35000], intensity, durationMs: 60000 };

  it('suggests distinct, sensible sections', () => {
    const suggestions = suggestSections(analysis, 15000);
    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    const recommended = suggestions.find((s) => s.label === 'Recommended')!;
    // Recommended should sit in the build (rising into the chorus).
    expect(recommended.startMs).toBeGreaterThanOrEqual(15000);
    expect(recommended.startMs).toBeLessThanOrEqual(36000);
    const softer = suggestions.find((s) => s.label === 'Softer');
    if (softer) {
      // Softer sits in a quiet region, away from the loud stretch.
      const mid = softer.startMs + 7500;
      expect(mid < 22000 || softer.startMs >= 45000).toBe(true);
    }
    // Suggestions don't overlap heavily.
    for (const a of suggestions) {
      for (const b of suggestions) {
        if (a !== b) expect(Math.abs(a.startMs - b.startMs)).toBeGreaterThan(9000);
      }
    }
  });

  it('falls back gracefully when the song barely exceeds the reel', () => {
    const short = { strongBeats: [], intensity: Array(20).fill(0.5), durationMs: 10000 };
    const suggestions = suggestSections(short, 9000);
    expect(suggestions[0].startMs).toBe(0);
  });
});

describe('timestamp formatting', () => {
  it('formats like Instagram displays', () => {
    expect(formatTimestamp(47.2)).toBe('0:47.2');
    expect(formatTimestamp(0)).toBe('0:00.0');
    expect(formatTimestamp(62.4)).toBe('1:02.4');
    expect(formatTimestamp(59.97)).toBe('1:00.0');
  });
});

// ---------------------------------------------------------------------------

const photoRecord = (id: string): PhotoRecord => ({
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
  restrictedFlags: [],
  status: 'ready',
  analysis: {
    stats: makeStats(),
    faces: [],
    phash: (BigInt(id.length) * 0x9e3779b97f4a7c15n & 0xffffffffffffffffn)
      .toString(16)
      .padStart(16, '0'),
    classification: { label: 'pro', confidence: 0.9, reasons: [] },
    score: 0.6,
    analyzedAt: 0,
    version: 2,
  },
});

const reelOf = (over: Partial<ReelRecord>): ReelRecord => ({
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
  requiredIds: [],
  manualOrder: null,
  purpose: 'photography',
  ...over,
});

describe('Instagram audio in the timeline', () => {
  const photos = ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'].map(photoRecord);

  it('reference audio previews from the section start but is never embedded', () => {
    const timeline = buildTimeline({
      reel: reelOf({
        instagramAudio: {
          songTitle: 'Beautiful Things',
          artist: 'Benson Boone',
          referenceAssetKey: 'igref:x',
          referenceName: 'ref.mp3',
          startSec: 47.2,
        },
      }),
      photos,
      brand: defaultBrand(),
      templateId: 'signature-energy',
      beats: [],
      seed: 1,
    });
    expect(timeline.audio).not.toBeNull();
    expect(timeline.audio!.embedInExport).toBe(false);
    expect(timeline.audio!.offsetSec).toBeCloseTo(47.2);
  });

  it('studio music remains embedded', () => {
    const timeline = buildTimeline({
      reel: reelOf({ musicAssetKey: 'music:1', musicName: 'Track' }),
      photos,
      brand: defaultBrand(),
      templateId: 'signature-energy',
      beats: [],
      seed: 1,
    });
    expect(timeline.audio!.embedInExport).toBe(true);
    expect(timeline.audio!.offsetSec).toBe(0);
  });

  it('visual timing is identical with and without the reference attached', () => {
    const base = {
      photos,
      brand: defaultBrand(),
      templateId: 'signature-energy' as const,
      beats: [1500, 3000, 4500],
      seed: 5,
    };
    const silent = buildTimeline({ ...base, reel: reelOf({}) });
    const withRef = buildTimeline({
      ...base,
      reel: reelOf({
        instagramAudio: {
          songTitle: 'S',
          artist: 'A',
          referenceAssetKey: 'igref:x',
          referenceName: 'r.mp3',
          startSec: 10,
        },
      }),
    });
    expect(withRef.clips.map((c) => [c.startMs, c.endMs])).toEqual(
      silent.clips.map((c) => [c.startMs, c.endMs]),
    );
  });
});

describe('sync cue', () => {
  it('names the photo on screen at the first big hit', () => {
    const timeline = buildTimeline({
      reel: reelOf({}),
      photos: ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff'].map(photoRecord),
      brand: defaultBrand(),
      templateId: 'signature-energy',
      beats: [],
      seed: 2,
    });
    const cue = syncCue(timeline, [50, 2600, 5000]);
    expect(cue).not.toBeNull();
    // 50ms is too early to be checkable — the 2600ms hit is used.
    expect(cue!.tMs).toBe(2600);
    const clip = timeline.clips.find((c) => 2600 >= c.startMs && 2600 < c.endMs)!;
    expect(cue!.photoId).toBe(clip.layers[0].photoId);
    expect(cue!.photoNumber).toBeGreaterThanOrEqual(1);
  });

  it('returns null without usable strong beats', () => {
    const timeline = buildTimeline({
      reel: reelOf({}),
      photos: ['a', 'bb', 'ccc', 'dddd'].map(photoRecord),
      brand: defaultBrand(),
      templateId: 'signature-energy',
      beats: [],
      seed: 2,
    });
    expect(syncCue(timeline, [])).toBeNull();
  });
});
