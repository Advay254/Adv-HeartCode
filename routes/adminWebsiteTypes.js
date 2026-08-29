const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { CATEGORY_ICON_NAMES, DEFAULT_ICON_NAME } = require('../lib/icons');
const { slugify } = require('../lib/slugify');
const { resolveDeploySlugPattern, extractFieldKeyReferences } = require('../lib/deploySlug');
const { PASSWORD_PAGE_PLACEHOLDERS } = require('../lib/passwordPageTemplates');

const router = express.Router();
router.use(requireAdminSession);

const FIELD_KEY_RE = /^[a-z0-9_]+$/;
const { VALID_FIELD_TYPES, OPTION_BASED_FIELD_TYPES } = require('../lib/fieldTypes');
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
  // v1.1.6 Part E: lowered from 2000 -> 140. Same card-layout-consistency
  // reasoning as routes/adminCategories.js's own createCategorySchema
  // (see that file's comment) -- a website type's description renders in
  // the exact same kind of fixed-size /explore card, now with the same
  // line-clamp-2 safety net for anything already saved longer than this.
  description: z.string().max(140).optional(),
  // v1.0.6: priceKes -> priceUsd. This is now the ONLY price field the
  // application reads or writes — website_types.price_kes is left in the
  // schema (unused) purely for backward compatibility with pre-1.0.6 rows.
  // Decimals now allowed (no .int()) since real USD prices have cents.
  priceUsd: z.coerce.number().min(0).optional(),
  slug: z.string().trim().max(100).optional(),
  // v1.0.7: validated against the exact curated set lib/icons.js bundles
  // as real SVG files — an arbitrary string here would just mean a card
  // silently falls back to the default icon at render time (getIconSvg
  // already guards for that), but rejecting it here means the admin finds
  // out immediately, at save time, rather than wondering later why their
  // custom icon name never showed up.
  iconName: z.enum(CATEGORY_ICON_NAMES).optional(),
  // v1.1.4 Part D: nullable FK to website_categories — omitted/null means
  // "uncategorized" (the type shows in /explore's "More Website Types"
  // fallback section). Existence is checked against the DB below, not
  // just shape here, since any positive integer is syntactically valid.
  categoryId: z.coerce.number().int().positive().nullable().optional()
});

const updateTypeSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  // v1.1.6 Part E: see createTypeSchema's comment above.
  description: z.string().max(140).optional(),
  isActive: z.boolean().optional(),
  priceUsd: z.coerce.number().min(0).optional(),
  displayOrder: z.coerce.number().int().optional(),
  iconName: z.enum(CATEGORY_ICON_NAMES).optional(),
  // v1.0.8 Part B. Follows the same convention already established for
  // admin config secrets (see HANDOFF.md): omitted = don't change,
  // empty string = clear it (stored as NULL, reverting to today's random
  // slug behavior), non-empty string = set/replace the pattern.
  deploySlugPattern: z.string().max(500).optional(),
  // v1.1.2 Part A: per-type SEO overrides. Same "omitted = don't change,
  // '' = clear back to the global site_settings fallback" convention —
  // see routes/public.js's GET /build/:slug for where the fallback
  // actually happens. Length caps loosely follow common on-page SEO
  // guidance (a title well past ~60-70 characters just gets truncated in
  // search results, a description past ~160 similarly) without hard-
  // enforcing those exact numbers — an admin who wants to type something
  // longer isn't blocked, just past the point where it stops helping.
  seoTitle: z.string().max(200).optional(),
  seoDescription: z.string().max(500).optional(),
  // v1.1.4 Part D: same "omitted = don't change" convention as everything
  // else in this schema. null (or 0) explicitly clears back to
  // uncategorized — a plain omitted field can't distinguish "don't
  // change" from "clear it" the way null can, so this is the one field
  // in this schema where null is a meaningful, distinct third state from
  // both "omitted" and "a real id".
  categoryId: z.coerce.number().int().positive().nullable().optional()
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
  // v1.1.4 Part A: field_key is now editable in-place (previously the
  // only way to fix a typo'd key was delete-and-recreate, which lost the
  // field's position and any existing template/AI-prompt/email reference
  // to it anyway). Renaming a key here does NOT rewrite any {{old_key}}
  // reference already saved in a template/AI prompt/email body — those
  // still literally say {{old_key}}, which will simply stop resolving to
  // anything once the key changes. The admin UI warns about this clearly
  // at save time when fieldKey is actually changing (not on every save);
  // this route itself doesn't attempt to be "smart" about it beyond that
  // — no rewriting of other tables' content, by design (out of scope, and
  // a surprising thing for an edit endpoint to silently do to unrelated
  // content).
  fieldKey: z.string().regex(FIELD_KEY_RE, 'fieldKey must match ^[a-z0-9_]+$').optional(),
  fieldLabel: z.string().trim().min(1).max(200).optional(),
  fieldType: z.enum(VALID_FIELD_TYPES).optional(),
  placeholderText: z.string().max(500).optional(),
  isRequired: z.boolean().optional(),
  dropdownOptions: z.array(z.string().max(200)).max(100).optional(),
  displayOrder: z.coerce.number().int().optional()
});

