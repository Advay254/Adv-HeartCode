'use strict';

// v1.2.11: input rules for a review (reviewer submission AND admin edit go
// through exactly this code, so an edit can never slip past a limit the
// reviewer was held to). The server is the only enforcement that counts;
// maxlength and the live counter in the browser are convenience only.

const NAME_MIN = 2;
const NAME_MAX = 60;
const TESTIMONIAL_MIN = 20;
const TESTIMONIAL_MAX = 600;

// Control characters (except tab and newline, handled separately), C1
// controls, soft hyphen, combining grapheme joiner, Arabic letter mark,
// Hangul and Khmer fillers, zero width and bidi formatting characters,
// invisible math operators, BOM, and the deprecated/annotation specials.
// Variation selectors are deliberately NOT stripped, so a normal emoji keeps
// its presentation.
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFC]/g;
// Unicode "tag" characters: invisible, and a known way to smuggle hidden text.
const TAG_CHARS_RE = /[\u{E0000}-\u{E007F}]/gu;
const LINE_BREAKS_RE = /\r\n|\r|\u2028|\u2029|\u0085/g;
const HORIZONTAL_SPACE_RE = /[\t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

// A URL of any common shape: a scheme, www., a bare domain on a common TLD,
// or a script-style pseudo scheme.
const URL_RE = new RegExp(
  '(?:' +
    '[a-z][a-z0-9+.\\-]*:\\/\\/' +
    '|\\bwww\\.' +
    '|\\b(?:mailto|javascript|data|vbscript|file|ftp):' +
    '|\\b[a-z0-9](?:[a-z0-9\\-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9\\-]*[a-z0-9])?)*\\.(?:com|net|org|io|uk|ke|dev|app|info|biz|xyz|site|online|shop|store|link|ai|tv|top|club|live)\\b' +
  ')',
  'i'
);

// Anything that looks like an HTML tag, comment, doctype or processing
// instruction. A lone "<3" or "a < b" is fine; "<b", "</", "<!", "<?" is not.
const HTML_RE = /<\s*[a-z\/!?]/i;

function countChars(value) {
  return Array.from(value).length;
}

/**
 * Normalizes one text value: Unicode NFC, strips control and invisible
 * characters, turns odd spaces into plain ones, collapses runs of spaces,
 * and (for multiline text) trims every line and collapses runs of blank
 * lines into one. Single-line text has its line breaks turned into spaces.
 */
function normalizeText(raw, { multiline }) {
  if (typeof raw !== 'string') return '';
  let s = raw.normalize('NFC');
  s = s.replace(LINE_BREAKS_RE, '\n');
  s = s.replace(TAG_CHARS_RE, '').replace(INVISIBLE_RE, '');
  s = s.replace(HORIZONTAL_SPACE_RE, ' ');

  if (multiline) {
    s = s
      .split('\n')
      .map(line => line.replace(/ {2,}/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else {
    s = s.replace(/\n/g, ' ').replace(/ {2,}/g, ' ').trim();
  }
  return s;
}

function plainTextProblem(value, label) {
  if (HTML_RE.test(value)) {
    return `Please remove anything that looks like HTML from your ${label}.`;
  }
  if (URL_RE.test(value)) {
    return `Please remove the web address from your ${label}.`;
  }
  return null;
}

function validateName(raw) {
  const value = normalizeText(raw, { multiline: false });
  const length = countChars(value);
  if (length === 0) return { error: 'Please enter your name.', value };
  if (length < NAME_MIN) return { error: `Your name needs at least ${NAME_MIN} characters.`, value };
  if (length > NAME_MAX) return { error: `Your name can be at most ${NAME_MAX} characters.`, value };
  const problem = plainTextProblem(value, 'name');
  if (problem) return { error: problem, value };
  return { value };
}

function validateTestimonial(raw) {
  const value = normalizeText(raw, { multiline: true });
  const length = countChars(value);
  if (length === 0) return { error: 'Please write your review.', value };
  if (length < TESTIMONIAL_MIN) return { error: `Your review needs at least ${TESTIMONIAL_MIN} characters.`, value };
  if (length > TESTIMONIAL_MAX) return { error: `Your review can be at most ${TESTIMONIAL_MAX} characters.`, value };
  const problem = plainTextProblem(value, 'review');
  if (problem) return { error: problem, value };
  return { value };
}

function validateRating(raw) {
  const text = typeof raw === 'number' ? String(raw) : (typeof raw === 'string' ? raw.trim() : '');
  if (!/^[1-5]$/.test(text)) {
    return { error: 'Please choose a rating from 1 to 5 stars.', value: null };
  }
  return { value: Number(text) };
}

/**
 * Validates a full reviewer submission. Returns { ok, values, errors } where
 * errors is keyed by field name.
 */
function validateReviewSubmission({ name, testimonial, rating }) {
  const n = validateName(name);
  const t = validateTestimonial(testimonial);
  const r = validateRating(rating);
  const errors = {};
  if (n.error) errors.name = n.error;
  if (t.error) errors.testimonial = t.error;
  if (r.error) errors.rating = r.error;
  return {
    ok: Object.keys(errors).length === 0,
    values: { name: n.value, testimonial: t.value, rating: r.value },
    errors
  };
}

module.exports = {
  NAME_MIN,
  NAME_MAX,
  TESTIMONIAL_MIN,
  TESTIMONIAL_MAX,
  countChars,
  normalizeText,
  plainTextProblem,
  validateName,
  validateTestimonial,
  validateRating,
  validateReviewSubmission
};
