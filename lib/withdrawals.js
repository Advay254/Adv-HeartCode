'use strict';

// v1.2.18: the rules for withdrawals from the Paystack balance. Routes call
// into this file; the checks that protect money all live here, on the server.
//
// Money rules in one place:
// - Amounts are whole numbers in the smallest unit (KES cents). No decimals.
// - Only saved recipients, only after their waiting period, only while
//   Withdrawals enabled is on.
// - The checks and the insert of a withdrawal happen in one transaction that
//   holds a database advisory lock, so two requests at the same moment are
//   handled one after the other and the second sees the first.
// - A withdrawal row exists BEFORE Paystack is called, with a unique reference.
//   Paystack is called at most once per row, and an unclear answer is never
//   retried: the row becomes 'unknown' and is settled by looking the reference
//   up (reconcile below).
// - Nothing here logs or returns a secret key, a password, an OTP or a full
//   phone or account number.

const crypto = require('crypto');
const ps = require('./paystackTransfers');
const { notifyAdminAlert } = require('./notifications');

const LOCK_KEY = 1218018; // advisory lock shared by every money-moving check and settings change
const OTP_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_STREAK = 3;
const BALANCE_CACHE_MS = 10 * 1000;

// ---- settings (site_settings rows, never exposed to public pages) ----
const SETTING_DEFAULTS = {
  withdrawals_enabled: 'false',
  withdrawals_max_per_withdrawal: '100000', // 1,000.00 in the smallest unit
  withdrawals_max_per_day: '300000',        // 3,000.00
  withdrawals_reserve: '0',
  withdrawals_wait_hours: '24',
  withdrawals_currency: 'KES',
  withdrawals_failed_streak: '0'
};
const SETTING_KEYS = Object.keys(SETTING_DEFAULTS);

async function getSettings(db) {
  const r = await db.query('SELECT key, value FROM site_settings WHERE key = ANY($1)', [SETTING_KEYS]);
  const v = { ...SETTING_DEFAULTS };
  for (const row of r.rows) if (row.value !== null) v[row.key] = row.value;
  const int = (x, d) => (Number.isSafeInteger(Number(x)) && Number(x) >= 0 ? Number(x) : d);
  return {
    enabled: v.withdrawals_enabled === 'true',
    maxPerWithdrawal: int(v.withdrawals_max_per_withdrawal, 100000),
    maxPerDay: int(v.withdrawals_max_per_day, 300000),
    reserve: int(v.withdrawals_reserve, 0),
    waitHours: Math.max(1, int(v.withdrawals_wait_hours, 24)),
    currency: /^[A-Z]{3}$/.test(v.withdrawals_currency) ? v.withdrawals_currency : 'KES',
    failedStreak: int(v.withdrawals_failed_streak, 0)
  };
}

async function putSettings(client, pairs) {
  for (const [key, value] of Object.entries(pairs)) {
    if (!SETTING_KEYS.includes(key)) continue;
    await client.query(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, String(value)]
    );
  }
}

function feeAllowance() {
  const n = Number(process.env.WITHDRAWAL_FEE_ALLOWANCE_MINOR || 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
function maxAttemptsPerHour() {
  const n = Number(process.env.WITHDRAWAL_MAX_ATTEMPTS_PER_HOUR || 10);
  return Number.isSafeInteger(n) && n > 0 ? n : 10;
}
function businessTypesEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.WITHDRAWAL_ENABLE_TILL || '').trim().toLowerCase());
}

