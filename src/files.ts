/* File intake. Everything here stays on the device — no upload
   path exists in this app by construction. */

export type Source = {
  name: string;
  text: string;
  size: number;
  /** Present when the browser handed us a real handle, which is
      what makes live-reload and relative images possible. */
  file?: FileSystemFileHandle;
  dir?: FileSystemDirectoryHandle;
  lastModified?: number;
};

/* Markdown only. `.txt` is not markdown, and `.mdx` is JSX in
   disguise — rendering it as prose produces garbage. */
const MD_RE = /\.(md|markdown|mdown|mkd|mdwn)$/i;

/** Rendering multi-megabyte markdown locks the tab for seconds; a
    real document never gets close to this. */
export const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_MB = MAX_BYTES / 1024 / 1024;

export class TooLargeError extends Error {
  constructor() {
    super('file exceeds the size limit');
    this.name = 'TooLargeError';
  }
}

export const isMarkdownName = (n: string) => MD_RE.test(n);

export const supportsFsAccess = () => 'showOpenFilePicker' in window;

/* ── picker ────────────────────────────────────────────────── */
export async function pickFile(): Promise<Source | null> {
  const w = window as unknown as {
    showOpenFilePicker?: (o: unknown) => Promise<FileSystemFileHandle[]>;
  };

  if (!w.showOpenFilePicker) return null;

  const [handle] = await w.showOpenFilePicker({
    multiple: false,
    excludeAcceptAllOption: true,
    types: [
      {
        description: 'Markdown',
        accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mdwn'] },
      },
    ],
  });
  return handle ? fromFileHandle(handle) : null;
}

export async function fromFileHandle(
  handle: FileSystemFileHandle,
  dir?: FileSystemDirectoryHandle,
): Promise<Source> {
  const file = await handle.getFile();
  if (!isMarkdownName(file.name)) throw new Error('not markdown');
  if (file.size > MAX_BYTES) throw new TooLargeError();
  return {
    name: file.name,
    text: await file.text(),
    size: file.size,
    file: handle,
    dir,
    lastModified: file.lastModified,
  };
}

export async function fromFile(file: File): Promise<Source> {
  if (!isMarkdownName(file.name)) throw new Error('not markdown');
  if (file.size > MAX_BYTES) throw new TooLargeError();
  return { name: file.name, text: await file.text(), size: file.size };
}

/* ── drop ──────────────────────────────────────────────────────
   `dataTransfer.items` is emptied the moment the drop handler
   yields, so every handle request has to be issued synchronously
   and awaited afterwards. */
export function readDropItems(dt: DataTransfer): Promise<unknown>[] {
  const pending: Promise<unknown>[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const withHandle = item as DataTransferItem & {
      getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
    };
    pending.push(
      withHandle.getAsFileSystemHandle
        ? withHandle.getAsFileSystemHandle()
        : Promise.resolve(item.getAsFile()),
    );
  }
  return pending;
}

export async function resolveDrop(dt: DataTransfer): Promise<Source | null> {
  const results = await Promise.all(readDropItems(dt));

  for (const r of results) {
    if (!r) continue;

    if (r instanceof File) {
      if (isMarkdownName(r.name)) return fromFile(r);
      continue;
    }

    const handle = r as FileSystemHandle;
    if (handle.kind === 'file') {
      const fh = handle as FileSystemFileHandle;
      if (isMarkdownName(fh.name)) return fromFileHandle(fh);
    } else if (handle.kind === 'directory') {
      const dir = handle as FileSystemDirectoryHandle;
      const entry = await findMarkdownInDir(dir);
      if (entry) return fromFileHandle(entry, dir);
    }
  }

  /* Some sources (Outlook, a few file managers) only expose
     `dataTransfer.files`. */
  for (const f of Array.from(dt.files)) {
    if (isMarkdownName(f.name)) return fromFile(f);
  }
  return null;
}

