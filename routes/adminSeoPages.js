const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { slugify } = require('../lib/slugify');
const { isReservedTopLevelSlug } = require('../lib/reservedSlugs');
const { refreshFooterExtrasCache } = require('../lib/footerExtras');

const router = express.Router();
router.use(requireAdminSession);

const CONTENT_FORMATS = ['html', 'markdown'];

function formatSeoPage(p) {
  return {
    id: p.id,
    slug: p.slug,
    pageTitle: p.page_title,
    metaDescription: p.meta_description,
    targetWebsiteTypeId: p.target_website_type_id,
    ctaText: p.cta_text,
    isActive: p.is_active,
    // v1.2.2 Part C: which renderer routes/public.js's SEO page route
    // applies to this page's active seo_page_content row at request time
    // -- see this file's own /:id/content sub-routes below and this
    // version's db/init.js migration comment for why this lives on
    // seo_pages itself rather than being versioned per seo_page_content
    // row.
    contentFormat: p.content_format,
    createdAt: p.created_at
  };
}

// Ordered alphabetically by slug -- there is no display_order column on
// this table (unlike landing_sections/website_categories/etc.), since the
// spec for this version never asked these pages to have a relative order
// against each other: each one is an independent URL a search visitor
// lands on directly, never browsed as an ordered list on the public
// site the way categories or types are.
router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    `SELECT sp.*, wt.name AS target_website_type_name, wt.slug AS target_website_type_slug
     FROM seo_pages sp
     LEFT JOIN website_types wt ON wt.id = sp.target_website_type_id
     ORDER BY sp.slug ASC`
  );
  res.json(result.rows.map(p => ({
    ...formatSeoPage(p),
    targetWebsiteTypeName: p.target_website_type_name,
    targetWebsiteTypeSlug: p.target_website_type_slug
  })));
}));

const createSchema = z.object({
  slug: z.string().trim().min(1).max(150),
  pageTitle: z.string().trim().min(1).max(200),
  metaDescription: z.string().trim().min(1).max(500),
  targetWebsiteTypeId: z.coerce.number().int().positive().nullable().optional(),
  ctaText: z.string().trim().max(100).optional()
});

