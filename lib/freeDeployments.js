'use strict';

// v1.2.21: everything specific to free ($0) deployments.
//
// The flow: a visitor picks a free type and enters an email at checkout. The
// server checks the rules below, stores a pending deployment plus a free
// claim, and emails a one-time link. Only when the link is opened (within the
// link lifetime, and while the day's cap has room) is the site deployed.
// Nothing here talks to Paystack.

const crypto = require('crypto');
const { getPool } = require('../db/init');
const { DISPOSABLE_DOMAINS } = require('./disposableDomains');

const DEFAULTS = {
  free_daily_cap: 10,         // free deployments (verified) per UTC day, 0 closes freebies
  free_verify_daily_max: 30,  // verification emails per UTC day, protects the email quota
  free_expiry_days: 7,        // how long a free site lives, 1 to 30
  free_link_minutes: 30       // how long the emailed link works, 5 to 120
};
const MAX_EXPIRY_DAYS = 30;
const IP_DAILY_MAX = 3;           // verification emails per IP per UTC day
const RESEND_COOLDOWN_MINUTES = 60; // an address with a live link cannot ask for another

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function getFreeSettings() {
  const result = await getPool().query(
    "SELECT key, value FROM site_settings WHERE key = ANY($1::text[])",
    [[...Object.keys(DEFAULTS), 'free_blocked_list']]
  );
  const raw = {};
  for (const row of result.rows) raw[row.key] = row.value;
  return {
    dailyCap: clampInt(raw.free_daily_cap, 0, 1000, DEFAULTS.free_daily_cap),
    verifyDailyMax: clampInt(raw.free_verify_daily_max, 0, 5000, DEFAULTS.free_verify_daily_max),
    expiryDays: clampInt(raw.free_expiry_days, 1, MAX_EXPIRY_DAYS, DEFAULTS.free_expiry_days),
    linkMinutes: clampInt(raw.free_link_minutes, 5, 120, DEFAULTS.free_link_minutes),
    blockedList: parseBlockedList(raw.free_blocked_list || '')
  };
}

