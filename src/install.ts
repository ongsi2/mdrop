import './styles/theme.css';
import './styles/app.css';

import { initAnalytics, trackInstallResult } from './analytics.ts';
import { lang, rememberLang } from './i18n.ts';
import {
  MAX_BYTES,
  TooComplexError,
  TooLargeError,
  isMarkdownName,
  readText,
  stashHandoff,
  validateSourceText,
} from './files.ts';
import { safeGet, safeSet } from './storage.ts';

/* A deliberately small entry point. The reader's bundle assumes a
   document view, a table of contents and a file pipeline that none of
   this page has, so it stays out of here entirely. */

initAnalytics();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const btnTheme = $<HTMLButtonElement>('btn-theme');
const themeLabel = $('theme-label');
const langLink = $<HTMLAnchorElement>('lang-link');
const btnInstall = $<HTMLButtonElement>('btn-install');
const stateReady = $('state-ready');
const stateInstalled = $('state-installed');
const stateManual = $('state-manual');
const guide = $('guide');

function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.dataset.theme = theme;
  if (themeLabel) themeLabel.textContent = theme.toUpperCase();
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#0b0b16' : '#fbfbfd');
  safeSet('mdview:theme', theme);
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
  const prompt = deferred;
  if (!prompt) {
    trackInstallResult('manual');
    return;
  }
  deferred = null;
  btnInstall.disabled = true;
  try {
    trackInstallResult('prompt');
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    trackInstallResult(outcome);
    show(outcome === 'accepted' ? 'installed' : 'manual');
  } catch {
    trackInstallResult('manual');
    show('manual');
  } finally {
    btnInstall.disabled = false;
  }
});

window.addEventListener('appinstalled', () => {
  deferred = null;
  trackInstallResult('installed');
  show('installed');
});

/* ── drop handoff ──────────────────────────────────────────────
   The site's promise is "drop it anywhere", and without these the
   browser's default for a dropped file is to *navigate to it* —
   raw markdown replaces the guide. Catch the drop, stash the text,
   and let the reader on the home page render it. */
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
});

let dropError: HTMLElement | null = null;
function showDropError(message: string): void {
  dropError?.remove();
  const box = document.createElement('div');
  box.className = 'callout callout--warn';
  box.setAttribute('role', 'alert');

  const title = document.createElement('p');
  title.className = 'callout__title';
  title.textContent = message;

  const action = document.createElement('a');
  action.className = 'btn btn--solid';
  action.href = lang === 'en' ? '/en/' : '/';
  action.textContent = lang === 'en' ? 'Open it from the reader' : '뷰어에서 파일 열기';

  box.append(title, action);
  guide?.querySelector('.steps')?.before(box);
  dropError = box;
  box.scrollIntoView({ block: 'center' });
}

window.addEventListener('drop', async (e) => {
  if (!e.dataTransfer?.files.length) return;
  /* Always prevented: even a rejected file must not blow the page
     away. */
  e.preventDefault();

  const file = Array.from(e.dataTransfer.files).find((f) => isMarkdownName(f.name));
  if (!file) {
    showDropError(
      lang === 'en'
        ? 'That is not a supported Markdown file.'
        : '지원하는 마크다운 파일이 아닙니다.',
    );
    return;
  }
  if (file.size > MAX_BYTES) {
    showDropError(
      lang === 'en' ? 'That file is larger than 4 MB.' : '파일이 4MB보다 큽니다.',
    );
    return;
  }

  try {
    const text = await readText(file);
    validateSourceText(text, file.size);
    if (stashHandoff(file.name, text, file.size)) {
      location.href = lang === 'en' ? '/en/' : '/';
    } else {
      showDropError(
        lang === 'en'
          ? 'This browser blocked the handoff. Open the file from the reader instead.'
          : '브라우저가 파일 전달을 막았습니다. 뷰어에서 직접 열어 주세요.',
      );
    }
  } catch (error) {
    if (error instanceof TooLargeError) {
      showDropError(lang === 'en' ? 'That file is larger than 4 MB.' : '파일이 4MB보다 큽니다.');
    } else if (error instanceof TooComplexError) {
      showDropError(
        lang === 'en'
          ? 'That document is too structurally complex to open safely.'
          : '문서 구조가 너무 복잡해 안전하게 열 수 없습니다.',
      );
    } else {
      showDropError(lang === 'en' ? 'Could not read that file.' : '파일을 읽지 못했습니다.');
    }
  }
});

applyTheme(safeGet('mdview:theme') === 'light' ? 'light' : 'dark');

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is a bonus, never a blocker */
    });
  });
}
