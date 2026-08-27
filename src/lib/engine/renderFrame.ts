// renderFrame — draws one frame of a Timeline at time t onto a 2D canvas.
// Pure with respect to its inputs: the same timeline, resources and t always
// produce the same pixels. Used by both the live preview and the exporter.

import type { NRect } from '../types';
import type {
  Clip,
  ClipLayer,
  Easing,
  RenderResources,
  TextOverlay,
  Timeline,
} from './types';

const ease = (kind: Easing, t: number): number => {
  switch (kind) {
    case 'linear':
      return t;
    case 'ease-out':
      return 1 - (1 - t) * (1 - t);
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }
};

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const lerpRect = (a: NRect, b: NRect, t: number): NRect => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
});

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  timeline: Timeline,
  tMs: number,
  res: RenderResources,
): void {
  const { width: W, height: H } = timeline;
  ctx.save();
  ctx.fillStyle = timeline.background;
  ctx.fillRect(0, 0, W, H);

  const clips = timeline.clips;
  const idx = clips.findIndex((c) => tMs >= c.startMs && tMs < c.endMs);
  const activeIdx = idx >= 0 ? idx : tMs >= timeline.durationMs ? clips.length - 1 : 0;
  const clip = clips[activeIdx];
  if (!clip) {
    ctx.restore();
    return;
  }

  const transition = clip.transitionIn;
  const inTransition =
    activeIdx > 0 &&
    transition.kind !== 'cut' &&
    tMs < clip.startMs + transition.durationMs;

  if (inTransition) {
    const prev = clips[activeIdx - 1];
    const progress = (tMs - clip.startMs) / transition.durationMs;
    // Previous clip holds its final state under the incoming one.
    drawClip(ctx, timeline, prev, prev.endMs - 1, res);
    ctx.save();
    if (transition.kind === 'fade') {
      ctx.globalAlpha = progress;
      drawClip(ctx, timeline, clip, tMs, res);
    } else {
      const eased = ease('ease-in-out', progress);
      const dy = transition.kind === 'push-up' ? (1 - eased) * H : 0;
      const dx = transition.kind === 'push-left' ? (1 - eased) * W : 0;
      ctx.translate(dx, dy);
      drawClip(ctx, timeline, clip, tMs, res);
    }
    ctx.restore();
  } else {
    drawClip(ctx, timeline, clip, tMs, res);
  }

  for (const overlay of timeline.overlays) {
    if (tMs >= overlay.startMs && tMs < overlay.endMs) {
      drawOverlay(ctx, timeline, overlay, tMs, res);
    }
  }
  ctx.restore();
}

function drawClip(
  ctx: CanvasRenderingContext2D,
  timeline: Timeline,
  clip: Clip,
  tMs: number,
  res: RenderResources,
): void {
  const progress = Math.min(
    1,
    Math.max(0, (tMs - clip.startMs) / Math.max(1, clip.endMs - clip.startMs)),
  );
  for (const layer of clip.layers) {
    drawLayer(ctx, timeline, layer, progress, res);
  }
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  timeline: Timeline,
  layer: ClipLayer,
  progress: number,
  res: RenderResources,
): void {
  const img = res.images.get(layer.photoId);
  if (!img) return;
  const { width: W, height: H } = timeline;
  const dest = {
    x: layer.dest.x * W,
    y: layer.dest.y * H,
    w: layer.dest.w * W,
    h: layer.dest.h * H,
  };
  const t = ease(layer.easing, progress);
  const crop = lerpRect(layer.crop, layer.cropEnd, t);

  ctx.save();
  ctx.beginPath();
  ctx.rect(dest.x, dest.y, dest.w, dest.h);
  ctx.clip();

  if (layer.fill === 'cover') {
    drawCropped(ctx, img, crop, dest);
  } else {
    if (layer.fill === 'contain-blur') {
      const blurred = res.blurred.get(layer.photoId);
      if (blurred) {
        // Blurred backdrop covers the dest region.
        const cover = coverRect(blurred.width, blurred.height, dest.w, dest.h);
        ctx.drawImage(
          blurred,
          dest.x - (cover.w - dest.w) / 2,
          dest.y - (cover.h - dest.h) / 2,
          cover.w,
          cover.h,
        );
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(dest.x, dest.y, dest.w, dest.h);
      }
    }
    // Contained image with a barely-there scale drift for life.
    const drift = 1 + 0.015 * t;
    const contain = containRect(img.width, img.height, dest.w * 0.92, dest.h * 0.86);
    const w = contain.w * drift;
    const h = contain.h * drift;
    ctx.drawImage(img, dest.x + (dest.w - w) / 2, dest.y + (dest.h - h) / 2, w, h);
  }
  ctx.restore();
}

