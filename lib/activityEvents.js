'use strict';

/**
 * v1.2.5 (Chunk C: activity feed). A small, append-only event log backing
 * the admin "Recent Activity" feed. Framework-free like
 * lib/deploymentQueries.js / lib/analyticsQueries.js, so it can be tested
 * directly against a real Postgres.
 *
 * SCOPE: the roadmap's illustrative event list also mentioned "Deployment
 * failed" and "Hosting error". Those aren't logged here — the app doesn't
 * currently have a structured "this deployment failed" state to hang an
 * event on (an error just surfaces as a 500 to whoever triggered it; see
 * the v1.2.3 HANDOFF's "Known gaps": deployed_sites only records
 * successful deployments). Adding that is Chunk D territory (deployment
 * health), not a quiet omission here. This chunk logs five events that
 * are all real, already-detectable facts in the current codebase:
 *   - payment_received     (lib/finalizeDeployment.js, after Paystack verifies)
 *   - deployment_completed (lib/finalizeDeployment.js, after the site goes live)
 *   - email_sent           (lib/finalizeDeployment.js, after the confirmation email sends)
 *   - recovery_completed   (lib/finalizeDeployment.js, ONLY when reached via
 *                           the admin Recovery page's retry button — an
 *                           addition beyond the roadmap's plain "recovery"
 *                           label, to distinguish an admin-recovered
 *                           payment from the normal live-webhook path)
 *   - site_details_resent  (routes/public.js, the public self-service
 *                           "resend my site details" flow — an addition
 *                           beyond the roadmap's original five, since it's
 *                           a real, already-detectable customer-facing
 *                           event this chunk's plumbing makes nearly free
 *                           to also surface)
 *   - admin_config_changed (a curated set of "this changes how HeartCode
 *                           behaves" saves: Paystack, hosting, an AI or
 *                           email provider being activated, site settings
 *                           — not a blanket audit log of every admin
 *                           mutation, which would flood the feed with
 *                           routine content edits)
 */

const { z } = require('zod');

const EVENT_TYPES = [
  'payment_received',
  'deployment_completed',
  'email_sent',
  'recovery_completed',
  'site_details_resent',
  'admin_config_changed'
];

// Matches lib/deploymentQueries.js's CURSOR_TS_SQL/REGEX exactly, for the
// same reason: a cursor's timestamp has to survive a round trip to full
// microsecond precision, or two events created microseconds apart in the
// same batch could be skipped or repeated at a page boundary.
const CURSOR_TS_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_TS_SQL = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Records one event. Never throws on a bad eventType/title (logs and
 * returns null instead) — every call site is a side effect alongside a
 * real action that already succeeded (a payment verified, a deployment
 * went live, an admin saved a setting); a typo or a transient DB hiccup
 * while writing the ACTIVITY LOG about that action must never be what
 * fails the action itself. Pass `client` to log inside an existing
 * transaction (atomic with the row that motivated the event); omit it to
 * use the pool directly (fine for a fire-and-forget log after commit).
 */
async function logEvent(dbOrClient, { eventType, title, detail = null, reference = null, amountUsd = null, metadata = null }) {
  if (!EVENT_TYPES.includes(eventType)) {
    console.error(`[ACTIVITY] Refusing to log unknown event type "${eventType}" (title: ${title})`);
    return null;
  }
  if (!title || typeof title !== 'string') {
    console.error('[ACTIVITY] Refusing to log an event with no title', { eventType });
    return null;
  }
  try {
    const result = await dbOrClient.query(
      `INSERT INTO activity_events (event_type, title, detail, reference, amount_usd, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [eventType, title, detail, reference, amountUsd, metadata ? JSON.stringify(metadata) : null]
    );
    return Number(result.rows[0].id);
  } catch (err) {
    console.error('[ACTIVITY] Failed to log event (non-fatal):', err.message, { eventType, title });
    return null;
  }
}

function emptyToUndefined(v) {
  return v === '' || v === null ? undefined : v;
}

const listQuerySchema = z.object({
  limit: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(MAX_LIMIT).optional().default(DEFAULT_LIMIT)),
  cursor: z.preprocess(emptyToUndefined, z.string().max(300).optional()),
  eventType: z.preprocess(emptyToUndefined, z.enum(EVENT_TYPES).optional())
});

function encodeCursor(tsText, id) {
  return Buffer.from(JSON.stringify({ t: tsText, i: id }), 'utf8').toString('base64url');
}

/** Returns { ts, id } or null if the token is malformed/tampered. */
function decodeCursor(token) {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed.t !== 'string' || !CURSOR_TS_REGEX.test(parsed.t) ||
      !Number.isInteger(parsed.i) || parsed.i < 1
    ) {
      return null;
    }
    return { ts: parsed.t, id: parsed.i };
  } catch (_err) {
    return null;
  }
}

/**
 * One keyset page (newest first), optionally filtered to one event type.
 * Same reasoning as lib/deploymentQueries.js's fetchPage: OFFSET pagination
 * degrades as the log grows, so this walks (created_at, id) directly via
 * the idx_activity_events_created_at_id / idx_activity_events_type_created_at_id
 * indexes instead.
 */
async function fetchPage(pool, { limit, cursor, eventType }) {
  const clauses = [];
  const params = [];
  if (eventType) {
    params.push(eventType);
    clauses.push(`event_type = $${params.length}`);
  }
  if (cursor) {
    params.push(cursor.ts, cursor.id);
    clauses.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }
  params.push(limit + 1);

  const result = await pool.query(
    `SELECT id, event_type, title, detail, reference, amount_usd, metadata, created_at,
            ${CURSOR_TS_SQL} AS created_at_cursor
     FROM activity_events
     ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  );

  const hasMore = result.rows.length > limit;
  const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
  const last = rows[rows.length - 1];
  return {
    rows,
    // last.id comes back from Postgres as a STRING (BIGSERIAL/bigint
    // columns are returned as text by node-postgres to avoid silent
    // precision loss above 2^53) -- coerced to a real Number here so the
    // encoded cursor's `i` field round-trips through decodeCursor's
    // Number.isInteger() check correctly instead of being rejected as
    // "invalid" on the very next page request.
    nextCursor: hasMore && last ? encodeCursor(last.created_at_cursor, Number(last.id)) : null
  };
}

function mapEvent(row) {
  return {
    id: Number(row.id),
    eventType: row.event_type,
    title: row.title,
    detail: row.detail,
    reference: row.reference,
    amountUsd: row.amount_usd !== null ? Number(row.amount_usd) : null,
    metadata: row.metadata || null,
    createdAt: row.created_at
  };
}

module.exports = {
  EVENT_TYPES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  logEvent,
  listQuerySchema,
  decodeCursor,
  fetchPage,
  mapEvent
};
