// Encrypted persistence for restricted-child recognition data.
//
// Privacy posture:
// - Reference photos are processed entirely in the browser; only 128-d
//   embeddings plus a small review thumbnail are kept.
// - That payload is AES-GCM encrypted at rest in IndexedDB. The key lives in
//   IndexedDB as a non-extractable CryptoKey, which protects the data from
//   casual inspection/copying of the database file. This is device-local
//   protection — server-held keys arrive with real team accounts in Phase 2.
// - Nothing in this module performs network I/O.

import { db } from '../db';
import { uid } from '../ids';
import type { RestrictedProfile, RestrictedReference } from '../types';

const KEY_SETTING = 'restricted-key';

async function getOrCreateKey(): Promise<CryptoKey> {
  const existing = await db.settings.get(KEY_SETTING);
  if (existing?.value) {
    return existing.value as CryptoKey;
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  await db.settings.put({ key: KEY_SETTING, value: key });
  return key;
}

async function encryptJson(value: unknown): Promise<{ iv: ArrayBuffer; cipher: ArrayBuffer }> {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return { iv: iv.buffer, cipher };
}

async function decryptJson<T>(iv: ArrayBuffer, cipher: ArrayBuffer): Promise<T> {
  const key = await getOrCreateKey();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

// ---------------------------------------------------------------------------

export async function listProfiles(): Promise<RestrictedProfile[]> {
  return db.restrictedProfiles.toArray();
}

export async function createProfile(label: string): Promise<RestrictedProfile> {
  const profile: RestrictedProfile = {
    id: uid(),
    label,
    disabled: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    referenceCount: 0,
  };
  await db.restrictedProfiles.add(profile);
  return profile;
}

export async function getReferences(profileId: string): Promise<RestrictedReference[]> {
  const row = await db.restrictedData.get(profileId);
  if (!row) return [];
  try {
    return await decryptJson<RestrictedReference[]>(row.iv, row.cipher);
  } catch {
    return [];
  }
}

export async function saveReferences(
  profileId: string,
  references: RestrictedReference[],
): Promise<void> {
  const { iv, cipher } = await encryptJson(references);
  await db.restrictedData.put({ profileId, iv, cipher });
  await db.restrictedProfiles.update(profileId, {
    referenceCount: references.length,
    updatedAt: Date.now(),
  });
}

export async function setProfileDisabled(profileId: string, disabled: boolean): Promise<void> {
  await db.restrictedProfiles.update(profileId, { disabled, updatedAt: Date.now() });
}

export async function deleteProfile(profileId: string): Promise<void> {
  await db.transaction('rw', db.restrictedProfiles, db.restrictedData, async () => {
    await db.restrictedProfiles.delete(profileId);
    await db.restrictedData.delete(profileId);
  });
}

/** All enabled profiles with their decrypted embeddings, for matching. */
export async function loadActiveReferenceSets(): Promise<
  { profile: RestrictedProfile; embeddings: number[][] }[]
> {
  const profiles = (await listProfiles()).filter((p) => !p.disabled);
  const out: { profile: RestrictedProfile; embeddings: number[][] }[] = [];
  for (const profile of profiles) {
    const refs = await getReferences(profile.id);
    if (refs.length > 0) {
      out.push({ profile, embeddings: refs.map((r) => r.embedding) });
    }
  }
  return out;
}
