const express = require('express');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');

const router = express.Router();
router.use(requireAdminSession);

const FIELD_KEY_RE = /^[a-z0-9_]+$/;
const VALID_FIELD_TYPES = ['text', 'textarea', 'email', 'password', 'dropdown'];
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
// v1.0.6: matches a full loop block, {{#each key}}...{{/each}}, capturing
// both the root key and the body — used at template-save time to (a)
// check that every field referenced in a loop is actually array-shaped
// (see the shape-validation block in PUT /:id/template) and (b) strip loop
// bodies out before the flat-placeholder scan runs, so {{this}} /
// {{this.sub_key}} tokens legitimately inside a loop aren't misreported as
// undefined top-level placeholders. Mirrors lib/template.js's own
// EACH_BLOCK_RE exactly (same non-greedy, non-nesting scope).
const EACH_BLOCK_RE = /\{\{#each\s+([a-zA-Z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g;
const OUTPUT_KEY_RE = /^[a-z0-9_]+$/;
const OUTPUT_TYPES = ['string', 'array_of_strings', 'array_of_objects'];

// Gap this whole file closes: GET/POST/PUT/DELETE on /:id, /:id/fields,
// /:id/fields/:fieldId, and /:id/template all used Number(req.params.X)
// with no NaN check and (for most of them) no try/catch around the query
// that followed — same unhandled-rejection-crashes-the-process risk
// documented in adminAiProviders.js. Every path param below is now
// validated before it reaches any query.
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });
const fieldIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  fieldId: z.coerce.number().int().positive()
});
const rollbackParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  version: z.coerce.number().int().positive()
});

const createTypeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  // v1.0.6: priceKes -> priceUsd. This is now the ONLY price field the
  // application reads or writes — website_types.price_kes is left in the
  // schema (unused) purely for backward compatibility with pre-1.0.6 rows.
  // Decimals now allowed (no .int()) since real USD prices have cents.
  priceUsd: z.coerce.number().min(0).optional(),
  slug: z.string().trim().max(100).optional()
});

const updateTypeSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  isActive: z.boolean().optional(),
  priceUsd: z.coerce.number().min(0).optional(),
  displayOrder: z.coerce.number().int().optional()
});

const createFieldSchema = z.object({
  fieldKey: z.string().regex(FIELD_KEY_RE, 'fieldKey must match ^[a-z0-9_]+$'),
  fieldLabel: z.string().trim().min(1).max(200),
  fieldType: z.enum(VALID_FIELD_TYPES).optional().default('text'),
  placeholderText: z.string().max(500).optional(),
  isRequired: z.boolean().optional().default(true),
  dropdownOptions: z.array(z.string().max(200)).max(100).optional(),
  displayOrder: z.coerce.number().int().optional().default(0)
});

const updateFieldSchema = z.object({
  fieldLabel: z.string().trim().min(1).max(200).optional(),
  fieldType: z.enum(VALID_FIELD_TYPES).optional(),
  placeholderText: z.string().max(500).optional(),
  isRequired: z.boolean().optional(),
  dropdownOptions: z.array(z.string().max(200)).max(100).optional(),
  displayOrder: z.coerce.number().int().optional()
});

// ~500KB ceiling — generous for a template, well under any body-size limit,
// still a real bound instead of "any length string accepted."
const templateSchema = z.object({
  htmlContent: z.string().min(1).max(500000)
});

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

function formatOutputField(f) {
  return {
    id: f.id,
    outputKey: f.output_key,
    outputType: f.output_type,
    description: f.description,
    objectShape: f.object_shape,
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
      priceUsd: Number(t.price_usd) || 0,
      aiEnabled: t.ai_enabled,
      fieldCount: Number(fieldCount.rows[0].count),
      activeTemplateVersion: activeTemplate.rowCount > 0 ? activeTemplate.rows[0].version : null,
      createdAt: t.created_at,
      updatedAt: t.updated_at
    });
  }

  res.json(results);
});

