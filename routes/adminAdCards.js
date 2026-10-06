'use strict';

const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../lib/asyncHandler');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { validatePlainText } = require('../lib/promoText');
const media = require('../lib/adMedia');
const card = require('../lib/promoCard');
const adCards = require('../lib/adCards');
const promotions = require('../lib/promotions');

// v1.2.15: admin API for ad cards. Session-gated, and every state-changing
// route is CSRF-gated, like every other admin router.
//
// Nothing here ever requests a media link. Links are checked as text only
// (https, no spaces, no credentials); the admin preview and the visitor's
// browser are the only things that load them.

const router = express.Router();
router.use(requireAdminSession);

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const bodySchema = z.object({
  name: z.string().max(400),
  layout: z.enum(['text', 'media', 'banner']),
  mediaUrl: z.string().max(3000).optional(),
  mediaKind: z.enum(['image', 'video']).optional(),
  ratioW: z.coerce.number().optional(),
  ratioH: z.coerce.number().optional(),
  mediaFit: z.enum(['fill', 'fit']).optional(),
  mediaAlt: z.string().max(1000).optional(),
  stillUrl: z.string().max(3000).optional(),
  headline: z.string().max(400).optional(),
  line: z.string().max(600).optional(),
  buttonLabel: z.string().max(400).optional(),
  destTypeId: z.coerce.number().int().positive().nullable().optional(),
  accentColor: z.string().trim().max(20).optional(),
  cardBg: z.string().trim().max(20).optional(),
  textColor: z.string().trim().max(20).optional(),
  corner: z.enum(['', 'sharp', 'soft', 'round']).optional(),
  density: z.enum(['', 'compact', 'comfortable']).optional(),
  isActive: z.boolean().optional(),
  startsOn: z.string().trim().max(10).optional(),
  endsOn: z.string().trim().max(10).optional(),
  weight: z.coerce.number().optional(),
  allCampaigns: z.boolean().optional(),
  campaignIds: z.array(z.coerce.number().int().positive()).max(500).optional(),
  // Preview only
  previewTheme: z.enum(['light', 'dark']).optional()
});

