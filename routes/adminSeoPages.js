const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { slugify } = require('../lib/slugify');
const { isReservedTopLevelSlug } = require('../lib/reservedSlugs');
const { refreshLandingSectionsCache } = require('../lib/landingSections');

const router = express.Router();
router.use(requireAdminSession);

function formatSeoPage(p) {
  return {
    id: p.id,
    slug: p.slug,
    pageTitle: p.page_title,
    metaDescription: p.meta_description,
    targetWebsiteTypeId: p.target_website_type_id,
    ctaText: p.cta_text,
    isActive: p.is_active,
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
  // A brand-new SEO page has zero landing_sections rows yet -- there is
  // nothing to cache -- but this seeds an empty cache entry for its
  // page_slug up front so the very first public request for it doesn't
  // need to distinguish "never cached" from "genuinely has zero active
  // sections" (both render the same minimal hero-only fallback either
  // way; this just avoids one redundant DB round trip on that first hit).
  await refreshLandingSectionsCache(baseSlug);
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
  // page's cached landing_sections key (page_slug) and its live public
  // URL; silently changing it here would orphan every section already
  // saved under the old page_slug. An admin who genuinely needs a
  // different URL deletes this page and creates a new one, the same
  // tradeoff website_types.slug already accepts for the same reason
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
  res.json(formatSeoPage(result.rows[0]));
}));

router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid SEO page id' });

  const pool = getPool();
  const result = await pool.query('DELETE FROM seo_pages WHERE id = $1 RETURNING slug', [idParsed.data.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'SEO page not found' });

  // Deliberately NOT deleting this page's landing_sections rows (its
  // page_slug simply becomes orphaned, exactly like website_types rows
  // stay put when their category is deleted) -- an admin who re-creates
  // an SEO page with the exact same slug later gets its old sections
  // back rather than starting from a blank hero, and nothing on the
  // public site can ever reach an orphaned page_slug's sections anyway
  // once its seo_pages row is gone (GET /:seoSlug 404s with no matching
  // row to render against). Only the in-memory cache entry is cleared,
  // so a stale cached copy can't outlive the deletion within its TTL
  // window.
  await refreshLandingSectionsCache(result.rows[0].slug);
  res.json({ success: true });
}));

module.exports = router;
