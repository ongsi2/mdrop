import { inspectRaster, type RasterInfo } from './raster.ts';

export const MAX_RASTER_DIMENSION = 8_192;
export const MAX_RASTER_PIXELS = 20_000_000;
export const MAX_DOCUMENT_RASTER_PIXELS = 64_000_000;
export const MAX_INLINE_RASTER_BYTES = 3 * 1024 * 1024;
export const RASTER_PIXELS_ATTRIBUTE = 'data-md-raster-pixels';

export function reserveRasterPixels(remaining: number, pixels: number): number | null {
  if (
    !Number.isSafeInteger(remaining) ||
    !Number.isSafeInteger(pixels) ||
    remaining < 0 ||
    pixels <= 0 ||
    pixels > remaining
  ) {
    return null;
  }
  return remaining - pixels;
}

export function withinRasterBudget(info: RasterInfo): boolean {
  return (
    info.width <= MAX_RASTER_DIMENSION &&
    info.height <= MAX_RASTER_DIMENSION &&
    info.width * info.height <= MAX_RASTER_PIXELS
  );
}

export function inspectSafeRaster(bytes: Uint8Array): RasterInfo | null {
  const info = inspectRaster(bytes);
  /* Animated formats can multiply decoded work by an attacker-controlled
     frame count. The document reader deliberately accepts static rasters only. */
  return info && !info.animated && withinRasterBudget(info) ? info : null;
}

/** Validate an embedded raster before its URL can reach a live image element. */
export function inspectSafeRasterDataUrl(value: string): RasterInfo | null {
  const match =
    /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([a-z0-9+/=\t\r\n ]+)$/i.exec(value);
  if (!match) return null;

  const payload = match[2].replace(/[\t\r\n ]/g, '');
  if (payload.length > Math.ceil(MAX_INLINE_RASTER_BYTES / 3) * 4 + 4) return null;

  try {
    const binary = atob(payload);
    if (binary.length > MAX_INLINE_RASTER_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    const info = inspectSafeRaster(bytes);
    return info?.mime === match[1].toLowerCase() ? info : null;
  } catch {
    return null;
  }
}
