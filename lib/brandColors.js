'use strict';

const fs = require('fs');
const path = require('path');

// v1.2.13: the brand colours promotions use.
//
// The site defines its blue, yellow and ink once, as custom properties on
// :root in src/styles/main.css (--hc-blue, --hc-yellow, --hc-ink). Promotions
// read the very same declarations, so changing them there changes every
// promotion with no second place to edit and no colour value repeated in code.
// The result is cached for a few minutes and re-read after that, so an edit
// to the stylesheet shows up without a restart.
//
// If the file cannot be read or a property is missing, that colour is null
// and the embed script falls back to neutral, non-brand colours. Nothing is
// ever invented here.

const CSS_PATH = path.join(__dirname, '..', 'src', 'styles', 'main.css');
const CACHE_TTL_MS = 5 * 60 * 1000;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

let cached = null;
let cachedAt = 0;

function expandHex(hex) {
  if (hex.length === 4) {
    return '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3];
  }
  return hex;
}

function readProperty(rootBlock, name) {
  const match = rootBlock.match(new RegExp('--' + name + '\\s*:\\s*(#[0-9a-fA-F]{3,6})\\s*;'));
  if (!match || !HEX_RE.test(match[1])) return null;
  return expandHex(match[1]).toLowerCase();
}

function load() {
  const result = { blue: null, yellow: null, ink: null };
  try {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
    if (root) {
      result.blue = readProperty(root[1], 'hc-blue');
      result.yellow = readProperty(root[1], 'hc-yellow');
      result.ink = readProperty(root[1], 'hc-ink');
    }
  } catch (err) {
    console.error('[PROMOTIONS] Could not read the brand colours from the stylesheet:', err.message);
  }
  return result;
}

function getBrandColors() {
  const now = Date.now();
  if (!cached || now - cachedAt > CACHE_TTL_MS) {
    cached = load();
    cachedAt = now;
  }
  return cached;
}

/** Relative luminance of a #rrggbb colour, 0 (black) to 1 (white). */
function luminance(hex) {
  const n = parseInt(expandHex(hex).slice(1), 16);
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/**
 * Picks readable text for a filled background: white on dark fills, the
 * given dark colour on light fills. `dark` may be null, in which case black.
 */
function readableOn(background, dark) {
  if (!background) return '#ffffff';
  return luminance(background) > 0.45 ? (dark || '#000000') : '#ffffff';
}

module.exports = { getBrandColors, readableOn };
