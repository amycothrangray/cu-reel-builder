import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createReel, deleteReelCompletely } from '../lib/reels';
import { ingestFiles, type IngestProgress } from '../lib/analysis/ingest';
import { enrichWithAi } from '../lib/analysis/aiVision';
import { chooseFromDropbox, dropboxConfigured } from '../lib/dropbox';
import { useToasts } from '../components/toast';

const ACCEPT = 'image/jpeg,image/png,image/heic,image/heif,.heic,.heif,.jpg,.jpeg,.png';

export function NewReelScreen() {
  const navigate = useNavigate();
  const show = useToasts((s) => s.show);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<IngestProgress | null>(null);
  const [dropboxBusy, setDropboxBusy] = useState(false);

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter(
        (f) => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png)$/i.test(f.name),
      );
      if (files.length === 0) {
        show('Those files don’t look like photos we can use.', 'error');
        return;
      }
      try {
        const reel = await createReel();
        setProgress({ total: files.length, done: 0, failed: 0, stage: 'Looking through your photos' });
        // Analysis starts immediately — no separate "Analyze" button.
        // ingestFiles never rejects: unreadable files are counted as failures
        // and repeats are dropped, so the counts are the only honest source.
        let failed = 0;
        const ingestedIds = await ingestFiles(reel.id, files, (p) => {
          failed = p.failed;
          setProgress(p);
        });
        const duplicates = files.length - ingestedIds.length - failed;

        if (ingestedIds.length === 0) {
          // Nothing came in — sending her to an empty review screen would
          // just be a mystery. Stay here, clean up the empty reel, say why.
          await deleteReelCompletely(reel.id);
          setProgress(null);
          show(
            files.length === 1
              ? 'We couldn’t open that photo — it may be a file type this browser can’t read. Nothing was lost.'
              : `We couldn’t open any of those ${files.length} photos — they may be a file type this browser can’t read. Nothing was lost.`,
            'error',
          );
          return;
        }

        // Optional AI enrichment runs in the background; never blocks the flow.
        void enrichWithAi(reel.id);
        navigate(`/reel/${reel.id}/review`);

        if (failed > 0 || duplicates > 0) {
          const parts = [`Added ${ingestedIds.length} photo${ingestedIds.length === 1 ? '' : 's'}.`];
          if (duplicates > 0) {
            parts.push(
              `${duplicates} ${duplicates === 1 ? 'was a repeat' : 'were repeats'}, so we kept one of each.`,
            );
          }
          if (failed > 0) {
            parts.push(
              `${failed} couldn’t be opened — that file type may not work in this browser.`,
            );
          }
          show(parts.join(' '), failed > 0 ? 'error' : 'info');
        }
      } catch (err) {
        setProgress(null);
        show(
          'We couldn’t read those photos. Nothing was lost — try again.',
          'error',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    [navigate, show],
  );

  if (progress) {
    const fraction = progress.total > 0 ? progress.done / progress.total : 0;
    return (
      <div className="panel" style={{ maxWidth: 480, margin: '10vh auto', textAlign: 'center' }}>
        <div className="spinner spinner-lg" style={{ margin: '0 auto 18px' }} />
        <h2>{progress.stage}</h2>
        <p className="muted" style={{ margin: '10px 0 18px' }}>
          {progress.done} of {progress.total} photos
          {progress.failed > 0 ? ` · ${progress.failed} couldn’t be read` : ''}
        </p>
        <div className="progressbar">
          <div style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 20 }}>New reel</h1>
      <div
        className="panel"
        style={{
          border: `2px dashed ${dragOver ? 'var(--accent)' : 'var(--line-strong)'}`,
          background: dragOver ? 'var(--paper-sunken)' : 'var(--paper-raised)',
          textAlign: 'center',
          padding: '64px 24px',
          cursor: 'pointer',
          transition: 'border-color 0.15s ease, background 0.15s ease',
        }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFiles(e.dataTransfer.files);
        }}
      >
        <h2 style={{ fontSize: 26 }}>Drop in your photos</h2>
        <p className="muted" style={{ margin: '10px auto 22px', maxWidth: 380 }}>
          JPEG, PNG and iPhone (HEIC) photos all work. We’ll look through them,
          flag anything that needs review, and get everything reel-ready.
        </p>
        <span className="btn btn-primary btn-lg">Choose photos</span>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            // Clear it now, or choosing the same photos again after a failure
            // never fires this and the button looks dead.
            e.target.value = '';
            if (files.length > 0) void handleFiles(files);
          }}
        />
      </div>

      {dropboxConfigured && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button
            className="btn btn-secondary"
            disabled={dropboxBusy}
            onClick={async () => {
              setDropboxBusy(true);
              try {
                const files = await chooseFromDropbox();
                if (files.length > 0) await handleFiles(files);
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
            {dropboxBusy ? <span className="spinner" /> : null} Import from Dropbox
          </button>
        </div>
      )}

      <p className="faint" style={{ marginTop: 14, textAlign: 'center' }}>
        Your photos stay on this device — analysis happens right here in your browser.
      </p>
    </div>
  );
}
