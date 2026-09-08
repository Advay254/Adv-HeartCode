const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { refreshLandingSectionsCache, formatSection } = require('../lib/landingSections');
const { SECTION_TYPES, DEFAULT_CONTENT, validateSectionContent, preserveImageAssetKeys } = require('../lib/landingSectionTypes');

const router = express.Router();
router.use(requireAdminSession);

// v1.2.0: every route below is now scoped by page_slug (query param on
// GET, body field on POST) so this same admin API serves the homepage's
// section list AND every independent SEO page's own section list,
// exactly like lib/landingSections.js's cache is now keyed per page_slug
// instead of one shared array. Defaults to 'home' everywhere a caller
// omits it, so this stays fully backward compatible with any client code
// written before this version existed.
const pageSlugSchema = z.string().trim().min(1).max(150).optional().default('home');

// Admin sees EVERY row for the requested page (including inactive ones)
// — unlike the public getLandingSections() cache, which only ever
// returns active rows for that page. No caching here either: this is a
// low-traffic, admin-only, always-fresh read, same reasoning as
// routes/adminLanding.js's own GET handlers.
router.get('/', asyncHandler(async (req, res) => {
  const pageSlug = pageSlugSchema.parse(req.query.page);
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM landing_sections WHERE page_slug = $1 ORDER BY display_order ASC, id ASC',
    [pageSlug]
  );
  res.json({
    pageSlug,
    sections: result.rows.map(formatSection),
    sectionTypes: SECTION_TYPES,
    defaultContent: DEFAULT_CONTENT
  });
}));

const createSchema = z.object({
  sectionType: z.enum(SECTION_TYPES),
  content: z.record(z.string(), z.unknown()).optional(),
  pageSlug: z.string().trim().min(1).max(150).optional().default('home')
});

router.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid section_type' });
  }
  const { sectionType, content, pageSlug } = parsed.data;
  // A freshly-created section always starts with no image (empty
  // image_asset_key/keys) — there's no image-picker UI, and forcing this
  // here (rather than just leaving it out of the admin's create form)
  // means a raw API call can't set one either. See
  // lib/landingSectionTypes.js's preserveImageAssetKeys() comment.
  const rawContent = preserveImageAssetKeys(sectionType, {}, content !== undefined ? content : DEFAULT_CONTENT[sectionType]);
  const validated = validateSectionContent(sectionType, rawContent);
  if (!validated.success) {
    return res.status(400).json({ error: validated.error });
  }

  const pool = getPool();
  // Scoped to THIS page's own rows only -- each page has its own
  // independent ordered list starting from its own max, not one shared
  // global counter (see this file's top-of-file comment).
  const maxOrderResult = await pool.query(
    'SELECT COALESCE(MAX(display_order), 0) AS max_order FROM landing_sections WHERE page_slug = $1',
    [pageSlug]
  );
  const nextOrder = Number(maxOrderResult.rows[0].max_order) + 1;

  const result = await pool.query(
    'INSERT INTO landing_sections (section_type, content, display_order, page_slug) VALUES ($1, $2, $3, $4) RETURNING *',
    [sectionType, JSON.stringify(validated.data), nextOrder, pageSlug]
  );
  await refreshLandingSectionsCache(pageSlug);
  res.status(201).json(formatSection(result.rows[0]));
}));

const idSchema = z.object({ id: z.coerce.number().int().positive() });

router.put('/:id/content', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid section id' });

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM landing_sections WHERE id = $1', [idParsed.data.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Section not found' });
  const current = existing.rows[0];

  // Force image_asset_key(s) to stay exactly what they already were,
  // regardless of what the request body contains — see
  // lib/landingSectionTypes.js's preserveImageAssetKeys() comment for why
  // this has to happen server-side, not just by omission from the form.
  const rawContent = preserveImageAssetKeys(current.section_type, current.content, req.body ? req.body.content : undefined);
  const validated = validateSectionContent(current.section_type, rawContent);
  if (!validated.success) {
    return res.status(400).json({ error: validated.error });
  }

  const result = await pool.query(
    'UPDATE landing_sections SET content = $1 WHERE id = $2 RETURNING *',
    [JSON.stringify(validated.data), idParsed.data.id]
  );
  await refreshLandingSectionsCache(current.page_slug);
  res.json(formatSection(result.rows[0]));
}));

