const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');

// v1.2.1 Part A: admin CRUD for the three site-wide legal pages (Privacy
// Policy, Terms and Conditions, Cookie Policy). Structurally this mirrors
// routes/adminWebsiteTypes.js's Template/Email/Password Page tabs (GET
// active+history, PUT to save a new version, POST to roll back) -- same
// version-bump-under-FOR-UPDATE-lock pattern, deactivate-then-insert in
// one transaction, nothing ever deleted. The one real difference: those
// three are all scoped by website_type_id; these three are scoped by a
// fixed page_key instead, since a legal page is site-wide, not per
// website type. There is also no placeholder-substitution concern here
// (unlike Template/Password Page) -- legal pages are plain admin-authored
// HTML with no {{token}} set of their own.

const router = express.Router();
router.use(requireAdminSession);

const PAGE_KEYS = ['privacy_policy', 'terms', 'cookie_policy'];

const pageKeyParamSchema = z.object({ pageKey: z.enum(PAGE_KEYS) });
const rollbackParamsSchema = z.object({
  pageKey: z.enum(PAGE_KEYS),
  version: z.coerce.number().int().positive()
});
const saveBodySchema = z.object({
  htmlContent: z.string().trim().min(1).max(200000)
});

router.get('/:pageKey', asyncHandler(async (req, res) => {
  const parsed = pageKeyParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid legal page key' });
  }
  const { pageKey } = parsed.data;

  const pool = getPool();
  const active = await pool.query(
    'SELECT * FROM legal_pages WHERE page_key = $1 AND is_active = true LIMIT 1',
    [pageKey]
  );
  const history = await pool.query(
    'SELECT version, created_at FROM legal_pages WHERE page_key = $1 ORDER BY version DESC LIMIT 5',
    [pageKey]
  );

  res.json({
    active: active.rowCount > 0
      ? { htmlContent: active.rows[0].html_content, version: active.rows[0].version }
      : null,
    history: history.rows.map(h => ({ version: h.version, createdAt: h.created_at }))
  });
}));

router.put('/:pageKey', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = pageKeyParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid legal page key' });
  }
  const bodyParsed = saveBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'htmlContent is required' });
  }
  const { pageKey } = paramsParsed.data;
  const { htmlContent } = bodyParsed.data;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // FOR UPDATE on any existing rows for this page_key serializes
    // concurrent saves of the same page, same reasoning as every other
    // single-active-version table in this schema (see
    // routes/adminWebsiteTypes.js's own template/email-template/
    // password-page save routes).
    await client.query('SELECT id FROM legal_pages WHERE page_key = $1 FOR UPDATE', [pageKey]);

    const maxVersionResult = await client.query(
      'SELECT COALESCE(MAX(version), 0) AS max_version FROM legal_pages WHERE page_key = $1',
      [pageKey]
    );
    const nextVersion = Number(maxVersionResult.rows[0].max_version) + 1;

    await client.query(
      'UPDATE legal_pages SET is_active = false WHERE page_key = $1 AND is_active = true',
      [pageKey]
    );

    const inserted = await client.query(
      `INSERT INTO legal_pages (page_key, html_content, version, is_active)
       VALUES ($1, $2, $3, true) RETURNING *`,
      [pageKey, htmlContent, nextVersion]
    );

    await client.query('COMMIT');
    res.json({ version: inserted.rows[0].version });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[LEGAL PAGES] Failed to save legal page:', err.message);
    res.status(500).json({ error: 'Failed to save legal page' });
  } finally {
    client.release();
  }
}));

router.post('/:pageKey/rollback/:version', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = rollbackParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid legal page key or version' });
  }
  const { pageKey, version } = parsed.data;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const target = await client.query(
      'SELECT id FROM legal_pages WHERE page_key = $1 AND version = $2 FOR UPDATE',
      [pageKey, version]
    );
    if (target.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That version does not exist' });
    }

    await client.query(
      'UPDATE legal_pages SET is_active = false WHERE page_key = $1 AND is_active = true',
      [pageKey]
    );
    await client.query('UPDATE legal_pages SET is_active = true WHERE id = $1', [target.rows[0].id]);

    await client.query('COMMIT');
    res.json({ success: true, activeVersion: version });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[LEGAL PAGES] Failed to roll back legal page:', err.message);
    res.status(500).json({ error: 'Failed to roll back legal page' });
  } finally {
    client.release();
  }
}));

module.exports = router;
