const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { logEvent } = require('../lib/activityEvents');
const { MAX_PERCENT, MIN_PRICE_USD, CODE_RE, normalizeCode } = require('../lib/coupons');

// v1.2.21: promotional coupons. The 25 percent ceiling is checked here, again
// at checkout (lib/coupons.js) and once more by the database.
const router = express.Router();
router.use(requireAdminSession);

const idList = z.array(z.coerce.number().int().positive()).max(200).optional().nullable();

const createSchema = z.object({
  code: z.string().trim().min(3).max(32),
  percent: z.coerce.number().int().min(1).max(MAX_PERCENT),
  expiresAt: z.string().trim().max(40).optional().nullable(),
  maxUses: z.coerce.number().int().min(1).max(1000000).optional().nullable(),
  websiteTypeIds: idList
}).strict();

const patchSchema = z.object({
  isActive: z.boolean().optional(),
  expiresAt: z.string().trim().max(40).optional().nullable(),
  maxUses: z.coerce.number().int().min(1).max(1000000).optional().nullable()
}).strict();

function parseDate(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? false : d;
}

function serialize(c) {
  return {
    id: c.id,
    code: c.code,
    percent: c.percent,
    isActive: c.is_active,
    expiresAt: c.expires_at,
    maxUses: c.max_uses,
    usesCount: c.uses_count,
    websiteTypeIds: c.website_type_ids || [],
    createdAt: c.created_at
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const coupons = await pool.query('SELECT * FROM coupons ORDER BY created_at DESC, id DESC');
  const types = await pool.query(
    'SELECT id, name, price_usd FROM website_types WHERE is_active = true AND NOT is_deleted_placeholder ORDER BY display_order, name'
  );
  res.json({
    maxPercent: MAX_PERCENT,
    minPriceUsd: MIN_PRICE_USD,
    coupons: coupons.rows.map(serialize),
    types: types.rows.map(t => ({ id: t.id, name: t.name, priceUsd: Number(t.price_usd) || 0 }))
  });
}));

router.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `Use a code of 3 to 32 letters, numbers, - or _, and a percentage from 1 to ${MAX_PERCENT}.` });
  }
  const code = normalizeCode(parsed.data.code);
  if (!CODE_RE.test(code)) {
    return res.status(400).json({ error: 'The code can only use letters, numbers, - and _.' });
  }
  const expiresAt = parseDate(parsed.data.expiresAt);
  if (expiresAt === false) return res.status(400).json({ error: 'That expiry date is not valid.' });

  const pool = getPool();
  try {
    const typeIds = parsed.data.websiteTypeIds && parsed.data.websiteTypeIds.length ? parsed.data.websiteTypeIds : null;
    const result = await pool.query(
      `INSERT INTO coupons (code, percent, expires_at, max_uses, website_type_ids)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [code, parsed.data.percent, expiresAt || null, parsed.data.maxUses || null, typeIds]
    );
    await logEvent(pool, { eventType: 'admin_config_changed', title: `Coupon ${code} created (${parsed.data.percent}%)` });
    res.status(201).json(serialize(result.rows[0]));
  } catch (err) {
    if (err && err.code === '23505') return res.status(409).json({ error: 'A coupon with that code already exists.' });
    throw err;
  }
}));

router.patch('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid coupon.' });
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request.' });
  const expiresAt = parseDate(parsed.data.expiresAt);
  if (expiresAt === false) return res.status(400).json({ error: 'That expiry date is not valid.' });

  const sets = [];
  const params = [];
  if (parsed.data.isActive !== undefined) { params.push(parsed.data.isActive); sets.push(`is_active = $${params.length}`); }
  if (expiresAt !== undefined) { params.push(expiresAt); sets.push(`expires_at = $${params.length}`); }
  if (parsed.data.maxUses !== undefined) { params.push(parsed.data.maxUses || null); sets.push(`max_uses = $${params.length}`); }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to change.' });
  params.push(id);

  const result = await getPool().query(`UPDATE coupons SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (result.rowCount === 0) return res.status(404).json({ error: 'No such coupon.' });
  res.json(serialize(result.rows[0]));
}));

router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid coupon.' });
  const result = await getPool().query('DELETE FROM coupons WHERE id = $1 RETURNING code', [id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'No such coupon.' });
  await logEvent(getPool(), { eventType: 'admin_config_changed', title: `Coupon ${result.rows[0].code} deleted` });
  res.json({ ok: true });
}));

module.exports = router;
