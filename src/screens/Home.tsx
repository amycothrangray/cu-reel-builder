import { useLiveQuery } from 'dexie-react-hooks';
import { Link, useNavigate } from 'react-router-dom';
import { db, blobKey, exportExtension } from '../lib/db';
import { deleteReelCompletely, duplicateReel } from '../lib/reels';
import { TEMPLATES } from '../lib/engine/templates';
import { useBlobMimeType, useBlobUrl } from '../components/hooks';
import { useToasts } from '../components/toast';
import type { ReelRecord } from '../lib/types';

function ReelCard({ reel }: { reel: ReelRecord }) {
  const navigate = useNavigate();
  const show = useToasts((s) => s.show);
  const firstPhoto = useLiveQuery(
    () => db.photos.where('reelId').equals(reel.id).filter((p) => p.status === 'ready').first(),
    [reel.id],
  );
  const thumbUrl = useBlobUrl(firstPhoto ? blobKey.thumb(firstPhoto.id) : null);
  const activeVersion = reel.versions.find((v) => v.id === reel.activeVersionId);
  // The style shown is the one this reel actually plays, which is the active
  // version's — reel.templateId is only what the picker last had selected.
  const template = TEMPLATES.find(
    (t) => t.id === (activeVersion?.timeline.templateId ?? reel.templateId),
  );
  const exportKey =
    reel.status === 'exported' && reel.activeVersionId
      ? blobKey.export(reel.id, reel.activeVersionId)
      : null;
  const exportUrl = useBlobUrl(exportKey);
  const exportType = useBlobMimeType(exportKey);

  const destination =
    reel.status === 'draft' && !reel.templateId
      ? `/reel/${reel.id}/review`
      : `/reel/${reel.id}/edit`;

  return (
    <div className="card" style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <Link
        to={destination}
        style={{ display: 'block', aspectRatio: '4 / 3', background: 'var(--paper-sunken)' }}
      >
        {thumbUrl && (
          <img
            src={thumbUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
      </Link>
      <div style={{ padding: '12px 14px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Link to={destination} style={{ fontWeight: 600, fontSize: 14.5 }}>
          {reel.name}
        </Link>
        <div className="faint">
          {new Date(reel.updatedAt).toLocaleDateString()} ·{' '}
          {reel.status === 'exported' ? 'Exported' : reel.status === 'ready' ? 'Ready' : 'Draft'}
          {template ? ` · ${template.name}` : ''}
        </div>
        <div className="row wrap" style={{ marginTop: 6, gap: 8 }}>
          {exportUrl && (
            <a
              className="btn btn-secondary btn-sm"
              href={exportUrl}
              download={`${reel.name.replace(/[^\w\- ]+/g, '')}.${exportExtension(exportType)}`}
            >
              Download
            </a>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              const copy = await duplicateReel(reel.id);
              if (copy) {
                show('Reel duplicated');
                navigate(`/reel/${copy.id}/review`);
              }
            }}
          >
            Duplicate
          </button>
          <button
            className="btn btn-ghost btn-sm"
            style={{ color: 'var(--danger)' }}
            onClick={async () => {
              if (window.confirm(`Delete “${reel.name}” and its photos? This can’t be undone.`)) {
                await deleteReelCompletely(reel.id);
                show('Reel deleted');
              }
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function HomeScreen() {
  const reels = useLiveQuery(() => db.reels.orderBy('updatedAt').reverse().toArray(), []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Your reels</h1>
          <p className="muted" style={{ marginTop: 6 }}>
            Upload a session, choose the vibe, get the reel.
          </p>
        </div>
        <div className="spacer" />
        <Link to="/new" className="btn btn-primary btn-lg">
          New Reel
        </Link>
      </div>

      {reels && reels.length === 0 && (
        <div className="empty-state panel">
          <h2>No reels yet</h2>
          <p>Start your first one — drop in photos and we’ll do the rest.</p>
          <Link to="/new" className="btn btn-primary" style={{ marginTop: 18 }}>
            Create your first reel
          </Link>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
          gap: 16,
        }}
      >
        {reels?.map((reel) => <ReelCard key={reel.id} reel={reel} />)}
      </div>
    </div>
  );
}
