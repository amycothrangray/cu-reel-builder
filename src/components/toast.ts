import { create } from 'zustand';
import { uid } from '../lib/ids';

export interface Toast {
  id: string;
  message: string;
  kind: 'info' | 'error';
  /** Optional technical detail, revealed on demand. */
  detail?: string;
}

interface ToastState {
  toasts: Toast[];
  show: (message: string, kind?: 'info' | 'error', detail?: string) => void;
  dismiss: (id: string) => void;
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  show: (message, kind = 'info', detail) => {
    const toast: Toast = { id: uid(), message, kind, detail };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== toast.id) }));
    }, kind === 'error' ? 7000 : 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
