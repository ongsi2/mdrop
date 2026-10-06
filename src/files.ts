/* File intake. Everything here stays on the device; no upload path exists. */

import { inspectRaster } from './raster.ts';
import {
  MAX_DOCUMENT_RASTER_PIXELS,
  MAX_LOCAL_IMAGE_BYTES,
  MAX_LOCAL_IMAGE_COUNT,
  MAX_LOCAL_IMAGE_TOTAL_BYTES,
  MAX_RASTER_DIMENSION,
  MAX_RASTER_PIXELS,
  RASTER_PIXELS_ATTRIBUTE,
  reserveRasterPixels,
  withinRasterBudget,
} from './image-policy.ts';
import { clearMissing, markMissing, type MissingReason } from './missing-image.ts';

export {
  MAX_LOCAL_IMAGE_BYTES,
  MAX_LOCAL_IMAGE_COUNT,
  MAX_LOCAL_IMAGE_TOTAL_BYTES,
} from './image-policy.ts';

export type Source = {
  name: string;
  text: string;
  size: number;
  /** Real handles enable live reload and directory-relative images. */
  file?: FileSystemFileHandle;
  dir?: FileSystemDirectoryHandle;
  /** The dropped folder and this file's directory path inside it. Links to
      sibling documents are resolved against these, so `../` can climb back
      up without ever leaving the folder the reader chose. */
  root?: FileSystemDirectoryHandle;
  dirPath?: string[];
  lastModified?: number;
  /** Key of this document's entry in the recent list, when it has one. */
  recentKey?: string;
};

const MD_RE = /\.(md|markdown|mdown|mkd|mdwn)$/i;

export const MAX_BYTES = 4 * 1024 * 1024;
export const MAX_MB = MAX_BYTES / 1024 / 1024;
export const MAX_LINES = 30_000;
export const MAX_HEADINGS = 5_000;
export const MAX_DOCUMENT_IMAGES = 300;
export const MAX_RAW_HTML_TAGS = 2_000;
export const MAX_RAW_HTML_ATTRIBUTES = 20_000;
export const MAX_LINE_LENGTH = 200_000;
export const MAX_INLINE_MARKERS = 20_000;

export class TooLargeError extends Error {
  constructor() {
    super('file exceeds the size limit');
    this.name = 'TooLargeError';
  }
}

export type ComplexityReason =
  | 'lines'
  | 'line-length'
  | 'headings'
  | 'images'
  | 'html-tags'
  | 'html-attributes'
  | 'inline-markers'
  | 'block-tokens'
  | 'code-blocks';

export class TooComplexError extends Error {
  readonly reason: ComplexityReason;

  constructor(reason: ComplexityReason) {
    super(`document exceeds the ${reason} complexity limit`);
    this.name = 'TooComplexError';
    this.reason = reason;
  }
}

export const isMarkdownName = (name: string) => MD_RE.test(name);

export const supportsFsAccess = () => 'showOpenFilePicker' in window;

/** Decode UTF-8 and BOM-marked UTF-16 without relying on File.text(). */
export async function readText(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    /* utf-16be is not implemented by a few older engines. Byte swapping keeps
       the fallback entirely local and lets the ubiquitous LE decoder do it. */
    const body = bytes.subarray(2);
    const swapped = new Uint8Array(body.length);
    for (let index = 0; index + 1 < body.length; index += 2) {
      swapped[index] = body[index + 1];
      swapped[index + 1] = body[index];
    }
    return new TextDecoder('utf-16le').decode(swapped);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Bound source bytes and pathological line shapes before parsing. The actual
 * Markdown block/inline fan-out budget lives in markdown-budget.ts.
 * `byteSize` should be the original file size when available; pasted strings
 * use their actual UTF-8 Blob size.
 */
export function validateSourceText(text: string, byteSize = new Blob([text]).size): void {
  if (byteSize > MAX_BYTES) throw new TooLargeError();

  let lines = 1;
  let lineLength = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 10 || code === 13) {
      /* Treat LF, CRLF and legacy CR as one logical line break. */
      if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
      lines += 1;
      lineLength = 0;
      if (lines > MAX_LINES) throw new TooComplexError('lines');
    } else {
      lineLength += 1;
      if (lineLength > MAX_LINE_LENGTH) throw new TooComplexError('line-length');
    }
  }

}