// ---- amounts ----
/** "12.5" -> 1250. Returns null for anything that is not a plain amount with at most 2 decimals. */
function parseMajor(text) {
  const s = String(text == null ? '' : text).trim().replace(/,/g, '');
  const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
  return Number.isSafeInteger(minor) ? minor : null;
}
function formatMinor(n, currency) {
  const v = Math.max(0, Number(n) || 0);
  const whole = Math.floor(v / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (currency ? currency + ' ' : '') + whole + '.' + String(v % 100).padStart(2, '0');
}
function plainMajor(n) {
  const v = Math.max(0, Number(n) || 0);
  return Math.floor(v / 100) + '.' + String(v % 100).padStart(2, '0');
}

// ---- numbers ----
/** Returns { ok, number } in the format set by WITHDRAWAL_MPESA_FORMAT, or { ok:false, error }. */
function normalizeKenyanMobile(input) {
  let s = String(input == null ? '' : input).replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (!/^\d+$/.test(s)) return { ok: false, error: 'A mobile number can only contain digits, spaces and an optional leading +.' };
  let local; // 9 digits starting with 7 or 1
  if (/^254[17]\d{8}$/.test(s)) local = s.slice(3);
  else if (/^0[17]\d{8}$/.test(s)) local = s.slice(1);
  else if (/^[17]\d{8}$/.test(s)) local = s;
  else return { ok: false, error: 'Enter a Kenyan mobile number such as 0712345678, 0112345678 or +254712345678.' };
  const fmt = String(process.env.WITHDRAWAL_MPESA_FORMAT || '254').trim().toLowerCase();
  const number = fmt === 'local' ? '0' + local : fmt === 'plus' ? '+254' + local : '254' + local;
  return { ok: true, number };
}
function maskNumber(raw) {
  const digits = String(raw).replace(/\D/g, '');
  const n = digits.length <= 7 ? 3 : 4;
  return '**** ' + digits.slice(-n);
}
/** Removes any run of 6+ digits so a failure message can never carry a number. */
function scrub(text) {
  return String(text == null ? '' : text).replace(/\d{6,}/g, '***').slice(0, 300);
}

// ---- audit and notifications ----
async function audit(db, e) {
  try {
    await db.query(
      `INSERT INTO withdrawal_audit (event_type, outcome, detail, withdrawal_id, recipient_id, reference, amount, currency, actor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [e.type, e.outcome || 'ok', e.detail ? scrub(e.detail) : null, e.withdrawalId || null, e.recipientId || null,
        e.reference || null, Number.isSafeInteger(e.amount) ? e.amount : null, e.currency || null, e.actor || 'admin']
    );
  } catch (err) {
    console.error('[WITHDRAWALS] Could not write the audit log:', err.message);
  }
}
function notify(event, title, message) {
  notifyAdminAlert({ event, title, message: scrub(message) }).catch(() => {});
}

// ---- switching off ----
async function switchOff(pool, { type, title, message, detail }) {
  await putSettings(pool, { withdrawals_enabled: 'false' });
  await audit(pool, { type, outcome: 'ok', detail });
  notify(type, title, message);
}

/** Counts one wrong password or OTP. At 3 in a row, withdrawals switch off. Returns the new count. */
async function recordFailedAttempt(pool, kind) {
  const r = await pool.query(
    `INSERT INTO site_settings (key, value, updated_at) VALUES ('withdrawals_failed_streak', '1', NOW())
     ON CONFLICT (key) DO UPDATE SET value = (COALESCE(NULLIF(site_settings.value, ''), '0')::int + 1)::text, updated_at = NOW()
     RETURNING value`
  );
  const n = Number(r.rows[0].value);
  await audit(pool, { type: kind === 'otp' ? 'otp_attempt' : 'password_failed', outcome: 'failed', detail: `Wrong ${kind === 'otp' ? 'Paystack code' : kind === 'code' ? 'authenticator code' : 'password'} (${n} in a row).` });
  if (n >= MAX_FAILED_STREAK) {
    const s = await getSettings(pool);
    if (s.enabled) {
      await switchOff(pool, {
        type: 'withdrawals_auto_off',
        title: 'Withdrawals switched off',
        message: `Withdrawals were switched off automatically after ${n} wrong passwords or codes in a row. Turning them on again needs the password.`,
        detail: `Switched off automatically after ${n} wrong attempts in a row.`
      });
    }
  }
  return n;
}
async function resetFailedStreak(db) {
  await db.query(`UPDATE site_settings SET value = '0', updated_at = NOW() WHERE key = 'withdrawals_failed_streak' AND value <> '0'`);
}

// ---- balance (read live, cached for a few seconds so the refresh button is rate limited) ----
let balanceCache = null; // { at, balances }
async function readBalances({ force } = {}) {
  const now = Date.now();
  if (!force && balanceCache && now - balanceCache.at < BALANCE_CACHE_MS) return { ok: true, balances: balanceCache.balances, readAt: balanceCache.at, cached: true };
  const r = await ps.fetchBalances();
  if (!r.ok) return { ok: false, message: r.message, kind: r.kind };
  balanceCache = { at: Date.now(), balances: r.balances, mode: r.mode };
  return { ok: true, balances: r.balances, readAt: balanceCache.at, cached: false, mode: r.mode };
}
/** A read that must be live (used inside the lock): never served from the cache. */
async function readBalanceFor(currency) {
  const r = await readBalances({ force: true });
  if (!r.ok) return { ok: false, message: 'Could not read the Paystack balance: ' + r.message };
  const b = r.balances.find((x) => x.currency === currency);
  return { ok: true, balance: b ? b.balance : 0 };
}

async function inflightTotal(db, currency) {
  // Withdrawals that Paystack may not have debited yet.
  const r = await db.query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS n FROM withdrawals
     WHERE currency = $1 AND status IN ('created', 'awaiting_otp', 'finalizing', 'unknown')`, [currency]);
  return Number(r.rows[0].n);
}
async function usedLast24h(db, currency) {
  const r = await db.query(
    `SELECT COALESCE(SUM(amount), 0)::bigint AS n FROM withdrawals
     WHERE currency = $1 AND status NOT IN ('failed', 'reversed', 'expired') AND created_at > NOW() - INTERVAL '24 hours'`, [currency]);
  return Number(r.rows[0].n);
}

/** The largest amount allowed right now, with the reason it is limited. */
async function computeMax(db, settings, balance) {
  const inflight = await inflightTotal(db, settings.currency);
  const used = await usedLast24h(db, settings.currency);
  const byBalance = balance - inflight - settings.reserve - feeAllowance();
  const byDay = settings.maxPerDay - used;
  const candidates = [
    { v: byBalance, why: 'the balance after the reserve' },
    { v: settings.maxPerWithdrawal, why: 'the per withdrawal limit' },
    { v: byDay, why: 'what is left of the daily limit' }
  ];
  candidates.sort((a, b) => a.v - b.v);
  return { max: Math.max(0, candidates[0].v), why: candidates[0].why, inflight, used };
}

// ---- recipients ----
function recipientUsable(r) {
  return r.status === 'active' && new Date(r.usable_at).getTime() <= Date.now();
}
function recipientView(r) {
  const usableAt = new Date(r.usable_at).toISOString();
  const waiting = r.status === 'active' && new Date(r.usable_at).getTime() > Date.now();
  return {
    id: r.id, label: r.label, type: r.recipient_type, bankName: r.bank_name || '', currency: r.currency,
    name: r.account_name, masked: r.masked_number, status: r.status, waiting,
    usable: recipientUsable(r), addedAt: new Date(r.added_at).toISOString(), usableAt
  };
}

// ---- creating a withdrawal (checks, lock, insert) ----
/**
 * Returns { refused: 'message' } or { withdrawal, existing }. Does NOT call Paystack.
 * `existing` is true when this submit key was already used: the caller must not send.
 */
async function createWithdrawal(pool, { recipientId, amount, note, submitKey }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);

    const dup = await client.query('SELECT * FROM withdrawals WHERE submit_key = $1', [submitKey]);
    if (dup.rowCount > 0) {
      await client.query('COMMIT');
      return { withdrawal: dup.rows[0], existing: true };
    }

    const s = await getSettings(client);
    const rules = await checkRules(client, s, recipientId, amount);
    if (rules.message) { await client.query('ROLLBACK'); return { refused: rules.message, recipient: rules.recipient }; }
    const recipient = rules.recipient;

    const bal = await readBalanceFor(s.currency);
    if (!bal.ok) { await client.query('ROLLBACK'); return { refused: bal.message, recipient }; }
    const room = await computeMax(client, s, bal.balance);
    if (amount > bal.balance - room.inflight - feeAllowance() - s.reserve) {
      await client.query('ROLLBACK');
      return { refused: 'That would take the Paystack balance below the amount you keep in reserve (' + formatMinor(s.reserve, s.currency) + ').', recipient };
    }

    const reference = 'hcwd-' + crypto.randomUUID();
    const ins = await client.query(
      `INSERT INTO withdrawals (reference, submit_key, recipient_id, recipient_label, recipient_type, recipient_masked, recipient_name,
         paystack_recipient_code, currency, amount, balance_before, note, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'created') RETURNING *`,
      [reference, submitKey, recipient.id, recipient.label, recipient.recipient_type, recipient.masked_number, recipient.account_name,
        recipient.paystack_recipient_code, s.currency, amount, bal.balance, note || null]
    );
    await audit(client, { type: 'withdrawal_attempt', outcome: 'ok', detail: 'Checks passed. Sending to ' + recipient.label + '.', withdrawalId: ins.rows[0].id, recipientId: recipient.id, reference, amount, currency: s.currency });
    await client.query('COMMIT');
    return { withdrawal: ins.rows[0], existing: false };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* already closed */ }
    throw err;
  } finally {
    client.release();
  }
}

