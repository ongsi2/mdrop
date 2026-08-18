export type RasterMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif';

export type RasterInfo = {
  mime: RasterMime;
  width: number;
  height: number;
  animated: boolean;
};

type Dimensions = Pick<RasterInfo, 'width' | 'height'>;
type RasterDetails = Dimensions & Pick<RasterInfo, 'animated'>;

function bytesEqual(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || offset + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected[index]) return false;
  }
  return true;
}

function asciiEqual(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (offset < 0 || offset + expected.length > bytes.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function ascii4(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function readU16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100;
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x1_0000;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1_000000 +
    bytes[offset + 1] * 0x1_0000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] +
    bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x1_0000 +
    bytes[offset + 3] * 0x1_000000
  );
}

function validDimensions(width: number, height: number): Dimensions | null {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

function largerDimensions(current: Dimensions | null, candidate: Dimensions): Dimensions {
  if (!current) return candidate;
  const currentArea = BigInt(current.width) * BigInt(current.height);
  const candidateArea = BigInt(candidate.width) * BigInt(candidate.height);
  return candidateArea > currentArea ? candidate : current;
}

function validPngHeader(bytes: Uint8Array, payload: number): Dimensions | null {
  const bitDepth = bytes[payload + 8];
  const colorType = bytes[payload + 9];
  const validBitDepth =
    (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
    (colorType === 2 && (bitDepth === 8 || bitDepth === 16)) ||
    (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
    (colorType === 4 && (bitDepth === 8 || bitDepth === 16)) ||
    (colorType === 6 && (bitDepth === 8 || bitDepth === 16));
  if (
    !validBitDepth ||
    bytes[payload + 10] !== 0 ||
    bytes[payload + 11] !== 0 ||
    bytes[payload + 12] > 1
  ) {
    return null;
  }
  return validDimensions(readU32BE(bytes, payload), readU32BE(bytes, payload + 4));
}

function pngDetails(bytes: Uint8Array): RasterDetails | null {
  if (
    bytes.length < 33 ||
    !bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  ) {
    return null;
  }

  let dimensions: Dimensions | null = null;
  let animated = false;
  let animationFrames = 0;
  let frameControls = 0;
  let nextSequence = 0;
  let hasImageData = false;
  let hasFrameControl = false;
  let currentFrameHasData = false;
  let imageDataEnded = false;
  let sawAnimationControl = false;
  let sawEnd = false;
  let offset = 8;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return null;
    const length = readU32BE(bytes, offset);
    const type = ascii4(bytes, offset + 4);
    const payload = offset + 8;
    const chunkEnd = payload + length;
    const next = chunkEnd + 4;
    if (chunkEnd < payload || next > bytes.length) return null;

    if (!dimensions) {
      if (type !== 'IHDR' || length !== 13) return null;
      dimensions = validPngHeader(bytes, payload);
      if (!dimensions) return null;
    } else if (type === 'IHDR') {
      return null;
    } else if (type === 'acTL') {
      if (sawAnimationControl || hasImageData || length !== 8) return null;
      animationFrames = readU32BE(bytes, payload);
      if (animationFrames === 0) return null;
      sawAnimationControl = true;
      animated = true;
    } else if (type === 'fcTL') {
      if (!sawAnimationControl || length !== 26) return null;
      if (hasFrameControl && !currentFrameHasData) return null;
      if (readU32BE(bytes, payload) !== nextSequence) return null;
      nextSequence += 1;
      const frameWidth = readU32BE(bytes, payload + 4);
      const frameHeight = readU32BE(bytes, payload + 8);
      const frameX = readU32BE(bytes, payload + 12);
      const frameY = readU32BE(bytes, payload + 16);
      if (
        !validDimensions(frameWidth, frameHeight) ||
        frameX + frameWidth > dimensions.width ||
        frameY + frameHeight > dimensions.height ||
        bytes[payload + 24] > 2 ||
        bytes[payload + 25] > 1
      ) {
        return null;
      }
      frameControls += 1;
      hasFrameControl = true;
      currentFrameHasData = false;
    } else if (type === 'fdAT') {
      if (!sawAnimationControl || !hasFrameControl || length < 4) return null;
      if (readU32BE(bytes, payload) !== nextSequence) return null;
      nextSequence += 1;
      if (length > 4) currentFrameHasData = true;
    } else if (type === 'IDAT') {
      if (imageDataEnded) return null;
      hasImageData = true;
      if (hasFrameControl && frameControls === 1) currentFrameHasData = true;
    } else if (type === 'IEND') {
      if (length !== 0 || next !== bytes.length) return null;
      sawEnd = true;
      offset = next;
      break;
    }

    if (hasImageData && type !== 'IDAT' && type !== 'IEND') imageDataEnded = true;

    offset = next;
  }

  if (!dimensions || !hasImageData || !sawEnd) return null;
  if (
    sawAnimationControl &&
    (frameControls !== animationFrames || !hasFrameControl || !currentFrameHasData)
  ) {
    return null;
  }
  return { ...dimensions, animated };
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number | null {
  let offset = start;
  while (offset < bytes.length) {
    const size = bytes[offset];
    offset += 1;
    if (size === 0) return offset;
    if (offset + size > bytes.length) return null;
    offset += size;
  }
  return null;
}

function gifDetails(bytes: Uint8Array): RasterDetails | null {
  if (
    bytes.length < 14 ||
    (!asciiEqual(bytes, 0, 'GIF87a') && !asciiEqual(bytes, 0, 'GIF89a'))
  ) {
    return null;
  }
  const dimensions = validDimensions(readU16LE(bytes, 6), readU16LE(bytes, 8));
  if (!dimensions) return null;

  const globalTableBytes = bytes[10] & 0x80 ? 3 * 2 ** ((bytes[10] & 7) + 1) : 0;
  let offset = 13 + globalTableBytes;
  if (offset > bytes.length) return null;
  let frames = 0;

  while (offset < bytes.length) {
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x3b) {
      return offset === bytes.length && frames > 0
        ? { ...dimensions, animated: frames > 1 }
        : null;
    }

    if (marker === 0x21) {
      if (offset >= bytes.length) return null;
      offset += 1;
      const next = skipGifSubBlocks(bytes, offset);
      if (next === null) return null;
      offset = next;
      continue;
    }

    if (marker !== 0x2c || offset + 9 > bytes.length) return null;
    const frameX = readU16LE(bytes, offset);
    const frameY = readU16LE(bytes, offset + 2);
    const frameWidth = readU16LE(bytes, offset + 4);
    const frameHeight = readU16LE(bytes, offset + 6);
    const packed = bytes[offset + 8];
    if (
      !validDimensions(frameWidth, frameHeight) ||
      frameX + frameWidth > dimensions.width ||
      frameY + frameHeight > dimensions.height
    ) {
      return null;
    }
    offset += 9;

    const localTableBytes = packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0;
    if (offset + localTableBytes + 1 > bytes.length) return null;
    offset += localTableBytes;
    const minimumCodeSize = bytes[offset];
    offset += 1;
    if (minimumCodeSize < 2 || minimumCodeSize > 8) return null;
    const next = skipGifSubBlocks(bytes, offset);
    if (next === null) return null;
    offset = next;
    frames += 1;
  }
  return null;
}

function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function jpegDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 4 || !bytesEqual(bytes, 0, [0xff, 0xd8])) return null;

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;

    const segmentLength = readU16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;

    if (isStartOfFrame(marker)) {
      if (segmentLength < 8) return null;
      const componentCount = bytes[offset + 7];
      if (componentCount === 0 || segmentLength !== 8 + componentCount * 3) return null;
      return validDimensions(readU16BE(bytes, offset + 5), readU16BE(bytes, offset + 3));
    }

    offset += segmentLength;
  }
  return null;
}

