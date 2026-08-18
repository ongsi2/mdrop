import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import footnote from 'markdown-it-footnote';

import { splitFrontmatter } from './frontmatter.ts';
import {
  MAX_DOCUMENT_IMAGES,
  MAX_HEADINGS,
  MAX_INLINE_MARKERS,
  MAX_RAW_HTML_ATTRIBUTES,
  MAX_RAW_HTML_TAGS,
  TooComplexError,
} from './files.ts';

/* Block parsing deliberately stops before markdown-it's inline expansion.
   It tells us which text is prose, fenced code or raw HTML without allocating
   the hundreds of thousands of child tokens an adversarial inline run can
   produce. */
const blockParser = new MarkdownIt({ html: true, linkify: true, breaks: true }).use(footnote);
const MAX_BLOCK_TOKENS = 20_000;
const MAX_CODE_BLOCKS = 1_000;

function count(value: string, pattern: RegExp): number {
  let total = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(value)) total += 1;
  return total;
}

/** Count source-owned HTML attributes in one linear pass, including boolean
 * attributes. DOMPurify still has to parse rejected attributes, so this budget
 * is enforced before an HTML DOM is allocated. */
function countHtmlAttributes(value: string): number {
  let attributes = 0;
  let index = 0;

  while (index < value.length) {
    if (value[index] !== '<' || !/[a-z]/i.test(value[index + 1] ?? '')) {
      index += 1;
      continue;
    }

    index += 2;
    while (index < value.length && !/[\s/>]/.test(value[index])) index += 1;

    while (index < value.length && value[index] !== '>') {
      while (/\s/.test(value[index] ?? '')) index += 1;
      if (index >= value.length || value[index] === '>') break;
      if (value[index] === '/') {
        index += 1;
        continue;
      }

      const nameStart = index;
      while (index < value.length && !/[\s=/>]/.test(value[index])) index += 1;
      if (index === nameStart) {
        index += 1;
        continue;
      }
      attributes += 1;
      if (attributes > MAX_RAW_HTML_ATTRIBUTES) return attributes;

      while (/\s/.test(value[index] ?? '')) index += 1;
      if (value[index] !== '=') continue;
      index += 1;
      while (/\s/.test(value[index] ?? '')) index += 1;

      const quote = value[index] === '"' || value[index] === "'" ? value[index] : '';
      if (quote) {
        index += 1;
        while (index < value.length && value[index] !== quote) index += 1;
        if (value[index] === quote) index += 1;
      } else {
        while (index < value.length && !/[\s>]/.test(value[index])) index += 1;
      }
    }
    if (value[index] === '>') index += 1;
  }
  return attributes;
}

/** Enforce budgets against the same block grammar used by the real renderer. */
export function validateMarkdownStructure(source: string): void {
  const { body } = splitFrontmatter(source);
  /* block.parse() is deliberately below the full core pipeline, so apply the
     core normalizer here to keep CR, CRLF and LF documents equivalent. */
  const normalizedBody = body.replace(/\r\n?/g, '\n');
  const tokens: Token[] = [];
  blockParser.block.parse(normalizedBody, blockParser, {}, tokens);
  if (tokens.length > MAX_BLOCK_TOKENS) throw new TooComplexError('block-tokens');

  let headings = 0;
  let images = 0;
  let htmlTags = 0;
  let htmlAttributes = 0;
  let inlineMarkers = 0;
  let codeBlocks = 0;

  for (const token of tokens) {
    if (token.type === 'heading_open') headings += 1;

    if (token.type === 'fence' || token.type === 'code_block') {
      codeBlocks += 1;
      if (codeBlocks > MAX_CODE_BLOCKS) throw new TooComplexError('code-blocks');
      continue;
    }

    if (token.type !== 'inline' && token.type !== 'html_block') continue;
    const content = token.content;

    images += count(content, /!\[/g) + count(content, /<img\b/gi);
    if (images > MAX_DOCUMENT_IMAGES) throw new TooComplexError('images');

    /* Never scan from each `<` to a distant `>`: malformed runs such as
       `<a<a<a...` otherwise turn a validation pass quadratic. Raw HTML blocks
       count every opener because DOMPurify still has to parse them. */
    htmlTags +=
      token.type === 'html_block'
        ? count(content, /</g)
        : count(content, /<[a-z!/][^<>]*>/gi);
    if (htmlTags > MAX_RAW_HTML_TAGS) throw new TooComplexError('html-tags');

    htmlAttributes += countHtmlAttributes(content);
    if (htmlAttributes > MAX_RAW_HTML_ATTRIBUTES) {
      throw new TooComplexError('html-attributes');
    }

    headings += count(content, /<h[1-6]\b/gi);
    if (headings > MAX_HEADINGS) throw new TooComplexError('headings');

    /* Raw HTML blocks are inert as Markdown prose; punctuation inside a
       comment or <pre> cannot become emphasis/link nodes. */
    if (token.type === 'html_block') continue;

    inlineMarkers += count(
      content,
      /(?:(?:https?|ftp):\/\/)|(?:[\\!#$%&*_`~|<>@.+:=^{}-])|(?:\[)|(?:\])/gi,
    );
    if (inlineMarkers > MAX_INLINE_MARKERS) {
      throw new TooComplexError('inline-markers');
    }
  }
}
