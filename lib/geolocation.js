const path = require('path');
const maxmind = require('maxmind');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour -- unchanged from before this version

// v1.1.9 Part D: the GeoLite2-Country database file itself, committed
// directly into the repo (see README's "Self-hosted geolocation"
// section for exactly how Advay obtains and commits this, since there's
// no terminal available to run a download script). Resolved relative to
// this file's own directory, not process.cwd(), so it works the same
// regardless of what directory `node server.js` happens to be launched
// from.
const MMDB_PATH = path.join(__dirname, '..', 'data', 'GeoLite2-Country.mmdb');

const cache = new Map(); // ip -> { value, expiresAt }

const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[0-1])\.)/;

function isPrivateOrLocalIp(ip) {
  if (!ip) return true;
  let addr = ip;
  if (addr.startsWith('::ffff:')) addr = addr.slice(7); // IPv4-mapped IPv6
  if (addr === '::1' || addr === 'localhost') return true;
  return PRIVATE_IP_RE.test(addr);
}

// v1.1.9 Part D: static ISO 3166-1 alpha-2 country -> ISO 4217 currency
// mapping. GeoLite2-Country's database only resolves a COUNTRY code --
// unlike ip-api.com/ipwho.is (the two providers this replaces), which
// each returned a currency code directly -- so this is the piece that
// closes that gap, feeding the exact same "currency" value
// resolveVisitorPricing() (routes/public.js) already expects back from
// getCurrencyForIp(). This is DIFFERENT from lib/currency.js's live
// USD-to-X exchange RATES (refreshed every 24h from open.er-api.com,
// because rates genuinely move constantly) -- which country uses which
// currency changes on the order of years, not days, so this table
// doesn't need the .mmdb file's own periodic-refresh discipline (see
// README). Deliberately not exhaustive of all ~195 countries: any
// country missing here, or any lookup failure at all, falls straight
// through to the same safe "correctly-labeled USD" default this file
// already guaranteed before this version (see v1.0.6's changelog entry
// on why a wrong/missing rate must never display a mislabeled number) --
// see getCurrencyForIp below.
const COUNTRY_TO_CURRENCY = {
  // North America
  US: 'USD', CA: 'CAD', MX: 'MXN', BM: 'BMD',
  // Central America & Caribbean
  GT: 'GTQ', BZ: 'BZD', SV: 'USD', HN: 'HNL', NI: 'NIO', CR: 'CRC', PA: 'PAB',
  CU: 'CUP', DO: 'DOP', HT: 'HTG', JM: 'JMD', TT: 'TTD', BS: 'BSD', BB: 'BBD',
  PR: 'USD',
  // South America
  BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN', VE: 'VES', EC: 'USD',
  BO: 'BOB', PY: 'PYG', UY: 'UYU', GY: 'GYD', SR: 'SRD',
  // Eurozone
  AT: 'EUR', BE: 'EUR', CY: 'EUR', EE: 'EUR', FI: 'EUR', FR: 'EUR', DE: 'EUR',
  GR: 'EUR', IE: 'EUR', IT: 'EUR', LV: 'EUR', LT: 'EUR', LU: 'EUR', MT: 'EUR',
  NL: 'EUR', PT: 'EUR', SK: 'EUR', SI: 'EUR', ES: 'EUR', HR: 'EUR',
  ME: 'EUR', XK: 'EUR', // unilaterally use the Euro, not EU/Eurozone members
  // Other Europe
  GB: 'GBP', CH: 'CHF', NO: 'NOK', SE: 'SEK', DK: 'DKK', IS: 'ISK', PL: 'PLN',
  CZ: 'CZK', HU: 'HUF', RO: 'RON', BG: 'BGN', RS: 'RSD', UA: 'UAH', BY: 'BYN',
  MD: 'MDL', AL: 'ALL', MK: 'MKD', BA: 'BAM', RU: 'RUB', TR: 'TRY', GE: 'GEL',
  AM: 'AMD', AZ: 'AZN',
  // Africa
  NG: 'NGN', EG: 'EGP', ZA: 'ZAR', KE: 'KES', GH: 'GHS', ET: 'ETB', TZ: 'TZS',
  UG: 'UGX', DZ: 'DZD', MA: 'MAD', TN: 'TND', LY: 'LYD', SD: 'SDG', AO: 'AOA',
  MZ: 'MZN', ZM: 'ZMW', ZW: 'ZWL', NA: 'NAD', BW: 'BWP', RW: 'RWF',
  SN: 'XOF', CI: 'XOF', ML: 'XOF', BF: 'XOF', NE: 'XOF', TG: 'XOF', BJ: 'XOF', GW: 'XOF',
  CM: 'XAF', GA: 'XAF', CG: 'XAF', TD: 'XAF', CF: 'XAF', GQ: 'XAF',
  CD: 'CDF', SO: 'SOS', DJ: 'DJF', ER: 'ERN', SS: 'SSP', MW: 'MWK', MG: 'MGA',
  MU: 'MUR', SC: 'SCR', LS: 'LSL', SZ: 'SZL', CV: 'CVE', GM: 'GMD', GN: 'GNF',
  SL: 'SLL', LR: 'LRD',
  // Middle East
  SA: 'SAR', AE: 'AED', QA: 'QAR', KW: 'KWD', BH: 'BHD', OM: 'OMR', IQ: 'IQD',
  IR: 'IRR', IL: 'ILS', JO: 'JOD', LB: 'LBP', SY: 'SYP', YE: 'YER', PS: 'ILS',
  // Asia
  CN: 'CNY', JP: 'JPY', KR: 'KRW', IN: 'INR', PK: 'PKR', BD: 'BDT', LK: 'LKR',
  NP: 'NPR', BT: 'BTN', MM: 'MMK', TH: 'THB', VN: 'VND', LA: 'LAK', KH: 'KHR',
  MY: 'MYR', SG: 'SGD', ID: 'IDR', PH: 'PHP', TW: 'TWD', HK: 'HKD', MO: 'MOP',
  MN: 'MNT', KZ: 'KZT', UZ: 'UZS', TM: 'TMT', TJ: 'TJS', KG: 'KGS', AF: 'AFN',
  // Oceania
  AU: 'AUD', NZ: 'NZD', FJ: 'FJD', PG: 'PGK', SB: 'SBD', VU: 'VUV', WS: 'WST',
  TO: 'TOP', KI: 'AUD', TV: 'AUD', NR: 'AUD', FM: 'USD', MH: 'USD', PW: 'USD'
};

