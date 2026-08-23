const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const PRIMARY_TIMEOUT_MS = 2500;
const FALLBACK_TIMEOUT_MS = 2500;

const cache = new Map(); // ip -> { value, expiresAt }

const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

function isPrivateOrLocalIp(ip) {
  if (!ip) return true;
  let addr = ip;
  if (addr.startsWith('::ffff:')) addr = addr.slice(7); // IPv4-mapped IPv6
  if (addr === '::1' || addr === 'localhost') return true;
  return PRIVATE_IP_RE.test(addr);
}

/**
 * v1.1.1 Part D: queries ip-api.com's free tier (HTTP only, no key, capped
 * at 45 req/min PER SOURCE IP). Returns a detailed attempt record rather
 * than throwing or silently defaulting — the caller decides what to do
 * with a failure (try the fallback provider, or, in the diagnostic route,
 * show it directly to the admin).
 */
async function queryIpApi(ip, timeoutMs) {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,countryCode,currency`,
      { signal: controller.signal }
    );
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      return { provider: 'ip-api.com', success: false, httpStatus: res.status, latencyMs, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    if (data.status === 'fail') {
      // ip-api.com's own documented failure shape: HTTP 200, but
      // {"status":"fail","message":"..."} — most commonly seen for a
      // rate-limited or otherwise rejected query, or a genuinely
      // unresolvable IP. Treated as a failed attempt either way, not a
      // successful "no data" result.
      return { provider: 'ip-api.com', success: false, httpStatus: res.status, latencyMs, error: data.message || 'lookup failed (status: fail)' };
    }

    return {
      provider: 'ip-api.com',
      success: true,
      httpStatus: res.status,
      latencyMs,
      currency: typeof data.currency === 'string' && data.currency ? data.currency : null,
      countryCode: typeof data.countryCode === 'string' && data.countryCode ? data.countryCode : null
    };
  } catch (err) {
    return {
      provider: 'ip-api.com',
      success: false,
      latencyMs: Date.now() - start,
      error: err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * v1.1.1 Part D: fallback provider, queried ONLY when ip-api.com's attempt
 * (above) fails for any reason. ipwho.is was chosen specifically because
 * it differs from ip-api.com on both axes most likely to matter here: it's
 * HTTPS (ip-api.com's free tier is HTTP-only), and its free quota is a
 * generous 2,000/day rather than a tight 45/minute PER SOURCE IP — the
 * second of which matters a lot if Render pools outbound traffic from
 * multiple customers' services behind a shared egress IP, since ip-api.com
 * has no way to tell those apart from one very busy caller. See this
 * version's delivery notes for the full diagnosis writeup.
 */
async function queryIpWhoIs(ip, timeoutMs) {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,message,country_code,currency`,
      { signal: controller.signal }
    );
    const latencyMs = Date.now() - start;

    if (!res.ok) {
      return { provider: 'ipwho.is', success: false, httpStatus: res.status, latencyMs, error: `HTTP ${res.status}` };
    }

    const data = await res.json();
    if (data.success === false) {
      return { provider: 'ipwho.is', success: false, httpStatus: res.status, latencyMs, error: data.message || 'lookup failed (success: false)' };
    }

    const currencyCode = data.currency && typeof data.currency.code === 'string' && data.currency.code ? data.currency.code : null;
    const countryCode = typeof data.country_code === 'string' && data.country_code ? data.country_code : null;

    return { provider: 'ipwho.is', success: true, httpStatus: res.status, latencyMs, currency: currencyCode, countryCode };
  } catch (err) {
    return {
      provider: 'ipwho.is',
      success: false,
      latencyMs: Date.now() - start,
      error: err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Tries ip-api.com first, then — only on failure — ipwho.is. Deliberately
 * a FALLBACK TO A DIFFERENT PROVIDER, not a retry against the same host:
 * if ip-api.com is failing because a shared/pooled outbound IP has already
 * exhausted its 45/min cap, retrying the same host within the same window
 * is very unlikely to succeed, whereas a different provider on a different
 * network gets a genuinely fresh shot. Returns both the final result (null
 * if every provider failed) and the full list of attempts, so callers can
 * either use just the result (getCurrencyForIp) or show the whole
 * diagnostic trail (runGeoDiagnostic, for the admin dashboard).
 */
async function resolveViaProviders(ip) {
  const attempts = [];

  const primary = await queryIpApi(ip, PRIMARY_TIMEOUT_MS);
  attempts.push(primary);
  if (primary.success) {
    return { result: { currency: primary.currency || 'USD', countryCode: primary.countryCode }, attempts };
  }

  const fallback = await queryIpWhoIs(ip, FALLBACK_TIMEOUT_MS);
  attempts.push(fallback);
  if (fallback.success) {
    return { result: { currency: fallback.currency || 'USD', countryCode: fallback.countryCode }, attempts };
  }

  return { result: null, attempts };
}

/**
 * Resolves { currency, countryCode } for a visitor's IP. Falls back to
 * { currency: 'USD', countryCode: null } only if BOTH providers fail (see
 * resolveViaProviders above) — this only ever feeds a display price or a
 * payment-currency decision, both of which already have a safe USD
 * default, so it must never throw and take down a page render.
 *
 * In-memory cache keyed by IP, ~1 hour TTL — unchanged from before v1.1.1.
 *
 * v1.1.1 Part D: every FRESH (non-cached) resolution now logs one line —
 * "low-noise" specifically because the 1h cache means this fires at most
 * once per unique visitor per hour, not once per request. This is what
 * makes a real "geolocation is silently failing" outage visible in
 * Render's own logs going forward, which is exactly what was missing
 * before this version (see the diagnosis in this version's delivery
 * notes) — previously a total, systemic geolocation failure and a
 * perfectly ordinary non-Kenyan visitor looked byte-for-byte identical
 * from the outside: both just quietly returned USD.
 */
async function getCurrencyForIp(ip) {
  if (isPrivateOrLocalIp(ip)) {
    return { currency: 'USD', countryCode: null };
  }

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const { result, attempts } = await resolveViaProviders(ip);
  const value = result || { currency: 'USD', countryCode: null };

  const usedProvider = attempts.find(a => a.success);
  const attemptsSummary = attempts
    .map(a => `${a.provider}:${a.success ? 'ok' : 'fail'}(${a.latencyMs}ms${a.error ? ` "${a.error}"` : ''})`)
    .join(', ');
  console.log(
    `[GEOLOCATION] ip=${ip} -> ${usedProvider ? `provider=${usedProvider.provider}` : 'ALL PROVIDERS FAILED, defaulted to USD'} ` +
    `currency=${value.currency} countryCode=${value.countryCode || 'null'} attempts=[${attemptsSummary}]`
  );

  cache.set(ip, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * v1.1.1 Part D: bypasses the cache entirely and returns the FULL attempt
 * list (provider, success/failure, HTTP status, latency, error) plus the
 * final resolved value — used only by the admin geolocation diagnostic
 * (routes/adminSettings.js's GET /geo-diagnostic and the "Geolocation
 * health check" panel on the Payments admin page), never by any
 * request-serving code path. This is the tool that lets Advay get real,
 * first-party evidence of what's actually happening from Render's own
 * network — by tapping a button in the dashboard already used from an
 * Android phone, no terminal or SSH access required.
 */
async function runGeoDiagnostic(ip) {
  if (isPrivateOrLocalIp(ip)) {
    return {
      ip,
      note: 'This IP is private/local — geolocation is always skipped for these (USD is returned immediately, regardless of provider health). Test with a real public IP address instead, e.g. one pulled from a real visitor in your logs.',
      attempts: [],
      finalResult: { currency: 'USD', countryCode: null }
    };
  }

  const { result, attempts } = await resolveViaProviders(ip);
  return { ip, attempts, finalResult: result || { currency: 'USD', countryCode: null } };
}

module.exports = { getCurrencyForIp, runGeoDiagnostic };