export async function pickFile(): Promise<Source | null> {
  const browser = window as unknown as {
    showOpenFilePicker?: (options: unknown) => Promise<FileSystemFileHandle[]>;
  };
  if (!browser.showOpenFilePicker) return null;

  const [handle] = await browser.showOpenFilePicker({
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

export type FolderLocation = { root: FileSystemDirectoryHandle; dirPath: string[] };

export async function fromFileHandle(
  handle: FileSystemFileHandle,
  dir?: FileSystemDirectoryHandle,
  location?: FolderLocation,
): Promise<Source> {
  const file = await handle.getFile();
  if (!isMarkdownName(file.name)) throw new Error('not markdown');
  if (file.size > MAX_BYTES) throw new TooLargeError();
  const text = await readText(file);
  validateSourceText(text, file.size);
  return {
    name: file.name,
    text,
    size: file.size,
    file: handle,
    dir,
    root: location?.root ?? dir,
    dirPath: location?.dirPath ?? [],
    lastModified: file.lastModified,
  };
}

export async function fromFile(file: File): Promise<Source> {
  if (!isMarkdownName(file.name)) throw new Error('not markdown');
  if (file.size > MAX_BYTES) throw new TooLargeError();
  const text = await readText(file);
  validateSourceText(text, file.size);
  return { name: file.name, text, size: file.size };
}

/* `dataTransfer.items` disappears as soon as the drop handler yields, so every
   handle request has to be started synchronously and awaited later. */
export function readDropItems(dataTransfer: DataTransfer): Promise<unknown>[] {
  const pending: Promise<unknown>[] = [];
  for (const item of Array.from(dataTransfer.items)) {
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

export async function resolveDrop(dataTransfer: DataTransfer): Promise<Source | null> {
  const settled = await Promise.allSettled(readDropItems(dataTransfer));
  const results = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );

  for (const result of results) {
    if (!result) continue;
    if (result instanceof File) {
      if (isMarkdownName(result.name)) return fromFile(result);
      continue;
    }

    const handle = result as FileSystemHandle;
    if (handle.kind === 'file') {
      const file = handle as FileSystemFileHandle;
      if (isMarkdownName(file.name)) return fromFileHandle(file);
    } else if (handle.kind === 'directory') {
      const root = handle as FileSystemDirectoryHandle;
      const found = await findMarkdownInDir(root);
      if (found) return fromFileHandle(found.file, found.dir, { root, dirPath: found.dirPath });
    }
  }

  for (const file of Array.from(dataTransfer.files)) {
    if (isMarkdownName(file.name)) return fromFile(file);
  }
  return null;
}

type FoundMarkdown = {
  file: FileSystemFileHandle;
  dir: FileSystemDirectoryHandle;
  dirPath: string[];
};

/** README first at each depth, then the shallowest markdown file. */
async function findMarkdownInDir(root: FileSystemDirectoryHandle): Promise<FoundMarkdown | null> {
  const MAX_DEPTH = 4;
  const MAX_ENTRIES = 1_000;
  let scanned = 0;
  type Level = { dir: FileSystemDirectoryHandle; depth: number; path: string[] };
  let level: Level[] = [{ dir: root, depth: 0, path: [] }];

  while (level.length) {
    const next: Level[] = [];
    let fallback: FoundMarkdown | null = null;

    for (const current of level) {
      const iterable = current.dir as unknown as AsyncIterable<[string, FileSystemHandle]>;
      for await (const [name, handle] of iterable) {
        scanned += 1;
        if (scanned > MAX_ENTRIES) return fallback;

        if (handle.kind === 'file' && isMarkdownName(name)) {
          const found = {
            file: handle as FileSystemFileHandle,
            dir: current.dir,
            dirPath: current.path,
          };
          if (/^readme\./i.test(name)) return found;
          fallback ??= found;
        } else if (handle.kind === 'directory' && current.depth < MAX_DEPTH) {
          next.push({
            dir: handle as FileSystemDirectoryHandle,
            depth: current.depth + 1,
            path: [...current.path, name],
          });
        }
      }
    }

    if (fallback) return fallback;
    level = next;
  }
  return null;
}

const APP_IMAGE_SOURCE = 'data-md-src';
const APPROVED_INLINE_IMAGE = 'data-md-inline-image';
const APPROVED_LOCAL_IMAGE = 'data-md-local-image';
const SAFE_IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif)$/i;
const MAX_IMAGE_PATH_DEPTH = 32;
const IMAGE_RESOLVE_CONCURRENCY = 4;

/* ── links to sibling documents ──────────────────────────────── */

export type DocLinkTarget = { segments: string[]; fragment: string };

/**
 * Normalize a relative link against the open document's folder path. Returns
 * null when the link is absolute, malformed, or climbs above the folder the
 * reader dropped; nothing outside that folder is ever looked up.
 */
export function resolveDocLink(dirPath: string[], href: string): DocLinkTarget | null {
  const trimmed = href.trim();
  const hashAt = trimmed.indexOf('#');
  let fragment = hashAt >= 0 ? trimmed.slice(hashAt + 1) : '';
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // A literal fragment is still usable for lookup.
  }
  const path = (hashAt >= 0 ? trimmed.slice(0, hashAt) : trimmed)
    .split('?', 1)[0]
    .replace(/\\/g, '/');
  if (!path || path.startsWith('/')) return null;

  const segments = [...dirPath];
  for (const encoded of path.split('/')) {
    if (!encoded || encoded === '.') continue;
    let decoded = '';
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (decoded === '..') {
      if (!segments.length) return null;
      segments.pop();
      continue;
    }
    if (!decoded || decoded.length > 255 || /[\\/\0]/.test(decoded)) return null;
    segments.push(decoded);
    if (segments.length > MAX_IMAGE_PATH_DEPTH) return null;
  }
  if (!segments.length) return null;
  return { segments, fragment };
}

/** Open a markdown file inside the dropped folder by its normalized path. */
export async function fromDocLink(
  root: FileSystemDirectoryHandle,
  target: DocLinkTarget,
): Promise<Source> {
  const dirPath = target.segments.slice(0, -1);
  let dir = root;
  for (const segment of dirPath) dir = await dir.getDirectoryHandle(segment);
  const handle = await dir.getFileHandle(target.segments[target.segments.length - 1]);
  return fromFileHandle(handle, dir, { root, dirPath });
}

function safeImagePath(raw: string): { key: string; segments: string[] } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('\\')) return null;
  const path = trimmed.split(/[?#]/, 1)[0].replace(/\\/g, '/');
  if (!path) return null;

  const segments: string[] = [];
  for (const encoded of path.split('/')) {
    if (!encoded || encoded === '.') continue;
    let decoded = '';
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      return null;
    }
    if (
      !decoded ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.length > 255 ||
      /[\\/\0]/.test(decoded)
    ) {
      return null;
    }
    segments.push(decoded);
    if (segments.length > MAX_IMAGE_PATH_DEPTH) return null;
  }

  if (!segments.length || !SAFE_IMAGE_EXTENSION.test(segments[segments.length - 1])) return null;
  return { key: segments.join('/'), segments };
}

type ResolvedImage = { url: string; width: number; height: number };

/** Resolve only inert paths created by render.ts, within strict resource budgets. */
export async function resolveImages(
  root: HTMLElement,
  dir: FileSystemDirectoryHandle,
  shouldContinue: () => boolean = () => true,
): Promise<string[]> {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>(`img[${APP_IMAGE_SOURCE}]`));
  const created: string[] = [];
  const byPath = new Map<string, Promise<ResolvedImage | MissingReason | null>>();
  const byDirectory = new Map<string, Promise<FileSystemDirectoryHandle | null>>([
    ['', Promise.resolve(dir)],
  ]);
  let totalBytes = 0;
  let remainingPixels = MAX_DOCUMENT_RASTER_PIXELS;

  for (const image of root.querySelectorAll<HTMLImageElement>(`img[${APPROVED_INLINE_IMAGE}="1"]`)) {
    const pixels = Number(image.getAttribute(RASTER_PIXELS_ATTRIBUTE));
    const remaining = reserveRasterPixels(remainingPixels, pixels);
    if (remaining === null) {
      image.removeAttribute(APPROVED_INLINE_IMAGE);
      image.removeAttribute(RASTER_PIXELS_ATTRIBUTE);
      markMissing(image, 'budget');
    } else {
      remainingPixels = remaining;
    }
  }

  for (const image of images.slice(MAX_LOCAL_IMAGE_COUNT)) {
    image.removeAttribute(APP_IMAGE_SOURCE);
    markMissing(image, 'too-many');
  }

  function resolveDirectory(segments: string[]): Promise<FileSystemDirectoryHandle | null> {
    let parentKey = '';
    let parent = byDirectory.get(parentKey)!;
    for (const segment of segments) {
      const key = parentKey ? `${parentKey}/${segment}` : segment;
      let pending = byDirectory.get(key);
      if (!pending) {
        pending = parent.then(async (handle) => {
          if (!handle || !shouldContinue()) return null;
          try {
            const child = await handle.getDirectoryHandle(segment);
            return shouldContinue() ? child : null;
          } catch {
            return null;
          }
        });
        byDirectory.set(key, pending);
      }
      parent = pending;
      parentKey = key;
    }
    return parent;
  }

  /** Resolves to the blob, to the reason it was refused, or to null when the
      render was superseded and nothing should be marked. */
  async function load(
    path: { key: string; segments: string[] },
  ): Promise<ResolvedImage | MissingReason | null> {
    let reservedBytes = 0;
    let reservedPixels = 0;
    try {
      if (!shouldContinue()) return null;
      const parent = await resolveDirectory(path.segments.slice(0, -1));
      if (!shouldContinue()) return null;
      if (!parent) return 'not-found';
      const handle = await parent.getFileHandle(path.segments[path.segments.length - 1]);
      if (!shouldContinue()) return null;
      const file = await handle.getFile();
      if (!shouldContinue()) return null;
      if (
        file.size > MAX_LOCAL_IMAGE_BYTES ||
        totalBytes + file.size > MAX_LOCAL_IMAGE_TOTAL_BYTES
      ) {
        return 'too-large';
      }

      /* Reserve synchronously before the signature read yields so concurrent
         workers cannot all pass the aggregate budget against a stale total. */
      totalBytes += file.size;
      reservedBytes = file.size;
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!shouldContinue()) {
        totalBytes -= reservedBytes;
        return null;
      }
      /* Same policy as inspectSafeRaster(), split so the reader learns
         whether the file was the wrong kind or merely too big. */
      const info = inspectRaster(bytes);
      if (!info || info.animated) {
        totalBytes -= reservedBytes;
        return 'unsupported';
      }
      if (!withinRasterBudget(info)) {
        totalBytes -= reservedBytes;
        return 'budget';
      }
      const pixels = info.width * info.height;
      const remaining = reserveRasterPixels(remainingPixels, pixels);
      if (remaining === null) {
        totalBytes -= reservedBytes;
        return 'budget';
      }
      remainingPixels = remaining;
      reservedPixels = pixels;

      const typed = file.type === info.mime ? file : file.slice(0, file.size, info.mime);
      const url = URL.createObjectURL(typed);
      created.push(url);
      reservedBytes = 0;
      reservedPixels = 0;
      return { url, width: info.width, height: info.height };
    } catch {
      if (reservedBytes) totalBytes -= reservedBytes;
      if (reservedPixels) remainingPixels += reservedPixels;
      /* Lookup and read failures alike: the path does not resolve to a
         readable file in this folder. */
      return shouldContinue() ? 'not-found' : null;
    }
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (shouldContinue() && cursor < Math.min(images.length, MAX_LOCAL_IMAGE_COUNT)) {
      const image = images[cursor];
      cursor += 1;
      image.removeAttribute('src');
      image.removeAttribute(APPROVED_LOCAL_IMAGE);

      const raw = image.getAttribute(APP_IMAGE_SOURCE) ?? '';
      const path = safeImagePath(raw);
      image.removeAttribute(APP_IMAGE_SOURCE);
      if (!path) {
        markMissing(image, 'unsupported', raw.slice(0, 120));
        continue;
      }

      let pending = byPath.get(path.key);
      if (!pending) {
        pending = load(path);
        byPath.set(path.key, pending);
      }
      const resolved = await pending;
      if (!shouldContinue() || resolved === null) return;
      if (typeof resolved === 'string') {
        markMissing(image, resolved, path.key);
        continue;
      }

      image.addEventListener(
        'load',
        () => {
          if (
            !image.naturalWidth ||
            !image.naturalHeight ||
            image.naturalWidth > MAX_RASTER_DIMENSION ||
            image.naturalHeight > MAX_RASTER_DIMENSION ||
            image.naturalWidth * image.naturalHeight > MAX_RASTER_PIXELS
          ) {
            markMissing(image, 'budget', path.key);
            return;
          }
          /* Approval is deliberately delayed until the browser has decoded the
             same bounded image successfully. Copying earlier simply omits it. */
          image.setAttribute(APPROVED_LOCAL_IMAGE, '1');
          image.setAttribute(
            RASTER_PIXELS_ATTRIBUTE,
            String(resolved.width * resolved.height),
          );
          clearMissing(image);
        },
        { once: true },
      );
      image.addEventListener(
        'error',
        () => {
          image.removeAttribute(APPROVED_LOCAL_IMAGE);
          image.removeAttribute(RASTER_PIXELS_ATTRIBUTE);
          markMissing(image, 'decode', path.key);
        },
        { once: true },
      );
      if (!image.hasAttribute('width') && !image.hasAttribute('height')) {
        image.width = resolved.width;
        image.height = resolved.height;
      }
      /* Optimistic: the placeholder note must not flash while the blob
         decodes. A failure re-marks the image from the error listener. */
      clearMissing(image);
      image.src = resolved.url;
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(IMAGE_RESOLVE_CONCURRENCY, images.length) },
      () => worker(),
    ),
  );
  return created;
}

