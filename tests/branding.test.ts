// Branding is opt-in, per reel. A saved brand kit is something to reach for,
// never something that stamps itself on every reel — so the default has to be
// off, and clearing the call to action has to mean no call to action.

import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/lib/engine/buildReel';
import { defaultBrand } from '../src/lib/types';
import type { BrandConfig } from '../src/lib/types';
import type { Timeline } from '../src/lib/engine/types';
import { makePhotoRecord, makeReelRecord } from './helpers';

const brandWithEverything = (): BrandConfig => ({
  ...defaultBrand(),
  logoAssetKey: 'logo:1',
  instagram: '@amygrayphoto',
  website: 'amygrayphotography.com',
  cta: 'Book your session',
});

const build = (
  over: Parameters<typeof makeReelRecord>[0] = {},
  brand: BrandConfig = brandWithEverything(),
): Timeline => {
  const photos = Array.from({ length: 8 }, (_, i) => makePhotoRecord({ id: `p${i}`, order: i }));
  const reel = makeReelRecord({ durationSec: 12, ...over });
  return buildTimeline({
    reel,
    photos,
    brand,
    templateId: reel.templateId ?? 'signature-energy',
    beats: [],
    seed: 5,
  });
};

const kinds = (t: Timeline) => t.overlays.map((o) => o.kind);

describe('branding is opt-in', () => {
  it('adds no sign-off at all to a reel that never asked for one', () => {
    // The saved kit has a logo, a handle and a call to action — none of it
    // belongs on this reel, because branding was never switched on.
    const t = build();
    expect(kinds(t)).not.toContain('cta');
    expect(kinds(t)).not.toContain('handle');
    expect(kinds(t)).not.toContain('logo');
  });

  it('treats a reel saved before this option existed as un-branded', () => {
    const t = build({ branding: undefined });
    expect(kinds(t)).not.toContain('cta');
    expect(kinds(t)).not.toContain('logo');
  });

  it('still shows the words she typed herself', () => {
    const t = build({
      text: { title: 'The Andersons', caption: 'golden hour', cta: 'Book now', showHandle: true },
    });
    expect(kinds(t)).toContain('title');
    expect(kinds(t)).toContain('caption');
    // …but her title is not an excuse to append the sign-off.
    expect(kinds(t)).not.toContain('cta');
  });

  it('adds the whole sign-off once she switches branding on', () => {
    const t = build({
      branding: true,
      text: { title: '', caption: '', cta: 'Book your session', showHandle: true, showLogo: true },
    });
    expect(kinds(t)).toContain('cta');
    expect(kinds(t)).toContain('handle');
    expect(kinds(t)).toContain('logo');
  });

  it('lets her keep the sign-off but drop the logo', () => {
    const t = build({
      branding: true,
      text: { title: '', caption: '', cta: 'Book your session', showHandle: true, showLogo: false },
    });
    expect(kinds(t)).toContain('cta');
    expect(kinds(t)).not.toContain('logo');
  });

  it('lets her keep the sign-off but drop the handle', () => {
    const t = build({
      branding: true,
      text: { title: '', caption: '', cta: 'Book your session', showHandle: false, showLogo: true },
    });
    expect(kinds(t)).toContain('cta');
    expect(kinds(t)).not.toContain('handle');
  });

  it('an empty call to action means none — never the saved default', () => {
    // This was the trap: clearing the field used to fall back to the brand
    // kit's CTA, so the end card could not be removed at all.
    const t = build({
      branding: true,
      text: { title: '', caption: '', cta: '   ', showHandle: true, showLogo: true },
    });
    expect(kinds(t)).not.toContain('cta');
    expect(kinds(t)).not.toContain('handle');
    expect(kinds(t)).not.toContain('logo');
  });

  it('leaves her fonts and colours alone either way', () => {
    // Typography is how the reel looks like her work; only the sign-off
    // advertises. Editorial Minimal keeps its brand background regardless.
    const off = build({ templateId: 'editorial-minimal' });
    const on = build({ templateId: 'editorial-minimal', branding: true });
    expect(off.background).toBe(on.background);
  });
});