function validDay(value) {
  if (!DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

async function activeTypeExists(id) {
  const result = await getPool().query(
    'SELECT 1 FROM website_types WHERE id = $1 AND is_active = true AND is_deleted_placeholder = false',
    [id]
  );
  return result.rowCount > 0;
}

/**
 * Applies every rule. Returns { ok: true, values } with normalized values
 * ready to store, or { ok: false, errors } mapping a field to a message.
 */
async function validateAd(body, { requireCampaignsExist = true } = {}) {
  const errors = {};

  const name = (body.name || '').replace(/\s+/g, ' ').trim();
  if (!name) errors.name = 'Name is required.';
  else if (Array.from(name).length > 100) errors.name = 'Name must be 100 characters or fewer.';

  const headline = validatePlainText(body.headline || '', { max: promotions.HEADLINE_MAX, label: 'Headline' });
  if (!headline.ok) errors.headline = headline.error;
  else if (!headline.value) errors.headline = 'Headline is required.';

  const line = validatePlainText(body.line || '', { max: promotions.LINE_MAX, label: 'Supporting line' });
  if (!line.ok) errors.line = line.error;

  const buttonRaw = body.buttonLabel === undefined ? promotions.DEFAULT_BUTTON_LABEL : body.buttonLabel;
  const button = validatePlainText(buttonRaw, { max: promotions.BUTTON_MAX, label: 'Button label' });
  if (!button.ok) errors.buttonLabel = button.error;
  else if (!button.value) errors.buttonLabel = 'Button label is required.';

  // ---- media (text cards have none) ----
  let mediaUrl = null;
  let mediaAlt = null;
  let stillUrl = null;
  let ratio = { w: 16, h: 9 };
  const kind = body.mediaKind || 'image';
  if (body.layout !== 'text') {
    const link = media.validateMediaLink(body.mediaUrl, 'The media link');
    if (!link.ok) errors.mediaUrl = link.error;
    else mediaUrl = link.value;

    const alt = media.validateAlt(body.mediaAlt);
    if (!alt.ok) errors.mediaAlt = alt.error;
    else mediaAlt = alt.value;

    const r = media.validateRatio(body.ratioW, body.ratioH);
    if (!r.ok) errors.ratio = r.error;
    else ratio = r.value;

    if ((body.stillUrl || '').trim()) {
      const still = media.validateMediaLink(body.stillUrl, 'The still image link');
      if (!still.ok) errors.stillUrl = still.error;
      else stillUrl = still.value;
    }
  }

  // ---- destination ----
  let destTypeId = null;
  if (body.destTypeId) {
    destTypeId = body.destTypeId;
    if (!(await activeTypeExists(destTypeId))) errors.destTypeId = 'Choose an active website type, or the home page.';
  }

  // ---- appearance ----
  const accent = (body.accentColor || '').trim();
  if (accent && !HEX_RE.test(accent)) errors.accentColor = 'Accent colour must look like #RRGGBB, or be left blank.';
  const cardBg = (body.cardBg || '').trim();
  if (cardBg && !HEX_RE.test(cardBg)) errors.cardBg = 'Card background must look like #RRGGBB, or be left blank.';
  const textColor = (body.textColor || '').trim();
  if (textColor && !HEX_RE.test(textColor)) errors.textColor = 'Text colour must look like #RRGGBB, or be left blank.';

  // ---- schedule and weight ----
  const startsOn = (body.startsOn || '').trim();
  const endsOn = (body.endsOn || '').trim();
  if (startsOn && !validDay(startsOn)) errors.startsOn = 'Start date must be a real date (YYYY-MM-DD), or blank.';
  if (endsOn && !validDay(endsOn)) errors.endsOn = 'End date must be a real date (YYYY-MM-DD), or blank.';
  if (!errors.startsOn && !errors.endsOn && startsOn && endsOn && endsOn < startsOn) {
    errors.endsOn = 'The end date cannot be before the start date.';
  }
  const weight = body.weight === undefined || Number.isNaN(body.weight) ? 5 : body.weight;
  if (!Number.isInteger(weight) || weight < 1 || weight > 10) errors.weight = 'Weight must be a whole number from 1 to 10.';

  // ---- assigned campaigns ----
  const allCampaigns = body.allCampaigns !== false;
  let campaignIds = [];
  if (!allCampaigns) {
    campaignIds = Array.from(new Set(body.campaignIds || []));
    if (campaignIds.length === 0) {
      errors.campaignIds = 'Choose at least one campaign, or assign the card to all campaigns.';
    } else if (requireCampaignsExist) {
      const found = await getPool().query('SELECT id FROM promotion_campaigns WHERE id = ANY($1::int[])', [campaignIds]);
      if (found.rowCount !== campaignIds.length) errors.campaignIds = 'One of the chosen campaigns no longer exists.';
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  // Readability of the card's own colours over the defaults, in both themes.
  const contrast = card.checkContrast({
    accent_color: accent ? accent.toLowerCase() : null,
    card_bg: cardBg ? cardBg.toLowerCase() : null,
    text_color: textColor ? textColor.toLowerCase() : null,
    theme: 'auto'
  });
  if (contrast.level === 'block') {
    errors.contrast = contrast.messages.join(' ') + ' Choose colours with more contrast.';
    return { ok: false, errors };
  }

  return {
    ok: true,
    values: {
      name,
      layout: body.layout,
      mediaUrl,
      mediaKind: kind,
      ratioW: ratio.w,
      ratioH: ratio.h,
      mediaFit: body.mediaFit || 'fill',
      mediaAlt,
      stillUrl,
      headline: headline.value,
      line: line.value || null,
      buttonLabel: button.value,
      destTypeId,
      accentColor: accent ? accent.toLowerCase() : null,
      cardBg: cardBg ? cardBg.toLowerCase() : null,
      textColor: textColor ? textColor.toLowerCase() : null,
      corner: body.corner || null,
      density: body.density || null,
      isActive: body.isActive !== false,
      startsOn: startsOn || null,
      endsOn: endsOn || null,
      weight,
      allCampaigns,
      campaignIds,
      contrast
    }
  };
}

const INSERT_SQL = `INSERT INTO ad_cards
  (name, layout, media_url, media_kind, ratio_w, ratio_h, media_fit, media_alt, still_url, headline, line,
   button_label, dest_type_id, accent_color, card_bg, text_color, corner, density, is_active, starts_on,
   ends_on, weight, all_campaigns)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
  RETURNING id`;

function insertParams(v) {
  return [v.name, v.layout, v.mediaUrl, v.mediaKind, v.ratioW, v.ratioH, v.mediaFit, v.mediaAlt, v.stillUrl,
    v.headline, v.line, v.buttonLabel, v.destTypeId, v.accentColor, v.cardBg, v.textColor, v.corner, v.density,
    v.isActive, v.startsOn, v.endsOn, v.weight, v.allCampaigns];
}

async function setAssignments(client, adId, v) {
  await client.query('DELETE FROM ad_card_campaigns WHERE ad_card_id = $1', [adId]);
  if (!v.allCampaigns && v.campaignIds.length > 0) {
    await client.query(
      'INSERT INTO ad_card_campaigns (ad_card_id, campaign_id) SELECT $1, UNNEST($2::int[])',
      [adId, v.campaignIds]
    );
  }
}

// ---- list ----
router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const [cards, campaigns, types] = await Promise.all([
    adCards.listAdCards(),
    pool.query('SELECT id, label, is_active FROM promotion_campaigns ORDER BY id DESC'),
    pool.query(
      `SELECT id, name FROM website_types
       WHERE is_active = true AND is_deleted_placeholder = false
       ORDER BY display_order ASC, id ASC`
    )
  ]);
  res.json({
    adCards: cards,
    campaigns: campaigns.rows.map((c) => ({ id: c.id, label: c.label, isActive: c.is_active })),
    types: types.rows.map((t) => ({ id: t.id, name: t.name })),
    defaultButtonLabel: promotions.DEFAULT_BUTTON_LABEL
  });
}));

// ---- preview ----
//
// Builds the config the embed script renders, from the form as it is now
// (saved or not). Nothing is stored. The link on the button is a plain site
// path with no tracking token, so previewing never counts. The media link is
// passed through as text for the admin's own browser to load.
router.post('/preview', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = bodySchema.partial({ name: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
  const data = parsed.data;
  const checked = await validateAd(
    { ...data, name: data.name || 'Preview', layout: data.layout || 'text', headline: data.headline || 'Preview' },
    { requireCampaignsExist: false }
  );
  // The preview still renders when only the media or schedule is incomplete,
  // but not when a rule that changes the look is broken.
  if (!checked.ok) return res.status(422).json({ errors: checked.errors });

  const v = checked.values;
  const theme = data.previewTheme || 'light';
  const destination = await adCards.resolveDestination(v.destTypeId);
  const row = {
    id: 0, headline: v.headline, line: v.line, weight: v.weight, button_label: v.buttonLabel, layout: v.layout,
    accent_color: v.accentColor, card_bg: v.cardBg, text_color: v.textColor, corner: v.corner, density: v.density,
    media_url: v.mediaUrl, media_kind: v.mediaKind, ratio_w: v.ratioW, ratio_h: v.ratioH, media_fit: v.mediaFit,
    media_alt: v.mediaAlt, still_url: v.stillUrl
  };
  const item = adCards.buildItem(row, null, theme, destination);
  delete item.id;
  const config = {
    v: 2,
    name: await promotions.getSiteName(),
    theme,
    btn: v.buttonLabel,
    css: card.buildCardCss(null, theme),
    items: [item]
  };
  res.json({ config, contrast: v.contrast });
}));

// ---- create ----
router.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
  const checked = await validateAd(parsed.data);
  if (!checked.ok) return res.status(422).json({ errors: checked.errors });
  const v = checked.values;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(INSERT_SQL, insertParams(v));
    await setAssignments(client, result.rows[0].id, v);
    await client.query('COMMIT');
    res.status(201).json(await adCards.getAdCardForAdmin(result.rows[0].id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// ---- update ----
router.put('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid ad card id' });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid request body' });
  const checked = await validateAd(parsed.data);
  if (!checked.ok) return res.status(422).json({ errors: checked.errors });
  const v = checked.values;
  const { id } = idParsed.data;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE ad_cards SET
         name=$1, layout=$2, media_url=$3, media_kind=$4, ratio_w=$5, ratio_h=$6, media_fit=$7, media_alt=$8,
         still_url=$9, headline=$10, line=$11, button_label=$12, dest_type_id=$13, accent_color=$14, card_bg=$15,
         text_color=$16, corner=$17, density=$18, is_active=$19, starts_on=$20, ends_on=$21, weight=$22,
         all_campaigns=$23, updated_at=NOW()
       WHERE id=$24 RETURNING id`,
      [...insertParams(v), id]
    );
    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ad card not found' });
    }
    await setAssignments(client, id, v);
    await client.query('COMMIT');
    res.json(await adCards.getAdCardForAdmin(id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// ---- duplicate ----
// Copies everything (media, text, destination, look, schedule, weight and the
// campaign assignments) under a new name, so a variation is quick to design.
// Statistics are not copied.
router.post('/:id/duplicate', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid ad card id' });
  const { id } = idParsed.data;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const copy = await client.query(
      `INSERT INTO ad_cards
         (name, layout, media_url, media_kind, ratio_w, ratio_h, media_fit, media_alt, still_url, headline, line,
          button_label, dest_type_id, accent_color, card_bg, text_color, corner, density, is_active, starts_on,
          ends_on, weight, all_campaigns)
       SELECT LEFT(name, 93) || ' (copy)', layout, media_url, media_kind, ratio_w, ratio_h, media_fit, media_alt,
              still_url, headline, line, button_label, dest_type_id, accent_color, card_bg, text_color, corner,
              density, is_active, starts_on, ends_on, weight, all_campaigns
       FROM ad_cards WHERE id = $1
       RETURNING id`,
      [id]
    );
    if (copy.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Ad card not found' });
    }
    await client.query(
      'INSERT INTO ad_card_campaigns (ad_card_id, campaign_id) SELECT $1, campaign_id FROM ad_card_campaigns WHERE ad_card_id = $2',
      [copy.rows[0].id, id]
    );
    await client.query('COMMIT');
    res.status(201).json(await adCards.getAdCardForAdmin(copy.rows[0].id));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}));

// ---- on / off ----
router.put('/:id/active', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  const bodyParsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!idParsed.success || !bodyParsed.success) return res.status(400).json({ error: 'Invalid request' });
  const result = await getPool().query(
    'UPDATE ad_cards SET is_active = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
    [bodyParsed.data.isActive, idParsed.data.id]
  );
  if (result.rowCount === 0) return res.status(404).json({ error: 'Ad card not found' });
  res.json(await adCards.getAdCardForAdmin(idParsed.data.id));
}));

// ---- delete ----
// Its statistics and campaign assignments go with it (ON DELETE CASCADE). A
// script already cached on another website stops showing it within the cache
// time, and a click on it in the meantime goes to the home page.
router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const idParsed = idParamSchema.safeParse(req.params);
  if (!idParsed.success) return res.status(400).json({ error: 'Invalid ad card id' });
  const result = await getPool().query('DELETE FROM ad_cards WHERE id = $1 RETURNING id', [idParsed.data.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Ad card not found' });
  res.json({ success: true });
}));

module.exports = router;