/** The checks that need no Paystack call. Returns { message } to refuse, or { recipient }. */
async function checkRules(db, s, recipientId, amount) {
  if (!s.enabled) return { message: 'Withdrawals are switched off. Turn them on in Settings first.' };
  if (!Number.isSafeInteger(amount) || amount <= 0) return { message: 'Enter an amount greater than zero.' };
  const rr = await db.query('SELECT * FROM withdrawal_recipients WHERE id = $1', [recipientId]);
  if (rr.rowCount === 0) return { message: 'That recipient does not exist. Money can only go to a saved recipient.' };
  const recipient = rr.rows[0];
  if (recipient.status !== 'active') return { message: 'That recipient is disabled.', recipient };
  if (new Date(recipient.usable_at).getTime() > Date.now()) {
    return { message: 'That recipient is in its waiting period until ' + new Date(recipient.usable_at).toUTCString() + '.', recipient };
  }
  if (recipient.currency !== s.currency) {
    return { message: 'That recipient is set up for ' + recipient.currency + ' but withdrawals are set to ' + s.currency + '.', recipient };
  }
  if (amount > s.maxPerWithdrawal) return { message: 'The most allowed per withdrawal is ' + formatMinor(s.maxPerWithdrawal, s.currency) + '.', recipient };
  const used = await usedLast24h(db, s.currency);
  if (used + amount > s.maxPerDay) {
    return { message: 'That would pass the daily limit of ' + formatMinor(s.maxPerDay, s.currency) + ' (' + formatMinor(used, s.currency) + ' already used in the last 24 hours).', recipient };
  }
  return { recipient };
}

