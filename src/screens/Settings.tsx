import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { summarizeUsage, type UsageSummary } from '../lib/usage';
import { hasAdminPin, setAdminPin, useAdminStore } from '../lib/auth/adminGate';
import { useAdminAction } from '../components/AdminGate';
import { useToasts } from '../components/toast';

export function SettingsScreen() {
  const show = useToasts((s) => s.show);
  const unlocked = useAdminStore((s) => s.unlocked);
  const lock = useAdminStore((s) => s.lock);
  const { requireAdmin, GateModal } = useAdminAction();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [pinSet, setPinSet] = useState(false);
  const audit = useLiveQuery(
    () => (unlocked ? db.audit.orderBy('at').reverse().limit(30).toArray() : []),
    [unlocked],
  );

  useEffect(() => {
    void summarizeUsage().then(setUsage);
    void hasAdminPin().then(setPinSet);
  }, []);

  return (
    <div style={{ maxWidth: 620, margin: '0 auto' }}>
      <div className="page-header">
        <h1>Settings</h1>
      </div>

      <div className="stack-v">
        <div className="panel">
          <h3 style={{ marginBottom: 10 }}>Usage</h3>
          {usage ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontSize: 26, fontFamily: 'var(--font-display)' }}>{usage.reelsGenerated}</div>
                <div className="faint">reels created</div>
              </div>
              <div>
                <div style={{ fontSize: 26, fontFamily: 'var(--font-display)' }}>{usage.exports}</div>
                <div className="faint">videos exported</div>
              </div>
              <div>
                <div style={{ fontSize: 26, fontFamily: 'var(--font-display)' }}>{usage.aiCalls}</div>
                <div className="faint">AI analysis calls (~${usage.estimatedAiCostUsd.toFixed(2)} est.)</div>
              </div>
              <div>
                <div style={{ fontSize: 26, fontFamily: 'var(--font-display)' }}>{usage.analysisRuns}</div>
                <div className="faint">local analysis runs (free)</div>
              </div>
            </div>
          ) : (
            <span className="spinner" />
          )}
          <p className="faint" style={{ marginTop: 12 }}>
            Rendering and photo analysis run on this device at no cost. AI calls only
            happen when the optional vision analysis is configured on the server.
          </p>
        </div>

        <div className="panel">
          <h3 style={{ marginBottom: 10 }}>Admin</h3>
          <p className="muted" style={{ fontSize: 14, marginBottom: 12 }}>
            The admin PIN protects Photo Restrictions and restricted-photo overrides.
            {pinSet ? '' : ' No PIN is set yet — one will be created the first time you open an admin area.'}
          </p>
          <div className="row wrap">
            {pinSet && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  requireAdmin(() => {
                    const next = window.prompt('New admin PIN (4+ characters):');
                    if (next && next.length >= 4) {
                      void setAdminPin(next).then(() => show('Admin PIN updated.'));
                    }
                  })
                }
              >
                Change PIN
              </button>
            )}
            {unlocked && (
              <button className="btn btn-secondary btn-sm" onClick={lock}>
                Lock admin session
              </button>
            )}
          </div>
        </div>

        {unlocked && (
          <div className="panel">
            <h3 style={{ marginBottom: 10 }}>Override log</h3>
            {audit && audit.length > 0 ? (
              <div className="stack-v" style={{ gap: 6 }}>
                {audit.map((a) => (
                  <div key={a.id} className="faint">
                    {new Date(a.at).toLocaleString()} — {a.action}: {a.details}
                  </div>
                ))}
              </div>
            ) : (
              <p className="faint">No admin actions recorded yet.</p>
            )}
          </div>
        )}

        <div className="panel">
          <h3 style={{ marginBottom: 10 }}>Privacy</h3>
          <p className="muted" style={{ fontSize: 14 }}>
            Photos, reels, brand assets and restricted-child data live in this
            browser’s local storage — they are not uploaded to a server. The one
            exception: when AI photo analysis is configured, small preview copies of
            reel photos (never originals, never restricted-child references) are sent
            to a secure server function for analysis and are not retained. Clearing
            this site’s browser data deletes everything.
          </p>
        </div>
      </div>
      <GateModal />
    </div>
  );
}
