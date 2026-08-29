const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { refreshLandingContentCache } = require('../lib/landingContent');
const { ALL_ICON_NAMES } = require('../lib/icons');
const { moveItem } = require('../lib/reorder');

const router = express.Router();
router.use(requireAdminSession);

// Steps can reasonably use either a UI icon (layout-template, pencil,
// rocket -- the seeded defaults) or a category icon (heart, gift, etc.)
// -- no reason to restrict an admin-authored step to a narrower set than
// the full curated library.
const STEP_ICON_NAMES = ALL_ICON_NAMES;

function formatStep(s) {
  return { id: s.id, iconName: s.icon_name, title: s.title, description: s.description, displayOrder: s.display_order };
}
function formatFooterLink(l) {
  return { id: l.id, label: l.label, url: l.url, displayOrder: l.display_order };
}

router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const [contentResult, stepsResult, linksResult] = await Promise.all([
    pool.query('SELECT * FROM landing_content ORDER BY id ASC LIMIT 1'),
    pool.query('SELECT * FROM landing_steps ORDER BY display_order ASC, id ASC'),
    pool.query('SELECT * FROM landing_footer_links ORDER BY display_order ASC, id ASC')
  ]);

  const c = contentResult.rows[0] || {};
  res.json({
    content: {
      heroHeadline: c.hero_headline || '',
      heroTagline: c.hero_tagline || '',
      heroCtaText: c.hero_cta_text || '',
      trustLineText: c.trust_line_text || '',
      footerText: c.footer_text || ''
    },
    steps: stepsResult.rows.map(formatStep),
    footerLinks: linksResult.rows.map(formatFooterLink)
  });
}));

const contentSchema = z.object({
  heroHeadline: z.string().trim().max(200).optional(),
  heroTagline: z.string().trim().max(500).optional(),
  heroCtaText: z.string().trim().max(100).optional(),
  trustLineText: z.string().trim().max(300).optional(),
  footerText: z.string().trim().max(300).optional()
});

router.put('/content', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = contentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid landing content' });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same single-row upsert pattern as routes/adminPaystack.js's
    // paystack_config -- lock the existing row (if any) before deciding
    // whether to UPDATE or INSERT, closing the same TOCTOU gap a plain
    // existence-check would have.
    const existing = await client.query('SELECT * FROM landing_content ORDER BY id ASC LIMIT 1 FOR UPDATE');
    const current = existing.rows[0] || {};
    const next = {
      hero_headline: parsed.data.heroHeadline !== undefined ? parsed.data.heroHeadline : current.hero_headline,
      hero_tagline: parsed.data.heroTagline !== undefined ? parsed.data.heroTagline : current.hero_tagline,
      hero_cta_text: parsed.data.heroCtaText !== undefined ? parsed.data.heroCtaText : current.hero_cta_text,
      trust_line_text: parsed.data.trustLineText !== undefined ? parsed.data.trustLineText : current.trust_line_text,
      footer_text: parsed.data.footerText !== undefined ? parsed.data.footerText : current.footer_text
    };

    if (existing.rowCount > 0) {
      await client.query(
        `UPDATE landing_content SET hero_headline = $1, hero_tagline = $2, hero_cta_text = $3,
           trust_line_text = $4, footer_text = $5, updated_at = NOW() WHERE id = $6`,
        [next.hero_headline, next.hero_tagline, next.hero_cta_text, next.trust_line_text, next.footer_text, current.id]
      );
    } else {
      await client.query(
        `INSERT INTO landing_content (hero_headline, hero_tagline, hero_cta_text, trust_line_text, footer_text)
         VALUES ($1, $2, $3, $4, $5)`,
        [next.hero_headline, next.hero_tagline, next.hero_cta_text, next.trust_line_text, next.footer_text]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[LANDING] Failed to save content:', err.message);
    return res.status(500).json({ error: 'Failed to save landing content' });
  } finally {
    client.release();
  }

  await refreshLandingContentCache();
  res.json({ success: true });
}));

// ---- steps ----

const stepSchema = z.object({
  iconName: z.enum(STEP_ICON_NAMES),
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(300)
});