function vp8Dimensions(bytes: Uint8Array, offset: number, size: number): Dimensions | null {
  if (
    size < 10 ||
    (bytes[offset] & 1) !== 0 ||
    !bytesEqual(bytes, offset + 3, [0x9d, 0x01, 0x2a])
  ) {
    return null;
  }
  return validDimensions(
    readU16LE(bytes, offset + 6) & 0x3fff,
    readU16LE(bytes, offset + 8) & 0x3fff,
  );
}

function vp8lDimensions(bytes: Uint8Array, offset: number, size: number): Dimensions | null {
  if (size < 5 || bytes[offset] !== 0x2f || (bytes[offset + 4] & 0xe0) !== 0) return null;
  return validDimensions(
    1 + bytes[offset + 1] + ((bytes[offset + 2] & 0x3f) << 8),
    1 + (bytes[offset + 2] >> 6) + (bytes[offset + 3] << 2) +
      ((bytes[offset + 4] & 0x0f) << 10),
  );
}

function webpFrameIsValid(
  bytes: Uint8Array,
  start: number,
  end: number,
  canvas: Dimensions,
): boolean {
  if (end - start < 16) return false;
  const frameX = readU24LE(bytes, start) * 2;
  const frameY = readU24LE(bytes, start + 3) * 2;
  const frameWidth = 1 + readU24LE(bytes, start + 6);
  const frameHeight = 1 + readU24LE(bytes, start + 9);
  if (
    frameX + frameWidth > canvas.width ||
    frameY + frameHeight > canvas.height ||
    (bytes[start + 15] & 0xfc) !== 0
  ) {
    return false;
  }

  let imageChunks = 0;
  let offset = start + 16;
  while (offset < end) {
    if (offset + 8 > end) return false;
    const type = ascii4(bytes, offset);
    const size = readU32LE(bytes, offset + 4);
    const payload = offset + 8;
    const next = payload + size + (size & 1);
    if (next > end) return false;

    if (type === 'VP8 ' || type === 'VP8L') {
      const dimensions = type === 'VP8 '
        ? vp8Dimensions(bytes, payload, size)
        : vp8lDimensions(bytes, payload, size);
      if (
        !dimensions ||
        dimensions.width !== frameWidth ||
        dimensions.height !== frameHeight
      ) {
        return false;
      }
      imageChunks += 1;
    }
    offset = next;
  }
  return offset === end && imageChunks === 1;
}

