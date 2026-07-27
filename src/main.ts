import './styles/theme.css';
import './styles/app.css';
import './styles/markdown.css';

import { enhance, highlight, renderFrontmatterCard, renderMarkdown } from './render.ts';
import {
  MAX_MB,
  TooLargeError,
  fromFile,
  fromFileHandle,
  isMarkdownName,
  pickFile,
  resolveDrop,
  resolveImages,
  supportsFsAccess,
  takeHandoff,
  watch,
  type Source,
} from './files.ts';
import { buildToc, type TocController } from './toc.ts';
import { copyFormatted } from './export.ts';
import { lang, rememberLang, t } from './i18n.ts';
import { canRemember, clear as clearRecent, ensureReadable, forget, list, remember } from './recent.ts';

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
const fallbackInput = $<HTMLInputElement>('fallback-input');

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
const langLink = $<HTMLAnchorElement>('lang-link');
const themeLabel = $('theme-label');
const recentBox = $('recents');
const recentList = $('recent-list');
const recentClear = $<HTMLButtonElement>('recent-clear');

/* ── state ─────────────────────────────────────────────────── */
let current: Source | null = null;
let toc: TocController | null = null;
let unwatch: (() => void) | null = null;
let objectUrls: string[] = [];
let tocEnabled = localStorage.getItem('mdview:toc') !== 'off';
const initialTitle = document.title;

/* ── chrome helpers ────────────────────────────────────────── */
let toastTimer = 0;
function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  toastEl.replaceChildren(message);
  toastEl.dataset.kind = kind;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => {
      toastEl.hidden = true;
    },
    kind === 'error' ? 4200 : 2200,
  );
}

/** Stays put until acted on — an offer the reader can ignore. */
function stickyToast(message: string, actionLabel: string, action: () => void): void {
  window.clearTimeout(toastTimer);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toast__action';
  button.textContent = actionLabel;
  button.addEventListener('click', action);
  toastEl.replaceChildren(message, button);
  toastEl.dataset.kind = 'info';
  toastEl.hidden = false;
}

function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
  themeLabel.textContent = theme.toUpperCase();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0b0b16' : '#fbfbfd');
  localStorage.setItem('mdview:theme', theme);
}

function describe(text: string): string {
  const chars = text.replace(/\s/g, '').length;
  return t.stat(chars, Math.max(1, Math.round(chars / 600)));
}

function releaseObjectUrls(): void {
  objectUrls.forEach(URL.revokeObjectURL);
  objectUrls = [];
}

function reportIntakeError(err: unknown): void {
  if (err instanceof TooLargeError) toast(t.tooLarge(MAX_MB), 'error');
  else toast(t.openFailed, 'error');
}

/* ── render pipeline ───────────────────────────────────────── */
async function paint(text: string): Promise<void> {
  releaseObjectUrls();

  const { html, meta } = renderMarkdown(text);
  doc.innerHTML = (meta ? renderFrontmatterCard(meta) : '') + html;
  enhance(doc);

  if (current?.dir) {
    objectUrls = await resolveImages(doc, current.dir);
  }

  toc?.destroy();
  toc = buildToc(doc, tocList);
  const hasToc = toc.count >= 2;
  btnToc.hidden = !hasToc;
  syncToc(hasToc);

  docStat.textContent = describe(text);

  const heading = doc.querySelector('h1');
  document.title = `${heading?.textContent?.replace(/^#/, '').trim() || current?.name || 'MDVIEW'} — MDVIEW`;

  /* Not awaited: the document is readable before the highlighter
     finishes downloading. */
  void highlight(doc);
}

function syncToc(hasToc: boolean): void {
  const on = hasToc && tocEnabled;
  reader.dataset.toc = on ? 'on' : 'off';
  tocBox.hidden = !on;
  btnToc.setAttribute('aria-pressed', String(on));
}

async function open(source: Source): Promise<void> {
  unwatch?.();
  unwatch = null;
  current = source;

  /* One history entry for "a document is open", pushed once — so the
     Back button returns to the empty state instead of leaving the
     site. Opening another document on top reuses the same entry. */
  if (!(history.state && history.state.mdviewDoc)) {
    history.pushState({ mdviewDoc: true }, '', location.pathname + location.search);
  }

  hero.hidden = true;
  reader.hidden = false;
  docMeta.hidden = false;
  btnPrint.hidden = false;
  btnCopy.hidden = false;
  docName.textContent = source.name;

  await paint(source.text);
  stage.scrollIntoView({ block: 'start' });
  window.scrollTo({ top: 0 });

  liveBadge.hidden = !source.file;
  if (source.file) {
    void remember(source.name, source.file);
    unwatch = watch(
      source,
      async (text, lastModified) => {
        if (!current) return;
        current.text = text;
        current.lastModified = lastModified;
        const anchor = captureAnchor();
        await paint(text);
        restoreAnchor(anchor);
        toast(t.reloaded);
      },
      /* The document stays readable, but a LIVE badge over a dead
         watcher is a lie. */
      () => {
        liveBadge.hidden = true;
      },
    );
  }
}

