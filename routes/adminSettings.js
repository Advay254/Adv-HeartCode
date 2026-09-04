const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { runGeoDiagnostic } = require('../lib/geolocation');
const { resolveClientIp } = require('../lib/clientIp');

const router = express.Router();
router.use(requireAdminSession);

// v1.0.6: a small, generic key/value surface over the already-existing
// site_settings table, starting with the one setting v1.0.6 actually
// needs (kenyan_payment_currency). Deliberately per-key routes rather than
// a single free-form "set any key" endpoint -- that would let the admin UI
// (or a CSRF-bypassing bug) write arbitrary settings keys the backend
// doesn't know about; each setting this app actually reads gets its own
// narrow, validated route instead.

router.get('/kenyan-payment-currency', asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    "SELECT value FROM site_settings WHERE key = 'kenyan_payment_currency'"
  );
  res.json({ value: result.rowCount > 0 ? result.rows[0].value : 'USD' });
}));

const updateKenyanCurrencySchema = z.object({
  value: z.enum(['USD', 'KES'])
});

router.put('/kenyan-payment-currency', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = updateKenyanCurrencySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'value must be "USD" or "KES"' });
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ('kenyan_payment_currency', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [parsed.data.value]
  );
  res.json({ value: parsed.data.value });
}));

// v1.1.9 hotfix Part 3: a master on/off switch for the DISPLAY-only
// currency conversion shown while browsing (routes/public.js's
// resolveVisitorPricing -- the home/explore/build pages' estimated
// price). Off (the default) means every visitor sees a plain USD price
// everywhere, with no geolocation lookup even attempted for pricing
// display. On restores the existing behavior: a geolocation-based local-
// currency estimate for most visitors, plus the Kenyan-specific handling
// above.
//
// This is DELIBERATELY separate from, and does not affect, the Kenyan
// charge-currency setting above or resolveChargeForCheckout -- that
// function decides what a visitor is actually BILLED and always runs
// its own geolocation check regardless of this toggle, since Kenya/KES
// billing is a distinct feature (whether M-Pesa is live on Paystack) and
// must keep working the same either way. This toggle only ever changes
// what's shown before checkout, never what's charged.
router.get('/currency-conversion', asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    "SELECT value FROM site_settings WHERE key = 'currency_conversion_enabled'"
  );
  const enabled = result.rowCount > 0 && result.rows[0].value === 'true';
  res.json({ enabled });
}));

const updateCurrencyConversionSchema = z.object({
  enabled: z.boolean()
});

router.put('/currency-conversion', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = updateCurrencyConversionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ('currency_conversion_enabled', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [String(parsed.data.enabled)]
  );
  res.json({ enabled: parsed.data.enabled });
}));

// v1.1.2 Part C: admin-configurable daily-per-IP cap on the public
// resend-details lookup (routes/public.js's POST /api/resend-details) —
// read fresh from this same row on every single request via
// lib/rateLimit.js's createDynamicRateLimiter, never cached, so a change
// here takes effect on the very next request.
const updateResendDetailsRateLimitSchema = z.object({
  value: z.coerce.number().int().min(1).max(1000)
});

router.get('/resend-details-rate-limit', asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    "SELECT value FROM site_settings WHERE key = 'resend_details_rate_limit_per_day'"
  );
  res.json({ value: result.rowCount > 0 ? result.rows[0].value : '1' });
}));

router.put('/resend-details-rate-limit', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = updateResendDetailsRateLimitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'value must be a whole number between 1 and 1000' });
  }

  const pool = getPool();
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ('resend_details_rate_limit_per_day', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [String(parsed.data.value)]
  );
  res.json({ value: parsed.data.value });
}));