function webpDetails(bytes: Uint8Array): RasterDetails | null {
  if (
    bytes.length < 20 ||
    !asciiEqual(bytes, 0, 'RIFF') ||
    !asciiEqual(bytes, 8, 'WEBP')
  ) {
    return null;
  }

  const riffSize = readU32LE(bytes, 4);
  const end = riffSize + 8;
  if (riffSize < 12 || end !== bytes.length) return null;

  let canvas: Dimensions | null = null;
  let directDimensions: Dimensions | null = null;
  let animationFlag = false;
  let sawAnimationControl = false;
  let animationFrames = 0;
  let directImages = 0;
  let sawExtendedHeader = false;
  let offset = 12;
  while (offset < end) {
    if (offset + 8 > end) return null;
    const type = ascii4(bytes, offset);
    const size = readU32LE(bytes, offset + 4);
    const payload = offset + 8;
    const paddedSize = size + (size & 1);
    if (payload + paddedSize > end) return null;

    let candidate: Dimensions | null = null;
    if (type === 'VP8X') {
      if (
        sawExtendedHeader ||
        offset !== 12 ||
        size !== 10 ||
        (bytes[payload] & 0xc1) !== 0 ||
        bytes[payload + 1] !== 0 ||
        bytes[payload + 2] !== 0 ||
        bytes[payload + 3] !== 0
      ) {
        return null;
      }
      sawExtendedHeader = true;
      animationFlag = (bytes[payload] & 0x02) !== 0;
      candidate = validDimensions(
        1 + readU24LE(bytes, payload + 4),
        1 + readU24LE(bytes, payload + 7),
      );
      canvas = candidate;
    } else if (type === 'VP8L') {
      candidate = vp8lDimensions(bytes, payload, size);
      directImages += 1;
      directDimensions = candidate;
    } else if (type === 'VP8 ') {
      candidate = vp8Dimensions(bytes, payload, size);
      directImages += 1;
      directDimensions = candidate;
    } else if (type === 'ANIM') {
      if (!sawExtendedHeader || !animationFlag || sawAnimationControl || size !== 6) return null;
      sawAnimationControl = true;
    } else if (type === 'ANMF') {
      if (
        !animationFlag ||
        !sawAnimationControl ||
        !canvas ||
        !webpFrameIsValid(bytes, payload, payload + size, canvas)
      ) {
        return null;
      }
      animationFrames += 1;
    }

    if ((type === 'VP8X' || type === 'VP8L' || type === 'VP8 ') && !candidate) return null;
    offset = payload + paddedSize;
  }

  const hasAnimationStructure = sawAnimationControl || animationFrames > 0;
  if (animationFlag || hasAnimationStructure) {
    if (
      !sawExtendedHeader ||
      !animationFlag ||
      !sawAnimationControl ||
      animationFrames === 0 ||
      directImages !== 0 ||
      !canvas
    ) {
      return null;
    }
    return { ...canvas, animated: true };
  }
  if (directImages !== 1 || !directDimensions) return null;
  if (
    canvas &&
    (canvas.width !== directDimensions.width || canvas.height !== directDimensions.height)
  ) {
    return null;
  }
  return { ...(canvas ?? directDimensions), animated: false };
}

