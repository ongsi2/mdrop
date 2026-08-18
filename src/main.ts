import './styles/theme.css';
import './styles/app.css';
import './styles/markdown.css';

import { enhance, highlight, renderFrontmatterCard, renderMarkdown } from './render.ts';
import { validateMarkdownStructure } from './markdown-budget.ts';
import {
  MAX_MB,
  TooComplexError,
  TooLargeError,
  fromFile,
  fromFileHandle,
  isMarkdownName,
  pickFile,
  resolveDrop,
  resolveImages,
  supportsFsAccess,
  takeHandoff,
  validateSourceText,
  watch,
  type Source,
} from './files.ts';
import { buildToc, type TocController } from './toc.ts';
import { copyFormatted } from './export.ts';
import { lang, rememberLang, t } from './i18n.ts';
import { canRemember, clear as clearRecent, ensureReadable, forget, list, remember } from './recent.ts';
import { safeGet, safeSet } from './storage.ts';

/* A PWA has one manifest and therefore one start URL. Route only launches
   carrying our explicit marker; normal links and crawlers are never redirected. */
{
  const params = new URLSearchParams(location.search);
  const preferred = safeGet('mdview:lang');
  if (params.get('source') === 'pwa' && (preferred === 'ko' || preferred === 'en')) {
    const onEnglishPage = location.pathname.startsWith('/en/');
    if ((preferred === 'en') !== onEnglishPage) {
      const pathname = preferred === 'en' ? '/en/' : '/';
      location.replace(`${pathname}${location.search}${location.hash}`);
    }
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const stage = $('stage');
const hero = $('hero');
const reader = $('reader');
const doc = $('doc');
const tocBox = $('toc');
const tocList = $('toclist');
const dropzone = $('dropzone');
const dropcard = $('dropcard');
const toastEl = $('toast');
const announceEl = $('announce');
const alertEl = $('alert');
const fallbackInput = $<HTMLInputElement>('fallback-input');
const skipLink = document.querySelector<HTMLAnchorElement>('.skip');

const docMeta = $('docmeta');
const docName = $('docname');
const docStat = $('docstat');
const liveBadge = $('livebadge');

const btnOpen = $<HTMLButtonElement>('btn-open');
const btnToc = $<HTMLButtonElement>('btn-toc');
const btnTheme = $<HTMLButtonElement>('btn-theme');
const btnPrint = $<HTMLButtonElement>('btn-print');
const btnCopy = $<HTMLButtonElement>('btn-copy');
const btnInstall = $<HTMLButtonElement>('btn-install');
const btnMore = $<HTMLButtonElement>('btn-more');
const moreMenu = $('more-menu');
const langLink = $<HTMLAnchorElement>('lang-link');
const themeLabel = $('theme-label');
const recentBox = $('recents');
const recentList = $('recent-list');
const recentClear = $<HTMLButtonElement>('recent-clear');

let current: Source | null = null;
let toc: TocController | null = null;
let unwatch: (() => void) | null = null;
let objectUrls: string[] = [];
let renderEpoch = 0;
let watcherEpoch = 0;
let lastOpenTrigger: HTMLElement | null = null;
let pendingPickerTrigger: HTMLElement | null = null;

const storedToc = safeGet('mdview:toc');
let tocEnabled =
  storedToc === 'on' ||
  (storedToc !== 'off' && !window.matchMedia('(max-width: 1100px)').matches);
const initialTitle = document.title;

/* ── feedback ─────────────────────────────────────────────── */
let toastTimer = 0;
let speechSerial = 0;

function speak(message: string, kind: 'info' | 'error' = 'info'): void {
  const target = kind === 'error' ? alertEl : announceEl;
  const serial = ++speechSerial;
  target.textContent = '';
  window.requestAnimationFrame(() => {
    if (serial === speechSerial) target.textContent = message;
  });
}

function hideToast(): void {
  toastEl.hidden = true;
}

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  toastEl.replaceChildren(message);
  toastEl.dataset.kind = kind;
  toastEl.hidden = false;
  speak(message, kind);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(hideToast, kind === 'error' ? 7000 : 2600);
}

/** Stays visible until the reader explicitly accepts the offered action. */
function stickyToast(message: string, actionLabel: string, action: () => void): void {
  window.clearTimeout(toastTimer);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toast__action';
  button.textContent = actionLabel;
  button.addEventListener('click', action, { once: true });
  toastEl.replaceChildren(message, button);
  toastEl.dataset.kind = 'info';
  toastEl.hidden = false;
  speak(message);
}

function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
  themeLabel.textContent = theme.toUpperCase();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0b0b16' : '#fbfbfd');
  safeSet('mdview:theme', theme);
}