export type WatchRejectedError = TooLargeError | TooComplexError;

/** Poll a file handle, advancing the applied mtime only after a successful render. */
export function watch(
  source: Source,
  onChange: (text: string, lastModified: number, byteSize: number) => void | Promise<void>,
  onDead?: () => void,
  onRejected?: (error: WatchRejectedError) => void,
  intervalMs = 800,
): () => void {
  if (!source.file) return () => {};

  let appliedModified = source.lastModified ?? 0;
  let rejectedModified: number | null = null;
  let failedModified: number | null = null;
  let retryFailedAfter = 0;
  let checking = false;
  let stopped = false;

  const id = window.setInterval(async () => {
    if (stopped || checking || document.hidden) return;
    checking = true;
    try {
      const file = await source.file!.getFile();
      if (stopped) return;
      if (file.lastModified === appliedModified || file.lastModified === rejectedModified) return;
      if (file.lastModified === failedModified && Date.now() < retryFailedAfter) return;

      let text: string;
      try {
        if (file.size > MAX_BYTES) throw new TooLargeError();
        text = await readText(file);
        if (stopped) return;
        validateSourceText(text, file.size);
      } catch (error) {
        if (error instanceof TooLargeError || error instanceof TooComplexError) {
          rejectedModified = file.lastModified;
          onRejected?.(error);
          return;
        }
        throw error;
      }

      try {
        if (stopped) return;
        await onChange(text, file.lastModified, file.size);
        if (stopped) return;
        appliedModified = file.lastModified;
        rejectedModified = null;
        failedModified = null;
      } catch (error) {
        if (error instanceof TooLargeError || error instanceof TooComplexError) {
          rejectedModified = file.lastModified;
          onRejected?.(error);
          return;
        }
        /* Keep the previous document and retry a transient render failure later. */
        failedModified = file.lastModified;
        retryFailedAfter = Date.now() + 5_000;
      }
    } catch {
      stopped = true;
      window.clearInterval(id);
      onDead?.();
    } finally {
      checking = false;
    }
  }, intervalMs);

  return () => {
    stopped = true;
    window.clearInterval(id);
  };
}

