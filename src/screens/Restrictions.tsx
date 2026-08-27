import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { auditLog, db } from '../lib/db';
import { useAdminStore } from '../lib/auth/adminGate';
import { AdminGateModal } from '../components/AdminGate';
import { decodeImageFile, scaleToCanvas, canvasToBlob } from '../lib/imaging/decode';
import { detectFacesWithDescriptors } from '../lib/analysis/faces';
import {
  createProfile,
  deleteProfile,
  getReferences,
  saveReferences,
  setProfileDisabled,
} from '../lib/restricted/store';
import { rescanReelForRestricted } from '../lib/analysis/ingest';
import { useToasts } from '../components/toast';
import type { RestrictedProfile, RestrictedReference } from '../lib/types';

function ProfileCard({ profile }: { profile: RestrictedProfile }) {
  const show = useToasts((s) => s.show);
  const [busy, setBusy] = useState(false);
  const [refs, setRefs] = useState<RestrictedReference[] | null>(null);

  const loadRefs = async () => setRefs(await getReferences(profile.id));

  const addReferences = async (files: FileList) => {
    setBusy(true);
    try {
      const existing = await getReferences(profile.id);
      let added = 0;
      for (const file of Array.from(files)) {
        try {
          // All processing stays in this browser: decode → detect → embed.
          const bitmap = await decodeImageFile(file);
          const canvas = scaleToCanvas(bitmap, 1000);
          bitmap.close();
          const faces = await detectFacesWithDescriptors(canvas);
          if (faces.length === 0) {
            show(`No face found in ${file.name} — try a clearer photo.`, 'error');
            continue;
          }
          // Use the largest face in the reference photo.
          const main = faces.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h)[0];
          // Tiny crop for the review screen only.
          const thumbCanvas = document.createElement('canvas');
          const size = 96;
          thumbCanvas.width = size;
          thumbCanvas.height = size;
          const pad = 0.25;
          const sx = Math.max(0, (main.box.x - main.box.w * pad) * canvas.width);
          const sy = Math.max(0, (main.box.y - main.box.h * pad) * canvas.height);
          const sw = Math.min(canvas.width - sx, main.box.w * (1 + pad * 2) * canvas.width);
          const sh = Math.min(canvas.height - sy, main.box.h * (1 + pad * 2) * canvas.height);
          thumbCanvas.getContext('2d')!.drawImage(canvas, sx, sy, sw, sh, 0, 0, size, size);
          const thumbBlob = await canvasToBlob(thumbCanvas, 'image/jpeg', 0.7);
          const thumbDataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(thumbBlob);
          });
          existing.push({
            embedding: Array.from(main.descriptor),
            thumbDataUrl,
            addedAt: Date.now(),
          });
          added++;
        } catch (err) {
          show(`Couldn’t process ${file.name}.`, 'error', err instanceof Error ? err.message : undefined);
        }
      }
      if (added > 0) {
        await saveReferences(profile.id, existing);
        await auditLog('admin', 'restricted-add-references', `${added} for ${profile.label}`);
        show(`${added} reference photo${added > 1 ? 's' : ''} added for ${profile.label}.`);
        setRefs(existing);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h3>{profile.label}</h3>
          <p className="faint">
            {profile.referenceCount} reference{profile.referenceCount === 1 ? '' : 's'}
            {profile.disabled ? ' · disabled' : ''}
          </p>
        </div>
        <div className="spacer" />
        <label className="btn btn-secondary btn-sm">
          {busy ? <span className="spinner" /> : 'Add reference photos'}
          <input
            type="file"
            accept="image/*,.heic,.heif"
            multiple
            hidden
            disabled={busy}
            onChange={(e) => e.target.files?.length && void addReferences(e.target.files)}
          />
        </label>
      </div>

      <div className="row wrap" style={{ marginTop: 10 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => void (refs ? setRefs(null) : loadRefs())}>
          {refs ? 'Hide references' : 'Show references'}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => void setProfileDisabled(profile.id, !profile.disabled)}
        >
          {profile.disabled ? 'Enable' : 'Disable'}
        </button>
        <button
          className="btn btn-ghost btn-sm"
          style={{ color: 'var(--danger)' }}
          onClick={async () => {
            if (window.confirm(`Delete “${profile.label}” and all recognition data?`)) {
              await deleteProfile(profile.id);
              await auditLog('admin', 'restricted-delete-profile', profile.label);
            }
          }}
        >
          Delete
        </button>
      </div>

      {refs && (
        <div className="row wrap" style={{ marginTop: 10 }}>
          {refs.length === 0 && <span className="faint">No references yet.</span>}
          {refs.map((r, i) => (
            <div key={i} style={{ position: 'relative' }}>
              <img
                src={r.thumbDataUrl}
                alt=""
                style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover' }}
              />
              <button
                style={{
                  position: 'absolute',
                  top: -6,
                  right: -6,
                  background: 'var(--danger)',
                  color: '#fff',
                  borderRadius: '50%',
                  width: 20,
                  height: 20,
                  fontSize: 11,
                }}
                onClick={async () => {
                  const next = refs.filter((_, j) => j !== i);
                  await saveReferences(profile.id, next);
                  setRefs(next);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RestrictionsScreen() {
  const unlocked = useAdminStore((s) => s.unlocked);
  const [gateOpen, setGateOpen] = useState(true);
  const [newLabel, setNewLabel] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const show = useToasts((s) => s.show);
  const profiles = useLiveQuery(() => db.restrictedProfiles.toArray(), []);

  if (!unlocked) {
    return (
      <div>
        <div className="empty-state panel" style={{ maxWidth: 480, margin: '6vh auto' }}>
          <h2>Photo Restrictions</h2>
          <p>This area holds recognition data for children who can’t appear in marketing. Admin access required.</p>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setGateOpen(true)}>
            Unlock
          </button>
        </div>
        {gateOpen && (
          <AdminGateModal onClose={() => setGateOpen(false)} onUnlocked={() => setGateOpen(false)} />
        )}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <div className="page-header">
        <div>
          <h1>Photo Restrictions</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Reference photos for children who must not appear in marketing.
          </p>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 20, background: 'var(--paper-sunken)' }}>
        <h3 style={{ marginBottom: 6 }}>How privacy works here</h3>
        <p className="muted" style={{ fontSize: 13.5 }}>
          Reference photos are analyzed entirely in this browser and are not uploaded
          anywhere. Only a numerical face signature and a small review thumbnail are
          kept, encrypted on this device, and they are never used to train anything.
          Keep labels simple — no birth dates, schools or family details.
        </p>
      </div>

      <div className="row" style={{ marginBottom: 20 }}>
        <input
          type="text"
          placeholder="Internal label, e.g. “Student A”"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          style={{
            flex: 1,
            background: 'var(--paper-raised)',
            border: '1px solid var(--line-strong)',
            borderRadius: 10,
            padding: '11px 14px',
            minHeight: 44,
          }}
        />
        <button
          className="btn btn-primary"
          disabled={!newLabel.trim()}
          onClick={async () => {
            await createProfile(newLabel.trim());
            await auditLog('admin', 'restricted-create-profile', newLabel.trim());
            setNewLabel('');
          }}
        >
          Add Child
        </button>
      </div>

      <div className="stack-v">
        {profiles?.map((p) => <ProfileCard key={p.id} profile={p} />)}
        {profiles?.length === 0 && (
          <p className="faint" style={{ textAlign: 'center', padding: 24 }}>
            No restricted profiles yet.
          </p>
        )}
      </div>

      {profiles && profiles.length > 0 && (
        <div className="panel" style={{ marginTop: 20 }}>
          <h3 style={{ marginBottom: 6 }}>Re-check existing reels</h3>
          <p className="muted" style={{ fontSize: 13.5, marginBottom: 12 }}>
            After adding or changing references, re-scan photos already uploaded to
            open reels.
          </p>
          <button
            className="btn btn-secondary"
            disabled={rescanning}
            onClick={async () => {
              setRescanning(true);
              try {
                const reels = await db.reels.toArray();
                let flagged = 0;
                for (const reel of reels) {
                  flagged += await rescanReelForRestricted(reel.id);
                }
                show(
                  flagged > 0
                    ? `Re-scan complete — ${flagged} photo${flagged > 1 ? 's' : ''} flagged for review.`
                    : 'Re-scan complete — nothing flagged.',
                );
              } finally {
                setRescanning(false);
              }
            }}
          >
            {rescanning ? <span className="spinner" /> : null} Re-scan all reels
          </button>
        </div>
      )}
    </div>
  );
}
