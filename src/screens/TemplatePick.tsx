import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from 'react-router-dom';
import { db } from '../lib/db';
import { TEMPLATES, surpriseMe } from '../lib/engine/templates';
import { toSequencePhoto, eligiblePhotos } from '../lib/engine/buildReel';
import { generateVersion } from '../lib/reels';
import { useToasts } from '../components/toast';
import type { TemplateId } from '../lib/types';

/** Tiny pure-CSS motion sketch that hints at each template's feel. */
function TemplateSketch({ id }: { id: TemplateId }) {
  const anims: Record<TemplateId, { duration: string; blocks: number; fade: boolean }> = {
    'signature-energy': { duration: '1.7s', blocks: 3, fade: false },
    'cinematic-story': { duration: '3s', blocks: 2, fade: true },
    'quick-cut': { duration: '0.9s', blocks: 4, fade: false },
    'rapid-fire': { duration: '0.35s', blocks: 6, fade: false },
    'editorial-minimal': { duration: '2.4s', blocks: 2, fade: true },
    'photo-story': { duration: '2s', blocks: 3, fade: false },
  };
  const a = anims[id];
  return (
    <div
      style={{
        aspectRatio: '9 / 16',
        width: 72,
        borderRadius: 8,
        overflow: 'hidden',
        position: 'relative',
        background: id === 'editorial-minimal' ? 'var(--paper-sunken)' : '#161310',
        flexShrink: 0,
      }}
    >
      <style>{`
        @keyframes sketch-pan { 0% { transform: translateX(-6%) scale(1.12); } 100% { transform: translateX(6%) scale(1.12); } }
        @keyframes sketch-swap-${id} {
          0%, ${100 / a.blocks - (a.fade ? 12 : 2)}% { opacity: 1; }
          ${100 / a.blocks}%, 100% { opacity: 0; }
        }
      `}</style>
      {Array.from({ length: a.blocks }).map((_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            inset: id === 'editorial-minimal' ? '12% 14%' : 0,
            background: `linear-gradient(${125 + i * 60}deg, #b39b7c, #6e5a44 55%, #3d332a)`,
            animation: `sketch-swap-${id} ${parseFloat(a.duration) * a.blocks}s infinite`,
            animationDelay: `${i * parseFloat(a.duration)}s`,
            opacity: 0,
            borderRadius: id === 'editorial-minimal' ? 3 : 0,
          }}
        >
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'radial-gradient(circle at 50% 38%, rgba(255,244,230,0.5), transparent 42%)',
              animation: `sketch-pan ${a.duration} ease-in-out infinite alternate`,
            }}
          />
        </div>
      ))}
    </div>
  );
}

export function TemplatePickScreen() {
  const { reelId } = useParams<{ reelId: string }>();
  const navigate = useNavigate();
  const show = useToasts((s) => s.show);
  const [building, setBuilding] = useState<TemplateId | 'surprise' | null>(null);

  const photos = useLiveQuery(
    () => (reelId ? db.photos.where('reelId').equals(reelId).toArray() : []),
    [reelId],
  );

  const choose = async (templateId: TemplateId, viaSurprise = false) => {
    if (!reelId) return;
    setBuilding(viaSurprise ? 'surprise' : templateId);
    try {
      await generateVersion(reelId, templateId);
      navigate(`/reel/${reelId}/edit`);
    } catch (err) {
      setBuilding(null);
      show(
        'We couldn’t build the reel just now. Your photos are safe — try again.',
        'error',
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const surprise = () => {
    if (!photos) return;
    const seq = eligiblePhotos(photos).map(toSequencePhoto);
    const picked = surpriseMe(seq, Date.now() % 97);
    void choose(picked, true);
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="page-header">
        <div>
          <h1>Choose the vibe</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Every style arranges your photos, pacing and type on its own.
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-secondary" onClick={surprise} disabled={building !== null}>
          {building === 'surprise' ? <span className="spinner" /> : '✨'} Surprise Me
        </button>
      </div>

      <div className="stack-v">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            className="panel row"
            style={{ textAlign: 'left', gap: 16, cursor: 'pointer', alignItems: 'center' }}
            disabled={building !== null}
            onClick={() => void choose(t.id)}
          >
            <TemplateSketch id={t.id} />
            <div style={{ flex: 1 }}>
              <h3>{t.name}</h3>
              <p className="muted" style={{ fontSize: 14, margin: '4px 0' }}>
                {t.description}
              </p>
              <p className="faint">
                {t.pace} · {t.idealFor}
              </p>
            </div>
            {building === t.id ? <span className="spinner" /> : <span style={{ color: 'var(--ink-faint)' }}>→</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
