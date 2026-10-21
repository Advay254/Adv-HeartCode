'use strict';

// Time-based one-time codes (RFC 6238) with Node's built-in crypto only:
// HMAC-SHA1, 30 second steps, 6 digits, the same codes Google Authenticator,
// Microsoft Authenticator, Aegis and similar apps show. Secrets are shown to
// people as base32 text (RFC 4648).

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1; // one step either side
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Not a valid base32 key');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random secret: 20 bytes (160 bits), as base32 text. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** The 6 digit code for a secret at a given step counter. */
function codeAt(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

function stepFor(timeMs) {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

/**
 * Checks a typed code. Returns the matching step counter (a number) or null.
 * Accepts the current step and one either side. Compares in constant time.
 * The caller must refuse a counter it has already accepted (replay).
 */
function verifyCode(secretBase32, typed, nowMs = Date.now()) {
  const text = String(typed == null ? '' : typed).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(text)) return null;
  const now = stepFor(nowMs);
  let matched = null;
  for (let c = now - WINDOW; c <= now + WINDOW; c += 1) {
    const expected = Buffer.from(codeAt(secretBase32, c));
    const given = Buffer.from(text);
    // No early exit, so timing does not reveal which step matched.
    if (crypto.timingSafeEqual(expected, given)) matched = c;
  }
  return matched;
}

/** The standard otpauth:// address an authenticator app understands. */
function buildOtpauthUrl({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Groups a secret in fours for easier reading and typing. */
function formatSecret(secret) {
  return String(secret).replace(/(.{4})/g, '$1 ').trim();
}

module.exports = {
  generateSecret,
  codeAt,
  verifyCode,
  stepFor,
  buildOtpauthUrl,
  formatSecret,
  base32Encode,
  base32Decode,
  STEP_SECONDS
};
