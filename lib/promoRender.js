'use strict';

const { escapeHtml } = require('./template');
const { readableOn } = require('./brandColors');
const { DEFAULT_BRAND_LINE } = require('./promotions');
const { normalizeText } = require('./promoText');

// v1.2.13: server-side rendering for the two promotion variants that cannot
// run JavaScript: the iframe page and the plain HTML snippet. The script
// variant renders in public/embed.js. The frame styles below mirror the
// rules in public/embed.js: if one changes, change the other.
//
// No site name, domain or brand value is written here. Everything comes in
// through the config built by lib/promotions.js (which reads site settings
// and the site stylesheet's own colour properties).

// Fixed iframe heights per style, in pixels. The frame is sized by the
// snippet, so the host page never shifts when the frame loads.
const IFRAME_HEIGHTS = { card: 210, slim: 64, text: 84 };

// Neutral stand-ins used only when a brand colour could not be read.
const NEUTRAL = { fg: '#111111', bg: '#ffffff', onDark: '#ffffff' };

function pickItem(items) {
  if (!items || items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function resolveDark(theme) {
  return theme === 'dark';
}

function palette(config, dark) {
  const c = config.c || {};
  const ink = c.i || NEUTRAL.fg;
  const accent = c.a || ink;
  return {
    accent,
    onAccent: c.t || readableOn(accent, c.i),
    hover: c.h || accent,
    onHover: c.ht || ink,
    ink,
    bg: dark ? ink : NEUTRAL.bg,
    fg: dark ? NEUTRAL.onDark : ink,
    border: dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)',
    mark: dark ? (c.h || NEUTRAL.onDark) : accent,
    link: dark ? (c.h || NEUTRAL.onDark) : accent
  };
}

const HEART_PATH = 'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5';

function heartSvg() {
  return '<svg class="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + `<path d="${HEART_PATH}"/></svg>`;
}

function textParts(config, item) {
  const name = normalizeText(config.name || '');
  const headline = normalizeText(item.h || '');
  const line = normalizeText(item.l || '');
  return { name, headline, line, showHeadline: headline && headline !== name };
}

/**
 * The self-contained page served at /embed/frame/:token. Static HTML and
 * CSS only (the iframe snippet's sandbox has no scripts), with links that
 * open in a new tab. Theme "auto" follows the visitor's device setting with
 * a media query; the colour change on hover and press is the only motion and
 * is switched off for reduced motion.
 */
function renderFramePage(config, item) {
  const dark = resolveDark(config.theme);
  const light = palette(config, false);
  const night = palette(config, true);
  const autoTheme = config.theme === 'auto';
  const initial = dark ? night : light;

  const rules = (p) => `
    :root{--bg:${p.bg};--fg:${p.fg};--bd:${p.border};--ac:${p.accent};--on:${p.onAccent};--hv:${p.hover};--oh:${p.onHover};--mk:${p.mark};--lk:${p.link}}`;

  const css = `
    *{box-sizing:border-box}
    ${rules(initial)}
    ${autoTheme ? `@media (prefers-color-scheme:dark){${rules(night)}}` : ''}
    html,body{margin:0;padding:0;background:transparent}
    body{font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg)}
    .c{padding:16px 18px;border:1px solid var(--bd);border-radius:14px;background:var(--bg);color:var(--fg)}
    .nm{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--mk)}
    .hd{margin:6px 0 2px;font-size:17px;font-weight:700;line-height:1.25}
    .ln{margin:6px 0 0;opacity:.78}
    .s{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--bd);border-radius:10px;background:var(--bg);color:var(--fg);white-space:nowrap}
    .s .tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
    .s .mk{color:var(--mk);flex:none;display:flex}
    .t{margin:8px 0;line-height:1.5}
    .b{display:inline-block;margin-top:12px;padding:8px 16px;border-radius:999px;background:var(--ac);color:var(--on);font-weight:600;font-size:14px;line-height:1.2;text-decoration:none;transition:background-color .3s ease-out,color .3s ease-out}
    .s .b{margin:0;padding:6px 14px;flex:none}
    .b:hover,.b:active,.b:focus-visible{background:var(--hv);color:var(--oh)}
    .k{color:var(--lk);font-weight:600;text-decoration:underline;border-radius:3px;transition:background-color .3s ease-out,color .3s ease-out}
    .k:hover,.k:active,.k:focus-visible{background:var(--hv);color:var(--oh)}
    a:focus-visible{outline:2px solid var(--ac);outline-offset:2px}
    @media (prefers-reduced-motion:reduce){.b,.k{transition:none}}
    .ic{display:block}`;

  let body = '';
  if (!config.off && item && item.u && /^\/(?!\/)/.test(item.u)) {
    const href = escapeHtml(item.u);
    const { name, headline, line, showHeadline } = textParts(config, item);
    const label = escapeHtml(config.btn || '');
    const aria = escapeHtml(`${config.btn || ''}: ${headline}`);
    const link = (cls) => `<a class="${cls}" href="${href}" target="_blank" rel="noopener" aria-label="${aria}">${label}</a>`;

    if (config.style === 'slim') {
      const lead = [name ? `<strong>${escapeHtml(name)}</strong>` : '']
        .concat(showHeadline ? [escapeHtml(headline)] : [])
        .concat(line ? [escapeHtml(line)] : []);
      const text = lead.filter(Boolean).join(': ');
      body = `<div class="s"><span class="mk">${heartSvg()}</span><span class="tx">${text}</span>${link('b')}</div>`;
    } else if (config.style === 'text') {
      const lead = showHeadline ? `${escapeHtml(headline)}${name ? ` on ${escapeHtml(name)}` : ''}` : escapeHtml(name || headline);
      body = `<p class="t">${lead}${line ? `: ${escapeHtml(line)}` : ''} ${link('k')}</p>`;
    } else {
      body = '<div class="c">'
        + (name ? `<div class="nm">${heartSvg()}<span>${escapeHtml(name)}</span></div>` : '')
        + (showHeadline ? `<p class="hd">${escapeHtml(headline)}</p>` : '')
        + (line ? `<p class="ln">${escapeHtml(line)}</p>` : '')
        + link('b')
        + '</div>';
    }
  }

  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex">'
    + `<title>${escapeHtml(config.name || '')}</title>`
    + `<style>${css}</style></head><body>${body}</body></html>`;
}

/**
 * The three copyable snippets for one campaign, built from live settings at
 * the moment of the call. `base` is the public address with no trailing
 * slash. `config` is the campaign's own config (see buildConfig), used to
 * write the plain HTML card from the same live site name and colours.
 */
function buildSnippets({ base, campaign, config }) {
  const token = campaign.token;
  const style = campaign.style;
  const height = IFRAME_HEIGHTS[style] || IFRAME_HEIGHTS.card;
  const title = escapeHtml(config.name || '');

  const script = `<script async src="${escapeHtml(base)}/embed.js" data-token="${escapeHtml(token)}"></script>`;

  const iframe = `<iframe src="${escapeHtml(base)}/embed/frame/${escapeHtml(token)}" title="${title}" `
    + `loading="lazy" width="100%" height="${height}" scrolling="no" `
    + 'style="border:0;max-width:100%;color-scheme:normal" '
    + 'sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>';

  return { script, iframe, html: buildHtmlCard({ base, campaign, config }), iframeHeight: height };
}

/**
 * Plain HTML, no JavaScript. A styled link block pointing at the campaign's
 * /go/:token link. Clicks are counted, impressions are not. Inline styles
 * cannot follow the visitor's device setting, so theme "auto" is written as
 * the light look.
 */
function buildHtmlCard({ base, campaign, config }) {
  const dark = campaign.theme === 'dark';
  const p = palette(config, dark);
  const name = normalizeText(config.name || '');
  const headline = normalizeText(campaign.custom_headline || '') || name;
  const line = normalizeText(campaign.custom_line || '') || DEFAULT_BRAND_LINE;
  const href = escapeHtml(`${base}/go/${campaign.token}`);
  const label = escapeHtml(campaign.button_label);
  const showHeadline = headline && headline !== name;
  const fontInherit = 'font-family:inherit';

  const button = (extra) => `<a href="${href}" target="_blank" rel="noopener" `
    + `style="display:inline-block;${extra}padding:8px 16px;border-radius:999px;background:${p.accent};`
    + `color:${p.onAccent};font-size:14px;font-weight:600;line-height:1.2;text-decoration:none;${fontInherit}">${label}</a>`;

  if (campaign.style === 'slim') {
    const lead = [name ? `<strong>${escapeHtml(name)}</strong>` : '']
      .concat(showHeadline ? [escapeHtml(headline)] : [])
      .concat([escapeHtml(line)])
      .filter(Boolean)
      .join(': ');
    return `<div style="display:flex;align-items:center;gap:10px;max-width:100%;margin:12px 0;padding:8px 12px;`
      + `border:1px solid ${p.border};border-radius:10px;background:${p.bg};color:${p.fg};font-size:14px;${fontInherit}">`
      + `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${lead}</span>`
      + `${button('flex:none;')}</div>`;
  }

  if (campaign.style === 'text') {
    const lead = showHeadline ? `${escapeHtml(headline)}${name ? ` on ${escapeHtml(name)}` : ''}` : escapeHtml(name || headline);
    return `<p style="margin:12px 0;color:${p.fg};font-size:14px;line-height:1.5;${fontInherit}">${lead}: ${escapeHtml(line)} `
      + `<a href="${href}" target="_blank" rel="noopener" style="color:${p.link};font-weight:600;text-decoration:underline">${label}</a></p>`;
  }

  return `<div style="box-sizing:border-box;max-width:420px;margin:12px 0;padding:16px 18px;border:1px solid ${p.border};`
    + `border-radius:14px;background:${p.bg};color:${p.fg};line-height:1.45;${fontInherit}">`
    + (name ? `<p style="margin:0 0 4px;font-size:12px;font-weight:600;color:${p.mark}">${escapeHtml(name)}</p>` : '')
    + (showHeadline ? `<p style="margin:0 0 2px;font-size:17px;font-weight:700;line-height:1.25">${escapeHtml(headline)}</p>` : '')
    + `<p style="margin:0 0 12px;font-size:14px;opacity:.78">${escapeHtml(line)}</p>`
    + `${button('')}</div>`;
}

module.exports = { renderFramePage, buildSnippets, pickItem, IFRAME_HEIGHTS };
