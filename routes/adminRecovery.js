const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { finalizeDeployment } = require('../lib/finalizeDeployment');
const sitePasswordCache = require('../lib/sitePasswordCache');

const router = express.Router();
router.use(requireAdminSession);

const PAGE_SIZE = 20;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().trim().max(200).optional().default('')
});

// GET /api/admin/pending-deployments — every row currently sitting in
// pending_deployments (v1.1.0: now kept for up to 7 days past expires_at
// rather than swept almost immediately — see db/init.js's migration
// comment and server.js's cleanup job), newest first. `status` is
// computed here, once, as the single source of truth the admin table
// just renders rather than re-deriving client-side:
//   - 'active': expires_at is still in the future — this checkout is
//     still fresh enough that the CLIENT'S OWN browser could still
//     complete it normally; nothing for an admin to do yet.
//   - 'needs_attention': expires_at has passed but the row hasn't been
//     swept yet (still within the 7-day window) — this is the set worth
//     actually looking at: either a genuinely abandoned checkout, or one
//     where payment succeeded but the webhook never fired and the client
//     never landed back on the callback page.
router.get('/', asyncHandler(async (req, res) => {
  const parsed = paginationSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters' });
  }
  const { page, search } = parsed.data;

  const pool = getPool();
  const params = [];
  let whereClause = '';
  if (search) {
    params.push(`%${search}%`);
    whereClause = 'WHERE pd.client_email ILIKE $1 OR pd.reference ILIKE $1';
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM pending_deployments pd ${whereClause}`, params);
  const total = Number(countResult.rows[0].count);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const offset = (page - 1) * PAGE_SIZE;

  const dataResult = await pool.query(
    `SELECT pd.reference, pd.client_email, pd.charge_currency, pd.charge_amount,
            pd.created_at, pd.expires_at, wt.name AS website_type_name
     FROM pending_deployments pd
     LEFT JOIN website_types wt ON wt.id = pd.website_type_id
     ${whereClause}
     ORDER BY pd.created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, PAGE_SIZE, offset]
  );

  const now = new Date();

  res.json({
    pending: dataResult.rows.map(p => ({
      reference: p.reference,
      clientEmail: p.client_email,
      websiteTypeName: p.website_type_name,
      chargeCurrency: p.charge_currency,
      chargeAmount: p.charge_amount !== null ? Number(p.charge_amount) : null,
      createdAt: p.created_at,
      expiresAt: p.expires_at,
      status: new Date(p.expires_at) < now ? 'needs_attention' : 'active'
    })),
    page,
    totalPages,
    total
  });
}));

const referenceParamsSchema = z.object({
  reference: z.string().trim().min(1).max(100)
});

// POST /api/admin/pending-deployments/:reference/retry — calls the exact
// same finalizeDeployment() the Paystack webhook and the browser's own
// checkout-callback page already call, with skipExpiryCheck: true (see
// lib/finalizeDeployment.js's doc comment for the full reasoning on why
// that flag has to exist and why only this one route ever passes it).
// Genuinely safe to click on a row that was never actually paid: real
// Paystack verification runs first, inside the same transaction as
// everything else — a transaction that never gets a chance to touch
// Cloudflare, deployed_sites, or pending_deployments unless that
// verification actually comes back successful. Nothing destructive
// happens on any non-success outcome; the row is untouched either way.
router.post('/:reference/retry', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = referenceParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid reference' });
  }
  const { reference } = parsed.data;

  const result = await finalizeDeployment(reference, { skipExpiryCheck: true });

  if (result.status === 'deployed' || result.status === 'already_deployed') {
    return res.json({ outcome: 'deployed', siteUrl: result.site.site_url });
  }
  if (result.status === 'not_paid') {
    return res.json({ outcome: 'not_paid' });
  }
  if (result.status === 'not_found') {
    return res.json({ outcome: 'not_found' });
  }
  if (result.status === 'expired') {
    // Shouldn't normally be reachable with skipExpiryCheck: true, but
    // kept as a distinct outcome rather than folded into 'error' in case
    // finalizeDeployment's internals ever grow a second expiry-like
    // condition — fails loudly and distinctly rather than silently.
    return res.json({ outcome: 'expired' });
  }

  console.error(`[RECOVERY] finalizeDeployment error retrying ${reference}:`, result.error);
  return res.status(502).json({ outcome: 'error', error: result.error || 'Failed to retry this deployment' });
}));

// DELETE /api/admin/pending-deployments/:reference — plain housekeeping,
// for a row the admin has confirmed is genuinely abandoned and wants to
// clear before the 7-day window closes on its own. No payment check: this
// only ever removes an UNRESOLVED checkout attempt, never a completed
// deployment (a completed one has already moved to deployed_sites and
// isn't reachable through this table or this route at all).
router.delete('/:reference', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = referenceParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid reference' });
  }
  const { reference } = parsed.data;

  const pool = getPool();
  const result = await pool.query(
    'DELETE FROM pending_deployments WHERE reference = $1 RETURNING reference',
    [reference]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'No pending deployment with that reference' });
  }

  // Best-effort cleanup of the matching in-memory plaintext-password
  // bridge entry (lib/sitePasswordCache.js), if one still exists — not
  // required for correctness (it would age out of that cache within an
  // hour regardless), just tidy: no reason to leave a plaintext password
  // sitting around in memory for a row that no longer exists at all.
  sitePasswordCache.takeOnce(reference);

  res.json({ success: true });
}));

module.exports = router;