function describe(text: string): string {
  const chars = text.replace(/\s/g, '').length;
  return t.stat(chars, chars ? Math.max(1, Math.round(chars / 600)) : 0);
}

function revokeObjectUrls(urls: string[]): void {
  for (const url of urls) URL.revokeObjectURL(url);
}

function releaseObjectUrls(): void {
  revokeObjectUrls(objectUrls);
  objectUrls = [];
}

function reportIntakeError(error: unknown): void {
  if (error instanceof TooLargeError) toast(t.tooLarge(MAX_MB), 'error');
  else if (error instanceof TooComplexError) toast(t.complexityExceeded, 'error');
  else toast(t.openFailed, 'error');
}

/* ── menu and document chrome ─────────────────────────────── */
function setMoreOpen(open: boolean): void {
  moreMenu.dataset.open = String(open);
  btnMore.setAttribute('aria-expanded', String(open));
  btnMore.setAttribute('aria-label', open ? t.moreClose : t.moreOpen);
}

function syncDocumentActions(): void {
  const hasActions = [btnToc, btnCopy, btnPrint, btnInstall].some((button) => !button.hidden);
  btnMore.hidden = !hasActions;
  if (!hasActions) setMoreOpen(false);
}

function syncToc(hasToc: boolean): void {
  const on = hasToc && tocEnabled;
  reader.dataset.toc = on ? 'on' : 'off';
  tocBox.hidden = !on;
  btnToc.setAttribute('aria-pressed', String(on));
}

/* ── atomic render pipeline ───────────────────────────────── */
type PreparedDocument = { root: HTMLElement; urls: string[] };

function prioritizeResolvedImages(root: HTMLElement): void {
  let first = true;
  for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
    if (!image.hasAttribute('src')) {
      image.loading = 'lazy';
      image.removeAttribute('fetchpriority');
      continue;
    }
    image.loading = first ? 'eager' : 'lazy';
    if (first) image.fetchPriority = 'high';
    else image.removeAttribute('fetchpriority');
    first = false;
  }
}

function emptyDocument(name: string): HTMLElement {
  const section = document.createElement('section');
  section.className = 'empty-doc';

  const status = document.createElement('div');
  status.setAttribute('role', 'status');

  const heading = document.createElement('h1');
  heading.className = 'empty-doc__title';
  heading.textContent = t.emptyTitle;

  const body = document.createElement('p');
  body.className = 'empty-doc__body';
  body.textContent = `${name} — ${t.emptyBody}`;
  status.append(heading, body);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'btn btn--solid empty-doc__action';
  action.textContent = t.openAnother;
  action.addEventListener('click', () => void openViaPicker(action));

  section.append(status, action);
  return section;
}

async function prepareDocument(
  source: Source,
  text: string,
  epoch: number,
  byteSize = source.size,
): Promise<PreparedDocument | null> {
  validateSourceText(text, byteSize);
  validateMarkdownStructure(text);

  const root = document.createElement('article');
  if (!text.trim()) {
    root.append(emptyDocument(source.name));
  } else {
    const { html, meta } = renderMarkdown(text);
    root.innerHTML = (meta ? renderFrontmatterCard(meta) : '') + html;
    enhance(root);
  }

  let urls: string[] = [];
  if (source.dir) urls = await resolveImages(root, source.dir, () => epoch === renderEpoch);
  prioritizeResolvedImages(root);
  if (epoch !== renderEpoch) {
    revokeObjectUrls(urls);
    return null;
  }

  /* Highlighting is part of preparation so an older async import can never
     mutate whatever document happens to be live when it finishes. */
  try {
    await highlight(root);
  } catch {
    // Syntax colouring is optional; readable code is already present.
  }

  if (epoch !== renderEpoch) {
    revokeObjectUrls(urls);
    return null;
  }
  return { root, urls };
}

