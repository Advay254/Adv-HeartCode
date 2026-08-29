const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { getSiteSettings, refreshSiteSettingsCache, DEFAULTS } = require('../lib/siteSettings');

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
  social_linkedin_url: z.string().trim().max(2000).optional()
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
  res.json(fresh);
}));

module.exports = router;
