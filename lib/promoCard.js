'use strict';

const { getBrandColors, readableOn, contrastRatio, mixHex, rgbTriplet } = require('./brandColors');
const { escapeHtml } = require('./template');
const { normalizeText } = require('./promoText');

// v1.2.14: the one place the promotion card's look is defined.
//
// The card has a single design. A campaign can change a few things about it
// (accent colour, card background, text colour, corner style, density, theme)
// and everything else is fixed. The same CSS text is used by the embed
// script, the preview and the iframe page, so they cannot drift apart: the
// server builds it here and hands it to the script inside the config.
//
// No site name, domain or brand value is written in this file. Brand colours
// come from lib/brandColors.js (the site stylesheet's own properties) and
// neutral stand-ins are used only when one of them could not be read.

const CORNERS = ['sharp', 'soft', 'round'];
const DENSITIES = ['compact', 'comfortable'];
const DEFAULT_CORNER = 'soft';
const DEFAULT_DENSITY = 'comfortable';

// Contrast limits (WCAG ratio). Below WARN the admin is warned. Below BLOCK
// saving is refused because the text would be close to unreadable.
const CONTRAST_WARN = 4.5;
const CONTRAST_BLOCK = 2;

const SHAPES = {
  sharp: { card: 0, btn: 0, tile: 0 },
  soft: { card: 14, btn: 10, tile: 9 },
  round: { card: 24, btn: 999, tile: 999 }
};

const SIZES = {
  compact: { pad: '14px 16px', gap: 10, head: 16, line: 13, tile: 26, name: 12 },
  comfortable: { pad: '20px 22px', gap: 14, head: 18, line: 14, tile: 32, name: 13 }
};

const NEUTRAL = { ink: '#111111', white: '#ffffff', darkText: '#f4f5f8' };

// One heart icon, drawn the same way everywhere it appears.
const ICON_PATH = 'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5';

function iconSvg(size) {
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
    + '<path d="' + ICON_PATH + '"/></svg>';
}

function pickEnum(value, allowed, fallback) {
  return allowed.indexOf(value) !== -1 ? value : fallback;
}

/**
 * Everything the look depends on, with defaults filled in. Accepts a
 * campaign row (snake_case) or a draft with the same names.
 */
function resolveAppearance(campaign) {
  const c = campaign || {};
  const brand = getBrandColors();
  const ink = brand.ink || NEUTRAL.ink;
  const accent = c.accent_color || brand.blue || ink;
  const second = brand.yellow || accent;
  return {
    corner: pickEnum(c.corner, CORNERS, DEFAULT_CORNER),
    density: pickEnum(c.density, DENSITIES, DEFAULT_DENSITY),
    ink,
    accent,
    second,
    customBg: c.card_bg || null,
    customText: c.text_color || null
  };
}

/** The colours used in one theme ('light' or 'dark'). */
function paletteFor(app, dark) {
  const bg = app.customBg || (dark ? mixHex(app.ink, NEUTRAL.white, 0.93) : NEUTRAL.white);
  const fg = app.customText || (dark ? NEUTRAL.darkText : app.ink);
  // Light: blue button turning yellow. Dark: the reverse.
  const btn = dark ? app.second : app.accent;
  const hover = dark ? app.accent : app.second;
  return {
    bg,
    fg,
    muted: mixHex(fg, bg, 0.82),
    placeholder: mixHex(fg, bg, 0.1),
    border: 'rgba(' + rgbTriplet(fg) + ',' + (dark ? '.16' : '.10') + ')',
    shadow: dark
      ? '0 1px 2px rgba(0,0,0,.35),0 10px 28px -10px rgba(0,0,0,.55)'
      : '0 1px 2px rgba(' + rgbTriplet(app.ink) + ',.06),0 10px 28px -12px rgba(' + rgbTriplet(app.ink) + ',.18)',
    btn,
    btnText: readableOn(btn, app.ink),
    hover,
    hoverText: readableOn(hover, app.ink)
  };
}

/**
 * Checks the text and button contrast in every theme the campaign can show.
 * Returns { level: 'ok' | 'warn' | 'block', messages: [...] }.
 */
