'use strict';

// v1.2.17: the two-step login store. One row in admin_security.
//
// - The authenticator secret is encrypted with lib/crypto.js (ENCRYPTION_KEY).
//   If that key is missing or has changed since the secret was saved, the
//   secret cannot be read: app codes stop working (recovery codes, which are
//   hashes that do not depend on the key, still do) and the Security page says
//   so. The emergency switch below is the way out.
// - Recovery codes are stored only as salted scrypt hashes.
// - A code (app or recovery) can be used once. App codes are tied to a 30
//   second step, and a step that was already accepted is refused.
// - Nothing in here logs or returns a secret, a code or a hash, except the
//   one-time return of newly made recovery codes and the setup secret.

const crypto = require('crypto');
const { promisify } = require('util');
const { encrypt, decrypt } = require('./crypto');
const totp = require('./totp');

const scrypt = promisify(crypto.scrypt);
const RECOVERY_COUNT = 10;
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0 O 1 I L
const PENDING_SETUP_MAX_AGE_MS = 30 * 60 * 1000;

/** Emergency switch: ADMIN_DISABLE_TWO_STEP=true turns the second step off. */
function emergencySwitchActive() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.ADMIN_DISABLE_TWO_STEP || '').trim().toLowerCase());
}

async function getRow(pool) {
  const result = await pool.query('SELECT * FROM admin_security WHERE id = 1');
  if (result.rowCount > 0) return result.rows[0];
  await pool.query('INSERT INTO admin_security (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  return (await pool.query('SELECT * FROM admin_security WHERE id = 1')).rows[0];
}

/** Whether the second step is required at login right now. */
async function isTwoStepActive(pool) {
  if (emergencySwitchActive()) return false;
  const row = await getRow(pool);
  return Boolean(row.totp_enabled);
}

/**
 * Run once at startup. With the emergency switch on, the saved two-step setup
 * is cleared (it is useless without its recovery path anyway), so removing the
 * switch later leaves a clean "off" state to set up again from.
 */
async function applyEmergencySwitchAtStartup(pool) {
  if (!emergencySwitchActive()) return false;
  console.warn('[SECURITY] ADMIN_DISABLE_TWO_STEP is set: the two-step login is OFF and its saved setup was cleared. Remove this setting from the environment once you are back in, then set two-step login up again on the Security page.');
  try {
    await pool.query(
      `UPDATE admin_security
       SET totp_enabled = false, totp_secret_encrypted = NULL, totp_pending_secret_encrypted = NULL,
           totp_pending_at = NULL, recovery_codes = '[]'::jsonb, updated_at = NOW()
       WHERE id = 1`
    );
  } catch (err) {
    console.error('[SECURITY] Could not clear the saved two-step setup:', err.message);
  }
  return true;
}

// ---- encryption health ----

function encryptionKeySet() {
  return Boolean(process.env.ENCRYPTION_KEY);
}

function secretReadable(row) {
  if (!row.totp_secret_encrypted) return false;
  try {
    decrypt(row.totp_secret_encrypted);
    return true;
  } catch (err) {
    return false;
  }
}

// ---- recovery codes ----

function newRecoveryCode() {
  let out = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i += 1) out += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

function normalizeRecoveryInput(text) {
  return String(text == null ? '' : text).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Asynchronous on purpose: scrypt runs on the thread pool, so checking a code
// never freezes the rest of the app.
async function hashRecovery(normalized, saltHex) {
  return (await scrypt(normalized, Buffer.from(saltHex, 'hex'), 32)).toString('hex');
}

async function makeRecoverySet() {
  const codes = [];
  for (let i = 0; i < RECOVERY_COUNT; i += 1) codes.push(newRecoveryCode());
  const stored = await Promise.all(codes.map(async (code) => {
    const salt = crypto.randomBytes(16).toString('hex');
    return { salt, hash: await hashRecovery(normalizeRecoveryInput(code), salt), used_at: null };
  }));
  return { codes, stored };
}

function recoveryRemaining(row) {
  const list = Array.isArray(row.recovery_codes) ? row.recovery_codes : [];
  return list.filter((c) => !c.used_at).length;
}

// ---- setup ----

/** Starts setup: makes a new secret, keeps it (encrypted) as pending. */
async function beginSetup(pool, { account, issuer }) {
  const row = await getRow(pool);
  if (row.totp_enabled) return { error: 'already_enabled' };
  if (!encryptionKeySet()) return { error: 'no_encryption_key' };
  const secret = totp.generateSecret();
  const encrypted = encrypt(secret);
  await pool.query(
    'UPDATE admin_security SET totp_pending_secret_encrypted = $1, totp_pending_at = NOW(), updated_at = NOW() WHERE id = 1',
    [encrypted]
  );
  return {
    secret,
    secretDisplay: totp.formatSecret(secret),
    otpauthUrl: totp.buildOtpauthUrl({ secret, account, issuer })
  };
}

/** Finishes setup when the typed code matches the pending secret. */
async function enableWithCode(pool, typedCode) {
  const row = await getRow(pool);
  if (row.totp_enabled) return { error: 'already_enabled' };
  if (!row.totp_pending_secret_encrypted || !row.totp_pending_at
      || Date.now() - new Date(row.totp_pending_at).getTime() > PENDING_SETUP_MAX_AGE_MS) {
    return { error: 'no_setup' };
  }
  let secret;
  try {
    secret = decrypt(row.totp_pending_secret_encrypted);
  } catch (err) {
    return { error: 'unreadable' };
  }
  const counter = totp.verifyCode(secret, typedCode);
  if (counter === null) return { error: 'wrong_code' };

  const { codes, stored } = await makeRecoverySet();
  const result = await pool.query(
    `UPDATE admin_security
     SET totp_enabled = true, totp_secret_encrypted = totp_pending_secret_encrypted,
         totp_pending_secret_encrypted = NULL, totp_pending_at = NULL,
         totp_last_counter = $1, recovery_codes = $2::jsonb, updated_at = NOW()
     WHERE id = 1 AND totp_enabled = false`,
    [counter, JSON.stringify(stored)]
  );
  if (result.rowCount === 0) return { error: 'already_enabled' };
  return { ok: true, recoveryCodes: codes };
}

async function cancelSetup(pool) {
  await pool.query(
    'UPDATE admin_security SET totp_pending_secret_encrypted = NULL, totp_pending_at = NULL, updated_at = NOW() WHERE id = 1 AND totp_enabled = false'
  );
}

// ---- checking a code at login (and for disable / regenerate) ----

async function tryAppCode(pool, row, typed) {
  let secret;
  try {
    secret = decrypt(row.totp_secret_encrypted);
  } catch (err) {
    return { ok: false, reason: 'unreadable' };
  }
  const counter = totp.verifyCode(secret, typed);
  if (counter === null) return { ok: false, reason: 'wrong' };
  // Atomic: only the call that moves the stored step forward wins, so the same
  // code cannot be accepted twice, even by two requests at the same moment.
  const moved = await pool.query(
    'UPDATE admin_security SET totp_last_counter = $1 WHERE id = 1 AND totp_last_counter < $1',
    [counter]
  );
  if (moved.rowCount === 0) return { ok: false, reason: 'replay' };
  return { ok: true, method: 'app' };
}

async function tryRecoveryCode(pool, row, typed) {
  const normalized = normalizeRecoveryInput(typed);
  if (normalized.length !== 10) return { ok: false, reason: 'wrong' };
  const list = Array.isArray(row.recovery_codes) ? row.recovery_codes : [];
  // Every stored code is checked, so timing does not show which one matched.
  let hit = -1;
  const candidates = await Promise.all(list.map((entry) => hashRecovery(normalized, entry.salt)));
  list.forEach((entry, i) => {
    const candidate = Buffer.from(candidates[i], 'hex');
    const stored = Buffer.from(entry.hash, 'hex');
    if (candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored) && !entry.used_at) hit = i;
  });
  if (hit === -1) return { ok: false, reason: 'wrong' };
  const used = await pool.query(
    `UPDATE admin_security
     SET recovery_codes = jsonb_set(recovery_codes, ARRAY[$1::text, 'used_at'], to_jsonb($2::text)), updated_at = NOW()
     WHERE id = 1 AND (recovery_codes -> $1::int) ->> 'used_at' IS NULL`,
    [hit, new Date().toISOString()]
  );
  if (used.rowCount === 0) return { ok: false, reason: 'replay' };
  return { ok: true, method: 'recovery' };
}

/**
 * Checks what was typed in the code box: a 6 digit app code, or a recovery
 * code. Returns { ok, method } or { ok:false, reason }.
 *   reason: 'wrong', 'replay' (already used), 'unreadable' (secret cannot be decrypted)
 */
async function verifyLoginCode(pool, typed, { allowRecovery = true } = {}) {
  const row = await getRow(pool);
  if (!row.totp_enabled) return { ok: false, reason: 'off' };
  const text = String(typed == null ? '' : typed).trim();
  if (text.length > 40) return { ok: false, reason: 'wrong' };
  if (/^\d[\d\s]*$/.test(text)) {
    return tryAppCode(pool, row, text);
  }
  if (!allowRecovery) return { ok: false, reason: 'wrong' };
  return tryRecoveryCode(pool, row, text);
}

async function disable(pool) {
  await pool.query(
    `UPDATE admin_security
     SET totp_enabled = false, totp_secret_encrypted = NULL, totp_pending_secret_encrypted = NULL,
         totp_pending_at = NULL, totp_last_counter = 0, recovery_codes = '[]'::jsonb, updated_at = NOW()
     WHERE id = 1`
  );
}

async function regenerateRecoveryCodes(pool) {
  const { codes, stored } = await makeRecoverySet();
  await pool.query(
    "UPDATE admin_security SET recovery_codes = $1::jsonb, updated_at = NOW() WHERE id = 1 AND totp_enabled = true",
    [JSON.stringify(stored)]
  );
  return codes;
}

module.exports = {
  emergencySwitchActive,
  getRow,
  isTwoStepActive,
  applyEmergencySwitchAtStartup,
  encryptionKeySet,
  secretReadable,
  recoveryRemaining,
  beginSetup,
  enableWithCode,
  cancelSetup,
  verifyLoginCode,
  disable,
  regenerateRecoveryCodes,
  RECOVERY_COUNT
};
