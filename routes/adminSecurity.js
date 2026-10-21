'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../lib/asyncHandler');
const { getPool } = require('../db/init');
const { requireAdminSession, COOKIE_NAME, getSessionCookie } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { getSiteSettings } = require('../lib/siteSettings');
const { getRateLimitKey } = require('../lib/clientIp');
const { timingSafeEqual, destroyAllSessions, destroyOtherSessions, countSessions, getIdleTimeoutMs } = require('../lib/auth');
const throttle = require('../lib/loginThrottle');
const adminSecurity = require('../lib/adminSecurity');
const { getWeakSettings } = require('../lib/securityWarnings');
const { notifyAdminAlert } = require('../lib/notifications');
const { logEvent } = require('../lib/activityEvents');

// v1.2.17: the Security page's API. Every route is behind the admin session,
// and every route that changes anything is also behind CSRF protection.
// Anything that ends sessions or weakens the login also asks for the password
// again. Password and code mistakes here count in the same limits as the login
// itself (per address, and the global slow mode).

const router = express.Router();
router.use(requireAdminSession);

const passwordSchema = z.object({ password: z.string().min(1).max(200) });
const passwordCodeSchema = z.object({ password: z.string().min(1).max(200), code: z.string().min(1).max(40) });
const codeSchema = z.object({ code: z.string().min(1).max(40) });

/** Checks the admin password again. Returns a response to send, or null if fine. */
async function recheckPassword(req, res, password) {
  const key = getRateLimitKey(req);
  if (throttle.isLockedOut(key)) {
    res.status(429).json({ error: 'Too many attempts, try again later' });
    return true;
  }
  await throttle.applySlowModeDelay();
  const ok = timingSafeEqual(password, (process.env.ADMIN_PASSWORD || '').trim());
  if (!ok) {
    throttle.recordFailure(key);
    res.status(401).json({ error: 'The password is not right.' });
    return true;
  }
  return false;
}

/** Checks an app code or recovery code. Returns true (and responds) on failure. */
async function recheckCode(req, res, pool, code) {
  const result = await adminSecurity.verifyLoginCode(pool, code);
  if (result.ok) {
    if (result.method === 'recovery') req.usedRecoveryCode = true;
    return false;
  }
  throttle.recordFailure(getRateLimitKey(req));
  const message = result.reason === 'unreadable'
    ? 'App codes cannot be read right now (the encryption key may have changed). Use a recovery code.'
    : 'That code is not right.';
  res.status(401).json({ error: message });
  return true;
}

function alert(event, title, message) {
  notifyAdminAlert({ event, title, message }).catch(() => {});
}

router.get('/status', asyncHandler(async (req, res) => {
  const pool = getPool();
  const row = await adminSecurity.getRow(pool);
  const stats = throttle.getThrottleStats();
  const channels = await pool.query(
    "SELECT COUNT(*)::int AS n FROM notification_channels WHERE is_active = true AND channel_type IN ('webhook', 'gotify')"
  );
  const pendingFresh = Boolean(row.totp_pending_secret_encrypted && row.totp_pending_at
    && Date.now() - new Date(row.totp_pending_at).getTime() < 30 * 60 * 1000);

  res.json({
    twoStepEnabled: Boolean(row.totp_enabled),
    setupPending: !row.totp_enabled && pendingFresh,
    emergencySwitchActive: adminSecurity.emergencySwitchActive(),
    encryptionKeySet: adminSecurity.encryptionKeySet(),
    secretReadable: row.totp_enabled ? adminSecurity.secretReadable(row) : null,
    recoveryRemaining: row.totp_enabled ? adminSecurity.recoveryRemaining(row) : 0,
    recoveryTotal: adminSecurity.RECOVERY_COUNT,
    weakSettings: getWeakSettings(),
    sessionCount: await countSessions(pool),
    idleMinutes: Math.round(getIdleTimeoutMs() / 60000),
    slowModeActive: stats.slowModeActive,
    recentFailedLogins: stats.recentFailures,
    slowModeThreshold: stats.slowThreshold,
    alertChannelCount: channels.rows[0].n
  });
}));