router.post('/steps', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = stepSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid step data' });
  }
  const pool = getPool();
  const maxOrderResult = await pool.query('SELECT COALESCE(MAX(display_order), 0) AS max_order FROM landing_steps');
  const nextOrder = Number(maxOrderResult.rows[0].max_order) + 1;

  const result = await pool.query(
    'INSERT INTO landing_steps (icon_name, title, description, display_order) VALUES ($1, $2, $3, $4) RETURNING *',
    [parsed.data.iconName, parsed.data.title, parsed.data.description, nextOrder]
  );
  await refreshLandingContentCache();
  res.status(201).json(formatStep(result.rows[0]));
}));

router.put('/steps/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid step id' });
  const bodyParsed = stepSchema.partial().safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: 'Invalid step data' });

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM landing_steps WHERE id = $1', [idParsed.data.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Step not found' });
  const current = existing.rows[0];
  const { iconName, title, description } = bodyParsed.data;

  const result = await pool.query(
    'UPDATE landing_steps SET icon_name = $1, title = $2, description = $3 WHERE id = $4 RETURNING *',
    [
      iconName !== undefined ? iconName : current.icon_name,
      title !== undefined ? title : current.title,
      description !== undefined ? description : current.description,
      idParsed.data.id
    ]
  );
  await refreshLandingContentCache();
  res.json(formatStep(result.rows[0]));
}));

router.delete('/steps/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid step id' });
  const pool = getPool();
  const result = await pool.query('DELETE FROM landing_steps WHERE id = $1 RETURNING id', [idParsed.data.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Step not found' });
  await refreshLandingContentCache();
  res.json({ success: true });
}));

// v1.1.4: moveItem() itself now lives in lib/reorder.js (also used by the
// new routes/adminCategories.js) — behavior here is completely unchanged.
const moveSchema = z.object({ direction: z.enum(['up', 'down']) });

router.put('/steps/:id/move', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  const bodyParsed = moveSchema.safeParse(req.body);
  if (!idParsed.success || !bodyParsed.success) return res.status(400).json({ error: 'Invalid request' });

  const result = await moveItem(getPool(), 'landing_steps', idParsed.data.id, bodyParsed.data.direction);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Step not found' });
  if (result.error === 'no_neighbor') return res.status(200).json({ success: true }); // already at the end — no-op, not an error
  await refreshLandingContentCache();
  res.json({ success: true });
}));

// ---- footer links ----

const footerLinkSchema = z.object({
  label: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(500)
});

router.post('/footer-links', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = footerLinkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid footer link data' });

  const pool = getPool();
  const maxOrderResult = await pool.query('SELECT COALESCE(MAX(display_order), 0) AS max_order FROM landing_footer_links');
  const nextOrder = Number(maxOrderResult.rows[0].max_order) + 1;

  const result = await pool.query(
    'INSERT INTO landing_footer_links (label, url, display_order) VALUES ($1, $2, $3) RETURNING *',
    [parsed.data.label, parsed.data.url, nextOrder]
  );
  await refreshLandingContentCache();
  res.status(201).json(formatFooterLink(result.rows[0]));
}));

router.put('/footer-links/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid footer link id' });
  const bodyParsed = footerLinkSchema.partial().safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: 'Invalid footer link data' });

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM landing_footer_links WHERE id = $1', [idParsed.data.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Footer link not found' });
  const current = existing.rows[0];
  const { label, url } = bodyParsed.data;

  const result = await pool.query(
    'UPDATE landing_footer_links SET label = $1, url = $2 WHERE id = $3 RETURNING *',
    [label !== undefined ? label : current.label, url !== undefined ? url : current.url, idParsed.data.id]
  );
  await refreshLandingContentCache();
  res.json(formatFooterLink(result.rows[0]));
}));

router.delete('/footer-links/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid footer link id' });
  const pool = getPool();
  const result = await pool.query('DELETE FROM landing_footer_links WHERE id = $1 RETURNING id', [idParsed.data.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Footer link not found' });
  await refreshLandingContentCache();
  res.json({ success: true });
}));

router.put('/footer-links/:id/move', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  const bodyParsed = moveSchema.safeParse(req.body);
  if (!idParsed.success || !bodyParsed.success) return res.status(400).json({ error: 'Invalid request' });

  const result = await moveItem(getPool(), 'landing_footer_links', idParsed.data.id, bodyParsed.data.direction);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Footer link not found' });
  if (result.error === 'no_neighbor') return res.status(200).json({ success: true });
  await refreshLandingContentCache();
  res.json({ success: true });
}));

module.exports = router;