// One entry per line: an email address or a domain. Lowercased, a leading "@"
// removed, blanks and duplicates dropped. Used both when saving and reading.
function parseBlockedList(text) {
  const seen = new Set();
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const entry = line.trim().toLowerCase().replace(/^@/, '');
    if (!entry || entry.length > 254 || /\s/.test(entry) || seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

async function saveFreeSettings(input) {
  const pool = getPool();
  const next = {
    free_daily_cap: String(clampInt(input.dailyCap, 0, 1000, DEFAULTS.free_daily_cap)),
    free_verify_daily_max: String(clampInt(input.verifyDailyMax, 0, 5000, DEFAULTS.free_verify_daily_max)),
    free_expiry_days: String(clampInt(input.expiryDays, 1, MAX_EXPIRY_DAYS, DEFAULTS.free_expiry_days)),
    free_link_minutes: String(clampInt(input.linkMinutes, 5, 120, DEFAULTS.free_link_minutes)),
    free_blocked_list: parseBlockedList(input.blockedList).join('\n')
  };
  for (const [key, value] of Object.entries(next)) {
    await pool.query(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  }
  return getFreeSettings();
}

/**
 * The same person must map to the same key however they type the address:
 * lowercase, anything after "+" in the local part dropped, and for Gmail the
 * dots removed and googlemail.com treated as gmail.com.
 */
function normalizeEmailKey(email) {
  const lower = String(email || '').trim().toLowerCase();
  const at = lower.lastIndexOf('@');
  if (at < 1) return lower;
  let local = lower.slice(0, at);
  let domain = lower.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** True when the address, or its domain (or a parent domain), is on the built-in or custom block list. */
function isBlockedEmail(email, customList = []) {
  const lower = String(email || '').trim().toLowerCase();
  const domain = lower.slice(lower.lastIndexOf('@') + 1);
  const keyed = normalizeEmailKey(lower);
  const blocked = new Set([...DISPOSABLE_DOMAINS, ...customList]);
  if (blocked.has(lower) || blocked.has(keyed)) return true;
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    if (blocked.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(`${process.env.SESSION_SECRET || ''}|${ip || ''}`).digest('hex').slice(0, 32);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function utcDayStart() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function freeDeploymentsToday(db = getPool()) {
  const r = await db.query("SELECT COUNT(*)::int AS n FROM free_claims WHERE status = 'verified' AND verified_at >= $1", [utcDayStart()]);
  return r.rows[0].n;
}

const EXHAUSTED_MESSAGE = "Today's free deployments have been used up. Please try again early tomorrow.";

/**
 * Applies every rule and, if they all pass, records the claim and returns the
 * one-time token to email. Returns { ok: true, token, expiresAt } or
 * { ok: false, code, message }. The caller sends the email.
 */
async function createFreeClaim({ email, ip, websiteTypeId, reference }) {
  const pool = getPool();
  const settings = await getFreeSettings();
  const emailKey = normalizeEmailKey(email);

  if (settings.dailyCap <= 0) return { ok: false, code: 'closed', message: 'Free deployments are not available right now.' };
  if (isBlockedEmail(email, settings.blockedList)) {
    return { ok: false, code: 'blocked', message: 'Please use a permanent email address. Temporary or blocked addresses cannot be used for free sites.' };
  }

  const verified = await pool.query("SELECT 1 FROM free_claims WHERE email_key = $1 AND status = 'verified' LIMIT 1", [emailKey]);
  if (verified.rowCount > 0) {
    return { ok: false, code: 'used', message: 'This email address has already been used for a free site. Each email gets one.' };
  }

  // A live, unopened link already exists: do not send another email.
  const live = await pool.query(
    "SELECT created_at FROM free_claims WHERE email_key = $1 AND status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1",
    [emailKey]
  );
  if (live.rowCount > 0) {
    return { ok: false, code: 'link_sent', message: 'We already emailed you a link. Please check your inbox and spam folder, and open it before it expires.' };
  }

  const dayStart = utcDayStart();
  const todayDeploys = await freeDeploymentsToday(pool);
  if (todayDeploys >= settings.dailyCap) return { ok: false, code: 'exhausted', message: EXHAUSTED_MESSAGE };

  const sent = await pool.query('SELECT COUNT(*)::int AS n FROM free_claims WHERE created_at >= $1', [dayStart]);
  if (sent.rows[0].n >= settings.verifyDailyMax) return { ok: false, code: 'exhausted', message: EXHAUSTED_MESSAGE };

  const ipHash = hashIp(ip);
  const fromIp = await pool.query('SELECT COUNT(*)::int AS n FROM free_claims WHERE ip_hash = $1 AND created_at >= $2', [ipHash, dayStart]);
  if (fromIp.rows[0].n >= IP_DAILY_MAX) {
    return { ok: false, code: 'ip_limit', message: 'Too many free requests from your network today. Please try again tomorrow.' };
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + settings.linkMinutes * 60 * 1000);

  // An older, expired, unverified claim for this address is replaced.
  const replaced = await pool.query("DELETE FROM free_claims WHERE email_key = $1 AND status = 'pending' RETURNING reference", [emailKey]);
  if (replaced.rowCount > 0) {
    await pool.query('DELETE FROM pending_deployments WHERE is_free = true AND reference = ANY($1::text[])', [replaced.rows.map(r => r.reference)]);
  }
  await pool.query(
    `INSERT INTO free_claims (email, email_key, ip_hash, reference, token_hash, website_type_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [email, emailKey, ipHash, reference, hashToken(token), websiteTypeId, expiresAt]
  );
  return { ok: true, token, expiresAt, linkMinutes: settings.linkMinutes, expiryDays: settings.expiryDays };
}

/**
 * Opens a link. Returns { status } with one of:
 *   'invalid'    unknown token
 *   'expired'    link older than its lifetime (never verified)
 *   'exhausted'  today's cap is full (the link stays usable until it expires)
 *   'ready'      claim verified; { reference } is ready to finalise
 *   'already'    claim was verified before; { reference } (finalise is idempotent)
 */
async function verifyFreeClaim(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return { status: 'invalid' };
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // One verification at a time, so two people cannot both take the last slot.
    await client.query('SELECT pg_advisory_xact_lock(2121001)');
    const found = await client.query('SELECT * FROM free_claims WHERE token_hash = $1 FOR UPDATE', [hashToken(token)]);
    if (found.rowCount === 0) { await client.query('COMMIT'); return { status: 'invalid' }; }
    const claim = found.rows[0];
    if (claim.status === 'verified') { await client.query('COMMIT'); return { status: 'already', reference: claim.reference }; }
    if (new Date(claim.expires_at) < new Date()) { await client.query('COMMIT'); return { status: 'expired' }; }

    const settings = await getFreeSettings();
    const today = await freeDeploymentsToday(client);
    if (today >= settings.dailyCap) { await client.query('COMMIT'); return { status: 'exhausted' }; }

    try {
      await client.query("UPDATE free_claims SET status = 'verified', verified_at = NOW() WHERE id = $1", [claim.id]);
    } catch (err) {
      // The unique index: this address was verified through another claim in the meantime.
      await client.query('ROLLBACK');
      return { status: 'invalid' };
    }
    await client.query('COMMIT');
    return { status: 'ready', reference: claim.reference };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Housekeeping: drop unverified claims (and their pending rows) a couple of days after they lapsed. */
async function purgeStaleFreeClaims() {
  const pool = getPool();
  const stale = await pool.query(
    "DELETE FROM free_claims WHERE status = 'pending' AND expires_at < NOW() - INTERVAL '2 days' RETURNING reference"
  );
  if (stale.rowCount > 0) {
    await pool.query('DELETE FROM pending_deployments WHERE is_free = true AND reference = ANY($1::text[])', [stale.rows.map(r => r.reference)]);
  }
  return stale.rowCount;
}

module.exports = {
  DEFAULTS,
  MAX_EXPIRY_DAYS,
  EXHAUSTED_MESSAGE,
  getFreeSettings,
  saveFreeSettings,
  parseBlockedList,
  normalizeEmailKey,
  isBlockedEmail,
  createFreeClaim,
  verifyFreeClaim,
  freeDeploymentsToday,
  purgeStaleFreeClaims
};
