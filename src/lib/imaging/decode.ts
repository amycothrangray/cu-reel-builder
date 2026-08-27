// File decoding, HEIC handling, and preview/thumbnail generation.
// Originals are always preserved untouched in the blob store; previews are
// working copies sized for analysis and preview rendering.

const HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];

export const isHeic = (file: File): boolean =>
  HEIC_TYPES.includes(file.type) || /\.heic$|\.heif$/i.test(file.name);

/**
 * Decode any supported upload to an ImageBitmap. Tries the native decoder
 * first (Safari decodes HEIC natively); falls back to a lazily-loaded wasm
 * HEIC converter elsewhere. The user never needs to know HEIC exists.
 */
export async function decodeImageFile(file: Blob & { name?: string; type: string }): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch (err) {
    if (isHeic(file as File)) {
      const { default: heic2any } = await import('heic2any');
      const converted = (await heic2any({
        blob: file,
        toType: 'image/jpeg',
        quality: 0.95,
      })) as Blob;
      return createImageBitmap(converted);
    }
    throw err;
  }
}

/** Draw a bitmap into a canvas scaled so its long edge is at most `maxEdge`. */
export function scaleToCanvas(
  bitmap: ImageBitmap,
  maxEdge: number,
): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = 'image/jpeg',
  quality = 0.9,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))),
      type,
      quality,
    );
  });
}

export interface Derivatives {
  width: number;
  height: number;
  /** ≤1600px long edge — used for analysis, correction and rendering. */
  preview: Blob;
  /** ≤400px long edge — used for grids and strips. */
  thumb: Blob;
  previewCanvas: HTMLCanvasElement;
}

export const PREVIEW_EDGE = 1600;
export const THUMB_EDGE = 400;

export async function makeDerivatives(bitmap: ImageBitmap): Promise<Derivatives> {
  const previewCanvas = scaleToCanvas(bitmap, PREVIEW_EDGE);
  const thumbCanvas = scaleToCanvas(bitmap, THUMB_EDGE);
  const [preview, thumb] = await Promise.all([
    canvasToBlob(previewCanvas, 'image/jpeg', 0.9),
    canvasToBlob(thumbCanvas, 'image/jpeg', 0.82),
  ]);
  return { width: bitmap.width, height: bitmap.height, preview, thumb, previewCanvas };
}
