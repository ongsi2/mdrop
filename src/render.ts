import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import DOMPurify, { type Config as PurifyConfig } from 'dompurify';

import { t } from './i18n.ts';

/* ── slugs ─────────────────────────────────────────────────────
   The default slugifier percent-encodes Korean into unreadable
   `%EA%B0%80` anchors. Keep Hangul as-is instead. */
export function slugify(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^\p{Script=Hangul}\p{L}\p{N}-]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '') || 'section'
  );
}

/* ── frontmatter ───────────────────────────────────────────────
   Deliberately not a YAML engine. Frontmatter here is a metadata
   card, and a full parser costs more bytes than the feature is
   worth. Flat scalars and simple lists cover what shows up. */
export function splitFrontmatter(src: string): {
  meta: Record<string, string> | null;
  body: string;
} {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  if (!m) return { meta: null, body: src };

  const unquote = (v: string) => v.replace(/^["']|["']$/g, '').trim();
  const meta: Record<string, string> = {};
  let key = '';

  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const item = /^\s*-\s+(.+)$/.exec(line);
    if (item && key) {
      const v = unquote(item[1]);
      meta[key] = meta[key] ? `${meta[key]}, ${v}` : v;
      continue;
    }

    const kv = /^([\w.\- ]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1].trim();
    meta[key] = unquote(kv[2]).replace(/^\[|\]$/g, '').trim();
  }

  return {
    meta: Object.keys(meta).length ? meta : null,
    body: src.slice(m[0].length),
  };
}

/* ── markdown-it ───────────────────────────────────────────── */
const md = new MarkdownIt({
  html: true,
  linkify: true,
  // A reader should show the line breaks the author actually typed.
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

/* markdown-it expresses table alignment as an inline style, which is
   the only reason the sanitizer would have to allow `style` through
   at all. Rewriting it to a class before sanitizing lets the attribute
   be banned outright. */
const ALIGN = /text-align:\s*(left|center|right)/;

for (const rule of ['th_open', 'td_open'] as const) {
  const fallback = md.renderer.rules[rule];
  md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const index = token.attrIndex('style');
    if (index >= 0 && token.attrs) {
      const match = ALIGN.exec(token.attrs[index][1]);
      token.attrs.splice(index, 1);
      if (match) token.attrJoin('class', `ta-${match[1]}`);
    }
    return fallback
      ? fallback(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };
}

/* External links open away from the reader and never hand over the
   opener reference. */
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof HTMLAnchorElement)) return;
  const href = node.getAttribute('href') ?? '';
  if (/^https?:\/\//i.test(href)) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/* A reader needs prose, tables and code — nothing that executes,
   navigates on its own, or repaints the surrounding app. SVG and
   MathML are refused outright: a viewer has no use for them, and
   they carry the awkward parser-differential surface. */
const PURIFY_CONFIG: PurifyConfig = {
  ADD_TAGS: ['details', 'summary'],
  ADD_ATTR: ['target', 'rel', 'open', 'loading', 'decoding'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: true,
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
    'svg',
    'math',
    'audio',
    'video',
    'source',
    'track',
  ],
  FORBID_ATTR: ['style', 'srcdoc', 'formaction', 'ping', 'srcset', 'background'],
};

export function renderMarkdown(src: string): {
  html: string;
  meta: Record<string, string> | null;
} {
  const { meta, body } = splitFrontmatter(src);
  const html = DOMPurify.sanitize(md.render(body), PURIFY_CONFIG) as unknown as string;
  return { html, meta };
}

export function renderFrontmatterCard(meta: Record<string, string>): string {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = Object.entries(meta)
    .slice(0, 12)
    .map(
      ([k, v]) =>
        `<div class="fm__row"><span class="fm__k">${esc(k)}</span><span class="fm__v">${esc(v)}</span></div>`,
    )
    .join('');
  return `<div class="fm">${rows}</div>`;
}

/* ── post-render passes ────────────────────────────────────────
   Everything below runs on the sanitized DOM rather than on the
   token stream: less coupling to markdown-it internals, and the
   markup it produces never re-enters the sanitizer. */

export function enhance(root: HTMLElement): void {
  applyTaskLists(root);
  wrapTables(root);
  decorateCodeBlocks(root);
  softenImages(root);
}

/* Whitespace-only nodes have to be skipped. A *loose* list — any
   list with blank lines between its items — renders as
   `<li>\n<p>…</p>\n</li>`, so the naive first text node is the
   newline and every task marker in it would be missed. */
function firstTextNode(el: Element): Text | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeValue?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
  });
  return walker.nextNode() as Text | null;
}

function applyTaskLists(root: HTMLElement): void {
  for (const li of Array.from(root.querySelectorAll('li'))) {
    const node = firstTextNode(li);
    if (!node?.nodeValue) continue;

    const m = /^\[([ xX])\]\s+/.exec(node.nodeValue);
    if (!m) continue;

    node.nodeValue = node.nodeValue.slice(m[0].length);

    const done = m[1].toLowerCase() === 'x';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = done;
    box.disabled = true;

    const span = document.createElement('span');
    while (li.firstChild) span.appendChild(li.firstChild);
    li.append(box, span);

    li.classList.add('task-item');
    if (done) li.classList.add('is-done');
    li.parentElement?.classList.add('task-list');
  }
}

function wrapTables(root: HTMLElement): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  }
}

function decorateCodeBlocks(root: HTMLElement): void {
  for (const code of Array.from(root.querySelectorAll('pre > code'))) {
    const pre = code.parentElement as HTMLPreElement;
    const lang = Array.from(code.classList)
      .find((c) => c.startsWith('language-'))
      ?.slice('language-'.length);
    if (lang) pre.dataset.lang = lang;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = t.copy;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent ?? '');
        btn.textContent = t.copied;
        btn.dataset.done = '1';
        setTimeout(() => {
          btn.textContent = t.copy;
          delete btn.dataset.done;
        }, 1400);
      } catch {
        btn.textContent = t.copyFailed;
      }
    });
    pre.appendChild(btn);
  }
}

function softenImages(root: HTMLElement): void {
  for (const img of Array.from(root.querySelectorAll('img'))) {
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', () => img.classList.add('is-missing'), { once: true });
  }
}

/* Highlighting is the single heaviest dependency, so it only loads
   once a document proves it has fenced code — and only for fences
   that declare a language. Auto-detection guesses wrong often
   enough on prose and config snippets to not be worth it. */
export async function highlight(root: HTMLElement): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]'));
  if (!blocks.length) return;

  const { default: hljs } = await import('highlight.js/lib/common');

  for (const el of blocks) {
    const lang = Array.from(el.classList)
      .find((c) => c.startsWith('language-'))!
      .slice('language-'.length);
    if (!hljs.getLanguage(lang)) continue;
    try {
      el.innerHTML = hljs.highlight(el.textContent ?? '', {
        language: lang,
        ignoreIllegals: true,
      }).value;
      el.classList.add('hljs');
    } catch {
      /* an unhighlighted block still reads fine */
    }
  }
}
