const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { createRateLimiter } = require('../lib/rateLimit');
const { getRealClientIp } = require('../lib/clientIp');

const router = express.Router();

// 'payment_completed' is DELIBERATELY excluded from this list — see
// lib/finalizeDeployment.js, the only place that event is ever inserted.
// Trusting a client-submitted event for "a payment happened" would be
// trivially fakeable (anyone can open devtools and POST here) and
// pointless to chart regardless — this endpoint has no way to verify a
// payment actually occurred, only finalizeDeployment (which just
// committed a real, Paystack-verified deployment) does.
const ALLOWED_EVENT_TYPES = [
  'page_view_home',
  'page_view_explore',
  'form_started',
  'preview_generated',
  'checkout_started'
];

const eventBodySchema = z.object({
  event_type: z.enum(ALLOWED_EVENT_TYPES),
  website_type_id: z.coerce.number().int().positive().optional(),
  // A random client-generated identifier (public/funnel.js), NOT a
  // persistent cookie, NOT tied to any personal information — see
  // db/init.js's funnel_events migration comment.
  session_id: z.string().trim().min(1).max(200)
});

// 60/hour per IP: generous enough that several real visitor sessions from
// behind the same IP (shared office wifi, a phone on cellular data, etc.)
// never get blocked — a genuine session naturally fires somewhere around
// 5-6 events end to end (home or explore view, form started, preview
// generated, checkout started) — while still bounding an abusive script
// hammering this endpoint. Reuses the same generic sliding-window helper
// every other rate limit in this app uses (lib/rateLimit.js), not a
// bespoke implementation.
const eventLimiter = createRateLimiter({ max: 60, windowMs: 60 * 60 * 1000 });

// Fire-and-forget from the client (navigator.sendBeacon, falling back to a
// non-blocking fetch — see public/funnel.js): the page must never wait on
// this or feel slower because of it. That cuts both ways here too — this
// route does the minimum necessary work and returns 204 with no body,
// rather than anything a beacon-style caller would never read anyway.
router.post('/', express.json(), asyncHandler(async (req, res) => {
  // v1.1.9 hotfix Part 2: see lib/clientIp.js -- keyed off the real
  // visitor IP, not Cloudflare's edge address.
  if (!eventLimiter.tryConsume(getRealClientIp(req))) {
    return res.status(429).end();
  }

  const parsed = eventBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).end();
  }

  const { event_type, website_type_id, session_id } = parsed.data;
  const pool = getPool();

  try {
    await pool.query(
      'INSERT INTO funnel_events (event_type, website_type_id, session_id) VALUES ($1, $2, $3)',
      [event_type, website_type_id || null, session_id]
    );
  } catch (err) {
    // A bogus website_type_id (references a row that doesn't exist, or
    // one that was deleted between page load and this call) trips the
    // foreign key constraint — a real possibility on a public,
    // unauthenticated endpoint that accepts client-supplied IDs. Logged
    // and swallowed rather than surfaced as a 500: this is a
    // fire-and-forget analytics beacon, not a critical write path, and
    // the client never reads the response body either way.
    console.error('[EVENTS] Failed to insert funnel event:', err.message);
    return res.status(400).end();
  }

  res.status(204).end();
}));

module.exports = router;
