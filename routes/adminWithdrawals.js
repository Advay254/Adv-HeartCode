'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../lib/asyncHandler');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { getRateLimitKey } = require('../lib/clientIp');
const { timingSafeEqual } = require('../lib/auth');
const throttle = require('../lib/loginThrottle');
const adminSecurity = require('../lib/adminSecurity');
const ps = require('../lib/paystackTransfers');
const { getActivePaystackKeys } = require('../lib/paystack');
const W = require('../lib/withdrawals');

// v1.2.18: the Withdrawals API. The admin here is the single owner account
// (ADMIN_USERNAME / ADMIN_PASSWORD): HeartCode has no other admin roles, so the
// admin session IS the owner. Every route needs it, and every route that
// changes anything also needs CSRF and accepts only its exact fields.
//
// Password and code mistakes count in the same login limits as the login page
// (per address, plus slow mode) and also in the withdrawal streak: 3 wrong in a
// row switches withdrawals off.

const router = express.Router();
router.use(requireAdminSession);

const pw = z.string().min(1).max(200);
const submitKey = z.string().regex(/^[a-f0-9]{32}$/);
const noteText = z.string().trim().max(100).regex(/^[\p{L}\p{N} .,'-]*$/u, 'The note can only use letters, numbers, spaces and . , \' -');
const nameText = z.string().trim().min(2).max(120).regex(/^[\p{L}\p{N} .,'&()\/-]+$/u, 'The name has characters that are not allowed.');
const codeText = z.string().trim().max(40).optional();

function bad(res, err) {
  const first = err && err.issues && err.issues[0];
  return res.status(400).json({ error: first && first.message && first.message !== 'Invalid' ? first.message : 'Some fields are missing or not valid.' });
}

/**
 * Checks the password (and, when two-step login is on and needCode is set, a
 * current app code; recovery codes are not accepted for money). Returns true
 * after sending an error response.
 */
async function confirmIdentity(req, res, { password, code, needCode }) {
  const pool = getPool();
  const key = getRateLimitKey(req);
  if (throttle.isLockedOut(key)) { res.status(429).json({ error: 'Too many attempts, try again later.' }); return true; }
  await throttle.applySlowModeDelay();
  const ok = timingSafeEqual(password, (process.env.ADMIN_PASSWORD || '').trim());
  if (!ok) {
    throttle.recordFailure(key);
    const n = await W.recordFailedAttempt(pool, 'password');
    res.status(401).json({ error: n >= W.MAX_FAILED_STREAK ? 'The password is not right. Withdrawals were switched off after 3 wrong tries in a row.' : 'The password is not right.' });
    return true;
  }
  if (needCode && await adminSecurity.isTwoStepActive(pool)) {
    if (!code) { res.status(400).json({ error: 'Enter a current code from your authenticator app.' }); return true; }
    const result = await adminSecurity.verifyLoginCode(pool, code, { allowRecovery: false });
    if (!result.ok) {
      throttle.recordFailure(key);
      const n = await W.recordFailedAttempt(pool, 'code');
      const msg = result.reason === 'unreadable'
        ? 'App codes cannot be read right now (the encryption key may have changed).'
        : 'That code is not right. Each code works once, so wait for the next one if you just used it.';
      res.status(401).json({ error: n >= W.MAX_FAILED_STREAK ? msg + ' Withdrawals were switched off after 3 wrong tries in a row.' : msg });
      return true;
    }
  }
  return false;
}

function wView(w) {
  return {
    id: w.id, reference: w.reference, status: w.status, label: w.recipient_label, type: w.recipient_type,
    masked: w.recipient_masked, name: w.recipient_name, currency: w.currency,
    amount: Number(w.amount), amountText: W.formatMinor(w.amount, w.currency),
    fee: w.fee == null ? null : Number(w.fee), feeText: w.fee == null ? null : W.formatMinor(w.fee, w.currency),
    note: w.note || '', failureReason: w.failure_reason || '',
    createdAt: new Date(w.created_at).toISOString(),
    otpExpiresAt: w.otp_expires_at ? new Date(w.otp_expires_at).toISOString() : null,
    completedAt: w.completed_at ? new Date(w.completed_at).toISOString() : null
  };
}
function settingsView(s) {
  return {
    enabled: s.enabled, currency: s.currency, waitHours: s.waitHours,
    maxPerWithdrawal: W.plainMajor(s.maxPerWithdrawal), maxPerDay: W.plainMajor(s.maxPerDay), reserve: W.plainMajor(s.reserve)
  };
}

// ---- overview ----
router.get('/overview', asyncHandler(async (req, res) => {
  const pool = getPool();
  const [s, keys, twoStep, rec] = await Promise.all([
    W.getSettings(pool), getActivePaystackKeys(), adminSecurity.isTwoStepActive(pool),
    pool.query('SELECT * FROM withdrawal_recipients ORDER BY added_at DESC')
  ]);
  res.json({
    settings: settingsView(s),
    paystackConfigured: Boolean(keys), mode: keys ? keys.mode : null,
    twoStepActive: twoStep,
    recipients: rec.rows.map(W.recipientView),
    tillEnabled: W.businessTypesEnabled(),
    feeAllowance: W.feeAllowance() ? W.plainMajor(W.feeAllowance()) : null,
    ipHint: ps.IP_HINT
  });
}));

// ---- balance ----
router.get('/balance', asyncHandler(async (req, res) => {
  const force = req.query.refresh === '1';
  const r = await W.readBalances({ force });
  if (!r.ok) return res.status(502).json({ error: r.message });
  const s = await W.getSettings(getPool());
  res.json({
    readAt: new Date(r.readAt).toISOString(), cached: r.cached, mode: r.mode || null, withdrawCurrency: s.currency,
    balances: r.balances.map((b) => ({ currency: b.currency, minor: b.balance, text: W.formatMinor(b.balance, b.currency) }))
  });
}));

// ---- banks for the bank account form ----
router.get('/banks', asyncHandler(async (req, res) => {
  const currency = req.query.currency === 'USD' ? 'USD' : 'KES';
  let r = await ps.listBanks(`currency=${currency}&type=kepss&perPage=100`);
  let list = r.ok && Array.isArray(r.data) ? r.data : [];
  if (!list.length) {
    r = await ps.listBanks(`country=kenya&currency=${currency}&perPage=100`);
    list = r.ok && Array.isArray(r.data) ? r.data : [];
  }
  if (!list.length) {
    return res.status(502).json({ error: r.ok ? 'Paystack returned no Kenyan banks for ' + currency + '.' : r.message });
  }
  res.json({
    banks: list.filter((b) => b && typeof b.code === 'string' && typeof b.name === 'string')
      .map((b) => ({ code: b.code, name: b.name })).sort((a, b) => a.name.localeCompare(b.name))
  });
}));

// ---- settings ----
const settingsSchema = z.object({
  enabled: z.boolean(),
  maxPerWithdrawal: z.string().max(20), maxPerDay: z.string().max(20), reserve: z.string().max(20),
  waitHours: z.number().int().min(1).max(720),
  currency: z.enum(['KES', 'USD']),
  password: pw
}).strict();

router.post('/settings', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const b = parsed.data;
  const perW = W.parseMajor(b.maxPerWithdrawal), perD = W.parseMajor(b.maxPerDay), reserve = W.parseMajor(b.reserve);
  if (!perW || !perD) return res.status(400).json({ error: 'The limits must be amounts greater than zero, with at most 2 decimals.' });
  if (reserve === null) return res.status(400).json({ error: 'The reserve must be an amount, with at most 2 decimals. Use 0 for none.' });
  if (perW > 100000000 || perD > 1000000000) return res.status(400).json({ error: 'That limit is higher than this screen allows.' });
  if (perD < perW) return res.status(400).json({ error: 'The daily limit cannot be lower than the per withdrawal limit.' });
  if (await confirmIdentity(req, res, { password: b.password, needCode: false })) return;

  const pool = getPool();
  const client = await pool.connect();
  let before, changed = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [W.LOCK_KEY]);
    before = await W.getSettings(client);
    const next = { withdrawals_enabled: String(b.enabled), withdrawals_max_per_withdrawal: perW, withdrawals_max_per_day: perD, withdrawals_reserve: reserve, withdrawals_wait_hours: b.waitHours, withdrawals_currency: b.currency, withdrawals_failed_streak: b.enabled ? 0 : before.failedStreak };
    if (before.maxPerWithdrawal !== perW) changed.push('Maximum per withdrawal is now ' + W.formatMinor(perW, b.currency));
    if (before.maxPerDay !== perD) changed.push('Maximum per day is now ' + W.formatMinor(perD, b.currency));
    if (before.reserve !== reserve) changed.push('Reserve is now ' + W.formatMinor(reserve, b.currency));
    if (before.waitHours !== b.waitHours) changed.push('Waiting period is now ' + b.waitHours + ' hours');
    if (before.currency !== b.currency) changed.push('Currency is now ' + b.currency);
    await W.putSettings(client, next);
    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* closed */ }
    throw err;
  } finally {
    client.release();
  }

  if (before.enabled !== b.enabled) {
    await W.audit(pool, { type: b.enabled ? 'withdrawals_enabled' : 'withdrawals_disabled', outcome: 'ok', detail: b.enabled ? 'Withdrawals switched on.' : 'Withdrawals switched off in Settings.' });
    W.notify(b.enabled ? 'withdrawals_enabled' : 'withdrawals_disabled', b.enabled ? 'Withdrawals switched on' : 'Withdrawals switched off', b.enabled ? 'Withdrawals were switched on.' : 'Withdrawals were switched off.');
  }
  if (changed.length) {
    await W.audit(pool, { type: 'settings_changed', outcome: 'ok', detail: changed.join('. ') + '.' });
    W.notify('withdrawal_settings_changed', 'Withdrawal settings changed', changed.join('. ') + '.');
  }
  res.json({ success: true, settings: settingsView(await W.getSettings(pool)) });
}));

