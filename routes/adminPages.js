const express = require('express');
const { getPool } = require('../db/init');
const { deriveCsrfToken } = require('../lib/auth');
const { requireAdminSession, getSessionCookie } = require('../middleware/requireAdminSession');
const { INTERNAL_ADMIN_PREFIX } = require('../middleware/adminSlug');

const router = express.Router();

router.use(requireAdminSession);

// Every dashboard page needs the current slug (to build nav links) and a
// CSRF token (to embed in the page for state-changing fetch calls) — set
// once here via res.locals rather than repeating it in every route.
router.use((req, res, next) => {
  res.locals.slug = process.env.ADMIN_PATH_SLUG;
  res.locals.csrfToken = deriveCsrfToken(getSessionCookie(req), process.env.SESSION_SECRET);
  next();
});

router.get(`${INTERNAL_ADMIN_PREFIX}/`, async (req, res) => {
  const pool = getPool();

  const paystackResult = await pool.query('SELECT mode FROM paystack_config WHERE id = 1');
  const paystackConfigured = paystackResult.rowCount > 0;
  const paystackMode = paystackConfigured ? paystackResult.rows[0].mode : null;

  const providerResult = await pool.query(
    'SELECT label, selected_model FROM ai_providers WHERE is_active = true LIMIT 1'
  );
  const activeProvider = providerResult.rowCount > 0
    ? { label: providerResult.rows[0].label, selectedModel: providerResult.rows[0].selected_model }
    : null;

  const typeCounts = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE is_active) AS active_count,
       COUNT(*) FILTER (WHERE NOT is_active) AS inactive_count
     FROM website_types`
  );

  res.render('admin/overview', {
    paystackConfigured,
    paystackMode,
    activeProvider,
    activeTypeCount: Number(typeCounts.rows[0].active_count),
    inactiveTypeCount: Number(typeCounts.rows[0].inactive_count)
  });
});

router.get(`${INTERNAL_ADMIN_PREFIX}/payments`, (req, res) => {
  res.render('admin/paystack');
});

router.get(`${INTERNAL_ADMIN_PREFIX}/ai-provider`, (req, res) => {
  res.render('admin/ai-providers');
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

module.exports = router;