const HANDOFF = 'mdview:handoff-v2';
const LEGACY_HANDOFF_TEXT = 'mdview:handoff';
const LEGACY_HANDOFF_NAME = 'mdview:handoff-name';

export type Handoff = {
  name: string;
  text: string;
  size: number;
  /** Set when the document was carried across an in-app navigation
      (language switch, install guide) rather than freshly dropped. */
  carried?: boolean;
  /** Lets the reader reattach the file handle kept in the recent list. */
  recentKey?: string;
};

export function stashHandoff(
  name: string,
  text: string,
  size = new Blob([text]).size,
  extra: Pick<Handoff, 'carried' | 'recentKey'> = {},
): boolean {
  try {
    const payload: Handoff = { name, text, size, ...extra };
    sessionStorage.setItem(HANDOFF, JSON.stringify(payload));
    sessionStorage.removeItem(LEGACY_HANDOFF_TEXT);
    sessionStorage.removeItem(LEGACY_HANDOFF_NAME);
    return true;
  } catch {
    try {
      sessionStorage.removeItem(HANDOFF);
    } catch {
      // Storage is unavailable; there is nothing else to clean up.
    }
    return false;
  }
}

export function takeHandoff(): Handoff | null {
  try {
    const payload = sessionStorage.getItem(HANDOFF);
    if (payload !== null) {
      sessionStorage.removeItem(HANDOFF);
      const parsed = JSON.parse(payload) as {
        name?: unknown;
        text?: unknown;
        size?: unknown;
        carried?: unknown;
        recentKey?: unknown;
      };
      if (
        typeof parsed.name === 'string' &&
        typeof parsed.text === 'string' &&
        typeof parsed.size === 'number' &&
        Number.isFinite(parsed.size) &&
        parsed.size >= 0
      ) {
        const handoff: Handoff = { name: parsed.name, text: parsed.text, size: parsed.size };
        if (parsed.carried === true) handoff.carried = true;
        if (typeof parsed.recentKey === 'string' && parsed.recentKey) {
          handoff.recentKey = parsed.recentKey;
        }
        return handoff;
      }
      return null;
    }

    /* One-release migration for handoffs written by the previous format. */
    const text = sessionStorage.getItem(LEGACY_HANDOFF_TEXT);
    if (text === null) return null;
    const name = sessionStorage.getItem(LEGACY_HANDOFF_NAME) ?? 'document.md';
    sessionStorage.removeItem(LEGACY_HANDOFF_TEXT);
    sessionStorage.removeItem(LEGACY_HANDOFF_NAME);
    return { name, text, size: new Blob([text]).size };
  } catch {
    return null;
  }
}
