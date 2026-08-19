const { getPool } = require('../db/init');

const CACHE_TTL_MS = 60 * 1000; // same reasoning as lib/siteSettings.js / lib/siteScripts.js

let cached = null;
let cachedAt = 0;

async function fetchFromDb() {
  const pool = getPool();

  const [contentResult, stepsResult, footerLinksResult] = await Promise.all([
    pool.query('SELECT * FROM landing_content ORDER BY id ASC LIMIT 1'),
    pool.query('SELECT * FROM landing_steps ORDER BY display_order ASC, id ASC'),
    pool.query('SELECT * FROM landing_footer_links ORDER BY display_order ASC, id ASC')
  ]);

  const content = contentResult.rowCount > 0 ? contentResult.rows[0] : {
    hero_headline: 'HeartCode',
    hero_tagline: '',
    hero_cta_text: 'Explore website types',
    trust_line_text: '',
    footer_text: ''
  };

  return {
    content: {
      heroHeadline: content.hero_headline,
      heroTagline: content.hero_tagline,
      heroCtaText: content.hero_cta_text,
      trustLineText: content.trust_line_text,
      footerText: content.footer_text
    },
    steps: stepsResult.rows.map(s => ({
      id: s.id,
      iconName: s.icon_name,
      title: s.title,
      description: s.description,
      displayOrder: s.display_order
    })),
    footerLinks: footerLinksResult.rows.map(l => ({
      id: l.id,
      label: l.label,
      url: l.url,
      displayOrder: l.display_order
    }))
  };
}

/**
 * Returns { content, steps, footerLinks } for the landing page, cached the
 * same way and for the same reason as lib/siteSettings.js. Falls back to
 * a minimal, non-empty content object (never an empty/broken landing page)
 * if the DB read fails and there's no cache yet — the migration always
 * seeds a real row, so this fallback should be unreachable in practice,
 * but the landing page must never break outright over a transient DB
 * hiccup on what's fundamentally a marketing page.
 */
async function getLandingContent() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    cached = await fetchFromDb();
    cachedAt = now;
  } catch (err) {
    console.error('[LANDING CONTENT] Failed to read landing content, serving last-known values:', err.message);
    if (!cached) {
      cached = {
        content: {
          heroHeadline: 'HeartCode',
          heroTagline: '',
          heroCtaText: 'Explore website types',
          trustLineText: '',
          footerText: ''
        },
        steps: [],
        footerLinks: []
      };
    }
  }

  return cached;
}

async function refreshLandingContentCache() {
  try {
    cached = await fetchFromDb();
    cachedAt = Date.now();
  } catch (err) {
    console.error('[LANDING CONTENT] Failed to refresh cache after save:', err.message);
  }
  return cached;
}

module.exports = { getLandingContent, refreshLandingContentCache };