type IsoBox = {
  type: string;
  payload: number;
  end: number;
  next: number;
};

function readIsoBox(bytes: Uint8Array, offset: number, parentEnd: number): IsoBox | null {
  if (offset < 0 || parentEnd > bytes.length || offset + 8 > parentEnd) return null;
  const shortSize = readU32BE(bytes, offset);
  const type = ascii4(bytes, offset + 4);
  let headerSize = 8;
  let size = shortSize;

  if (shortSize === 1) {
    if (offset + 16 > parentEnd) return null;
    const high = readU32BE(bytes, offset + 8);
    if (high !== 0) return null;
    size = readU32BE(bytes, offset + 12);
    headerSize = 16;
  } else if (shortSize === 0) {
    size = parentEnd - offset;
  }

  if (size < headerSize || size > parentEnd - offset) return null;
  const end = offset + size;
  return { type, payload: offset + headerSize, end, next: end };
}

function isAvifBrand(brand: string): boolean {
  return brand === 'avif' || brand === 'avis';
}

function hasAvifFileType(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || !asciiEqual(bytes, 4, 'ftyp')) return false;
  const shortSize = readU32BE(bytes, 0);
  let payload = 8;
  let declaredEnd = shortSize === 0 ? bytes.length : shortSize;
  if (shortSize === 1) {
    if (bytes.length < 24 || readU32BE(bytes, 8) !== 0) return false;
    declaredEnd = readU32BE(bytes, 12);
    payload = 16;
  }
  if (declaredEnd < payload + 8) return false;
  if (isAvifBrand(ascii4(bytes, payload))) return true;
  const availableEnd = Math.min(bytes.length, declaredEnd);
  for (let brand = payload + 8; brand + 4 <= availableEnd; brand += 4) {
    if (isAvifBrand(ascii4(bytes, brand))) return true;
  }
  return false;
}

type AvifScan = {
  valid: boolean;
  dimensions: Dimensions | null;
  animated: boolean;
};

function scanAvifProperties(
  bytes: Uint8Array,
  start: number,
  end: number,
  level: 'meta' | 'iprp' | 'ipco',
): AvifScan {
  let dimensions: Dimensions | null = null;
  let offset = start;

  while (offset < end) {
    const box = readIsoBox(bytes, offset, end);
    if (!box) return { valid: false, dimensions: null, animated: false };

    if (level === 'meta' && box.type === 'iprp') {
      const nested = scanAvifProperties(bytes, box.payload, box.end, 'iprp');
      if (!nested.valid) return nested;
      if (nested.dimensions) dimensions = largerDimensions(dimensions, nested.dimensions);
    } else if (level === 'iprp' && box.type === 'ipco') {
      const nested = scanAvifProperties(bytes, box.payload, box.end, 'ipco');
      if (!nested.valid) return nested;
      if (nested.dimensions) dimensions = largerDimensions(dimensions, nested.dimensions);
    } else if (level === 'ipco' && box.type === 'ispe') {
      if (
        box.end - box.payload < 12 ||
        bytes[box.payload] !== 0 ||
        bytes[box.payload + 1] !== 0 ||
        bytes[box.payload + 2] !== 0 ||
        bytes[box.payload + 3] !== 0
      ) {
        return { valid: false, dimensions: null, animated: false };
      }
      const candidate = validDimensions(
        readU32BE(bytes, box.payload + 4),
        readU32BE(bytes, box.payload + 8),
      );
      if (!candidate) return { valid: false, dimensions: null, animated: false };
      dimensions = largerDimensions(dimensions, candidate);
    }

    offset = box.next;
  }
  return { valid: offset === end, dimensions, animated: false };
}

function trackHeaderDimensions(bytes: Uint8Array, box: IsoBox): Dimensions | null {
  if (box.end - box.payload < 4) return null;
  const version = bytes[box.payload];
  const dimensionOffset = version === 0 ? box.payload + 76 : version === 1 ? box.payload + 88 : -1;
  if (dimensionOffset < 0 || dimensionOffset + 8 > box.end) return null;
  return validDimensions(
    Math.ceil(readU32BE(bytes, dimensionOffset) / 0x1_0000),
    Math.ceil(readU32BE(bytes, dimensionOffset + 4) / 0x1_0000),
  );
}