type Anchor = { id: string; offset: number } | { y: number };

function captureAnchor(): Anchor {
  let found: HTMLElement | null = null;
  for (const heading of doc.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id]')) {
    if (heading.getBoundingClientRect().top > 140) break;
    found = heading;
  }
  return found
    ? { id: found.id, offset: found.getBoundingClientRect().top }
    : { y: window.scrollY };
}

function restoreAnchor(anchor: Anchor): void {
  if ('y' in anchor) {
    window.scrollTo({ top: anchor.y });
    return;
  }
  const element = doc.querySelector<HTMLElement>(`#${CSS.escape(anchor.id)}`);
  if (!element) return;
  window.scrollTo({
    top: window.scrollY + element.getBoundingClientRect().top - anchor.offset,
  });
}

function commitDocument(
  source: Source,
  text: string,
  prepared: PreparedDocument,
  options: { focus?: boolean; anchor?: Anchor; byteSize?: number } = {},
): void {
  const oldUrls = objectUrls;
  toc?.destroy();
  toc = null;

  doc.replaceChildren(...Array.from(prepared.root.childNodes));
  objectUrls = prepared.urls;
  revokeObjectUrls(oldUrls);

  current = source;
  source.text = text;
  source.size = options.byteSize ?? source.size;

  toc = buildToc(doc, tocList);
  const hasToc = toc.count >= 2;
  btnToc.hidden = !hasToc;

  hero.hidden = true;
  reader.hidden = false;
  docMeta.hidden = false;
  const hasContent = Boolean(text.trim());
  btnPrint.hidden = !hasContent;
  btnCopy.hidden = !hasContent;
  docName.textContent = source.name;
  docStat.textContent = describe(text);
  liveBadge.hidden = !source.file;
  skipLink?.setAttribute('href', '#doc');

  syncToc(hasToc);
  syncDocumentActions();
  setMoreOpen(false);

  const heading = doc.querySelector('h1');
  const title = heading?.textContent?.replace(/^#/, '').trim() || source.name || 'MDVIEW';
  document.title = `${title} — MDVIEW`;

  if (options.anchor) {
    restoreAnchor(options.anchor);
  } else {
    stage.scrollIntoView({ block: 'start' });
    window.scrollTo({ top: 0 });
  }

  if (options.focus) doc.focus({ preventScroll: true });
  speak(t.documentOpened(source.name, docStat.textContent ?? ''));
}

function stopWatching(): void {
  watcherEpoch += 1;
  unwatch?.();
  unwatch = null;
}

async function reloadSource(
  source: Source,
  text: string,
  lastModified: number,
  byteSize: number,
  watcher: number,
): Promise<void> {
  if (watcher !== watcherEpoch) return;
  if (current !== source) return;
  const anchor = captureAnchor();
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const restoreFocus = Boolean(active && doc.contains(active));
  const focusHeadingId = active?.closest<HTMLElement>('h1[id], h2[id], h3[id], h4[id]')?.id;
  const epoch = ++renderEpoch;
  const prepared = await prepareDocument(source, text, epoch, byteSize);
  if (
    !prepared ||
    watcher !== watcherEpoch ||
    current !== source ||
    epoch !== renderEpoch
  ) {
    return;
  }

  source.lastModified = lastModified;
  commitDocument(source, text, prepared, { anchor, byteSize });
  if (restoreFocus) {
    const heading = focusHeadingId
      ? doc.querySelector<HTMLElement>(`#${CSS.escape(focusHeadingId)}`)
      : null;
    if (heading) {
      if (!heading.hasAttribute('tabindex')) {
        heading.tabIndex = -1;
        heading.addEventListener('blur', () => heading.removeAttribute('tabindex'), { once: true });
      }
      heading.focus({ preventScroll: true });
    } else {
      doc.focus({ preventScroll: true });
    }
  }
  liveBadge.hidden = false;
  toast(t.reloaded);
}

function startWatching(source: Source): void {
  if (!source.file || current !== source) return;
  const watcher = ++watcherEpoch;
  liveBadge.hidden = false;
  unwatch = watch(
    source,
    (text, lastModified, byteSize) =>
      reloadSource(source, text, lastModified, byteSize, watcher),
    () => {
      if (watcher !== watcherEpoch || current !== source) return;
      unwatch = null;
      liveBadge.hidden = true;
      toast(t.readFailed, 'error');
    },
    (error) => {
      if (watcher !== watcherEpoch || current !== source) return;
      liveBadge.hidden = true;
      toast(
        error instanceof TooLargeError ? t.livePaused : t.complexityExceeded,
        'error',
      );
    },
  );
}

async function openSource(source: Source, trigger?: HTMLElement | null): Promise<void> {
  const previous = current;
  stopWatching();
  if (previous?.file) liveBadge.hidden = true;

  const epoch = ++renderEpoch;
  let prepared: PreparedDocument | null;
  try {
    prepared = await prepareDocument(source, source.text, epoch);
  } catch (error) {
    if (current === previous && previous?.file) startWatching(previous);
    throw error;
  }

  if (!prepared || epoch !== renderEpoch) return;
  lastOpenTrigger = trigger ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  commitDocument(source, source.text, prepared, { focus: true, byteSize: source.size });

  if (!(history.state && history.state.mdviewDoc)) {
    history.pushState({ mdviewDoc: true }, '', location.pathname + location.search);
  }

  if (source.file) {
    void remember(source.name, source.file, source.dir);
    startWatching(source);
  }
}

/* ── closing and in-document navigation ───────────────────── */
function closeDocument(): void {
  ++renderEpoch;
  stopWatching();
  current = null;
  releaseObjectUrls();
  toc?.destroy();
  toc = null;
  doc.replaceChildren();

  reader.hidden = true;
  tocBox.hidden = true;
  hero.hidden = false;
  docMeta.hidden = true;
  liveBadge.hidden = true;
  btnPrint.hidden = true;
  btnCopy.hidden = true;
  btnToc.hidden = true;
  syncDocumentActions();
  setMoreOpen(false);
  skipLink?.setAttribute('href', '#stage');

  document.title = initialTitle;
  window.scrollTo({ top: 0 });
  void renderRecents();

  const target = lastOpenTrigger;
  lastOpenTrigger = null;
  window.requestAnimationFrame(() => {
    if (target?.isConnected && target.getClientRects().length) target.focus();
    else dropcard.focus();
  });
}

window.addEventListener('popstate', (event) => {
  if (current && !(event.state && event.state.mdviewDoc)) {
    closeDocument();
  } else if (!current && event.state?.mdviewDoc) {
    /* Closing intentionally releases the local document. Forward cannot
       resurrect it without retaining private content, so clear the marker. */
    history.replaceState(null, '', location.pathname + location.search);
  }
});

doc.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest?.('a[href^="#"]');
  if (!link) return;
  const raw = link.getAttribute('href')?.slice(1) ?? '';
  if (!raw) return;

  event.preventDefault();
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Keep the literal fragment; CSS.escape below makes lookup safe.
  }
  const target = doc.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  history.replaceState(history.state, '', `#${encodeURIComponent(id)}`);
});