// ---- emergency stop: no password on purpose ----
router.post('/emergency-stop', requireCsrf, asyncHandler(async (req, res) => {
  await W.switchOff(getPool(), {
    type: 'emergency_stop', title: 'Withdrawals stopped',
    message: 'The emergency stop was used. Withdrawals are switched off. Turning them on again needs the password.',
    detail: 'Emergency stop used.'
  });
  res.json({ success: true });
}));

// ---- recipients ----
const addSchema = z.object({
  label: z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} .,'&()\/-]+$/u, 'The label has characters that are not allowed.'),
  type: z.enum(['mpesa', 'till', 'bank']),
  number: z.string().trim().min(1).max(40),
  name: nameText,
  bankCode: z.string().trim().max(20).optional(),
  bankName: z.string().trim().max(120).optional(),
  currency: z.enum(['KES', 'USD']).optional(),
  password: pw,
  code: codeText
}).strict();

router.post('/recipients', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const b = parsed.data;
  const pool = getPool();

  let psType, bankCode, currency, number, bankName = null;
  if (b.type === 'mpesa') {
    const n = W.normalizeKenyanMobile(b.number);
    if (!n.ok) return res.status(400).json({ error: n.error });
    psType = 'mobile_money'; bankCode = 'MPESA'; currency = 'KES'; number = n.number;
  } else if (b.type === 'till') {
    if (!W.businessTypesEnabled()) {
      return res.status(409).json({ error: 'Till numbers are switched off. Paystack documents that Kenyan Till transfers need an account reference but does not say what it must contain, so this stays off until you confirm it with Paystack and set WITHDRAWAL_ENABLE_TILL=true.' });
    }
    if (!/^\d{5,7}$/.test(b.number.replace(/\s/g, ''))) return res.status(400).json({ error: 'A till number is 5 to 7 digits.' });
    psType = 'mobile_money_business'; bankCode = 'MPTILL'; currency = 'KES'; number = b.number.replace(/\s/g, '');
  } else {
    const digits = b.number.replace(/[\s-]/g, '');
    if (!/^\d{6,20}$/.test(digits)) return res.status(400).json({ error: 'A bank account number is 6 to 20 digits.' });
    if (!b.bankCode || !/^[A-Za-z0-9_-]{2,20}$/.test(b.bankCode)) return res.status(400).json({ error: 'Choose the bank.' });
    psType = 'kepss'; bankCode = b.bankCode; currency = b.currency || 'KES'; number = digits; bankName = b.bankName || null;
  }
  if (await confirmIdentity(req, res, { password: b.password, code: b.code, needCode: true })) return;

  const r = await ps.createRecipient({ type: psType, name: b.name, accountNumber: number, bankCode, currency });
  const masked = W.maskNumber(number);
  if (!r.ok || !r.data || typeof r.data.recipient_code !== 'string') {
    await W.audit(pool, { type: 'recipient_added', outcome: 'failed', detail: 'Paystack did not create ' + b.label + ' (' + masked + '): ' + (r.message || 'no recipient code returned') });
    return res.status(r.kind === 'unclear' ? 502 : 400).json({ error: r.message || 'Paystack did not return a recipient code.' });
  }
  const s = await W.getSettings(pool);
  try {
    const ins = await pool.query(
      `INSERT INTO withdrawal_recipients (label, recipient_type, bank_code, bank_name, currency, account_name, paystack_recipient_code, masked_number, usable_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($9 || ' hours')::interval) RETURNING *`,
      [b.label, b.type, bankCode, bankName, currency, b.name, r.data.recipient_code, masked, String(s.waitHours)]
    );
    const row = ins.rows[0];
    await W.audit(pool, { type: 'recipient_added', outcome: 'ok', detail: `Added ${b.label} (${b.type}, ${masked}). Usable after the waiting period.`, recipientId: row.id });
    W.notify('withdrawal_recipient_added', 'Withdrawal recipient added', `${b.label} (${masked}) was added. It can be used after ${s.waitHours} hours.`);
    res.json({ success: true, recipient: W.recipientView(row) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That account is already saved as a recipient.' });
    throw err;
  }
}));

