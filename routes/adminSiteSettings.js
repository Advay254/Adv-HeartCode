const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { logEvent } = require('../lib/activityEvents');
const { getSiteSettings, refreshSiteSettingsCache, DEFAULTS } = require('../lib/siteSettings');
const { moveItem } = require('../lib/reorder');
const { refreshFooterExtrasCache } = require('../lib/footerExtras');
const analytics = require('../lib/analytics');

const router = express.Router();
router.use(requireAdminSession);

// Same six keys lib/siteSettings.js reads for public pages -- kept as one
// explicit list here (not imported from DEFAULTS' key set) so this
// schema is the single place that decides what's actually settable
// through this route, independent of what lib/siteSettings.js happens to
// default.
const updateSchema = z.object({
  manual_stats_number: z.string().trim().max(20).optional(),
  manual_stats_label: z.string().trim().max(200).optional(),
  favicon_url: z.string().trim().max(2000).optional(),
  og_image_url: z.string().trim().max(2000).optional(),
  meta_description: z.string().trim().max(500).optional(),
  site_title: z.string().trim().max(200).optional(),
  // v1.1.6 Part D: Organization structured data fields. Validated the
  // same permissive way favicon_url/og_image_url already are above --
  // trimmed + length-capped only, no .url()/.email() format enforcement
  // — so an empty string still passes through cleanly to "clear this
  // value" (this route's own established convention: every field here is
  // a plain per-key upsert, not the separate null-means-unchanged /
  // empty-means-clear convention used for encrypted admin config
  // elsewhere in this app -- see HANDOFF.md's "Secrets convention" note,
  // which applies to Paystack/AI provider keys specifically, not this
  // table).
  logo_url: z.string().trim().max(2000).optional(),
  contact_email: z.string().trim().max(254).optional(),
  social_twitter_url: z.string().trim().max(2000).optional(),
  social_facebook_url: z.string().trim().max(2000).optional(),
  social_instagram_url: z.string().trim().max(2000).optional(),
  social_linkedin_url: z.string().trim().max(2000).optional(),
  // v1.1.9 Part B: master on/off switch for the type-gallery/form price
  // display -- stored as the literal strings 'true'/'false' (matching
  // this table's existing all-strings convention), not a JSON boolean,
  // so the enum here is deliberately stricter than every url/text field
  // above it.
  show_type_prices_early: z.enum(['true', 'false']).optional(),
  // v1.2.12: master switch for the public /testimonials page only.
  testimonials_page_enabled: z.enum(['true', 'false']).optional(),
  // v1.2.6: stored as a string like every other row in this table (the
  // whole table is TEXT-valued), but constrained to a whole number 1-100
  // -- the actual value the WebP encoder in lib/imageProcessing.js
  // accepts. Read fresh per request by routes/apiBuild.js via
  // getSiteSettings() (see lib/siteSettings.js), so a change here is live
  // for the next form submission, not just the next page render.
  image_compression_quality: z.string().trim().refine((v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 100;
  }, { message: 'Must be a whole number between 1 and 100' }).optional()
});

router.get('/', asyncHandler(async (req, res) => {
  // Reads straight from the DB here, not the cached lib/siteSettings.js
  // helper -- the admin editing this form should always see the actual
  // current value, never a value that could be up to 60s stale from the
  // public-page cache.
  const pool = getPool();
  const result = await pool.query(
    'SELECT key, value FROM site_settings WHERE key = ANY($1)',
    [Object.keys(DEFAULTS)]
  );
  const values = { ...DEFAULTS };
  for (const row of result.rows) {
    if (row.value !== null && row.value !== undefined) values[row.key] = row.value;
  }
  res.json(values);
}));

router.put('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid site settings data' });
  }

  const pool = getPool();
  const entries = Object.entries(parsed.data);
  if (entries.length === 0) {
    return res.status(400).json({ error: 'No fields provided' });
  }

  // Each key is its own row in the generic site_settings table -- no
  // single-row/single-active invariant here (unlike paystack_config or
  // ai_providers.is_active), so a plain per-key upsert loop is enough;
  // there's no race condition a transaction would need to close.
  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO site_settings (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  }

  const fresh = await refreshSiteSettingsCache();
  await logEvent(pool, {
    eventType: 'admin_config_changed',
    title: 'Site settings updated',
    detail: entries.map(([key]) => key).join(', ')
  });
  res.json(fresh);
}));

// ---- analytics (v1.2.16) ----
//
// Its own pair of endpoints and its own card on the page (same shape as the
// resend-details limit card: a separate card with its own Save button). All
// analytics keys are saved together in one statement, so a failed save never
// leaves a half-updated connection, and the settings cache and the cached
// tracker script are refreshed straight after.

const analyticsSchema = z.object({
  enabled: z.boolean(),
  scriptUrl: z.string().max(600),
  websiteId: z.string().max(100),
  domains: z.string().max(1000),
  dnt: z.boolean(),
  afterInteraction: z.boolean(),
  performance: z.boolean(),
  recorder: z.boolean(),
  recorderUrl: z.string().max(600),
  proxy: z.boolean()
});

