const { getPool } = require('../db/init');

const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Fetches every USD-based rate from open.er-api.com (free, no key) and
 * upserts it into exchange_rates in one round trip. On ANY failure
 * (network error, non-200, unexpected shape) this logs and returns without
 * throwing -- existing cached rates are left exactly as they were, so a
 * transient outage here never breaks a page render or a checkout; callers
 * just keep serving the last good rate until the next refresh succeeds.
 */
async function refreshExchangeRates() {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data || data.result !== 'success' || !data.rates || typeof data.rates !== 'object') {
      throw new Error('Unexpected response shape from open.er-api.com');
    }

    const entries = Object.entries(data.rates).filter(
      ([, rate]) => typeof rate === 'number' && Number.isFinite(rate) && rate > 0
    );
    if (entries.length === 0) {
      throw new Error('No usable rates in response');
    }

    const pool = getPool();
    const valuePlaceholders = [];
    const params = [];
    entries.forEach(([code, rate], i) => {
      const base = i * 2;
      valuePlaceholders.push(`('USD', $${base + 1}, $${base + 2}, NOW())`);
      params.push(code, rate);
    });

    await pool.query(
      `INSERT INTO exchange_rates (base_currency, target_currency, rate, fetched_at)
       VALUES ${valuePlaceholders.join(', ')}
       ON CONFLICT (base_currency, target_currency) DO UPDATE SET
         rate = EXCLUDED.rate,
         fetched_at = EXCLUDED.fetched_at`,
      params
    );

    console.log(`[CURRENCY] Refreshed ${entries.length} exchange rates.`);
  } catch (err) {
    console.error('[CURRENCY] Failed to refresh exchange rates -- keeping existing cached values:', err.message);
  }
}

/**
 * Reads the cached USD -> targetCurrency rate. Returns null if no rate is
 * cached for that currency at all (e.g. before the first successful
 * refresh, or an unrecognized/unsupported code). If the cached rate is
 * older than 24h, kicks off a non-blocking background refresh (errors from
 * which are already logged inside refreshExchangeRates and never surface
 * here) but still returns the stale-but-recent cached value immediately --
 * callers should never be made to wait on a live fetch just to render a
 * price.
 */
async function getRate(targetCurrency) {
  if (!targetCurrency || targetCurrency === 'USD') return 1;

  const pool = getPool();
  const result = await pool.query(
    'SELECT rate, fetched_at FROM exchange_rates WHERE base_currency = $1 AND target_currency = $2',
    ['USD', targetCurrency]
  );
  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  const ageMs = Date.now() - new Date(row.fetched_at).getTime();
  if (ageMs > STALE_AFTER_MS) {
    refreshExchangeRates().catch(() => {}); // fire-and-forget; own errors already logged
  }

  return Number(row.rate);
}

/**
 * Converts a USD amount to targetCurrency using the cached rate. If no
 * rate is available for that currency, this falls back to the RAW USD
 * amount -- and critically, also falls back the CURRENCY LABEL to 'USD' in
 * the same step. Never returns a raw/unconverted number under any label
 * other than the one it's actually denominated in -- that mismatch (a raw
 * number shown under the wrong currency code) is exactly the bug this
 * version exists to fix, so the fallback path is held to the same
 * standard as the success path, not treated as a lesser-effort escape
 * hatch.
 */
async function convertUsdTo(amountUsd, targetCurrency) {
  const usd = Number(amountUsd) || 0;

  if (!targetCurrency || targetCurrency === 'USD') {
    return { amount: round2(usd), currency: 'USD', rate: 1 };
  }

  try {
    const rate = await getRate(targetCurrency);
    if (rate == null) {
      return { amount: round2(usd), currency: 'USD', rate: null };
    }
    return { amount: round2(usd * rate), currency: targetCurrency, rate };
  } catch (err) {
    console.error('[CURRENCY] convertUsdTo failed, falling back to unconverted USD:', err.message);
    return { amount: round2(usd), currency: 'USD', rate: null };
  }
}

/**
 * Determines what currency a visitor should actually be CHARGED in --
 * server-side only, never trusts anything from the client. USD for
 * everyone except Kenyan visitors when the kenyan_payment_currency site
 * setting is explicitly 'KES' (default 'USD', flipped by the admin once
 * M-Pesa is set up on the Paystack account -- see routes/adminSettings.js).
 */
async function getChargeCurrencyForCountry(countryCode) {
  if (countryCode !== 'KE') return 'USD';

  const pool = getPool();
  const result = await pool.query(
    "SELECT value FROM site_settings WHERE key = 'kenyan_payment_currency'"
  );
  return result.rowCount > 0 && result.rows[0].value === 'KES' ? 'KES' : 'USD';
}

/**
 * Formats an amount for display with the correct currency symbol/code via
 * Intl -- e.g. formatMoney(25, 'USD') -> "$25.00", formatMoney(3250, 'KES')
 * -> "KES 3,250.00". Falls back to a plain "CODE amount" string rather than
 * throwing if `currencyCode` isn't a currency Intl recognizes (a defensive
 * guard against an unexpected code from geolocation, not an expected path).
 */
function formatMoney(amount, currencyCode) {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol'
    }).format(Number(amount) || 0);
  } catch (err) {
    return `${currencyCode} ${(Number(amount) || 0).toFixed(2)}`;
  }
}

module.exports = {
  refreshExchangeRates,
  getRate,
  convertUsdTo,
  getChargeCurrencyForCountry,
  formatMoney
};