function drawCropped(
  ctx: CanvasRenderingContext2D,
  img: ImageBitmap | HTMLCanvasElement,
  crop: NRect,
  dest: { x: number; y: number; w: number; h: number },
): void {
  const sx = crop.x * img.width;
  const sy = crop.y * img.height;
  const sw = crop.w * img.width;
  const sh = crop.h * img.height;
  ctx.drawImage(img, sx, sy, sw, sh, dest.x, dest.y, dest.w, dest.h);
}

const coverRect = (iw: number, ih: number, dw: number, dh: number) => {
  const scale = Math.max(dw / iw, dh / ih);
  return { w: iw * scale, h: ih * scale };
};

const containRect = (iw: number, ih: number, dw: number, dh: number) => {
  const scale = Math.min(dw / iw, dh / ih);
  return { w: iw * scale, h: ih * scale };
};

// ---------------------------------------------------------------------------
// Overlays

function overlayAlphaAndOffset(
  overlay: TextOverlay,
  tMs: number,
): { alpha: number; dy: number; revealFrac: number } {
  const IN = 450;
  const OUT = 350;
  const tIn = Math.min(1, (tMs - overlay.startMs) / IN);
  const tOut = Math.min(1, (overlay.endMs - tMs) / OUT);
  const alpha = Math.min(tIn, tOut);
  let dy = 0;
  let revealFrac = 1;
  if (overlay.animation === 'slide-up') {
    dy = (1 - ease('ease-out', tIn)) * 26;
  } else if (overlay.animation === 'reveal') {
    revealFrac = ease('ease-out', tIn);
  }
  return { alpha: ease('ease-in-out', Math.max(0, alpha)), dy, revealFrac };
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  timeline: Timeline,
  overlay: TextOverlay,
  tMs: number,
  res: RenderResources,
): void {
  const { width: W, height: H } = timeline;
  const { alpha, dy, revealFrac } = overlayAlphaAndOffset(overlay, tMs);
  if (alpha <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  if (overlay.kind === 'logo') {
    if (res.logo) {
      const maxW = overlay.sizePx * (W / 1080) * 2.2;
      const scale = Math.min(maxW / res.logo.width, (maxW * 0.6) / res.logo.height);
      const w = res.logo.width * scale;
      const h = res.logo.height * scale;
      ctx.drawImage(res.logo, overlay.pos.x * W - w / 2, overlay.pos.y * H - h / 2 + dy, w, h);
    }
    ctx.restore();
    return;
  }

  const family = overlay.font === 'primary' ? res.fontPrimary : res.fontSecondary;
  const size = overlay.sizePx * (W / 1080);
  ctx.font = `${overlay.kind === 'caption' || overlay.kind === 'handle' ? 400 : 500} ${size}px ${family}`;
  ctx.textAlign = overlay.align;
  ctx.textBaseline = 'middle';
  const spacing = overlay.letterSpacing * size;
  const canSpace = 'letterSpacing' in ctx;
  if (canSpace) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${spacing}px`;
  }

  const text = overlay.uppercase ? overlay.text.toUpperCase() : overlay.text;
  const maxWidth = W * 0.84;
  const lines = wrapText(ctx, text, maxWidth);
  const lineHeight = size * 1.28;
  const blockH = lines.length * lineHeight;
  const cx = overlay.pos.x * W;
  const cy = overlay.pos.y * H + dy;

  // Soft scrim band behind the text for legibility over photography.
  if (overlay.scrim > 0) {
    const bandH = blockH + size * 1.6;
    const grad = ctx.createLinearGradient(0, cy - bandH, 0, cy + bandH);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, `rgba(0,0,0,${overlay.scrim})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, cy - bandH, W, bandH * 2);
  }

  ctx.fillStyle = overlay.color;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = size * 0.12;
  ctx.shadowOffsetY = 1;

  lines.forEach((line, i) => {
    const y = cy - blockH / 2 + lineHeight * (i + 0.5);
    if (overlay.animation === 'reveal' && revealFrac < 1) {
      // Clip a widening window around the text for a gentle reveal.
      ctx.save();
      const lineW = ctx.measureText(line).width;
      const half = (lineW / 2 + size) * revealFrac;
      ctx.beginPath();
      ctx.rect(cx - half, y - lineHeight, half * 2, lineHeight * 2);
      ctx.clip();
      ctx.fillText(line, cx, y);
      ctx.restore();
    } else {
      ctx.fillText(line, cx, y);
    }
  });

  if (canSpace) {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
  }
  ctx.restore();
}
