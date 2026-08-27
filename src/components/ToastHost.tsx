import { useState } from 'react';
import { useToasts } from './toast';

export function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (toasts.length === 0) return null;
  return (
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`} onClick={() => dismiss(t.id)}>
          {t.message}
          {t.detail && (
            <div style={{ marginTop: 6 }}>
              <button
                style={{ textDecoration: 'underline', fontSize: 12.5, opacity: 0.85 }}
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(expanded === t.id ? null : t.id);
                }}
              >
                {expanded === t.id ? 'Hide technical details' : 'Show technical details'}
              </button>
              {expanded === t.id && (
                <pre
                  style={{
                    fontSize: 11.5,
                    whiteSpace: 'pre-wrap',
                    marginTop: 6,
                    marginBottom: 0,
                    opacity: 0.85,
                    maxHeight: 120,
                    overflow: 'auto',
                  }}
                >
                  {t.detail}
                </pre>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
