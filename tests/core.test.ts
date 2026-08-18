import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_BYTES,
  MAX_DOCUMENT_IMAGES,
  MAX_HEADINGS,
  MAX_INLINE_MARKERS,
  MAX_LINES,
  MAX_RAW_HTML_ATTRIBUTES,
  TooComplexError,
  TooLargeError,
  readText,
  validateSourceText,
  watch,
  type Source,
} from '../src/files.ts';
import { splitFrontmatter } from '../src/frontmatter.ts';
import {
  inspectSafeRaster,
  inspectSafeRasterDataUrl,
  MAX_DOCUMENT_RASTER_PIXELS,
  reserveRasterPixels,
} from '../src/image-policy.ts';
import { validateMarkdownStructure } from '../src/markdown-budget.ts';
import { inspectRaster, sniffRasterMime } from '../src/raster.ts';

test('delimiter-looking prose is not stripped as frontmatter', () => {
  const source = '---\nthis is prose\n---\n# Kept';
  const result = splitFrontmatter(source);
  assert.equal(result.meta, null);
  assert.equal(result.body, source);
});

test('frontmatter accepts Unicode keys and keeps dangerous keys inert', () => {
  const source = '---\n제목: 문서\n__proto__: harmless\ntags:\n  - one\n  - two\n---\nBody';
  const result = splitFrontmatter(source);
  assert.equal(result.meta?.제목, '문서');
  assert.equal(result.meta?.tags, 'one, two');
  assert.equal(result.meta?.['__proto__'], 'harmless');
  assert.equal(Object.getPrototypeOf(result.meta), null);
  assert.equal(result.body, 'Body');
});

test('readText decodes UTF-16 LE and BE byte-order marks', async () => {
  const le = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x00, 0xac]);
  const be = new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0xac, 0x00]);
  assert.equal(await readText(new Blob([le])), 'A가');
  assert.equal(await readText(new Blob([be])), 'A가');
});

test('source validation uses UTF-8 bytes, including pasted text', () => {
  assert.throws(() => validateSourceText('가'.repeat(Math.ceil(MAX_BYTES / 3) + 1)), TooLargeError);
});

test('file byte size remains authoritative for BOM-marked UTF-16 text', () => {
  const text = `${'가'.repeat(99)}\n`.repeat(17_000);
  const utf16Bytes = 2 + text.length * 2;
  assert.ok(new Blob([text]).size > MAX_BYTES);
  assert.ok(utf16Bytes < MAX_BYTES);
  assert.doesNotThrow(() => validateSourceText(text, utf16Bytes));
});

test('source validation counts LF, CRLF and CR line endings', () => {
  for (const newline of ['\n', '\r\n', '\r']) {
    assert.throws(
      () => validateSourceText(`x${newline}`.repeat(MAX_LINES)),
      (error) => error instanceof TooComplexError && error.reason === 'lines',
    );
  }
});

test('structure validation bounds DOM-amplifying constructs', () => {
  const cases: Array<[string, string]> = [
    ['## h\n'.repeat(MAX_HEADINGS + 1), 'headings'],
    ['title\n---\n'.repeat(MAX_HEADINGS + 1), 'headings'],
    ['![](a.png)\n'.repeat(MAX_DOCUMENT_IMAGES + 1), 'images'],
    [`${'![chart][asset]\n'.repeat(MAX_DOCUMENT_IMAGES + 1)}\n[asset]: chart.png`, 'images'],
  ];

  for (const [source, reason] of cases) {
    assert.throws(
      () => validateMarkdownStructure(source),
      (error) => error instanceof TooComplexError && error.reason === reason,
    );
  }
});

test('normal markdown remains below the safety budgets', () => {
  assert.doesNotThrow(() =>
    validateMarkdownStructure('# 제목\n\n본문입니다.\n\n- [ ] task\n\n![chart](img/chart.png)'),
  );
});

