'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../lib/asyncHandler');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { validatePlainText } = require('../lib/promoText');
const { resolvePublicBaseUrl } = require('../lib/publicUrl');
const promotions = require('../lib/promotions');
const { buildSnippets } = require('../lib/promoRender');
const card = require('../lib/promoCard');

// v1.2.13: admin API for promotion campaigns. Session-gated, and every
// state-changing route is CSRF-gated, like every other admin router.

const router = express.Router();
router.use(requireAdminSession);

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const campaignBodySchema = z.object({
  label: z.string().max(400),
  mode: z.enum(['general', 'category']),
  categoryId: z.coerce.number().int().positive().nullable().optional(),
  theme: z.enum(['light', 'dark', 'auto']),
  // '' (or omitted) means "use the brand colours".
  accentColor: z.string().trim().max(20).optional(),
  cardBg: z.string().trim().max(20).optional(),
  textColor: z.string().trim().max(20).optional(),
  corner: z.enum(['sharp', 'soft', 'round']).optional(),
  density: z.enum(['compact', 'comfortable']).optional(),
  // Preview only: the theme the campaign is set to, for the contrast check
  // (the preview itself is drawn in light or dark).
  formTheme: z.enum(['light', 'dark', 'auto']).optional(),
  customHeadline: z.string().max(400).optional(),
  customLine: z.string().max(600).optional(),
  buttonLabel: z.string().max(400).optional()
});

const activeBodySchema = z.object({ isActive: z.boolean() });

/**
 * Applies every content rule to a parsed body. Returns { ok: true, values }
 * with normalized, ready-to-store values, or { ok: false, errors } where
 * errors maps a field name to a message.
 */
function validateCampaign(body) {
  const errors = {};

  const label = (body.label || '').replace(/\s+/g, ' ').trim();
  if (!label) errors.label = 'Label is required.';
  else if (Array.from(label).length > 100) errors.label = 'Label must be 100 characters or fewer.';

  const headline = validatePlainText(body.customHeadline || '', { max: promotions.HEADLINE_MAX, label: 'Headline' });
  if (!headline.ok) errors.customHeadline = headline.error;

  const line = validatePlainText(body.customLine || '', { max: promotions.LINE_MAX, label: 'Supporting line' });
  if (!line.ok) errors.customLine = line.error;

  const buttonRaw = body.buttonLabel === undefined ? promotions.DEFAULT_BUTTON_LABEL : body.buttonLabel;
  const button = validatePlainText(buttonRaw, { max: promotions.BUTTON_MAX, label: 'Button label' });
  if (!button.ok) errors.buttonLabel = button.error;
  else if (!button.value) errors.buttonLabel = 'Button label is required.';

  const accent = (body.accentColor || '').trim();
  if (accent && !HEX_RE.test(accent)) errors.accentColor = 'Accent colour must look like #RRGGBB, or be left blank.';

  const cardBg = (body.cardBg || '').trim();
  if (cardBg && !HEX_RE.test(cardBg)) errors.cardBg = 'Card background must look like #RRGGBB, or be left blank.';
  const textColor = (body.textColor || '').trim();
  if (textColor && !HEX_RE.test(textColor)) errors.textColor = 'Text colour must look like #RRGGBB, or be left blank.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // Readability. Low contrast is a warning (shown live in the form), and
  // extremely low contrast cannot be saved.
  const contrast = card.checkContrast({
    accent_color: accent ? accent.toLowerCase() : null,
    card_bg: cardBg ? cardBg.toLowerCase() : null,
    text_color: textColor ? textColor.toLowerCase() : null,
    theme: body.theme
  });
  if (contrast.level === 'block') {
    errors.contrast = contrast.messages.join(' ') + ' Choose colours with more contrast.';
    return { ok: false, errors };
  }

  return {
    ok: true,
    values: {
      label,
      mode: body.mode,
      theme: body.theme,
      accentColor: accent ? accent.toLowerCase() : null,
      cardBg: cardBg ? cardBg.toLowerCase() : null,
      textColor: textColor ? textColor.toLowerCase() : null,
      corner: body.corner || card.DEFAULT_CORNER,
      density: body.density || card.DEFAULT_DENSITY,
      contrast,
      customHeadline: headline.value || null,
      customLine: line.value || null,
      buttonLabel: button.value
    }
  };
}

async function categoryExists(id) {
  const result = await getPool().query('SELECT 1 FROM website_categories WHERE id = $1', [id]);
  return result.rowCount > 0;
}

// ---- list ----
router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const [campaigns, categories] = await Promise.all([
    promotions.listCampaigns(),
    // Every category that currently exists, in the order the site shows them.
    pool.query('SELECT id, name, is_active FROM website_categories ORDER BY display_order ASC, id ASC')
  ]);
  const base = resolvePublicBaseUrl(req);
  res.json({
    campaigns,
    categories: categories.rows.map((c) => ({ id: c.id, name: c.name, isActive: c.is_active })),
    publicBaseUrl: base.url,
    publicBaseUrlSource: base.source,
    defaultButtonLabel: promotions.DEFAULT_BUTTON_LABEL
  });
}));

