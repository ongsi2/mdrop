/* Recently opened documents.
   Only the file *handle* is stored, never the contents — reopening
   still reads from disk, and the browser re-asks for permission if
   it has lapsed. Everything lives in this origin's IndexedDB and
   goes away when site data is cleared. */

export type RecentEntry = {
  key: string;
  name: string;
  handle: FileSystemFileHandle;
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
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

export async function remember(name: string, handle: FileSystemFileHandle): Promise<void> {
  if (!canRemember()) return;
  try {
    /* Same file reopened later should move up, not duplicate. The
       handle itself is the identity the browser understands, so
       compare against what is already stored. */
    const existing = await list();
    for (const entry of existing) {
      if (await entry.handle.isSameEntry(handle).catch(() => false)) {
        await tx('readwrite', (s) => s.delete(entry.key));
      }
    }
    const key = `${name}:${Date.now()}`;
    await tx('readwrite', (s) => s.put({ key, name, handle, at: Date.now() }));

    const kept = await list();
    const stale = (await tx<RecentEntry[]>('readonly', (s) => s.getAll())).filter(
      (e) => !kept.some((k) => k.key === e.key),
    );
    for (const entry of stale) await tx('readwrite', (s) => s.delete(entry.key));
  } catch {
    /* a missing history is not worth surfacing */
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
export async function ensureReadable(handle: FileSystemFileHandle): Promise<boolean> {
  const withPerms = handle as FileSystemFileHandle & {
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
