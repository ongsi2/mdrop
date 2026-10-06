import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import DOMPurify, { type Config as PurifyConfig } from 'dompurify';

import { splitFrontmatter } from './frontmatter.ts';
import { isMarkdownName } from './files.ts';
import { markMissing, MISSING_REASON, type MissingReason } from './missing-image.ts';
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

/* `[[Target]]`, `[[Target|Label]]` and `[[Target#Heading]]` link to a sibling
   document the way Obsidian and most wikis do. They become ordinary relative
   links, so the same folder lookup that serves `./guide.md` serves them. */
const WIKI_LINK_MAX = 512;

md.inline.ruler.before('link', 'wikilink', (state, silent) => {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
  const end = src.indexOf(']]', start + 2);
  if (end < 0 || end + 2 > state.posMax || end - start > WIKI_LINK_MAX) return false;

  const inner = src.slice(start + 2, end);
  if (!inner.trim() || /[\n[\]]/.test(inner)) return false;
  const pipe = inner.indexOf('|');
  const targetPart = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  const hashAt = targetPart.indexOf('#');
  const page = (hashAt >= 0 ? targetPart.slice(0, hashAt) : targetPart).trim();
  const heading = hashAt >= 0 ? targetPart.slice(hashAt + 1).trim() : '';
  if (!page && !heading) return false;
  const label =
    (pipe >= 0 ? inner.slice(pipe + 1).trim() : '') ||
    (page && heading ? `${page} › ${heading}` : page || heading);

  if (!silent) {
    let href = page ? (isMarkdownName(page) ? page : `${page}.md`) : '';
    if (heading) href += `#${encodeURIComponent(slugify(heading))}`;
    const open = state.push('link_open', 'a', 1);
    open.attrs = [
      ['href', href],
      ['class', 'wikilink'],
    ];
    const text = state.push('text', '', 0);
    text.content = label;
    state.push('link_close', 'a', -1);
  }
  state.pos = end + 2;
  return true;
});

/* GitHub-style alerts: a blockquote whose first line is `[!NOTE]`, `[!TIP]`,
   `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` becomes a titled callout. */
const CALLOUT = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\n|$)/i;
type CalloutKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

