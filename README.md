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
- **Six genuinely different templates** — Signature Energy, Cinematic Story,
  Quick Cut, Rapid Fire, Editorial Minimal, and Photo Story. Each is a
  reusable algorithm that picks the sequence, opener/closer, crops, motion,
  pacing, stacked layouts, and text-safe zones for any photo set. "Surprise
  Me" picks a template from the character of the set. Rapid Fire — built for
  huge sets flashing by in well under a second each — stays almost entirely
  hard cuts for readability, with an occasional brief fade or push-left on
  slides that have room to spare, a guaranteed hard-cut opener, and a soft
  landing on the closer.
- **Face-safe layout** — faces are detected locally; crops never slice through
  a face, pans settle on the subject, and wide family groups fall back to a
  full-image treatment over a blurred backdrop rather than being chopped.
- **Brand system, opt-in per reel** — upload your real logo and licensed font
  files (WOFF / WOFF2 / OTF / TTF), set colors, default CTA, website and
  Instagram handle. The kit is *saved*, not automatically applied: a reel ends
  with your sign-off (logo, handle, call to action) only when you switch
  branding on for that reel, because most reels are the work itself rather
  than an advertisement. Your fonts and colours are used either way, so an
  unbranded reel still looks like yours. Switch it on and the whole sign-off
  appears, pre-filled from the kit; from there you can drop the logo, drop the
  handle, or clear the call to action — an empty field means none, never a
  silent fall back to the saved default.
- **Music, two ways** — *Reel Studio Music*: upload tracks you're licensed to
  include and they're embedded in the MP4, with local beat/intensity analysis
  timing the cuts. *Instagram Audio*: build the reel to a song you'll add
  natively inside Instagram — provide a temporary reference track, pick the
  exact song section on a waveform (with suggested sections), preview in
  sync, then **Export for Instagram** produces a silent MP4 with identical
  visual timing plus a posting card (song, artist, start timestamp, and a
  visual sync check: "the first big hit lands as photo 4 appears"). The
  reference is never embedded in the export, and Reel Studio never claims a
  song is available on Instagram — Instagram remains the source of truth.
- **Versioning** — "Try Another Edit" creates a new arrangement as a new
  version (in the same style or any other); earlier versions are never
  destroyed.
- **Import from Dropbox** — when a Dropbox App key is configured, an
  "Import from Dropbox" button appears on the upload screen and on "Add
  photos" in the photo review screen. It uses Dropbox's own file picker
  (Chooser) — Dropbox handles sign-in in its own popup, this app never sees
  a Dropbox password, and picked files go straight into the same local
  ingestion pipeline as any other upload. See `.env.example` for how to
  get an App key.
- **Fix framing anywhere** — tap ⛶ on any photo in the editor's photo strip
  (or open it from the photos page) to drag and zoom a 9:16 crop. The strip
  thumbnail then shows that exact framing, and the reel rebuilds around it.
  Crops are non-destructive and always beat the automatic framing.
- **An honest preview** — the editor always shows how many photos are in the
  reel, its length, the per-photo pace, a playhead, and whether the preview
  is up to date or still rebuilding. Playback stops at the end with an
  explicit "End of reel · Replay" — it never loops.
- **Pace is a promise, not a variable** — each style has a comfortable pace
  as well as a physical floor. Too many photos for the time slot means fewer
  photos, never a faster reel: the engine stops selecting at the style's
  pace, and photos *you* added are always kept with a plain warning plus
  one-tap fixes (longer reel, or a style built for that speed). Where the two
  numbers differ, every screen quotes the comfortable one — "best with 6–10
  photos" is what the engine will actually do, not the absolute maximum.
- **Nothing is dropped in silence** — a 9-second reel can only hold so many
  photographs. When photos you added can't fit, the editor says exactly how
  many and why, shows them greyed at the end of the strip, and offers the two
  real fixes: the length that would hold them all, or a style that would.
- **A manual order means what it says** — once you place photos by hand, the
  reel is those photos in that order. Nudging one thumbnail never pulls in
  others you didn't choose. Photos added later join the end of your list.
- **Unknown is never treated as safe** — if the face model can't load, the
  photos it couldn't check are held for review rather than passing as clear,
  a failed check is never cached as a clean one, re-scanning repairs it, and
  export stays blocked until a person has looked. Photos with an open or
  blocked restricted flag are never sent to the optional AI route.
- **Export** — 1080×1920 MP4 (H.264 + AAC) rendered deterministically in the
  browser via WebCodecs, with a preflight checklist (safety review, missing
  images, text bounds, fonts, audio) before the button unlocks. Export waits
  for an in-flight rebuild rather than racing it, cancels cleanly if you leave,
  hands you the finished video before saving a copy (so a full disk can't lose
  the render), and names the file for what it really is when a browser falls
  back to WebM.
- **Versions keep their own settings** — editing a reel rebuilds the take
  you're looking at, in the style it was made in. Going back to Version 1 and
  changing the length no longer re-cuts it in Version 2's style, and the
  moment any edit lands, a stale "Exported" download is retired instead of
  being offered as if it were current.
- **Type your own length** — the 9s/12s/15s buttons are quick picks, not the
  limit. A custom number field (5–60s) sets any exact length. Next to it, a
  live "N included photos would naturally fill about Ys with [Style]" hint
  (with a one-tap "Use Ys") shows how long the current photo count would
  comfortably fill, independent of whatever length is set right now.
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

### Editorial intelligence

Reels are *edited*, not templated. `src/lib/editorial/` holds the engine:

- **Reel Purpose** (Photography / School / Surprise me) is separate from
  Style: purpose sets editorial priorities (selection, breadth, emphasis);
  style sets presentation character. Photography mode is selective — a tight
  22-photo reel beats a padded 35 — while School/Community mode optimizes
  the "parent test": many recognizable faces, real moments, breadth across
  the set, technical quality deliberately not dominant.
- **Editorial profiles** per photo: shot scale, people count, grouping,
  energy, brightness, purpose-weighted hero score.
- **Recurring-identity clustering** (fully local, recurrence only — no
  demographic inference) so the same student doesn't accidentally headline
  the whole reel.
- **Micro-sequences**: burst frames of one unfolding moment become rapid
  sequences; redundant alternate takes collapse to the best one.
- **Arc-based planning**: hook → establish → build → breath → payoff →
  close, shaped by purpose, style, the photographs and the music's energy
  curve; heroes hold longer and land on musical moments.
- **A second-pass Reel Critic** scores every constructed plan (opener,
  variety, people spread, brightness flow, redundancy, hero emphasis) and
  revises it before it ever becomes Version 1.
- **Three-state photo model**: REQUIRED (user-added — never dropped, made
  to work), ELIGIBLE (used when it improves the edit), EXCLUDED. Choosing
  photos does not freeze their order; only explicit manual reordering does,
  and Try Another Edit respects whichever locks exist.

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