function formatAnalytics(values, req) {
  const get = (k) => values[analytics.SETTING_KEYS[k]];
  const cfg = analytics.readConfig({ ...values });
  return {
    enabled: get('enabled') === 'true',
    scriptUrl: get('scriptUrl') || '',
    websiteId: get('websiteId') || '',
    domains: get('domains') || '',
    dnt: get('dnt') !== 'false',
    afterInteraction: get('afterInteraction') === 'true',
    performance: get('performance') !== 'false',
    recorder: get('recorder') === 'true',
    recorderUrl: get('recorderUrl') || '',
    proxy: get('proxy') === 'true',
    defaultDomain: analytics.defaultDomain(req),
    dashboardUrl: cfg.enabled ? cfg.origin : '',
    defaultRecorderUrl: cfg.collectBase ? cfg.collectBase + '/recorder.js' : '',
    proxyScriptPath: analytics.PROXY_SCRIPT_PATH,
    proxyCollectPath: analytics.PROXY_COLLECT_PATH
  };
}

async function readAnalyticsValues(pool) {
  const keys = Object.values(analytics.SETTING_KEYS);
  const result = await pool.query('SELECT key, value FROM site_settings WHERE key = ANY($1)', [keys]);
  const values = { ...analytics.SETTING_DEFAULTS };
  for (const row of result.rows) {
    if (row.value !== null && row.value !== undefined) values[row.key] = row.value;
  }
  return values;
}

router.get('/analytics', asyncHandler(async (req, res) => {
  res.json(formatAnalytics(await readAnalyticsValues(getPool()), req));
}));

router.put('/analytics', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = analyticsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Some analytics fields are missing or the wrong type.' });
  }
  const checked = analytics.validateSettingsInput(parsed.data);
  if (!checked.ok) return res.status(400).json({ error: checked.error });

  const pool = getPool();
  const keys = Object.keys(checked.values);
  await pool.query(
    `INSERT INTO site_settings (key, value, updated_at)
     SELECT k, v, NOW() FROM unnest($1::text[], $2::text[]) AS t(k, v)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [keys, keys.map((k) => checked.values[k])]
  );

  analytics.clearScriptCache();
  await refreshSiteSettingsCache();
  await logEvent(pool, {
    eventType: 'admin_config_changed',
    title: 'Analytics settings updated',
    detail: parsed.data.enabled ? 'analytics on' : 'analytics off'
  });
  res.json(formatAnalytics(checked.values, req));
}));

// ---- custom footer links (v1.2.2 Part F) ----
//
// Structurally identical to routes/adminLanding.js's footer-links trio
// (same schema shape, same moveItem() helper, same refresh-cache-after-
// write pattern) -- see lib/footerExtras.js's own comment for why this is
// a separate table/cache from that one rather than reusing it.

function formatCustomLink(l) {
  return { id: l.id, label: l.label, url: l.url, displayOrder: l.display_order };
}

const customLinkSchema = z.object({
  label: z.string().trim().min(1).max(100),
  url: z.string().trim().min(1).max(500)
});

const moveSchema = z.object({ direction: z.enum(['up', 'down']) });

router.get('/custom-links', asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM custom_footer_links ORDER BY display_order ASC, id ASC');
  res.json(result.rows.map(formatCustomLink));
}));

router.post('/custom-links', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = customLinkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid custom link data' });

  const pool = getPool();
  const maxOrderResult = await pool.query('SELECT COALESCE(MAX(display_order), 0) AS max_order FROM custom_footer_links');
  const nextOrder = Number(maxOrderResult.rows[0].max_order) + 1;

  const result = await pool.query(
    'INSERT INTO custom_footer_links (label, url, display_order) VALUES ($1, $2, $3) RETURNING *',
    [parsed.data.label, parsed.data.url, nextOrder]
  );
  await refreshFooterExtrasCache();
  res.status(201).json(formatCustomLink(result.rows[0]));
}));

router.put('/custom-links/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid custom link id' });
  const bodyParsed = customLinkSchema.partial().safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: 'Invalid custom link data' });

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM custom_footer_links WHERE id = $1', [idParsed.data.id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Custom link not found' });
  const current = existing.rows[0];
  const { label, url } = bodyParsed.data;

  const result = await pool.query(
    'UPDATE custom_footer_links SET label = $1, url = $2 WHERE id = $3 RETURNING *',
    [label !== undefined ? label : current.label, url !== undefined ? url : current.url, idParsed.data.id]
  );
  await refreshFooterExtrasCache();
  res.json(formatCustomLink(result.rows[0]));
}));

router.delete('/custom-links/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid custom link id' });
  const pool = getPool();
  const result = await pool.query('DELETE FROM custom_footer_links WHERE id = $1 RETURNING id', [idParsed.data.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Custom link not found' });
  await refreshFooterExtrasCache();
  res.json({ success: true });
}));

router.put('/custom-links/:id/move', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
  const bodyParsed = moveSchema.safeParse(req.body);
  if (!idParsed.success || !bodyParsed.success) return res.status(400).json({ error: 'Invalid request' });

  const result = await moveItem(getPool(), 'custom_footer_links', idParsed.data.id, bodyParsed.data.direction);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Custom link not found' });
  if (result.error === 'no_neighbor') return res.status(200).json({ success: true });
  await refreshFooterExtrasCache();
  res.json({ success: true });
}));

module.exports = router;
