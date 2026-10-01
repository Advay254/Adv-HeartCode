'use strict';

const sharp = require('sharp');

// v1.2.11: the one optional photo on a review. Two independent checks on the
// REAL bytes (the declared MIME type and the file extension are never
// trusted on their own), then a full decode, resize and re-encode to WebP
// here on the HeartCode side BEFORE anything is sent to ClarityHeart. The
// re-encode drops anything hidden inside the original file (metadata, EXIF,
// appended data, polyglot payloads), so what leaves this server is always a
// clean WebP regardless of what ClarityHeart does with it afterwards.

const REVIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const REVIEW_IMAGE_MAX_DIMENSION = 1200;
const ALLOWED_DECLARED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_DECODED_FORMATS = ['jpeg', 'png', 'webp'];

function sniffFormat(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) return 'png';
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) return 'webp';
  return null;
}

/**
 * Returns { ok: true, buffer, contentType } with a clean re-encoded WebP, or
 * { ok: false, error } with a message safe to show the reviewer.
 */
async function prepareReviewImage(buffer, declaredMimeType) {
  const badType = 'The photo must be a JPEG, PNG or WebP image.';

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: 'The photo file was empty.' };
  }
  if (buffer.length > REVIEW_IMAGE_MAX_BYTES) {
    return { ok: false, error: 'The photo is too large. Please choose one under 5 MB.' };
  }
  if (!ALLOWED_DECLARED_TYPES.includes(declaredMimeType)) {
    return { ok: false, error: badType };
  }

  const sniffed = sniffFormat(buffer);
  if (!sniffed) return { ok: false, error: badType };

  try {
    const pipeline = sharp(buffer, { failOn: 'error', limitInputPixels: 40 * 1000 * 1000 });
    const meta = await pipeline.metadata();
    if (!ALLOWED_DECODED_FORMATS.includes(meta.format) || meta.format !== sniffed) {
      return { ok: false, error: badType };
    }
    if (!meta.width || !meta.height) {
      return { ok: false, error: 'That photo could not be read.' };
    }

    const out = await pipeline
      .rotate()
      .resize({
        width: REVIEW_IMAGE_MAX_DIMENSION,
        height: REVIEW_IMAGE_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 82 })
      .toBuffer();

    return { ok: true, buffer: out, contentType: 'image/webp' };
  } catch (err) {
    return { ok: false, error: 'That photo could not be read. Please try a different one.' };
  }
}

module.exports = {
  prepareReviewImage,
  sniffFormat,
  REVIEW_IMAGE_MAX_BYTES,
  ALLOWED_DECLARED_TYPES
};
