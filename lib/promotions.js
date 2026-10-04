'use strict';

const crypto = require('crypto');
const { getPool } = require('../db/init');
const { getSiteSettings } = require('./siteSettings');
const { getBrandColors, readableOn } = require('./brandColors');
const { trimAtWord, normalizeText } = require('./promoText');

// v1.2.13: data layer for promotion campaigns.
//
// Nothing in this file contains the site name, the domain or a brand colour.
// The name comes from site_settings (site_title), colours from
// lib/brandColors.js, and addresses are relative paths that the caller
// (embed script, frame page or snippet builder) joins to its own origin.

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DEFAULT_BUTTON_LABEL = 'Build yours';
// Used for the general brand message. The site has no tagline setting, so
// this short neutral line is the default. A campaign can override it.
const DEFAULT_BRAND_LINE = 'Build a personal website for someone special.';

const HEADLINE_MAX = 60;
const LINE_MAX = 120;
const PROMO_LINE_MAX = 100;
const DESCRIPTION_TRIM_TO = 100;
const BUTTON_MAX = 24;

function createToken() {
  // 16 random bytes as base64url is always exactly 22 characters.
  return crypto.randomBytes(16).toString('base64url');
}

function isValidToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/**
 * The relative path a promo link points at. A valid token routes through
 * /go/:token (which counts the click and redirects). An unknown or malformed
 * token never appears in a path: those links go straight to the site page.
 */
function linkPath(token, slug) {
  const safeSlug = typeof slug === 'string' && SLUG_RE.test(slug) ? slug : null;
  if (isValidToken(token)) {
    return safeSlug ? `/go/${token}/${safeSlug}` : `/go/${token}`;
  }
  return safeSlug ? `/build/${safeSlug}` : '/';
}

async function getSiteName() {
  const settings = await getSiteSettings();
  return normalizeText(settings.site_title || '');
}

async function getCampaignByToken(token) {
  if (!isValidToken(token)) return null;
  const result = await getPool().query('SELECT * FROM promotion_campaigns WHERE token = $1', [token]);
  return result.rows[0] || null;
}

async function loadActiveTypes() {
  const result = await getPool().query(
    `SELECT id, slug, name, description, promo_line, category_id
     FROM website_types
     WHERE is_active = true AND is_deleted_placeholder = false
     ORDER BY display_order ASC, id ASC`
  );
  return result.rows;
}

/** One website type as a promo item. Built from its existing fields. */
function typeItem(type, token) {
  const promoLine = normalizeText(type.promo_line || '');
  return {
    h: trimAtWord(type.name, HEADLINE_MAX),
    l: promoLine || trimAtWord(type.description || '', DESCRIPTION_TRIM_TO),
    u: linkPath(token, type.slug)
  };
}

/** The general brand message, with per-campaign custom text when set. */
function brandItem(campaign, siteName, token) {
  const customHeadline = campaign && campaign.custom_headline ? normalizeText(campaign.custom_headline) : '';
  const customLine = campaign && campaign.custom_line ? normalizeText(campaign.custom_line) : '';
  return {
    h: customHeadline || siteName,
    l: customLine || DEFAULT_BRAND_LINE,
    u: linkPath(token, null)
  };
}

/**
 * Works out which items a campaign can promote right now, live, on every
 * call. Only active website types are ever included.
 *
 * Returns { items, effectiveMode, categoryUnavailable }.
 *   - category campaign: only the active types in its category, provided the
 *     category still exists, is active, and has at least one active type.
 *   - otherwise (general campaign, deleted campaign, or a category that has
 *     gone away or run dry): the brand message plus every active type, which
 *     is just the brand message when no type is active.
 * Nothing here ever throws because of a category problem.
 */
async function resolvePool(campaign, token, siteName) {
  const types = await loadActiveTypes();
  let categoryUnavailable = false;

  if (campaign && campaign.mode === 'category') {
    let category = null;
    if (campaign.category_id) {
      const result = await getPool().query(
        'SELECT id, is_active FROM website_categories WHERE id = $1',
        [campaign.category_id]
      );
      category = result.rows[0] || null;
    }
    if (category && category.is_active) {
      const inCategory = types.filter((t) => t.category_id === category.id);
      if (inCategory.length > 0) {
        return {
          items: inCategory.map((t) => typeItem(t, token)),
          effectiveMode: 'category',
          categoryUnavailable: false
        };
      }
    }
    categoryUnavailable = true;
  }

  return {
    items: [brandItem(campaign, siteName, token), ...types.map((t) => typeItem(t, token))],
    effectiveMode: 'general',
    categoryUnavailable
  };
}

/**
 * The config the embed script, the frame page and the preview all render
 * from. `campaign` is null for an unknown or deleted campaign, which gets the
 * general promotion with default presentation. A campaign that is switched
 * off returns { v: 1, off: true } and nothing else.
 */
async function buildConfig(campaign, token) {
  if (campaign && !campaign.is_active) {
    return { config: { v: 1, off: true }, effectiveMode: null, categoryUnavailable: false };
  }

  const siteName = await getSiteName();
  const pool = await resolvePool(campaign, token, siteName);
  const brand = getBrandColors();
  const accent = (campaign && campaign.accent_color) || brand.blue || null;

  return {
    config: {
      v: 1,
      name: siteName,
      style: campaign ? campaign.style : 'card',
      theme: campaign ? campaign.theme : 'auto',
      btn: campaign ? campaign.button_label : DEFAULT_BUTTON_LABEL,
      c: {
        a: accent,
        h: brand.yellow,
        i: brand.ink,
        t: readableOn(accent, brand.ink),
        ht: readableOn(brand.yellow, brand.ink)
      },
      items: pool.items
    },
    effectiveMode: pool.effectiveMode,
    categoryUnavailable: pool.categoryUnavailable
  };
}

