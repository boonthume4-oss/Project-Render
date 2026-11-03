// Small, dependency-free image helpers for the generation adapters: media-type sniffing from magic bytes,
// pixel dimensions from PNG / JPEG / WebP headers, and output sizes from aspect ratio + resolution.

import { explicitAspect } from './http';
import type { ImageMediaType, ImageSize } from './types';

/** Media type from the first bytes, or null when it is not PNG / JPEG / WebP. */
export function sniffMediaType(buf: Uint8Array): ImageMediaType | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ascii(buf: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...buf.subarray(from, to));
}

/** Width/height read from the image header; null when the format or header is not recognised. */
export function imageDimensions(buf: Uint8Array): { width: number; height: number } | null {
  const type = sniffMediaType(buf);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  try {
    if (type === 'image/png' && buf.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) };
    if (type === 'image/jpeg') return jpegDimensions(buf, view);
    if (type === 'image/webp') return webpDimensions(buf, view);
  } catch {
    /* truncated header */
  }
  return null;
}

function jpegDimensions(buf: Uint8Array, view: DataView): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + view.getUint16(i + 2);
  }
  return null;
}

function webpDimensions(buf: Uint8Array, view: DataView): { width: number; height: number } | null {
  const chunk = ascii(buf, 12, 16);
  if (chunk === 'VP8X' && buf.length >= 30) {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width: w, height: h };
  }
  if (chunk === 'VP8 ' && buf.length >= 30) return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  if (chunk === 'VP8L' && buf.length >= 25) {
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return null;
}

export interface SizeLimits {
  /** Long side for 1K / 2K / 4K */
  longSide: Record<ImageSize, number>;
  min: number;
  max: number;
  /** Both sides are rounded to a multiple of this */
  step: number;
}

/**
 * Output width/height. The ratio comes from an explicit W:H aspect, else from the input image (Original),
 * else square. The long side follows the resolution, clamped to the provider limits.
 */
export function outputSize(
  aspect: string | undefined,
  imageSize: ImageSize | undefined,
  input: { width: number; height: number } | null,
  limits: SizeLimits,
): { width: number; height: number } {
  const ratioText = explicitAspect(aspect);
  let ratio = 1;
  if (ratioText) {
    const [w, h] = ratioText.split(':').map(Number);
    if (w > 0 && h > 0) ratio = w / h;
  } else if (input && input.width > 0 && input.height > 0) {
    ratio = input.width / input.height;
  }
  const long = Math.min(limits.max, limits.longSide[imageSize ?? '1K']);
  const fit = (v: number) => Math.min(limits.max, Math.max(limits.min, Math.round(v / limits.step) * limits.step));
  return ratio >= 1 ? { width: fit(long), height: fit(long / ratio) } : { width: fit(long * ratio), height: fit(long) };
}

/** Base64 of a binary image body; the media type comes from the magic bytes (headers can be wrong). Null if not an image. */
export function binaryToImage(buf: Uint8Array): { base64: string; mediaType: ImageMediaType } | null {
  const mediaType = sniffMediaType(buf);
  return mediaType ? { base64: Buffer.from(buf).toString('base64'), mediaType } : null;
}

/** Decoded header bytes of a base64 image (enough for sniffing and dimensions). */
export function base64Head(b64: string, bytes = 64 * 1024): Uint8Array {
  return Buffer.from(b64.slice(0, Math.ceil(bytes / 3) * 4), 'base64');
}