/* ── keeping your place across a live reload ────────────────────
   Restoring a raw pixel offset drifts as soon as an edit above the
   viewport changes height, which is exactly what editing does.
   Pin to the heading you were under instead. */
type Anchor = { id: string; offset: number } | { y: number };

function captureAnchor(): Anchor {
  let found: HTMLElement | null = null;
  for (const h of doc.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id]')) {
    if (h.getBoundingClientRect().top > 140) break;
    found = h;
  }
  return found ? { id: found.id, offset: found.getBoundingClientRect().top } : { y: window.scrollY };
}

function restoreAnchor(anchor: Anchor): void {
  if ('y' in anchor) {
    window.scrollTo({ top: anchor.y });
    return;
  }
  const el = doc.querySelector<HTMLElement>(`#${CSS.escape(anchor.id)}`);
  if (!el) return;
  window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - anchor.offset });
}

/* ── closing a document (Back / Esc) ───────────────────────────── */
function closeDocument(): void {
  unwatch?.();
  unwatch = null;
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

  document.title = initialTitle;
  window.scrollTo({ top: 0 });
  /* The document just closed is the freshest "recent" — the chips
     must include it. */
  void renderRecents();
}

window.addEventListener('popstate', (event) => {
  /* Hash navigation inside an open document also fires popstate; the
     doc marker distinguishes "left the document" from "moved within
     it". */
  if (current && !(event.state && event.state.mdviewDoc)) closeDocument();
});

/* In-document hash links (heading permalinks, footnotes) must not
   stack history entries — each one would become an extra Back press
   on the way out. Scroll and update the URL in place instead. */
doc.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest?.('a[href^="#"]');
  if (!link) return;
  event.preventDefault();
  const id = decodeURIComponent(link.getAttribute('href')!.slice(1));
  const target = document.getElementById(id);
  target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  history.replaceState(history.state, '', `#${id}`);
});

/* ── recent documents ──────────────────────────────────────────── */
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
      chip.title = entry.name;
      chip.addEventListener('click', async () => {
        /* Called straight from the click so the permission prompt
           still counts as user-initiated. */
        if (!(await ensureReadable(entry.handle))) {
          toast(t.recentDenied, 'error');
          return;
        }
        try {
          await open(await fromFileHandle(entry.handle));
        } catch (err) {
          if (err instanceof TooLargeError) {
            toast(t.tooLarge(MAX_MB), 'error');
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

/* ── intake ────────────────────────────────────────────────── */
async function openViaPicker(): Promise<void> {
  try {
    if (supportsFsAccess()) {
      const source = await pickFile();
      if (source) await open(source);
      return;
    }
    fallbackInput.click();
  } catch (err) {
    /* The picker throws AbortError when the user simply cancels. */
    if ((err as DOMException)?.name === 'AbortError') return;
    reportIntakeError(err);
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
    await open(await fromFile(file));
  } catch (err) {
    reportIntakeError(err);
  }
});

/* ── drag and drop ─────────────────────────────────────────── */
let dragDepth = 0;

window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth += 1;
  dropzone.hidden = false;
});

window.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.hidden = true;
});

window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer) return;
  e.preventDefault();
  dragDepth = 0;
  dropzone.hidden = true;

  try {
    const source = await resolveDrop(e.dataTransfer);
    if (!source) {
      toast(t.notMarkdown, 'error');
      return;
    }
    await open(source);
  } catch (err) {
    if (err instanceof TooLargeError) toast(t.tooLarge(MAX_MB), 'error');
    else toast(t.readFailed, 'error');
  }
});

/* ── paste ─────────────────────────────────────────────────── */
document.addEventListener('paste', async (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.isContentEditable || target instanceof HTMLInputElement) return;

  const file = Array.from(e.clipboardData?.files ?? []).find((f) => isMarkdownName(f.name));
  if (file) {
    try {
      await open(await fromFile(file));
    } catch (err) {
      reportIntakeError(err);
    }
    return;
  }

  const text = e.clipboardData?.getData('text/plain');
  if (!text?.trim()) return;
  await open({ name: t.pastedName, text, size: text.length });
  toast(t.pasted);
});