router.post('/recipients/:id/disable', requireCsrf, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Not a valid recipient.' });
  const pool = getPool();
  const r = await pool.query(`UPDATE withdrawal_recipients SET status = 'disabled' WHERE id = $1 AND status = 'active' RETURNING *`, [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'That recipient is not active.' });
  const row = r.rows[0];
  await W.audit(pool, { type: 'recipient_disabled', outcome: 'ok', detail: `Disabled ${row.label} (${row.masked_number}).`, recipientId: id });
  W.notify('withdrawal_recipient_disabled', 'Withdrawal recipient disabled', `${row.label} (${row.masked_number}) was disabled.`);
  res.json({ success: true });
}));

router.post('/recipients/:id/delete', requireCsrf, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Not a valid recipient.' });
  const pool = getPool();
  const found = await pool.query('SELECT * FROM withdrawal_recipients WHERE id = $1', [id]);
  if (found.rowCount === 0) return res.status(404).json({ error: 'That recipient does not exist.' });
  const row = found.rows[0];
  // Best effort at Paystack (it only marks the recipient inactive there). Our copy is removed either way.
  const remote = await ps.deleteRecipient(row.paystack_recipient_code);
  await pool.query('DELETE FROM withdrawal_recipients WHERE id = $1', [id]);
  await W.audit(pool, { type: 'recipient_deleted', outcome: 'ok', detail: `Deleted ${row.label} (${row.masked_number}).${remote.ok ? '' : ' Paystack could not be told, so it may still be active there.'}`, recipientId: id });
  W.notify('withdrawal_recipient_deleted', 'Withdrawal recipient deleted', `${row.label} (${row.masked_number}) was deleted.`);
  res.json({ success: true, paystackUpdated: remote.ok });
}));

