'use strict';

// v1.2.15: rules for the media links on ad cards.
//
// This app never uploads, stores, fetches or measures media. A link is checked
// here as text only (it must be an https address), and the visitor's browser
// is the only thing that ever loads the file.

const LINK_MAX = 2000;
const ALT_MAX = 125;

const IMAGE_EXT = ['gif', 'webp', 'png', 'jpg', 'jpeg', 'svg', 'avif', 'apng'];
const VIDEO_EXT = ['mp4', 'webm', 'm4v', 'mov', 'ogv'];
// Image types that can be animated. Visitors with reduced motion or a data
// saver do not download these unless the card has a still image.
const MOVING_IMAGE_EXT = ['gif', 'webp', 'apng', 'avif'];

const RATIO_MIN = 1;
const RATIO_MAX = 100;
// Keeps a shape sensible: nothing flatter than 10:1 or taller than 1:10.
const RATIO_LIMIT = 10;

function extensionOf(link) {
  try {
    const path = new URL(link).pathname.toLowerCase();
    const match = path.match(/\.([a-z0-9]{2,5})$/);
    return match ? match[1] : '';
  } catch (_err) {
    return '';
  }
}

/** 'image', 'video' or null. A guess from the end of the link only. */
function guessKind(link) {
  const ext = extensionOf(link);
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (VIDEO_EXT.includes(ext)) return 'video';
  return null;
}

/** True when the file could be animated (any video, or a moving image type). */
function mayMove(link, kind) {
  if (kind === 'video') return true;
  return MOVING_IMAGE_EXT.includes(extensionOf(link));
}

/**
 * Checks one media link. Returns { ok: true, value } with the cleaned link, or
 * { ok: false, error }. Text checks only: nothing is requested.
 */
function validateMediaLink(raw, label) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return { ok: false, error: `${label} is required.` };
  if (Array.from(value).length > LINK_MAX) return { ok: false, error: `${label} is too long.` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s]/.test(value)) return { ok: false, error: `${label} must be a single link with no spaces.` };
  let url;
  try {
    url = new URL(value);
  } catch (_err) {
    return { ok: false, error: `${label} must be a full link starting with https://` };
  }
  if (url.protocol !== 'https:') return { ok: false, error: `${label} must start with https://` };
  if (url.username || url.password) return { ok: false, error: `${label} must not contain a username or password.` };
  if (!url.hostname || !url.hostname.includes('.')) return { ok: false, error: `${label} must point to a real web address.` };
  return { ok: true, value: url.href };
}

function validateAlt(raw) {
  const value = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!value) return { ok: false, error: 'Describe the media in a few words (alternative text is required).' };
  if (Array.from(value).length > ALT_MAX) return { ok: false, error: `Alternative text must be ${ALT_MAX} characters or fewer.` };
  if (/[<>]/.test(value)) return { ok: false, error: 'Alternative text must be plain text.' };
  return { ok: true, value };
}

function validateRatio(w, h) {
  const rw = Number(w);
  const rh = Number(h);
  if (!Number.isInteger(rw) || !Number.isInteger(rh) || rw < RATIO_MIN || rh < RATIO_MIN || rw > RATIO_MAX || rh > RATIO_MAX) {
    return { ok: false, error: `The shape needs two whole numbers between ${RATIO_MIN} and ${RATIO_MAX}.` };
  }
  if (rw / rh > RATIO_LIMIT || rh / rw > RATIO_LIMIT) {
    return { ok: false, error: `The shape cannot be flatter or taller than ${RATIO_LIMIT} to 1.` };
  }
  return { ok: true, value: { w: rw, h: rh } };
}

module.exports = {
  LINK_MAX,
  ALT_MAX,
  guessKind,
  mayMove,
  validateMediaLink,
  validateAlt,
  validateRatio
};
