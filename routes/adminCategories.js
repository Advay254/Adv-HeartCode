const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { CATEGORY_ICON_NAMES, DEFAULT_ICON_NAME } = require('../lib/icons');
const { slugify } = require('../lib/slugify');
const { moveItem } = require('../lib/reorder');

const router = express.Router();
router.use(requireAdminSession);

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const moveSchema = z.object({ direction: z.enum(['up', 'down']) });

function formatCategory(c) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    iconName: c.icon_name,
    displayOrder: c.display_order,
    isActive: c.is_active
  };
}

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().max(100).optional(),
  // v1.1.6 Part E: lowered from 1000 -> 140. A category's description
  // renders inside a fixed-size /explore card (views/public/explore.ejs)
  // alongside a title, icon, and type-count line -- with no cap, a long
  // description could make that one card's grid ROW taller than its
  // siblings (CSS Grid stretches every item in a row to the tallest one).
  // 140 characters is short enough to read as a one-line teaser at this
  // card's width in the common case, and paired with the SAME cards'
  // new line-clamp-2 (a display-only, non-destructive safety net for
  // anything already saved longer than this before the limit existed —
  // see explore.ejs/explore-category.ejs) so layout stays consistent
  // either way. This only constrains NEW saves going forward -- an
  // existing row already over 140 characters is untouched in the
  // database by this change; it simply can't be re-saved without being
  // shortened first (or with description omitted from the PUT body
  // entirely, in which case updateCategorySchema below never even
  // evaluates the existing value against this limit -- see current.description
  // in the PUT handler below).
  description: z.string().max(140).optional(),
  iconName: z.enum(CATEGORY_ICON_NAMES).optional()
});

const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(140).optional(),
  iconName: z.enum(CATEGORY_ICON_NAMES).optional(),
  isActive: z.boolean().optional()
});

router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const categories = await pool.query('SELECT * FROM website_categories ORDER BY display_order ASC, id ASC');

  // Same "count of types in this category" convenience GET /website-types
  // already provides per type (fieldCount) -- helps the admin see at a
  // glance whether deleting/deactivating a category leaves types stranded.
  const results = [];
  for (const c of categories.rows) {
    const countResult = await pool.query(
      'SELECT COUNT(*) FROM website_types WHERE category_id = $1',
      [c.id]
    );
    results.push({ ...formatCategory(c), typeCount: Number(countResult.rows[0].count) });
  }
  res.json(results);
}));

router.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = createCategorySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'name is required' });
  }
  const { name, description, iconName, slug: providedSlug } = parsed.data;

  const baseSlug = slugify(providedSlug || name);
  if (!baseSlug) {
    return res.status(400).json({ error: 'Could not derive a valid slug from name' });
  }

  const pool = getPool();
  const conflict = await pool.query('SELECT id FROM website_categories WHERE slug = $1', [baseSlug]);
  if (conflict.rowCount > 0) {
    return res.status(409).json({ error: `slug "${baseSlug}" is already in use`, conflictField: 'slug' });
  }

  const maxOrderResult = await pool.query('SELECT COALESCE(MAX(display_order), 0) AS max_order FROM website_categories');
  const nextOrder = Number(maxOrderResult.rows[0].max_order) + 1;

  const result = await pool.query(
    `INSERT INTO website_categories (name, slug, description, icon_name, display_order)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [name, baseSlug, description || '', iconName || DEFAULT_ICON_NAME, nextOrder]
  );
  res.status(201).json({ ...formatCategory(result.rows[0]), typeCount: 0 });
}));

router.put('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid category id' });
  }
  const bodyParsed = updateCategorySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  const { id } = paramsParsed.data;
  const { name, description, iconName, isActive } = bodyParsed.data;

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM website_categories WHERE id = $1', [id]);
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'Category not found' });
  }
  const current = existing.rows[0];

  const next = {
    name: name !== undefined ? name : current.name,
    description: description !== undefined ? description : current.description,
    icon_name: iconName !== undefined ? iconName : current.icon_name,
    is_active: isActive !== undefined ? isActive : current.is_active
  };

  const result = await pool.query(
    `UPDATE website_categories SET name = $1, description = $2, icon_name = $3, is_active = $4
     WHERE id = $5 RETURNING *`,
    [next.name, next.description, next.icon_name, next.is_active, id]
  );
  const countResult = await pool.query('SELECT COUNT(*) FROM website_types WHERE category_id = $1', [id]);
  res.json({ ...formatCategory(result.rows[0]), typeCount: Number(countResult.rows[0].count) });
}));

router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid category id' });
  }
  const { id } = parsed.data;

  const pool = getPool();
  // website_types.category_id is ON DELETE SET NULL -- deleting a
  // category never deletes or hides the types inside it, it just
  // uncategorizes them (see db/init.js's v1.1.4 migration comment).
  const result = await pool.query('DELETE FROM website_categories WHERE id = $1 RETURNING id', [id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Category not found' });
  }
  res.json({ success: true });
}));

router.put('/:id/move', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  const bodyParsed = moveSchema.safeParse(req.body);
  if (!idParsed.success || !bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const result = await moveItem(getPool(), 'website_categories', idParsed.data.id, bodyParsed.data.direction);
  if (result.error === 'not_found') {
    return res.status(404).json({ error: 'Category not found' });
  }
  if (result.error === 'no_neighbor') {
    return res.status(200).json({ success: true }); // already at the end — no-op, not an error
  }
  res.json({ success: true });
}));

module.exports = router;