function checkContrast(campaign) {
  const app = resolveAppearance(campaign);
  const theme = campaign && campaign.theme;
  const themes = theme === 'dark' ? ['dark'] : theme === 'light' ? ['light'] : ['light', 'dark'];
  const messages = [];
  let level = 'ok';

  function note(ratio, text) {
    if (ratio < CONTRAST_BLOCK) {
      level = 'block';
      messages.push(text + ' is too low to read (' + ratio.toFixed(1) + ':1).');
    } else if (ratio < CONTRAST_WARN) {
      if (level !== 'block') level = 'warn';
      messages.push(text + ' is low (' + ratio.toFixed(1) + ':1). Aim for at least ' + CONTRAST_WARN + ':1.');
    }
  }

  themes.forEach((name) => {
    const p = paletteFor(app, name === 'dark');
    const where = themes.length > 1 ? ' in the ' + name + ' theme' : '';
    note(Math.min(contrastRatio(p.fg, p.bg), contrastRatio(p.muted, p.bg)), 'The text against the card background' + where);
    note(Math.min(contrastRatio(p.btnText, p.btn), contrastRatio(p.hoverText, p.hover)), 'The button text against the button' + where);
  });

  // Messages can repeat when both themes share the problem; keep one of each.
  const seen = {};
  return { level, messages: messages.filter((m) => (seen[m] ? false : (seen[m] = true))) };
}

function varsFor(app, p) {
  const shape = SHAPES[app.corner];
  const size = SIZES[app.density];
  return '--hcp-bg:' + p.bg + ';--hcp-fg:' + p.fg + ';--hcp-mu:' + p.muted + ';--hcp-bd:' + p.border
    + ';--hcp-sh:' + p.shadow + ';--hcp-btn:' + p.btn + ';--hcp-bt:' + p.btnText
    + ';--hcp-bh:' + p.hover + ';--hcp-bht:' + p.hoverText + ';--hcp-ph:' + p.placeholder
    + ';--hcp-s1:' + app.accent + ';--hcp-s2:' + app.second
    + ';--hcp-rc:' + shape.card + 'px;--hcp-rb:' + shape.btn + 'px;--hcp-rt:' + shape.tile + 'px'
    + ';--hcp-pad:' + size.pad + ';--hcp-gap:' + size.gap + 'px;--hcp-gap2:' + (size.gap + 10) + 'px;--hcp-gap3:' + (size.gap - 4) + 'px'
    + ';--hcp-hd:' + size.head + 'px;--hcp-ln:' + size.line + 'px;--hcp-nm:' + size.name + 'px;--hcp-tl:' + size.tile + 'px';
}

/**
 * The stylesheet for a card. `theme` is 'light', 'dark' or 'auto' (auto
 * follows the visitor's device setting).
 *
 * Every class starts with hcp-, so the same rules are safe in a page's own
 * DOM when Shadow DOM is not available. The look is driven by custom
 * properties (colours, corners, density), so an ad card that differs from its
 * campaign only needs the small override block from buildOverrideCss. The
 * layout is driven by a container query: stacked when the space is narrow,
 * one row when it is wide.
 */