// v1.1.4 Part A: accepts every field id for a website type, in the exact
// order they should now display in — the whole set must be present
// exactly once (checked below), not a partial reorder, so display_order
// values across the type's fields can never end up with gaps or
// duplicates from a partial/stale client-side list.
const reorderFieldsSchema = z.object({
  fieldIds: z.array(z.coerce.number().int().positive()).min(1)
});

// v1.1.4 Part B: raised from 500,000 chars (~500KB) to 5,000,000
// (~5MB) — the actual root cause of the "large template silently fails
// to save" bug was server.js's express.json() body-size limit (100kb,
// Express's own default), not this zod cap; that limit is now raised to
// 10mb for this route (see server.js's adminJsonBodyParser). But leaving
// THIS cap at its old 500,000-char value would have just moved the same
// silent-failure-shaped problem one layer up for any template between
// ~500KB and 10MB, undoing the point of raising the body limit at all —
// so this is raised proportionally, with headroom under the 10mb JSON
// body ceiling for the surrounding request's JSON overhead.
const templateSchema = z.object({
  htmlContent: z.string().min(1).max(5000000)
});

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

router.get('/', asyncHandler(async (req, res) => {
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
      iconName: t.icon_name,
      fieldCount: Number(fieldCount.rows[0].count),
      activeTemplateVersion: activeTemplate.rowCount > 0 ? activeTemplate.rows[0].version : null,
      categoryId: t.category_id,
      createdAt: t.created_at,
      updatedAt: t.updated_at
    });
  }

  res.json(results);
}));

