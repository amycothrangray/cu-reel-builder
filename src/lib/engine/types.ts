// Timeline model — the deterministic contract between template algorithms,
// the preview player, and the exporter. A Timeline is plain serializable data:
// given the same timeline and the same source images, preview and export
// produce identical frames.

import type { NRect, TemplateId } from '../types';

export type Easing = 'linear' | 'ease-in-out' | 'ease-out';

export type TransitionKind = 'cut' | 'fade' | 'push-up' | 'push-left';

export interface Transition {
  kind: TransitionKind;
  durationMs: number;
}

/**
 * One photo placed in the frame. `crop` and `cropEnd` are normalized source
 * rectangles; motion (pan / gentle zoom) is the interpolation between them
 * over the life of the clip. Presentation-only — source pixels are never
 * modified.
 */
export interface ClipLayer {
  photoId: string;
  /** Destination region in the 9:16 frame, normalized. */
  dest: NRect;
  /** Source crop at clip start, normalized to the image. */
  crop: NRect;
  /** Source crop at clip end. Same as `crop` for a static hold. */
  cropEnd: NRect;
  easing: Easing;
  /**
   * How to fill `dest` when showing the full image: 'cover' crops to fill;
   * 'contain-blur' letterboxes over an enlarged blurred copy of the same
   * image; 'contain-brand' letterboxes over the brand color.
   */
  fill: 'cover' | 'contain-blur' | 'contain-brand';
}

export interface Clip {
  id: string;
  startMs: number;
  endMs: number;
  layers: ClipLayer[]; // 1 = single photo, 2 = stacked pair
  transitionIn: Transition;
}

export type OverlayKind = 'title' | 'caption' | 'cta' | 'handle' | 'logo';

export type OverlayAnimation = 'fade' | 'slide-up' | 'reveal';

export interface TextOverlay {
  id: string;
  kind: OverlayKind;
  text: string; // ignored for 'logo'
  startMs: number;
  endMs: number;
  /** Anchor point in the frame, normalized. */
  pos: { x: number; y: number };
  align: 'left' | 'center' | 'right';
  /** Font size relative to a 1080-wide frame. */
  sizePx: number;
  font: 'primary' | 'secondary';
  color: string;
  /** 0..1 backdrop scrim strength behind the text for legibility. */
  scrim: number;
  animation: OverlayAnimation;
  letterSpacing: number;
  uppercase: boolean;
}

export interface TimelineAudio {
  assetKey: string;
  name: string;
  gain: number; // linear, 1 = unity
  fadeOutMs: number;
  /** Playback offset into the source track (Instagram section start). */
  offsetSec?: number;
  /**
   * False for Instagram Audio references: the track drives preview and
   * timing, but the export stays silent — the official song is added
   * natively inside Instagram. Visual timing is identical either way.
   */
  embedInExport?: boolean;
}

export interface Timeline {
  templateId: TemplateId;
  width: number; // 1080
  height: number; // 1920
  fps: number; // 30
  durationMs: number;
  background: string;
  clips: Clip[];
  overlays: TextOverlay[];
  audio: TimelineAudio | null;
  /** Seed used by the template for tie-breaking, so re-runs can differ. */
  seed: number;
}

/** Everything renderFrame needs that isn't in the timeline itself. */
export interface RenderResources {
  /** photoId → decoded bitmap (corrected variant already chosen upstream). */
  images: Map<string, ImageBitmap | HTMLCanvasElement>;
  /** photoId → pre-blurred, frame-filling backdrop for contain-blur fills. */
  blurred: Map<string, HTMLCanvasElement>;
  logo: ImageBitmap | null;
  /** Resolved CSS font-family names (brand fonts registered via FontFace). */
  fontPrimary: string;
  fontSecondary: string;
}