// ---- preview ----
//
// Builds the same config the public config endpoint serves, from the values
// currently in the form (saved or not), so the admin preview renders the real
// promo. Nothing is stored, and links in a preview are plain site paths with
// no tracking token, so previewing never counts.
router.post('/preview', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = campaignBodySchema.partial({ label: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
  const checked = validateCampaign({
    ...parsed.data,
    label: parsed.data.label || 'Preview',
    theme: parsed.data.formTheme || parsed.data.theme
  });
  if (!checked.ok) return res.status(422).json({ errors: checked.errors });

  const v = checked.values;
  const draft = {
    mode: v.mode,
    category_id: parsed.data.mode === 'category' ? (parsed.data.categoryId || null) : null,
    theme: parsed.data.theme,
    accent_color: v.accentColor,
    card_bg: v.cardBg,
    text_color: v.textColor,
    corner: v.corner,
    density: v.density,
    custom_headline: v.customHeadline,
    custom_line: v.customLine,
    button_label: v.buttonLabel,
    is_active: true
  };
  const { config, effectiveMode, categoryUnavailable } = await promotions.buildConfig(draft, null);
  res.json({ config, effectiveMode, categoryUnavailable, contrast: v.contrast });
}));

// ---- create ----
router.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = campaignBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
  const checked = validateCampaign(parsed.data);
  if (!checked.ok) return res.status(422).json({ errors: checked.errors });
  const v = checked.values;

  let categoryId = null;
  if (v.mode === 'category') {
    categoryId = parsed.data.categoryId || null;
    if (!categoryId) return res.status(422).json({ errors: { categoryId: 'Choose a category.' } });
    if (!(await categoryExists(categoryId))) {
      return res.status(422).json({ errors: { categoryId: 'That category does not exist.' } });
    }
  }

  const result = await getPool().query(
    `INSERT INTO promotion_campaigns
       (label, token, mode, category_id, theme, accent_color, card_bg, text_color, corner, density,
        custom_headline, custom_line, button_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [v.label, promotions.createToken(), v.mode, categoryId, v.theme, v.accentColor, v.cardBg, v.textColor,
      v.corner, v.density, v.customHeadline, v.customLine, v.buttonLabel]
  );
  res.status(201).json(await promotions.getCampaignForAdmin(result.rows[0].id));
}));

// ---- update ----
router.put('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid campaign id' });
  const parsed = campaignBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
  const checked = validateCampaign(parsed.data);
  if (!checked.ok) return res.status(422).json({ errors: checked.errors });
  const v = checked.values;
  const { id } = idParsed.data;

  const existing = await getPool().query('SELECT id, mode, category_id FROM promotion_campaigns WHERE id = $1', [id]);
  if (existing.rowCount === 0) return res.status(404).json({ error: 'Campaign not found' });
  const current = existing.rows[0];

  let categoryId = null;
  if (v.mode === 'category') {
    categoryId = parsed.data.categoryId || null;
    // A campaign whose category was deleted has no category to keep, and that
    // must never stop it from being edited. It may stay as it is (and keeps
    // serving the general promotion) until a new category is chosen.
    const alreadyWithoutCategory = current.mode === 'category' && current.category_id === null;
    if (!categoryId && !alreadyWithoutCategory) {
      return res.status(422).json({ errors: { categoryId: 'Choose a category.' } });
    }
    if (categoryId && !(await categoryExists(categoryId))) {
      return res.status(422).json({ errors: { categoryId: 'That category does not exist.' } });
    }
  }

  await getPool().query(
    `UPDATE promotion_campaigns
     SET label = $1, mode = $2, category_id = $3, theme = $4, accent_color = $5, card_bg = $6,
         text_color = $7, corner = $8, density = $9, custom_headline = $10, custom_line = $11,
         button_label = $12, updated_at = NOW()
     WHERE id = $13`,
    [v.label, v.mode, categoryId, v.theme, v.accentColor, v.cardBg, v.textColor, v.corner, v.density,
      v.customHeadline, v.customLine, v.buttonLabel, id]
  );
  res.json(await promotions.getCampaignForAdmin(id));
}));

// ---- on / off ----
router.put('/:id/active', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  const bodyParsed = activeBodySchema.safeParse(req.body);
  if (!idParsed.success || !bodyParsed.success) return res.status(400).json({ error: 'Invalid request' });

  const result = await getPool().query(
    'UPDATE promotion_campaigns SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
    [bodyParsed.data.isActive, idParsed.data.id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Campaign not found' });
  res.json(await promotions.getCampaignForAdmin(idParsed.data.id));
}));

// ---- delete ----
// Stats go with the campaign (ON DELETE CASCADE). A snippet still placed on
// another website then serves the general promotion, uncounted.
router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid campaign id' });
  const result = await getPool().query('DELETE FROM promotion_campaigns WHERE id = $1 RETURNING id', [idParsed.data.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Campaign not found' });
  res.json({ success: true });
}));

// ---- build script ----
//
// The three snippets, built now from live settings: the public address, the
// site name and the brand colours are all read at this moment.
router.get('/:id/snippets', asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid campaign id' });

  const result = await getPool().query('SELECT * FROM promotion_campaigns WHERE id = $1', [idParsed.data.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = result.rows[0];

  const base = resolvePublicBaseUrl(req);
  // Build from the campaign as saved, but always as if it were on: the
  // snippet text does not depend on the switch.
  const { config } = await promotions.buildConfig({ ...campaign, is_active: true }, campaign.token);
  const snippets = buildSnippets({ base: base.url, campaign, config });

  res.json({
    publicBaseUrl: base.url,
    publicBaseUrlSource: base.source,
    snippets: { script: snippets.script, iframe: snippets.iframe, html: snippets.html },
    scriptUrl: snippets.scriptUrl,
    legacyScriptUrl: snippets.legacyScriptUrl,
    iframeHeight: snippets.iframeHeight
  });
}));

module.exports = router;
