# Reel Studio

A branded photography reel maker for a professional photography team. Upload a
session, choose the vibe, get a polished 9:16 MP4 — no video editing required.

**Upload → Choose → Preview → Export.**

## What it does

- **Photo ingestion** — drag-and-drop or photo-library upload of JPEG, PNG and
  iPhone HEIC files. Originals are preserved untouched; optimized previews and
  thumbnails are generated automatically, and analysis starts immediately.
- **Pro vs. mobile classification** — EXIF plus image measurements decide
  whether a photo is professional-camera work or a casual phone shot. Uncertain
  photos are left untouched. Manual overrides always win.
- **Restrained mobile correction** — phone photos get conservative, corrective
  processing only (contrast softening, highlight recovery, gentle warmth and
  orange-skin neutralization) so they sit naturally beside professional work.
  Professional photography is never altered — presentation-only transforms
  (crop, pan, gentle zoom, blurred background fill). Before/after compare and
  Restore Original per photo.
- **Five genuinely different templates** — Signature Energy, Cinematic Story,
  Quick Cut, Editorial Minimal, and Photo Story. Each is a reusable algorithm
  that picks the sequence, opener/closer, crops, motion, pacing, stacked
  layouts, and text-safe zones for any photo set. "Surprise Me" picks a
  template from the character of the set.
- **Face-safe layout** — faces are detected locally; crops never slice through
  a face, pans settle on the subject, and wide family groups fall back to a
  full-image treatment over a blurred backdrop rather than being chopped.
- **Brand system** — upload your real logo and licensed font files (WOFF /
  WOFF2 / OTF / TTF), set colors, default CTA, website and Instagram handle.
  Every reel uses them automatically.
- **Music** — upload tracks or reuse stored ones. Local beat detection aligns
  meaningful cuts to the music without forcing every cut to a beat.
- **Versioning** — "Try Another Edit" creates a new arrangement as a new
  version; earlier versions are never destroyed.
- **Export** — 1080×1920 MP4 (H.264 + AAC) rendered deterministically in the
  browser via WebCodecs, with a preflight checklist (safety review, missing
  images, text bounds, fonts, audio) before the button unlocks.
- **Restricted-child protection** — administrators register reference photos
  for children who must not appear in marketing. Face embeddings are computed
  **locally in the browser**, stored encrypted, and every upload is checked.
  Possible matches flag the photo for human review ("Possible restricted child
  detected — review required" — never presented as certain), and export is
  blocked until every flag is reviewed. The matching threshold deliberately
  favors false positives. Overrides are admin-gated and audit-logged.

## Architecture

| Where | What runs there |
|---|---|
| **Browser** | Everything by default: ingestion, HEIC conversion, analysis, classification, correction, face detection & embeddings, template algorithms, beat detection, preview, MP4 encoding, storage (IndexedDB). |
| **Netlify Functions** | One optional route, `/api/analyze-photos`, which proxies small downscaled previews to the Claude vision API for smarter triage/crop planning. The API key lives server-side only. The app is fully functional without it. |

Key modules:

- `src/lib/engine/` — the timeline engine. Templates emit a plain serializable
  `Timeline`; `renderFrame.ts` draws any timeline at any time `t`; the preview
  player and the exporter share that one function, so what you see is what you
  export.
- `src/lib/engine/export/provider.ts` — `VideoGenerationProvider` abstraction
  (`createJob` / `checkStatus` / `retrieveOutput`). The default provider
  renders locally with WebCodecs + [Mediabunny](https://mediabunny.dev)
  muxing; a MediaRecorder fallback covers older browsers; a server or external
  renderer can be added later without UI changes. No generative video ever
  touches the photographs.
- `src/lib/classify/`, `src/lib/imaging/` — deterministic, unit-tested pixel
  math (stats, dHash similarity, correction) — no AI where code does the job.
- `src/lib/restricted/` — matching math and AES-GCM-encrypted local storage
  for restricted-child reference embeddings.
- `netlify/functions/analyze-photos.mts` — the only network AI hop.

### AI vs. deterministic code

AI (optional, behind the serverless route) makes *decisions*: story roles,
subject regions, appeal. Deterministic code performs *transformations*:
resizing, cropping, rendering, transitions, text, beat detection, encoding.
Analysis results are cached by content hash so re-used photos cost nothing.

### Privacy

- Photos, reels, brand assets and restricted-child data stay in the browser
  (IndexedDB). Nothing is uploaded by default.
- When AI analysis is configured, only ≤512px preview JPEGs of reel photos are
  sent — never originals, never restricted-child references.
- Restricted-child reference photos never leave the device; only encrypted
  128-d embeddings plus small review thumbnails are stored.
- No client photos are ever used for model training. No secret keys exist in
  browser code.

## Development

```bash
npm install
npm run dev        # Vite dev server at http://localhost:5173
npm test           # vitest suite (classification, layout, templates, safety…)
npm run build      # copies face models, typechecks, builds to dist/
```

The optional AI route needs the Netlify runtime: `npx netlify dev` serves the
app together with the function. Without it the app silently uses local
heuristics.

## Deploying to Netlify

1. Push this repository to Git and create a new Netlify site from it.
2. Build settings are read from `netlify.toml`:
   - build command: `npm run build`
   - publish directory: `dist`
   - functions directory: `netlify/functions`
3. (Optional) In **Site settings → Environment variables**, set
   `ANTHROPIC_API_KEY` to enable AI photo analysis, and optionally
   `VISION_MODEL` to override the model. See `.env.example`.
4. Deploy. No source edits are required.

## Team use & roles

The role model is Admin vs. Team Member. In this MVP, admin-only areas (Photo
Restrictions, restricted-photo overrides, the audit log) sit behind a local
PIN (PBKDF2-hashed on device) and admin actions are audit-logged. The gate is
structured as a credential check so Phase 2 server-side authentication is a
drop-in replacement. Note that in this MVP, data is per-browser: each team
member's reels live on their own device.

## Roadmap (Phase 2 / 3)

- Server-side team accounts, roles, and shared reel library
- Server-held keys for restricted-child data
- Smarter beat matching and richer storytelling
- Multiple brand profiles, licensed music-library integrations
- Optional external rendering providers behind `VideoGenerationProvider`

## Manual test checklist

Beyond `npm test`, verify on real devices:

- Safari on iPhone (photo-library upload, HEIC, preview playback, export)
- Chrome desktop (drag-and-drop, large batches)
- Many large camera JPGs at once; mixed landscape/portrait; mixed camera/iPhone
- Sets containing multiple faces and group shots
