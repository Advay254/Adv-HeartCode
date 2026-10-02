'use strict';

const { getPool } = require('../db/init');
const { normalizeText, plainTextProblem, countChars } = require('./reviewValidation');

// v1.2.12: the single running-text broadcast shown at the top of the
// /testimonials page. At most one row (id pinned to 1). Saving replaces it
// and restarts the 7 day clock. Every query is parameterized.

const BROADCAST_MAX = 160;
const BROADCAST_TTL_DAYS = 7;

/**
 * Same plain-text rules as a review: trim, strip control and invisible
 * characters, no HTML, no URL. Counted in real characters. Returns
 * { value } or { error, value }.
 */
function validateBroadcastMessage(raw) {
  const value = normalizeText(raw, { multiline: false });
  const length = countChars(value);
  if (length === 0) return { error: 'Please enter a message.', value };
  if (length > BROADCAST_MAX) return { error: `The message can be at most ${BROADCAST_MAX} characters.`, value };
  const problem = plainTextProblem(value, 'message');
  if (problem) return { error: problem, value };
  return { value };
}

function shape(row) {
  const msLeft = new Date(row.expires_at).getTime() - Date.now();
  return {
    message: row.message,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    daysLeft: Math.max(0, Math.ceil(msLeft / 86400000))
  };
}

/** The current broadcast, or null. An expired row counts as gone right here, before the job removes it. */
async function getActiveBroadcast() {
  const result = await getPool().query(
    'SELECT message, updated_at, expires_at FROM testimonials_broadcast WHERE id = 1 AND expires_at > NOW()'
  );
  return result.rowCount > 0 ? shape(result.rows[0]) : null;
}

/** Saves (or replaces) the broadcast; the 7 days restart from now. */
async function saveBroadcast(message) {
  const result = await getPool().query(
    `INSERT INTO testimonials_broadcast (id, message, updated_at, expires_at)
     VALUES (1, $1, NOW(), NOW() + make_interval(days => $2))
     ON CONFLICT (id) DO UPDATE
       SET message = EXCLUDED.message, updated_at = NOW(), expires_at = NOW() + make_interval(days => $2)
     RETURNING message, updated_at, expires_at`,
    [message, BROADCAST_TTL_DAYS]
  );
  return shape(result.rows[0]);
}

async function deleteBroadcast() {
  const result = await getPool().query('DELETE FROM testimonials_broadcast WHERE id = 1');
  return result.rowCount > 0;
}

/** Physically removes an expired broadcast (called by the existing scheduled cleanup job). */
async function deleteExpiredBroadcast() {
  const result = await getPool().query('DELETE FROM testimonials_broadcast WHERE expires_at <= NOW()');
  return result.rowCount;
}

module.exports = {
  BROADCAST_MAX,
  BROADCAST_TTL_DAYS,
  validateBroadcastMessage,
  getActiveBroadcast,
  saveBroadcast,
  deleteBroadcast,
  deleteExpiredBroadcast
};