router.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = createTypeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'name is required' });
  }
  const { name, description, priceUsd, slug: providedSlug, iconName, categoryId } = parsed.data;

  const baseSlug = slugify(providedSlug || name);
  if (!baseSlug) {
    return res.status(400).json({ error: 'Could not derive a valid slug from name' });
  }

  const pool = getPool();
  const conflict = await pool.query('SELECT id FROM website_types WHERE slug = $1', [baseSlug]);
  if (conflict.rowCount > 0) {
    return res.status(409).json({ error: `slug "${baseSlug}" is already in use`, conflictField: 'slug' });
  }

  if (categoryId) {
    const categoryCheck = await pool.query('SELECT id FROM website_categories WHERE id = $1', [categoryId]);
    if (categoryCheck.rowCount === 0) {
      return res.status(400).json({ error: 'That category does not exist' });
    }
  }

  const price = typeof priceUsd === 'number' && priceUsd >= 0 ? priceUsd : 0;

  const result = await pool.query(
    `INSERT INTO website_types (slug, name, description, price_usd, icon_name, category_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [baseSlug, name, description || '', price, iconName || DEFAULT_ICON_NAME, categoryId || null]
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
    iconName: t.icon_name,
    categoryId: t.category_id,
    fieldCount: 0,
    activeTemplateVersion: null
  });
}));

router.put('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const bodyParsed = updateTypeSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  const { id } = paramsParsed.data;
  const { name, description, isActive, priceUsd, displayOrder, iconName, deploySlugPattern, seoTitle, seoDescription, categoryId } = bodyParsed.data;

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM website_types WHERE id = $1', [id]);
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'Website type not found' });
  }
  const current = existing.rows[0];

  // v1.1.4 Part D: null (explicitly sent) clears back to uncategorized;
  // omitted leaves it unchanged; a real id sets/replaces it. Existence is
  // checked against the DB, not just the schema's positive-int shape.
  if (categoryId) {
    const categoryCheck = await pool.query('SELECT id FROM website_categories WHERE id = $1', [categoryId]);
    if (categoryCheck.rowCount === 0) {
      return res.status(400).json({ error: 'That category does not exist' });
    }
  }

  const next = {
    name: name !== undefined ? name : current.name,
    description: description !== undefined ? description : current.description,
    is_active: isActive !== undefined ? isActive : current.is_active,
    price_usd: priceUsd !== undefined ? priceUsd : current.price_usd,
    display_order: displayOrder !== undefined ? displayOrder : current.display_order,
    icon_name: iconName !== undefined ? iconName : current.icon_name,
    // '' clears to NULL (today's random-slug behavior); omitted leaves it
    // unchanged; a non-empty string sets/replaces it.
    deploy_slug_pattern: deploySlugPattern !== undefined
      ? (deploySlugPattern === '' ? null : deploySlugPattern)
      : current.deploy_slug_pattern,
    // Same '' clears / omitted keeps convention — clearing means "fall
    // back to the global site_settings title/description again."
    seo_title: seoTitle !== undefined ? (seoTitle === '' ? null : seoTitle) : current.seo_title,
    seo_description: seoDescription !== undefined ? (seoDescription === '' ? null : seoDescription) : current.seo_description,
    category_id: categoryId !== undefined ? categoryId : current.category_id
  };

  const result = await pool.query(
    `UPDATE website_types SET name = $1, description = $2, is_active = $3,
       price_usd = $4, display_order = $5, icon_name = $6, deploy_slug_pattern = $7,
       seo_title = $8, seo_description = $9, category_id = $10, updated_at = NOW()
     WHERE id = $11 RETURNING *`,
    [next.name, next.description, next.is_active, next.price_usd, next.display_order, next.icon_name,
      next.deploy_slug_pattern, next.seo_title, next.seo_description, next.category_id, id]
  );
  const t = result.rows[0];

  // v1.0.8 Part B: warn (don't block — same "warn, don't block" pattern
  // as the template placeholder/shape validation in PUT /:id/template)
  // if the pattern references a field_key that doesn't exist for this
  // website type. Checked AFTER saving, same as the template validation
  // — the admin may be about to add the field next, and a slug pattern
  // referencing a not-yet-created field is far more likely to be "field
  // coming later" than "typo," given fields and the pattern are usually
  // set up in the same sitting.
  let deploySlugWarnings = [];
  if (next.deploy_slug_pattern) {
    const referencedKeys = extractFieldKeyReferences(next.deploy_slug_pattern);
    if (referencedKeys.length > 0) {
      const fieldsResult = await pool.query(
        'SELECT field_key FROM template_fields WHERE website_type_id = $1',
        [id]
      );
      const knownKeys = new Set(fieldsResult.rows.map(f => f.field_key));
      deploySlugWarnings = referencedKeys
        .filter(k => !knownKeys.has(k))
        .map(k => `"${k}" is not a defined field for this website type — it will resolve to empty in the deploy slug until you add it`);
    }
  }

  res.json({
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    isActive: t.is_active,
    displayOrder: t.display_order,
    priceUsd: Number(t.price_usd) || 0,
    aiEnabled: t.ai_enabled,
    iconName: t.icon_name,
    deploySlugPattern: t.deploy_slug_pattern,
    deploySlugWarnings,
    seoTitle: t.seo_title,
    seoDescription: t.seo_description,
    categoryId: t.category_id
  });
}));

router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
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
}));

// ---- fields ----

router.get('/:id/fields', asyncHandler(async (req, res) => {
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
}));

router.post('/:id/fields', requireCsrf, asyncHandler(async (req, res) => {
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

  if (OPTION_BASED_FIELD_TYPES.includes(fieldType) && !Array.isArray(dropdownOptions)) {
    return res.status(400).json({ error: `dropdownOptions must be an array when fieldType is "${fieldType}"` });
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
      OPTION_BASED_FIELD_TYPES.includes(fieldType) ? JSON.stringify(dropdownOptions) : null,
      displayOrder
    ]
  );
  res.status(201).json(formatField(result.rows[0]));
}));

// v1.1.4 Part A: registered BEFORE PUT /:id/fields/:fieldId deliberately —
// Express matches routes in registration order, and a plain `:fieldId`
// param matches ANY path segment (including the literal string
// "reorder"), so if the reorder route were registered after the
// generic-fieldId one, a request to PUT /:id/fields/reorder would be
// swallowed by that earlier route with `:fieldId` bound to "reorder"
// instead. Caught by actually testing this route with curl against a
// real running server, not just by reasoning about it — the first
// version of this endpoint (with routes in the other order) returned
// a fieldId-not-found-shaped error instead of ever running this handler.
router.put('/:id/fields/reorder', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const bodyParsed = reorderFieldsSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'fieldIds must be a non-empty array of field ids' });
  }
  const { id: websiteTypeId } = paramsParsed.data;
  const { fieldIds } = bodyParsed.data;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query(
      'SELECT id FROM template_fields WHERE website_type_id = $1 FOR UPDATE',
      [websiteTypeId]
    );
    const existingIds = new Set(existing.rows.map(r => r.id));
    const providedIds = new Set(fieldIds);

    // The full set must match exactly — every existing field present
    // exactly once, nothing extra, nothing missing. A partial or stale
    // list (e.g. from a client that loaded the fields list, then another
    // browser tab added/removed a field before this request landed) is
    // rejected outright rather than silently reassigning display_order
    // to only some of the type's fields.
    const isExactMatch = existingIds.size === fieldIds.length
      && fieldIds.length === providedIds.size
      && [...existingIds].every(existingId => providedIds.has(existingId));

    if (!isExactMatch) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'fieldIds must include every field for this website type exactly once' });
    }

    for (let i = 0; i < fieldIds.length; i++) {
      await client.query(
        'UPDATE template_fields SET display_order = $1 WHERE id = $2 AND website_type_id = $3',
        [i, fieldIds[i], websiteTypeId]
      );
    }

    await client.query('COMMIT');

    const result = await pool.query(
      'SELECT * FROM template_fields WHERE website_type_id = $1 ORDER BY display_order ASC, id ASC',
      [websiteTypeId]
    );
    res.json(result.rows.map(formatField));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[FIELDS] Failed to reorder fields:', err.message);
    res.status(500).json({ error: 'Failed to reorder fields' });
  } finally {
    client.release();
  }
}));

router.put('/:id/fields/:fieldId', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = fieldIdParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type or field id' });
  }
  const bodyParsed = updateFieldSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid field data' });
  }
  const { id, fieldId } = paramsParsed.data;
  const { fieldKey, fieldLabel, fieldType, placeholderText, isRequired, dropdownOptions, displayOrder } = bodyParsed.data;

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
  if (OPTION_BASED_FIELD_TYPES.includes(nextType) && dropdownOptions !== undefined && !Array.isArray(dropdownOptions)) {
    return res.status(400).json({ error: `dropdownOptions must be an array when fieldType is "${nextType}"` });
  }

  // v1.1.4 Part A: same symmetric collision checks POST /:id/fields
  // already runs at creation time — only actually run here when fieldKey
  // is both provided AND actually different from the current value, so a
  // save that doesn't touch the key never pays for these two extra
  // queries.
  const nextKey = fieldKey !== undefined ? fieldKey : current.field_key;
  if (nextKey !== current.field_key) {
    const conflict = await pool.query(
      'SELECT id FROM template_fields WHERE website_type_id = $1 AND field_key = $2 AND id != $3',
      [id, nextKey, fieldId]
    );
    if (conflict.rowCount > 0) {
      return res.status(409).json({ error: `fieldKey "${nextKey}" already exists for this website type` });
    }
    const aiConflict = await pool.query(
      'SELECT id FROM ai_output_fields WHERE website_type_id = $1 AND output_key = $2',
      [id, nextKey]
    );
    if (aiConflict.rowCount > 0) {
      return res.status(409).json({ error: `fieldKey "${nextKey}" collides with an existing AI output field of the same key` });
    }
  }

  const next = {
    field_key: nextKey,
    field_label: fieldLabel !== undefined ? fieldLabel : current.field_label,
    field_type: nextType,
    placeholder_text: placeholderText !== undefined ? placeholderText : current.placeholder_text,
    is_required: isRequired !== undefined ? isRequired : current.is_required,
    dropdown_options: OPTION_BASED_FIELD_TYPES.includes(nextType)
      ? JSON.stringify(dropdownOptions !== undefined ? dropdownOptions : current.dropdown_options)
      : null,
    display_order: displayOrder !== undefined ? displayOrder : current.display_order
  };

  const result = await pool.query(
    `UPDATE template_fields SET field_key = $1, field_label = $2, field_type = $3, placeholder_text = $4,
       is_required = $5, dropdown_options = $6, display_order = $7
     WHERE id = $8 RETURNING *`,
    [next.field_key, next.field_label, next.field_type, next.placeholder_text, next.is_required, next.dropdown_options, next.display_order, fieldId]
  );
  res.json({ ...formatField(result.rows[0]), keyChanged: nextKey !== current.field_key, oldFieldKey: current.field_key });
}));

router.delete('/:id/fields/:fieldId', requireCsrf, asyncHandler(async (req, res) => {
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
}));

// ---- templates ----

router.get('/:id/template', asyncHandler(async (req, res) => {
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
}));

router.put('/:id/template', requireCsrf, asyncHandler(async (req, res) => {
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
    // v1.0.9 bug fix: this used to select field_key only, so a raw
    // "checkboxes" field (array-shaped, submitted as multiple selections —
    // see lib/fieldTypes.js and apiBuild.js's rawArrayValues) could never
    // be recognized as array-shaped here. The shape-mismatch check below
    // would then wrongly warn that a perfectly correct
    // {{#each some_checkboxes_field}} "won't work" on a field where it's
    // actually the loop syntax that's needed to render every selected
    // option (a flat {{some_checkboxes_field}} still "works" too, just as
    // a comma-joined string — the warning wasn't just noisy, it steered an
    // admin toward the wrong syntax for what they were trying to do).
    // AI output fields already got this right (see the object_shape
    // handling just below); this brings raw fields in line with the same
    // shape-awareness.
    const fieldsResult = await client.query(
      'SELECT field_key, field_type FROM template_fields WHERE website_type_id = $1',
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

    const flatKeys = new Set();
    const arrayKeys = new Set();
    for (const f of fieldsResult.rows) {
      if (f.field_type === 'checkboxes') arrayKeys.add(f.field_key);
      else flatKeys.add(f.field_key);
    }
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
}));

router.post('/:id/template/rollback/:version', requireCsrf, asyncHandler(async (req, res) => {
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
}));

// ---- email templates (v1.0.9 Part A) ----
//
// Same versioning discipline as ---- template (site) ---- above: PUT
// inserts a new version and deactivates the previous active one, rollback
// is a pointer-flip, nothing is ever deleted. A type with no row here at
// all uses the original hardcoded generic email — see
// lib/finalizeDeployment.js and lib/emailTemplates.js.

// Reserved variable names always available to an email template, on top of
// this type's own raw fields / AI output fields — see
// lib/emailTemplates.js's SYSTEM_EMAIL_VARIABLES (kept in sync manually;
// this file doesn't import from lib/emailTemplates.js purely to avoid a
// route file depending on a lib whose only other consumer is the finalize
// pipeline, not because the list is expected to diverge).
const SYSTEM_EMAIL_VARIABLES = ['site_url', 'client_email', 'website_type_name', 'deployed_at', 'site_password'];

// v1.1.4 Part B: same reasoning and same raise (500,000 -> 5,000,000
// chars) as templateSchema's htmlContent above — the Email tab's HTML
// body hits the exact same "large paste silently fails" shape of bug.
const emailTemplateSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  htmlBody: z.string().min(1).max(5000000)
});

router.get('/:id/email-template', asyncHandler(async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const { id } = parsed.data;

  const pool = getPool();
  const active = await pool.query(
    'SELECT * FROM email_templates WHERE website_type_id = $1 AND is_active = true LIMIT 1',
    [id]
  );
  const history = await pool.query(
    'SELECT version, created_at FROM email_templates WHERE website_type_id = $1 ORDER BY version DESC LIMIT 5',
    [id]
  );

  res.json({
    active: active.rowCount > 0
      ? { subject: active.rows[0].subject, htmlBody: active.rows[0].html_body, version: active.rows[0].version }
      : null,
    history: history.rows.map(h => ({ version: h.version, createdAt: h.created_at }))
  });
}));

router.put('/:id/email-template', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const bodyParsed = emailTemplateSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    const message = bodyParsed.error.issues[0] ? bodyParsed.error.issues[0].message : 'subject and htmlBody are required';
    return res.status(400).json({ error: message });
  }
  const { id: websiteTypeId } = paramsParsed.data;
  const { subject, htmlBody } = bodyParsed.data;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const typeCheck = await client.query('SELECT id FROM website_types WHERE id = $1 FOR UPDATE', [websiteTypeId]);
    if (typeCheck.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Website type not found' });
    }

    const fieldsResult = await client.query(
      'SELECT field_key, field_type FROM template_fields WHERE website_type_id = $1',
      [websiteTypeId]
    );
    const outputFieldsResult = await client.query(
      'SELECT output_key, output_type FROM ai_output_fields WHERE website_type_id = $1',
      [websiteTypeId]
    );

    const flatKeys = new Set(SYSTEM_EMAIL_VARIABLES);
    const arrayKeys = new Set();
    for (const f of fieldsResult.rows) {
      if (f.field_type === 'checkboxes') arrayKeys.add(f.field_key);
      else flatKeys.add(f.field_key);
    }
    for (const f of outputFieldsResult.rows) {
      if (f.output_type === 'string') flatKeys.add(f.output_key);
      else arrayKeys.add(f.output_key);
    }
    const knownKeys = new Set([...flatKeys, ...arrayKeys]);

    // Loop scan on htmlBody only — {{#each}} has no effect in the
    // plain-text subject line (lib/emailTemplates.js's renderEmailContent
    // substitutes the subject via substitutePlainText, the same
    // loop-free engine used for AI prompts). A subject containing
    // {{#each ...}} isn't specially warned about here; it just won't
    // expand, same as any other engine limitation the admin UI documents
    // as copy rather than a save-time error.
    const foundEachKeys = new Set();
    let match;
    EACH_BLOCK_RE.lastIndex = 0;
    while ((match = EACH_BLOCK_RE.exec(htmlBody)) !== null) {
      foundEachKeys.add(match[1]);
    }
    const htmlBodyWithoutLoopBodies = htmlBody.replace(EACH_BLOCK_RE, '');

    const foundFlatKeys = new Set();
    PLACEHOLDER_RE.lastIndex = 0;
    while ((match = PLACEHOLDER_RE.exec(htmlBodyWithoutLoopBodies)) !== null) {
      foundFlatKeys.add(match[1]);
    }
    PLACEHOLDER_RE.lastIndex = 0;
    while ((match = PLACEHOLDER_RE.exec(subject)) !== null) {
      foundFlatKeys.add(match[1]);
    }
    const undefinedPlaceholders = [...foundFlatKeys].filter(k => !knownKeys.has(k));

    const shapeWarnings = [];
    for (const k of foundFlatKeys) {
      if (arrayKeys.has(k)) {
        shapeWarnings.push(`"${k}" is a list field — use {{#each ${k}}}...{{/each}} in the HTML body instead of {{${k}}}`);
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
      'SELECT COALESCE(MAX(version), 0) AS max_version FROM email_templates WHERE website_type_id = $1',
      [websiteTypeId]
    );
    const nextVersion = Number(maxVersionResult.rows[0].max_version) + 1;

    await client.query(
      'UPDATE email_templates SET is_active = false WHERE website_type_id = $1 AND is_active = true',
      [websiteTypeId]
    );

    const inserted = await client.query(
      `INSERT INTO email_templates (website_type_id, subject, html_body, version, is_active)
       VALUES ($1, $2, $3, $4, true) RETURNING *`,
      [websiteTypeId, subject, htmlBody, nextVersion]
    );

    await client.query('COMMIT');

    res.json({
      version: inserted.rows[0].version,
      undefinedPlaceholders,
      shapeWarnings
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[EMAIL TEMPLATE] Failed to save email template:', err.message);
    res.status(500).json({ error: 'Failed to save email template' });
  } finally {
    client.release();
  }
}));

