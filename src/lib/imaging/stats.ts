import type { ImageStats } from '../types';
import { lumaOf, looksLikeSkin, type PixelBuffer } from './pixels';

/**
 * Deterministic measurements over a downscaled preview. All values are cheap
 * single-pass statistics; nothing here modifies pixels.
 */
export function computeStats(buf: PixelBuffer): ImageStats {
  const { data, width, height } = buf;
  const n = width * height;

  let lumaSum = 0;
  let lumaSqSum = 0;
  let satSum = 0;
  let warmSum = 0;
  let clipped = 0;
  let crushed = 0;
  let skinPixels = 0;
  let skinWarmSum = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luma = lumaOf(r, g, b);
    lumaSum += luma;
    lumaSqSum += luma * luma;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    satSum += max === 0 ? 0 : (max - min) / max;

    warmSum += (r - b) / 255;

    if (luma > 248) clipped++;
    if (luma < 8) crushed++;

    if (looksLikeSkin(r, g, b)) {
      skinPixels++;
      // How far skin skews toward orange beyond a natural baseline:
      // natural skin sits near r-g ≈ 20–45; excess beyond that reads orange.
      skinWarmSum += Math.max(0, r - g - 45) / 255;
    }
  }

  const meanLuma = lumaSum / n / 255;
  const variance = Math.max(0, lumaSqSum / n - (lumaSum / n) ** 2);
  const contrast = Math.sqrt(variance) / 255;

  // Sharpness: variance of a 3×3 Laplacian over luma, sampled on a stride to
  // keep this fast on large previews.
  let lapSum = 0;
  let lapSq = 0;
  let lapN = 0;
  const stride = Math.max(1, Math.floor(Math.sqrt(n / 90000)));
  const lumaAt = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return lumaOf(data[i], data[i + 1], data[i + 2]);
  };
  for (let y = stride; y < height - stride; y += stride) {
    for (let x = stride; x < width - stride; x += stride) {
      const lap =
        4 * lumaAt(x, y) -
        lumaAt(x - stride, y) -
        lumaAt(x + stride, y) -
        lumaAt(x, y - stride) -
        lumaAt(x, y + stride);
      lapSum += lap;
      lapSq += lap * lap;
      lapN++;
    }
  }
  const lapVar = lapN > 0 ? Math.max(0, lapSq / lapN - (lapSum / lapN) ** 2) : 0;
  // Normalize into a rough 0..1 band (300+ variance is decidedly sharp).
  const sharpness = Math.min(1, lapVar / 300);

  return {
    sharpness,
    contrast,
    saturation: satSum / n,
    warmth: warmSum / n,
    highlightClip: clipped / n,
    shadowCrush: crushed / n,
    meanLuma,
    skinWarmthExcess: skinPixels > 0 ? skinWarmSum / skinPixels : 0,
    skinFraction: skinPixels / n,
  };
}
