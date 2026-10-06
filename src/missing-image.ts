/* Every image that cannot be shown ends up with the same dashed placeholder.
   The reason differs a lot, though: a privacy block, a lone file with no
   folder, a typo in the path, a size limit. This module records which one it
   was and writes a short explanation next to the image so the reader knows
   what, if anything, would fix it.

   Strings are resolved lazily from the document language so this module can
   be imported in Node for tests without a DOM present at import time. */

import {
  MAX_DOCUMENT_RASTER_PIXELS,
  MAX_LOCAL_IMAGE_BYTES,
  MAX_LOCAL_IMAGE_COUNT,
  MAX_LOCAL_IMAGE_TOTAL_BYTES,
  MAX_RASTER_PIXELS,
} from './image-policy.ts';

export type MissingReason =
  /** Remote URLs are never fetched. */
  | 'remote'
  /** A relative path, but the document was opened without its folder. */
  | 'no-folder'
  /** The folder is open and the path does not exist in it. */
  | 'not-found'
  /** Per-file or per-document byte limit. */
  | 'too-large'
  /** Per-image or per-document pixel limit. */
  | 'budget'
  /** Not a static PNG, JPEG, GIF, WebP or AVIF, or an unsafe path or scheme. */
  | 'unsupported'
  /** Beyond the per-document image count. */
  | 'too-many'
  /** The browser refused to decode what looked like a valid raster. */
  | 'decode';

export const MISSING_REASON = 'data-md-missing';
const NOTE_CLASS = 'img-missing__why';

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;
const millions = (pixels: number, locale: string) =>
  `${(pixels / 1_000_000).toLocaleString(locale)}`;

function describe(reason: MissingReason): string {
  const english = typeof document !== 'undefined' && document.documentElement.lang.startsWith('en');
  if (english) {
    switch (reason) {
      case 'remote':
        return 'Remote images are not loaded. Save the image next to the document and use a relative path.';
      case 'no-folder':
        return 'Only the file was opened, so images beside it are out of reach. Drop the whole folder to show them.';
      case 'not-found':
        return 'This image was not found in the folder.';
      case 'too-large':
        return `Image too large. Up to ${mb(MAX_LOCAL_IMAGE_BYTES)} per image and ${mb(MAX_LOCAL_IMAGE_TOTAL_BYTES)} per document are read.`;
      case 'budget':
        return `Pixel limit exceeded. Up to ${millions(MAX_RASTER_PIXELS, 'en-US')} million pixels per image and ${millions(MAX_DOCUMENT_RASTER_PIXELS, 'en-US')} million per document are drawn.`;
      case 'unsupported':
        return 'Unsupported image. Only static PNG, JPEG, GIF, WebP and AVIF files are shown.';
      case 'too-many':
        return `Only the first ${MAX_LOCAL_IMAGE_COUNT} images of a document are shown.`;
      case 'decode':
        return 'The browser could not decode this image.';
    }
  }
  switch (reason) {
    case 'remote':
      return '외부 이미지는 불러오지 않습니다. 이미지를 문서 옆에 저장하고 상대 경로로 바꾸면 보입니다.';
    case 'no-folder':
      return '파일만 열어서 옆에 있는 이미지에 닿을 수 없습니다. 폴더를 통째로 끌어다 놓으면 보입니다.';
    case 'not-found':
      return '폴더에서 이 이미지를 찾지 못했습니다.';
    case 'too-large':
      return `이미지가 너무 큽니다. 장당 ${mb(MAX_LOCAL_IMAGE_BYTES)}, 문서당 ${mb(MAX_LOCAL_IMAGE_TOTAL_BYTES)}까지 읽습니다.`;
    case 'budget':
      return `픽셀 수가 한도를 넘었습니다. 장당 ${millions(MAX_RASTER_PIXELS, 'ko-KR')}백만, 문서당 ${millions(MAX_DOCUMENT_RASTER_PIXELS, 'ko-KR')}백만 픽셀까지 그립니다.`;
    case 'unsupported':
      return '지원하지 않는 이미지입니다. PNG·JPEG·GIF·WebP·AVIF 정지 이미지만 보여줍니다.';
    case 'too-many':
      return `문서당 이미지 ${MAX_LOCAL_IMAGE_COUNT}장까지만 표시합니다.`;
    case 'decode':
      return '브라우저가 이미지를 해석하지 못했습니다.';
  }
}

/** Record why an image is blank and explain it right below the placeholder. */
export function markMissing(image: HTMLImageElement, reason: MissingReason, detail = ''): void {
  image.removeAttribute('src');
  image.classList.add('is-missing');
  image.setAttribute(MISSING_REASON, reason);

  let note = image.nextElementSibling;
  if (!(note instanceof HTMLElement) || !note.classList.contains(NOTE_CLASS)) {
    note = document.createElement('small');
    note.className = NOTE_CLASS;
    image.after(note);
  }
  const text = describe(reason);
  note.textContent = detail ? `${text} (${detail})` : text;
}

/** The image decoded after all: drop the placeholder state and its note. */
export function clearMissing(image: HTMLImageElement): void {
  image.classList.remove('is-missing');
  image.removeAttribute(MISSING_REASON);
  const note = image.nextElementSibling;
  if (note instanceof HTMLElement && note.classList.contains(NOTE_CLASS)) note.remove();
}
