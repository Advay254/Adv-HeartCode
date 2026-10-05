'use strict';

const { escapeHtml } = require('./template');
const { DEFAULT_BRAND_HEADLINE, DEFAULT_BRAND_LINE } = require('./promotions');
const { normalizeText } = require('./promoText');
const card = require('./promoCard');

// v1.2.13: server-side rendering for the two promotion variants that cannot
// run JavaScript: the iframe page and the plain HTML snippet. The script
// variant renders in public/embed.js from the same stylesheet (lib/promoCard.js).
//
// v1.2.14: card only. There is one design, with optional appearance settings.
//
// No site name, domain or brand value is written here. Everything comes in
// through the config built by lib/promotions.js (which reads site settings
// and the site stylesheet's own colour properties).

// Fixed iframe heights by density, in pixels. The frame is sized by the
// snippet, so the host page never shifts when the frame loads. They fit the
// stacked layout, which is the tallest one.
const IFRAME_HEIGHTS = { compact: 208, comfortable: 238 };

// Reserved on the script snippet's container so the page does not jump when
// the card is inserted.
const RESERVED_HEIGHT = 130;

function pickItem(items) {
  if (!items || items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * The self-contained page served at /embed/frame/:token. Static HTML and
 * CSS only (the iframe snippet's sandbox has no scripts), with links that
 * open in a new tab. Theme "auto" follows the visitor's device setting with
 * a media query; the colour change on hover and press is the only motion and
 * is switched off for reduced motion.
 */
function renderFramePage(config, item) {
  const css = config.css || '';
  let body = '';
  if (!config.off && item && item.u && /^\/(?!\/)/.test(item.u)) {
    body = card.renderCardHtml(config, item);
  }
  const page = '*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent}'
    + 'body{padding:4px 4px 12px;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}';

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex">'
    + `<title>${escapeHtml(config.name || '')}</title>`
    + `<style>${page}${css}</style></head><body>${body}</body></html>`;
}

/**
 * The copyable snippets for one campaign, built from live settings at the
 * moment of the call. `base` is the public address with no trailing slash.
 * `config` is the campaign's own config (see buildConfig), used for the site
 * name in the fallback link and the plain HTML card.
 *
 * The script snippet is three parts: an empty container that identifies the
 * campaign, the script (one request: the campaign's settings are inside it),
 * and a link for visitors without JavaScript.
 */
function buildSnippets({ base, campaign, config }) {
  const token = campaign.token;
  const app = card.resolveAppearance(campaign);
  const height = IFRAME_HEIGHTS[app.density] || IFRAME_HEIGHTS.comfortable;
  const title = escapeHtml(config.name || '');
  const b = escapeHtml(base);
  const t = escapeHtml(token);

  const scriptUrl = `${base}/embed/${token}.js`;
  const script = `<div id="hc-promo-${t}" style="min-height:${RESERVED_HEIGHT}px"></div>\n`
    + `<script async src="${b}/embed/${t}.js"></script>\n`
    + `<noscript><a href="${b}/go/${t}">${title}</a></noscript>`;

  const iframe = `<iframe src="${b}/embed/frame/${t}" title="${title}" `
    + `loading="lazy" width="100%" height="${height}" scrolling="no" `
    + 'style="border:0;max-width:100%;color-scheme:normal" '
    + 'sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>';

  return {
    script,
    iframe,
    html: buildHtmlCard({ base, campaign, config }),
    iframeHeight: height,
    scriptUrl,
    legacyScriptUrl: `${base}/embed.js`
  };
}

/**
 * Plain HTML, no JavaScript. The same card drawn with inline styles, stacked,
 * pointing at the campaign's /go/:token link. Clicks are counted, impressions
 * are not. Inline styles cannot follow the visitor's device setting or react
 * to hover, so theme "auto" is written as the light look.
 */
function buildHtmlCard({ base, campaign, config }) {
  const app = card.resolveAppearance(campaign);
  const dark = campaign.theme === 'dark';
  const p = card.paletteFor(app, dark);
  const shape = { sharp: [0, 0, 0], soft: [14, 10, 9], round: [24, 999, 999] }[app.corner];
  const size = card.SIZES[app.density];
  const name = normalizeText(config.name || '');
  const headline = normalizeText(campaign.custom_headline || '') || DEFAULT_BRAND_HEADLINE;
  const line = normalizeText(campaign.custom_line || '') || DEFAULT_BRAND_LINE;
  const href = escapeHtml(`${base}/go/${campaign.token}`);
  const label = escapeHtml(campaign.button_label);
  const showHeadline = headline && headline !== name;
  const fontInherit = 'font-family:inherit';

  return `<div style="box-sizing:border-box;max-width:420px;margin:12px 0;overflow:hidden;border:1px solid ${p.border};`
    + `border-radius:${shape[0]}px;background:${p.bg};color:${p.fg};line-height:1.45;${fontInherit}">`
    + `<div style="height:3px;background:linear-gradient(90deg,${app.accent} 0,${app.accent} 62%,${app.second} 62%,${app.second} 100%)"></div>`
    + `<div style="padding:${size.pad}">`
    + `<div style="display:flex;align-items:center;gap:9px;margin:0 0 ${size.gap - 4}px">`
    + `<span style="display:flex;flex:none;align-items:center;justify-content:center;width:${size.tile}px;height:${size.tile}px;`
    + `border-radius:${shape[2]}px;background:${p.btn};color:${p.btnText}">${card.iconSvg(Math.round(size.tile * 0.55))}</span>`
    + `<span style="font-size:${size.name}px;font-weight:600;color:${p.fg}">${escapeHtml(name)}</span></div>`
    + (showHeadline ? `<p style="margin:0;font-size:${size.head}px;font-weight:700;line-height:1.25;color:${p.fg}">${escapeHtml(headline)}</p>` : '')
    + `<p style="margin:4px 0 ${size.gap}px;font-size:${size.line}px;color:${p.muted}">${escapeHtml(line)}</p>`
    + `<a href="${href}" target="_blank" rel="noopener" style="display:block;box-sizing:border-box;min-height:44px;`
    + `padding:12px 22px;border-radius:${shape[1]}px;background:${p.btn};color:${p.btnText};font-size:15px;font-weight:600;`
    + `line-height:1.2;text-align:center;text-decoration:none;${fontInherit}">${label}</a>`
    + '</div></div>';
}

module.exports = { renderFramePage, buildSnippets, pickItem, IFRAME_HEIGHTS, RESERVED_HEIGHT };
