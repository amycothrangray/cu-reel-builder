import { describe, expect, it } from 'vitest';
import { guessMimeType } from '../src/lib/dropbox';

describe('Dropbox import: filename -> mime type', () => {
  it('recognizes supported photo extensions, case-insensitively', () => {
    expect(guessMimeType('beach.jpg')).toBe('image/jpeg');
    expect(guessMimeType('Beach.JPEG')).toBe('image/jpeg');
    expect(guessMimeType('portrait.PNG')).toBe('image/png');
    expect(guessMimeType('IMG_0001.HEIC')).toBe('image/heic');
    expect(guessMimeType('IMG_0002.heif')).toBe('image/heif');
  });

  it('falls back to a generic type for anything else', () => {
    expect(guessMimeType('notes.txt')).toBe('application/octet-stream');
    expect(guessMimeType('noextension')).toBe('application/octet-stream');
  });
});
