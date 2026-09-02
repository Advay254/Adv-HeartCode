const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { getPool } = require('../db/init');
const { deriveCsrfToken } = require('../lib/auth');
const { requireAdminSession, getSessionCookie } = require('../middleware/requireAdminSession');
const { INTERNAL_ADMIN_PREFIX } = require('../middleware/adminSlug');
const { CATEGORY_ICON_NAMES, ALL_ICON_NAMES } = require('../lib/icons');
const { SECTION_TYPES, DEFAULT_CONTENT, ACCENT_COLOR_NAMES } = require('../lib/landingSectionTypes');

const router = express.Router();

router.use(requireAdminSession);

// Every dashboard page needs the current slug (to build nav links) and a
// CSRF token (to embed in the page for state-changing fetch calls) — set
// once here via res.locals rather than repeating it in every route.
// iconNames (v1.0.7) is here for the same reason: only the website-types
// views actually use it (the icon picker), but setting it once for every
// admin page is simpler and safer than remembering to pass it at each of
// the two specific routes that need it, and lib/icons.js's
// CATEGORY_ICON_NAMES stays the single source of truth either way.
// stepIconNames (v1.0.8) is the broader ALL_ICON_NAMES set, for the
// Landing Page admin's step icon picker — matches exactly what
// routes/adminLanding.js's own STEP_ICON_NAMES validates against.
router.use((req, res, next) => {
  res.locals.slug = process.env.ADMIN_PATH_SLUG;
  res.locals.csrfToken = deriveCsrfToken(getSessionCookie(req), process.env.SESSION_SECRET);
  res.locals.iconNames = CATEGORY_ICON_NAMES;
  res.locals.stepIconNames = ALL_ICON_NAMES;
  // v1.1.3: only the new Landing Sections page uses these, but set once
  // here for the same reason iconNames/stepIconNames are — one place to
  // keep in sync with lib/landingSectionTypes.js rather than remembering
  // it at just that one route.
  res.locals.landingSectionTypes = SECTION_TYPES;
  res.locals.landingSectionDefaults = DEFAULT_CONTENT;
  res.locals.landingAccentColors = ACCENT_COLOR_NAMES;
  next();
});

router.get(`${INTERNAL_ADMIN_PREFIX}/`, (req, res) => {
  res.render('admin/overview');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/payments`, (req, res) => {
  res.render('admin/paystack');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/hosting`, (req, res) => {
  res.render('admin/hosting');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/ai-provider`, (req, res) => {
  res.render('admin/ai-providers');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/email-providers`, (req, res) => {
  res.render('admin/email-providers');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/notifications`, (req, res) => {
  res.render('admin/notifications');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/website-types`, (req, res) => {
  res.render('admin/website-types/index');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/website-types/:id`, asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM website_types WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) {
    return res.status(404).send('Website type not found');
  }
  // v1.1.4 Part D: the Details tab's category dropdown needs the full
  // category list up front (client-fetched data would work too, but this
  // page already renders websiteType server-side, so fetching categories
  // the same way avoids an extra round trip before the dropdown can
  // render with the right option pre-selected).
  const categoriesResult = await pool.query(
    'SELECT id, name FROM website_categories ORDER BY display_order ASC, id ASC'
  );
  res.render('admin/website-types/detail', {
    websiteType: result.rows[0],
    categories: categoriesResult.rows
  });
}));

router.get(`${INTERNAL_ADMIN_PREFIX}/categories`, (req, res) => {
  res.render('admin/categories');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/faq`, (req, res) => {
  res.render('admin/faq');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/submissions`, (req, res) => {
  res.render('admin/submissions');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/recovery`, (req, res) => {
  res.render('admin/recovery');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/funnel`, (req, res) => {
  res.render('admin/funnel');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/site-settings`, (req, res) => {
  res.render('admin/site-settings');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/landing-page`, (req, res) => {
  res.render('admin/landing-page');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/landing-sections`, (req, res) => {
  res.render('admin/landing-sections');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/scripts`, (req, res) => {
  res.render('admin/scripts');
});

module.exports = router;