let readerPromise = null;
let readerLoadFailed = false;

/**
 * Opens data/GeoLite2-Country.mmdb exactly once per process -- cached in
 * this module-level promise, per this version's own requirement ("cached
 * at module load, not per-request") -- and every subsequent lookup reuses
 * that same reader. If the file is missing, unreadable, or fails to
 * parse, that's logged ONCE (not once per request, which would spam the
 * logs on every single visitor) and every later call short-circuits
 * straight to the safe USD fallback without retrying the open -- there's
 * no scenario where the file would appear mid-process-lifetime on
 * Render anyway (a fresh deploy is the only way the file's presence
 * changes, and that's a new process). See README's "Self-hosted
 * geolocation" section for how to obtain and commit this file.
 */
function getReader() {
  if (readerLoadFailed) return Promise.resolve(null);
  if (!readerPromise) {
    readerPromise = maxmind.open(MMDB_PATH).catch((err) => {
      readerLoadFailed = true;
      console.error(
        `[GEOLOCATION] Failed to open ${MMDB_PATH}: ${err.message} -- every visitor will see USD pricing until this is fixed. See README's "Self-hosted geolocation" section for how to obtain and commit the GeoLite2-Country database file.`
      );
      return null;
    });
  }
  return readerPromise;
}

/**
 * A single local lookup attempt, deliberately shaped like the old
 * multi-provider "attempt" record (provider/success/latencyMs/error/
 * countryCode/currency) this file used to produce for EACH of
 * ip-api.com and ipwho.is -- purely so the existing admin geolocation
 * diagnostic UI (public/dashboard-assets/admin.js's initPaymentsPage,
 * unchanged by this version) keeps rendering correctly with zero changes
 * on that end: it was built to show a table of N attempts, and N is just
 * always 1 now. The near-zero latencyMs this reports is itself useful
 * signal on that panel -- visible proof this is no longer a network
 * round trip to a third-party service.
 */
