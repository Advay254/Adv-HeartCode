const { z } = require('zod');
const { ALL_ICON_NAMES } = require('./icons');

// v1.1.3: decorative accent tokens for the Skilline-styled landing page —
// every one of these traces back to a tint/shade of hc-blue or hc-yellow
// (see tailwind.config.js's landing-only theme extension and that file's
// comment for the exact hex values and where each is used). Never
// Skilline's own rainbow palette (purples/oranges/cyans/greens/reds) —
// that's the one deliberate recolor deviation from the template, per the
// build brief. Used anywhere a section's JSON shape calls for an
// icon_color or decorative_accent_color.
const ACCENT_COLOR_NAMES = [
  'sk-blue', 'sk-blue-deep', 'sk-blue-soft', 'sk-blue-pale',
  'sk-yellow', 'sk-yellow-deep', 'sk-yellow-soft', 'sk-yellow-pale'
];

// v1.1.3 correction: an earlier pass through this file had image fields
// accept a hosted URL string (`image_url`/`hero_image_url`), following
// the same convention as og_image_url/favicon_url elsewhere in this app.
// The actual build brief for this version is explicit that images are
// NOT part of this CMS at all — every image is a fixed file already
// committed into the repo (public/images/landing/, see
// lib/landingImageAssets.js), referenced by a short `image_asset_key`
// that's set ONLY at seed time (db/init.js's migration) and never
// exposed as an editable field anywhere in the admin UI. This is a
// generous length cap on that key, not a strict shape check — the actual
// "does this key resolve to a real file" check happens at render time in
// getLandingImageAsset(), which degrades to a placeholder rather than a
// broken image for an empty/unrecognized key (e.g. a section the admin
// created fresh, which has no image available to it this version).
const imageAssetKeyField = z.string().trim().max(100).optional().default('');
const urlField = z.string().trim().max(500).optional().default('');
const requiredUrlField = z.string().trim().min(1).max(500);

const heroSchema = z.object({
  headline: z.string().trim().min(1).max(200),
  highlighted_word: z.string().trim().max(100).optional().default(''),
  tagline: z.string().trim().max(500).optional().default(''),
  primary_cta_text: z.string().trim().max(100).optional().default(''),
  primary_cta_url: urlField,
  secondary_cta_text: z.string().trim().max(100).optional().default(''),
  secondary_cta_url: urlField
  // No image field at all — the hero image is the fixed girl.png asset,
  // hardcoded in views/partials/landing-sections/hero.ejs. There's only
  // ever one hero section, so there's no ambiguity about which image it
  // uses and nothing for a key to select between.
});

const featureCardSchema = z.object({
  // icon_name is an additive extension beyond the literal shape given in
  // the build brief (which specified only icon_color) — see db/init.js's
  // migration comment for why a card needs a real icon selection, not
  // just a color, to actually "reuse the curated Lucide icon set."
  icon_name: z.enum(ALL_ICON_NAMES),
  icon_color: z.enum(ACCENT_COLOR_NAMES),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(400)
});
const featureCardsSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  highlighted_word: z.string().trim().max(100).optional().default(''),
  cards: z.array(featureCardSchema).max(12).optional().default([])
});

const splitImageTextSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  highlighted_word: z.string().trim().max(100).optional().default(''),
  body_text: z.string().trim().max(1000).optional().default(''),
  image_side: z.enum(['left', 'right']).optional().default('right'),
  cta_text: z.string().trim().max(100).optional().default(''),
  cta_url: urlField,
  decorative_accent_color: z.enum(ACCENT_COLOR_NAMES).optional().default('sk-yellow'),
  image_asset_key: imageAssetKeyField
});

const ctaImageCardSchema = z.object({
  image_asset_key: imageAssetKeyField,
  overlay_label: z.string().trim().min(1).max(100),
  button_text: z.string().trim().min(1).max(100),
  button_url: requiredUrlField
});
const ctaImageCardsSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  cards: z.array(ctaImageCardSchema).max(6).optional().default([])
});

const bulletItemSchema = z.object({
  icon_color: z.enum(ACCENT_COLOR_NAMES),
  text: z.string().trim().min(1).max(300)
});
const bulletListSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  highlighted_word: z.string().trim().max(100).optional().default(''),
  body_text: z.string().trim().max(1000).optional().default(''),
  items: z.array(bulletItemSchema).max(12).optional().default([]),
  image_asset_key: imageAssetKeyField
});

// Deliberately ships empty by default (see db/init.js — no seed rows of
// this type at all) — never seeded with placeholder people. An admin
// either adds real ones here or leaves this section type unused/inactive.
// No image field either: the original template's "TESTIMONIAL" section
// paired a decorative image with header copy but no actual reviews —
// that image (testimonials.png) is hardcoded directly into
// views/partials/landing-sections/testimonials.ejs the same way hero's
// is, since (like hero) there's only ever one testimonials section.
const testimonialItemSchema = z.object({
  quote: z.string().trim().min(1).max(600),
  author_name: z.string().trim().min(1).max(120),
  author_role: z.string().trim().max(120).optional().default('')
});
const testimonialsSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  eyebrow_text: z.string().trim().max(100).optional().default(''),
  items: z.array(testimonialItemSchema).max(20).optional().default([])
});

