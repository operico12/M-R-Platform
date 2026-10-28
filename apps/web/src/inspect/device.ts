// Inspection drafts, photos and the outbox live on this device
// (docs/inspections.md "Drafts and the outbox"). A draft saves as it is
// filled in; a submitted inspection, and each later step on it, waits in the
// outbox until the database has it. Storage can be full or blocked, so every
// read and write is guarded and the app still works without it.

import type { AuditEntry, Inspection } from '@mr/core';

export interface OutboxItem {
  id: string;
  kind: 'inspection' | 'photo';
  inspectionId: string;
  /** The inspection as it should be saved, for kind 'inspection'. */
  inspection?: Inspection;
  /** For kind 'photo'. The picture itself stays in the photo store until sent. */
  photo?: { id: string; itemId: string };
  audit: AuditEntry[];
  queuedAt: string;
  /** Queued while the device had no connection. */
  offline: boolean;
  tries: number;
  nextAt: string;
  lastError?: string;
  /** The database said no; retrying will not help. */
  refused?: boolean;
}

const key = (site: string, user: string, what: 'drafts' | 'outbox') => `mr.insp.${site}.${user}.${what}`;
const photoKey = (id: string) => `mr.insp.photo.${id}`;

function read<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Returns false when the device could not keep it (storage full or blocked). */
function write(k: string, v: unknown): boolean {
  try {
    localStorage.setItem(k, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
}

export const readDrafts = (site: string, user: string) => read<Inspection[]>(key(site, user, 'drafts'), []);
export const writeDrafts = (site: string, user: string, d: Inspection[]) => write(key(site, user, 'drafts'), d);
export const readOutbox = (site: string, user: string) => read<OutboxItem[]>(key(site, user, 'outbox'), []);
export const writeOutbox = (site: string, user: string, o: OutboxItem[]) => write(key(site, user, 'outbox'), o);

export function keepPhoto(id: string, dataUrl: string): boolean {
  try {
    localStorage.setItem(photoKey(id), dataUrl);
    return true;
  } catch {
    return false;
  }
}
export function localPhoto(id: string): string | undefined {
  try {
    return localStorage.getItem(photoKey(id)) ?? undefined;
  } catch {
    return undefined;
  }
}
/** Free the space once the database has the photo. */
export function forgetPhoto(id: string): void {
  try {
    localStorage.removeItem(photoKey(id));
  } catch {
    /* ignore */
  }
}

/** Wait before the next try: 5 s, 10 s, 20 s … up to 5 minutes. */
export const backoffMs = (tries: number) => Math.min(5_000 * 2 ** Math.max(0, tries - 1), 300_000);

/**
 * A photo from the camera or a file, downscaled to a JPEG data URL small
 * enough to store on the device and in the database (under 600 kB).
 */
export async function downscalePhoto(file: Blob, maxSide = 1280): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('That file is not a picture this device can read.'));
      i.src = url;
    });
    let side = maxSide;
    for (let attempt = 0; attempt < 5; attempt++) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      const data = c.toDataURL('image/jpeg', 0.7);
      if (data.length <= 580_000) return data;
      side = Math.round(side * 0.7);
    }
    throw new Error('The picture is too large, even after shrinking it.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