// v1.1.1 Part D, updated v1.1.9 Part D: lets Advay confirm the local
// GeoLite2-Country database (data/GeoLite2-Country.mmdb) actually loaded
// and correctly resolves a given IP — by tapping a button in the
// dashboard he already uses from an Android phone, with no terminal/SSH
// access needed. Bypasses lib/geolocation.js's 1h cache entirely (every
// click is a fresh lookup) and returns the full attempt record (now
// always a single entry, since there's only one local database to check,
// not two competing third-party providers as before this version) — see
// lib/geolocation.js's runGeoDiagnostic for exactly what it records
// (success/failure, latency, error message).
//
// `ip` defaults to the requesting admin's own connection if not provided —
// genuinely useful as a smoke test (if THIS fails, something is broken
// regardless of the visitor's actual location), but not a substitute for
// testing with a real Kenyan visitor's IP (pulled from Render's own
// request logs) when the question is specifically "why did a Kenyan
// visitor see USD" — no single hardcoded "known Kenyan IP" here would be
// reliable evidence either way, so this deliberately doesn't guess one.
const geoDiagnosticQuerySchema = z.object({
  ip: z.string().trim().min(1).max(64).optional()
});

router.get('/geo-diagnostic', asyncHandler(async (req, res) => {
  const parsed = geoDiagnosticQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid ip query parameter' });
  }

  // v1.1.9 hotfix Part 2: this is the exact check that surfaced the bug —
  // a visitor testing from Kenya resolved to Belgium/EUR because req.ip
  // was landing on Cloudflare's own edge address (104.23.241.68), not
  // the visitor's. See lib/clientIp.js for the full explanation. A
  // manually-supplied `ip` query param (testing a specific address pulled
  // from Render's logs) always wins and bypasses this resolution
  // entirely — it's an explicit override, not "the requesting admin's own
  // connection".
  const clientIpInfo = resolveClientIp(req);
  const usedManualOverride = Boolean(parsed.data.ip);
  const testIp = parsed.data.ip || clientIpInfo.ip;

  const pool = getPool();
  const settingResult = await pool.query(
    "SELECT value FROM site_settings WHERE key = 'kenyan_payment_currency'"
  );
  const kenyanPaymentCurrency = settingResult.rowCount > 0 ? settingResult.rows[0].value : 'USD';

  try {
    const diagnostic = await runGeoDiagnostic(testIp);
    res.json({
      ...diagnostic,
      kenyanPaymentCurrency,
      // adminOwnIp is now the RESOLVED real IP (CF-Connecting-IP when
      // present, req.ip otherwise) rather than the raw req.ip this used
      // to report — reporting the pre-fix value here would have hidden
      // the very bug this diagnostic exists to catch.
      adminOwnIp: clientIpInfo.ip,
      // v1.1.9 hotfix Part 2: exactly which source resolved testIp, so
      // this class of bug is diagnosable at a glance instead of needing
      // another investigation — 'manual-override' (an explicit ?ip= was
      // given), 'cf-connecting-ip' (Cloudflare's header was present and
      // used), or 'req.ip' (no CF-Connecting-IP header was seen at all,
      // meaning Cloudflare genuinely isn't fronting this request).
      ipSource: usedManualOverride ? 'manual-override' : clientIpInfo.source,
      // The raw CF-Connecting-IP header value, or null if Cloudflare
      // didn't set it on this request at all.
      cfConnectingIpHeader: (typeof req.headers['cf-connecting-ip'] === 'string' && req.headers['cf-connecting-ip'])
        || null,
      // v1.1.9 hotfix Part 1: raw proxy-chain visibility, added after a
      // real trust-proxy misconfiguration (see server.js's trust proxy
      // comment) made req.ip resolve to a private/internal address for
      // every visitor. rawForwardedFor is the literal X-Forwarded-For
      // header text, and trustedHopChain is what Express's own trust
      // proxy resolution considered along the way (req.ips) — an empty
      // array here with a non-empty rawForwardedFor would itself be a
      // clear signal that trust proxy isn't trusting enough of the chain.
      // Kept alongside the CF-specific fields above since a regression
      // could in principle come from either layer.
      rawForwardedFor: req.headers['x-forwarded-for'] || null,
      trustedHopChain: req.ips
    });
  } catch (err) {
    console.error('[ADMIN-SETTINGS] Geo diagnostic failed unexpectedly:', err.message);
    res.status(500).json({ error: 'Diagnostic failed to run', details: err.message });
  }
}));

module.exports = router;
