/**
 * Creates a simple in-memory sliding-window rate limiter keyed by an
 * arbitrary string (an IP address, here). Resets on server restart and is
 * per-process — same caveat as the login attempt limiter in
 * routes/adminAuth.js. Move to a DB-backed counter if this needs to
 * survive restarts or work correctly across multiple server instances.
 *
 * This is a separate, generic helper rather than a copy-pasted variant of
 * the login limiter because the two have genuinely different shapes: login
 * only counts FAILURES and applies a fixed lockout once a threshold is
 * crossed, while this counts every call within a true rolling window (old
 * hits age out continuously rather than the whole window resetting at
 * once). The existing login limiter is left as-is rather than retrofitted
 * onto this — it already works and isn't part of this version's scope.
 */
function createRateLimiter({ max, windowMs }) {
  const hits = new Map(); // key -> array of hit timestamps (ms)

  function prune(key) {
    const now = Date.now();
    const fresh = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (fresh.length > 0) {
      hits.set(key, fresh);
    } else {
      hits.delete(key);
    }
    return fresh;
  }

  /**
   * If `key` is under its limit, records a hit and returns true.
   * If `key` is at/over its limit, returns false and records nothing.
   */
  function tryConsume(key) {
    const fresh = prune(key);
    if (fresh.length >= max) {
      return false;
    }
    fresh.push(Date.now());
    hits.set(key, fresh);
    return true;
  }

  return { tryConsume };
}

/**
 * v1.1.2 Part C: the first rate limit in this app whose cap an admin can
 * actually change without a code deploy — the resend-details endpoint's
 * daily-per-IP cap, backed by the `resend_details_rate_limit_per_day`
 * site_settings row. This is a genuinely different shape from
 * createRateLimiter above, not an overload of it: `max` there is a fixed
 * number baked in at limiter-creation time (used synchronously,
 * `tryConsume` returns a plain boolean), which can't represent "read
 * whatever the admin has it set to right now." Below, `getMax` is called
 * fresh on every single tryConsume() call — deliberately never cached —
 * so a change the admin makes takes effect on the very next request, not
 * after some TTL expires. Existing callers of createRateLimiter are
 * completely unaffected; this is purely additive.
 */
function createDynamicRateLimiter({ windowMs, getMax }) {
  const hits = new Map();

  function prune(key) {
    const now = Date.now();
    const fresh = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (fresh.length > 0) {
      hits.set(key, fresh);
    } else {
      hits.delete(key);
    }
    return fresh;
  }

  /**
   * Same contract as createRateLimiter's tryConsume, except async (it
   * awaits getMax() first) and the returned promise resolves to the
   * boolean rather than returning one synchronously.
   */
  async function tryConsume(key) {
    const max = await getMax();
    const fresh = prune(key);
    if (fresh.length >= max) {
      return false;
    }
    fresh.push(Date.now());
    hits.set(key, fresh);
    return true;
  }

  return { tryConsume };
}

module.exports = { createRateLimiter, createDynamicRateLimiter };