/** For the review step: the same checks, no insert, live balance. */
async function reviewWithdrawal(pool, { recipientId, amount }) {
  const s = await getSettings(pool);
  const rules = await checkRules(pool, s, recipientId, amount);
  if (rules.message) return { refused: rules.message };
  const bal = await readBalanceFor(s.currency);
  if (!bal.ok) return { refused: bal.message };
  const inflight = await inflightTotal(pool, s.currency);
  const after = bal.balance - inflight - amount - feeAllowance();
  if (after < s.reserve) return { refused: 'That would take the Paystack balance below the amount you keep in reserve (' + formatMinor(s.reserve, s.currency) + ').' };
  return { recipient: rules.recipient, settings: s, balance: bal.balance, balanceAfter: bal.balance - inflight - amount, readAt: Date.now() };
}

// ---- state changes (all guarded, so repeats and out of order messages are safe) ----
const OPEN = ['created', 'awaiting_otp', 'finalizing', 'processing', 'unknown'];

async function transition(pool, reference, to, { from, extra = {}, allowReconFailed = false } = {}) {
  const sets = ['status = $2', 'updated_at = NOW()'];
  const params = [reference, to, from];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (extra.transferCode) add('transfer_code', extra.transferCode);
  if (extra.failureReason !== undefined) add('failure_reason', extra.failureReason);
  if (extra.fee !== undefined && Number.isSafeInteger(extra.fee)) add('fee', extra.fee);
  if (extra.otpExpiresAt) add('otp_expires_at', extra.otpExpiresAt);
  if (extra.failedByRecon !== undefined) add('failed_by_recon', extra.failedByRecon);
  else if (to !== 'failed') sets.push('failed_by_recon = false');
  if (['success', 'failed', 'reversed', 'expired'].includes(to)) sets.push('completed_at = NOW()');
  const r = await pool.query(
    `UPDATE withdrawals SET ${sets.join(', ')}
     WHERE reference = $1 AND (status = ANY($3) ${allowReconFailed ? "OR (status = 'failed' AND failed_by_recon = true)" : ''})
     RETURNING *`, params);
  return r.rows[0] || null;
}

