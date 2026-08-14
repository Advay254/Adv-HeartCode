const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const REQUEST_TIMEOUT_MS = 3000;

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
 * Resolves { currency, countryCode } for a visitor's IP via ip-api.com's
 * free tier (no key, 45 req/min). Falls back to { currency: 'USD',
 * countryCode: null } on ANY failure -- private/local IP, network error,
 * timeout, rate limit, malformed response. This only ever feeds a display
 * price or a payment-currency decision, both of which already have a safe
 * USD default, so it must never throw and take down a page render over a
 * best-effort geolocation lookup.
 *
 * In-memory cache keyed by IP, ~1 hour TTL -- avoids a repeat lookup for
 * the same visitor browsing multiple pages in one session. Resets on
 * server restart, same caveat as the rate limiters in lib/rateLimit.js.
 */
async function getCurrencyForIp(ip) {
  if (isPrivateOrLocalIp(ip)) {
    return { currency: 'USD', countryCode: null };
  }

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=countryCode,currency`,
      { signal: controller.signal }
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();

    const value = {
      currency: typeof data.currency === 'string' && data.currency ? data.currency : 'USD',
      countryCode: typeof data.countryCode === 'string' && data.countryCode ? data.countryCode : null
    };

    cache.set(ip, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err) {
    console.error('[GEOLOCATION] Failed to resolve currency for IP, defaulting to USD:', err.message);
    return { currency: 'USD', countryCode: null };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { getCurrencyForIp };
