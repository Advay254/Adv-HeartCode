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

/** WCAG contrast ratio between two #rrggbb colours, 1 to 21. */
function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Mixes two #rrggbb colours. weight is the share of `a`, 0 to 1. */
function mixHex(a, b, weight) {
  const pa = parseInt(expandHex(a).slice(1), 16);
  const pb = parseInt(expandHex(b).slice(1), 16);
  const ch = (shift) => {
    const va = (pa >> shift) & 255;
    const vb = (pb >> shift) & 255;
    return Math.round(va * weight + vb * (1 - weight));
  };
  const out = (ch(16) << 16) | (ch(8) << 8) | ch(0);
  return '#' + out.toString(16).padStart(6, '0');
}

/** "r,g,b" for use inside rgba(). */
function rgbTriplet(hex) {
  const n = parseInt(expandHex(hex).slice(1), 16);
  return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
}

/**
 * Picks readable text for a filled background: whichever of white or the
 * given dark colour has the higher contrast against it. `dark` may be null,
 * in which case black is the dark candidate.
 */
function readableOn(background, dark) {
  if (!background) return '#ffffff';
  const darkText = dark || '#000000';
  return contrastRatio(background, darkText) >= contrastRatio(background, '#ffffff') ? darkText : '#ffffff';
}

module.exports = { getBrandColors, readableOn, contrastRatio, mixHex, rgbTriplet };
