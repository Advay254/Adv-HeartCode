const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { createRateLimiter } = require('../lib/rateLimit');
const dq = require('../lib/deploymentQueries');

const router = express.Router();
router.use(requireAdminSession);

const PAGE_SIZE = 20;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().trim().max(200).optional().default('')
});

// v1.2.4: this route used to also compute total deployments/revenue, the
// subscriber count, and the per-type breakdown -- all of it time-bound
// data that now lives in routes/adminAnalytics.js (GET /overview and
// GET /website-types), which can answer "as of last 7 days" instead of
// only "of all time". What's left here is purely current CONFIGURATION
// state, which has no date range to speak of.
router.get('/stats', asyncHandler(async (req, res) => {
  const pool = getPool();

  const [paystackResult, providerResult, typeCountsResult] = await Promise.all([
    pool.query('SELECT mode FROM paystack_config WHERE id = 1'),
    pool.query('SELECT label, selected_model FROM ai_providers WHERE is_active = true LIMIT 1'),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_active) AS active_count,
        COUNT(*) FILTER (WHERE NOT is_active) AS inactive_count
      FROM website_types
    `)
  ]);

  res.json({
    paystackConfigured: paystackResult.rowCount > 0,
    paystackMode: paystackResult.rowCount > 0 ? paystackResult.rows[0].mode : null,
    activeProvider: providerResult.rowCount > 0
      ? { label: providerResult.rows[0].label, selectedModel: providerResult.rows[0].selected_model }
      : null,
    activeTypeCount: Number(typeCountsResult.rows[0].active_count),
    inactiveTypeCount: Number(typeCountsResult.rows[0].inactive_count)
  });
}));

// ---- Deployments (v1.2.3: Deployment Center) ----
//
// Replaces the old page/OFFSET endpoint. The list is keyset-paginated (see
// lib/deploymentQueries.js for why), filterable by search / website type /
// date range, and returns the exact count + revenue for the current filter
// only on the FIRST page (no cursor) -- paging through the same result set
// doesn't re-count it every time.
//
// Route order matters here: '/deployments/export' and '/deployments/facets'
// MUST be registered before '/deployments/:reference', or Express would
// treat the literal words "export"/"facets" as a reference (the same shadowing class of bug the reorder
// routes elsewhere in this app were fixed for).

router.get('/deployments', asyncHandler(async (req, res) => {
  const parsed = dq.listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters' });
  }
  const { limit, cursor: cursorToken, ...filters } = parsed.data;
  const rangeError = dq.validateRange(filters);
  if (rangeError) {
    return res.status(400).json({ error: rangeError });
  }

  let cursor = null;
  if (cursorToken) {
    cursor = dq.decodeCursor(cursorToken, filters.sort);
    if (!cursor) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
  }

  const pool = getPool();
  const [page, summary] = await Promise.all([
    dq.fetchPage(pool, filters, { limit, cursor }),
    cursor ? Promise.resolve(null) : dq.fetchSummary(pool, filters)
  ]);

  res.json({
    deployments: page.rows.map(dq.mapDeployment),
    nextCursor: page.nextCursor,
    limit,
    summary
  });
}));

// Website types for the Deployments page's filter dropdown. Includes inactive
// types on purpose: a deactivated type can still own past deployments.
router.get('/deployments/facets', asyncHandler(async (req, res) => {
  const result = await getPool().query(
    'SELECT id, name FROM website_types ORDER BY display_order ASC, id ASC'
  );
  res.json({ websiteTypes: result.rows.map(t => ({ id: t.id, name: t.name })) });
}));

// A full export can be large, so it's rate limited harder than ordinary
// admin GETs and streamed in keyset batches (never loaded into memory).
const deploymentExportLimiter = createRateLimiter({ max: 6, windowMs: 60 * 1000 });

router.get('/deployments/export', asyncHandler(async (req, res) => {
  if (!deploymentExportLimiter.tryConsume(req.ip || 'unknown')) {
    return res.status(429).json({ error: 'Too many exports. Wait a minute and try again.' });
  }
  const parsed = dq.filtersSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query parameters' });
  }
  const filters = parsed.data;
  const rangeError = dq.validateRange(filters);
  if (rangeError) {
    return res.status(400).json({ error: rangeError });
  }

  const pool = getPool();
  let closed = false;
  res.on('close', () => { closed = true; });

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="deployments-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');

  try {
    // UTF-8 BOM so Excel doesn't mangle non-ASCII characters in emails.
    res.write('\uFEFF' + dq.CSV_HEADER + '\r\n');
    for await (const rows of dq.iterateAll(pool, filters)) {
      if (closed) return; // the admin cancelled the download; stop querying
      const chunk = rows.map(r => dq.csvLine(dq.mapDeployment(r))).join('\r\n') + '\r\n';
      if (!res.write(chunk)) {
        // Respect backpressure, but never wait on a socket that has gone away.
        await new Promise(resolve => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
      }
    }
    res.end();
  } catch (err) {
    // Headers are already on the wire, so the global JSON error handler
    // can't respond any more. Cut the connection so the browser sees a
    // failed download instead of a silently truncated file that looks whole.
    console.error('[ADMIN] Deployment export failed mid-stream:', err.message);
    res.destroy(err);
  }
}));

const referenceParamSchema = z.object({
  reference: z.string().trim().min(1).max(200)
});

router.get('/deployments/:reference', asyncHandler(async (req, res) => {
  const parsed = referenceParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid reference' });
  }
  const row = await dq.fetchOne(getPool(), parsed.data.reference);
  if (!row) {
    return res.status(404).json({ error: 'Deployment not found' });
  }
  res.json({ deployment: dq.mapDeployment(row) });
}));

router.get('/subscribers', asyncHandler(async (req, res) => {
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
    whereClause = 'WHERE email ILIKE $1';
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM subscriber_emails ${whereClause}`, params);
  const total = Number(countResult.rows[0].count);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const offset = (page - 1) * PAGE_SIZE;

  const dataResult = await pool.query(
    `SELECT email, first_seen_at, opted_out FROM subscriber_emails
     ${whereClause}
     ORDER BY first_seen_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, PAGE_SIZE, offset]
  );

  res.json({
    subscribers: dataResult.rows.map(s => ({
      email: s.email,
      firstSeenAt: s.first_seen_at,
      optedOut: s.opted_out
    })),
    page,
    totalPages,
    total
  });
}));

const optOutParamsSchema = z.object({
  email: z.string().trim().email().max(254)
});
const optOutBodySchema = z.object({
  optedOut: z.boolean()
});

router.put('/subscribers/:email/opt-out', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = optOutParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  const bodyParsed = optOutBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'optedOut must be a boolean' });
  }

  const pool = getPool();
  const result = await pool.query(
    'UPDATE subscriber_emails SET opted_out = $1 WHERE email = $2 RETURNING email, opted_out',
    [bodyParsed.data.optedOut, paramsParsed.data.email]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Subscriber not found' });
  }

  res.json({ email: result.rows[0].email, optedOut: result.rows[0].opted_out });
}));

router.get('/subscribers/export', asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    'SELECT email, first_seen_at, opted_out FROM subscriber_emails ORDER BY first_seen_at DESC'
  );

  function csvEscape(value) {
    const str = String(value == null ? '' : value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  const lines = ['email,first_seen_at,opted_out'];
  for (const row of result.rows) {
    lines.push([csvEscape(row.email), csvEscape(row.first_seen_at.toISOString()), csvEscape(row.opted_out)].join(','));
  }

  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="subscribers.csv"');
  res.send(lines.join('\n'));
}));

module.exports = router;