/* ── recent documents ─────────────────────────────────────── */
async function renderRecents(): Promise<void> {
  if (!canRemember()) return;
  const entries = await list();
  recentBox.hidden = entries.length === 0;
  if (!entries.length) {
    recentList.replaceChildren();
    return;
  }

  recentList.replaceChildren(
    ...entries.map((entry) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = entry.name;
      chip.title = entry.dir ? t.recentFolderAccess(entry.name) : entry.name;
      if (entry.dir) chip.setAttribute('aria-label', t.recentFolderAccess(entry.name));
      chip.addEventListener('click', async () => {
        if (!(await ensureReadable(entry.handle))) {
          toast(t.recentDenied, 'error');
          return;
        }

        let dir: FileSystemDirectoryHandle | undefined;
        if (entry.dir && (await ensureReadable(entry.dir))) dir = entry.dir;

        try {
          await openSource(await fromFileHandle(entry.handle, dir), chip);
        } catch (error) {
          if (error instanceof TooLargeError || error instanceof TooComplexError) {
            reportIntakeError(error);
            return;
          }
          await forget(entry.key);
          await renderRecents();
          toast(t.recentGone, 'error');
        }
      });
      return chip;
    }),
  );
}

/* ── intake ───────────────────────────────────────────────── */
async function openViaPicker(trigger?: HTMLElement | null): Promise<void> {
  pendingPickerTrigger = trigger ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  try {
    if (supportsFsAccess()) {
      const source = await pickFile();
      if (source) await openSource(source, pendingPickerTrigger);
      return;
    }
    fallbackInput.click();
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') return;
    reportIntakeError(error);
  }
}

