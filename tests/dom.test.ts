/* Browser-level checks that the pure-function suite cannot make: what the
   sanitizer actually leaves in a live DOM, that remote images never gain a
   source, how folder images and sibling links resolve, and keyboard focus.
   jsdom stands in for the browser; it is the environment DOMPurify is
   developed against. */

import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html lang="ko"><body></body></html>', {
  url: 'https://mdrop.app/',
});
const { window } = dom;
const globals = globalThis as Record<string, unknown>;
globals.window = window;
for (const key of [
  'document',
  'HTMLElement',
  'HTMLAnchorElement',
  'HTMLImageElement',
  'Element',
  'Node',
  'NodeFilter',
  'Text',
  'DocumentFragment',
  'DOMParser',
  'FocusEvent',
]) {
  globals[key] = (window as unknown as Record<string, unknown>)[key];
}

/* The modules read `document` at import time, so they load only now. */
const { renderMarkdown, enhance, APP_DOC_LINK } = await import('../src/render.ts');
const { resolveImages, resolveDocLink, fromDocLink } = await import('../src/files.ts');
const { MISSING_REASON } = await import('../src/missing-image.ts');
const { moveFocus } = await import('../src/focus.ts');

function render(markdown: string): HTMLElement {
  const root = window.document.createElement('article');
  root.innerHTML = renderMarkdown(markdown).html;
  enhance(root as unknown as HTMLElement);
  return root as unknown as HTMLElement;
}

function noteFor(image: Element): string {
  const note = image.nextElementSibling;
  return note?.classList.contains('img-missing__why') ? (note.textContent ?? '') : '';
}

/* ── sanitizer ─────────────────────────────────────────────── */