router.post('/:id/email-template/rollback/:version', requireCsrf, asyncHandler(async (req, res) => {
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
      'SELECT id FROM email_templates WHERE website_type_id = $1 AND version = $2 FOR UPDATE',
      [websiteTypeId, version]
    );
    if (target.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That email template version does not exist' });
    }

    await client.query(
      'UPDATE email_templates SET is_active = false WHERE website_type_id = $1 AND is_active = true',
      [websiteTypeId]
    );
    await client.query('UPDATE email_templates SET is_active = true WHERE id = $1', [target.rows[0].id]);

    await client.query('COMMIT');
    res.json({ success: true, activeVersion: version });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[EMAIL TEMPLATE] Failed to rollback email template:', err.message);
    res.status(500).json({ error: 'Failed to rollback email template' });
  } finally {
    client.release();
  }
}));

// ---- password page templates (v1.1.4 Part C) ----
//
// Same versioning discipline as ---- template (site) ---- and
// ---- email templates ---- above: PUT inserts a new version and
// deactivates the previous active one, rollback is a pointer-flip,
// nothing is ever deleted. A type with no row here at all uses the
// original hardcoded generic password gate — see
// lib/passwordPageTemplates.js and lib/finalizeDeployment.js.
//
// Deliberately validated against PASSWORD_PAGE_PLACEHOLDERS only (NOT
// this type's raw fields / AI output fields, unlike the Template/Email
// validation above) — this page renders before any site content is
// unlocked, so it never has access to that data in the first place.

