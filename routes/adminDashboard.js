const express = require('express');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');

const router = express.Router();
router.use(requireAdminSession);

const PAGE_SIZE = 20;

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  search: z.string().trim().max(200).optional().default('')
});

router.get('/stats', async (req, res) => {
  const pool = getPool();

  const [paystackResult, providerResult, typeCountsResult, deploymentStatsResult, breakdownResult, subscriberCountResult] = await Promise.all([
    pool.query('SELECT mode FROM paystack_config WHERE id = 1'),
    pool.query('SELECT label, selected_model FROM ai_providers WHERE is_active = true LIMIT 1'),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_active) AS active_count,
        COUNT(*) FILTER (WHERE NOT is_active) AS inactive_count
      FROM website_types
    `),
    pool.query('SELECT COUNT(*) AS total, COALESCE(SUM(amount_kes), 0) AS revenue FROM deployed_sites'),
    pool.query(`
      SELECT wt.name, wt.slug, COUNT(ds.id) AS deployment_count, COALESCE(SUM(ds.amount_kes), 0) AS revenue_kes
      FROM website_types wt
      LEFT JOIN deployed_sites ds ON ds.website_type_id = wt.id
      GROUP BY wt.id, wt.name, wt.slug
      ORDER BY deployment_count DESC, wt.name ASC
    `),
    pool.query('SELECT COUNT(*) FROM subscriber_emails WHERE opted_out = false')
  ]);

  res.json({
    paystackConfigured: paystackResult.rowCount > 0,
    paystackMode: paystackResult.rowCount > 0 ? paystackResult.rows[0].mode : null,
    activeProvider: providerResult.rowCount > 0
      ? { label: providerResult.rows[0].label, selectedModel: providerResult.rows[0].selected_model }
      : null,
    activeTypeCount: Number(typeCountsResult.rows[0].active_count),
    inactiveTypeCount: Number(typeCountsResult.rows[0].inactive_count),
    totalDeployments: Number(deploymentStatsResult.rows[0].total),
    totalRevenueKes: Number(deploymentStatsResult.rows[0].revenue),
    subscriberCount: Number(subscriberCountResult.rows[0].count),
    breakdown: breakdownResult.rows.map(r => ({
      name: r.name,
      slug: r.slug,
      deploymentCount: Number(r.deployment_count),
      revenueKes: Number(r.revenue_kes)
    }))
  });
});

router.get('/deployments', async (req, res) => {
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
    whereClause = 'WHERE ds.client_email ILIKE $1 OR ds.reference ILIKE $1 OR ds.site_url ILIKE $1';
  }

  const countResult = await pool.query(`SELECT COUNT(*) FROM deployed_sites ds ${whereClause}`, params);
  const total = Number(countResult.rows[0].count);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const offset = (page - 1) * PAGE_SIZE;

  const dataResult = await pool.query(
    `SELECT ds.reference, ds.client_email, ds.site_url, ds.amount_kes, ds.deployed_at, wt.name AS website_type_name
     FROM deployed_sites ds
     LEFT JOIN website_types wt ON wt.id = ds.website_type_id
     ${whereClause}
     ORDER BY ds.deployed_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, PAGE_SIZE, offset]
  );

  res.json({
    deployments: dataResult.rows.map(d => ({
      reference: d.reference,
      clientEmail: d.client_email,
      siteUrl: d.site_url,
      websiteTypeName: d.website_type_name,
      amountKes: d.amount_kes,
      deployedAt: d.deployed_at
    })),
    page,
    totalPages,
    total
  });
});

router.get('/subscribers', async (req, res) => {
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
});

const optOutParamsSchema = z.object({
  email: z.string().trim().email().max(254)
});
const optOutBodySchema = z.object({
  optedOut: z.boolean()
});

router.put('/subscribers/:email/opt-out', requireCsrf, async (req, res) => {
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
});

router.get('/subscribers/export', async (req, res) => {
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
});

module.exports = router;