async function announce(pool, row, to, why) {
  const label = row.recipient_label;
  const money = formatMinor(row.amount, row.currency);
  const map = {
    success: ['withdrawal_succeeded', 'Withdrawal succeeded', `${money} was sent to ${label} (${row.recipient_masked}).`],
    failed: ['withdrawal_failed', 'Withdrawal failed', `${money} to ${label} failed. The money stays in your Paystack balance. ${why || ''}`],
    reversed: ['withdrawal_reversed', 'Withdrawal reversed', `${money} to ${label} was reversed and returned to your Paystack balance. ${why || ''}`],
    expired: ['withdrawal_expired', 'Withdrawal expired', `${money} to ${label} was not confirmed with the Paystack code in time and expired.`]
  };
  const m = map[to];
  await audit(pool, { type: 'paystack_result', outcome: to === 'success' ? 'ok' : 'info', detail: `Status is now ${to}.${why ? ' ' + why : ''}`, withdrawalId: row.id, recipientId: row.recipient_id, reference: row.reference, amount: Number(row.amount), currency: row.currency });
  if (m) notify(m[0], m[1], m[2]);
}

/** Applies what Paystack says (webhook, lookup, or an answer to our own call). Returns the updated row or null if nothing changed. */
async function applyPaystackStatus(pool, row, psStatus, data) {
  const d = data || {};
  const fee = Number.isSafeInteger(d.fee_charged) ? d.fee_charged : undefined;
  const code = typeof d.transfer_code === 'string' ? d.transfer_code.slice(0, 60) : undefined;
  const reason = d.gateway_response ? scrub(d.gateway_response) : '';
  let updated = null;

  if (psStatus === 'success') {
    updated = await transition(pool, row.reference, 'success', { from: ['created', 'awaiting_otp', 'finalizing', 'processing', 'unknown', 'expired'], allowReconFailed: true, extra: { fee, transferCode: code, failureReason: null } });
    if (updated) await announce(pool, updated, 'success');
  } else if (psStatus === 'failed') {
    const why = reason || 'Paystack reported that the transfer failed.';
    updated = await transition(pool, row.reference, 'failed', { from: ['created', 'awaiting_otp', 'finalizing', 'processing', 'unknown', 'expired'], extra: { fee, transferCode: code, failureReason: why } });
    if (updated) await announce(pool, updated, 'failed', why);
  } else if (psStatus === 'reversed') {
    const why = reason || 'Paystack reversed the transfer and returned the money to your balance.';
    updated = await transition(pool, row.reference, 'reversed', { from: ['created', 'awaiting_otp', 'finalizing', 'processing', 'unknown', 'expired', 'success'], allowReconFailed: true, extra: { fee, transferCode: code, failureReason: why } });
    if (updated) await announce(pool, updated, 'reversed', why);
  } else if (psStatus === 'otp') {
    updated = await transition(pool, row.reference, 'awaiting_otp', { from: ['created', 'unknown'], extra: { transferCode: code, otpExpiresAt: new Date(new Date(row.created_at).getTime() + OTP_WINDOW_MS) } });
  } else if (['pending', 'processing', 'queued', 'received', 'sending'].includes(psStatus)) {
    updated = await transition(pool, row.reference, 'processing', { from: ['created', 'unknown', 'finalizing', 'awaiting_otp'], extra: { transferCode: code } });
  }
  return updated;
}