async function lookupLocally(ip) {
  const start = Date.now();
  const reader = await getReader();

  if (!reader) {
    return {
      provider: 'GeoLite2-Country (local)',
      success: false,
      latencyMs: Date.now() - start,
      error: 'Database file not loaded — see server logs and README\'s "Self-hosted geolocation" section'
    };
  }

  try {
    const result = reader.get(ip);
    const countryCode = (result && result.country && typeof result.country.iso_code === 'string' && result.country.iso_code)
      ? result.country.iso_code
      : null;

    if (!countryCode) {
      return {
        provider: 'GeoLite2-Country (local)',
        success: false,
        latencyMs: Date.now() - start,
        error: 'IP not found in database'
      };
    }

    return {
      provider: 'GeoLite2-Country (local)',
      success: true,
      latencyMs: Date.now() - start,
      countryCode,
      currency: COUNTRY_TO_CURRENCY[countryCode] || null
    };
  } catch (err) {
    return {
      provider: 'GeoLite2-Country (local)',
      success: false,
      latencyMs: Date.now() - start,
      error: err.message
    };
  }
}

/**
 * Resolves { currency, countryCode } for a visitor's IP entirely from the
 * local GeoLite2-Country database -- no network call per request, no
 * rate limit, works offline once the .mmdb file is present (v1.1.9 Part
 * D; previously this fanned out to ip-api.com, then ipwho.is on
 * failure). Falls back to { currency: 'USD', countryCode: null } if the
 * database file failed to load, the IP isn't found in it, or its
 * resolved country isn't in COUNTRY_TO_CURRENCY above -- this only ever
 * feeds a display price or a payment-currency decision, both of which
 * already have a safe USD default, so it must never throw and take down
 * a page render.
 *
 * In-memory cache keyed by IP, ~1 hour TTL -- unchanged from before this
 * version. A local lookup is cheap enough that the cache is no longer
 * about avoiding expensive calls so much as it is about keeping the
 * per-visitor log line below at "once per unique IP per hour" instead of
 * once per request.
 */
async function getCurrencyForIp(ip) {
  if (isPrivateOrLocalIp(ip)) {
    return { currency: 'USD', countryCode: null };
  }

  const cached = cache.get(ip);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const attempt = await lookupLocally(ip);
  const value = attempt.success
    ? { currency: attempt.currency || 'USD', countryCode: attempt.countryCode }
    : { currency: 'USD', countryCode: null };

  console.log(
    `[GEOLOCATION] ip=${ip} -> ${attempt.success ? 'ok' : `FAILED (${attempt.error})`} ` +
    `currency=${value.currency} countryCode=${value.countryCode || 'null'} latency=${attempt.latencyMs}ms`
  );

  cache.set(ip, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * v1.1.9 Part D: bypasses the cache entirely and returns the full
 * attempt record (now always a single-element array — see lookupLocally
 * above) plus the final resolved value — used only by the admin
 * geolocation diagnostic (routes/adminSettings.js's GET /geo-diagnostic
 * and the "Geolocation health check" panel on the Payments admin page),
 * never by any request-serving code path. Lets Advay confirm the
 * database file actually loaded and a given IP resolves correctly, by
 * tapping a button in the dashboard already used from an Android phone —
 * no terminal or SSH access required.
 */
async function runGeoDiagnostic(ip) {
  if (isPrivateOrLocalIp(ip)) {
    return {
      ip,
      note: 'This IP is private/local — geolocation is always skipped for these (USD is returned immediately, regardless of database lookup health). Test with a real public IP address instead, e.g. one pulled from a real visitor in your logs.',
      attempts: [],
      finalResult: { currency: 'USD', countryCode: null }
    };
  }

  const attempt = await lookupLocally(ip);
  const finalResult = attempt.success
    ? { currency: attempt.currency || 'USD', countryCode: attempt.countryCode }
    : { currency: 'USD', countryCode: null };

  return { ip, attempts: [attempt], finalResult };
}

module.exports = { getCurrencyForIp, runGeoDiagnostic };