router.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return res.status(400).json({ error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid request body' });
  }
  const { pageTitle, metaDescription, targetWebsiteTypeId, ctaText } = parsed.data;

  const baseSlug = slugify(parsed.data.slug);
  if (!baseSlug) {
    return res.status(400).json({ error: 'Could not derive a valid slug' });
  }

  // See lib/reservedSlugs.js's own comment for why this has to be a hard
  // rejection at creation time rather than something route ordering
  // alone can paper over -- a colliding slug would otherwise create a
  // page that silently never renders, with no error anywhere to explain
  // why.
  if (isReservedTopLevelSlug(baseSlug)) {
    return res.status(409).json({
      error: `"${baseSlug}" is a reserved top-level path and can't be used as an SEO page slug`,
      conflictField: 'slug'
    });
  }

  const pool = getPool();

  if (targetWebsiteTypeId) {
    const typeCheck = await pool.query('SELECT id FROM website_types WHERE id = $1', [targetWebsiteTypeId]);
    if (typeCheck.rowCount === 0) {
      return res.status(400).json({ error: 'targetWebsiteTypeId does not refer to an existing website type' });
    }
  }

  const conflict = await pool.query('SELECT id FROM seo_pages WHERE slug = $1', [baseSlug]);
  if (conflict.rowCount > 0) {
    return res.status(409).json({ error: `slug "${baseSlug}" is already in use by another SEO page`, conflictField: 'slug' });
  }

  const result = await pool.query(
    `INSERT INTO seo_pages (slug, page_title, meta_description, target_website_type_id, cta_text)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [baseSlug, pageTitle, metaDescription, targetWebsiteTypeId || null, ctaText || 'Build this website']
  );
  // A brand-new SEO page has zero seo_page_content rows yet -- see this
  // file's /:id/content GET route, which already returns active: null for
  // that case, and routes/public.js's own "nothing active yet" fallback.
  // It IS immediately eligible for the site-wide footer's "Pages" list
  // (Part D) once active, so that cache needs a kick -- same reasoning
  // as every other cache-refresh-on-write call in this codebase.
  await refreshFooterExtrasCache();
  res.status(201).json(formatSeoPage(result.rows[0]));
}));

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const updateSchema = z.object({
  pageTitle: z.string().trim().min(1).max(200).optional(),
  metaDescription: z.string().trim().min(1).max(500).optional(),
  targetWebsiteTypeId: z.coerce.number().int().positive().nullable().optional(),
  ctaText: z.string().trim().max(100).optional(),
  isActive: z.boolean().optional()
  // slug is deliberately NOT editable after creation -- it's also this
  // page's live public URL; silently changing it here would leave every
  // seo_page_content version already saved under the old id reachable
  // only at a URL that no longer resolves to it. An admin who genuinely
  // needs a different URL deletes this page and creates a new one, the
  // same tradeoff website_types.slug already accepts for the same reason
  // (see routes/adminWebsiteTypes.js).
});

router.put('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid SEO page id' });
  const bodyParsed = updateSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    const issue = bodyParsed.error.issues[0];
    return res.status(400).json({ error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid request body' });
  }
  const { pageTitle, metaDescription, targetWebsiteTypeId, ctaText, isActive } = bodyParsed.data;

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM seo_pages WHERE id = $1', [idParsed.data.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'SEO page not found' });
  const current = existing.rows[0];

  if (targetWebsiteTypeId !== undefined && targetWebsiteTypeId !== null) {
    const typeCheck = await pool.query('SELECT id FROM website_types WHERE id = $1', [targetWebsiteTypeId]);
    if (typeCheck.rowCount === 0) {
      return res.status(400).json({ error: 'targetWebsiteTypeId does not refer to an existing website type' });
    }
  }

  const next = {
    page_title: pageTitle !== undefined ? pageTitle : current.page_title,
    meta_description: metaDescription !== undefined ? metaDescription : current.meta_description,
    target_website_type_id: targetWebsiteTypeId !== undefined ? targetWebsiteTypeId : current.target_website_type_id,
    cta_text: ctaText !== undefined ? ctaText : current.cta_text,
    is_active: isActive !== undefined ? isActive : current.is_active
  };

  const result = await pool.query(
    `UPDATE seo_pages SET page_title = $1, meta_description = $2, target_website_type_id = $3,
       cta_text = $4, is_active = $5 WHERE id = $6 RETURNING *`,
    [next.page_title, next.meta_description, next.target_website_type_id, next.cta_text, next.is_active, idParsed.data.id]
  );
  // page_title and is_active both feed the site-wide footer's "Pages"
  // list (Part D) -- refresh unconditionally rather than only when
  // isActive/pageTitle were actually part of this request, since that's
  // simpler and this cache refresh is cheap (two small indexed queries,
  // see lib/footerExtras.js).
  await refreshFooterExtrasCache();
  res.json(formatSeoPage(result.rows[0]));
}));

router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid SEO page id' });

  const pool = getPool();
  // seo_page_content rows for this page are deleted automatically by its
  // ON DELETE CASCADE (see db/init.js's v1.2.2 migration comment) -- unlike
  // the old landing_sections-per-page_slug design this replaces, a
  // deleted SEO page's content history has no independent meaning worth
  // orphan-keeping.
  const result = await pool.query('DELETE FROM seo_pages WHERE id = $1 RETURNING slug', [idParsed.data.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'SEO page not found' });

  await refreshFooterExtrasCache();
  res.json({ success: true });
}));

// ---- content (v1.2.2 Part C) ----
//
// Structurally identical to routes/adminLegal.js's GET/PUT/rollback trio
// (FOR-UPDATE-locked deactivate-then-insert in one transaction, rollback
// as a pointer flip, nothing ever deleted) -- the one real difference:
// this table is scoped by seo_page_id (an integer FK) rather than a fixed
// page_key enum, and a save here also updates seo_pages.content_format in
// the SAME transaction, so a page's format and its content version can
// never observably disagree mid-request. See db/init.js's migration
// comment for why content_format itself is not versioned per row.
router.get('/:id/content', asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid SEO page id' });
  const { id } = idParsed.data;

  const pool = getPool();
  const pageResult = await pool.query('SELECT content_format FROM seo_pages WHERE id = $1', [id]);
  if (pageResult.rowCount === 0) return res.status(404).json({ error: 'SEO page not found' });

  const active = await pool.query(
    'SELECT * FROM seo_page_content WHERE seo_page_id = $1 AND is_active = true LIMIT 1',
    [id]
  );
  const history = await pool.query(
    'SELECT version, content_format, created_at FROM seo_page_content WHERE seo_page_id = $1 ORDER BY version DESC LIMIT 5',
    [id]
  );

  res.json({
    contentFormat: pageResult.rows[0].content_format,
    active: active.rowCount > 0
      ? { rawContent: active.rows[0].raw_content, version: active.rows[0].version }
      : null,
    history: history.rows.map(h => ({ version: h.version, contentFormat: h.content_format, createdAt: h.created_at }))
  });
}));

const saveContentSchema = z.object({
  contentFormat: z.enum(CONTENT_FORMATS),
  // Same generous ceiling as legal_pages/templates' own html_content
  // column (routes/adminLegal.js) -- an SEO page's body is the same
  // shape of "large admin-authored content blob."
  rawContent: z.string().trim().min(1).max(500000)
});

router.put('/:id/content', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid SEO page id' });
  const bodyParsed = saveContentSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    const issue = bodyParsed.error.issues[0];
    return res.status(400).json({ error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'Invalid request body' });
  }
  const { id } = idParsed.data;
  const { contentFormat, rawContent } = bodyParsed.data;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const pageCheck = await client.query('SELECT id FROM seo_pages WHERE id = $1 FOR UPDATE', [id]);
    if (pageCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'SEO page not found' });
    }

    // FOR UPDATE on any existing content rows for this page serializes
    // concurrent saves of the same page's content, same reasoning as
    // every other single-active-version table in this schema.
    await client.query('SELECT id FROM seo_page_content WHERE seo_page_id = $1 FOR UPDATE', [id]);

    const maxVersionResult = await client.query(
      'SELECT COALESCE(MAX(version), 0) AS max_version FROM seo_page_content WHERE seo_page_id = $1',
      [id]
    );
    const nextVersion = Number(maxVersionResult.rows[0].max_version) + 1;

    await client.query(
      'UPDATE seo_page_content SET is_active = false WHERE seo_page_id = $1 AND is_active = true',
      [id]
    );

    const inserted = await client.query(
      `INSERT INTO seo_page_content (seo_page_id, raw_content, content_format, version, is_active)
       VALUES ($1, $2, $3, $4, true) RETURNING *`,
      [id, rawContent, contentFormat, nextVersion]
    );

    await client.query('UPDATE seo_pages SET content_format = $1 WHERE id = $2', [contentFormat, id]);

    await client.query('COMMIT');
    res.json({ version: inserted.rows[0].version, contentFormat });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SEO PAGE CONTENT] Failed to save content:', err.message);
    res.status(500).json({ error: 'Failed to save SEO page content' });
  } finally {
    client.release();
  }
}));

const rollbackParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  version: z.coerce.number().int().positive()
});

router.post('/:id/content/rollback/:version', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = rollbackParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid SEO page id or version' });
  }
  const { id, version } = parsed.data;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const target = await client.query(
      'SELECT id, content_format FROM seo_page_content WHERE seo_page_id = $1 AND version = $2 FOR UPDATE',
      [id, version]
    );
    if (target.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That content version does not exist' });
    }

    await client.query(
      'UPDATE seo_page_content SET is_active = false WHERE seo_page_id = $1 AND is_active = true',
      [id]
    );
    await client.query('UPDATE seo_page_content SET is_active = true WHERE id = $1', [target.rows[0].id]);
    // Real bug this closes (found by actually running the rollback flow
    // during this version's own testing): without this, rolling back to
    // a version saved under a different format than seo_pages'
    // CURRENT content_format left the two disagreeing, so the restored
    // raw_content rendered through the wrong renderer. Keeping this in
    // the same transaction as the two updates above means a reader can
    // never observe format and active content disagreeing mid-request.
    await client.query('UPDATE seo_pages SET content_format = $1 WHERE id = $2', [target.rows[0].content_format, id]);

    await client.query('COMMIT');
    res.json({ success: true, activeVersion: version, contentFormat: target.rows[0].content_format });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[SEO PAGE CONTENT] Failed to roll back content:', err.message);
    res.status(500).json({ error: 'Failed to roll back SEO page content' });
  } finally {
    client.release();
  }
}));

module.exports = router;