const passwordPageSchema = z.object({
  // Same 5,000,000-char ceiling as templateSchema/emailTemplateSchema
  // above, for the same Part B reason — a large hand-designed password
  // page is the same shape of "big HTML paste" as the Template/Email
  // tabs, so it gets the same generous cap.
  htmlContent: z.string().min(1).max(5000000)
});

router.get('/:id/password-page', asyncHandler(async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const { id } = parsed.data;

  const pool = getPool();
  const active = await pool.query(
    'SELECT * FROM password_page_templates WHERE website_type_id = $1 AND is_active = true LIMIT 1',
    [id]
  );
  const history = await pool.query(
    'SELECT version, created_at FROM password_page_templates WHERE website_type_id = $1 ORDER BY version DESC LIMIT 5',
    [id]
  );

  res.json({
    active: active.rowCount > 0
      ? { htmlContent: active.rows[0].html_content, version: active.rows[0].version }
      : null,
    history: history.rows.map(h => ({ version: h.version, createdAt: h.created_at }))
  });
}));

router.put('/:id/password-page', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid website type id' });
  }
  const bodyParsed = passwordPageSchema.safeParse(req.body);
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

    // Warn, don't block — same posture as the Template/Email tabs. Only
    // the two fixed tokens are ever "known" here; a stray {{some_field}}
    // typo (e.g. an admin muscle-memory-typing a real field's key,
    // forgetting this page doesn't have access to those) is flagged so
    // it doesn't silently render as literal, un-substituted text on a
    // live deployed site.
    const foundKeys = new Set();
    PLACEHOLDER_RE.lastIndex = 0;
    let match;
    while ((match = PLACEHOLDER_RE.exec(htmlContent)) !== null) {
      foundKeys.add(match[1]);
    }
    const undefinedPlaceholders = [...foundKeys].filter(k => !PASSWORD_PAGE_PLACEHOLDERS.includes(k));

    const missingFunctionalToken = !foundKeys.has('password_input_and_button');

    const maxVersionResult = await client.query(
      'SELECT COALESCE(MAX(version), 0) AS max_version FROM password_page_templates WHERE website_type_id = $1',
      [websiteTypeId]
    );
    const nextVersion = Number(maxVersionResult.rows[0].max_version) + 1;

    await client.query(
      'UPDATE password_page_templates SET is_active = false WHERE website_type_id = $1 AND is_active = true',
      [websiteTypeId]
    );

    const inserted = await client.query(
      `INSERT INTO password_page_templates (website_type_id, html_content, version, is_active)
       VALUES ($1, $2, $3, true) RETURNING *`,
      [websiteTypeId, htmlContent, nextVersion]
    );

    await client.query('COMMIT');

    res.json({
      version: inserted.rows[0].version,
      undefinedPlaceholders,
      // Genuinely worth blocking-adjacent (a strong warning, not a hard
      // block — the admin may still be mid-edit and about to add it) —
      // a saved password page missing this token entirely deploys with
      // no way for a visitor to actually type a password in, which is a
      // real functional break, not just a cosmetic placeholder typo.
      missingFunctionalToken
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PASSWORD PAGE] Failed to save password page template:', err.message);
    res.status(500).json({ error: 'Failed to save password page template' });
  } finally {
    client.release();
  }
}));