// ---- sending ----
/** Called once, by the request that created the row. Never retried. */
async function sendWithdrawal(pool, row) {
  const r = await ps.initiateTransfer({
    amount: Number(row.amount), recipient: row.paystack_recipient_code, reference: row.reference,
    reason: row.note || undefined, currency: row.currency,
    accountReference: row.recipient_type === 'till' ? row.reference : undefined
  });
  if (r.kind === 'ok') {
    const d = r.data || {};
    // Only a transfer that needs no code counts as a clean finish; one waiting for a code resets the streak when the code is accepted.
    if (d.status !== 'otp') await resetFailedStreak(pool);
    const code = typeof d.transfer_code === 'string' ? d.transfer_code.slice(0, 60) : undefined;
    let updated;
    if (d.status === 'otp') {
      updated = await transition(pool, row.reference, 'awaiting_otp', { from: ['created'], extra: { transferCode: code, otpExpiresAt: new Date(Date.now() + OTP_WINDOW_MS) } });
    } else if (['success', 'failed', 'reversed'].includes(d.status)) {
      updated = await applyPaystackStatus(pool, row, d.status, d);
    } else {
      updated = await transition(pool, row.reference, 'processing', { from: ['created'], extra: { transferCode: code } });
    }
    await audit(pool, { type: 'withdrawal_sent', outcome: 'ok', detail: 'Paystack accepted the request (' + scrub(d.status || 'no status') + ').', withdrawalId: row.id, reference: row.reference, amount: Number(row.amount), currency: row.currency });
    notify('withdrawal_started', 'Withdrawal started', `${formatMinor(row.amount, row.currency)} to ${row.recipient_label} (${row.recipient_masked}) was sent to Paystack.`);
    return updated || (await getById(pool, row.id));
  }

  if (r.kind === 'rejected') {
    const updated = await transition(pool, row.reference, 'failed', { from: ['created'], extra: { failureReason: scrub(r.message) } });
    await audit(pool, { type: 'withdrawal_sent', outcome: 'failed', detail: 'Paystack refused: ' + r.message, withdrawalId: row.id, reference: row.reference, amount: Number(row.amount), currency: row.currency });
    if (updated) notify('withdrawal_failed', 'Withdrawal failed', `${formatMinor(row.amount, row.currency)} to ${row.recipient_label} was refused by Paystack. Nothing was sent.`);
    return updated || (await getById(pool, row.id));
  }

  // Unclear. Do NOT send again. The reconcile job looks the reference up.
  const updated = await transition(pool, row.reference, 'unknown', { from: ['created'], extra: { failureReason: scrub(r.message) + ' It may or may not have been sent. It will be checked with Paystack automatically.' } });
  await audit(pool, { type: 'withdrawal_sent', outcome: 'failed', detail: 'Unclear answer from Paystack. Marked unknown, to be settled by reference lookup.', withdrawalId: row.id, reference: row.reference, amount: Number(row.amount), currency: row.currency });
  notify('withdrawal_unknown', 'Withdrawal state unclear', `${formatMinor(row.amount, row.currency)} to ${row.recipient_label}: Paystack did not answer clearly. It will be checked automatically. Do not send it again.`);
  return updated || (await getById(pool, row.id));
}

async function getById(db, id) {
  const r = await db.query('SELECT * FROM withdrawals WHERE id = $1', [id]);
  return r.rows[0] || null;
}

/** Claims an awaiting_otp row for finalising, so two submissions cannot both call Paystack. */
async function claimForOtp(pool, id) {
  const r = await pool.query(
    `UPDATE withdrawals SET status = 'finalizing', updated_at = NOW()
     WHERE id = $1 AND status = 'awaiting_otp' AND otp_expires_at > NOW() AND transfer_code IS NOT NULL RETURNING *`, [id]);
  return r.rows[0] || null;
}

/** Finalise with the OTP. Result: { row, wrongCode?, message? } */
async function finalizeWithOtp(pool, claimed, otp) {
  const r = await ps.finalizeTransfer(claimed.transfer_code, otp);
  if (r.kind === 'ok') {
    await resetFailedStreak(pool);
    const d = r.data || {};
    let updated;
    if (['success', 'failed', 'reversed'].includes(d.status)) updated = await applyPaystackStatus(pool, claimed, d.status, d);
    if (!updated) updated = await transition(pool, claimed.reference, 'processing', { from: ['finalizing'] });
    await audit(pool, { type: 'otp_attempt', outcome: 'ok', detail: 'Code accepted by Paystack.', withdrawalId: claimed.id, reference: claimed.reference, amount: Number(claimed.amount), currency: claimed.currency });
    return { row: updated || (await getById(pool, claimed.id)) };
  }
  if (r.kind === 'rejected') {
    const back = await transition(pool, claimed.reference, 'awaiting_otp', { from: ['finalizing'] });
    const keyProblem = r.status === 401 || r.status === 403;
    if (!keyProblem) await recordFailedAttempt(pool, 'otp');
    return { row: back || (await getById(pool, claimed.id)), wrongCode: !keyProblem, message: r.message };
  }
  await transition(pool, claimed.reference, 'unknown', { from: ['finalizing'], extra: { failureReason: 'Paystack did not answer clearly when the code was sent. It will be checked automatically.' } });
  await audit(pool, { type: 'otp_attempt', outcome: 'failed', detail: 'Unclear answer from Paystack. Marked unknown, to be settled by reference lookup.', withdrawalId: claimed.id, reference: claimed.reference });
  return { row: await getById(pool, claimed.id), message: r.message, unclear: true };
}