// ---- counting ----
//
// Counts only. One row per campaign per day (UTC), updated in place. The
// insert reads the campaign row by token, so an unknown or deleted token
// inserts nothing and needs no separate lookup (and so is never counted).

async function recordImpression(token) {
  if (!isValidToken(token)) return;
  await getPool().query(
    `INSERT INTO promotion_stats (campaign_id, day, impressions)
     SELECT id, (NOW() AT TIME ZONE 'UTC')::date, 1
     FROM promotion_campaigns WHERE token = $1 AND is_active = true
     ON CONFLICT (campaign_id, day)
     DO UPDATE SET impressions = promotion_stats.impressions + 1`,
    [token]
  );
}

async function recordClick(token) {
  if (!isValidToken(token)) return;
  await getPool().query(
    `INSERT INTO promotion_stats (campaign_id, day, clicks)
     SELECT id, (NOW() AT TIME ZONE 'UTC')::date, 1
     FROM promotion_campaigns WHERE token = $1
     ON CONFLICT (campaign_id, day)
     DO UPDATE SET clicks = promotion_stats.clicks + 1`,
    [token]
  );
}

/** True only for an active, non-placeholder website type with this slug. */
async function isActiveTypeSlug(slug) {
  if (typeof slug !== 'string' || slug.length > 100 || !SLUG_RE.test(slug)) return false;
  const result = await getPool().query(
    'SELECT 1 FROM website_types WHERE slug = $1 AND is_active = true AND is_deleted_placeholder = false',
    [slug]
  );
  return result.rowCount > 0;
}

// ---- admin queries ----

const CAMPAIGN_LIST_SQL = `
  SELECT c.*,
         cat.name AS category_name,
         cat.is_active AS category_is_active,
         (SELECT COUNT(*) FROM website_types t
            WHERE t.category_id = c.category_id AND t.is_active = true AND t.is_deleted_placeholder = false
         )::int AS category_active_types,
         COALESCE(s.impressions, 0) AS impressions,
         COALESCE(s.clicks, 0) AS clicks,
         COALESCE(s.impressions_7d, 0) AS impressions_7d,
         COALESCE(s.clicks_7d, 0) AS clicks_7d
  FROM promotion_campaigns c
  LEFT JOIN website_categories cat ON cat.id = c.category_id
  LEFT JOIN LATERAL (
    SELECT SUM(impressions)::int AS impressions,
           SUM(clicks)::int AS clicks,
           (SUM(impressions) FILTER (WHERE day >= (NOW() AT TIME ZONE 'UTC')::date - 6))::int AS impressions_7d,
           (SUM(clicks) FILTER (WHERE day >= (NOW() AT TIME ZONE 'UTC')::date - 6))::int AS clicks_7d
    FROM promotion_stats WHERE campaign_id = c.id
  ) s ON true
`;

/**
 * Why a category campaign is currently serving the general promotion, or null
 * when it is not. Used for the admin notice only.
 */
function categoryProblem(row) {
  if (row.mode !== 'category') return null;
  if (!row.category_id) return 'deleted';
  if (!row.category_is_active) return 'inactive';
  if (!row.category_active_types) return 'empty';
  return null;
}

function formatCampaign(row) {
  const impressions = Number(row.impressions) || 0;
  const clicks = Number(row.clicks) || 0;
  return {
    id: row.id,
    label: row.label,
    token: row.token,
    mode: row.mode,
    categoryId: row.category_id,
    categoryName: row.category_name || null,
    categoryProblem: categoryProblem(row),
    style: row.style,
    theme: row.theme,
    accentColor: row.accent_color,
    customHeadline: row.custom_headline || '',
    customLine: row.custom_line || '',
    buttonLabel: row.button_label,
    isActive: row.is_active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    impressions,
    clicks,
    clickRate: impressions > 0 ? clicks / impressions : null,
    impressions7d: Number(row.impressions_7d) || 0,
    clicks7d: Number(row.clicks_7d) || 0
  };
}

async function listCampaigns() {
  const result = await getPool().query(`${CAMPAIGN_LIST_SQL} ORDER BY c.id DESC`);
  return result.rows.map(formatCampaign);
}

async function getCampaignForAdmin(id) {
  const result = await getPool().query(`${CAMPAIGN_LIST_SQL} WHERE c.id = $1`, [id]);
  return result.rows[0] ? formatCampaign(result.rows[0]) : null;
}

module.exports = {
  TOKEN_RE,
  SLUG_RE,
  DEFAULT_BUTTON_LABEL,
  DEFAULT_BRAND_LINE,
  HEADLINE_MAX,
  LINE_MAX,
  PROMO_LINE_MAX,
  BUTTON_MAX,
  createToken,
  isValidToken,
  linkPath,
  getSiteName,
  getCampaignByToken,
  buildConfig,
  recordImpression,
  recordClick,
  isActiveTypeSlug,
  listCampaigns,
  getCampaignForAdmin
};