function buildCardCss(campaign, theme) {
  const app = resolveAppearance(campaign);
  const light = paletteFor(app, false);
  const dark = paletteFor(app, true);
  const base = theme === 'dark' ? dark : light;

  return ''
    + '.hcp-root{' + varsFor(app, base) + ';container-type:inline-size;container-name:hcp;display:block;max-width:760px;'
    + 'margin:0;box-sizing:border-box;font-family:inherit;font-size:var(--hcp-ln);line-height:1.45;text-align:left}'
    + (theme === 'auto' ? '@media (prefers-color-scheme:dark){.hcp-root{' + varsFor(app, dark) + '}}' : '')
    + '.hcp-root *,.hcp-root *::before,.hcp-root *::after{box-sizing:border-box}'
    + '.hcp-root .hcp-card{position:relative;display:flex;flex-direction:column;gap:var(--hcp-gap);overflow:hidden;'
    + 'padding:var(--hcp-pad);border:1px solid var(--hcp-bd);border-radius:var(--hcp-rc);'
    + 'background:var(--hcp-bg);color:var(--hcp-fg);box-shadow:var(--hcp-sh)}'
    + '.hcp-root .hcp-card::before{content:"";position:absolute;z-index:2;left:0;right:0;top:0;height:3px;'
    + 'background:linear-gradient(90deg,var(--hcp-s1) 0,var(--hcp-s1) 62%,var(--hcp-s2) 62%,var(--hcp-s2) 100%)}'
    + '.hcp-root .hcp-main{min-width:0;flex:1}'
    + '.hcp-root .hcp-brand{display:flex;align-items:center;gap:9px;margin:0 0 var(--hcp-gap3)}'
    + '.hcp-root .hcp-tile{display:flex;flex:none;align-items:center;justify-content:center;width:var(--hcp-tl);height:var(--hcp-tl);'
    + 'border-radius:var(--hcp-rt);background:var(--hcp-btn);color:var(--hcp-bt)}'
    + '.hcp-root .hcp-tile svg{display:block;width:55%;height:55%}'
    + '.hcp-root .hcp-name{min-width:0;margin:0;font-size:var(--hcp-nm);font-weight:600;letter-spacing:.01em;color:var(--hcp-fg);'
    + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.hcp-root .hcp-head{margin:0;font-size:var(--hcp-hd);font-weight:700;line-height:1.25;color:var(--hcp-fg)}'
    + '.hcp-root .hcp-line{margin:4px 0 0;font-size:var(--hcp-ln);color:var(--hcp-mu)}'
    + '.hcp-root a.hcp-btn{display:inline-flex;align-items:center;justify-content:center;align-self:stretch;min-height:44px;'
    + 'padding:0 22px;border-radius:var(--hcp-rb);background:var(--hcp-btn);color:var(--hcp-bt);font-family:inherit;'
    + 'font-size:15px;font-weight:600;line-height:1.2;text-align:center;text-decoration:none;cursor:pointer;'
    + 'transition:background-color .3s ease-out,color .3s ease-out}'
    + '.hcp-root a.hcp-btn:hover,.hcp-root a.hcp-btn:active,.hcp-root a.hcp-btn:focus-visible{background:var(--hcp-bh);color:var(--hcp-bht)}'
    + '.hcp-root a.hcp-btn:focus-visible{outline:2px solid var(--hcp-fg);outline-offset:2px}'
    // ---- media (card with media, and the media only banner) ----
    + '.hcp-root .hcp-card.hcp-hasm{padding:0;gap:0}'
    + '.hcp-root .hcp-body{display:flex;flex-direction:column;gap:var(--hcp-gap);min-width:0;flex:1;padding:var(--hcp-pad)}'
    + '.hcp-root .hcp-mbox{position:relative;display:block;flex:none;width:100%;overflow:hidden;background:var(--hcp-ph);'
    + 'aspect-ratio:var(--hcp-ar)}'
    + '@supports not (aspect-ratio:1/1){.hcp-root .hcp-mbox::before{content:"";display:block;padding-top:calc(100% / var(--hcp-arn))}}'
    + '.hcp-root .hcp-mbox img,.hcp-root .hcp-mbox video{position:absolute;left:0;top:0;display:block;width:100%;height:100%;'
    + 'max-width:none;margin:0;padding:0;border:0;border-radius:0;object-fit:cover;background:transparent}'
    + '.hcp-root .hcp-mbox.hcp-fit img,.hcp-root .hcp-mbox.hcp-fit video{object-fit:contain}'
    + '.hcp-root a.hcp-banner{position:relative;display:block;overflow:hidden;border:1px solid var(--hcp-bd);border-radius:var(--hcp-rc);'
    + 'box-shadow:var(--hcp-sh);text-decoration:none;color:#fff}'
    + '.hcp-root a.hcp-banner:focus-visible{outline:2px solid var(--hcp-fg);outline-offset:2px}'
    + '.hcp-root .hcp-chip{position:absolute;z-index:2;left:10px;bottom:10px;display:flex;align-items:center;gap:7px;max-width:calc(100% - 20px);'
    + 'padding:4px 10px 4px 4px;border-radius:999px;background:rgba(0,0,0,.62);color:#fff;font-size:12px;font-weight:600}'
    + '.hcp-root .hcp-chip .hcp-tile{width:22px;height:22px;border-radius:999px}'
    + '.hcp-root .hcp-chip .hcp-name{color:#fff;font-size:12px}'
    + '.hcp-root [hidden]{display:none !important}'
    + '@container hcp (min-width:460px){'
    + '.hcp-root .hcp-card{flex-direction:row;align-items:center;gap:var(--hcp-gap2)}'
    + '.hcp-root a.hcp-btn{align-self:center;flex:none}'
    + '.hcp-root .hcp-card.hcp-hasm:not(.hcp-top){align-items:stretch;gap:0}'
    + '.hcp-root .hcp-card.hcp-hasm:not(.hcp-top) .hcp-mbox{width:44%;align-self:stretch}'
    + '.hcp-root .hcp-card.hcp-hasm:not(.hcp-top) .hcp-body{justify-content:center}'
    + '.hcp-root .hcp-card.hcp-hasm:not(.hcp-top) a.hcp-btn{align-self:flex-start}'
    + '.hcp-root .hcp-card.hcp-hasm.hcp-top{flex-direction:column;align-items:stretch}'
    + '.hcp-root .hcp-card.hcp-hasm.hcp-top .hcp-body{flex-direction:row;align-items:center;gap:var(--hcp-gap2)}}'
    + '@media (prefers-reduced-motion:reduce){.hcp-root a.hcp-btn{transition:none}}';
}

