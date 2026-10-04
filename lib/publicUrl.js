'use strict';

// v1.2.13: how a built snippet learns this site's public address.
//
// The codebase has no single settings row for the public URL. Two things
// exist: the PUBLIC_BASE_URL environment variable (already used by
// lib/reviews.js for review links) and the request's own address (used by
// routes/public.js for the sitemap, robots.txt and structured data). This
// helper uses the same two sources in the same order and adds no fixed
// fallback value of its own:
//
//   1. PUBLIC_BASE_URL, when it is set to a valid http(s) address.
//   2. Otherwise the address the admin is using right now (protocol and host
//      of the request).
//
// Set PUBLIC_BASE_URL in production so a snippet never depends on which
// address the admin happened to open the dashboard from.

function normalizeBase(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch (_err) {
    return null;
  }
}

/** Returns { url, source } where source is 'env' or 'request'. */
function resolvePublicBaseUrl(req) {
  const fromEnv = normalizeBase(process.env.PUBLIC_BASE_URL);
  if (fromEnv) return { url: fromEnv, source: 'env' };
  return { url: `${req.protocol}://${req.get('host')}`, source: 'request' };
}

module.exports = { resolvePublicBaseUrl, normalizeBase };
