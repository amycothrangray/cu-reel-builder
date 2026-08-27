// PIN gate for admin-only actions (restricted-child management, overrides).
// See lib/auth/adminGate.ts for the security posture and Phase 2 path.

import { useEffect, useState } from 'react';
import { hasAdminPin, setAdminPin, useAdminStore, verifyAdminPin } from '../lib/auth/adminGate';
import { Modal } from './Modal';

export function AdminGateModal({
  onClose,
  onUnlocked,
}: {
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const unlock = useAdminStore((s) => s.unlock);
  const [pinExists, setPinExists] = useState<boolean | null>(null);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    void hasAdminPin().then(setPinExists);
  }, []);

  const submit = async () => {
    setError('');
    if (pinExists === false) {
      if (pin.length < 4) {
        setError('Choose at least 4 digits or characters.');
        return;
      }
      if (pin !== confirm) {
        setError('The two entries don’t match.');
        return;
      }
      await setAdminPin(pin);
      unlock();
      onUnlocked();
      return;
    }
    if (await verifyAdminPin(pin)) {
      unlock();
      onUnlocked();
    } else {
      setError('That PIN isn’t right.');
    }
  };

  if (pinExists === null) return null;

  return (
    <Modal onClose={onClose}>
      <h2 style={{ marginBottom: 8 }}>
        {pinExists ? 'Admin access' : 'Set an admin PIN'}
      </h2>
      <p className="muted" style={{ marginBottom: 18 }}>
        {pinExists
          ? 'This area is limited to authorized staff. Enter the admin PIN.'
          : 'Protect restricted-child settings and overrides with a PIN that only authorized staff know.'}
      </p>
      <div className="field">
        <label>PIN</label>
        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
      </div>
      {pinExists === false && (
        <div className="field">
          <label>Confirm PIN</label>
          <input
            type="password"
            inputMode="numeric"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </div>
      )}
      {error && (
        <p style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 13.5 }}>{error}</p>
      )}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={() => void submit()}>
          {pinExists ? 'Unlock' : 'Set PIN & continue'}
        </button>
      </div>
    </Modal>
  );
}

/** Hook: run an action only when admin-unlocked, prompting if needed. */
export function useAdminAction(): {
  gateOpen: boolean;
  closeGate: () => void;
  requireAdmin: (action: () => void) => void;
  GateModal: () => JSX.Element | null;
} {
  const unlocked = useAdminStore((s) => s.unlocked);
  const [gateOpen, setGateOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const requireAdmin = (action: () => void) => {
    if (unlocked) {
      action();
    } else {
      setPendingAction(() => action);
      setGateOpen(true);
    }
  };

  const GateModal = () =>
    gateOpen ? (
      <AdminGateModal
        onClose={() => setGateOpen(false)}
        onUnlocked={() => {
          setGateOpen(false);
          pendingAction?.();
          setPendingAction(null);
        }}
      />
    ) : null;

  return { gateOpen, closeGate: () => setGateOpen(false), requireAdmin, GateModal };
}