function scanTrackBoxes(
  bytes: Uint8Array,
  start: number,
  end: number,
  level: 'moov' | 'trak',
): AvifScan {
  let dimensions: Dimensions | null = null;
  let animated = false;
  let offset = start;

  while (offset < end) {
    const box = readIsoBox(bytes, offset, end);
    if (!box) return { valid: false, dimensions: null, animated: false };

    if (level === 'moov' && box.type === 'trak') {
      animated = true;
      const nested = scanTrackBoxes(bytes, box.payload, box.end, 'trak');
      if (!nested.valid) return nested;
      if (nested.dimensions) dimensions = largerDimensions(dimensions, nested.dimensions);
    } else if (level === 'moov' && box.type === 'mvex') {
      animated = true;
    } else if (level === 'trak' && box.type === 'tkhd') {
      const candidate = trackHeaderDimensions(bytes, box);
      if (!candidate) return { valid: false, dimensions: null, animated: false };
      dimensions = largerDimensions(dimensions, candidate);
    }

    offset = box.next;
  }
  return { valid: offset === end, dimensions, animated };
}

function avifDetails(bytes: Uint8Array): RasterDetails | null {
  if (bytes.length < 16) return null;

  let hasBrand = false;
  let hasSequenceBrand = false;
  let hasFtyp = false;
  let animated = false;
  let dimensions: Dimensions | null = null;
  let offset = 0;

  while (offset < bytes.length) {
    const box = readIsoBox(bytes, offset, bytes.length);
    if (!box) return null;

    if (box.type === 'ftyp') {
      if (offset !== 0 || hasFtyp || box.end - box.payload < 8) return null;
      hasFtyp = true;
      hasBrand = isAvifBrand(ascii4(bytes, box.payload));
      hasSequenceBrand = ascii4(bytes, box.payload) === 'avis';
      for (let brand = box.payload + 8; brand + 4 <= box.end; brand += 4) {
        const compatibleBrand = ascii4(bytes, brand);
        hasBrand ||= isAvifBrand(compatibleBrand);
        hasSequenceBrand ||= compatibleBrand === 'avis';
      }
      if ((box.end - (box.payload + 8)) % 4 !== 0) return null;
    } else if (box.type === 'meta') {
      if (box.end - box.payload < 4) return null;
      const scan = scanAvifProperties(bytes, box.payload + 4, box.end, 'meta');
      if (!scan.valid) return null;
      if (scan.dimensions) dimensions = largerDimensions(dimensions, scan.dimensions);
    } else if (box.type === 'moov') {
      const scan = scanTrackBoxes(bytes, box.payload, box.end, 'moov');
      if (!scan.valid) return null;
      if (scan.dimensions) dimensions = largerDimensions(dimensions, scan.dimensions);
      animated ||= scan.animated;
    }

    offset = box.next;
  }
  return hasFtyp && hasBrand && dimensions
    ? { ...dimensions, animated: animated || hasSequenceBrand }
    : null;
}

/**
 * Detect the raster formats MDVIEW is willing to display or export.
 * This intentionally remains a signature-only check; use `inspectRaster` when
 * dimensions and structural header validation are required.
 */
export function sniffRasterMime(bytes: Uint8Array): RasterMime | null {
  if (bytesEqual(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (bytesEqual(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiEqual(bytes, 0, 'GIF87a') || asciiEqual(bytes, 0, 'GIF89a')) return 'image/gif';
  if (asciiEqual(bytes, 0, 'RIFF') && asciiEqual(bytes, 8, 'WEBP')) return 'image/webp';
  if (hasAvifFileType(bytes)) return 'image/avif';
  return null;
}

/**
 * Read encoded raster dimensions without invoking an image decoder. Parsing is
 * iterative over the supplied byte array (with fixed-depth ISO-BMFF helpers),
 * validates every traversed length before access, and never allocates from an
 * untrusted embedded size.
 */
export function inspectRaster(bytes: Uint8Array): RasterInfo | null {
  const mime = sniffRasterMime(bytes);
  let details: RasterDetails | null = null;
  if (mime === 'image/png') details = pngDetails(bytes);
  else if (mime === 'image/jpeg') {
    const dimensions = jpegDimensions(bytes);
    if (dimensions) details = { ...dimensions, animated: false };
  } else if (mime === 'image/gif') details = gifDetails(bytes);
  else if (mime === 'image/webp') details = webpDetails(bytes);
  else if (mime === 'image/avif') details = avifDetails(bytes);
  if (!mime || !details) return null;
  return { mime, ...details };
}
