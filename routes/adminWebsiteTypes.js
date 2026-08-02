const express = require('express');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');

const router = express.Router();
router.use(requireAdminSession);

const FIELD_KEY_RE = /^[a-z0-9_]+$/;
const VALID_FIELD_TYPES = new Set(['text', 'textarea', 'email', 'password', 'dropdown']);
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

function slugify(input) {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatField(f) {
  return {
    id: f.id,
    fieldKey: f.field_key,
    fieldLabel: f.field_label,
    fieldType: f.field_type,
    placeholderText: f.placeholder_text,
    isRequired: f.is_required,
    dropdownOptions: f.dropdown_options,
    displayOrder: f.display_order
  };
}

// ---- website types ----

router.get('/', async (req, res) => {
  const pool = getPool();
  const types = await pool.query('SELECT * FROM website_types ORDER BY display_order ASC, id ASC');

  const results = [];
  for (const t of types.rows) {
    const fieldCount = await pool.query(
      'SELECT COUNT(*) FROM template_fields WHERE website_type_id = $1',
      [t.id]
    );
    const activeTemplate = await pool.query(
      'SELECT version FROM templates WHERE website_type_id = $1 AND is_active = true LIMIT 1',
      [t.id]
    );
    results.push({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      isActive: t.is_active,
      displayOrder: t.display_order,
      priceKes: t.price_kes,
      fieldCount: Number(fieldCount.rows[0].count),
      activeTemplateVersion: activeTemplate.rowCount > 0 ? activeTemplate.rows[0].version : null,
      createdAt: t.created_at,
      updatedAt: t.updated_at
    });
  }

  res.json(results);
});

router.post('/', requireCsrf, async (req, res) => {
  const { name, description, priceKes, slug: providedSlug } = req.body || {};

  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const baseSlug = slugify(providedSlug || name);
  if (!baseSlug) {
    return res.status(400).json({ error: 'Could not derive a valid slug from name' });
  }

  const pool = getPool();
  const conflict = await pool.query('SELECT id FROM website_types WHERE slug = $1', [baseSlug]);
  if (conflict.rowCount > 0) {
    return res.status(409).json({ error: `slug "${baseSlug}" is already in use`, conflictField: 'slug' });
  }

  const price = Number.isInteger(priceKes) && priceKes >= 0 ? priceKes : 0;

  const result = await pool.query(
    `INSERT INTO website_types (slug, name, description, price_kes)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [baseSlug, name.trim(), typeof description === 'string' ? description : '', price]
  );
  const t = result.rows[0];
  res.status(201).json({
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    isActive: t.is_active,
    displayOrder: t.display_order,
    priceKes: t.price_kes,
    fieldCount: 0,
    activeTemplateVersion: null
  });
});

router.put('/:id', requireCsrf, async (req, res) => {
  const id = Number(req.params.id);
  const { name, description, isActive, priceKes, displayOrder } = req.body || {};

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM website_types WHERE id = $1', [id]);
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }
  const current = existing.rows[0];

  const next = {
    name: typeof name === 'string' && name.trim() ? name.trim() : current.name,
    description: typeof description === 'string' ? description : current.description,
    is_active: typeof isActive === 'boolean' ? isActive : current.is_active,
    price_kes: Number.isInteger(priceKes) && priceKes >= 0 ? priceKes : current.price_kes,
    display_order: Number.isInteger(displayOrder) ? displayOrder : current.display_order
  };

  const result = await pool.query(
    `UPDATE website_types SET name = $1, description = $2, is_active = $3,
       price_kes = $4, display_order = $5, updated_at = NOW()
     WHERE id = $6 RETURNING *`,
    [next.name, next.description, next.is_active, next.price_kes, next.display_order, id]
  );
  const t = result.rows[0];
  res.json({
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    isActive: t.is_active,
    displayOrder: t.display_order,
    priceKes: t.price_kes
  });
});

router.delete('/:id', requireCsrf, async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();
  // ON DELETE CASCADE on template_fields.website_type_id and
  // templates.website_type_id removes dependent rows automatically.
  const result = await pool.query('DELETE FROM website_types WHERE id = $1 RETURNING id', [id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }
  res.json({ success: true });
});

// ---- fields ----

router.get('/:id/fields', async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM template_fields WHERE website_type_id = $1 ORDER BY display_order ASC, id ASC',
    [id]
  );
  res.json(result.rows.map(formatField));
});

router.post('/:id/fields', requireCsrf, async (req, res) => {
  const websiteTypeId = Number(req.params.id);
  const { fieldKey, fieldLabel, fieldType, placeholderText, isRequired, dropdownOptions, displayOrder } = req.body || {};

  if (typeof fieldKey !== 'string' || !FIELD_KEY_RE.test(fieldKey)) {
    return res.status(400).json({ error: 'fieldKey must match ^[a-z0-9_]+$' });
  }
  if (typeof fieldLabel !== 'string' || !fieldLabel.trim()) {
    return res.status(400).json({ error: 'fieldLabel is required' });
  }

  const type = VALID_FIELD_TYPES.has(fieldType) ? fieldType : 'text';
  if (type === 'dropdown' && !Array.isArray(dropdownOptions)) {
    return res.status(400).json({ error: 'dropdownOptions must be an array when fieldType is "dropdown"' });
  }

  const pool = getPool();
  const typeCheck = await pool.query('SELECT id FROM website_types WHERE id = $1', [websiteTypeId]);
  if (typeCheck.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }

  const conflict = await pool.query(
    'SELECT id FROM template_fields WHERE website_type_id = $1 AND field_key = $2',
    [websiteTypeId, fieldKey]
  );
  if (conflict.rowCount > 0) {
    return res.status(409).json({ error: `fieldKey "${fieldKey}" already exists for this website type` });
  }

  const result = await pool.query(
    `INSERT INTO template_fields (website_type_id, field_key, field_label, field_type, placeholder_text, is_required, dropdown_options, display_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      websiteTypeId,
      fieldKey,
      fieldLabel.trim(),
      type,
      typeof placeholderText === 'string' ? placeholderText : '',
      typeof isRequired === 'boolean' ? isRequired : true,
      type === 'dropdown' ? JSON.stringify(dropdownOptions) : null,
      Number.isInteger(displayOrder) ? displayOrder : 0
    ]
  );
  res.status(201).json(formatField(result.rows[0]));
});

router.put('/:id/fields/:fieldId', requireCsrf, async (req, res) => {
  const { id, fieldId } = req.params;
  const { fieldLabel, fieldType, placeholderText, isRequired, dropdownOptions, displayOrder } = req.body || {};

  const pool = getPool();
  const existing = await pool.query(
    'SELECT * FROM template_fields WHERE id = $1 AND website_type_id = $2',
    [fieldId, id]
  );
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'Field not found' });
  }
  const current = existing.rows[0];

  const nextType = VALID_FIELD_TYPES.has(fieldType) ? fieldType : current.field_type;
  if (nextType === 'dropdown' && dropdownOptions !== undefined && !Array.isArray(dropdownOptions)) {
    return res.status(400).json({ error: 'dropdownOptions must be an array when fieldType is "dropdown"' });
  }

  const next = {
    field_label: typeof fieldLabel === 'string' && fieldLabel.trim() ? fieldLabel.trim() : current.field_label,
    field_type: nextType,
    placeholder_text: typeof placeholderText === 'string' ? placeholderText : current.placeholder_text,
    is_required: typeof isRequired === 'boolean' ? isRequired : current.is_required,
    dropdown_options: nextType === 'dropdown'
      ? JSON.stringify(dropdownOptions !== undefined ? dropdownOptions : current.dropdown_options)
      : null,
    display_order: Number.isInteger(displayOrder) ? displayOrder : current.display_order
  };

  const result = await pool.query(
    `UPDATE template_fields SET field_label = $1, field_type = $2, placeholder_text = $3,
       is_required = $4, dropdown_options = $5, display_order = $6
     WHERE id = $7 RETURNING *`,
    [next.field_label, next.field_type, next.placeholder_text, next.is_required, next.dropdown_options, next.display_order, fieldId]
  );
  res.json(formatField(result.rows[0]));
});

