'use strict';

const crypto = require('crypto');
const { getPool } = require('../db/init');

// v1.2.11: data layer for review links and reviews. Every query here is
// parameterized; nothing user-controlled is ever concatenated into SQL.

const REVIEW_LINK_TTL_DAYS = 14;
const REMINDER_AFTER_DAYS = 2;
const AUTO_PUBLISH_AFTER_DAYS = 14;

// 32 random bytes as base64url is always exactly 43 characters.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function getPublicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || 'https://heartcode.uk').replace(/\/+$/, '');
}

function buildReviewUrl(token) {
  return `${getPublicBaseUrl()}/review/${token}`;
}

function buildAdminReviewsUrl() {
  const slug = process.env.ADMIN_PATH_SLUG || '';
  return `${getPublicBaseUrl()}/${slug}/reviews`;
}

/**
 * Creates the single review link for a REAL deployment, inside the caller's
 * open transaction (lib/finalizeDeployment.js). Returns the token, or null
 * when no link should exist / could not be made.
 *
 *  - Test deployments never get one (is_test rows are refused here too, not
 *    only by the caller).
 *  - uq_review_links_deployed_site plus ON CONFLICT DO NOTHING means a
 *    repeated call can never create a second link for the same deployment;
 *    it returns the existing token instead.
 *  - Runs inside a SAVEPOINT: if anything about link creation fails, only
 *    that is undone. The deployment is already live on ClarityHeart, so a
 *    review-link problem must never roll back the deployment record.
 */
async function createReviewLinkForDeployment(client, site) {
  if (!site || site.is_test === true) return null;

  await client.query('SAVEPOINT review_link_create');
  try {
    const inserted = await client.query(
      `INSERT INTO review_links (token, deployed_site_id, expires_at)
       VALUES ($1, $2, NOW() + make_interval(days => $3))
       ON CONFLICT (deployed_site_id) DO NOTHING
       RETURNING token`,
      [generateToken(), site.id, REVIEW_LINK_TTL_DAYS]
    );
    let token = inserted.rowCount > 0 ? inserted.rows[0].token : null;
    if (!token) {
      const existing = await client.query(
        'SELECT token FROM review_links WHERE deployed_site_id = $1',
        [site.id]
      );
      token = existing.rowCount > 0 ? existing.rows[0].token : null;
    }
    await client.query('RELEASE SAVEPOINT review_link_create');
    return token;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT review_link_create');
    console.error('[REVIEWS] Could not create review link (deployment itself is unaffected):', err.message);
    return null;
  }
}

/**
 * Looks a token up. Returns the link row or null. Used and expired and
 * never-existed tokens are indistinguishable to the caller on purpose. An
 * expired row that the cleanup job has not removed yet is treated as
 * invalid right here, in the query itself.
 */
async function findValidLink(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  const pool = getPool();
  const result = await pool.query(
    'SELECT id, deployed_site_id FROM review_links WHERE token = $1 AND expires_at > NOW()',
    [token]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

/**
 * Saves a review and permanently deletes its link in ONE transaction.
 * DELETE ... RETURNING takes the row lock, so two simultaneous submissions on
 * the same link cannot both succeed: the second waits on the lock, then finds
 * no row. Returns { ok: false } when the link is no longer valid.
 */
async function submitReviewWithLink({ token, name, rating, testimonial, imageUrl }) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false };

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const link = await client.query(
      'DELETE FROM review_links WHERE token = $1 AND expires_at > NOW() RETURNING deployed_site_id',
      [token]
    );
    if (link.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false };
    }

    const inserted = await client.query(
      `INSERT INTO reviews (deployed_site_id, reviewer_name, rating, testimonial, image_url)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, reviewer_name, rating`,
      [link.rows[0].deployed_site_id, name, rating, testimonial, imageUrl || null]
    );

    await client.query('COMMIT');
    return { ok: true, review: inserted.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const REVIEW_SELECT = `
  SELECT r.id, r.reviewer_name, r.rating, r.testimonial, r.image_url, r.status,
         r.auto_approved, r.submitted_at, r.approved_at,
         ds.site_url, ds.client_email, wt.name AS website_type_name,
         GREATEST(0, CEIL(EXTRACT(EPOCH FROM (r.submitted_at + make_interval(days => $1) - NOW())) / 86400))::int AS days_left
    FROM reviews r
    LEFT JOIN deployed_sites ds ON ds.id = r.deployed_site_id
    LEFT JOIN website_types wt ON wt.id = ds.website_type_id
`;

async function listPendingReviews() {
  const result = await getPool().query(
    `${REVIEW_SELECT} WHERE r.status = 'pending' ORDER BY r.submitted_at ASC, r.id ASC`,
    [AUTO_PUBLISH_AFTER_DAYS]
  );
  return result.rows;
}

async function listApprovedReviews(limit = 200) {
  const result = await getPool().query(
    `${REVIEW_SELECT} WHERE r.status = 'approved' ORDER BY r.approved_at DESC NULLS LAST, r.id DESC LIMIT $2`,
    [AUTO_PUBLISH_AFTER_DAYS, limit]
  );
  return result.rows;
}

async function countPendingReviews() {
  const result = await getPool().query("SELECT COUNT(*)::int AS n FROM reviews WHERE status = 'pending'");
  return result.rows[0].n;
}

/**
 * Approves a pending review, optionally with edited name/testimonial, in one
 * transaction with a row lock so it cannot race the auto-publish job or
 * another admin click. Returns { ok: false, reason } when it is not pending.
 */
async function approveReview(id, edits) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query(
      "SELECT id FROM reviews WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [id]
    );
    if (locked.rowCount === 0) {
      await client.query('ROLLBACK');
      return { ok: false, reason: 'not_pending' };
    }

    if (edits) {
      await client.query(
        `UPDATE reviews
            SET reviewer_name = $2, testimonial = $3, status = 'approved',
                auto_approved = false, approved_at = NOW()
          WHERE id = $1`,
        [id, edits.name, edits.testimonial]
      );
    } else {
      await client.query(
        "UPDATE reviews SET status = 'approved', auto_approved = false, approved_at = NOW() WHERE id = $1",
        [id]
      );
    }
    await client.query('COMMIT');
    return { ok: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Permanently deletes the row. Returns the deleted row's image_url (or undefined if no such review). */
async function deleteReviewRow(id) {
  const result = await getPool().query(
    'DELETE FROM reviews WHERE id = $1 RETURNING image_url',
    [id]
  );
  return result.rowCount > 0 ? { imageUrl: result.rows[0].image_url } : null;
}

module.exports = {
  REVIEW_LINK_TTL_DAYS,
  REMINDER_AFTER_DAYS,
  AUTO_PUBLISH_AFTER_DAYS,
  TOKEN_RE,
  generateToken,
  getPublicBaseUrl,
  buildReviewUrl,
  buildAdminReviewsUrl,
  createReviewLinkForDeployment,
  findValidLink,
  submitReviewWithLink,
  listPendingReviews,
  listApprovedReviews,
  countPendingReviews,
  approveReview,
  deleteReviewRow
};