test('complexity examples inside fenced code stay readable', () => {
  const example = `\`\`\`markdown\n${'![example][asset]\n'.repeat(MAX_DOCUMENT_IMAGES + 1)}${'## example\n'.repeat(MAX_HEADINGS + 1)}\`\`\``;
  assert.doesNotThrow(() => validateMarkdownStructure(example));
});

test('an invalid backtick-info pseudo-fence cannot hide dense markup', () => {
  const source = `\`\`\` \`bad\n${'*x* '.repeat(Math.floor(MAX_INLINE_MARKERS / 2) + 1)}`;
  assert.throws(
    () => validateMarkdownStructure(source),
    (error) => error instanceof TooComplexError && error.reason === 'inline-markers',
  );
});

test('dense inline markup is rejected before it can amplify into a huge DOM', () => {
  const source = '*x* '.repeat(Math.floor(MAX_INLINE_MARKERS / 2) + 1);
  assert.throws(
    () => validateMarkdownStructure(source),
    (error) => error instanceof TooComplexError && error.reason === 'inline-markers',
  );
});

test('inline rule terminators share the expansion budget', () => {
  const sources = ['\\', '!', '#', '$', '%', '&', ':', '=', '^', '{', '}'].map((marker) =>
    `${marker}x `.repeat(MAX_INLINE_MARKERS + 1),
  );

  for (const source of sources) {
    assert.throws(
      () => validateMarkdownStructure(source),
      (error) => error instanceof TooComplexError && error.reason === 'inline-markers',
    );
  }
});

test('dense linkified URLs share the inline expansion budget', () => {
  const source = 'http://a '.repeat(MAX_INLINE_MARKERS + 1);
  assert.throws(
    () => validateMarkdownStructure(source),
    (error) => error instanceof TooComplexError && error.reason === 'inline-markers',
  );
});

test('raw HTML and frontmatter cannot disguise dense Markdown as a fence', () => {
  const dense = '*x* '.repeat(Math.floor(MAX_INLINE_MARKERS / 2) + 1);
  const sources = [
    `<pre>\n\`\`\`\n</pre>\n${dense}`,
    `<!--\n\`\`\`\n-->\n${dense}`,
    `---\ntitle: example\n\`\`\`\n---\n${dense}`,
  ];
  for (const source of sources) {
    assert.throws(
      () => validateMarkdownStructure(source),
      (error) => error instanceof TooComplexError && error.reason === 'inline-markers',
    );
  }
});

test('footnote definitions use the renderer block grammar for complexity checks', () => {
  const source = `[^note]:\n\n    ${'*x* '.repeat(Math.floor(MAX_INLINE_MARKERS / 2) + 1)}\n\nuse [^note]`;
  assert.throws(
    () => validateMarkdownStructure(source),
    (error) => error instanceof TooComplexError && error.reason === 'inline-markers',
  );
});

test('malformed raw HTML is rejected without a quadratic scan', () => {
  assert.throws(
    () => validateMarkdownStructure(`<div\n${'<a'.repeat(10_001)}`),
    (error) => error instanceof TooComplexError && error.reason === 'html-tags',
  );
});

test('raw HTML attributes have a pre-DOM allocation budget', () => {
  const attributes = Array.from(
    { length: MAX_RAW_HTML_ATTRIBUTES + 1 },
    (_, index) => ` aria-x${index}=x`,
  ).join('');
  assert.throws(
    () => validateMarkdownStructure(`<div${attributes}></div>`),
    (error) => error instanceof TooComplexError && error.reason === 'html-attributes',
  );
});

test('raster detection trusts signatures rather than declared names or MIME types', () => {
  assert.equal(sniffRasterMime(new TextEncoder().encode('private notes')), null);
  assert.equal(
    sniffRasterMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/png',
  );
  assert.equal(sniffRasterMime(new Uint8Array([0xff, 0xd8, 0xff])), 'image/jpeg');
});