/* ── file handler: .md double-click in Explorer ────────────────
   Only fires for an installed PWA on Chromium desktop, which is
   the whole point of installing it. */
const launch = (
  window as unknown as {
    launchQueue?: { setConsumer(cb: (p: { files?: FileSystemFileHandle[] }) => void): void };
  }
).launchQueue;

launch?.setConsumer(async (params) => {
  const handle = params.files?.[0];
  if (!handle) return;
  try {
    await open(await fromFileHandle(handle));
  } catch (err) {
    reportIntakeError(err);
  }
});

/* ── install ───────────────────────────────────────────────────
   Chromium hides its own install affordance in the address-bar
   overflow, where nobody finds it. Catch the event and surface a
   real button instead. */
type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferredInstall: InstallPrompt | null = null;
const installed = window.matchMedia('(display-mode: standalone)').matches;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  if (installed) return;
  deferredInstall = e as InstallPrompt;
  btnInstall.hidden = false;
});

btnInstall.addEventListener('click', async () => {
  if (!deferredInstall) return;
  await deferredInstall.prompt();
  const { outcome } = await deferredInstall.userChoice;
  deferredInstall = null;
  btnInstall.hidden = true;
  if (outcome === 'accepted') toast(t.installed);
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  btnInstall.hidden = true;
});

/* ── controls ──────────────────────────────────────────────── */
btnOpen.addEventListener('click', openViaPicker);
dropcard.addEventListener('click', openViaPicker);
dropcard.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    void openViaPicker();
  }
});

btnToc.addEventListener('click', () => {
  tocEnabled = !tocEnabled;
  localStorage.setItem('mdview:toc', tocEnabled ? 'on' : 'off');
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

/* The link navigates on its own; this only records the choice so a
   launched PWA lands in the right language next time. */
langLink.addEventListener('click', () => rememberLang(lang === 'ko' ? 'en' : 'ko'));

/* ── language hint ─────────────────────────────────────────────
   Redirecting people based on their browser locale is hostile — it
   hijacks a URL somebody deliberately opened, and it hides the other
   version from search crawlers. Offering the switch costs nothing
   and leaves the choice where it belongs. */
{
  const hint = document.getElementById('langhint');
  const close = document.getElementById('langhint-close');
  const HINT_KEY = 'mdview:langhint';

  const speaksKorean = (navigator.language ?? '').toLowerCase().startsWith('ko');
  const mismatched = lang === 'ko' ? !speaksKorean : speaksKorean;

  let settled = false;
  try {
    settled =
      localStorage.getItem(HINT_KEY) === 'off' || localStorage.getItem('mdview:lang') !== null;
  } catch {
    /* private mode — showing the hint once per visit is fine */
  }

  if (hint && mismatched && !settled) hint.hidden = false;

  close?.addEventListener('click', () => {
    if (hint) hint.hidden = true;
    try {
      localStorage.setItem(HINT_KEY, 'off');
    } catch {
      /* nothing to remember it with; it simply shows again */
    }
  });
}

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.isContentEditable || target instanceof HTMLInputElement) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    void openViaPicker();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  /* Through history.back() rather than closeDocument() directly, so
     Esc and the Back button are the same action in the same order. */
  if (e.key === 'Escape' && current) {
    history.back();
    return;
  }

  if (e.key.toLowerCase() === 't' && !btnToc.hidden) btnToc.click();
  if (e.key.toLowerCase() === 'd') btnTheme.click();
  if (e.key.toLowerCase() === 'c' && !btnCopy.hidden && !getSelection()?.toString()) {
    /* Only when nothing is selected — otherwise this would hijack a
       plain `c` typed during a normal text selection. */
    btnCopy.click();
  }
});

/* ── boot ──────────────────────────────────────────────────── */
applyTheme(localStorage.getItem('mdview:theme') === 'light' ? 'light' : 'dark');
void renderRecents();

/* A drop on a secondary page (/install/) lands here via
   sessionStorage — render it as though it had been dropped on us. */
const handoff = takeHandoff();
if (handoff) {
  void open({ name: handoff.name, text: handoff.text, size: handoff.text.length });
}

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');

      /* A deploy swaps the worker, but this page keeps running the
         assets it already loaded. Offer the reload rather than
         yanking the document out from under whoever is reading. */
      registration.addEventListener('updatefound', () => {
        const incoming = registration.installing;
        incoming?.addEventListener('statechange', () => {
          if (incoming.state !== 'installed' || !navigator.serviceWorker.controller) return;
          stickyToast(t.updateReady, t.reload, () => location.reload());
        });
      });
    } catch {
      /* offline support is a bonus, never a blocker */
    }
  });
}
