// v1.1.3: static image assets bundled with the Skilline-styled landing
// page redesign. Per the build brief, these are committed files, NEVER
// admin-editable (no `image_url`/upload field anywhere in
// lib/landingSectionTypes.js's schemas) — an `image_asset_key` stored on
// a `split_image_text` / `cta_image_cards` / `bullet_list` row's content
// is just a lookup into this fixed map, resolved at render time.
//
// Every key here is set ONLY by the v1.1.3 seed migration (db/init.js),
// for the specific section instances that came from the original
// Skilline template. Sections the admin creates fresh through the
// "Add section" flow have no way to pick an image this version (see
// routes/adminLandingSections.js / views/admin/landing-sections.ejs —
// there is deliberately no image-picker UI), so their `image_asset_key`
// stays '' and getLandingImageAsset() below returns null for them.
// views/partials/landing-sections/*.ejs render a neutral placeholder
// panel (matching the pattern the old landing.ejs hero placeholder used)
// rather than a broken <img> in that case — see each partial's own
// comment.
//
// img/company/* (fake trusted-by logos) and the four images used
// exclusively by the dropped "Latest News" section
// (laptop-news/children-laptop/girl-laptop/cat-laptop.png) were
// deliberately never copied into public/images/landing/ at all — see
// this version's delivery notes. img/hero.png was ALSO excluded: it's
// unreferenced dead weight in the original template itself (the actual
// hero image the template renders is girl.png, not hero.png) — same
// "don't ship unused images" reasoning as the company-logo exclusion,
// just for a file that isn't part of an explicitly-dropped section.
const LANDING_IMAGE_ASSETS = {
  // split_image_text instances
  'teacher-explaining': '/images/landing/teacher-explaining.png',
  'girl-with-books': '/images/landing/girl-with-books.png',
  'true-false': '/images/landing/true-false.png',
  'gradebook': '/images/landing/gradebook.png',
  'discussion': '/images/landing/discussion.png',
  'integrations': '/images/landing/integrations.png',
  // cta_image_cards instances
  'for-instructors': '/images/landing/for-instructors.png',
  'for-students': '/images/landing/for-students.png',
  // bullet_list instance
  'vcall': '/images/landing/vcall.png'
};

// hero and testimonials each have exactly one real-world instance and,
// like the build brief specifies for hero, their image is hardcoded
// directly into that section type's own partial — never looked up by key
// at all, and never part of a section's `content` JSON. Exported here too
// just so every static landing image path lives in one file, not because
// any lookup happens through this map for these two.
const HERO_IMAGE_PATH = '/images/landing/hero-girl.png';
const HERO_DECORATIVE_PATHS = {
  calendar: '/images/landing/hero-calendar.svg',
  congrat: '/images/landing/hero-congrat.svg',
  uxClass: '/images/landing/hero-ux-class.svg'
};
const TESTIMONIALS_IMAGE_PATH = '/images/landing/testimonials.png';

/**
 * Resolves an `image_asset_key` to its static path, or null if the key is
 * empty/unrecognized (e.g. an admin-created section with no image, or
 * stale/hand-edited data) — callers render a placeholder rather than a
 * broken <img> in that case.
 */
function getLandingImageAsset(key) {
  if (!key) return null;
  return LANDING_IMAGE_ASSETS[key] || null;
}

module.exports = {
  LANDING_IMAGE_ASSETS,
  HERO_IMAGE_PATH,
  HERO_DECORATIVE_PATHS,
  TESTIMONIALS_IMAGE_PATH,
  getLandingImageAsset
};