// ---- the withdrawal itself ----
const reviewSchema = z.object({ recipientId: z.number().int().positive(), amount: z.string().max(20) }).strict();

router.post('/review', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const amount = W.parseMajor(parsed.data.amount);
  if (!amount) return res.status(400).json({ error: 'Enter an amount greater than zero, with at most 2 decimals.' });
  const out = await W.reviewWithdrawal(getPool(), { recipientId: parsed.data.recipientId, amount });
  if (out.refused) return res.status(409).json({ error: out.refused });
  res.json({
    recipient: W.recipientView(out.recipient), currency: out.settings.currency, amount, amountText: W.formatMinor(amount, out.settings.currency),
    balanceText: W.formatMinor(out.balance, out.settings.currency), balanceAfterText: W.formatMinor(out.balanceAfter, out.settings.currency),
    reserveText: W.formatMinor(out.settings.reserve, out.settings.currency),
    feeNote: 'Paystack charges a fee per transfer and reports it only after the transfer. It is not known yet' + (W.feeAllowance() ? ', so ' + W.formatMinor(W.feeAllowance(), out.settings.currency) + ' is held back as an allowance when checking the reserve.' : '.'),
    readAt: new Date(out.readAt).toISOString()
  });
}));

router.get('/max', asyncHandler(async (req, res) => {
  const pool = getPool();
  const s = await W.getSettings(pool);
  const bal = await W.readBalanceFor(s.currency);
  if (!bal.ok) return res.status(502).json({ error: bal.message });
  const m = await W.computeMax(pool, s, bal.balance);
  res.json({ amount: W.plainMajor(m.max), limitedBy: m.why });
}));

