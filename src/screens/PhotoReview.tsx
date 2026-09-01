import { useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { blobKey, db, auditLog, deletePhotoCompletely, getBlob, putBlob } from '../lib/db';
import { effectiveClassification, correctionAllowed, type NRect, type PhotoRecord } from '../lib/types';
import { isNearDuplicate } from '../lib/imaging/similarity';
import { renderCorrected } from '../lib/imaging/correction';
import { canvasToBlob } from '../lib/imaging/decode';
import { matchConfidenceLabel } from '../lib/restricted/matching';
import { ingestFiles } from '../lib/analysis/ingest';
import { chooseFromDropbox, dropboxConfigured } from '../lib/dropbox';
import { enrichWithAi } from '../lib/analysis/aiVision';
import { addPhotosToArrangement, rebuildActiveVersion, removePhotosFromArrangement } from '../lib/reels';
import { getTemplate, templateCapacity } from '../lib/engine/templates';
import { useBlobUrl, invalidateBlobUrl } from '../components/hooks';
import { Modal } from '../components/Modal';
import { CropEditor } from '../components/CropEditor';
import { useAdminAction } from '../components/AdminGate';
import { useToasts } from '../components/toast';

function Badges({ photo, reelIndex }: { photo: PhotoRecord; reelIndex?: number }) {
  const cls = effectiveClassification(photo);
  const flagged = photo.restrictedFlags.some((f) => f.status === 'pending' || f.status === 'blocked');
  return (
    <div className="badges">
      {flagged && <span className="badge badge-restricted">Restricted?</span>}
      {reelIndex !== undefined && (
        <span className="badge badge-recommended">In reel · {reelIndex + 1}</span>
      )}
      {cls === 'pro' && <span className="badge badge-pro">Pro</span>}
      {cls === 'mobile' && <span className="badge badge-mobile">Mobile</span>}
      {photo.correctionEnabled && photo.hasCorrected && (
        <span className="badge badge-corrected">Corrected</span>
      )}
      {photo.customCrop && <span className="badge">Cropped</span>}
    </div>
  );
}

function PhotoCell({
  photo,
  reelIndex,
  duplicate,
  onOpen,
}: {
  photo: PhotoRecord;
  reelIndex?: number;
  duplicate: boolean;
  onOpen: () => void;
}) {
  const thumbUrl = useBlobUrl(photo.status !== 'ingesting' ? blobKey.thumb(photo.id) : null);
  const flagged = photo.restrictedFlags.some((f) => f.status === 'pending' || f.status === 'blocked');
  return (
    <div
      className={`photo-cell ${photo.included ? '' : 'excluded'} ${flagged ? 'flagged' : ''}`}
      onClick={onOpen}
    >
      {thumbUrl ? (
        <img src={thumbUrl} alt={photo.fileName} loading="lazy" />
      ) : (
        <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
          <div className="spinner" />
        </div>
      )}
      {photo.status === 'ready' && (
        <>
          <Badges photo={photo} reelIndex={reelIndex} />
          {duplicate && (
            <span className="badge badge-duplicate" style={{ position: 'absolute', top: 6, right: 6 }}>
              Duplicate
            </span>
          )}
        </>
      )}
      {photo.status === 'error' && (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 12, color: 'var(--danger)', padding: 8, textAlign: 'center' }}>
          Couldn’t read this photo
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DetailModal({
  photo,
  reelPosition,
  onAddToReel,
  onRemoveFromReel,
  onClose,
  onChanged,
}: {
  photo: PhotoRecord;
  /** Position in the current arrangement, if the photo is in it. */
  reelPosition?: number;
  onAddToReel: () => void;
  onRemoveFromReel: () => void;
  onClose: () => void;
  /** Called after any change that affects the reel arrangement. */
  onChanged: () => void;
}) {
  const show = useToasts((s) => s.show);
  const { requireAdmin, GateModal } = useAdminAction();
  const previewUrl = useBlobUrl(blobKey.preview(photo.id));
  const correctedUrl = useBlobUrl(photo.hasCorrected ? blobKey.corrected(photo.id) : null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [cropping, setCropping] = useState(false);

  const cls = effectiveClassification(photo);
  const showingCorrected =
    photo.correctionEnabled && photo.hasCorrected && correctedUrl && !showOriginal;
  const pendingFlags = photo.restrictedFlags.filter(
    (f) => f.status === 'pending' || f.status === 'blocked',
  );

  const setOverride = async (value: 'pro' | 'mobile' | undefined) => {
    const patch: Partial<PhotoRecord> = { overrideClassification: value };
    if (value === 'pro') patch.correctionEnabled = false;
    await db.photos.update(photo.id, patch);
    if (value === 'mobile' && !photo.hasCorrected && photo.analysis) {
      await renderCorrectionFor(photo);
    }
    onChanged();
  };

  const renderCorrectionFor = async (p: PhotoRecord) => {
    const blob = await getBlob(blobKey.preview(p.id));
    if (!blob || !p.analysis) return;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    const { canvas: corrected, changed } = renderCorrected(canvas, p.analysis.stats);
    bitmap.close();
    if (changed) {
      await putBlob(blobKey.corrected(p.id), await canvasToBlob(corrected, 'image/jpeg', 0.92));
      invalidateBlobUrl(blobKey.corrected(p.id));
      await db.photos.update(p.id, { hasCorrected: true, correctionEnabled: true });
    } else {
      show('This photo already sits well next to professional work — no correction needed.');
    }
  };

  const saveCrop = async (crop: NRect | undefined) => {
    await db.photos.update(photo.id, { customCrop: crop });
    setCropping(false);
    onChanged();
    show(crop ? 'Crop saved — the reel will use this framing.' : 'Custom crop removed.');
  };

  const reviewFlag = async (
    profileId: string,
    status: 'safe' | 'blocked' | 'removed',
  ) => {
    const apply = async () => {
      if (status === 'removed') {
        await auditLog('admin', 'restricted-remove-photo', `photo ${photo.fileName}`);
        await deletePhotoCompletely(photo.id);
        onChanged();
        onClose();
        return;
      }
      const flags = photo.restrictedFlags.map((f) =>
        f.profileId === profileId ? { ...f, status, reviewedAt: Date.now(), reviewedBy: 'admin' } : f,
      );
      await db.photos.update(photo.id, {
        restrictedFlags: flags,
        ...(status === 'blocked' ? { included: false } : {}),
      });
      await auditLog(
        'admin',
        `restricted-mark-${status}`,
        `photo ${photo.fileName}, profile ${profileId}`,
      );
      onChanged();
    };
    if (status === 'safe') {
      requireAdmin(() => void apply());
    } else {
      await apply();
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="row" style={{ marginBottom: 14, alignItems: 'flex-start' }}>
        <div>
          <h2 style={{ fontSize: 19 }}>{photo.fileName}</h2>
          <p className="faint">
            {photo.width} × {photo.height} · {(photo.bytes / 1024 / 1024).toFixed(1)} MB
            {photo.exif.make ? ` · ${photo.exif.make} ${photo.exif.model ?? ''}` : ''}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          Close
        </button>
      </div>

      {pendingFlags.length > 0 && (
        <div
          className="panel"
          style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)', marginBottom: 16 }}
        >
          <h3 style={{ color: 'var(--danger)', marginBottom: 6 }}>
            Possible restricted child detected — review required
          </h3>
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 12 }}>
            Face matching is never certain. Please look carefully before deciding.
          </p>
          {pendingFlags.map((flag) => (
            <div key={flag.profileId} style={{ marginBottom: 12 }}>
              <p style={{ fontWeight: 600, fontSize: 14 }}>
                May match: {flag.profileLabel}{' '}
                <span className="faint">({matchConfidenceLabel(flag.distance)})</span>
              </p>
              <div className="row wrap" style={{ marginTop: 8 }}>
                <button className="btn btn-danger btn-sm" onClick={() => void reviewFlag(flag.profileId, 'removed')}>
                  Remove Photo
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => void reviewFlag(flag.profileId, 'blocked')}>
                  Keep Blocked
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => void reviewFlag(flag.profileId, 'safe')}>
                  Mark as Safe
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {cropping && previewUrl ? (
        <CropEditor
          imageUrl={showingCorrected ? correctedUrl! : previewUrl}
          imageWidth={photo.width}
          imageHeight={photo.height}
          initial={photo.customCrop}
          onSave={(crop) => void saveCrop(crop)}
          onReset={() => void saveCrop(undefined)}
          onClose={() => setCropping(false)}
        />
      ) : (
        <>
          <div style={{ position: 'relative', borderRadius: 12, overflow: 'hidden', background: 'var(--paper-sunken)' }}>
            {previewUrl && (
              <img
                src={showingCorrected ? correctedUrl! : previewUrl}
                alt=""
                style={{ width: '100%', display: 'block', maxHeight: '48vh', objectFit: 'contain' }}
              />
            )}
            {pendingFlags.map((flag, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: `${flag.face.x * 100}%`,
                  top: `${flag.face.y * 100}%`,
                  width: `${flag.face.w * 100}%`,
                  height: `${flag.face.h * 100}%`,
                  border: '2px solid var(--danger)',
                  borderRadius: 4,
                }}
              />
            ))}
          </div>

          <div className="row wrap" style={{ marginTop: 12 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => setCropping(true)}>
              {photo.customCrop ? 'Adjust crop' : 'Crop for reel'}
            </button>
            {photo.hasCorrected && correctionAllowed(photo) && (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onPointerDown={() => setShowOriginal(true)}
                  onPointerUp={() => setShowOriginal(false)}
                  onPointerLeave={() => setShowOriginal(false)}
                >
                  {showOriginal ? 'Original' : 'Hold to compare original'}
                </button>
                <label className="row" style={{ gap: 6, fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={photo.correctionEnabled}
                    onChange={(e) => {
                      void db.photos.update(photo.id, { correctionEnabled: e.target.checked }).then(onChanged);
                    }}
                  />
                  Apply gentle correction
                </label>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => void db.photos.update(photo.id, { correctionEnabled: false }).then(onChanged)}
                >
                  Restore Original
                </button>
              </>
            )}
          </div>
        </>
      )}

      <hr className="divider" />

      <div className="row wrap">
        <span className="faint">
          Detected: {photo.analysis?.classification.label ?? '…'}
          {photo.overrideClassification ? ` · your setting: ${photo.overrideClassification}` : ''}
        </span>
        <div className="spacer" />
        <button
          className={`btn btn-sm ${cls === 'pro' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => void setOverride('pro')}
        >
          Treat as Professional
        </button>
        <button
          className={`btn btn-sm ${cls === 'mobile' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => void setOverride('mobile')}
        >
          Allow Mobile Correction
        </button>
      </div>

      {photo.analysis?.classification.reasons.length ? (
        <p className="faint" style={{ marginTop: 10 }}>
          {photo.analysis.classification.reasons.join(' · ')}
        </p>
      ) : null}

      <div className="row" style={{ marginTop: 16 }}>
        {reelPosition !== undefined ? (
          <>
            <span className="faint">In the reel — position {reelPosition + 1}</span>
            <button className="btn btn-secondary btn-sm" onClick={onRemoveFromReel}>
              Remove from reel
            </button>
          </>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={onAddToReel}>
            Add to reel
          </button>
        )}
        <div className="spacer" />
        <button
          className="btn btn-ghost btn-sm"
          style={{ color: 'var(--danger)' }}
          onClick={() => {
            if (window.confirm('Remove this photo from the reel entirely?')) {
              void deletePhotoCompletely(photo.id).then(() => {
                onChanged();
                onClose();
              });
            }
          }}
        >
          Remove photo
        </button>
      </div>
      <GateModal />
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export function PhotoReviewScreen() {
  const { reelId } = useParams<{ reelId: string }>();
  const navigate = useNavigate();
  const show = useToasts((s) => s.show);
  const addInputRef = useRef<HTMLInputElement>(null);
  const [dropboxBusy, setDropboxBusy] = useState(false);
  const [openPhotoId, setOpenPhotoId] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reel = useLiveQuery(() => (reelId ? db.reels.get(reelId) : undefined), [reelId]);
  const photos = useLiveQuery(
    () => (reelId ? db.photos.where('reelId').equals(reelId).sortBy('order') : []),
    [reelId],
  );

  const ready = useMemo(() => (photos ?? []).filter((p) => p.status === 'ready'), [photos]);
  const analyzing = (photos ?? []).some((p) => p.status === 'ingesting' || p.status === 'analyzing');

  // Which photos appear in the current arrangement, and in what order.
  const inReelIndex = useMemo(() => {
    const map = new Map<string, number>();
    const version = reel?.versions.find((v) => v.id === reel.activeVersionId);
    if (!version) return map;
    for (const clip of version.timeline.clips) {
      for (const layer of clip.layers) {
        if (!map.has(layer.photoId)) map.set(layer.photoId, map.size);
      }
    }
    return map;
  }, [reel]);

  const duplicateIds = useMemo(() => {
    const seen: { id: string; phash: string }[] = [];
    const dupes = new Set<string>();
    for (const p of ready) {
      if (!p.analysis) continue;
      if (seen.some((s) => isNearDuplicate(s.phash, p.analysis!.phash))) {
        dupes.add(p.id);
      } else {
        seen.push({ id: p.id, phash: p.analysis.phash });
      }
    }
    return dupes;
  }, [ready]);

  if (!reel || !photos) return null;

  const flaggedCount = ready.filter((p) =>
    p.restrictedFlags.some((f) => f.status === 'pending'),
  ).length;
  const openPhoto = photos.find((p) => p.id === openPhotoId);
  const inReelCount = inReelIndex.size;

  const template = reel.templateId ? getTemplate(reel.templateId) : null;
  const capacity = template ? templateCapacity(template, reel.durationSec * 1000) : null;

  const refreshArrangement = () => {
    if (reelId) void rebuildActiveVersion(reelId);
  };

  const addToReel = async (ids: string[]) => {
    if (!reelId) return;
    await addPhotosToArrangement(reelId, ids);
    if (capacity !== null && inReelCount + ids.length > capacity) {
      show(
        `This style fits ${capacity} photos at ${reel.durationSec}s — some may not appear until you pick a longer length or a faster style.`,
      );
    }
  };

  const removeFromReel = async (ids: string[]) => {
    if (!reelId) return;
    await removePhotosFromArrangement(reelId, ids);
  };

  const bulk = async (fn: (p: PhotoRecord) => Partial<PhotoRecord>) => {
    for (const id of selected) {
      const p = photos.find((x) => x.id === id);
      if (p) await db.photos.update(id, fn(p));
    }
    setSelected(new Set());
    setSelecting(false);
    refreshArrangement();
  };

  const bulkReel = async (include: boolean) => {
    const ids = [...selected];
    setSelected(new Set());
    setSelecting(false);
    if (include) await addToReel(ids);
    else await removeFromReel(ids);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{reel.name}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {ready.length} photos
            {inReelCount > 0
              ? ` · ${inReelCount} in the current reel${capacity !== null ? ` (fits up to ${capacity} at ${reel.durationSec}s)` : ''}`
              : ''}
            {analyzing ? ' · still looking through a few…' : ''}
            {flaggedCount > 0 ? ` · ${flaggedCount} need review` : ''}
          </p>
        </div>
        <div className="spacer" />
        <button className="btn btn-ghost" onClick={() => setSelecting(!selecting)}>
          {selecting ? 'Done' : 'Select'}
        </button>
        <button className="btn btn-secondary" onClick={() => addInputRef.current?.click()}>
          Add photos
        </button>
        {dropboxConfigured && (
          <button
            className="btn btn-secondary"
            disabled={dropboxBusy}
            onClick={async () => {
              if (!reelId) return;
              setDropboxBusy(true);
              try {
                const files = await chooseFromDropbox();
                if (files.length > 0) {
                  const newIds = await ingestFiles(reelId, files);
                  void enrichWithAi(reelId);
                  if (newIds.length > 0) await addToReel(newIds);
                }
              } catch (err) {
                show(
                  'Dropbox import didn’t work — try again.',
                  'error',
                  err instanceof Error ? err.message : String(err),
                );
              } finally {
                setDropboxBusy(false);
              }
            }}
          >
            {dropboxBusy ? <span className="spinner" /> : null} From Dropbox
          </button>
        )}
        {reel.templateId ? (
          <Link to={`/reel/${reel.id}/edit`} className="btn btn-primary btn-lg">
            Back to editor
          </Link>
        ) : (
          <button
            className="btn btn-primary btn-lg"
            disabled={ready.filter((p) => p.included).length < 3}
            onClick={() => navigate(`/reel/${reel.id}/template`)}
          >
            Choose a style
          </button>
        )}
      </div>

      {flaggedCount > 0 && (
        <div
          className="panel"
          style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)', marginBottom: 20 }}
        >
          <strong style={{ color: 'var(--danger)' }}>
            {flaggedCount} photo{flaggedCount > 1 ? 's' : ''} may show a restricted child.
          </strong>{' '}
          <span className="muted">Tap the flagged photos to review — export stays locked until then.</span>
        </div>
      )}

      {selecting && (
        <div className="row wrap panel" style={{ marginBottom: 16, padding: 12 }}>
          <span className="muted" style={{ fontSize: 14 }}>
            {selected.size} selected
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() =>
              setSelected(
                selected.size === ready.length
                  ? new Set()
                  : new Set(ready.map((p) => p.id)),
              )
            }
          >
            {selected.size === ready.length ? 'Clear all' : 'Select all'}
          </button>
          <div className="spacer" />
          <button className="btn btn-secondary btn-sm" onClick={() => void bulkReel(true)}>
            Add to reel
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => void bulkReel(false)}>
            Remove from reel
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void bulk(() => ({ overrideClassification: 'pro', correctionEnabled: false }))}
          >
            Treat as Pro
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void bulk(() => ({ overrideClassification: 'mobile' }))}
          >
            Allow Correction
          </button>
        </div>
      )}

      <div className="photo-grid">
        {photos.map((photo) => (
          <div key={photo.id} style={{ position: 'relative' }}>
            <PhotoCell
              photo={photo}
              reelIndex={inReelIndex.get(photo.id)}
              duplicate={duplicateIds.has(photo.id)}
              onOpen={() => {
                if (selecting) {
                  setSelected((s) => {
                    const next = new Set(s);
                    if (next.has(photo.id)) next.delete(photo.id);
                    else next.add(photo.id);
                    return next;
                  });
                } else {
                  setOpenPhotoId(photo.id);
                }
              }}
            />
            {selecting && (
              <div
                style={{
                  position: 'absolute',
                  top: 6,
                  left: 6,
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  border: '2px solid #fff',
                  background: selected.has(photo.id) ? 'var(--ink)' : 'rgba(0,0,0,0.25)',
                  display: 'grid',
                  placeItems: 'center',
                  color: '#fff',
                  fontSize: 13,
                  pointerEvents: 'none',
                }}
              >
                {selected.has(photo.id) ? '✓' : ''}
              </div>
            )}
          </div>
        ))}
      </div>

      {photos.length === 0 && (
        <div className="empty-state panel">
          <h2>No photos here yet</h2>
          <Link to="/new" className="btn btn-primary" style={{ marginTop: 14 }}>
            Upload photos
          </Link>
        </div>
      )}

      <input
        ref={addInputRef}
        type="file"
        accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files?.length && reelId) {
            void ingestFiles(reelId, Array.from(e.target.files)).then((newIds) => {
              void enrichWithAi(reelId);
              // New uploads go straight into the current arrangement.
              if (newIds.length > 0) void addToReel(newIds);
            });
          }
        }}
      />

      {openPhoto && (
        <DetailModal
          photo={openPhoto}
          reelPosition={inReelIndex.get(openPhoto.id)}
          onAddToReel={() => void addToReel([openPhoto.id])}
          onRemoveFromReel={() => void removeFromReel([openPhoto.id])}
          onClose={() => setOpenPhotoId(null)}
          onChanged={refreshArrangement}
        />
      )}
    </div>
  );
}