router.post('/', requireCsrf, async (req, res) => {
  const parsed = createTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'name is required' });
  }
  const { name, description, priceUsd, slug: providedSlug } = parsed.data;

  const baseSlug = slugify(providedSlug || name);
  if (!baseSlug) {
    return res.status(400).json({ error: 'Could not derive a valid slug from name' });
  }

  const pool = getPool();
  const conflict = await pool.query('SELECT id FROM website_types WHERE slug = $1', [baseSlug]);
  if (conflict.rowCount > 0) {
    return res.status(409).json({ error: `slug "${baseSlug}" is already in use`, conflictField: 'slug' });
  }

  const price = typeof priceUsd === 'number' && priceUsd >= 0 ? priceUsd : 0;

  const result = await pool.query(
    `INSERT INTO website_types (slug, name, description, price_usd)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [baseSlug, name, description || '', price]
  );
  const t = result.rows[0];
  res.status(201).json({
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    isActive: t.is_active,
    displayOrder: t.display_order,
    priceUsd: Number(t.price_usd) || 0,
    aiEnabled: t.ai_enabled,
    fieldCount: 0,
    activeTemplateVersion: null
  });
});

router.put('/:id', requireCsrf, async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const bodyParsed = updateTypeSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  const { id } = paramsParsed.data;
  const { name, description, isActive, priceUsd, displayOrder } = bodyParsed.data;

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM website_types WHERE id = $1', [id]);
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }
  const current = existing.rows[0];

  const next = {
    name: name !== undefined ? name : current.name,
    description: description !== undefined ? description : current.description,
    is_active: isActive !== undefined ? isActive : current.is_active,
    price_usd: priceUsd !== undefined ? priceUsd : current.price_usd,
    display_order: displayOrder !== undefined ? displayOrder : current.display_order
  };

  const result = await pool.query(
    `UPDATE website_types SET name = $1, description = $2, is_active = $3,
       price_usd = $4, display_order = $5, updated_at = NOW()
     WHERE id = $6 RETURNING *`,
    [next.name, next.description, next.is_active, next.price_usd, next.display_order, id]
  );
  const t = result.rows[0];
  res.json({
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    isActive: t.is_active,
    displayOrder: t.display_order,
    priceUsd: Number(t.price_usd) || 0,
    aiEnabled: t.ai_enabled
  });
});

router.delete('/:id', requireCsrf, async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const { id } = parsed.data;

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
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const { id } = parsed.data;

  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM template_fields WHERE website_type_id = $1 ORDER BY display_order ASC, id ASC',
    [id]
  );
  res.json(result.rows.map(formatField));
});

router.post('/:id/fields', requireCsrf, async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const bodyParsed = createFieldSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    const message = bodyParsed.error.issues[0] ? bodyParsed.error.issues[0].message : 'Invalid field data';
    return res.status(400).json({ error: message });
  }
  const { id: websiteTypeId } = paramsParsed.data;
  const { fieldKey, fieldLabel, fieldType, placeholderText, isRequired, dropdownOptions, displayOrder } = bodyParsed.data;

  if (fieldType === 'dropdown' && !Array.isArray(dropdownOptions)) {
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

  // v1.0.6: raw fields and AI output fields share the same substitution
  // namespace at render time (lib/template.js's substitutePlaceholders
  // takes one merged `values` map) — a fieldKey colliding with an existing
  // AI output_key would be ambiguous about which one wins, so it's
  // rejected symmetrically with the check in the AI output-field route
  // below.
  const aiConflict = await pool.query(
    'SELECT id FROM ai_output_fields WHERE website_type_id = $1 AND output_key = $2',
    [websiteTypeId, fieldKey]
  );
  if (aiConflict.rowCount > 0) {
    return res.status(409).json({ error: `fieldKey "${fieldKey}" collides with an existing AI output field of the same key` });
  }

  const result = await pool.query(
    `INSERT INTO template_fields (website_type_id, field_key, field_label, field_type, placeholder_text, is_required, dropdown_options, display_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      websiteTypeId,
      fieldKey,
      fieldLabel,
      fieldType,
      placeholderText || '',
      isRequired,
      fieldType === 'dropdown' ? JSON.stringify(dropdownOptions) : null,
      displayOrder
    ]
  );
  res.status(201).json(formatField(result.rows[0]));
});

