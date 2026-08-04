const express = require('express');
const { getPool } = require('../db/init');

const router = express.Router();

router.get('/', async (req, res) => {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM website_types WHERE is_active = true ORDER BY display_order ASC, id ASC'
  );

  res.render('public/home', {
    websiteTypes: result.rows.map(t => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      priceKes: t.price_kes
    }))
  });
});

router.get('/build/:slug', async (req, res) => {
  const pool = getPool();
  const typeResult = await pool.query(
    'SELECT * FROM website_types WHERE slug = $1 AND is_active = true',
    [req.params.slug]
  );

  if (typeResult.rowCount === 0) {
    return res.status(404).render('public/not-found', {
      message: 'That website type is not available.'
    });
  }

  const websiteType = typeResult.rows[0];
  const fieldsResult = await pool.query(
    'SELECT * FROM template_fields WHERE website_type_id = $1 ORDER BY display_order ASC, id ASC',
    [websiteType.id]
  );

  res.render('public/build', {
    websiteType: { slug: websiteType.slug, name: websiteType.name, priceKes: websiteType.price_kes },
    fields: fieldsResult.rows.map(f => ({
      fieldKey: f.field_key,
      fieldLabel: f.field_label,
      fieldType: f.field_type,
      placeholderText: f.placeholder_text,
      isRequired: f.is_required,
      dropdownOptions: f.dropdown_options
    }))
  });
});

router.get('/build/:slug/preview', async (req, res) => {
  const pool = getPool();
  const typeResult = await pool.query(
    'SELECT * FROM website_types WHERE slug = $1 AND is_active = true',
    [req.params.slug]
  );

  if (typeResult.rowCount === 0) {
    return res.status(404).render('public/not-found', {
      message: 'That website type is not available.'
    });
  }

  res.render('public/preview', {
    websiteType: { slug: typeResult.rows[0].slug, name: typeResult.rows[0].name }
  });
});

router.get('/build/:slug/checkout', async (req, res) => {
  const pool = getPool();
  const typeResult = await pool.query(
    'SELECT * FROM website_types WHERE slug = $1 AND is_active = true',
    [req.params.slug]
  );

  if (typeResult.rowCount === 0) {
    return res.status(404).render('public/not-found', {
      message: 'That website type is not available.'
    });
  }

  res.render('public/checkout-stub', { slug: typeResult.rows[0].slug });
});

module.exports = router;