/** README first, then the shallowest markdown file we can find. */
async function findMarkdownInDir(
  dir: FileSystemDirectoryHandle,
): Promise<FileSystemFileHandle | null> {
  const iterable = dir as unknown as AsyncIterable<[string, FileSystemHandle]>;
  let fallback: FileSystemFileHandle | null = null;

  for await (const [name, handle] of iterable) {
    if (handle.kind !== 'file' || !isMarkdownName(name)) continue;
    if (/^readme\./i.test(name)) return handle as FileSystemFileHandle;
    fallback ??= handle as FileSystemFileHandle;
  }
  return fallback;
}

/* ── relative images ───────────────────────────────────────────
   A lone dropped file has no sibling access at all; only a
   directory handle can resolve `./img/foo.png`. */
export async function resolveImages(
  root: HTMLElement,
  dir: FileSystemDirectoryHandle,
): Promise<string[]> {
  const created: string[] = [];

  await Promise.all(
    Array.from(root.querySelectorAll('img')).map(async (img) => {
      const raw = img.getAttribute('src') ?? '';
      if (!raw || /^(https?:|data:|blob:|\/\/)/i.test(raw)) return;

      const segments = decodeURI(raw.split(/[?#]/)[0])
        .split('/')
        .filter((s) => s && s !== '.');
      if (!segments.length || segments.includes('..')) return;

      try {
        let cursor = dir;
        for (const seg of segments.slice(0, -1)) {
          cursor = await cursor.getDirectoryHandle(seg);
        }
        const fh = await cursor.getFileHandle(segments[segments.length - 1]);
        const url = URL.createObjectURL(await fh.getFile());
        img.src = url;
        created.push(url);
      } catch {
        img.classList.add('is-missing');
      }
    }),
  );

  return created;
}

/* ── live reload ───────────────────────────────────────────────
   There is no file-watch API on the web, so `lastModified`
   polling is the only option. At this interval the cost is not
   measurable. */
export function watch(
  source: Source,
  onChange: (text: string, lastModified: number) => void,
  onDead?: () => void,
  intervalMs = 800,
): () => void {
  if (!source.file) return () => {};

  let last = source.lastModified ?? 0;
  let stopped = false;

  const id = window.setInterval(async () => {
    if (stopped || document.hidden) return;
    try {
      const file = await source.file!.getFile();
      if (file.lastModified === last) return;
      last = file.lastModified;
      if (file.size > MAX_BYTES) return;
      onChange(await file.text(), file.lastModified);
    } catch {
      /* The file was deleted, moved, or permission lapsed. The
         document on screen is still readable — but the watcher is
         dead, and whoever showed a LIVE badge needs to know. */
      stopped = true;
      window.clearInterval(id);
      onDead?.();
    }
  }, intervalMs);

  return () => {
    stopped = true;
    window.clearInterval(id);
  };
}

/* ── cross-page handoff ────────────────────────────────────────
   Secondary pages (/install/) have no reader, but the site's one
   promise is "drop it anywhere". A drop there stashes the text and
   sends the visitor home, where the reader picks it up. */

const HANDOFF_TEXT = 'mdview:handoff';
const HANDOFF_NAME = 'mdview:handoff-name';

export function stashHandoff(name: string, text: string): boolean {
  try {
    sessionStorage.setItem(HANDOFF_TEXT, text);
    sessionStorage.setItem(HANDOFF_NAME, name);
    return true;
  } catch {
    /* quota — a >2MB document in UTF-16 can exceed it */
    return false;
  }
}

export function takeHandoff(): { name: string; text: string } | null {
  try {
    const text = sessionStorage.getItem(HANDOFF_TEXT);
    if (text === null) return null;
    const name = sessionStorage.getItem(HANDOFF_NAME) ?? 'document.md';
    sessionStorage.removeItem(HANDOFF_TEXT);
    sessionStorage.removeItem(HANDOFF_NAME);
    return { name, text };
  } catch {
    return null;
  }
}
