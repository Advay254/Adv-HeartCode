const crypto = require('crypto');
const { getPool } = require('../db/init');
const { decrypt } = require('./crypto');
const { slugify } = require('./slugify');

// v1.1.9 Part A: replaces lib/cloudflarePages.js entirely (removed, not
// kept around unused — see this version's delivery notes). HeartCode no
// longer deploys each finished site to its own Cloudflare Pages project
// via the wrangler CLI; it POSTs the finished HTML to ClarityHeart, a
// separate, already-production-ready service that stores and serves site
// HTML by slug. Nothing about the client-facing flow changes — only what
// lib/finalizeDeployment.js calls at the moment it's time to put a site
// online.
//
// The real ClarityHeart API contract (confirmed against its actual
// source, not assumed): POST {base_url}/api/deploy, Authorization:
// Bearer <token>, body { html, slug }. Success: { success: true, slug,
// requestedSlug, url } — slug MAY differ from the one requested if
// ClarityHeart found a collision on its own side, so callers must always
// use the returned slug/url, never assume the requested one was honored.
// Failure: { success: false, error }, with 401 for auth problems, 400 for
// validation, 500 for storage failures.

// ClarityHeart's own stated slug contract: lowercase letters, digits, and
// hyphens, MUST start with a letter or digit (never a hyphen), 1-63
// characters total. This happens to land on the same 63-character ceiling
// Cloudflare Pages project names lived under (a DNS-label limit), but
// that's a coincidence worth noting, not something inherited from the old
// Cloudflare-specific code — this constant exists because ClarityHeart's
// own regex says so.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_SLUG_LENGTH = 63;

/**
 * Re-sanitizes a seed — already slugify()'d once upstream, either by
 * lib/deploySlug.js's resolveDeploySlugPattern() for a custom
 * deploy_slug_pattern, or implicitly by virtue of being a Paystack
 * reference (plain hex + a stripped "hc-" prefix) — against
 * ClarityHeart's OWN, stricter contract. Explicit and re-checked HERE,
 * immediately before the API call, rather than assumed "close enough"
 * from upstream sanitization, per this version's own build brief.
 *
 * slugify() (lib/slugify.js) already lowercases, strips to [a-z0-9-],
 * collapses repeated separators, and trims leading/trailing hyphens —
 * which already guarantees "doesn't start or end with a hyphen" for any
 * NON-EMPTY result. What slugify() alone does NOT guarantee, and what
 * this function exists to close:
 *   (a) a length under ClarityHeart's 63-character ceiling — slugify()
 *       deliberately leaves length-capping to each caller (see its own
 *       comment), since different callers have different limits;
 *   (b) a non-empty result at all — an all-symbol/all-hyphen seed (or an
 *       empty one) slugifies to "", which fails SLUG_RE outright;
 *   (c) truncating to MAX_SLUG_LENGTH can, in principle, cut a string
 *       right after a hyphen, exposing a NEW trailing hyphen that wasn't
 *       there in the untruncated slug — handled explicitly below, not
 *       assumed away.
 * Any seed that still doesn't pass SLUG_RE after all of the above falls
 * back to a guaranteed-valid random slug — a deploy must never fail
 * outright over an unusable seed.
 */
function sanitizeSlugForClarityHeart(seed) {
  let slug = slugify(String(seed || '')).slice(0, MAX_SLUG_LENGTH).replace(/-+$/, '');

  if (!SLUG_RE.test(slug)) {
    slug = `site-${crypto.randomBytes(4).toString('hex')}`;
  }

  return slug;
}

/**
 * Reads the single-row hosting_config, decrypts its API token, and
 * returns { baseUrl, apiToken } — or null if not configured yet, or if
 * the token can't be decrypted (missing/wrong ENCRYPTION_KEY, malformed
 * stored value). Same "treat as not configured rather than crash"
 * posture as lib/paystack.js's getActivePaystackKeys().
 */
async function getHostingConfig() {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM hosting_config WHERE id = 1');
  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  if (!row.base_url || !row.api_token_encrypted) return null;

  try {
    const apiToken = decrypt(row.api_token_encrypted);
    return { baseUrl: row.base_url, apiToken };
  } catch (err) {
    console.error('[CLARITYHEART] Failed to decrypt API token:', err.message);
    return null;
  }
}

