const express = require('express');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { runGeoDiagnostic } = require('../lib/geolocation');

const router = express.Router();
router.use(requireAdminSession);

// v1.0.6: a small, generic key/value surface over the already-existing
// site_settings table, starting with the one setting v1.0.6 actually
// needs (kenyan_payment_currency). Deliberately per-key routes rather than
// a single free-form "set any key" endpoint -- that would let the admin UI
// (or a CSRF-bypassing bug) write arbitrary settings keys the backend
// doesn't know about; each setting this app actually reads gets its own
// narrow, validated route instead.

router.get('/kenyan-payment-currency', async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    "SELECT value FROM site_settings WHERE key = 'kenyan_payment_currency'"
  );
  res.json({ value: result.rowCount > 0 ? result.rows[0].value : 'USD' });
});

const updateKenyanCurrencySchema = z.object({
  value: z.enum(['USD', 'KES'])
});

router.put('/kenyan-payment-currency', requireCsrf, async (req, res) => {
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
});

// v1.1.2 Part C: admin-configurable daily-per-IP cap on the public
// resend-details lookup (routes/public.js's POST /api/resend-details) —
// read fresh from this same row on every single request via
// lib/rateLimit.js's createDynamicRateLimiter, never cached, so a change
// here takes effect on the very next request.
const updateResendDetailsRateLimitSchema = z.object({
  value: z.coerce.number().int().min(1).max(1000)
});

router.get('/resend-details-rate-limit', async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    "SELECT value FROM site_settings WHERE key = 'resend_details_rate_limit_per_day'"
  );
  res.json({ value: result.rowCount > 0 ? result.rows[0].value : '1' });
});

router.put('/resend-details-rate-limit', requireCsrf, async (req, res) => {
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
});

// v1.1.1 Part D: lets Advay get REAL evidence of whether ip-api.com (and,
// if that fails, the ipwho.is fallback added this version) is actually
// reachable from Render's network — by tapping a button in the dashboard
// he already uses from an Android phone, with no terminal/SSH access
// needed. Bypasses lib/geolocation.js's 1h cache entirely (every click is
// a fresh, live attempt) and returns the FULL attempt trail, not just the
// final currency/country — see lib/geolocation.js's runGeoDiagnostic for
// what each attempt records (provider, success/failure, HTTP status,
// latency, error message).
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

router.get('/geo-diagnostic', async (req, res) => {
  const parsed = geoDiagnosticQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid ip query parameter' });
  }
  const testIp = parsed.data.ip || req.ip;

  const pool = getPool();
  const settingResult = await pool.query(
    "SELECT value FROM site_settings WHERE key = 'kenyan_payment_currency'"
  );
  const kenyanPaymentCurrency = settingResult.rowCount > 0 ? settingResult.rows[0].value : 'USD';

  try {
    const diagnostic = await runGeoDiagnostic(testIp);
    res.json({ ...diagnostic, kenyanPaymentCurrency, adminOwnIp: req.ip });
  } catch (err) {
    console.error('[ADMIN-SETTINGS] Geo diagnostic failed unexpectedly:', err.message);
    res.status(500).json({ error: 'Diagnostic failed to run', details: err.message });
  }
});

module.exports = router;
