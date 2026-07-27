import './styles/theme.css';
import './styles/app.css';

import { lang, rememberLang } from './i18n.ts';
import { MAX_BYTES, isMarkdownName, stashHandoff } from './files.ts';

/* A deliberately small entry point. The reader's bundle assumes a
   document view, a table of contents and a file pipeline that none of
   this page has, so it stays out of here entirely. */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const btnTheme = $<HTMLButtonElement>('btn-theme');
const themeLabel = $('theme-label');
const langLink = $<HTMLAnchorElement>('lang-link');
const btnInstall = $<HTMLButtonElement>('btn-install');
const stateReady = $('state-ready');
const stateInstalled = $('state-installed');
const stateManual = $('state-manual');

function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
  if (themeLabel) themeLabel.textContent = theme.toUpperCase();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0b0b16' : '#fbfbfd');
  try {
    localStorage.setItem('mdview:theme', theme);
  } catch {
    /* private mode — the toggle still works for this visit */
  }
}

btnTheme?.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

langLink?.addEventListener('click', () => rememberLang(lang === 'ko' ? 'en' : 'ko'));

/* ── which of the three states is this visitor in? ─────────────── */
const runningAsApp =
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as unknown as { standalone?: boolean }).standalone === true;

/* `beforeinstallprompt` is a one-way signal: when it fires we can
   offer a real button, but its *absence* proves nothing. Chrome
   withholds it on pages it has not decided to promote yet — this very
   page, as it turns out — so treating silence as "unsupported" told
   Chrome users their browser could not do the one thing it can.
   The fallback is therefore worded as directions, never a verdict. */
type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferred: InstallPrompt | null = null;

function show(which: 'ready' | 'installed' | 'manual'): void {
  for (const [key, el] of [
    ['ready', stateReady],
    ['installed', stateInstalled],
    ['manual', stateManual],
  ] as const) {
    if (el) el.hidden = key !== which;
  }
}

if (runningAsApp) {
  show('installed');
} else {
  show('manual');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    show('ready');
  });

  /* A normal tab can still find out the app is installed — the
     manifest lists itself as a related webapp exactly so this query
     has something to match. Async and Chromium-only; the manual
     callout stays for everyone else. */
  void (async () => {
    const query = (
      navigator as unknown as {
        getInstalledRelatedApps?: () => Promise<unknown[]>;
      }
    ).getInstalledRelatedApps;
    try {
      const apps = (await query?.call(navigator)) ?? [];
      if (apps.length && !deferred) show('installed');
    } catch {
      /* unsupported — nothing changes */
    }
  })();
}

btnInstall?.addEventListener('click', async () => {
  if (!deferred) return;
  await deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  if (outcome === 'accepted') show('installed');
});

window.addEventListener('appinstalled', () => show('installed'));

/* ── drop handoff ──────────────────────────────────────────────
   The site's promise is "drop it anywhere", and without these the
   browser's default for a dropped file is to *navigate to it* —
   raw markdown replaces the guide. Catch the drop, stash the text,
   and let the reader on the home page render it. */
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});

window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files.length) return;
  /* Always prevented: even a rejected file must not blow the page
     away. */
  e.preventDefault();

  const file = Array.from(e.dataTransfer.files).find((f) => isMarkdownName(f.name));
  if (!file || file.size > MAX_BYTES) return;

  try {
    if (stashHandoff(file.name, await file.text())) {
      location.href = lang === 'en' ? '/en/' : '/';
    }
  } catch {
    /* unreadable file — staying on the guide is the right outcome */
  }
});

applyTheme(localStorage.getItem('mdview:theme') === 'light' ? 'light' : 'dark');

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is a bonus, never a blocker */
    });
  });
}
