import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import DOMPurify, { type Config as PurifyConfig } from 'dompurify';

import { splitFrontmatter } from './frontmatter.ts';
import {
  inspectSafeRasterDataUrl,
  MAX_DOCUMENT_RASTER_PIXELS,
  MAX_RASTER_DIMENSION,
  MAX_RASTER_PIXELS,
  RASTER_PIXELS_ATTRIBUTE,
  reserveRasterPixels,
} from './image-policy.ts';
import { t } from './i18n.ts';

export { splitFrontmatter } from './frontmatter.ts';

/** Keep Hangul and other letters readable instead of percent-encoding them. */
export function slugify(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^\p{Script=Hangul}\p{L}\p{N}-]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  typographer: false,
});

md.use(footnote);
md.use(anchor, {
  level: [1, 2, 3, 4],
  slugify,
  permalink: anchor.permalink.linkInsideHeader({
    symbol: '#',
    class: 'anchor',
    placement: 'before',
    space: false,
  }),
});

/* markdown-it expresses table alignment as an inline style. Convert the only
   useful style to a tightly-scoped class so all style attributes can be banned. */
const ALIGN = /text-align:\s*(left|center|right)/;

for (const rule of ['th_open', 'td_open'] as const) {
  const fallback = md.renderer.rules[rule];
  md.renderer.rules[rule] = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const styleIndex = token.attrIndex('style');
    if (styleIndex >= 0 && token.attrs) {
      const match = ALIGN.exec(token.attrs[styleIndex][1]);
      token.attrs.splice(styleIndex, 1);
      if (match) token.attrJoin('class', `ta-${match[1]}`);
    }
    return fallback
      ? fallback(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options);
  };
}

const APP_IMAGE_SOURCE = 'data-md-src';
const APP_REMOTE_IMAGE_SOURCE = 'data-md-remote-src';
export const APPROVED_INLINE_IMAGE = 'data-md-inline-image';
export const APPROVED_LOCAL_IMAGE = 'data-md-local-image';

export function isSafeRasterDataUrl(value: string): boolean {
  return inspectSafeRasterDataUrl(value) !== null;
}

let remainingRasterPixels = 0;

const SAFE_RENDERER_CLASS = /^(?:anchor|footnotes(?:-sep)?|footnote-(?:item|ref|backref)|ta-(?:left|center|right)|language-[a-z0-9_+.-]{1,64})$/i;

function isAbsoluteWebUrl(value: string): boolean {
  if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return false;
  try {
    const parsed = new URL(value, document.baseURI);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * DOMPurify hooks run while the rendered HTML is still an inert string.
 * Relative and remote image URLs are removed before anything can enter the
 * live document, then kept only in app-owned data attributes for local lookup.
 */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof HTMLElement)) return;

  const classes = Array.from(node.classList).filter((name) => SAFE_RENDERER_CLASS.test(name));
  node.removeAttribute('class');
  if (classes.length) node.className = classes.join(' ');

  if (node instanceof HTMLAnchorElement) {
    const href = node.getAttribute('href')?.trim() ?? '';
    node.removeAttribute('target');
    node.removeAttribute('rel');
    if (isAbsoluteWebUrl(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    return;
  }

  if (!(node instanceof HTMLImageElement)) return;

  /* These attributes are allowlisted solely so values created in this hook
     survive serialization. Never trust values supplied by the document. */
  node.removeAttribute(APP_IMAGE_SOURCE);
  node.removeAttribute(APP_REMOTE_IMAGE_SOURCE);
  node.removeAttribute(APPROVED_INLINE_IMAGE);
  node.removeAttribute(APPROVED_LOCAL_IMAGE);
  node.removeAttribute(RASTER_PIXELS_ATTRIBUTE);

  const raw = node.getAttribute('src')?.trim() ?? '';
  if (!raw) {
    node.removeAttribute('src');
    return;
  }

  const inline = inspectSafeRasterDataUrl(raw);
  if (inline) {
    const pixels = inline.width * inline.height;
    const remaining = reserveRasterPixels(remainingRasterPixels, pixels);
    if (remaining !== null) {
      remainingRasterPixels = remaining;
      node.setAttribute(APPROVED_INLINE_IMAGE, '1');
      node.setAttribute(RASTER_PIXELS_ATTRIBUTE, String(pixels));
    } else {
      node.removeAttribute('src');
    }
    return;
  }

  node.removeAttribute('src');
  if (raw.length > 4096 || /^blob:/i.test(raw) || /^data:/i.test(raw)) return;

  if (isAbsoluteWebUrl(raw)) {
    node.setAttribute(APP_REMOTE_IMAGE_SOURCE, raw);
  } else if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    node.setAttribute(APP_IMAGE_SOURCE, raw);
  }
});

