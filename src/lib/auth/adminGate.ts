// Admin gate — MVP local implementation of the role model.
//
// The architecture assumes two roles (Admin / Team Member). Until server
// accounts arrive (Phase 2), admin-only areas — Photo Restrictions, brand
// management, restricted-image overrides — sit behind a local PIN whose
// PBKDF2 hash is stored on-device. This is deliberately structured like a
// credential check so swapping in real authentication is a drop-in change.

import { create } from 'zustand';
import { db } from '../db';
import type { AdminPin } from '../types';

const PIN_SETTING = 'admin-pin';
const ITERATIONS = 210_000;

const toB64 = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return toB64(bits);
}

export async function hasAdminPin(): Promise<boolean> {
  return Boolean((await db.settings.get(PIN_SETTING))?.value);
}

export async function setAdminPin(pin: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);
  const record: AdminPin = { salt: toB64(salt.buffer), hash, iterations: ITERATIONS };
  await db.settings.put({ key: PIN_SETTING, value: record });
}

export async function verifyAdminPin(pin: string): Promise<boolean> {
  const row = await db.settings.get(PIN_SETTING);
  if (!row?.value) return false;
  const stored = row.value as AdminPin;
  const hash = await derive(pin, fromB64(stored.salt), stored.iterations);
  return hash === stored.hash;
}

interface AdminState {
  unlocked: boolean;
  unlock: () => void;
  lock: () => void;
}

/** Session-scoped admin unlock (cleared on refresh). */
export const useAdminStore = create<AdminState>((set) => ({
  unlocked: false,
  unlock: () => set({ unlocked: true }),
  lock: () => set({ unlocked: false }),
}));