// ---- looking a reference up (reconcile and the Check now button) ----
async function lookupAndApply(pool, row) {
  const r = await ps.verifyTransfer(row.reference);
  await pool.query('UPDATE withdrawals SET last_checked_at = NOW() WHERE id = $1', [row.id]);
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  const expired = row.status === 'awaiting_otp' && row.otp_expires_at && new Date(row.otp_expires_at).getTime() < Date.now();

  if (r.kind === 'ok' && r.data && typeof r.data.status === 'string') {
    const changed = await applyPaystackStatus(pool, row, r.data.status, r.data);
    if (changed) return { row: changed, changed: true };
    if (expired && ['otp', 'pending'].includes(r.data.status)) return expireRow(pool, row);
    return { row: await getById(pool, row.id), changed: false };
  }
  if (r.kind === 'rejected' && (r.status === 404 || /not found/i.test(r.message))) {
    if (expired) return expireRow(pool, row);
    if (['created', 'unknown', 'finalizing'].includes(row.status) && ageMs > 30 * 60 * 1000) {
      const why = 'Paystack has no record of this transfer, so it was never sent.';
      const updated = await transition(pool, row.reference, 'failed', { from: ['created', 'unknown', 'finalizing'], extra: { failureReason: why, failedByRecon: true } });
      if (updated) await announce(pool, updated, 'failed', why);
      return { row: updated || (await getById(pool, row.id)), changed: Boolean(updated) };
    }
  }
  return { row: await getById(pool, row.id), changed: false, message: r.ok ? '' : r.message };
}
async function expireRow(pool, row) {
  const updated = await transition(pool, row.reference, 'expired', { from: ['awaiting_otp'] });
  if (updated) await announce(pool, updated, 'expired');
  return { row: updated || (await getById(pool, row.id)), changed: Boolean(updated) };
}

/** Scheduled job body. Only ever reads from Paystack; never sends money. */
async function reconcile(pool) {
  const r = await pool.query(
    `SELECT * FROM withdrawals
     WHERE (last_checked_at IS NULL OR last_checked_at < NOW() - INTERVAL '1 minute')
       AND (
         (status = 'awaiting_otp' AND otp_expires_at < NOW())
         OR (status IN ('created', 'unknown', 'finalizing') AND updated_at < NOW() - INTERVAL '2 minutes')
         OR (status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes')
       )
     ORDER BY id LIMIT 20`
  );
  let fixed = 0;
  for (const row of r.rows) {
    try {
      const out = await lookupAndApply(pool, row);
      if (out.changed) fixed++;
    } catch (err) {
      console.error('[WITHDRAWALS] Reconcile failed for one withdrawal:', err.message);
    }
  }
  return { checked: r.rowCount, fixed };
}

// ---- Paystack webhook (called after the signature has been verified) ----
async function handleTransferWebhook(pool, event) {
  const names = { 'transfer.success': 'success', 'transfer.failed': 'failed', 'transfer.reversed': 'reversed' };
  const psStatus = names[event.event];
  if (!psStatus) return;
  const d = event.data || {};
  const r = await pool.query('SELECT * FROM withdrawals WHERE reference = $1', [d.reference]);
  if (r.rowCount === 0) return; // not one of ours (for example made in the Paystack dashboard)
  const row = r.rows[0];
  if ((Number.isSafeInteger(d.amount) && d.amount !== Number(row.amount)) || (typeof d.currency === 'string' && d.currency.toUpperCase() !== row.currency)) {
    await audit(pool, { type: 'paystack_result', outcome: 'refused', detail: 'A transfer message did not match the saved amount or currency, so it was ignored.', withdrawalId: row.id, reference: row.reference });
    return;
  }
  await applyPaystackStatus(pool, row, psStatus, d);
}

module.exports = {
  LOCK_KEY, OTP_WINDOW_MS, MAX_FAILED_STREAK, SETTING_KEYS, OPEN,
  getSettings, putSettings, feeAllowance, maxAttemptsPerHour, businessTypesEnabled,
  parseMajor, formatMinor, plainMajor, normalizeKenyanMobile, maskNumber, scrub,
  audit, notify, switchOff, recordFailedAttempt, resetFailedStreak,
  readBalances, readBalanceFor, computeMax, recipientUsable, recipientView,
  createWithdrawal, reviewWithdrawal, sendWithdrawal, claimForOtp, finalizeWithOtp,
  lookupAndApply, reconcile, handleTransferWebhook, getById, applyPaystackStatus
};