const withdrawSchema = z.object({
  recipientId: z.number().int().positive(), amount: z.string().max(20), note: noteText.optional(),
  submitKey, password: pw, code: codeText
}).strict();

router.post('/withdraw', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = withdrawSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const b = parsed.data;
  const pool = getPool();
  const amount = W.parseMajor(b.amount);
  if (!amount) return res.status(400).json({ error: 'Enter an amount greater than zero, with at most 2 decimals.' });

  const refuse = async (status, message) => {
    const s = await W.getSettings(pool);
    await W.audit(pool, { type: 'withdrawal_attempt', outcome: 'refused', detail: message, recipientId: b.recipientId, amount, currency: s.currency });
    return res.status(status).json({ error: message });
  };

  const recent = await pool.query(`SELECT COUNT(*)::int AS n FROM withdrawal_audit WHERE event_type = 'withdrawal_attempt' AND created_at > NOW() - INTERVAL '1 hour'`);
  if (recent.rows[0].n >= W.maxAttemptsPerHour()) return refuse(429, 'Too many withdrawal attempts in the last hour. Try again later.');
  const s0 = await W.getSettings(pool);
  if (!s0.enabled) return refuse(409, 'Withdrawals are switched off. Turn them on in Settings first.');
  if (await adminSecurity.isTwoStepActive(pool) && !b.code) return res.status(400).json({ error: 'Enter a current code from your authenticator app.' });

  if (await confirmIdentity(req, res, { password: b.password, code: b.code, needCode: true })) return;

  const made = await W.createWithdrawal(pool, { recipientId: b.recipientId, amount, note: b.note, submitKey: b.submitKey });
  if (made.refused) return refuse(409, made.refused);
  if (made.existing) return res.json({ withdrawal: wView(made.withdrawal), duplicate: true });

  const done = await W.sendWithdrawal(pool, made.withdrawal);
  res.json({ withdrawal: wView(done) });
}));

router.get('/withdrawals/:id', asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Not a valid withdrawal.' });
  const w = await W.getById(getPool(), id);
  if (!w) return res.status(404).json({ error: 'That withdrawal does not exist.' });
  res.json({ withdrawal: wView(w) });
}));

router.post('/withdrawals/:id/refresh', requireCsrf, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Not a valid withdrawal.' });
  const pool = getPool();
  const w = await W.getById(pool, id);
  if (!w) return res.status(404).json({ error: 'That withdrawal does not exist.' });
  if (!W.OPEN.includes(w.status) && w.status !== 'expired') return res.json({ withdrawal: wView(w) });
  if (w.last_checked_at && Date.now() - new Date(w.last_checked_at).getTime() < 10000) return res.json({ withdrawal: wView(w), note: 'Checked a moment ago.' });
  const out = await W.lookupAndApply(pool, w);
  res.json({ withdrawal: wView(out.row), note: out.message || '' });
}));

const otpSchema = z.object({ otp: z.string().trim().regex(/^\d{4,10}$/, 'The Paystack code is digits only.'), password: pw }).strict();

