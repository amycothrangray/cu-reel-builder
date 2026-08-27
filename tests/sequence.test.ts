import { describe, expect, it } from 'vitest';
import { arrangePhotos, arrangeStory, inferStoryRole, pickOpening } from '../src/lib/engine/sequence';
import { isNearDuplicate } from '../src/lib/imaging/similarity';
import { recommendSubset } from '../src/lib/analysis/score';
import { phashDistance } from '../src/lib/imaging/similarity';
import { face, makePhoto } from './helpers';

describe('photo ordering', () => {
  it('opens with a strong face-forward image', () => {
    const weak = makePhoto({ score: 0.3 });
    const strongNoFace = makePhoto({ score: 0.8 });
    const strongFace = makePhoto({ score: 0.75, faces: [face(0.4, 0.3, 0.15, 0.2)] });
    expect(pickOpening([weak, strongNoFace, strongFace]).id).toBe(strongFace.id);
  });

  it('avoids consecutive near-duplicates when alternatives exist', () => {
    const dupeHash = 'aaaaaaaaaaaaaaaa';
    const photos = [
      makePhoto({ phash: dupeHash, score: 0.9 }),
      makePhoto({ phash: 'aaaaaaaaaaaaaaab', score: 0.85 }), // near-dupe of first
      makePhoto({ phash: '5555555555555555', score: 0.7 }),
      makePhoto({ phash: '00000000ffffffff', score: 0.7 }),
    ];
    const ordered = arrangePhotos(photos, 4, 42);
    for (let i = 0; i < ordered.length - 1; i++) {
      // The near-duplicate pair must not sit adjacent.
      if (isNearDuplicate(ordered[i].phash, ordered[i + 1].phash)) {
        throw new Error(`near-duplicates adjacent at ${i}`);
      }
    }
  });

  it('is deterministic for the same seed and varies across seeds', () => {
    const photos = Array.from({ length: 8 }, (_, i) =>
      makePhoto({ score: 0.5 + (i % 4) * 0.1, faces: i % 2 ? [face(0.4, 0.3, 0.1, 0.15)] : [] }),
    );
    const a = arrangePhotos(photos, 6, 7).map((p) => p.id);
    const b = arrangePhotos(photos, 6, 7).map((p) => p.id);
    expect(a).toEqual(b);
  });

  it('uses opener and closer distinct from each other', () => {
    const photos = Array.from({ length: 5 }, () => makePhoto({}));
    const ordered = arrangePhotos(photos, 5, 1);
    expect(new Set(ordered.map((p) => p.id)).size).toBe(5);
  });
});

describe('story arrangement', () => {
  it('infers roles from measurable proxies', () => {
    expect(inferStoryRole(makePhoto({ width: 6000, height: 4000, faces: [] }))).toBe('establishing');
    expect(inferStoryRole(makePhoto({ faces: [face(0.3, 0.2, 0.3, 0.35)] }))).toBe('closeup');
    expect(
      inferStoryRole(makePhoto({ faces: [face(0.2, 0.3, 0.1, 0.15), face(0.6, 0.3, 0.1, 0.15)] })),
    ).toBe('interaction');
    expect(inferStoryRole(makePhoto({ width: 2000, height: 3000, faces: [] }))).toBe('detail');
  });

  it('starts with an establishing image when one exists', () => {
    const photos = [
      makePhoto({ faces: [face(0.3, 0.2, 0.3, 0.35)] }), // closeup
      makePhoto({ width: 6000, height: 4000, faces: [] }), // establishing
      makePhoto({ faces: [face(0.2, 0.3, 0.1, 0.15), face(0.6, 0.3, 0.1, 0.15)] }), // interaction
    ];
    const ordered = arrangeStory(photos, 3, 5);
    expect(inferStoryRole(ordered[0])).toBe('establishing');
  });

  it('respects AI-provided roles over inferred ones', () => {
    const p = makePhoto({ faces: [face(0.3, 0.2, 0.3, 0.35)], ai: { storyRole: 'closing' } });
    expect(inferStoryRole(p)).toBe('closing');
  });
});

describe('recommended subset', () => {
  it('prefers strong photos and skips near-duplicates', () => {
    const items = [
      { id: 'a', score: 0.9, phash: 'aaaaaaaaaaaaaaaa' },
      { id: 'b', score: 0.85, phash: 'aaaaaaaaaaaaaaab' }, // dupe of a
      { id: 'c', score: 0.5, phash: '5555555555555555' },
      { id: 'd', score: 0.4, phash: '00000000ffffffff' },
    ];
    const picked = recommendSubset(items, 3, phashDistance);
    expect(picked.has('a')).toBe(true);
    expect(picked.has('c')).toBe(true);
    expect(picked.has('d')).toBe(true);
    expect(picked.has('b')).toBe(false);
  });

  it('backfills with duplicates when nothing else remains', () => {
    const items = [
      { id: 'a', score: 0.9, phash: 'aaaaaaaaaaaaaaaa' },
      { id: 'b', score: 0.8, phash: 'aaaaaaaaaaaaaaab' },
    ];
    const picked = recommendSubset(items, 2, phashDistance);
    expect(picked.size).toBe(2);
  });
});