const activeSchema = z.object({ isActive: z.boolean() });

router.put('/:id/active', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idSchema.safeParse(req.params);
  const bodyParsed = activeSchema.safeParse(req.body);
  if (!idParsed.success || !bodyParsed.success) return res.status(400).json({ error: 'Invalid request' });

  const pool = getPool();
  const existing = await pool.query('SELECT page_slug FROM landing_sections WHERE id = $1', [idParsed.data.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Section not found' });

  const result = await pool.query(
    'UPDATE landing_sections SET is_active = $1 WHERE id = $2 RETURNING *',
    [bodyParsed.data.isActive, idParsed.data.id]
  );
  await refreshLandingSectionsCache(existing.rows[0].page_slug);
  res.json(formatSection(result.rows[0]));
}));

router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid section id' });
  const pool = getPool();
  const existing = await pool.query('SELECT page_slug FROM landing_sections WHERE id = $1', [idParsed.data.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Section not found' });
  await pool.query('DELETE FROM landing_sections WHERE id = $1', [idParsed.data.id]);
  await refreshLandingSectionsCache(existing.rows[0].page_slug);
  res.json({ success: true });
}));

// Swaps this row's display_order with its immediate neighbor — identical
// mechanism (and identical reasoning) to routes/adminLanding.js's
// moveItem helper: transactional row-lock swap, no drag-and-drop
// dependency, matching this admin's mobile-first constraint.
//
// v1.2.0: the neighbor lookup is now scoped to `page_slug = current.page_slug`
// — without this, a section on a short SEO page could swap display_order
// with a numerically-nearby section belonging to a COMPLETELY different
// page's list (e.g. the homepage's), which would corrupt both pages'
// ordering in a way that would only surface as "sections are in a weird
// order" with no obvious cause. Each page's list must stay a closed loop
// that never reaches into another page's rows.
async function moveSection(pool, id, direction) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query('SELECT * FROM landing_sections WHERE id = $1 FOR UPDATE', [id]);
    if (currentResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: 'not_found' };
    }
    const current = currentResult.rows[0];

    const comparator = direction === 'up' ? '<' : '>';
    const order = direction === 'up' ? 'DESC' : 'ASC';
    const neighborResult = await client.query(
      `SELECT * FROM landing_sections WHERE page_slug = $1 AND display_order ${comparator} $2 ORDER BY display_order ${order} LIMIT 1 FOR UPDATE`,
      [current.page_slug, current.display_order]
    );
    if (neighborResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return { error: 'no_neighbor' };
    }
    const neighbor = neighborResult.rows[0];

    await client.query('UPDATE landing_sections SET display_order = $1 WHERE id = $2', [neighbor.display_order, current.id]);
    await client.query('UPDATE landing_sections SET display_order = $1 WHERE id = $2', [current.display_order, neighbor.id]);
    await client.query('COMMIT');
    return { success: true, pageSlug: current.page_slug };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const moveSchema = z.object({ direction: z.enum(['up', 'down']) });

router.put('/:id/move', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idSchema.safeParse(req.params);
  const bodyParsed = moveSchema.safeParse(req.body);
  if (!idParsed.success || !bodyParsed.success) return res.status(400).json({ error: 'Invalid request' });

  const result = await moveSection(getPool(), idParsed.data.id, bodyParsed.data.direction);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Section not found' });
  if (result.error === 'no_neighbor') return res.status(200).json({ success: true }); // already at the end — no-op, not an error
  await refreshLandingSectionsCache(result.pageSlug);
  res.json({ success: true });
}));

module.exports = router;
