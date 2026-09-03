import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { blobKey, db } from '../lib/db';
import {
  getBrand,
  generateVersion,
  rebuildActiveVersion,
  removePhotosFromArrangement,
  touchReel,
  addMusicTrack,
  clearInstagramAudio,
} from '../lib/reels';
import { formatTimestamp } from '../lib/audio/segments';
import { InstagramAudioModal } from '../components/InstagramAudioModal';
import { CropModal } from '../components/CropModal';
import { Modal } from '../components/Modal';
import { loadResources, type LoadedResources } from '../lib/engine/resources';
import { ReelPlayer } from '../lib/engine/preview';
import {
  TEMPLATES,
  getTemplate,
  pacingFor,
  estimateDurationSec,
  lengthThatFitsSec,
  styleThatFits,
} from '../lib/engine/templates';
import { useRebuildStatus } from '../lib/rebuildStatus';
import { useBlobUrl } from '../components/hooks';
import { useToasts } from '../components/toast';
import {
  clampReelDuration,
  correctionAllowed,
  MAX_REEL_DURATION_SEC,
  MIN_REEL_DURATION_SEC,
  REEL_DURATION_PRESETS,
} from '../lib/types';
import type { NRect, ReelPurpose, ReelRecord, TemplateId } from '../lib/types';
import type { Timeline } from '../lib/engine/types';

function StripThumb({
  photoId,
  index,
  count,
  crop,
  onMove,
  onRemove,
  onCrop,
}: {
  photoId: string;
  index: number;
  count: number;
  /** User-set framing, shown here so the strip matches the reel. */
  crop?: NRect;
  onMove: (from: number, to: number) => void;
  onRemove: () => void;
  onCrop: () => void;
}) {
  const url = useBlobUrl(blobKey.thumb(photoId));
  // With a custom crop, scale the thumbnail so the chosen region fills it.
  const cropStyle: React.CSSProperties = crop
    ? {
        position: 'absolute',
        width: `${100 / crop.w}%`,
        height: `${100 / crop.h}%`,
        left: `${(-crop.x / crop.w) * 100}%`,
        top: `${(-crop.y / crop.h) * 100}%`,
        objectFit: 'cover',
      }
    : { width: '100%', height: '100%', objectFit: 'cover' };
  return (
    <div
      draggable
      onDragStart={(e) => e.dataTransfer.setData('text/plain', String(index))}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        // The strip can be rebuilt mid-drag (a photo removed, a new take
        // made), so only accept a position that still exists.
        const valid = Number.isInteger(from) && from >= 0 && from < count;
        if (valid && from !== index) onMove(from, index);
      }}
      style={{
        position: 'relative',
        width: 72,
        flexShrink: 0,
        borderRadius: 8,
        overflow: 'hidden',
        aspectRatio: '9 / 16',
        background: 'var(--paper-sunken)',
        cursor: 'grab',
      }}
    >
      {url && <img src={url} alt="" style={cropStyle} />}
      <button
        aria-label="Fix crop"
        title="Fix crop"
        onClick={(e) => {
          e.stopPropagation();
          onCrop();
        }}
        style={{
          position: 'absolute',
          top: 4,
          left: 4,
          width: 22,
          height: 22,
          borderRadius: 6,
          background: crop ? 'var(--accent)' : 'rgba(13,12,10,0.6)',
          color: '#fff',
          fontSize: 12,
          display: 'grid',
          placeItems: 'center',
          lineHeight: 1,
        }}
      >
        ⛶
      </button>
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'space-between',
          background: 'linear-gradient(transparent, rgba(0,0,0,0.55))',
          padding: '10px 2px 2px',
        }}
      >
        <button
          aria-label="Move earlier"
          style={{ color: '#fff', padding: '2px 6px', fontSize: 14 }}
          disabled={index === 0}
          onClick={() => onMove(index, index - 1)}
        >
          ‹
        </button>
        <button
          aria-label="Remove"
          style={{ color: '#fff', padding: '2px 4px', fontSize: 12 }}
          onClick={onRemove}
        >
          ✕
        </button>
        <button
          aria-label="Move later"
          style={{ color: '#fff', padding: '2px 6px', fontSize: 14 }}
          disabled={index === count - 1}
          onClick={() => onMove(index, index + 1)}
        >
          ›
        </button>
      </div>
    </div>
  );
}

