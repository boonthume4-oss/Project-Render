// Request body validation for image endpoints.

import { ACCEPTED_MEDIA_TYPES, AdapterError, type ImageInput, type ImageMediaType } from './adapters/types';

/** Anthropic's per-image limit is 5 MB of decoded data. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Image generation inputs (Gemini inline data / OpenAI edits) are allowed to be larger than vision inputs. */
export const MAX_GENERATION_IMAGE_BYTES = 20 * 1024 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function decodedBase64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function normalizeMediaType(v: unknown): ImageMediaType | null {
  if (typeof v !== 'string') return null;
  const m = v.trim().toLowerCase() === 'image/jpg' ? 'image/jpeg' : v.trim().toLowerCase();
  return (ACCEPTED_MEDIA_TYPES as readonly string[]).includes(m) ? (m as ImageMediaType) : null;
}

/**
 * Shared { imageBase64, mediaType } parsing. `prefix` names the field in messages (e.g. 'images[1].');
 * `tooLarge` builds the 413 message from the decoded size in MB.
 */
function parseImage(body: unknown, maxBytes: number, tooLarge: (mb: string) => string, prefix = ''): ImageInput {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  let data = typeof b.imageBase64 === 'string' ? b.imageBase64.trim() : '';
  let mediaType = normalizeMediaType(b.mediaType);

  // Accept a full data URL too
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(data);
  if (m) {
    mediaType = mediaType ?? normalizeMediaType(m[1]);
    data = m[2];
  }
  data = data.replace(/\s+/g, '');

  if (!data) throw new AdapterError('invalid_request', 400, `${prefix}imageBase64 is required.`);
  if (!mediaType) {
    throw new AdapterError('invalid_request', 400, `${prefix}mediaType must be image/jpeg, image/png or image/webp.`);
  }
  if (data.length % 4 !== 0 || !BASE64_RE.test(data)) {
    throw new AdapterError('invalid_request', 400, `${prefix}imageBase64 is not valid base64.`);
  }
  const bytes = decodedBase64Bytes(data);
  if (bytes > maxBytes) throw new AdapterError('image_too_large', 413, tooLarge((bytes / 1024 / 1024).toFixed(1)));
  return { base64: data, mediaType };
}

/** Validates { imageBase64, mediaType } and returns a clean ImageInput, or throws AdapterError(400/413). */
export function parseImageBody(body: unknown): ImageInput {
  return parseImage(body, MAX_IMAGE_BYTES, (mb) => `The image is ${mb} MB; the vision model accepts at most 5 MB per image.`);
}

/** One entry of the /api/generate `images` array; `index` is 0-based. Throws AdapterError(400/413). */
export function parseGenerationImage(item: unknown, index = 0): ImageInput {
  return parseImage(
    item,
    MAX_GENERATION_IMAGE_BYTES,
    (mb) => `Image ${index + 1} is ${mb} MB; image generation accepts at most 20 MB per image.`,
    `images[${index}].`,
  );
}