router.put('/:id/fields/:fieldId', requireCsrf, async (req, res) => {
  const paramsParsed = fieldIdParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type or field id' });
  }
  const bodyParsed = updateFieldSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid field data' });
  }
  const { id, fieldId } = paramsParsed.data;
  const { fieldLabel, fieldType, placeholderText, isRequired, dropdownOptions, displayOrder } = bodyParsed.data;

  const pool = getPool();
  const existing = await pool.query(
    'SELECT * FROM template_fields WHERE id = $1 AND website_type_id = $2',
    [fieldId, id]
  );
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'Field not found' });
  }
  const current = existing.rows[0];

  const nextType = fieldType !== undefined ? fieldType : current.field_type;
  if (nextType === 'dropdown' && dropdownOptions !== undefined && !Array.isArray(dropdownOptions)) {
    return res.status(400).json({ error: 'dropdownOptions must be an array when fieldType is "dropdown"' });
  }

  const next = {
    field_label: fieldLabel !== undefined ? fieldLabel : current.field_label,
    field_type: nextType,
    placeholder_text: placeholderText !== undefined ? placeholderText : current.placeholder_text,
    is_required: isRequired !== undefined ? isRequired : current.is_required,
    dropdown_options: nextType === 'dropdown'
      ? JSON.stringify(dropdownOptions !== undefined ? dropdownOptions : current.dropdown_options)
      : null,
    display_order: displayOrder !== undefined ? displayOrder : current.display_order
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
  const parsed = fieldIdParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid website type or field id' });
  }
  const { id, fieldId } = parsed.data;

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
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const { id } = parsed.data;

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
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const bodyParsed = templateSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'htmlContent is required' });
  }
  const { id: websiteTypeId } = paramsParsed.data;
  const { htmlContent } = bodyParsed.data;

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
    // v1.0.6: also pull AI output fields so the placeholder check covers
    // {{key}} tokens that resolve to an AI output rather than a raw field,
    // and so the shape check below can tell flat outputs (output_type
    // 'string') from array-shaped ones (array_of_strings / array_of_objects).
    const outputFieldsResult = await client.query(
      'SELECT output_key, output_type FROM ai_output_fields WHERE website_type_id = $1',
      [websiteTypeId]
    );

    const flatKeys = new Set(fieldsResult.rows.map(f => f.field_key));
    const arrayKeys = new Set();
    for (const f of outputFieldsResult.rows) {
      if (f.output_type === 'string') flatKeys.add(f.output_key);
      else arrayKeys.add(f.output_key);
    }
    const knownKeys = new Set([...flatKeys, ...arrayKeys]);

    // v1.0.6: {{#each key}}...{{/each}} blocks are extracted from the
    // ORIGINAL html first (to catch every loop's root key, even an
    // unknown/mismatched one), and their bodies are then stripped out
    // before the flat {{key}} scan runs below. Without this, {{this}} and
    // {{this.sub_key}} tokens INSIDE a perfectly valid loop would get
    // caught by the flat scan too (nothing in PLACEHOLDER_RE's pattern
    // distinguishes "this" from a real field key) and misreported as an
    // undefined placeholder on every correctly-written loop template —
    // this mirrors the same before-the-flat-pass ordering lib/template.js's
    // expandLoops uses at render time, applied here for the same reason.
    const foundEachKeys = new Set();
    let match;
    EACH_BLOCK_RE.lastIndex = 0;
    let htmlWithoutLoopBodies = htmlContent;
    while ((match = EACH_BLOCK_RE.exec(htmlContent)) !== null) {
      foundEachKeys.add(match[1]);
    }
    htmlWithoutLoopBodies = htmlContent.replace(EACH_BLOCK_RE, '');

    const foundFlatKeys = new Set();
    PLACEHOLDER_RE.lastIndex = 0;
    while ((match = PLACEHOLDER_RE.exec(htmlWithoutLoopBodies)) !== null) {
      foundFlatKeys.add(match[1]);
    }
    const undefinedPlaceholders = [...foundFlatKeys].filter(k => !knownKeys.has(k));

    // v1.0.6: catch a flat {{key}} used against a field that's actually
    // array-shaped (or the reverse — {{#each key}} against a field that
    // isn't array-shaped) at SAVE time. Without this, either mistake fails
    // silently at render time: expandLoops() in lib/template.js just
    // renders an unknown/wrongly-shaped loop as empty rather than
    // throwing, so an admin who gets the syntax backwards would otherwise
    // only discover it by noticing a blank section on a live client
    // preview.
    const shapeWarnings = [];
    for (const k of foundFlatKeys) {
      if (arrayKeys.has(k)) {
        shapeWarnings.push(`"${k}" is a list field — use {{#each ${k}}}...{{/each}} instead of {{${k}}}`);
      }
    }
    for (const k of foundEachKeys) {
      if (flatKeys.has(k)) {
        shapeWarnings.push(`"${k}" is a single-value field, not a list — {{#each ${k}}} won't work, use {{${k}}} instead`);
      } else if (!knownKeys.has(k)) {
        shapeWarnings.push(`"${k}" (used in {{#each ${k}}}) is not a defined field or AI output`);
      }
    }

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
      undefinedPlaceholders,
      shapeWarnings
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
  const parsed = rollbackParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid website type id or version' });
  }
  const { id: websiteTypeId, version } = parsed.data;

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