router.post('/:id/password-page/rollback/:version', requireCsrf, asyncHandler(async (req, res) => {
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
      'SELECT id FROM password_page_templates WHERE website_type_id = $1 AND version = $2 FOR UPDATE',
      [websiteTypeId, version]
    );
    if (target.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That password page version does not exist' });
    }

    await client.query(
      'UPDATE password_page_templates SET is_active = false WHERE website_type_id = $1 AND is_active = true',
      [websiteTypeId]
    );
    await client.query('UPDATE password_page_templates SET is_active = true WHERE id = $1', [target.rows[0].id]);

    await client.query('COMMIT');
    res.json({ success: true, activeVersion: version });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[PASSWORD PAGE] Failed to rollback password page template:', err.message);
    res.status(500).json({ error: 'Failed to rollback password page template' });
  } finally {
    client.release();
  }
}));

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

router.get('/:id/ai', asyncHandler(async (req, res) => {
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
}));

router.put('/:id/ai', requireCsrf, asyncHandler(async (req, res) => {
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
}));

router.post('/:id/ai/output-fields', requireCsrf, asyncHandler(async (req, res) => {
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
}));

router.put('/:id/ai/output-fields/:fieldId', requireCsrf, asyncHandler(async (req, res) => {
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
}));

router.delete('/:id/ai/output-fields/:fieldId', requireCsrf, asyncHandler(async (req, res) => {
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
}));

module.exports = router;
