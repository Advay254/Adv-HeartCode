'use strict';

// v1.2.21: promotional coupon codes.
//
// Hard rules, enforced here and again by the database and the admin route:
//   - at most 25 percent off
//   - only on a website type priced ABOVE $2 (USD list price)
//   - one coupon per order, and each email address can use a given coupon once
// A coupon never makes a site free, so it can never reach the free flow.

const { getPool } = require('../db/init');
const { normalizeEmailKey } = require('./freeDeployments');

const MAX_PERCENT = 25;
const MIN_PRICE_USD = 2; // price must be strictly greater than this
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

const INVALID = 'That code is not valid for this order.';

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Checks a code against a website type and price. Never throws for a bad
 * code. Returns { ok: true, coupon, percent, discountedUsd } or
 * { ok: false, message }. Every failure reason except the price rule gets the
 * same message, so codes cannot be probed for existence or state.
 */
async function findApplicableCoupon({ code, websiteTypeId, priceUsd, email }) {
  const normalized = normalizeCode(code);
  if (!CODE_RE.test(normalized)) return { ok: false, message: INVALID };
  if (!(Number(priceUsd) > MIN_PRICE_USD)) {
    return { ok: false, message: `Promo codes only apply to sites priced above $${MIN_PRICE_USD}.` };
  }

  const pool = getPool();
  const result = await pool.query('SELECT * FROM coupons WHERE UPPER(code) = $1', [normalized]);
  if (result.rowCount === 0) return { ok: false, message: INVALID };
  const coupon = result.rows[0];

  if (!coupon.is_active) return { ok: false, message: INVALID };
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) return { ok: false, message: INVALID };
  if (coupon.max_uses !== null && coupon.uses_count >= coupon.max_uses) return { ok: false, message: INVALID };
  if (Array.isArray(coupon.website_type_ids) && coupon.website_type_ids.length > 0 && !coupon.website_type_ids.includes(Number(websiteTypeId))) {
    return { ok: false, message: INVALID };
  }
  if (email) {
    const used = await pool.query('SELECT 1 FROM coupon_redemptions WHERE coupon_id = $1 AND email_key = $2', [coupon.id, normalizeEmailKey(email)]);
    if (used.rowCount > 0) return { ok: false, message: 'This code has already been used with this email address.' };
  }

  const percent = Math.min(Number(coupon.percent), MAX_PERCENT);
  const discountedUsd = round2(Number(priceUsd) * (1 - percent / 100));
  return { ok: true, coupon, percent, discountedUsd };
}

module.exports = { MAX_PERCENT, MIN_PRICE_USD, CODE_RE, normalizeCode, findApplicableCoupon };
