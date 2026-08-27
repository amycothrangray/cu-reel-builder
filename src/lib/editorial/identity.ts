// Recurring-identity clustering WITHIN one uploaded set.
//
// Purpose: a school/community reel should feel like a lively community, not
// six pictures of the same photogenic kid. To do that the engine only needs
// to know "this person appears again", so faces are greedily clustered by
// embedding distance. This is recurrence detection, nothing more: no names,
// no demographics, no attributes, and nothing leaves the device.

import { euclideanDistance } from '../restricted/matching';
import type { SequencePhoto } from '../engine/sequence';

/** Same-person threshold for within-set clustering (face-api convention). */
const CLUSTER_DISTANCE = 0.52;

/** Faces smaller than this fraction of the frame are too unreliable to cluster. */
const MIN_FACE_AREA = 0.003;

export interface IdentityIndex {
  /** photoId → identity cluster ids present in that photo. */
  byPhoto: Map<string, string[]>;
  /** identity id → photoIds containing it. */
  byIdentity: Map<string, string[]>;
  identityCount: number;
}

export function clusterIdentities(photos: SequencePhoto[]): IdentityIndex {
  interface Cluster {
    id: string;
    members: number[][]; // descriptors
  }
  const clusters: Cluster[] = [];
  const byPhoto = new Map<string, string[]>();
  const byIdentity = new Map<string, string[]>();

  for (const photo of photos) {
    const ids: string[] = [];
    const descriptors = photo.descriptors ?? [];
    for (let i = 0; i < descriptors.length; i++) {
      const face = photo.faces[i];
      if (!face || face.w * face.h < MIN_FACE_AREA) continue;
      const descriptor = descriptors[i];
      if (!descriptor || descriptor.length === 0) continue;

      let best: Cluster | null = null;
      let bestDist = Infinity;
      for (const cluster of clusters) {
        for (const member of cluster.members) {
          const d = euclideanDistance(descriptor, member);
          if (d < bestDist) {
            bestDist = d;
            best = cluster;
          }
        }
      }
      let cluster: Cluster;
      if (best && bestDist <= CLUSTER_DISTANCE) {
        cluster = best;
        cluster.members.push(descriptor);
      } else {
        cluster = { id: `person-${clusters.length + 1}`, members: [descriptor] };
        clusters.push(cluster);
      }
      if (!ids.includes(cluster.id)) ids.push(cluster.id);
    }
    byPhoto.set(photo.id, ids);
    for (const id of ids) {
      const list = byIdentity.get(id) ?? [];
      list.push(photo.id);
      byIdentity.set(id, list);
    }
  }

  // Singleton "identities" (seen once) carry no repetition risk; keep them in
  // the index anyway — breadth logic treats an unseen face as fresh either way.
  return { byPhoto, byIdentity, identityCount: clusters.length };
}
