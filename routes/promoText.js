'use strict';

// v1.2.13: plain-text rules for everything a promotion can show.
//
// Promotion text is plain text only. HTML and URLs are rejected here, on the
// server, and every consumer also inserts it with safe text methods (the
// embed script uses textContent, the frame and snippet builders use
// escapeHtml), so this is a second layer and not the only one.

// A URL-like thing: an explicit scheme, a www. prefix, or a bare domain on a
// common top-level domain. Deliberately not "any word dot word", which would
// reject ordinary text such as "e.g." or two sentences typed without a space.
const URL_LIKE_RE = new RegExp(
  '(?:[a-z][a-z0-9+.-]*:\\/\\/)'
  + '|(?:\\bwww\\.)'
  + '|(?:\\b(?:mailto|javascript|data|tel):)'
  + '|(?:\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|net|org|io|co|uk|dev|app|me|ke|info|xyz|site|online|store|shop|biz|us|ai|gg|ly|link|page|pages|web|website|tech|tv|cc|to)\\b)',
  'i'
);

// Anything that looks like a tag, or an HTML entity (so "&lt;b&gt;" cannot be
// used to smuggle markup past a later unescape).
const HTML_LIKE_RE = /[<>]|&#?[a-z0-9]+;/i;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function countChars(value) {
  return Array.from(value).length;
}

/** Collapses every run of whitespace (including newlines) to one space. */
function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/**
 * Validates one plain-text value.
 * Returns { ok: true, value } (value is normalized and may be '') or
 * { ok: false, error }.
 */
function validatePlainText(raw, { max, label }) {
  const value = normalizeText(raw);
  if (CONTROL_RE.test(value)) {
    return { ok: false, error: `${label} contains characters that are not allowed.` };
  }
  if (HTML_LIKE_RE.test(value)) {
    return { ok: false, error: `${label} must be plain text. HTML is not allowed.` };
  }
  if (URL_LIKE_RE.test(value)) {
    return { ok: false, error: `${label} must not contain links or web addresses.` };
  }
  if (countChars(value) > max) {
    return { ok: false, error: `${label} must be ${max} characters or fewer.` };
  }
  return { ok: true, value };
}

/**
 * Trims text to about `max` characters, cleanly at a word boundary. Text that
 * already fits is returned unchanged. A cut adds three dots, after removing
 * any dangling punctuation left at the cut.
 */
function trimAtWord(text, max) {
  const clean = normalizeText(text);
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;

  // Leave room for the three dots so the result never exceeds max.
  const limit = Math.max(1, max - 3);
  let head = chars.slice(0, limit).join('');
  // If the cut lands inside a word, back up to the previous space.
  if (chars[limit] !== ' ') {
    const lastSpace = head.lastIndexOf(' ');
    if (lastSpace > 0) head = head.slice(0, lastSpace);
  }
  head = head.replace(/[\s,;:.\-!?]+$/u, '');
  return head + '...';
}

module.exports = { validatePlainText, trimAtWord, normalizeText, countChars };
