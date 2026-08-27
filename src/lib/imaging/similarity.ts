import { toGrayGrid, type PixelBuffer } from './pixels';

/**
 * 64-bit difference hash (dHash): downsample to 9×8 luma, compare horizontal
 * neighbours. Cheap, deterministic, robust to resizing and mild edits.
 */
export function computePhash(buf: PixelBuffer): string {
  const grid = toGrayGrid(buf, 9, 8);
  let hash = 0n;
  let bit = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (grid[y * 9 + x] > grid[y * 9 + x + 1]) {
        hash |= 1n << bit;
      }
      bit++;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/** Hamming distance between two 64-bit hex hashes (0 = identical). */
export function phashDistance(a: string, b: string): number {
  let x = BigInt('0x' + a) ^ BigInt('0x' + b);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Distance at or below this reads as "near-duplicate" for reel purposes. */
export const DUPLICATE_THRESHOLD = 10;

export const isNearDuplicate = (a: string, b: string): boolean =>
  phashDistance(a, b) <= DUPLICATE_THRESHOLD;
