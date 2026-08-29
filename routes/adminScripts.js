const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { refreshSiteScriptsCache, PLACEMENTS } = require('../lib/siteScripts');

const router = express.Router();
router.use(requireAdminSession);

const MAX_PER_PLACEMENT = 3;

const createSchema = z.object({
  placement: z.enum(PLACEMENTS),
  name: z.string().trim().min(1).max(200),
  scriptContent: z.string().trim().min(1).max(20000),
  isActive: z.boolean().optional().default(true)
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  scriptContent: z.string().trim().min(1).max(20000).optional(),
  isActive: z.boolean().optional()
});

function formatScript(row) {
  return {
    id: row.id,
    placement: row.placement,
    name: row.name,
    scriptContent: row.script_content,
    isActive: row.is_active,
    createdAt: row.created_at
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM site_scripts ORDER BY placement ASC, id ASC');

  const grouped = { head: [], body_start: [], footer: [] };
  for (const row of result.rows) {
    grouped[row.placement].push(formatScript(row));
  }
  res.json(grouped);
}));

router.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid script data' });
  }
  const { placement, name, scriptContent, isActive } = parsed.data;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Row-locked count-then-insert, same pattern as every other
    // single-row/capped-count invariant in this app (see
    // routes/adminPaystack.js, routes/adminAiProviders.js) -- a plain
    // "count first, insert if under 3" without the lock has the same
    // TOCTOU gap two concurrent admin tabs could hit, even though the
    // realistic odds of that race for a single admin are low. FOR UPDATE
    // on the existing rows for this placement serializes concurrent
    // inserts against the same placement.
    const countResult = await client.query(
      'SELECT id FROM site_scripts WHERE placement = $1 FOR UPDATE',
      [placement]
    );
    if (countResult.rowCount >= MAX_PER_PLACEMENT) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `This section already has ${MAX_PER_PLACEMENT} scripts — delete one first before adding another.`
      });
    }

    const insertResult = await client.query(
      `INSERT INTO site_scripts (placement, name, script_content, is_active)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [placement, name, scriptContent, isActive]
    );

    await client.query('COMMIT');
    await refreshSiteScriptsCache();
    res.status(201).json(formatScript(insertResult.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SCRIPTS] Failed to create script:', err.message);
    res.status(500).json({ error: 'Failed to save script' });
  } finally {
    client.release();
  }
}));

router.put('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!idParsed.success) {
    return res.status(400).json({ error: 'Invalid script id' });
  }
  const bodyParsed = updateSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid script data' });
  }

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM site_scripts WHERE id = $1', [idParsed.data.id]);
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'Script not found' });
  }
  const current = existing.rows[0];
  const { name, scriptContent, isActive } = bodyParsed.data;

  const next = {
    name: name !== undefined ? name : current.name,
    script_content: scriptContent !== undefined ? scriptContent : current.script_content,
    is_active: isActive !== undefined ? isActive : current.is_active
  };

  const result = await pool.query(
    'UPDATE site_scripts SET name = $1, script_content = $2, is_active = $3 WHERE id = $4 RETURNING *',
    [next.name, next.script_content, next.is_active, idParsed.data.id]
  );

  await refreshSiteScriptsCache();
  res.json(formatScript(result.rows[0]));
}));

router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!idParsed.success) {
    return res.status(400).json({ error: 'Invalid script id' });
  }

  const pool = getPool();
  const result = await pool.query('DELETE FROM site_scripts WHERE id = $1 RETURNING id', [idParsed.data.id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Script not found' });
  }

  await refreshSiteScriptsCache();
  res.json({ success: true });
}));

module.exports = router;