fallbackInput.addEventListener('change', async () => {
  const file = fallbackInput.files?.[0];
  fallbackInput.value = '';
  if (!file) return;
  if (!isMarkdownName(file.name)) {
    toast(t.notMarkdown, 'error');
    return;
  }
  try {
    await openSource(await fromFile(file), pendingPickerTrigger);
  } catch (error) {
    reportIntakeError(error);
  }
});

let dragDepth = 0;

window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  dragDepth += 1;
  dropzone.hidden = false;
});

window.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.hidden = true;
});

window.addEventListener('drop', async (event) => {
  if (!event.dataTransfer) return;
  event.preventDefault();
  dragDepth = 0;
  dropzone.hidden = true;

  try {
    const source = await resolveDrop(event.dataTransfer);
    if (!source) {
      toast(t.notMarkdown, 'error');
      return;
    }
    await openSource(source);
  } catch (error) {
    if (error instanceof TooLargeError || error instanceof TooComplexError) {
      reportIntakeError(error);
    } else {
      toast(t.readFailed, 'error');
    }
  }
});

document.addEventListener('paste', async (event) => {
  const target = event.target as HTMLElement | null;
  if (
    target?.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return;
  }

  const file = Array.from(event.clipboardData?.files ?? []).find((candidate) =>
    isMarkdownName(candidate.name),
  );
  if (file) {
    try {
      await openSource(await fromFile(file));
    } catch (error) {
      reportIntakeError(error);
    }
    return;
  }

  const text = event.clipboardData?.getData('text/plain');
  if (!text?.trim()) return;
  const size = new Blob([text]).size;
  try {
    await openSource({ name: t.pastedName, text, size });
    toast(t.pasted);
  } catch (error) {
    reportIntakeError(error);
  }
});

const launch = (
  window as unknown as {
    launchQueue?: { setConsumer(callback: (params: { files?: FileSystemFileHandle[] }) => void): void };
  }
).launchQueue;

launch?.setConsumer(async (params) => {
  const handle = params.files?.[0];
  if (!handle) return;
  try {
    await openSource(await fromFileHandle(handle));
  } catch (error) {
    reportIntakeError(error);
  }
});

/* ── install ──────────────────────────────────────────────── */
type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferredInstall: InstallPrompt | null = null;
const installed =
  window.matchMedia('(display-mode: standalone)').matches ||
  Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
const installGuide = btnInstall.dataset.guide ?? (lang === 'ko' ? '/install/' : '/en/install/');

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  if (installed) return;
  deferredInstall = event as InstallPrompt;
});

btnInstall.addEventListener('click', async () => {
  const prompt = deferredInstall;
  if (!prompt) {
    window.location.assign(installGuide);
    return;
  }

  deferredInstall = null;
  btnInstall.disabled = true;
  try {
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === 'accepted') toast(t.installed);
  } catch {
    window.location.assign(installGuide);
  } finally {
    btnInstall.disabled = false;
  }
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
});

/* ── controls ─────────────────────────────────────────────── */
btnOpen.addEventListener('click', () => void openViaPicker(btnOpen));
dropcard.addEventListener('click', () => void openViaPicker(dropcard));
dropcard.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void openViaPicker(dropcard);
  }
});

