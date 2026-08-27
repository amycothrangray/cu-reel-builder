// Loads everything renderFrame needs: decoded images (corrected variant when
// enabled), blurred backdrops, the brand logo, and registered brand fonts.

import { blobKey, getBlob } from '../db';
import { correctionAllowed, type BrandConfig, type PhotoRecord } from '../types';
import type { RenderResources, Timeline } from './types';

export const FALLBACK_PRIMARY = "'Fraunces', Georgia, serif";
export const FALLBACK_SECONDARY = "'Inter', -apple-system, sans-serif";

const registeredFonts = new Map<string, string>(); // assetKey → family

/** Register an uploaded brand font with the document; returns the family. */
export async function registerBrandFont(
  assetKey: string,
  family: string,
): Promise<string | null> {
  if (registeredFonts.has(assetKey)) return registeredFonts.get(assetKey)!;
  const blob = await getBlob(assetKey);
  if (!blob) return null;
  try {
    const face = new FontFace(family, await blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    registeredFonts.set(assetKey, family);
    return family;
  } catch (err) {
    console.warn('Could not load brand font', err);
    return null;
  }
}

export async function resolveBrandFonts(
  brand: BrandConfig,
): Promise<{ primary: string; secondary: string }> {
  let primary = FALLBACK_PRIMARY;
  let secondary = FALLBACK_SECONDARY;
  if (brand.primaryFont) {
    const fam = await registerBrandFont(brand.primaryFont.assetKey, brand.primaryFont.family);
    if (fam) primary = `'${fam}', ${FALLBACK_PRIMARY}`;
  }
  if (brand.secondaryFont) {
    const fam = await registerBrandFont(brand.secondaryFont.assetKey, brand.secondaryFont.family);
    if (fam) secondary = `'${fam}', ${FALLBACK_SECONDARY}`;
  }
  return { primary, secondary };
}

/** Pre-blur an image into a frame-filling backdrop (done once, not per frame). */
function makeBlurred(img: ImageBitmap): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  // Small intermediate + canvas filter blur = cheap and smooth.
  const w = 270;
  const h = Math.max(1, Math.round((img.height / img.width) * w));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.filter = 'blur(12px) brightness(0.9)';
  ctx.drawImage(img, -w * 0.1, -h * 0.1, w * 1.2, h * 1.2);
  return canvas;
}

export interface LoadedResources extends RenderResources {
  dispose: () => void;
}

/**
 * Load resources for the photos a timeline actually uses. Uses the stored
 * preview (≤1600px) — plenty for 1080×1920 output — and the corrected
 * variant when the photo has correction enabled.
 */
export async function loadResources(
  timeline: Timeline,
  photos: PhotoRecord[],
  brand: BrandConfig,
): Promise<LoadedResources> {
  const photoById = new Map(photos.map((p) => [p.id, p]));
  const neededIds = new Set<string>();
  for (const clip of timeline.clips) {
    for (const layer of clip.layers) neededIds.add(layer.photoId);
  }

  const images = new Map<string, ImageBitmap | HTMLCanvasElement>();
  const blurred = new Map<string, HTMLCanvasElement>();
  const bitmaps: ImageBitmap[] = [];

  for (const id of neededIds) {
    const photo = photoById.get(id);
    if (!photo) continue;
    const useCorrected =
      photo.correctionEnabled && photo.hasCorrected && correctionAllowed(photo);
    const blob =
      (useCorrected ? await getBlob(blobKey.corrected(id)) : undefined) ??
      (await getBlob(blobKey.preview(id)));
    if (!blob) continue;
    const bitmap = await createImageBitmap(blob);
    bitmaps.push(bitmap);
    images.set(id, bitmap);
    blurred.set(id, makeBlurred(bitmap));
  }

  let logo: ImageBitmap | null = null;
  if (brand.logoAssetKey) {
    const blob = await getBlob(brand.logoAssetKey);
    if (blob) {
      try {
        logo = await createImageBitmap(blob);
        bitmaps.push(logo);
      } catch {
        logo = null;
      }
    }
  }

  const fonts = await resolveBrandFonts(brand);

  return {
    images,
    blurred,
    logo,
    fontPrimary: fonts.primary,
    fontSecondary: fonts.secondary,
    dispose: () => {
      for (const b of bitmaps) b.close();
    },
  };
}
