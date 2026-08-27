// Optional AI photo analysis — the only network hop in the product.
//
// The browser sends small downscaled JPEG previews (never originals, never
// restricted-child reference data) and receives structured judgments:
// story role, subject location, appeal, and notes. Deterministic local
// heuristics remain the baseline; this endpoint refines them when an
// ANTHROPIC_API_KEY is configured in Netlify. The key never reaches the
// browser.

import Anthropic from '@anthropic-ai/sdk';
import type { Context } from '@netlify/functions';

const MAX_IMAGES = 16;
const MAX_IMAGE_BYTES = 600_000; // base64 length guard per image

interface AnalyzeRequestImage {
  id: string;
  /** base64 JPEG, no data: prefix */
  data: string;
}

interface AnalyzeRequest {
  images: AnalyzeRequestImage[];
}

interface PhotoJudgment {
  id: string;
  storyRole?: string;
  subjectRect?: { x: number; y: number; w: number; h: number };
  appeal?: number;
  notes?: string;
}

const VALID_ROLES = new Set([
  'establishing',
  'interaction',
  'closeup',
  'detail',
  'movement',
  'portrait',
  'emotional',
  'closing',
]);

export default async (req: Request, _context: Context): Promise<Response> => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Not configured — the client treats this as "AI unavailable" and
    // continues with local heuristics.
    return json({ enabled: false, results: [] }, 200);
  }

  let body: AnalyzeRequest;
  try {
    body = (await req.json()) as AnalyzeRequest;
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }
  if (!Array.isArray(body.images) || body.images.length === 0) {
    return json({ error: 'No images provided' }, 400);
  }
  const images = body.images.slice(0, MAX_IMAGES).filter(
    (img) =>
      typeof img.id === 'string' &&
      typeof img.data === 'string' &&
      img.data.length > 0 &&
      img.data.length <= MAX_IMAGE_BYTES,
  );
  if (images.length === 0) {
    return json({ error: 'Images too large or malformed' }, 400);
  }

  const client = new Anthropic({ apiKey });
  const model = process.env.VISION_MODEL || 'claude-fable-5';

  const content: Anthropic.ContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i + 1} (id: ${img.id}):` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: img.data },
    });
  });
  content.push({
    type: 'text',
    text: `You are helping a professional photography studio arrange these photos into a short vertical social reel. For EACH photo, provide:
- "id": the photo id given above
- "storyRole": one of establishing | interaction | closeup | detail | movement | portrait | emotional | closing
- "subjectRect": the main subject's bounding region as fractions of the image {x, y, w, h} (0..1)
- "appeal": 0..1 — how strong this image is as reel material (sharp, engaging, well composed)
- "notes": at most one short sentence, only if something matters for cropping (e.g. "subject far left")

Respond with ONLY a JSON array, no prose, like:
[{"id":"…","storyRole":"portrait","subjectRect":{"x":0.3,"y":0.2,"w":0.4,"h":0.6},"appeal":0.8,"notes":""}]`,
  });

  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content }],
    });

    if (response.stop_reason === 'refusal') {
      return json({ enabled: true, results: [], refused: true }, 200);
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const results = parseJudgments(text, new Set(images.map((i) => i.id)));
    return json({ enabled: true, results }, 200);
  } catch (err) {
    console.error('Vision analysis failed:', err);
    // Soft-fail: the app continues with local heuristics.
    return json({ enabled: true, results: [], error: 'analysis-failed' }, 200);
  }
};

function parseJudgments(text: string, validIds: Set<string>): PhotoJudgment[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as unknown[];
    const out: PhotoJudgment[] = [];
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue;
      const j = item as Record<string, unknown>;
      if (typeof j.id !== 'string' || !validIds.has(j.id)) continue;
      const judgment: PhotoJudgment = { id: j.id };
      if (typeof j.storyRole === 'string' && VALID_ROLES.has(j.storyRole)) {
        judgment.storyRole = j.storyRole;
      }
      const r = j.subjectRect as Record<string, unknown> | undefined;
      if (
        r &&
        [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && v >= 0 && v <= 1)
      ) {
        judgment.subjectRect = {
          x: r.x as number,
          y: r.y as number,
          w: r.w as number,
          h: r.h as number,
        };
      }
      if (typeof j.appeal === 'number' && j.appeal >= 0 && j.appeal <= 1) {
        judgment.appeal = j.appeal;
      }
      if (typeof j.notes === 'string') judgment.notes = j.notes.slice(0, 200);
      out.push(judgment);
    }
    return out;
  } catch {
    return [];
  }
}

const json = (data: unknown, status: number): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
