const crypto = require('crypto');
const { slugify } = require('./slugify');

// v1.0.8 Part B: custom per-website-type deploy slug patterns, e.g.
// "happybirthday-from{{user_name}}-to{{recepient_name}}". Token syntax:
//   {{field_key}}              -> that field's raw submitted value
//   {{random}}                 -> 6 random mixed-case alphanumeric chars
//   {{random:N}}                -> N random mixed-case alphanumeric chars
//   {{random:numbers:N}}        -> N random digits
//   {{random:letters:N}}        -> N random letters (mixed case)
const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_:]+)\s*\}\}/g;

const MIXED_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LETTERS_ONLY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DIGITS_ONLY = '0123456789';
const MAX_RANDOM_LENGTH = 64; // sanity ceiling — nothing legitimate needs more

function randomFrom(charset, n) {
  const length = Math.min(Math.max(parseInt(n, 10) || 0, 0), MAX_RANDOM_LENGTH);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[crypto.randomInt(charset.length)];
  }
  return result;
}

function isRandomToken(token) {
  return token === 'random' || /^random:\d+$/.test(token) || /^random:numbers:\d+$/.test(token) || /^random:letters:\d+$/.test(token);
}

function resolveRandomToken(token) {
  if (token === 'random') return randomFrom(MIXED_ALNUM, 6);

  let m = token.match(/^random:(\d+)$/);
  if (m) return randomFrom(MIXED_ALNUM, m[1]);

  m = token.match(/^random:numbers:(\d+)$/);
  if (m) return randomFrom(DIGITS_ONLY, m[1]);

  m = token.match(/^random:letters:(\d+)$/);
  if (m) return randomFrom(LETTERS_ONLY, m[1]);

  return ''; // unreachable given isRandomToken already gated this
}

/**
 * Every {{...}} token in `pattern` that ISN'T a {{random...}} variant is a
 * field_key reference — used at website-type-save time (see
 * routes/adminWebsiteTypes.js) to warn about a pattern referencing a
 * field_key that doesn't exist for this website type, the same way
 * template placeholder validation already warns about unknown
 * {{field_key}} usage in the template HTML itself.
 */
function extractFieldKeyReferences(pattern) {
  if (!pattern) return [];
  const refs = new Set();
  let match;
  const re = new RegExp(TOKEN_RE.source, 'g');
  while ((match = re.exec(pattern)) !== null) {
    if (!isRandomToken(match[1])) refs.add(match[1]);
  }
  return [...refs];
}

/**
 * Resolves a deploy_slug_pattern against this submission's raw form field
 * values (raw fields only — see routes/apiBuild.js / pending_deployments'
 * raw_field_values column — never AI-output fields, so slug resolution
 * never depends on AI generation having succeeded). A referenced
 * field_key that doesn't exist (or wasn't submitted) resolves to an empty
 * string rather than throwing — the whole deploy must never fail over a
 * bad slug pattern reference; that mistake is instead caught as a WARNING
 * at save time via extractFieldKeyReferences above, not at a client's
 * actual checkout moment.
 *
 * Returns the fully sanitized (slugify()'d) result — same function every
 * other slug in this codebase uses, not a second implementation.
 */
function resolveDeploySlugPattern(pattern, rawFieldValues) {
  if (!pattern) return '';
  const values = rawFieldValues || {};

  const resolved = pattern.replace(TOKEN_RE, (fullMatch, token) => {
    if (isRandomToken(token)) return resolveRandomToken(token);

    const val = values[token];
    if (val === undefined || val === null) return '';
    if (Array.isArray(val)) return val.join(' '); // e.g. a checkboxes field referenced in a pattern
    return String(val);
  });

  return slugify(resolved);
}

module.exports = { resolveDeploySlugPattern, extractFieldKeyReferences };
