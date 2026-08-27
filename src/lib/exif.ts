import exifr from 'exifr';
import type { ExifSummary } from './types';

/** Read the EXIF fields classification cares about. Failure is non-fatal. */
export async function readExif(file: Blob): Promise<ExifSummary> {
  try {
    const raw = await exifr.parse(file, {
      pick: [
        'Make',
        'Model',
        'LensModel',
        'FocalLength',
        'FNumber',
        'ISO',
        'Software',
        'DateTimeOriginal',
      ],
    });
    if (!raw) return {};
    return {
      make: raw.Make,
      model: raw.Model,
      lensModel: raw.LensModel,
      focalLength: raw.FocalLength,
      fNumber: raw.FNumber,
      iso: raw.ISO,
      software: raw.Software,
      dateTaken: raw.DateTimeOriginal ? String(raw.DateTimeOriginal) : undefined,
    };
  } catch {
    return {};
  }
}
