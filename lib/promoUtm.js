'use strict';

const promotions = require('./promotions');
const { slugify } = require('./slugify');

// v1.2.16: campaign tags on the /go/ redirects, so Umami can tell which
// campaign (and which ad card) sent a visitor.
//
//   utm_source   the campaign name, made URL safe (campaign-<id> if the name
//                has nothing usable, "general" if the token matches no campaign)
//   utm_medium   promo
//   utm_campaign the campaign's own identifier
//   utm_content  the ad card's id, only when an ad card caused the click
//
// The destination is still built by the server from the database. This only
// adds query parameters to that already built, same-site relative path, using
// URL and URLSearchParams so every value is escaped and any parameter the
// destination already has is kept. Tags are added whether or not analytics is
// switched on, because they are harmless and only Umami reads them.

const BASE = 'https://placeholder.invalid';

async function withCampaignTags(target, token, adId) {
  try {
    let campaign = null;
    try {
      campaign = await promotions.getCampaignByToken(token);
    } catch (err) { /* treated as no campaign */ }

    const tags = {};
    if (campaign && campaign.id) {
      tags.utm_source = slugify(campaign.label || '').slice(0, 40).replace(/-+$/, '') || `campaign-${campaign.id}`;
      tags.utm_medium = 'promo';
      tags.utm_campaign = String(campaign.id);
      if (adId) tags.utm_content = String(adId);
    } else {
      tags.utm_source = 'general';
      tags.utm_medium = 'promo';
      if (adId) tags.utm_content = String(adId);
    }

    const u = new URL(target, BASE);
    for (const [k, v] of Object.entries(tags)) u.searchParams.set(k, v);
    return u.pathname + u.search + u.hash;
  } catch (err) {
    return target;
  }
}

module.exports = { withCampaignTags };
