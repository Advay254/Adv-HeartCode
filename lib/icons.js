const fs = require('fs');
const path = require('path');

const ICONS_DIR = path.join(__dirname, '..', 'public', 'icons');

// v1.0.7: the full curated set (~40 Lucide icons, bundled as static SVG
// files in public/icons/ -- real Lucide source, not hand-approximated, not
// the full icon library, not an icon font). Split into two groups:
//
// - CATEGORY_ICON_NAMES: appropriate for an admin to pick as "the icon for
//   this website type" (a business/category picture) -- this exact list is
//   what routes/adminWebsiteTypes.js validates website_types.icon_name
//   against and what the Details tab's dropdown offers.
// - UI_ICON_NAMES: used directly, by fixed name, inside the layout
//   templates themselves (nav, hero, how-it-works steps) -- never
//   admin-selectable, so kept out of the picker/validation list.
const CATEGORY_ICON_NAMES = [
  'heart', 'utensils', 'briefcase', 'camera', 'shopping-bag', 'palette',
  'coffee', 'scissors', 'dumbbell', 'book-open', 'music', 'house', 'car',
  'wrench', 'graduation-cap', 'stethoscope', 'plane', 'gift', 'calendar',
  'users', 'shield-check', 'credit-card', 'zap', 'globe', 'lock',
  'circle-check', 'star', 'mail', 'phone', 'map-pin', 'sparkles'
];

const UI_ICON_NAMES = [
  'layout-template', 'pencil', 'rocket', 'menu', 'x', 'chevron-right',
  'chevron-down', 'arrow-right', 'external-link', 'bell'
];

const ALL_ICON_NAMES = [...CATEGORY_ICON_NAMES, ...UI_ICON_NAMES];
const DEFAULT_ICON_NAME = 'sparkles';

// Read once per name, cache forever -- these files never change at
// runtime (they're static assets shipped with the app, not user content),
// so there's no reason to hit the filesystem on every render of every
// card on a page that might show a dozen of these.
const cache = new Map();

function loadIconFile(name) {
  const filePath = path.join(ICONS_DIR, `${name}.svg`);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`[ICONS] Failed to read icon "${name}" from ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Returns the raw inline SVG markup for a curated icon name, for
 * unescaped rendering in an EJS view (`<%- getIconSvg('sparkles') %>`).
 * Falls back to DEFAULT_ICON_NAME for any name outside the curated set
 * (e.g. a pre-v1.0.7 website_types row, or any other unexpected value) --
 * a card should always show SOME icon rather than a broken image or blank
 * gap, and the fallback itself is always guaranteed present since it's
 * part of the bundled set this function's own allow-list is built from.
 */
function getIconSvg(name) {
  const safeName = ALL_ICON_NAMES.includes(name) ? name : DEFAULT_ICON_NAME;

  if (cache.has(safeName)) return cache.get(safeName);

  let svg = loadIconFile(safeName);
  if (svg === null && safeName !== DEFAULT_ICON_NAME) {
    svg = loadIconFile(DEFAULT_ICON_NAME);
  }
  svg = svg || '';

  cache.set(safeName, svg);
  return svg;
}

module.exports = { CATEGORY_ICON_NAMES, UI_ICON_NAMES, ALL_ICON_NAMES, DEFAULT_ICON_NAME, getIconSvg };