// ---- AI config (v1.0.6) ----
//
// Off by default per website type (ai_enabled defaults false at the DB
// level). When on: a system prompt, a user-prompt template built from the
// type's own raw fields, and a set of output fields describing exactly
// what structured JSON to request from the configured AI provider. See
// routes/apiBuild.js for where all of this actually gets used.

const updateAiConfigSchema = z.object({
  aiEnabled: z.boolean().optional(),
  aiSystemPrompt: z.string().max(20000).optional(),
  aiUserPromptTemplate: z.string().max(20000).optional()
});

// object_shape only supports flat string sub-properties by design (see
// lib/template.js's expandLoops — {{this.sub_key}} has no nested-loop
// support, so there's no legitimate shape that would need anything richer
// than "every sub-key is a string"). Each value must be the literal string
// "string", matching the shape the admin UI and the AI-facing JSON schema
// both produce.
const objectShapeSchema = z.record(z.string().regex(OUTPUT_KEY_RE), z.literal('string'));

const createOutputFieldSchema = z
  .object({
    outputKey: z.string().regex(OUTPUT_KEY_RE, 'outputKey must match ^[a-z0-9_]+$'),
    outputType: z.enum(OUTPUT_TYPES).optional().default('string'),
    description: z.string().max(1000).optional().default(''),
    objectShape: objectShapeSchema.optional(),
    displayOrder: z.coerce.number().int().optional().default(0)
  })
  .refine(
    data => data.outputType !== 'array_of_objects' || (data.objectShape && Object.keys(data.objectShape).length > 0),
    { message: 'objectShape (at least one key) is required when outputType is "array_of_objects"' }
  );

const updateOutputFieldSchema = z.object({
  outputType: z.enum(OUTPUT_TYPES).optional(),
  description: z.string().max(1000).optional(),
  objectShape: objectShapeSchema.nullable().optional(),
  displayOrder: z.coerce.number().int().optional()
});

router.get('/:id/ai', async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const { id } = parsed.data;

  const pool = getPool();
  const typeResult = await pool.query(
    'SELECT ai_enabled, ai_system_prompt, ai_user_prompt_template FROM website_types WHERE id = $1',
    [id]
  );
  if (typeResult.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }

  const outputFieldsResult = await pool.query(
    'SELECT * FROM ai_output_fields WHERE website_type_id = $1 ORDER BY display_order ASC, id ASC',
    [id]
  );

  const t = typeResult.rows[0];
  res.json({
    aiEnabled: t.ai_enabled,
    aiSystemPrompt: t.ai_system_prompt,
    aiUserPromptTemplate: t.ai_user_prompt_template,
    outputFields: outputFieldsResult.rows.map(formatOutputField)
  });
});

router.put('/:id/ai', requireCsrf, async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const bodyParsed = updateAiConfigSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  const { id } = paramsParsed.data;
  const { aiEnabled, aiSystemPrompt, aiUserPromptTemplate } = bodyParsed.data;

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM website_types WHERE id = $1', [id]);
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }
  const current = existing.rows[0];

  const next = {
    ai_enabled: aiEnabled !== undefined ? aiEnabled : current.ai_enabled,
    ai_system_prompt: aiSystemPrompt !== undefined ? aiSystemPrompt : current.ai_system_prompt,
    ai_user_prompt_template: aiUserPromptTemplate !== undefined ? aiUserPromptTemplate : current.ai_user_prompt_template
  };

  const result = await pool.query(
    `UPDATE website_types SET ai_enabled = $1, ai_system_prompt = $2, ai_user_prompt_template = $3
     WHERE id = $4 RETURNING ai_enabled, ai_system_prompt, ai_user_prompt_template`,
    [next.ai_enabled, next.ai_system_prompt, next.ai_user_prompt_template, id]
  );
  const t = result.rows[0];
  res.json({
    aiEnabled: t.ai_enabled,
    aiSystemPrompt: t.ai_system_prompt,
    aiUserPromptTemplate: t.ai_user_prompt_template
  });
});