function bytes(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function ascii(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function u32be(value: number): number[] {
  return [
    Math.floor(value / 0x1_000000) & 0xff,
    Math.floor(value / 0x1_0000) & 0xff,
    Math.floor(value / 0x100) & 0xff,
    value & 0xff,
  ];
}

function u32le(value: number): number[] {
  return [
    value & 0xff,
    Math.floor(value / 0x100) & 0xff,
    Math.floor(value / 0x1_0000) & 0xff,
    Math.floor(value / 0x1_000000) & 0xff,
  ];
}

function u16be(value: number): number[] {
  return [Math.floor(value / 0x100) & 0xff, value & 0xff];
}

function u16le(value: number): number[] {
  return [value & 0xff, Math.floor(value / 0x100) & 0xff];
}

function isoBox(type: string, ...payload: Array<Uint8Array | number[]>): Uint8Array {
  const body = bytes(...payload);
  return bytes(u32be(body.length + 8), ascii(type), body);
}

function pngChunk(type: string, payload: Uint8Array | number[]): Uint8Array {
  return bytes(u32be(payload.length), ascii(type), payload, [0, 0, 0, 0]);
}

function pngFile(
  width: number,
  height: number,
  ...chunks: Array<Uint8Array>
): Uint8Array {
  return bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    pngChunk('IHDR', bytes(u32be(width), u32be(height), [8, 6, 0, 0, 0])),
    ...chunks,
    pngChunk('IEND', []),
  );
}

function gifFrame(width: number, height: number): Uint8Array {
  return bytes(
    [0x2c],
    u16le(0),
    u16le(0),
    u16le(width),
    u16le(height),
    [0, 2, 1, 0, 0],
  );
}

function gifFile(width: number, height: number, frames = 1): Uint8Array {
  return bytes(
    ascii('GIF89a'),
    u16le(width),
    u16le(height),
    [0, 0, 0],
    ...Array.from({ length: frames }, () => gifFrame(width, height)),
    [0x3b],
  );
}

function rawWebpChunk(type: string, payload: Uint8Array | number[]): Uint8Array {
  const padding = payload.length % 2 ? [0] : [];
  return bytes(ascii(type), u32le(payload.length), payload, padding);
}

function webpFile(...chunks: Uint8Array[]): Uint8Array {
  const body = bytes(ascii('WEBP'), ...chunks);
  return bytes(ascii('RIFF'), u32le(body.length), body);
}

function webpChunk(type: string, payload: number[]): Uint8Array {
  return webpFile(rawWebpChunk(type, payload));
}

test('raster dimensions are read from PNG, GIF and JPEG headers without decoding', () => {
  const png = pngFile(12_000, 9_000, pngChunk('IDAT', []));
  assert.deepEqual(inspectRaster(png), {
    mime: 'image/png',
    width: 12_000,
    height: 9_000,
    animated: false,
  });

  const gif = gifFile(640, 480);
  assert.deepEqual(inspectRaster(gif), {
    mime: 'image/gif',
    width: 640,
    height: 480,
    animated: false,
  });

  const jpeg = bytes(
    [0xff, 0xd8],
    [0xff, 0xe1, 0x00, 0x08, 1, 2, 3, 4, 5, 6],
    [
      0xff, 0xc2, 0x00, 0x11, 8, 0x08, 0x70, 0x10, 0x00, 3,
      1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
    ],
  );
  assert.deepEqual(inspectRaster(jpeg), {
    mime: 'image/jpeg',
    width: 4_096,
    height: 2_160,
    animated: false,
  });
});

test('raster policy rejects pixel bombs before browser decoding', () => {
  const png = (width: number, height: number) =>
    pngFile(width, height, pngChunk('IDAT', []));

  const safe = png(1_920, 1_080);
  assert.equal(inspectSafeRaster(safe)?.mime, 'image/png');
  assert.equal(inspectSafeRaster(png(8_000, 8_000)), null);
  assert.equal(inspectSafeRaster(gifFile(16, 16, 2)), null);

  const payload = btoa(String.fromCharCode(...safe));
  assert.equal(inspectSafeRasterDataUrl(`data:image/png;base64,${payload}`)?.width, 1_920);
  assert.equal(inspectSafeRasterDataUrl(`data:image/jpeg;base64,${payload}`), null);
});

test('document raster budget bounds aggregate decoded pixels', () => {
  let remaining = MAX_DOCUMENT_RASTER_PIXELS;
  let accepted = 0;
  const pixels = 8_192 * 2_441;
  for (let index = 0; index < 100; index += 1) {
    const next = reserveRasterPixels(remaining, pixels);
    if (next === null) continue;
    remaining = next;
    accepted += 1;
  }
  assert.equal(accepted, 3);
});

test('raster dimensions cover all WebP bitstream headers', () => {
  const vp8Payload = [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01];
  const vp8x = webpFile(
    rawWebpChunk('VP8X', [0, 0, 0, 0, 0x7f, 0x02, 0, 0xdf, 0x01, 0]),
    rawWebpChunk('VP8 ', vp8Payload),
  );
  assert.deepEqual(inspectRaster(vp8x), {
    mime: 'image/webp',
    width: 640,
    height: 480,
    animated: false,
  });

  const width = 321;
  const height = 123;
  const packedWidth = width - 1;
  const packedHeight = height - 1;
  const vp8l = webpChunk('VP8L', [
    0x2f,
    packedWidth & 0xff,
    ((packedWidth >> 8) & 0x3f) | ((packedHeight & 3) << 6),
    (packedHeight >> 2) & 0xff,
    (packedHeight >> 10) & 0x0f,
  ]);
  assert.deepEqual(inspectRaster(vp8l), {
    mime: 'image/webp',
    width,
    height,
    animated: false,
  });

  const vp8 = webpChunk('VP8 ', vp8Payload);
  assert.deepEqual(inspectRaster(vp8), {
    mime: 'image/webp',
    width: 640,
    height: 480,
    animated: false,
  });
});

test('APNG, multi-frame GIF and animated WebP are identified without decoding', () => {
  const frameControl = (sequence: number) =>
    pngChunk(
      'fcTL',
      bytes(
        u32be(sequence),
        u32be(320),
        u32be(200),
        u32be(0),
        u32be(0),
        u16be(1),
        u16be(10),
        [0, 0],
      ),
    );
  const apng = pngFile(
    320,
    200,
    pngChunk('acTL', bytes(u32be(2), u32be(0))),
    frameControl(0),
    pngChunk('IDAT', []),
    frameControl(1),
    pngChunk('fdAT', bytes(u32be(2), [0])),
  );
  assert.deepEqual(inspectRaster(apng), {
    mime: 'image/png',
    width: 320,
    height: 200,
    animated: true,
  });

  assert.deepEqual(inspectRaster(gifFile(320, 200, 2)), {
    mime: 'image/gif',
    width: 320,
    height: 200,
    animated: true,
  });

  const vp8Payload = [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xc8, 0x00];
  const frame = bytes(
    [0, 0, 0, 0, 0, 0, 0x3f, 0x01, 0, 0xc7, 0, 0, 10, 0, 0, 0],
    rawWebpChunk('VP8 ', vp8Payload),
  );
  const animatedWebp = webpFile(
    rawWebpChunk('VP8X', [0x02, 0, 0, 0, 0x3f, 0x01, 0, 0xc7, 0, 0]),
    rawWebpChunk('ANIM', [0, 0, 0, 0, 0, 0]),
    rawWebpChunk('ANMF', frame),
  );
  assert.deepEqual(inspectRaster(animatedWebp), {
    mime: 'image/webp',
    width: 320,
    height: 200,
    animated: true,
  });
});

test('malformed animation containers are rejected instead of treated as static', () => {
  const mismatchedApng = pngFile(
    10,
    10,
    pngChunk('acTL', bytes(u32be(2), u32be(0))),
    pngChunk(
      'fcTL',
      bytes(
        u32be(0),
        u32be(10),
        u32be(10),
        u32be(0),
        u32be(0),
        u16be(1),
        u16be(1),
        [0, 0],
      ),
    ),
    pngChunk('IDAT', []),
  );
  assert.equal(inspectRaster(mismatchedApng), null);

  const gif = gifFile(10, 10, 2);
  assert.equal(inspectRaster(gif.subarray(0, gif.length - 1)), null);

  const frame = bytes(
    [0, 0, 0, 0, 0, 0, 9, 0, 0, 9, 0, 0, 1, 0, 0, 0],
    rawWebpChunk('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 10, 0, 10, 0]),
  );
  const missingAnimationFlag = webpFile(
    rawWebpChunk('VP8X', [0, 0, 0, 0, 9, 0, 0, 9, 0, 0]),
    rawWebpChunk('ANIM', [0, 0, 0, 0, 0, 0]),
    rawWebpChunk('ANMF', frame),
  );
  assert.equal(inspectRaster(missingAnimationFlag), null);
});

test('AVIF dimensions follow bounded ISO-BMFF property boxes', () => {
  const ftyp = isoBox('ftyp', ascii('mif1'), [0, 0, 0, 0], ascii('avif'));
  const small = isoBox('ispe', [0, 0, 0, 0], u32be(64), u32be(64));
  const large = isoBox('ispe', [0, 0, 0, 0], u32be(16_000), u32be(9_000));
  const meta = isoBox('meta', [0, 0, 0, 0], isoBox('iprp', isoBox('ipco', small, large)));
  const avif = bytes(ftyp, meta);

  assert.equal(sniffRasterMime(avif), 'image/avif');
  assert.deepEqual(inspectRaster(avif), {
    mime: 'image/avif',
    width: 16_000,
    height: 9_000,
    animated: false,
  });
});

test('AVIF sequence dimensions can be read from a track header', () => {
  const ftyp = isoBox('ftyp', ascii('avis'), [0, 0, 0, 0]);
  const trackHeader = new Uint8Array(84);
  trackHeader.set(u32be(1_920 * 0x1_0000), 76);
  trackHeader.set(u32be(1_080 * 0x1_0000), 80);
  const avif = bytes(ftyp, isoBox('moov', isoBox('trak', isoBox('tkhd', trackHeader))));

  assert.deepEqual(inspectRaster(avif), {
    mime: 'image/avif',
    width: 1_920,
    height: 1_080,
    animated: true,
  });
});

test('truncated and length-confused raster headers are rejected', () => {
  assert.equal(
    inspectRaster(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    null,
  );
  assert.equal(inspectRaster(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff])), null);

  const truncatedWebp = webpChunk('VP8X', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  truncatedWebp[16] = 0xff;
  assert.equal(inspectRaster(truncatedWebp), null);

  const ftyp = isoBox('ftyp', ascii('avif'), [0, 0, 0, 0]);
  const malformedMeta = bytes(u32be(7), ascii('meta'));
  assert.equal(inspectRaster(bytes(ftyp, malformedMeta)), null);
  assert.equal(inspectRaster(new TextEncoder().encode('not an image')), null);
});

test('a stopped watcher cannot publish a late file read', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let poll: (() => Promise<void>) | undefined;
  let finishRead: ((file: File) => void) | undefined;
  let changes = 0;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setInterval(callback: () => Promise<void>) {
        poll = callback;
        return 1;
      },
      clearInterval() {},
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { hidden: false },
  });

  try {
    const source: Source = {
      name: 'watch.md',
      text: 'old',
      size: 3,
      lastModified: 1,
      file: {
        getFile: () => new Promise<File>((resolve) => (finishRead = resolve)),
      } as FileSystemFileHandle,
    };

    const stop = watch(source, () => {
      changes += 1;
    });
    const running = poll?.();
    assert.ok(running);
    stop();

    const next = new Blob(['new'], { type: 'text/markdown' }) as Blob & {
      lastModified: number;
    };
    Object.defineProperty(next, 'lastModified', { value: 2 });
    finishRead?.(next as File);
    await running;
    assert.equal(changes, 0);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete (globalThis as { document?: unknown }).document;
  }
});