btnMore.textContent = t.more;
btnMore.addEventListener('click', () => {
  setMoreOpen(moreMenu.dataset.open !== 'true');
});
moreMenu.addEventListener('click', (event) => {
  if (!(event.target as HTMLElement).closest('button')) return;
  const wasOpen = moreMenu.dataset.open === 'true';
  setMoreOpen(false);
  if (wasOpen) window.requestAnimationFrame(() => btnMore.focus());
});
document.addEventListener('pointerdown', (event) => {
  if (moreMenu.dataset.open !== 'true') return;
  const target = event.target as Node;
  if (!moreMenu.contains(target) && !btnMore.contains(target)) setMoreOpen(false);
});

btnToc.addEventListener('click', () => {
  tocEnabled = !tocEnabled;
  safeSet('mdview:toc', tocEnabled ? 'on' : 'off');
  syncToc((toc?.count ?? 0) >= 2);
});

btnTheme.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

btnPrint.addEventListener('click', () => window.print());

let copying = false;
btnCopy.addEventListener('click', async () => {
  if (copying || !current) return;
  copying = true;
  btnCopy.disabled = true;
  try {
    const result = await copyFormatted(doc, current.text);
    if (result === 'rich') toast(t.copiedRich);
    else if (result === 'plain') toast(t.copiedPlain, 'error');
    else toast(t.copyRichFailed, 'error');
  } finally {
    copying = false;
    btnCopy.disabled = false;
  }
});

recentClear.addEventListener('click', async () => {
  await clearRecent();
  await renderRecents();
});

langLink.addEventListener('click', () => rememberLang(lang === 'ko' ? 'en' : 'ko'));

{
  const hint = document.getElementById('langhint');
  const close = document.getElementById('langhint-close');
  const hintKey = 'mdview:langhint';
  const speaksKorean = (navigator.language ?? '').toLowerCase().startsWith('ko');
  const mismatched = lang === 'ko' ? !speaksKorean : speaksKorean;
  const settled = safeGet(hintKey) === 'off' || safeGet('mdview:lang') !== null;

  if (hint && mismatched && !settled) hint.hidden = false;
  close?.addEventListener('click', () => {
    if (hint) hint.hidden = true;
    safeSet(hintKey, 'off');
  });
}

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (
    target?.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
    event.preventDefault();
    void openViaPicker(btnOpen);
    return;
  }

  if (event.key === 'Escape') {
    if (moreMenu.dataset.open === 'true') {
      event.preventDefault();
      setMoreOpen(false);
      btnMore.focus();
    } else if (current) {
      history.back();
    }
    return;
  }

  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === 't' && !btnToc.hidden) {
    event.preventDefault();
    btnToc.click();
  } else if (key === 'd') {
    event.preventDefault();
    btnTheme.click();
  } else if (key === 'c' && !btnCopy.hidden) {
    event.preventDefault();
    btnCopy.click();
  }
});

/* ── boot ─────────────────────────────────────────────────── */
applyTheme(safeGet('mdview:theme') === 'light' ? 'light' : 'dark');
syncDocumentActions();
void renderRecents();

const directoryDropSupported =
  typeof DataTransferItem !== 'undefined' &&
  'getAsFileSystemHandle' in DataTransferItem.prototype;
for (const element of document.querySelectorAll<HTMLElement>('[data-folder-drop-only]')) {
  element.hidden = !directoryDropSupported;
}

const handoff = takeHandoff();
if (handoff) {
  void openSource({ name: handoff.name, text: handoff.text, size: handoff.size }).catch(
    reportIntakeError,
  );
}

function offerServiceWorkerUpdate(worker: ServiceWorker): void {
  stickyToast(t.updateReady, t.reload, () => {
    let reloading = false;
    navigator.serviceWorker.addEventListener(
      'controllerchange',
      () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      },
      { once: true },
    );
    worker.postMessage({ type: 'SKIP_WAITING' });
  });
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      if (registration.waiting && navigator.serviceWorker.controller) {
        offerServiceWorkerUpdate(registration.waiting);
      }

      registration.addEventListener('updatefound', () => {
        const incoming = registration.installing;
        incoming?.addEventListener('statechange', () => {
          if (incoming.state !== 'installed' || !navigator.serviceWorker.controller) return;
          offerServiceWorkerUpdate(incoming);
        });
      });
    } catch {
      // Offline support is an enhancement, never an intake blocker.
    }
  });
}