const PURIFY_CONFIG: PurifyConfig = {
  ADD_TAGS: ['details', 'summary'],
  ADD_ATTR: [
    'target',
    'rel',
    'open',
    'loading',
    'decoding',
    APP_IMAGE_SOURCE,
    APP_REMOTE_IMAGE_SOURCE,
    APPROVED_INLINE_IMAGE,
    APPROVED_LOCAL_IMAGE,
    RASTER_PIXELS_ATTRIBUTE,
  ],
  ALLOW_DATA_ATTR: false,
  /* Source-owned ARIA can create large retained attribute sets and can lie to
     assistive technology. App-generated labels are added after sanitization. */
  ALLOW_ARIA_ATTR: false,
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    'style',
    'script',
    'iframe',
    'object',
    'embed',
    'base',
    'link',
    'meta',
    'form',
    'input',
    'button',
    'textarea',
    'select',
    'option',
    'svg',
    'math',
    'audio',
    'video',
    'source',
    'track',
    'picture',
    'marquee',
    'blink',
    'canvas',
    'dialog',
    'progress',
    'template',
  ],
  FORBID_ATTR: [
    'style',
    'srcdoc',
    'formaction',
    'ping',
    'srcset',
    'sizes',
    'poster',
    'background',
    'longdesc',
    'autofocus',
    'contenteditable',
    'tabindex',
    'accesskey',
  ],
};

export function renderMarkdown(src: string): {
  html: string;
  meta: Record<string, string> | null;
} {
  const { meta, body } = splitFrontmatter(src);
  remainingRasterPixels = MAX_DOCUMENT_RASTER_PIXELS;
  try {
    const html = DOMPurify.sanitize(md.render(body), PURIFY_CONFIG) as unknown as string;
    return { html, meta };
  } finally {
    remainingRasterPixels = 0;
  }
}

export function renderFrontmatterCard(meta: Record<string, string>): string {
  const escape = (value: string) =>
    value.replace(
      /[&<>"]/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!,
    );
  const rows = Object.entries(meta)
    .slice(0, 12)
    .map(
      ([key, value]) =>
        `<div class="fm__row"><span class="fm__k">${escape(key)}</span><span class="fm__v">${escape(value)}</span></div>`,
    )
    .join('');
  return `<div class="fm">${rows}</div>`;
}

const a11y = document.documentElement.lang.startsWith('en')
  ? {
      permalink: (heading: string) => `Link to ${heading}`,
      taskDone: (label: string) => `Completed task: ${label}`,
      taskOpen: (label: string) => `Incomplete task: ${label}`,
      table: 'Scrollable table',
    }
  : {
      permalink: (heading: string) => `${heading} 섹션 링크`,
      taskDone: (label: string) => `완료한 작업: ${label}`,
      taskOpen: (label: string) => `미완료 작업: ${label}`,
      table: '스크롤 가능한 표',
    };

/** Add reader controls only after sanitization; none of this markup is user-owned. */
export function enhance(root: HTMLElement): void {
  labelPermalinks(root);
  applyTaskLists(root);
  wrapTables(root);
  decorateCodeBlocks(root);
  softenImages(root);
}

function labelPermalinks(root: HTMLElement): void {
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('h1 > .anchor, h2 > .anchor, h3 > .anchor, h4 > .anchor'))) {
    const heading = link.parentElement?.textContent?.replace(/^#/, '').trim() || 'section';
    const label = a11y.permalink(heading);
    link.setAttribute('aria-label', label);
    link.title = label;
  }
}