/** A photo she asked for that couldn't fit this length — shown, but greyed. */
function OmittedThumb({ photoId }: { photoId: string }) {
  const url = useBlobUrl(blobKey.thumb(photoId));
  return (
    <div
      title="Doesn’t fit at this length"
      style={{
        position: 'relative',
        width: 72,
        flexShrink: 0,
        borderRadius: 8,
        overflow: 'hidden',
        aspectRatio: '9 / 16',
        background: 'var(--paper-sunken)',
        opacity: 0.4,
        filter: 'grayscale(1)',
      }}
    >
      {url && <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
    </div>
  );
}

export function EditorScreen() {
  const { reelId } = useParams<{ reelId: string }>();
  const navigate = useNavigate();
  const show = useToasts((s) => s.show);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<ReelPlayer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ended, setEnded] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const [igModalOpen, setIgModalOpen] = useState(false);
  const [styleChooserOpen, setStyleChooserOpen] = useState(false);
  const [cropPhotoId, setCropPhotoId] = useState<string | null>(null);
  const [durationInput, setDurationInput] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const musicInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // The live query answers `undefined` both while it's still looking and when
  // the reel is gone, so wrap the result to tell those two apart.
  const reelQuery = useLiveQuery(
    async () => ({ reel: reelId ? await db.reels.get(reelId) : undefined }),
    [reelId],
  );
  const reel = reelQuery?.reel;
  // Keep the custom-length field in sync with the reel unless it's being typed in.
  useEffect(() => {
    if (reel) setDurationInput(String(reel.durationSec));
  }, [reel?.durationSec]);
  // Same for the name: mirror the saved name back, but never mid-typing —
  // that's what made the caret jump and swallowed letters.
  useEffect(() => {
    if (reel && document.activeElement !== nameInputRef.current) setNameInput(reel.name);
  }, [reel?.name]);
  const photos = useLiveQuery(
    () => (reelId ? db.photos.where('reelId').equals(reelId).toArray() : []),
    [reelId],
  );
  const music = useLiveQuery(() => db.music.orderBy('addedAt').reverse().toArray(), []);
  // Is the preview showing the current settings, or still catching up?
  const rebuilding = useRebuildStatus((s) => s.pending > 0);

  const activeVersion = reel?.versions.find((v) => v.id === reel.activeVersionId) ?? null;
  const timeline = activeVersion?.timeline ?? null;

  // Photo order as the timeline plays it (stacked pairs flattened in order).
  const stripPhotoIds = useMemo(() => {
    if (!timeline) return [];
    const ids: string[] = [];
    for (const clip of timeline.clips) {
      for (const layer of clip.layers) {
        if (!ids.includes(layer.photoId)) ids.push(layer.photoId);
      }
    }
    return ids;
  }, [timeline]);

  /**
   * What the preview is actually made of. Building the player decodes every
   * photo, and the reel row is rewritten on any edit (even a name keystroke),
   * so rebuilding on the timeline object's identity re-decoded the whole reel
   * for nothing. A Timeline is plain data, so its JSON describes the frames
   * completely — order, crops, motion, words, music, length — and the photo
   * part covers the only photo facts that change which file gets decoded.
   */
  const previewKey = useMemo(() => {
    if (!timeline || !photos) return null;
    const needed = new Set<string>();
    for (const clip of timeline.clips) {
      for (const layer of clip.layers) needed.add(layer.photoId);
    }
    const photoSignature = photos
      .filter((p) => needed.has(p.id))
      .map(
        (p) =>
          `${p.id}:${p.correctionEnabled ? 1 : 0}${p.hasCorrected ? 1 : 0}${correctionAllowed(p) ? 1 : 0}`,
      )
      .sort()
      .join(',');
    return `${JSON.stringify(timeline)}|${photoSignature}`;
  }, [timeline, photos]);

  // (Re)create the player whenever what's on screen actually changes.
  useEffect(() => {
    let disposed = false;
    let localPlayer: ReelPlayer | null = null;
    let localRes: LoadedResources | null = null;
    const canvas = canvasRef.current;
    if (!canvas || !timeline || !photos) return;
    setPreviewError(null);
    void (async () => {
      try {
        const brand = await getBrand();
        const res = await loadResources(timeline as Timeline, photos, brand);
        if (disposed) {
          res.dispose();
          return;
        }
        localRes = res;
        localPlayer = new ReelPlayer(canvas, timeline as Timeline, res);
        await localPlayer.loadAudio();
        if (disposed) {
          localPlayer.destroy();
          return;
        }
        localPlayer.onTime = (t) => setElapsedMs(t);
        localPlayer.onEnded = () => {
          setPlaying(false);
          setEnded(true);
        };
        playerRef.current = localPlayer;
        setPlaying(false);
        setEnded(false);
        setElapsedMs(0);
      } catch (err) {
        // One unreadable photo used to leave a black frame and no explanation.
        if (disposed) return;
        setPreviewError('One of these photos wouldn’t open, so the preview stopped here.');
        show(
          'The preview stopped — one of these photos wouldn’t open. Your reel is safe; take that photo out under Photos, or make another edit.',
          'error',
          err instanceof Error ? err.message : String(err),
        );
      }
    })();
    return () => {
      disposed = true;
      localPlayer?.destroy();
      localRes?.dispose();
      if (playerRef.current === localPlayer) playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  if (!reelQuery || !photos) {
    return (
      <div className="empty-state panel">
        <span className="spinner" style={{ display: 'inline-block' }} />
        <p style={{ marginTop: 12 }}>Opening your reel…</p>
      </div>
    );
  }
  if (!reel) {
    return (
      <div className="empty-state panel">
        <h2>This reel isn’t here anymore</h2>
        <p style={{ marginTop: 8 }}>
          It was deleted, or the link points somewhere that no longer exists. Your other
          reels are untouched.
        </p>
        <Link to="/" className="btn btn-primary" style={{ marginTop: 14 }}>
          Back to my reels
        </Link>
      </div>
    );
  }
  if (!activeVersion) {
    return (
      <div className="empty-state panel">
        <h2>This reel doesn’t have an arrangement yet</h2>
        <Link to={`/reel/${reel.id}/template`} className="btn btn-primary" style={{ marginTop: 14 }}>
          Choose a style
        </Link>
      </div>
    );
  }

  const patchAndRebuild = async (patch: Partial<ReelRecord>) => {
    await touchReel(reel.id, patch);
    await rebuildActiveVersion(reel.id);
  };

  /**
   * Restyle the version she is looking at. The new style has to be passed
   * explicitly: a rebuild otherwise keeps the version's own template, which
   * is what stops an edit from silently retemplating an older take.
   */
  const changeStyle = async (templateId: TemplateId) => {
    await touchReel(reel.id, { templateId });
    await rebuildActiveVersion(reel.id, templateId);
  };

  const movePhoto = (from: number, to: number) => {
    const order = [...stripPhotoIds];
    // Guard against a strip that changed under the drag — an out-of-range
    // index would splice in an empty slot and save a broken order.
    if (from < 0 || from >= order.length || to < 0 || to >= order.length || from === to) return;
    const [moved] = order.splice(from, 1);
    order.splice(to, 0, moved);
    // manualOrder means "these photos, in this order" — it's the whole reel,
    // not a hint. So it must be exactly what the strip shows: reordering must
    // never quietly pull other photos into the reel.
    void patchAndRebuild({ manualOrder: order });
  };

  const tryAnotherEdit = async (templateId: TemplateId) => {
    setStyleChooserOpen(false);
    setBusy(true);
    try {
      // Lock-aware: photos the user added stay in; a manual order stays in
      // order (only pacing/treatment vary); otherwise the engine rethinks
      // the sequence with a fresh seed. Earlier versions are never lost.
      await generateVersion(reel.id, templateId, Date.now() % 100_000);
      show(
        reel.manualOrder
          ? 'New take created — your photo order is kept; pacing and motion vary.'
          : (reel.requiredIds?.length ?? 0) > 0
            ? 'New arrangement created — your added photos are all still in.'
            : 'New arrangement created — your earlier versions are saved.',
      );
    } catch (err) {
      show(
        'That new take didn’t come together. Nothing changed — your reel is exactly as it was. Try again in a moment.',
        'error',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.playing) {
      p.pause();
      setPlaying(false);
    } else {
      // Replaying from the end restarts at the top.
      if (p.ended) setElapsedMs(0);
      p.play();
      setPlaying(true);
      setEnded(false);
    }
  };

  const applyCustomDuration = () => {
    // An empty or unreadable box means "I didn't pick a length" — not 5s.
    // Clearing the field used to silently reset the whole reel.
    const typed = durationInput.trim();
    const parsed = Number(typed);
    if (typed === '' || !Number.isFinite(parsed)) {
      setDurationInput(String(reel.durationSec));
      return;
    }
    const clamped = clampReelDuration(parsed);
    setDurationInput(String(clamped));
    if (clamped !== reel.durationSec) void patchAndRebuild({ durationSec: clamped });
  };

  const includedCount = photos.filter((p) => p.included).length;

  const template = reel.templateId ? getTemplate(reel.templateId) : null;
  const pacing = template
    ? pacingFor(template, reel.durationSec * 1000, stripPhotoIds.length)
    : null;

  // How long the reel would want to be at this style's own pace. With a manual
  // order the reel is exactly the photos in the strip; otherwise the engine
  // chooses from everything included, so that's the set to plan a length for.
  const lengthPlanCount = reel.manualOrder ? stripPhotoIds.length : includedCount;
  const naturalSec = template ? estimateDurationSec(template, lengthPlanCount) : null;

  // Photos she guaranteed — added by hand, or placed in her own order — that
  // physically could not fit this length at this style's fastest. The engine
  // reports them instead of dropping them quietly, so the editor must say so.
  const omittedIds = (timeline?.omittedPhotoIds ?? []).filter((id) =>
    photos.some((p) => p.id === id),
  );
  const wantedCount = stripPhotoIds.length + omittedIds.length;
  const fitsSec =
    template && omittedIds.length > 0 ? lengthThatFitsSec(template, wantedCount) : null;
  const fasterStyle =
    omittedIds.length > 0
      ? styleThatFits(wantedCount, reel.durationSec * 1000, reel.templateId ?? undefined)
      : null;

  const previewStatus = rebuilding
    ? 'Updating preview…'
    : `${activeVersion.label} · up to date`;

  return (
    <div>
      <div className="page-header">
        <input
          ref={nameInputRef}
          value={nameInput}
          aria-label="Reel name"
          // Type freely here; the name is saved when you leave the box or
          // press Enter. Saving every keystroke went through the database and
          // came back out of order.
          onChange={(e) => setNameInput(e.target.value)}
          onBlur={() => {
            const next = nameInput.trim();
            if (!next) {
              setNameInput(reel.name);
              return;
            }
            if (next !== reel.name) void touchReel(reel.id, { name: next });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setNameInput(reel.name);
              e.currentTarget.blur();
            }
          }}
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 24,
            fontWeight: 500,
            border: 'none',
            background: 'transparent',
            width: 'min(60vw, 380px)',
          }}
        />
        <div className="spacer" />
        <div style={{ textAlign: 'right', marginRight: 4 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 19, lineHeight: 1.2 }}>
            {stripPhotoIds.length} photos · {reel.durationSec}.0s
          </div>
          <div className="faint">
            {pacing ? `~${(pacing.perPhotoMs / 1000).toFixed(1)}s each` : ''}
            {template ? ` · ${template.name}` : ''}
          </div>
        </div>
        <Link to={`/reel/${reel.id}/review`} className="btn btn-ghost">
          Photos
        </Link>
        <button className="btn btn-primary btn-lg" onClick={() => navigate(`/reel/${reel.id}/export`)}>
          Export
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 340px) minmax(0, 1fr)',
          gap: 28,
          alignItems: 'start',
        }}
        className="editor-grid"
      >
        <style>{`
          @media (max-width: 759px) {
            .editor-grid { grid-template-columns: 1fr !important; }
            .editor-grid .reel-frame { max-width: 300px; margin: 0 auto; }
          }
        `}</style>

        {/* Preview */}
        <div>
          <div className="reel-frame">
            <canvas ref={canvasRef} />
            {previewError ? (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                  alignContent: 'center',
                  gap: 10,
                  padding: 22,
                  textAlign: 'center',
                  background: 'rgba(13,12,10,0.82)',
                  color: '#fff',
                }}
              >
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 21 }}>
                  Preview stopped
                </div>
                <div style={{ fontSize: 13, opacity: 0.85 }}>
                  {previewError} Your reel is safe — take that photo out, or make another
                  edit.
                </div>
                <Link to={`/reel/${reel.id}/review`} className="btn btn-secondary btn-sm">
                  Check the photos
                </Link>
              </div>
            ) : ended ? (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                  alignContent: 'center',
                  gap: 10,
                  background: 'rgba(13,12,10,0.72)',
                  color: '#fff',
                }}
              >
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 21 }}>
                  End of reel
                </div>
                <div style={{ fontSize: 13, opacity: 0.85 }}>
                  {stripPhotoIds.length} photos · {reel.durationSec}.0s
                </div>
                {/* A real button: reachable by keyboard and announced. */}
                <button className="btn btn-secondary btn-sm" onClick={togglePlay}>
                  ↺ Replay
                </button>
              </div>
            ) : (
              // Covers the frame, so tapping the reel still plays and pauses it.
              <button
                onClick={togglePlay}
                aria-label={playing ? 'Pause preview' : 'Play preview'}
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: '100%',
                  height: '100%',
                  display: 'grid',
                  placeItems: 'center',
                  background: playing ? 'transparent' : 'rgba(0,0,0,0.18)',
                  color: '#fff',
                  fontSize: 48,
                }}
              >
                {playing ? '' : '▶'}
              </button>
            )}
          </div>

          {/* Playhead: always know where you are and when it's over. */}
          <div className="progressbar" style={{ marginTop: 8 }}>
            <div
              style={{
                width: `${Math.min(100, (elapsedMs / (reel.durationSec * 1000)) * 100)}%`,
                transition: playing ? 'none' : 'width 0.2s ease',
              }}
            />
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <span className="faint">
              {(Math.min(elapsedMs, reel.durationSec * 1000) / 1000).toFixed(1)}s /{' '}
              {reel.durationSec}.0s
            </span>
            <div className="spacer" />
            <span className="faint">{previewStatus}</span>
          </div>

          {/* Versions */}
          <div className="row wrap" style={{ marginTop: 14 }}>
            {reel.versions.map((v) => (
              <button
                key={v.id}
                className={`btn btn-sm ${v.id === reel.activeVersionId ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() =>
                  // Point the style picker at the style this take was actually
                  // built in, so the controls describe what's on screen.
                  void touchReel(reel.id, {
                    activeVersionId: v.id,
                    templateId: v.timeline.templateId,
                  })
                }
              >
                {v.label}
              </button>
            ))}
            <button
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => setStyleChooserOpen(true)}
            >
              {busy ? <span className="spinner" /> : '↻'} Try Another Edit
            </button>
          </div>
        </div>

        {/* Controls */}
        <div className="stack-v">
          {omittedIds.length > 0 && template && (
            <div
              className="panel"
              style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn)', padding: 14 }}
            >
              <strong style={{ fontSize: 14.5 }}>
                {omittedIds.length === 1
                  ? 'One of your photos didn’t fit'
                  : `${omittedIds.length} of your photos didn’t fit`}{' '}
                — {reel.durationSec} seconds holds {stripPhotoIds.length} at{' '}
                {template.name}’s fastest.
              </strong>
              <p className="muted" style={{ fontSize: 13.5, margin: '6px 0 10px' }}>
                {fitsSec === null && !fasterStyle
                  ? 'They’re still in your set — nothing is lost. This many photos won’t all fit in one reel, so a second reel is the honest answer.'
                  : 'They’re still in your set — nothing is lost. Give the reel more room, or pick a style that moves faster.'}
              </p>
              <div className="row wrap">
                {fitsSec !== null && fitsSec !== reel.durationSec && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void patchAndRebuild({ durationSec: fitsSec })}
                  >
                    Make it {fitsSec}s
                  </button>
                )}
                {fasterStyle && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      void changeStyle(fasterStyle.id);
                    }}
                  >
                    Switch to {fasterStyle.name}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* One warning at a time: when photos are being left out, that panel
              already offers the longer reel and the faster style. */}
          {pacing?.rushed && template && omittedIds.length === 0 && (
            <div
              className="panel"
              style={{ background: 'var(--warn-soft)', borderColor: 'var(--warn)', padding: 14 }}
            >
              <strong style={{ fontSize: 14.5 }}>
                {stripPhotoIds.length} photos in {reel.durationSec}s is ~
                {(pacing.perPhotoMs / 1000).toFixed(1)}s each — faster than{' '}
                {template.name}’s {template.pace}.
              </strong>
              <p className="muted" style={{ fontSize: 13.5, margin: '6px 0 10px' }}>
                These are photos you added, so they all stay in. Give them room, or
                pick a style built for this pace.
              </p>
              <div className="row wrap">
                {pacing.neededSec && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void patchAndRebuild({ durationSec: pacing.neededSec! })}
                  >
                    Use {pacing.neededSec}s
                  </button>
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    void changeStyle('quick-cut');
                  }}
                >
                  Switch to Quick Cut
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    void changeStyle('rapid-fire');
                  }}
                >
                  Switch to Rapid Fire
                </button>
              </div>
            </div>
          )}

          {/* Photo strip */}
          <div className="panel">
            <h3 style={{ marginBottom: 10 }}>Photo order</h3>
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 }}>
              {stripPhotoIds.map((id, i) => (
                <StripThumb
                  key={id}
                  photoId={id}
                  index={i}
                  count={stripPhotoIds.length}
                  crop={photos.find((p) => p.id === id)?.customCrop}
                  onCrop={() => setCropPhotoId(id)}
                  onMove={movePhoto}
                  onRemove={() => {
                    void removePhotosFromArrangement(reel.id, [id]);
                  }}
                />
              ))}
              {omittedIds.map((id) => (
                <OmittedThumb key={id} photoId={id} />
              ))}
              <Link
                to={`/reel/${reel.id}/review`}
                style={{
                  width: 72,
                  flexShrink: 0,
                  aspectRatio: '9 / 16',
                  borderRadius: 8,
                  border: '2px dashed var(--line-strong)',
                  display: 'grid',
                  placeItems: 'center',
                  color: 'var(--ink-faint)',
                  fontSize: 24,
                }}
              >
                +
              </Link>
            </div>
            <p className="faint" style={{ marginTop: 6 }}>
              Drag (or use ‹ ›) to reorder. Tap ⛶ on any photo to fix its framing.
              {omittedIds.length > 0 &&
                ' The greyed photos at the end don’t fit at this length yet.'}
            </p>
          </div>

          {/* Text */}
          <div className="panel">
            <h3 style={{ marginBottom: 12 }}>Words</h3>
            <div className="field">
              <label>Title (optional)</label>
              <input
                type="text"
                placeholder="The Andersons · Coronado Beach"
                defaultValue={reel.text.title}
                onBlur={(e) => void patchAndRebuild({ text: { ...reel.text, title: e.target.value } })}
              />
            </div>
            <div className="field">
              <label>Caption (optional)</label>
              <input
                type="text"
                placeholder="golden hour, big laughs"
                defaultValue={reel.text.caption}
                onBlur={(e) => void patchAndRebuild({ text: { ...reel.text, caption: e.target.value } })}
              />
            </div>
          </div>

          {/* Proof mode — opt in, per reel */}
          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ marginBottom: 4 }}>Proof mode</h3>
                <p className="faint" style={{ margin: 0, maxWidth: 340 }}>
                  {reel.proofOverlap
                    ? 'Photos always overlap, so no frame of this reel is a clean copy of one photo.'
                    : 'Off — anyone can pause and screenshot a photo cleanly.'}
                </p>
              </div>
              <label className="row" style={{ gap: 6, fontSize: 14, flexShrink: 0 }}>
                <input
                  type="checkbox"
                  checked={reel.proofOverlap === true}
                  onChange={(e) => void patchAndRebuild({ proofOverlap: e.target.checked })}
                />
                {reel.proofOverlap ? 'On' : 'Protect'}
              </label>
            </div>
            {reel.proofOverlap && (
              <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
                Each photo keeps the one beside it mixed in, so a screenshot comes out doubled.
                Good for portraits families are meant to buy. It discourages grabbing — it can’t
                stop a screen recording, and your original files are untouched.
              </p>
            )}
          </div>

          {/* Branding — opt in, per reel */}
          <div className="panel">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ marginBottom: 4 }}>Your branding</h3>
                <p className="faint" style={{ margin: 0, maxWidth: 340 }}>
                  {reel.branding
                    ? 'This reel ends with your sign-off.'
                    : 'Off — this reel is just the photographs. Turn it on to end with your sign-off.'}
                </p>
              </div>
              <label className="row" style={{ gap: 6, fontSize: 14, flexShrink: 0 }}>
                <input
                  type="checkbox"
                  checked={reel.branding === true}
                  onChange={(e) => void patchAndRebuild({ branding: e.target.checked })}
                />
                {reel.branding ? 'On' : 'Add it'}
              </label>
            </div>

            {reel.branding && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
                <div className="field">
                  <label>Call to action</label>
                  <input
                    type="text"
                    placeholder="Leave empty for no call to action"
                    defaultValue={reel.text.cta}
                    onBlur={(e) => void patchAndRebuild({ text: { ...reel.text, cta: e.target.value } })}
                  />
                </div>
                <label className="row" style={{ gap: 6, fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={reel.text.showHandle}
                    onChange={(e) =>
                      void patchAndRebuild({ text: { ...reel.text, showHandle: e.target.checked } })
                    }
                  />
                  Show website / Instagram handle
                </label>
                <label className="row" style={{ gap: 6, fontSize: 14, marginTop: 6 }}>
                  <input
                    type="checkbox"
                    checked={reel.text.showLogo !== false}
                    onChange={(e) =>
                      void patchAndRebuild({ text: { ...reel.text, showLogo: e.target.checked } })
                    }
                  />
                  Show your logo
                </label>
                <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
                  Comes from your <Link to="/brand">brand kit</Link>. Your fonts are used either
                  way — only the sign-off is optional.
                </p>
              </div>
            )}
          </div>

          {/* Style, duration, music */}
          <div className="panel">
            <h3 style={{ marginBottom: 12 }}>Style & pacing</h3>
            <div className="field">
              <label>Style</label>
              <select
                value={reel.templateId ?? ''}
                onChange={(e) => {
                  void changeStyle(e.target.value as TemplateId);
                }}
              >
                {TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Purpose</label>
              <select
                value={reel.purpose ?? 'auto'}
                onChange={(e) => void patchAndRebuild({ purpose: e.target.value as ReelPurpose })}
              >
                <option value="auto">Surprise me — read the set</option>
                <option value="photography">Photography — selective showcase</option>
                <option value="school">School / Community — many faces, real moments</option>
              </select>
              <span className="hint">
                Purpose sets what matters (selection & breadth); style sets how it feels.
              </span>
            </div>
            <div className="field">
              <label>Length</label>
              <div className="row wrap">
                {REEL_DURATION_PRESETS.map((d) => (
                  <button
                    key={d}
                    className={`btn btn-sm ${reel.durationSec === d ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => void patchAndRebuild({ durationSec: d })}
                  >
                    {d}s
                  </button>
                ))}
                <span className="row" style={{ gap: 6 }}>
                  <input
                    type="number"
                    min={MIN_REEL_DURATION_SEC}
                    max={MAX_REEL_DURATION_SEC}
                    value={durationInput}
                    onChange={(e) => setDurationInput(e.target.value)}
                    onBlur={() => applyCustomDuration()}
                    onKeyDown={(e) => e.key === 'Enter' && applyCustomDuration()}
                    style={{
                      width: 64,
                      background: 'var(--paper-raised)',
                      border: '1px solid var(--line-strong)',
                      borderRadius: 8,
                      padding: '7px 8px',
                      textAlign: 'center',
                    }}
                    aria-label="Custom length in seconds"
                  />
                  <span className="faint">s (custom)</span>
                </span>
              </div>
              {lengthPlanCount > 0 && template && (
                <span className="hint">
                  {(() => {
                    const photoWord = lengthPlanCount === 1 ? 'photo' : 'photos';
                    const these = reel.manualOrder
                      ? `your ${lengthPlanCount} ${photoWord}`
                      : `all ${lengthPlanCount} ${photoWord} you’ve included`;
                    if (naturalSec === null) {
                      return `Even at ${MAX_REEL_DURATION_SEC}s, ${template.name} can’t hold ${these} at its own pace — Rapid Fire is built for a set this big.`;
                    }
                    if (naturalSec === reel.durationSec) {
                      return `At ${reel.durationSec}s, ${template.name} has room for ${these} at its own pace.`;
                    }
                    return `Showing ${these} at ${template.name}’s own pace takes about ${naturalSec}s.`;
                  })()}
                  {naturalSec !== null && naturalSec !== reel.durationSec && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ marginLeft: 6, padding: '2px 8px', minHeight: 'auto' }}
                      onClick={() => void patchAndRebuild({ durationSec: naturalSec })}
                    >
                      Use {naturalSec}s
                    </button>
                  )}
                </span>
              )}
              {pacing && template && (
                <span className="hint">
                  {(() => {
                    const included = photos.filter((p) => p.included).length;
                    const showing = pacing.photoCount;
                    const comfy = pacing.comfortableCapacity;
                    if (reel.manualOrder) {
                      const cut = Math.max(0, Math.min(reel.manualOrder.length, included) - showing);
                      return (
                        `Showing ${showing} photos in your order at ~${(pacing.perPhotoMs / 1000).toFixed(1)}s each. ` +
                        `${template.name} sits best with ${comfy} at ${reel.durationSec}s.` +
                        (cut > 0
                          ? ` ${cut} more don’t fit at all; pick a longer length or Rapid Fire.`
                          : '')
                      );
                    }
                    return (
                      `Showing ${showing} of ${included} included photos at this style’s pace ` +
                      `(~${(pacing.perPhotoMs / 1000).toFixed(1)}s each; ${comfy} fit comfortably at ${reel.durationSec}s). ` +
                      `A tight edit is deliberate — use “Add to reel” on any photo that must appear.`
                    );
                  })()}
                </span>
              )}
            </div>
            <div className="field">
              <label>Music</label>
              {reel.instagramAudio ? (
                <div
                  className="panel"
                  style={{ padding: 12, background: 'var(--paper-sunken)' }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14.5 }}>
                    🎵 {reel.instagramAudio.songTitle}
                    {reel.instagramAudio.artist ? ` — ${reel.instagramAudio.artist}` : ''}
                  </div>
                  <div className="faint" style={{ margin: '2px 0 8px' }}>
                    Instagram Audio Reference · starts at{' '}
                    {formatTimestamp(reel.instagramAudio.startSec)} · export stays silent —
                    add the official song when you post
                  </div>
                  <div className="row">
                    <button className="btn btn-secondary btn-sm" onClick={() => setIgModalOpen(true)}>
                      Edit section
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => void clearInstagramAudio(reel.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <select
                    value={reel.musicAssetKey ?? ''}
                    onChange={(e) => {
                      const track = music?.find((m) => m.assetKey === e.target.value);
                      void patchAndRebuild({
                        musicAssetKey: track?.assetKey ?? null,
                        musicName: track?.name ?? null,
                        instagramAudio: null,
                      });
                    }}
                  >
                    <option value="">No music</option>
                    {music?.map((m) => (
                      <option key={m.id} value={m.assetKey}>
                        {m.name} ({Math.round(m.durationSec)}s)
                      </option>
                    ))}
                  </select>
                  <div className="row wrap">
                    <button className="btn btn-secondary btn-sm" onClick={() => musicInputRef.current?.click()}>
                      Upload a track
                    </button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setIgModalOpen(true)}>
                      Edit to Instagram Audio
                    </button>
                  </div>
                  <span className="hint">
                    Upload music you’re licensed to include, or build your reel to an
                    Instagram song and add the official audio when you post.
                  </span>
                </>
              )}
              <input
                ref={musicInputRef}
                type="file"
                accept="audio/*"
                hidden
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  await addMusicTrack(file);
                  const added = await db.music.orderBy('addedAt').reverse().first();
                  if (added) {
                    await patchAndRebuild({
                      musicAssetKey: added.assetKey,
                      musicName: added.name,
                      instagramAudio: null,
                    });
                  }
                  show('Track added');
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {cropPhotoId && (
        <CropModal
          photoId={cropPhotoId}
          reelId={reel.id}
          onClose={() => setCropPhotoId(null)}
        />
      )}

      {igModalOpen && <InstagramAudioModal reel={reel} onClose={() => setIgModalOpen(false)} />}

      {styleChooserOpen && (
        <Modal onClose={() => setStyleChooserOpen(false)}>
          <h2 style={{ marginBottom: 6 }}>Try another edit</h2>
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 16 }}>
            {reel.manualOrder
              ? 'Your photos and order are kept — pacing, motion and treatments will vary.'
              : (reel.requiredIds?.length ?? 0) > 0
                ? 'Photos you added stay in; the sequence gets rethought.'
                : 'The whole edit gets rethought — earlier versions are always saved.'}
          </p>
          <div className="stack-v" style={{ gap: 8 }}>
            {reel.templateId && (
              <button
                className="btn btn-primary"
                onClick={() => void tryAnotherEdit(reel.templateId!)}
              >
                Same style — {getTemplate(reel.templateId).name}
              </button>
            )}
            {TEMPLATES.filter((t) => t.id !== reel.templateId).map((t) => (
              <button
                key={t.id}
                className="btn btn-secondary"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => {
                  void touchReel(reel.id, { templateId: t.id }).then(() => tryAnotherEdit(t.id));
                }}
              >
                {t.name}
                <span className="faint" style={{ marginLeft: 8, fontWeight: 400 }}>
                  {t.pace}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