test('active content and inline styles never reach the live document', () => {
  const root = render(
    [
      '# Title',
      '',
      '<script>alert(1)</script>',
      '',
      '<iframe src="https://evil.test"></iframe><object data="x"></object><svg onload="alert(1)"></svg>',
      '',
      '<p onclick="alert(1)" style="color:red" tabindex="1" contenteditable>text</p>',
      '',
      '<a href="javascript:alert(1)">j</a> <form action="/x"><input autofocus></form>',
      '',
      '<base href="https://evil.test/"><link rel="stylesheet" href="x"><style>body{display:none}</style>',
    ].join('\n'),
  );
  const html = root.innerHTML;
  for (const tag of ['script', 'iframe', 'object', 'svg', 'form', 'input', 'base', 'link', 'style']) {
    assert.equal(root.querySelector(tag), null, `${tag} must be removed`);
  }
  assert.doesNotMatch(html, /on\w+=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.doesNotMatch(html, /style=/i);
  assert.equal(root.querySelector('p')?.hasAttribute('tabindex'), false);
  assert.equal(root.querySelector('p')?.hasAttribute('contenteditable'), false);
  assert.equal(root.querySelector('h1')?.textContent, '#Title');
});

test('table alignment survives as a class while every style attribute is banned', () => {
  const root = render('| a | b |\n| :-- | --: |\n| 1 | 2 |');
  assert.equal(root.querySelector('th.ta-left')?.textContent, 'a');
  assert.equal(root.querySelector('td.ta-right')?.textContent, '2');
  assert.equal(root.querySelector('[style]'), null);
});

test('source-supplied classes and ARIA are dropped, renderer classes kept', () => {
  const root = render(
    '<p class="anchor footnotes evil toc__item" aria-hidden="true" role="button">x</p>\n\nnote[^1]\n\n[^1]: f',
  );
  const p = root.querySelector('p')!;
  assert.equal(p.className, 'anchor footnotes');
  assert.equal(p.hasAttribute('aria-hidden'), false);
  assert.ok(root.querySelector('sup.footnote-ref > a'));
  assert.ok(root.querySelector('a.footnote-backref'));
});

/* ── images ────────────────────────────────────────────────── */

test('remote images never carry a source, and the reader is told why', () => {
  const root = render(
    [
      '![alt](https://cdn.example.com/a.png)',
      '',
      '<img src="https://cdn.example.com/b.png">',
      '',
      '<img src="//cdn.example.com/c.png" srcset="https://cdn.example.com/d.png 2x" sizes="100vw">',
      '',
      '<picture><source srcset="https://cdn.example.com/e.png"><img src="https://cdn.example.com/f.png"></picture>',
      '',
      '<img src="http://cdn.example.com/g.png" loading="eager" fetchpriority="high">',
    ].join('\n'),
  );
  const images = Array.from(root.querySelectorAll('img'));
  assert.ok(images.length >= 4);
  assert.equal(root.querySelector('img[src]'), null);
  assert.equal(root.querySelector('[srcset], [sizes], picture, source'), null);
  assert.doesNotMatch(root.innerHTML, /\ssrc="/);
  for (const image of images) {
    assert.equal(image.getAttribute(MISSING_REASON), 'remote');
    assert.ok(image.classList.contains('is-missing'));
    assert.match(noteFor(image), /외부 이미지/);
    assert.match(noteFor(image), /cdn\.example\.com/);
  }
});

test('a relative image without a folder explains that a folder would fix it', () => {
  const root = render('![chart](./img/chart.png)');
  const image = root.querySelector('img')!;
  assert.equal(image.hasAttribute('src'), false);
  assert.equal(image.getAttribute(MISSING_REASON), 'no-folder');
  assert.match(noteFor(image), /폴더/);
  assert.match(noteFor(image), /\.\/img\/chart\.png/);
});

test('embedded rasters are kept only when they are real, static and small', () => {
  const png = pngFile(2, 2, pngChunk('IDAT', []));
  const base64 = Buffer.from(png).toString('base64');
  const root = render(
    [
      `![ok](data:image/png;base64,${base64})`,
      '',
      /* markdown-it already refuses non-image data URLs in image syntax, so
         these arrive as raw HTML and must be caught by the sanitizer hook. */
      '<img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
      '',
      '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
      '',
      `![lying](data:image/jpeg;base64,${base64})`,
    ].join('\n'),
  );
  const [ok, html, svg, lying] = Array.from(root.querySelectorAll('img'));
  assert.equal(root.querySelectorAll('img').length, 4);
  assert.ok(ok.getAttribute('src')?.startsWith('data:image/png'));
  assert.equal(ok.getAttribute('data-md-inline-image'), '1');
  for (const rejected of [html, svg, lying]) {
    assert.equal(rejected.hasAttribute('src'), false);
    assert.equal(rejected.getAttribute(MISSING_REASON), 'unsupported');
  }
});

test('documents cannot forge the app-owned approval attributes', () => {
  const root = render(
    [
      '<img src="https://cdn.example.com/a.png" data-md-inline-image="1" data-md-local-image="1" data-md-raster-pixels="1" data-md-missing="budget">',
      '',
      '<a href="https://example.com" data-md-link="../../secret.md">web</a>',
      '',
      '<a href="#top" data-md-link="x.md">frag</a>',
    ].join('\n'),
  );
  const image = root.querySelector('img')!;
  assert.equal(image.hasAttribute('src'), false);
  assert.equal(image.hasAttribute('data-md-inline-image'), false);
  assert.equal(image.hasAttribute('data-md-local-image'), false);
  assert.equal(image.hasAttribute('data-md-raster-pixels'), false);
  assert.equal(image.getAttribute(MISSING_REASON), 'remote');

  const [web, frag] = Array.from(root.querySelectorAll('a'));
  assert.equal(web.hasAttribute(APP_DOC_LINK), false);
  assert.equal(web.getAttribute('target'), '_blank');
  assert.equal(web.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(frag.hasAttribute(APP_DOC_LINK), false);
});

/* ── links ─────────────────────────────────────────────────── */

test('relative markdown links are marked for folder lookup, others left alone', () => {
  const root = render(
    [
      '[guide](./guide.md) [up](../README.md) [deep](docs/설치.md#설치)',
      '',
      '[web](https://example.com) [mail](mailto:a@b.c) [frag](#top) [proto](//example.com/x.md)',
    ].join('\n'),
  );
  const links = Array.from(root.querySelectorAll('a'));
  const byText = Object.fromEntries(links.map((link) => [link.textContent, link]));

  assert.equal(byText.guide.getAttribute(APP_DOC_LINK), './guide.md');
  assert.equal(byText.up.getAttribute(APP_DOC_LINK), '../README.md');
  /* markdown-it percent-encodes link targets; resolveDocLink decodes them. */
  assert.equal(byText.deep.getAttribute(APP_DOC_LINK), 'docs/%EC%84%A4%EC%B9%98.md#%EC%84%A4%EC%B9%98');
  for (const name of ['guide', 'up', 'deep']) {
    assert.ok(byText[name].classList.contains('doclink'));
    assert.equal(byText[name].hasAttribute('target'), false);
    assert.ok(byText[name].title);
  }
  for (const name of ['web', 'mail', 'frag', 'proto']) {
    assert.equal(byText[name].hasAttribute(APP_DOC_LINK), false, name);
  }
  assert.equal(byText.web.getAttribute('target'), '_blank');
  assert.equal(byText.proto.getAttribute('rel'), 'noopener noreferrer');
});

test('wiki links become relative markdown links with readable labels', () => {
  const root = render(
    '[[Guide]] [[Guide|라벨]] [[Page#Some Heading]] [[#Only Heading]] [[notes.md]] `[[code]]` [[]] [[a\nb]]',
  );
  const links = Array.from(root.querySelectorAll('a'));
  assert.deepEqual(
    links.map((link) => [link.getAttribute('href'), link.textContent]),
    [
      ['Guide.md', 'Guide'],
      ['Guide.md', '라벨'],
      ['Page.md#some-heading', 'Page › Some Heading'],
      ['#only-heading', 'Only Heading'],
      ['notes.md', 'notes.md'],
    ],
  );
  assert.equal(links[0].getAttribute(APP_DOC_LINK), 'Guide.md');
  assert.equal(links[3].hasAttribute(APP_DOC_LINK), false);
  assert.equal(root.querySelector('code')?.textContent, '[[code]]');
  assert.match(root.textContent ?? '', /\[\[\]\]/);
});

test('wiki links inside fenced code and inline code are left verbatim', () => {
  const root = render('```\n[[Guide]]\n```\n\nand `[[Guide]]`');
  assert.equal(root.querySelector('a'), null);
});

/* ── callouts ──────────────────────────────────────────────── */

test('GitHub alerts become titled callouts, plain quotes stay plain', () => {
  const root = render(
    [
      '> [!NOTE]',
      '> body',
      '',
      '> [!tip]',
      '> lower',
      '',
      '> [!IMPORTANT]',
      '',
      '> [!WARNING]',
      '> a',
      '>',
      '> b',
      '',
      '> [!CAUTION]',
      '> c',
      '',
      '> [!BOGUS]',
      '> d',
      '',
      '> plain',
      '',
      '> [!NOTE] not alone on its line',
      '',
      '```md',
      '> [!NOTE]',
      '```',
    ].join('\n'),
  );
  const quotes = Array.from(root.querySelectorAll('blockquote'));
  assert.equal(quotes.length, 8);
  const kinds = quotes.map((quote) =>
    Array.from(quote.classList).find((name) => name.startsWith('alert--')) ?? null,
  );
  assert.deepEqual(kinds, [
    'alert--note',
    'alert--tip',
    'alert--important',
    'alert--warning',
    'alert--caution',
    null,
    null,
    null,
  ]);
  assert.equal(quotes[0].querySelector('.alert__title')?.textContent, '참고');
  assert.equal(quotes[0].textContent?.replace(/\s+/g, ' ').trim(), '참고 body');
  assert.equal(quotes[1].textContent?.replace(/\s+/g, ' ').trim(), '팁 lower');
  assert.match(quotes[7].textContent ?? '', /\[!NOTE\] not alone/);
  assert.equal(quotes[2].querySelectorAll('p').length, 1, 'marker-only quote keeps just the title');
  assert.equal(quotes[3].querySelectorAll('p').length, 3);
  assert.match(quotes[5].textContent ?? '', /\[!BOGUS\]/);
  assert.equal(root.querySelector('pre code')?.textContent, '> [!NOTE]\n');
  assert.equal(root.querySelector('pre .alert__title'), null);
});

/* ── folder images ─────────────────────────────────────────── */

type Tree = { [name: string]: Tree | Uint8Array };

function fakeDirectory(tree: Tree, log: string[]): FileSystemDirectoryHandle {
  const handle = {
    kind: 'directory',
    name: 'dir',
    async getDirectoryHandle(name: string) {
      log.push(`dir:${name}`);
      const entry = tree[name];
      if (!entry || entry instanceof Uint8Array) throw new Error('NotFoundError');
      return fakeDirectory(entry, log);
    },
    async getFileHandle(name: string) {
      log.push(`file:${name}`);
      const entry = tree[name];
      if (!(entry instanceof Uint8Array)) throw new Error('NotFoundError');
      return {
        kind: 'file',
        name,
        async getFile() {
          return new File([entry], name);
        },
      };
    },
  };
  return handle as unknown as FileSystemDirectoryHandle;
}

test('folder images resolve to local blobs and every failure names its reason', async () => {
  const log: string[] = [];
  const dir = fakeDirectory(
    {
      img: {
        'ok.png': pngFile(4, 4, pngChunk('IDAT', [])),
        'huge.png': pngFile(9_000, 9_000, pngChunk('IDAT', [])),
        'fake.png': new TextEncoder().encode('not really a png'),
        'secret.txt': new TextEncoder().encode('private'),
      },
    },
    log,
  );
  const root = render(
    [
      '![ok](img/ok.png)',
      '![missing](img/nope.png)',
      '![huge](img/huge.png)',
      '![fake](img/fake.png)',
      '![traversal](../img/ok.png)',
      '![absolute](/img/ok.png)',
      '![text](img/secret.txt)',
      '![svg](img/logo.svg)',
    ].join('\n'),
  );

  const urls = await resolveImages(root, dir);
  const [ok, missing, huge, fake, traversal, absolute, text, svg] = Array.from(
    root.querySelectorAll('img'),
  );

  assert.equal(urls.length, 1);
  assert.ok(ok.getAttribute('src')?.startsWith('blob:'));
  assert.equal(ok.classList.contains('is-missing'), false);
  assert.equal(noteFor(ok), '');
  assert.equal(ok.getAttribute('width'), '4');

  assert.equal(missing.getAttribute(MISSING_REASON), 'not-found');
  assert.match(noteFor(missing), /img\/nope\.png/);
  assert.equal(huge.getAttribute(MISSING_REASON), 'budget');
  assert.equal(fake.getAttribute(MISSING_REASON), 'unsupported');
  for (const refused of [traversal, absolute, text, svg]) {
    assert.equal(refused.getAttribute(MISSING_REASON), 'unsupported');
    assert.equal(refused.hasAttribute('src'), false);
  }

  /* Unsafe paths are refused before any handle is touched. */
  assert.equal(log.includes('dir:..'), false);
  assert.equal(log.includes('file:secret.txt'), false);
  assert.equal(log.includes('file:logo.svg'), false);
  for (const url of urls) URL.revokeObjectURL(url);
});

test('a superseded render marks nothing', async () => {
  const log: string[] = [];
  const dir = fakeDirectory({ 'a.png': pngFile(1, 1, pngChunk('IDAT', [])) }, log);
  const root = render('![a](a.png)');
  const image = root.querySelector('img')!;
  const before = noteFor(image);
  const urls = await resolveImages(root, dir, () => false);
  assert.equal(urls.length, 0);
  assert.equal(image.hasAttribute('src'), false);
  assert.equal(noteFor(image), before);
});

/* ── sibling documents ─────────────────────────────────────── */

test('document links normalize inside the dropped folder and never above it', () => {
  assert.deepEqual(resolveDocLink([], './guide.md'), { segments: ['guide.md'], fragment: '' });
  assert.deepEqual(resolveDocLink(['docs'], '../README.md#intro'), {
    segments: ['README.md'],
    fragment: 'intro',
  });
  assert.deepEqual(resolveDocLink(['a', 'b'], 'c/../d.md?x=1#%EC%84%A4%EC%B9%98'), {
    segments: ['a', 'b', 'd.md'],
    fragment: '설치',
  });
  assert.deepEqual(resolveDocLink([], 'docs\\%EC%84%A4%EC%B9%98.md'), {
    segments: ['docs', '설치.md'],
    fragment: '',
  });
  assert.equal(resolveDocLink(['docs'], '../../outside.md'), null);
  assert.equal(resolveDocLink([], '/abs.md'), null);
  assert.equal(resolveDocLink([], '#only'), null);
  assert.equal(resolveDocLink([], '%zz.md'), null);
  assert.equal(resolveDocLink([], 'a\0b.md'), null);
});

test('a linked document opens with its own folder location', async () => {
  const log: string[] = [];
  const root = fakeDirectory(
    {
      'README.md': new TextEncoder().encode('# root'),
      docs: { 'guide.md': new TextEncoder().encode('# guide'), 'notes.txt': new Uint8Array() },
    },
    log,
  );
  const source = await fromDocLink(root, resolveDocLink([], 'docs/guide.md')!);
  assert.equal(source.name, 'guide.md');
  assert.equal(source.text, '# guide');
  assert.deepEqual(source.dirPath, ['docs']);
  assert.equal(source.root, root);
  assert.ok(source.dir);
  assert.ok(source.file);

  await assert.rejects(fromDocLink(root, resolveDocLink([], 'docs/missing.md')!));
  await assert.rejects(fromDocLink(root, resolveDocLink([], 'docs/notes.txt')!), /not markdown/);
});

/* ── keyboard focus ────────────────────────────────────────── */

test('in-document navigation focuses the target without widening tab order', () => {
  const root = render('# Heading\n\ntext[^1]\n\n[^1]: footnote');
  window.document.body.appendChild(root);
  const item = root.querySelector<HTMLElement>('li.footnote-item')!;
  assert.equal(item.hasAttribute('tabindex'), false);

  moveFocus(item);
  assert.equal(window.document.activeElement, item);
  assert.equal(item.getAttribute('tabindex'), '-1');

  item.blur();
  assert.equal(item.hasAttribute('tabindex'), false);

  const heading = root.querySelector<HTMLElement>('h1')!;
  moveFocus(heading);
  assert.equal(window.document.activeElement, heading);
  root.remove();
});

/* ── raster helpers ────────────────────────────────────────── */

function bytes(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function pngChunk(type: string, payload: Uint8Array | number[]): Uint8Array {
  return bytes(u32be(payload.length), new TextEncoder().encode(type), payload, [0, 0, 0, 0]);
}

function pngFile(width: number, height: number, ...chunks: Uint8Array[]): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', bytes(u32be(width), u32be(height), [8, 6, 0, 0, 0])),
    ...chunks,
    pngChunk('IEND', []),
  );
}
