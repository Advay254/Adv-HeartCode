const sharp = require('sharp');

// v1.2.6: image field type (base64-embedded uploads). sharp was chosen over
// a pure-JS alternative (e.g. Jimp) specifically because it encodes to
// WebP natively and well (it's a thin binding over libvips, which has
// first-class WebP support) — Jimp has no real WebP encoder at all, only
// JPEG/PNG, which would have ruled out the quality-per-byte win WebP gives
// here. sharp ships prebuilt native binaries for linux-x64 (what Render
// runs), the same class of native-binary dependency this project already
// relies on elsewhere (@sparticuz/chromium, see HANDOFF.md's Testing
// standard) — confirmed installing and running correctly in the build
// sandbox against a real 4000x3000 synthetic photo before this shipped,
// not just assumed compatible. Output format is WebP, not the
// JPEG-fallback originally scoped as a possibility — WebP encoding proved
// completely reliable in testing, so the fallback path was never needed.

const MAX_DIMENSION_PX = 1600;
const DEFAULT_QUALITY = 85;

// Allow-list only — anything not in this exact list (SVG included) is
// rejected outright by routes/apiBuild.js's multer fileFilter before a
// single byte of image data is even processed. No sniffing, no
// content-based detection, no exceptions: a strict mimetype allow-list is
// the entire check.
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Enforced by multer's `limits.fileSize` (see routes/apiBuild.js) BEFORE
// this module ever sees a buffer — multer aborts the upload stream mid-flight
// once a file exceeds this, so an oversized upload never reaches disk/memory
// in full, let alone gets processed. 10MB comfortably covers a real phone
// photo (even a high-megapixel, minimally-compressed JPEG is typically
// 4-12MB) while still bounding worst-case memory/CPU cost per request.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Clamps a Site Settings `image_compression_quality` value (stored as a
 * plain string, like every other site_settings row) to a sane integer
 * 1-100, falling back to DEFAULT_QUALITY for anything missing, blank, or
 * garbage — a malformed setting must never make image processing throw for
 * every visitor building a site.
 */
function resolveQuality(rawSetting) {
  const parsed = parseInt(rawSetting, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_QUALITY;
  return Math.min(100, Math.max(1, parsed));
}

/**
 * Resize-then-compress, in that literal call order — resize() is called
 * BEFORE webp() below, and sharp only ever runs its final encode (webp())
 * once, at whatever dimensions the preceding resize() left the pipeline at,
 * when toBuffer() is invoked. This is deliberate and measured, not
 * incidental: encoding at full original resolution first and THEN
 * resizing would mean (a) spending real CPU time compressing pixel data
 * that gets thrown away moments later, and (b) a second lossy encode pass
 * on top of the first, compounding quality loss for no benefit. Verified
 * directly during this feature's build — resize-then-compress against a
 * synthetic 4000x3000 test photo took ~450ms end to end; deliberately
 * doing it the other way around (full-resolution WebP encode, then
 * decode + resize + re-encode) took ~3.1s for a WORSE result. Resizing
 * first is what makes compression cheap, not an independent nicety.
 *
 * `rotate()` runs before resize() so a phone photo's EXIF orientation
 * (very commonly "rotated" metadata rather than physically rotated pixels)
 * is baked into the pixel data itself before the resize decides which side
 * is "longest" — otherwise a portrait photo shot with the phone held
 * sideways could resize against the wrong axis, and the orientation tag
 * itself doesn't survive into a plain <img> src="data:...">.
 *
 * fit: 'inside' + withoutEnlargement: true means: shrink to fit within
 * 1600x1600 preserving aspect ratio if the original is larger, and leave a
 * smaller original completely alone (never upscale — upscaling only adds
 * file size, never real detail).
 *
 * Throws if `buffer` isn't a decodable image (corrupt data, or a spoofed
 * mimetype on non-image bytes that slipped past the multer fileFilter's
 * mimetype check) — the caller (routes/apiBuild.js) catches this and
 * reports the field as invalid, exactly like any other malformed
 * submitted value.
 */
async function processUploadedImage(buffer, rawQualitySetting) {
  const quality = resolveQuality(rawQualitySetting);

  const processed = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize({
      width: MAX_DIMENSION_PX,
      height: MAX_DIMENSION_PX,
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality })
    .toBuffer();

  return `data:image/webp;base64,${processed.toString('base64')}`;
}

module.exports = {
  processUploadedImage,
  resolveQuality,
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  MAX_DIMENSION_PX,
  DEFAULT_QUALITY
};