router.post('/withdrawals/:id/otp', requireCsrf, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Not a valid withdrawal.' });
  const parsed = otpSchema.safeParse(req.body);
  if (!parsed.success) return bad(res, parsed.error);
  const pool = getPool();
  const w = await W.getById(pool, id);
  if (!w) return res.status(404).json({ error: 'That withdrawal does not exist.' });
  if (w.status !== 'awaiting_otp') return res.status(409).json({ error: 'That withdrawal is not waiting for a code.', withdrawal: wView(w) });
  if (w.otp_expires_at && new Date(w.otp_expires_at).getTime() < Date.now()) {
    const out = await W.lookupAndApply(pool, w);
    return res.status(409).json({ error: 'The time to enter the code has run out. Nothing was sent. Start again if you still want to withdraw.', withdrawal: wView(out.row) });
  }
  if (await confirmIdentity(req, res, { password: parsed.data.password, needCode: false })) return;
  const claimed = await W.claimForOtp(pool, id);
  if (!claimed) return res.status(409).json({ error: 'That withdrawal is no longer waiting for a code.', withdrawal: wView(await W.getById(pool, id)) });
  const out = await W.finalizeWithOtp(pool, claimed, parsed.data.otp);
  if (out.wrongCode) return res.status(400).json({ error: out.message || 'Paystack did not accept that code.', withdrawal: wView(out.row) });
  if (out.unclear) return res.status(502).json({ error: out.message + ' It will be checked with Paystack automatically. Do not start it again.', withdrawal: wView(out.row) });
  res.json({ withdrawal: wView(out.row) });
}));

// ---- history ----
const AUDIT_TYPES = ['recipient_added', 'recipient_disabled', 'recipient_deleted', 'settings_changed', 'withdrawals_enabled', 'withdrawals_disabled',
  'withdrawals_auto_off', 'emergency_stop', 'withdrawal_attempt', 'withdrawal_sent', 'otp_attempt', 'password_failed', 'paystack_result'];

router.get('/history', asyncHandler(async (req, res) => {
  const pool = getPool();
  const where = [], params = [];
  if (typeof req.query.type === 'string' && AUDIT_TYPES.includes(req.query.type)) { params.push(req.query.type); where.push(`event_type = $${params.length}`); }
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof req.query.from === 'string' && date.test(req.query.from)) { params.push(req.query.from); where.push(`created_at >= $${params.length}::date`); }
  if (typeof req.query.to === 'string' && date.test(req.query.to)) { params.push(req.query.to); where.push(`created_at < ($${params.length}::date + 1)`); }
  const before = Number(req.query.before);
  if (Number.isInteger(before) && before > 0) { params.push(before); where.push(`id < $${params.length}`); }
  const rows = await pool.query(
    `SELECT * FROM withdrawal_audit ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 26`, params);
  const more = rows.rows.length > 25;
  const events = rows.rows.slice(0, 25).map((e) => ({
    id: Number(e.id), type: e.event_type, outcome: e.outcome, detail: e.detail || '', reference: e.reference || '',
    amountText: e.amount == null ? '' : W.formatMinor(e.amount, e.currency), createdAt: new Date(e.created_at).toISOString()
  }));

  const ws = await pool.query('SELECT * FROM withdrawals ORDER BY id DESC LIMIT 50');
  const totals = await pool.query(
    `SELECT currency,
       COALESCE(SUM(amount) FILTER (WHERE status = 'success'), 0)::bigint AS sent,
       COUNT(*) FILTER (WHERE status = 'success')::int AS sent_count,
       COALESCE(SUM(amount) FILTER (WHERE status IN ('created', 'awaiting_otp', 'finalizing', 'processing', 'unknown')), 0)::bigint AS pending,
       COUNT(*) FILTER (WHERE status IN ('failed', 'reversed', 'expired'))::int AS not_sent_count,
       COALESCE(SUM(fee) FILTER (WHERE status = 'success'), 0)::bigint AS fees
     FROM withdrawals WHERE created_at >= date_trunc('month', NOW()) GROUP BY currency`);
  res.json({
    types: AUDIT_TYPES, events, nextBefore: more ? events[events.length - 1].id : null,
    withdrawals: ws.rows.map(wView),
    totals: totals.rows.map((t) => ({
      currency: t.currency, sent: W.formatMinor(t.sent, t.currency), sentCount: t.sent_count,
      pending: W.formatMinor(t.pending, t.currency), notSentCount: t.not_sent_count, fees: W.formatMinor(t.fees, t.currency)
    }))
  });
}));

module.exports = router;
