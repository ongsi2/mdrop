/* Recently opened documents.
   Only the file *handle* is stored, never the contents — reopening
   still reads from disk, and the browser re-asks for permission if
   it has lapsed. Everything lives in this origin's IndexedDB and
   goes away when site data is cleared. */

import type { FolderLocation } from './files.ts';

export type RecentEntry = {
  key: string;
  name: string;
  handle: FileSystemFileHandle;
  /** Directory the markdown file is relative to, retained for local images. */
  dir?: FileSystemDirectoryHandle;
  /** The dropped folder and the file's path inside it, for sibling links. */
  root?: FileSystemDirectoryHandle;
  dirPath?: string[];
  at: number;
};

const DB_NAME = 'mdview';
const DB_VERSION = 1;
const STORE = 'recent';
const LIMIT = 6;

/** Handles can only be persisted where the File System Access API
    exists; elsewhere every call below degrades to a no-op. */
export const canRemember = () => 'showOpenFilePicker' in window && 'indexedDB' in window;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        let request: IDBRequest<T>;
        let result: T;
        try {
          request = run(transaction.objectStore(STORE));
        } catch (error) {
          db.close();
          reject(error);
          return;
        }
        request.onsuccess = () => {
          result = request.result;
        };
        transaction.oncomplete = () => {
          db.close();
          resolve(result);
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error ?? request.error ?? new Error('IndexedDB transaction aborted'));
        };
      }),
  );
}

export async function list(): Promise<RecentEntry[]> {
  if (!canRemember()) return [];
  try {
    const all = (await tx<RecentEntry[]>('readonly', (s) => s.getAll())) ?? [];
    return all.sort((a, b) => b.at - a.at).slice(0, LIMIT);
  } catch {
    return [];
  }
}

/** Returns the stored key so the caller can refer back to this entry. */
export async function remember(
  name: string,
  handle: FileSystemFileHandle,
  dir?: FileSystemDirectoryHandle,
  location?: FolderLocation,
): Promise<string | null> {
  if (!canRemember()) return null;
  try {
    /* Same file reopened later should move up, not duplicate. The
       handle itself is the identity the browser understands, so
       compare against what is already stored. */
    const existing = await list();
    let rememberedDir = dir;
    let rememberedRoot = location?.root;
    let rememberedPath = location?.dirPath;
    for (const entry of existing) {
      if (await entry.handle.isSameEntry(handle).catch(() => false)) {
        rememberedDir ??= entry.dir;
        if (!rememberedRoot && entry.root) {
          rememberedRoot = entry.root;
          rememberedPath = entry.dirPath;
        }
        await tx('readwrite', (s) => s.delete(entry.key));
      }
    }
    const key = `${name}:${Date.now()}`;
    const record: RecentEntry = {
      key,
      name,
      handle,
      dir: rememberedDir,
      root: rememberedRoot,
      dirPath: rememberedPath,
      at: Date.now(),
    };
    await tx('readwrite', (s) => s.put(record));

    const kept = await list();
    const stale = (await tx<RecentEntry[]>('readonly', (s) => s.getAll())).filter(
      (e) => !kept.some((k) => k.key === e.key),
    );
    for (const entry of stale) await tx('readwrite', (s) => s.delete(entry.key));
    return key;
  } catch {
    /* a missing history is not worth surfacing */
    return null;
  }
}

/** Query-only check that never prompts; safe to call outside a user gesture. */
export async function isReadable(handle: FileSystemHandle): Promise<boolean> {
  const withPerms = handle as FileSystemHandle & {
    queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
  };
  try {
    return (await withPerms.queryPermission?.({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}

export async function forget(key: string): Promise<void> {
  if (!canRemember()) return;
  try {
    await tx('readwrite', (s) => s.delete(key));
  } catch {
    /* ignore */
  }
}

export async function clear(): Promise<void> {
  if (!canRemember()) return;
  try {
    await tx('readwrite', (s) => s.clear());
  } catch {
    /* ignore */
  }
}

/** Permission lapses between sessions, and re-requesting it needs a
    user gesture — so this must be called straight from a click. */
export async function ensureReadable(handle: FileSystemHandle): Promise<boolean> {
  const withPerms = handle as FileSystemHandle & {
    queryPermission?: (d: { mode: string }) => Promise<PermissionState>;
    requestPermission?: (d: { mode: string }) => Promise<PermissionState>;
  };
  try {
    if ((await withPerms.queryPermission?.({ mode: 'read' })) === 'granted') return true;
    return (await withPerms.requestPermission?.({ mode: 'read' })) === 'granted';
  } catch {
    return false;
  }
}