const footerLinkSchema = z.object({
  label: z.string().trim().min(1).max(100),
  url: requiredUrlField
});
const footerLinkColumnSchema = z.object({
  heading: z.string().trim().max(100).optional().default(''),
  links: z.array(footerLinkSchema).max(10).optional().default([])
});
// `tagline` is the migrated v1.0.x landing_content.footer_text column
// (see db/init.js's v1.1.3 migration comment) and renders as the bottom
// copyright-style bar in views/partials/landing-sections/footer.ejs —
// not a short brand blurb near the logo. That's the field's real,
// always-has-been role: its own original schema default (and every
// fresh install's actual seeded value) is a full "© 2026 HeartCode. All
// rights reserved." line, not marketing copy.
const footerSchema = z.object({
  tagline: z.string().trim().max(300).optional().default(''),
  link_columns: z.array(footerLinkColumnSchema).max(6).optional().default([])
});

const SECTION_SCHEMAS = {
  hero: heroSchema,
  feature_cards: featureCardsSchema,
  split_image_text: splitImageTextSchema,
  cta_image_cards: ctaImageCardsSchema,
  bullet_list: bulletListSchema,
  testimonials: testimonialsSchema,
  footer: footerSchema
};

const SECTION_TYPES = Object.keys(SECTION_SCHEMAS);

// Section types whose content includes an image_asset_key an admin must
// never be able to set/overwrite through the update API — see
// preserveImageAssetKeys() below. cta_image_cards is the one type where
// the key lives one level down, per-card, rather than on the section's
// top-level content.
const TOP_LEVEL_IMAGE_KEY_TYPES = ['split_image_text', 'bullet_list'];

// Sensible, non-empty starting content for the "add section" flow's
// initial form render — deliberately generic placeholder text (never
// Skilline's own marketing copy), same reasoning as any other "new item"
// default elsewhere in this admin. image_asset_key is always '' here: a
// freshly admin-created section has no image available to it this
// version (no image-picker UI exists — see this version's delivery
// notes), so it renders via the placeholder path in each partial.
const DEFAULT_CONTENT = {
  hero: {
    headline: 'Your headline here', highlighted_word: '', tagline: '',
    primary_cta_text: 'Explore website types', primary_cta_url: '/explore',
    secondary_cta_text: '', secondary_cta_url: ''
  },
  feature_cards: { heading: 'Section heading', highlighted_word: '', cards: [] },
  split_image_text: {
    heading: 'Section heading', highlighted_word: '', body_text: '',
    image_side: 'right', cta_text: '', cta_url: '',
    decorative_accent_color: 'sk-yellow', image_asset_key: ''
  },
  cta_image_cards: { heading: 'Section heading', cards: [] },
  bullet_list: {
    heading: 'Section heading', highlighted_word: '', body_text: '',
    items: [], image_asset_key: ''
  },
  testimonials: { heading: 'What people say', eyebrow_text: 'TESTIMONIALS', items: [] },
  footer: { tagline: '', link_columns: [] }
};

/**
 * Validates a proposed `content` value against its section_type's schema.
 * Returns { success: true, data } with defaults applied, or
 * { success: false, error } with a human-readable first-issue message.
 */
function validateSectionContent(sectionType, content) {
  const schema = SECTION_SCHEMAS[sectionType];
  if (!schema) {
    return { success: false, error: 'Unknown section_type' };
  }
  const parsed = schema.safeParse(content || {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue ? issue.path.join('.') : 'content';
    return { success: false, error: `Invalid ${field || 'content'}${issue ? ': ' + issue.message : ''}` };
  }
  return { success: true, data: parsed.data };
}

/**
 * Forces `image_asset_key` (wherever it lives for this section_type) in
 * `incoming` to match `existing` — called by routes/adminLandingSections.js
 * BEFORE validateSectionContent() on every content update, so there is no
 * code path, malicious or accidental, through which the admin API can
 * change which image a section instance uses. This is the actual
 * enforcement of "not something the admin can change through this UI" —
 * simply omitting the field from the admin's EDIT FORM wouldn't be
 * enough on its own, since the API itself takes a raw JSON body.
 *
 * cta_image_cards is matched by array index (there's no per-card id) —
 * a card the admin adds beyond the existing count has no prior key to
 * inherit, so it starts with '' (no image), same as any other
 * freshly-created image-bearing content.
 */
function preserveImageAssetKeys(sectionType, existingContent, incomingContent) {
  const existing = existingContent || {};
  const incoming = { ...(incomingContent || {}) };

  if (TOP_LEVEL_IMAGE_KEY_TYPES.includes(sectionType)) {
    incoming.image_asset_key = existing.image_asset_key || '';
    return incoming;
  }

  if (sectionType === 'cta_image_cards') {
    const existingCards = Array.isArray(existing.cards) ? existing.cards : [];
    const incomingCards = Array.isArray(incoming.cards) ? incoming.cards : [];
    incoming.cards = incomingCards.map((card, i) => ({
      ...card,
      image_asset_key: (existingCards[i] && existingCards[i].image_asset_key) || ''
    }));
    return incoming;
  }

  return incoming;
}

module.exports = {
  SECTION_TYPES,
  SECTION_SCHEMAS,
  DEFAULT_CONTENT,
  ACCENT_COLOR_NAMES,
  validateSectionContent,
  preserveImageAssetKeys
};