/**
 * Deploys `htmlContent` to ClarityHeart under a slug derived from `seed`,
 * and returns { slug, url } — ALWAYS the values ClarityHeart's response
 * actually reports, never the requested seed assumed to have been
 * honored (see sanitizeSlugForClarityHeart's doc comment and this
 * version's build brief: ClarityHeart may change the slug on a collision
 * on its own side, and HeartCode no longer pre-checks for collisions
 * itself the way the old Cloudflare Pages path did — that responsibility
 * now belongs entirely to ClarityHeart, per its own documented contract).
 *
 * Throws a clear, specific error on any failure — a network/host problem,
 * an auth rejection, a validation failure, or a storage failure —
 * surfacing ClarityHeart's own `error` field directly where available,
 * never hidden behind a generic wrapper message.
 */
async function deployToClarityHeart(seed, htmlContent) {
  const config = await getHostingConfig();
  if (!config) {
    throw new Error('Hosting is not configured — set a base URL and API token on the Hosting admin page first.');
  }

  const slug = sanitizeSlugForClarityHeart(seed);

  let response;
  try {
    response = await fetch(`${config.baseUrl}/api/deploy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.apiToken}`,
        // v1.1.9 hotfix: a real-world "HTTP 403, non-JSON response" was
        // reported against a live ClarityHeart deployment. That signature
        // -- a non-JSON body alongside a 403 -- is the classic symptom of
        // an edge/WAF block page (e.g. Cloudflare's Bot Fight Mode or a
        // managed WAF rule) intercepting the request BEFORE it ever
        // reaches ClarityHeart's own application code, not a rejection
        // FROM that code (which, per its own documented contract, always
        // returns JSON even on failure). Node's built-in fetch sends no
        // User-Agent by default, which is a common trigger for exactly
        // this kind of generic bot filtering. Adding an honest, specific
        // one is a low-cost mitigation -- it can't fix a WAF rule that's
        // blocking on some other signal entirely, but it removes one
        // plausible cause. If this keeps happening after this change,
        // the next place to look is Cloudflare's Security settings for
        // whatever zone ClarityHeart's base URL lives on, not this code.
        'User-Agent': 'HeartCode-Deploy/1.1.9 (+server-to-server ClarityHeart integration)'
      },
      body: JSON.stringify({ html: htmlContent, slug })
    });
  } catch (err) {
    throw new Error(`Could not reach ClarityHeart at ${config.baseUrl}: ${err.message}`);
  }

  let data = null;
  try {
    data = await response.clone().json();
  } catch (err) {
    // v1.1.9 hotfix: surface a snippet of the actual response body
    // rather than just the HTTP status -- "non-JSON response (HTTP 403)"
    // alone gives no way to tell an edge/WAF block page (HTML, usually
    // with a recognizable title like "Attention Required" or "Access
    // denied") apart from some other unexpected non-JSON failure. Reads
    // from a clone taken BEFORE the failed .json() call above, not the
    // original response -- .json() already consumed the original
    // response's body stream by the time this catch runs, even though it
    // threw, so reading the original again here would return empty.
    // Truncated and stripped of newlines so one bad response can't spam
    // the logs or blow out this error message's length.
    let bodySnippet = '';
    try {
      const rawText = await response.text();
      bodySnippet = rawText.replace(/\s+/g, ' ').trim().slice(0, 200);
    } catch (readErr) {
      // Body already consumed or unreadable -- fall back to no snippet
      // rather than letting a diagnostic-only read throw past the real
      // error being reported.
    }
    throw new Error(
      `ClarityHeart returned a non-JSON response (HTTP ${response.status})` +
      (bodySnippet ? ` — body started with: "${bodySnippet}"` : '') +
      '. A non-JSON body on a failure usually means an edge/security layer (e.g. Cloudflare Bot Fight Mode or a WAF rule) blocked the request before it reached ClarityHeart itself — check that zone\'s Security settings if this persists.'
    );
  }

  if (!response.ok || !data || data.success !== true) {
    const errorMessage = (data && data.error) ? data.error : `ClarityHeart deploy failed (HTTP ${response.status})`;
    throw new Error(errorMessage);
  }

  if (!data.url || !data.slug) {
    throw new Error('ClarityHeart reported success but did not return a url/slug');
  }

  return { slug: data.slug, url: data.url };
}

module.exports = { deployToClarityHeart, sanitizeSlugForClarityHeart, getHostingConfig };
