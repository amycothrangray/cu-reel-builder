import { describe, expect, it } from 'vitest';
import { exportExtension } from '../src/lib/db';
import { versionTimelinePatch } from '../src/lib/reels';
import { defaultBrand, type ReelRecord, type ReelVersion, type TemplateId } from '../src/lib/types';
import type { Timeline } from '../src/lib/engine/types';

function makeTimeline(templateId: TemplateId, seed = 1): Timeline {
  return {
    templateId,
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs: 9000,
    background: '#000',
    clips: [],
    overlays: [],
    audio: null,
    seed,
  };
}

function makeVersion(id: string, templateId: TemplateId): ReelVersion {
  return { id, label: id, createdAt: 0, timeline: makeTimeline(templateId) };
}

function makeReel(patch: Partial<ReelRecord> = {}): ReelRecord {
  const brand = defaultBrand();
  return {
    id: 'reel-1',
    name: 'Reel',
    createdAt: 0,
    updatedAt: 0,
    status: 'ready',
    templateId: 'cinematic-story',
    durationSec: 9,
    text: { title: '', caption: '', cta: brand.cta, showHandle: true },
    musicAssetKey: null,
    musicName: null,
    versions: [makeVersion('v1', 'cinematic-story'), makeVersion('v2', 'rapid-fire')],
    activeVersionId: 'v1',
    requiredIds: [],
    manualOrder: null,
    purpose: 'auto',
    ...patch,
  };
}

describe('versionTimelinePatch', () => {
  it('replaces only the rebuilt version', () => {
    const reel = makeReel();
    const patch = versionTimelinePatch(reel, 'v1', makeTimeline('cinematic-story', 42));
    expect(patch).not.toBeNull();
    expect(patch!.versions).toHaveLength(2);
    expect(patch!.versions![0].timeline.seed).toBe(42);
    // Other versions keep their own timeline object untouched.
    expect(patch!.versions![1]).toBe(reel.versions[1]);
  });

  it('clears the exported state so the stale download is not offered', () => {
    const patch = versionTimelinePatch(
      makeReel({ status: 'exported', exportedAt: 1234 }),
      'v1',
      makeTimeline('cinematic-story', 2),
    );
    expect(patch!.status).toBe('ready');
    expect('exportedAt' in patch!).toBe(true);
    expect(patch!.exportedAt).toBeUndefined();
  });

  it('leaves a draft or ready reel’s status alone', () => {
    const patch = versionTimelinePatch(makeReel({ status: 'ready' }), 'v1', makeTimeline('cinematic-story', 2));
    expect('status' in patch!).toBe(false);
    expect('exportedAt' in patch!).toBe(false);
  });

  it('discards a build whose version stopped being active', () => {
    const reel = makeReel({ activeVersionId: 'v2' });
    expect(versionTimelinePatch(reel, 'v1', makeTimeline('cinematic-story', 3))).toBeNull();
  });

  it('discards a build for a version that no longer exists', () => {
    const reel = makeReel({ activeVersionId: 'gone' });
    expect(versionTimelinePatch(reel, 'gone', makeTimeline('cinematic-story', 3))).toBeNull();
  });
});

describe('exportExtension', () => {
  it('names WebM captures from the compatibility renderer correctly', () => {
    expect(exportExtension('video/webm')).toBe('webm');
    expect(exportExtension('video/webm;codecs=vp9')).toBe('webm');
  });

  it('names MP4 exports mp4', () => {
    expect(exportExtension('video/mp4')).toBe('mp4');
  });

  it('falls back to mp4 when the blob has no type', () => {
    expect(exportExtension(null)).toBe('mp4');
    expect(exportExtension(undefined)).toBe('mp4');
    expect(exportExtension('')).toBe('mp4');
  });
});
