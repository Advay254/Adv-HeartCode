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

/**
 * v1.2.7: the deploy seed lib/finalizeDeployment.js has always derived
 * inline -- extracted here so the admin test-deploy flow
 * (routes/adminTestDeploy.js) resolves a slug through EXACTLY the same code
 * as a real deployment rather than a second copy that could drift.
 *
 * `reference` is a checkout reference ("hc-<hex>", or "hctest-<hex>" for a
 * test deploy); the payment-reference prefix belongs to the reference
 * format, not to any hosting naming, so it is stripped before use as a
 * seed. If the type has a deploy_slug_pattern and it resolves to something
 * usable against the raw form values, that wins; otherwise (no pattern, or
 * a pattern that resolves to nothing) the stripped reference is the seed.
 */
function resolveDeploySeed(reference, pattern, rawFieldValues) {
  let seed = String(reference).replace(/^hc(?:test)?-/, '');
  if (pattern) {
    const resolved = resolveDeploySlugPattern(pattern, rawFieldValues || {});
    if (resolved) seed = resolved;
  }
  return seed;
}

// v1.2.7 (Admin Test Deploy): every test deployment's slug ends in this.
const TEST_SLUG_SUFFIX = '-test';
// ClarityHeart's own slug ceiling (see lib/clarityheart.js's SLUG_RE) --
// duplicated by value rather than imported to keep this module free of
// any DB/crypto dependency; lib/clarityheart.js re-checks it independently
// immediately before the API call regardless.
const MAX_SLUG_LENGTH = 63;

/**
 * Forces a deploy seed to a slug that ALWAYS ends in "-test" and always
 * fits ClarityHeart's 63-character ceiling *including* that suffix --
 * whatever the type's deploy_slug_pattern produced, however long, however
 * strange (empty, all symbols, already ending in "-test", ending in a
 * hyphen, over-long). Order matters and is the whole point:
 *   1. slugify the seed (same sanitizer every other slug here uses);
 *   2. drop ONE trailing "-test" if present, so a pattern that already
 *      ends in it is not doubled ("party-test" stays "party-test", not
 *      "party-test-test") -- and the function is idempotent;
 *   3. truncate the core so core + (optional unique token) + "-test" fits
 *      in 63 chars -- truncating AFTER appending would chop the suffix off
 *      the very thing it exists to guarantee;
 *   4. strip any trailing hyphen truncation exposed, fall back to "site"
 *      if nothing usable is left, and append the suffix.
 * `unique` (optional, [a-z0-9]) is spliced in before the suffix by the
 * caller when the plain result collides with an existing deployment.
 */
function forceTestSuffix(seed, { unique = '' } = {}) {
  let core = slugify(String(seed || ''));
  if (core.endsWith(TEST_SLUG_SUFFIX)) {
    core = core.slice(0, core.length - TEST_SLUG_SUFFIX.length);
  }
  const token = unique ? `-${unique}` : '';
  const room = MAX_SLUG_LENGTH - TEST_SLUG_SUFFIX.length - token.length;
  core = core.slice(0, Math.max(room, 1)).replace(/-+$/, '');
  if (!core) core = 'site';
  return `${core}${token}${TEST_SLUG_SUFFIX}`;
}

module.exports = {
  resolveDeploySlugPattern,
  extractFieldKeyReferences,
  resolveDeploySeed,
  forceTestSuffix,
  TEST_SLUG_SUFFIX
};