router.delete('/:id/fields/:fieldId', requireCsrf, async (req, res) => {
  const { id, fieldId } = req.params;
  const pool = getPool();
  const result = await pool.query(
    'DELETE FROM template_fields WHERE id = $1 AND website_type_id = $2 RETURNING id',
    [fieldId, id]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Field not found' });
  }
  res.json({ success: true });
});

// ---- templates ----

router.get('/:id/template', async (req, res) => {
  const id = Number(req.params.id);
  const pool = getPool();

  const active = await pool.query(
    'SELECT * FROM templates WHERE website_type_id = $1 AND is_active = true LIMIT 1',
    [id]
  );
  const history = await pool.query(
    `SELECT version, created_at FROM templates WHERE website_type_id = $1
     ORDER BY version DESC LIMIT 5`,
    [id]
  );

  res.json({
    active: active.rowCount > 0
      ? { htmlContent: active.rows[0].html_content, version: active.rows[0].version }
      : null,
    history: history.rows.map(h => ({ version: h.version, createdAt: h.created_at }))
  });
});

router.put('/:id/template', requireCsrf, async (req, res) => {
  const websiteTypeId = Number(req.params.id);
  const { htmlContent } = req.body || {};

  if (typeof htmlContent !== 'string' || !htmlContent.trim()) {
    return res.status(400).json({ error: 'htmlContent is required' });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const typeCheck = await client.query('SELECT id FROM website_types WHERE id = $1 FOR UPDATE', [websiteTypeId]);
    if (typeCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Website type not found' });
    }

    // Validate placeholders against defined fields — warn, don't block:
    // the admin may be about to add the field next.
    const fieldsResult = await client.query(
      'SELECT field_key FROM template_fields WHERE website_type_id = $1',
      [websiteTypeId]
    );
    const knownKeys = new Set(fieldsResult.rows.map(f => f.field_key));
    const foundKeys = new Set();
    let match;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((match = PLACEHOLDER_RE.exec(htmlContent)) !== null) {
      foundKeys.add(match[1]);
    }
    const undefinedPlaceholders = [...foundKeys].filter(k => !knownKeys.has(k));

    const maxVersionResult = await client.query(
      'SELECT COALESCE(MAX(version), 0) AS max_version FROM templates WHERE website_type_id = $1',
      [websiteTypeId]
    );
    const nextVersion = Number(maxVersionResult.rows[0].max_version) + 1;

    // Deactivate the current version and insert the new one as active, in
    // the same transaction — never overwrites or deletes old versions, so
    // a bad edit can always be rolled back.
    await client.query(
      'UPDATE templates SET is_active = false WHERE website_type_id = $1 AND is_active = true',
      [websiteTypeId]
    );

    const inserted = await client.query(
      `INSERT INTO templates (website_type_id, html_content, version, is_active)
       VALUES ($1, $2, $3, true) RETURNING *`,
      [websiteTypeId, htmlContent, nextVersion]
    );

    await client.query('COMMIT');

    res.json({
      version: inserted.rows[0].version,
      undefinedPlaceholders
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[TEMPLATE] Failed to save template:', err.message);
    res.status(500).json({ error: 'Failed to save template' });
  } finally {
    client.release();
  }
});

router.post('/:id/template/rollback/:version', requireCsrf, async (req, res) => {
  const websiteTypeId = Number(req.params.id);
  const version = Number(req.params.version);

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const target = await client.query(
      'SELECT id FROM templates WHERE website_type_id = $1 AND version = $2 FOR UPDATE',
      [websiteTypeId, version]
    );
    if (target.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That template version does not exist' });
    }

    // Pointer flip only — deactivate whatever's currently active, activate
    // the requested past version. Nothing is deleted or rewritten.
    await client.query(
      'UPDATE templates SET is_active = false WHERE website_type_id = $1 AND is_active = true',
      [websiteTypeId]
    );
    await client.query('UPDATE templates SET is_active = true WHERE id = $1', [target.rows[0].id]);

    await client.query('COMMIT');
    res.json({ success: true, activeVersion: version });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[TEMPLATE] Failed to rollback template:', err.message);
    res.status(500).json({ error: 'Failed to rollback template' });
  } finally {
    client.release();
  }
});

module.exports = router;