/**
 * The small block that makes one ad card look different from its campaign:
 * the same custom properties, applied to a root that also has the hcp-v class.
 * `merged` is the ad card's own choices over the campaign's.
 */
function buildOverrideCss(merged, theme) {
  const app = resolveAppearance(merged);
  const base = paletteFor(app, theme === 'dark');
  return '.hcp-root.hcp-v{' + varsFor(app, base) + '}'
    + (theme === 'auto' ? '@media (prefers-color-scheme:dark){.hcp-root.hcp-v{' + varsFor(app, paletteFor(app, true)) + '}}' : '');
}

/** The text pieces of a card. The site name is always shown. */
function cardText(config, item) {
  const name = normalizeText(config.name || '');
  const headline = normalizeText(item.h || '');
  const line = normalizeText(item.l || '');
  return { name, headline, line, showHeadline: !!headline && headline !== name };
}

/**
 * The card's markup as a string, for the iframe page. The embed script builds
 * the same structure with DOM calls (public/embed.js). `href` is a relative
 * path that has already been checked. The iframe page runs no script and
 * loads no media, so every ad card appears there as a text card.
 */
function renderCardHtml(config, item, size) {
  const t = cardText(config, item);
  const btn = item.b || config.btn || '';
  const label = escapeHtml(btn);
  const aria = escapeHtml(btn + (t.headline ? ': ' + t.headline : ''));
  return '<div class="hcp-root' + (item.v ? ' hcp-v' : '') + '"><div class="hcp-card"><div class="hcp-main">'
    + '<div class="hcp-brand"><span class="hcp-tile">' + iconSvg(size || 16) + '</span>'
    + '<p class="hcp-name">' + escapeHtml(t.name) + '</p></div>'
    + (t.showHeadline ? '<p class="hcp-head">' + escapeHtml(t.headline) + '</p>' : '')
    + (t.line ? '<p class="hcp-line">' + escapeHtml(t.line) + '</p>' : '')
    + '</div><a class="hcp-btn" href="' + escapeHtml(item.u) + '" target="_blank" rel="noopener" aria-label="' + aria + '">'
    + label + '</a></div></div>';
}

module.exports = {
  CORNERS,
  DENSITIES,
  DEFAULT_CORNER,
  DEFAULT_DENSITY,
  CONTRAST_WARN,
  CONTRAST_BLOCK,
  SIZES,
  resolveAppearance,
  paletteFor,
  checkContrast,
  buildCardCss,
  buildOverrideCss,
  cardText,
  renderCardHtml,
  iconSvg
};
