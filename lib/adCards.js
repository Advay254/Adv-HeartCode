'use strict';

const { getPool } = require('../db/init');
const { buildOverrideCss } = require('./promoCard');
const { mayMove } = require('./adMedia');
const { normalizeText } = require('./promoText');

// v1.2.15: data layer for ad cards, the cards designed by hand and shown by
// promotion campaigns.
//
// Media is never uploaded, stored, fetched or measured here. A card only holds
// links to files hosted elsewhere, and only the visitor's browser (or the
// admin preview) loads them. Nothing in this file contains the site name, the
// domain or a brand value: the destination is worked out from the database and
// is always a relative path on this site.

const MAX_AD_ITEMS = 12;
const MAX_POOL = 20;

const TODAY_SQL = "(NOW() AT TIME ZONE 'UTC')::date";

function isoDay(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/** live, scheduled, ended or off, by the UTC date. */
function statusOf(row, todayIso) {
  if (!row.is_active) return 'off';
  const start = isoDay(row.starts_on);
  const end = isoDay(row.ends_on);
  if (start && start > todayIso) return 'scheduled';
  if (end && end < todayIso) return 'ended';
  return 'live';
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Where a card sends visitors, worked out now: the build page of the chosen
 * website type while it is active, otherwise the home page. A relative path
 * built here from the database, never from anything in a request.
 */
async function resolveDestination(destTypeId) {
  if (!destTypeId) return '/';
  const result = await getPool().query(
    'SELECT slug FROM website_types WHERE id = $1 AND is_active = true AND is_deleted_placeholder = false',
    [destTypeId]
  );
  return result.rows[0] ? `/build/${result.rows[0].slug}` : '/';
}

async function getAdCard(id) {
  const result = await getPool().query('SELECT * FROM ad_cards WHERE id = $1', [id]);
  return result.rows[0] || null;
}

/** An ad card's own appearance choices laid over the campaign's. */
function mergeAppearance(campaign, ad) {
  const c = campaign || {};
  return {
    accent_color: ad.accent_color || c.accent_color || null,
    card_bg: ad.card_bg || c.card_bg || null,
    text_color: ad.text_color || c.text_color || null,
    corner: ad.corner || c.corner || null,
    density: ad.density || c.density || null
  };
}

function hasOwnLook(ad) {
  return !!(ad.accent_color || ad.card_bg || ad.text_color || ad.corner || ad.density);
}

/**
 * One ad card as an item for the config (the shape the embed script reads).
 * `link` is the already-built relative path the button points at.
 */
function buildItem(ad, campaign, theme, link, destination) {
  const item = {
    id: ad.id,
    h: normalizeText(ad.headline),
    l: normalizeText(ad.line || ''),
    u: link,
    w: ad.weight,
    b: ad.button_label,
    lay: ad.layout
  };
  if (hasOwnLook(ad)) item.v = buildOverrideCss(mergeAppearance(campaign, ad), theme);
  if (ad.layout !== 'text' && ad.media_url) {
    item.m = {
      u: ad.media_url,
      k: ad.media_kind === 'video' ? 'v' : 'i',
      r: [ad.ratio_w, ad.ratio_h],
      f: ad.media_fit === 'fit' ? 'n' : 'c',
      a: ad.media_alt || '',
      s: ad.still_url || '',
      an: mayMove(ad.media_url, ad.media_kind)
    };
  }
  if (destination) item.dest = destination;
  return item;
}

/**
 * The ad cards a campaign may show right now: switched on, today inside the
 * start and end dates, and assigned to the campaign (or to all campaigns).
 * Small and capped, so the per-campaign script stays small.
 */
async function eligibleItems(campaign, token, theme) {
  if (!campaign || !campaign.id) return [];
  const result = await getPool().query(
    `SELECT a.* FROM ad_cards a
     WHERE a.is_active = true
       AND (a.starts_on IS NULL OR a.starts_on <= ${TODAY_SQL})
       AND (a.ends_on IS NULL OR a.ends_on >= ${TODAY_SQL})
       AND (a.all_campaigns = true
            OR EXISTS (SELECT 1 FROM ad_card_campaigns x WHERE x.ad_card_id = a.id AND x.campaign_id = $1))
     ORDER BY a.weight DESC, a.id ASC
     LIMIT ${MAX_AD_ITEMS}`,
    [campaign.id]
  );
  const { isValidToken } = require('./promotions');
  return result.rows.map((ad) => buildItem(
    ad,
    campaign,
    theme,
    isValidToken(token) ? `/go/${token}/card/${ad.id}` : '/'
  ));
}

// ---- counting ----
//
// Daily aggregates only, one row per ad card per campaign per day (UTC),
// updated in place. The insert reads the campaign by token and the ad card by
// id, so an unknown or deleted one inserts nothing.

async function recordAdImpression(token, adId) {
  if (!Number.isInteger(adId) || adId <= 0) return;
  await getPool().query(
    `INSERT INTO ad_card_stats (ad_card_id, campaign_id, day, impressions)
     SELECT a.id, c.id, ${TODAY_SQL}, 1
     FROM ad_cards a, promotion_campaigns c
     WHERE a.id = $1 AND c.token = $2 AND c.is_active = true
     ON CONFLICT (ad_card_id, campaign_id, day)
     DO UPDATE SET impressions = ad_card_stats.impressions + 1`,
    [adId, token]
  );
}

async function recordAdClick(token, adId) {
  if (!Number.isInteger(adId) || adId <= 0) return;
  await getPool().query(
    `INSERT INTO ad_card_stats (ad_card_id, campaign_id, day, clicks)
     SELECT a.id, c.id, ${TODAY_SQL}, 1
     FROM ad_cards a, promotion_campaigns c
     WHERE a.id = $1 AND c.token = $2
     ON CONFLICT (ad_card_id, campaign_id, day)
     DO UPDATE SET clicks = ad_card_stats.clicks + 1`,
    [adId, token]
  );
}

// ---- admin queries ----

const LIST_SQL = `
  SELECT a.*,
         t.name AS dest_type_name,
         t.is_active AS dest_type_active,
         COALESCE(s.impressions, 0) AS impressions,
         COALESCE(s.clicks, 0) AS clicks,
         COALESCE((SELECT array_agg(x.campaign_id ORDER BY x.campaign_id)
                   FROM ad_card_campaigns x WHERE x.ad_card_id = a.id), '{}') AS campaign_ids
  FROM ad_cards a
  LEFT JOIN website_types t ON t.id = a.dest_type_id
  LEFT JOIN LATERAL (
    SELECT SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks
    FROM ad_card_stats WHERE ad_card_id = a.id
  ) s ON true
`;

function formatAd(row) {
  const impressions = Number(row.impressions) || 0;
  const clicks = Number(row.clicks) || 0;
  return {
    id: row.id,
    name: row.name,
    layout: row.layout,
    mediaUrl: row.media_url || '',
    mediaKind: row.media_kind,
    ratioW: row.ratio_w,
    ratioH: row.ratio_h,
    mediaFit: row.media_fit,
    mediaAlt: row.media_alt || '',
    stillUrl: row.still_url || '',
    headline: row.headline,
    line: row.line || '',
    buttonLabel: row.button_label,
    destTypeId: row.dest_type_id,
    destTypeName: row.dest_type_name || null,
    destProblem: row.dest_type_id && row.dest_type_active === false ? 'inactive' : null,
    accentColor: row.accent_color || '',
    cardBg: row.card_bg || '',
    textColor: row.text_color || '',
    corner: row.corner || '',
    density: row.density || '',
    isActive: row.is_active,
    startsOn: isoDay(row.starts_on) || '',
    endsOn: isoDay(row.ends_on) || '',
    weight: row.weight,
    allCampaigns: row.all_campaigns,
    campaignIds: row.campaign_ids || [],
    status: statusOf(row, todayIso()),
    impressions,
    clicks,
    clickRate: impressions > 0 ? clicks / impressions : null
  };
}

async function listAdCards() {
  const result = await getPool().query(`${LIST_SQL} ORDER BY a.id DESC`);
  return result.rows.map(formatAd);
}

async function getAdCardForAdmin(id) {
  const result = await getPool().query(`${LIST_SQL} WHERE a.id = $1`, [id]);
  return result.rows[0] ? formatAd(result.rows[0]) : null;
}

module.exports = {
  MAX_AD_ITEMS,
  MAX_POOL,
  statusOf,
  resolveDestination,
  getAdCard,
  mergeAppearance,
  buildItem,
  eligibleItems,
  recordAdImpression,
  recordAdClick,
  listAdCards,
  getAdCardForAdmin
};
