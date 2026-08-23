const express = require('express');
const { getPool } = require('../db/init');
const { deriveCsrfToken } = require('../lib/auth');
const { requireAdminSession, getSessionCookie } = require('../middleware/requireAdminSession');
const { INTERNAL_ADMIN_PREFIX } = require('../middleware/adminSlug');
const { CATEGORY_ICON_NAMES, ALL_ICON_NAMES } = require('../lib/icons');

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
  next();
});

router.get(`${INTERNAL_ADMIN_PREFIX}/`, (req, res) => {
  res.render('admin/overview');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/payments`, (req, res) => {
  res.render('admin/paystack');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/ai-provider`, (req, res) => {
  res.render('admin/ai-providers');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/email-providers`, (req, res) => {
  res.render('admin/email-providers');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/website-types`, (req, res) => {
  res.render('admin/website-types/index');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/website-types/:id`, async (req, res) => {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM website_types WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) {
    return res.status(404).send('Website type not found');
  }
  res.render('admin/website-types/detail', { websiteType: result.rows[0] });
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

router.get(`${INTERNAL_ADMIN_PREFIX}/scripts`, (req, res) => {
  res.render('admin/scripts');
});

module.exports = router;
