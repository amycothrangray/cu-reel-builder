// Copies the face-api model weights we actually use from node_modules into
// public/models so they are served same-origin (no CDN, no third-party request).
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@vladmandic', 'face-api', 'model');
const dest = join(root, 'public', 'models');

const files = [
  // Detection (small, fast — used for crop planning and text-safe zones)
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model.bin',
  // Landmarks (needed to align faces before computing embeddings)
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  // 128-d embeddings (restricted-child matching, fully local)
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin',
];

if (!existsSync(src)) {
  console.error('face-api models not found — run npm install first.');
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
for (const f of files) {
  copyFileSync(join(src, f), join(dest, f));
}
console.log(`Copied ${files.length} model files to public/models`);