md.core.ruler.after('block', 'callout', (state) => {
  const tokens = state.tokens;
  for (let index = 0; index + 2 < tokens.length; index += 1) {
    if (tokens[index].type !== 'blockquote_open') continue;
    if (tokens[index + 1].type !== 'paragraph_open' || tokens[index + 2].type !== 'inline') continue;
    const inline = tokens[index + 2];
    const match = CALLOUT.exec(inline.content);
    if (!match) continue;

    const kind = match[1].toLowerCase() as CalloutKind;
    tokens[index].attrJoin('class', `alert alert--${kind}`);

    const titleOpen = new state.Token('paragraph_open', 'p', 1);
    titleOpen.attrSet('class', 'alert__title');
    titleOpen.block = true;
    const titleInline = new state.Token('inline', '', 0);
    titleInline.block = true;
    titleInline.content = '';
    const titleText = new state.Token('text', '', 0);
    titleText.content = a11y.callout[kind];
    titleInline.children = [titleText];
    const titleClose = new state.Token('paragraph_close', 'p', -1);
    titleClose.block = true;

    const rest = inline.content.slice(match[0].length);
    if (rest.trim()) {
      inline.content = rest;
      tokens.splice(index + 1, 0, titleOpen, titleInline, titleClose);
    } else {
      /* The marker was the whole first paragraph: the title replaces it. */
      tokens.splice(index + 1, 3, titleOpen, titleInline, titleClose);
    }
    index += 3;
  }
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
/** A relative link to another document; main.ts resolves it in the opened folder. */
export const APP_DOC_LINK = 'data-md-link';
export const APPROVED_INLINE_IMAGE = 'data-md-inline-image';
export const APPROVED_LOCAL_IMAGE = 'data-md-local-image';

export function isSafeRasterDataUrl(value: string): boolean {
  return inspectSafeRasterDataUrl(value) !== null;
}

let remainingRasterPixels = 0;

const SAFE_RENDERER_CLASS =
  /^(?:anchor|footnotes(?:-sep)?|footnote-(?:item|ref|backref)|ta-(?:left|center|right)|language-[a-z0-9_+.-]{1,64}|wikilink|alert|alert--(?:note|tip|important|warning|caution)|alert__title)$/i;

/** Anything that is not a fragment, not protocol-relative and has no scheme. */
function isRelativePath(value: string): boolean {
  return (
    value !== '' &&
    !value.startsWith('#') &&
    !value.startsWith('//') &&
    !/^[a-z][a-z0-9+.-]*:/i.test(value)
  );
}

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
    node.removeAttribute(APP_DOC_LINK);
    if (isAbsoluteWebUrl(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    } else if (isRelativePath(href)) {
      node.setAttribute(APP_DOC_LINK, href);
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
  node.removeAttribute(MISSING_REASON);

  const raw = node.getAttribute('src')?.trim() ?? '';
  if (!raw) {
    node.removeAttribute('src');
    node.setAttribute(MISSING_REASON, 'unsupported');
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
      node.setAttribute(MISSING_REASON, 'budget');
    }
    return;
  }

  node.removeAttribute('src');
  if (raw.length > 4096 || /^blob:/i.test(raw) || /^data:/i.test(raw)) {
    node.setAttribute(MISSING_REASON, 'unsupported');
    return;
  }

  if (isAbsoluteWebUrl(raw)) {
    node.setAttribute(APP_REMOTE_IMAGE_SOURCE, raw);
    node.setAttribute(MISSING_REASON, 'remote');
  } else if (isRelativePath(raw)) {
    /* The reason is decided later: `no-folder` unless a folder resolves it. */
    node.setAttribute(APP_IMAGE_SOURCE, raw);
  } else {
    node.setAttribute(MISSING_REASON, 'unsupported');
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
    APP_DOC_LINK,
    APPROVED_INLINE_IMAGE,
    APPROVED_LOCAL_IMAGE,
    RASTER_PIXELS_ATTRIBUTE,
    MISSING_REASON,
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
      docLink: 'Opens this document from the folder',
      callout: {
        note: 'Note',
        tip: 'Tip',
        important: 'Important',
        warning: 'Warning',
        caution: 'Caution',
      },
    }
  : {
      permalink: (heading: string) => `${heading} 섹션 링크`,
      taskDone: (label: string) => `완료한 작업: ${label}`,
      taskOpen: (label: string) => `미완료 작업: ${label}`,
      table: '스크롤 가능한 표',
      docLink: '폴더 안의 이 문서를 엽니다',
      callout: {
        note: '참고',
        tip: '팁',
        important: '중요',
        warning: '주의',
        caution: '경고',
      },
    };

/** Add reader controls only after sanitization; none of this markup is user-owned. */
export function enhance(root: HTMLElement): void {
  labelPermalinks(root);
  labelDocLinks(root);
  applyTaskLists(root);
  wrapTables(root);
  decorateCodeBlocks(root);
  softenImages(root);
}

function labelDocLinks(root: HTMLElement): void {
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>(`a[${APP_DOC_LINK}]`))) {
    link.classList.add('doclink');
    link.title = a11y.docLink;
  }
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

function hostOf(url: string): string {
  try {
    return new URL(url, document.baseURI).host;
  } catch {
    return '';
  }
}

function softenImages(root: HTMLElement): void {
  for (const image of Array.from(root.querySelectorAll('img'))) {
    image.decoding = 'async';
    if (!image.hasAttribute('src')) {
      const decided = image.getAttribute(MISSING_REASON) as MissingReason | null;
      const relative = image.getAttribute(APP_IMAGE_SOURCE);
      const remote = image.getAttribute(APP_REMOTE_IMAGE_SOURCE);
      if (decided) {
        markMissing(image, decided, remote ? hostOf(remote) : '');
      } else {
        /* resolveImages() revisits this when the document came with a folder. */
        markMissing(image, relative ? 'no-folder' : 'unsupported', relative?.slice(0, 120) ?? '');
      }
    }
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
          markMissing(image, 'budget');
        }
      },
      { once: true },
    );
    image.addEventListener(
      'error',
      () => {
        image.removeAttribute(APPROVED_INLINE_IMAGE);
        image.removeAttribute(APPROVED_LOCAL_IMAGE);
        markMissing(image, 'decode');
      },
      { once: true },
    );
  }
  prioritizeImages(root);
}

/** The first image with a source loads eagerly, the rest lazily. Called again
    after folder images resolve, since that changes which image is first. */
export function prioritizeImages(root: HTMLElement): void {
  let first = true;
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>('img'))) {
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