router.post('/:id/ai/output-fields', requireCsrf, async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const bodyParsed = createOutputFieldSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    const message = bodyParsed.error.issues[0] ? bodyParsed.error.issues[0].message : 'Invalid output field data';
    return res.status(400).json({ error: message });
  }
  const { id: websiteTypeId } = paramsParsed.data;
  const { outputKey, outputType, description, objectShape, displayOrder } = bodyParsed.data;

  const pool = getPool();
  const typeCheck = await pool.query('SELECT id FROM website_types WHERE id = $1', [websiteTypeId]);
  if (typeCheck.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }

  // Same symmetric namespace-collision check as POST /:id/fields above —
  // an output_key colliding with an existing raw field_key is ambiguous at
  // render time, so it's rejected here too.
  const fieldConflict = await pool.query(
    'SELECT id FROM template_fields WHERE website_type_id = $1 AND field_key = $2',
    [websiteTypeId, outputKey]
  );
  if (fieldConflict.rowCount > 0) {
    return res.status(409).json({ error: `outputKey "${outputKey}" collides with an existing raw field of the same key` });
  }

  const outputConflict = await pool.query(
    'SELECT id FROM ai_output_fields WHERE website_type_id = $1 AND output_key = $2',
    [websiteTypeId, outputKey]
  );
  if (outputConflict.rowCount > 0) {
    return res.status(409).json({ error: `outputKey "${outputKey}" already exists for this website type` });
  }

  const result = await pool.query(
    `INSERT INTO ai_output_fields (website_type_id, output_key, output_type, description, object_shape, display_order)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      websiteTypeId,
      outputKey,
      outputType,
      description || '',
      objectShape ? JSON.stringify(objectShape) : null,
      displayOrder
    ]
  );
  res.status(201).json(formatOutputField(result.rows[0]));
});

router.put('/:id/ai/output-fields/:fieldId', requireCsrf, async (req, res) => {
  const paramsParsed = fieldIdParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type or output field id' });
  }
  const bodyParsed = updateOutputFieldSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid output field data' });
  }
  const { id, fieldId } = paramsParsed.data;
  const { outputType, description, objectShape, displayOrder } = bodyParsed.data;

  const pool = getPool();
  const existing = await pool.query(
    'SELECT * FROM ai_output_fields WHERE id = $1 AND website_type_id = $2',
    [fieldId, id]
  );
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'Output field not found' });
  }
  const current = existing.rows[0];

  const nextType = outputType !== undefined ? outputType : current.output_type;
  const nextShape = objectShape !== undefined ? objectShape : current.object_shape;
  if (nextType === 'array_of_objects' && (!nextShape || Object.keys(nextShape).length === 0)) {
    return res.status(400).json({ error: 'objectShape (at least one key) is required when outputType is "array_of_objects"' });
  }

  const next = {
    output_type: nextType,
    description: description !== undefined ? description : current.description,
    object_shape: nextType === 'array_of_objects' ? JSON.stringify(nextShape) : null,
    display_order: displayOrder !== undefined ? displayOrder : current.display_order
  };

  const result = await pool.query(
    `UPDATE ai_output_fields SET output_type = $1, description = $2, object_shape = $3, display_order = $4
     WHERE id = $5 RETURNING *`,
    [next.output_type, next.description, next.object_shape, next.display_order, fieldId]
  );
  res.json(formatOutputField(result.rows[0]));
});

router.delete('/:id/ai/output-fields/:fieldId', requireCsrf, async (req, res) => {
  const parsed = fieldIdParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid website type or output field id' });
  }
  const { id, fieldId } = parsed.data;

  const pool = getPool();
  const result = await pool.query(
    'DELETE FROM ai_output_fields WHERE id = $1 AND website_type_id = $2 RETURNING id',
    [fieldId, id]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Output field not found' });
  }
  res.json({ success: true });
});

module.exports = router;