router.post('/two-step/begin', requireCsrf, asyncHandler(async (req, res) => {
  if (adminSecurity.emergencySwitchActive()) {
    return res.status(409).json({ error: 'The emergency switch (ADMIN_DISABLE_TWO_STEP) is set, so two-step login cannot be turned on. Remove it from the environment first.' });
  }
  const settings = await getSiteSettings();
  const issuer = String(settings.site_title || 'HeartCode').replace(/[:]/g, ' ').slice(0, 60) + ' Admin';
  const result = await adminSecurity.beginSetup(getPool(), { account: 'admin', issuer });
  if (result.error === 'already_enabled') return res.status(409).json({ error: 'Two-step login is already on.' });
  if (result.error === 'no_encryption_key') {
    return res.status(409).json({ error: 'ENCRYPTION_KEY is not set, so the secret cannot be stored safely. Set it in the environment, restart, and try again.' });
  }
  res.json({ secret: result.secretDisplay, rawSecret: result.secret, otpauthUrl: result.otpauthUrl });
}));

router.post('/two-step/cancel', requireCsrf, asyncHandler(async (req, res) => {
  await adminSecurity.cancelSetup(getPool());
  res.json({ success: true });
}));

router.post('/two-step/enable', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter the 6 digit code from your app.' });
  if (adminSecurity.emergencySwitchActive()) {
    return res.status(409).json({ error: 'The emergency switch (ADMIN_DISABLE_TWO_STEP) is set. Remove it from the environment first.' });
  }
  const result = await adminSecurity.enableWithCode(getPool(), parsed.data.code);
  if (result.error === 'wrong_code') return res.status(400).json({ error: 'That code is not right. Check that the time on your phone is automatic, then try the next code.' });
  if (result.error === 'no_setup') return res.status(409).json({ error: 'Start the setup again to get a new key.' });
  if (result.error === 'already_enabled') return res.status(409).json({ error: 'Two-step login is already on.' });
  if (result.error) return res.status(409).json({ error: 'The saved key could not be read. Start the setup again.' });

  await logEvent(getPool(), { eventType: 'admin_config_changed', title: 'Two-step login turned on', detail: '' }).catch(() => {});
  alert('two_step_enabled', 'Two-step login turned on', 'Two-step login was turned on for the admin.');
  res.json({ success: true, recoveryCodes: result.recoveryCodes });
}));

router.post('/two-step/disable', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = passwordCodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter your password and a current code.' });
  if (await recheckPassword(req, res, parsed.data.password)) return;
  const pool = getPool();
  if (await recheckCode(req, res, pool, parsed.data.code)) return;

  await adminSecurity.disable(pool);
  await logEvent(pool, { eventType: 'admin_config_changed', title: 'Two-step login turned off', detail: '' }).catch(() => {});
  alert('two_step_disabled', 'Two-step login turned off', 'Two-step login was turned off for the admin.');
  if (req.usedRecoveryCode) alert('recovery_code_used', 'Recovery code used', 'A two-step recovery code was used to confirm turning two-step login off.');
  res.json({ success: true });
}));

router.post('/two-step/recovery-codes', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = passwordCodeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter your password and a current code.' });
  if (await recheckPassword(req, res, parsed.data.password)) return;
  const pool = getPool();
  if (await recheckCode(req, res, pool, parsed.data.code)) return;

  const codes = await adminSecurity.regenerateRecoveryCodes(pool);
  alert('recovery_codes_regenerated', 'Recovery codes replaced', 'New two-step recovery codes were made. The old ones no longer work.');
  if (req.usedRecoveryCode) alert('recovery_code_used', 'Recovery code used', 'A two-step recovery code was used to confirm making new recovery codes.');
  res.json({ success: true, recoveryCodes: codes });
}));

router.post('/sessions/logout-all', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter your password.' });
  if (await recheckPassword(req, res, parsed.data.password)) return;

  const count = await destroyAllSessions(getPool());
  res.clearCookie(COOKIE_NAME, { path: '/' });
  alert('sessions_ended_all', 'All admin sessions ended', `Every admin session was ended (${count} in total), including the one that asked.`);
  res.json({ success: true, ended: count });
}));

router.post('/sessions/logout-others', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = passwordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter your password.' });
  if (await recheckPassword(req, res, parsed.data.password)) return;

  const count = await destroyOtherSessions(getPool(), getSessionCookie(req));
  alert('sessions_ended_others', 'Other admin sessions ended', `${count} other admin session(s) were ended. The one that asked stays signed in.`);
  res.json({ success: true, ended: count });
}));

module.exports = router;