function firstTextNode(element: Element): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  return walker.nextNode() as Text | null;
}

function applyTaskLists(root: HTMLElement): void {
  for (const item of Array.from(root.querySelectorAll('li'))) {
    const node = firstTextNode(item);
    if (!node?.nodeValue) continue;

    const marker = /^\[([ xX])\]\s+/.exec(node.nodeValue);
    if (!marker) continue;
    node.nodeValue = node.nodeValue.slice(marker[0].length);

    const done = marker[1].toLowerCase() === 'x';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = done;
    box.disabled = true;

    const content = document.createElement('span');
    while (item.firstChild) content.appendChild(item.firstChild);
    const label = content.textContent?.trim() || (done ? 'done' : 'task');
    box.setAttribute('aria-label', done ? a11y.taskDone(label) : a11y.taskOpen(label));
    item.append(box, content);

    item.classList.add('task-item');
    if (done) item.classList.add('is-done');
    item.parentElement?.classList.add('task-list');
  }
}

function wrapTables(root: HTMLElement): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', table.querySelector('caption')?.textContent?.trim() || a11y.table);
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
}

function decorateCodeBlocks(root: HTMLElement): void {
  for (const code of Array.from(root.querySelectorAll('pre > code')).slice(0, 1_000)) {
    const pre = code.parentElement as HTMLPreElement;
    const language = Array.from(code.classList)
      .find((name) => name.startsWith('language-'))
      ?.slice('language-'.length);
    if (language) pre.dataset.lang = language;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-btn';
    button.textContent = t.copy;
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent ?? '');
        button.textContent = t.copied;
        button.dataset.done = '1';
        setTimeout(() => {
          button.textContent = t.copy;
          delete button.dataset.done;
        }, 1400);
      } catch {
        button.textContent = t.copyFailed;
      }
    });
    pre.appendChild(button);
  }
}

function softenImages(root: HTMLElement): void {
  let first = true;
  for (const image of Array.from(root.querySelectorAll('img'))) {
    image.decoding = 'async';
    if (image.hasAttribute('src') && first) {
      image.loading = 'eager';
      image.fetchPriority = 'high';
      first = false;
    } else {
      image.loading = 'lazy';
    }
    if (!image.hasAttribute('src')) image.classList.add('is-missing');
    image.addEventListener(
      'load',
      () => {
        if (
          image.naturalWidth > MAX_RASTER_DIMENSION ||
          image.naturalHeight > MAX_RASTER_DIMENSION ||
          image.naturalWidth * image.naturalHeight > MAX_RASTER_PIXELS
        ) {
          image.removeAttribute(APPROVED_INLINE_IMAGE);
          image.removeAttribute(APPROVED_LOCAL_IMAGE);
          image.removeAttribute('src');
          image.classList.add('is-missing');
        }
      },
      { once: true },
    );
    image.addEventListener(
      'error',
      () => {
        image.removeAttribute(APPROVED_INLINE_IMAGE);
        image.removeAttribute(APPROVED_LOCAL_IMAGE);
        image.removeAttribute('src');
        image.classList.add('is-missing');
      },
      { once: true },
    );
  }
}

/** Load syntax highlighting only for fenced blocks that name a known language. */
export async function highlight(root: HTMLElement): Promise<void> {
  const maxBlockCharacters = 100_000;
  let remainingCharacters = 250_000;
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]'),
  )
    .slice(0, 1_000)
    .filter((element) => {
      const length = element.textContent?.length ?? 0;
      if (length > maxBlockCharacters || length > remainingCharacters) return false;
      remainingCharacters -= length;
      return true;
    });
  if (!blocks.length) return;

  const { default: hljs } = await import('highlight.js/lib/common');
  for (const element of blocks) {
    const language = Array.from(element.classList)
      .find((name) => name.startsWith('language-'))!
      .slice('language-'.length);
    if (!hljs.getLanguage(language)) continue;
    try {
      element.innerHTML = hljs.highlight(element.textContent ?? '', {
        language,
        ignoreIllegals: true,
      }).value;
      element.classList.add('hljs');
    } catch {
      /* An unhighlighted block remains fully readable. */
    }
  }
}
