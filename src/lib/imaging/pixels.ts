// Pure pixel-level math shared by stats, similarity and correction.
// Operates on plain arrays so the logic is unit-testable in Node.

export interface PixelBuffer {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

export const lumaOf = (r: number, g: number, b: number): number =>
  0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Grayscale (0..255) downsample to exactly w×h using box sampling. */
export function toGrayGrid(buf: PixelBuffer, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  const { data, width, height } = buf;
  for (let gy = 0; gy < h; gy++) {
    const y0 = Math.floor((gy * height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / h));
    for (let gx = 0; gx < w; gx++) {
      const x0 = Math.floor((gx * width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / w));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          sum += lumaOf(data[i], data[i + 1], data[i + 2]);
          n++;
        }
      }
      out[gy * w + gx] = sum / n;
    }
  }
  return out;
}

/** Rough skin-tone detector in RGB space (deliberately broad). */
export function looksLikeSkin(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (
    r > 60 &&
    g > 35 &&
    b > 15 &&
    r > b &&
    r >= g &&
    max - min > 12 &&
    Math.abs(r - g) > 8 &&
    max < 250
  );
}

export const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
