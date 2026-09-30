'use strict';

/**
 * v1.2.9: website type deletion + deployment-history anonymization.
 *
 * "Deleting" a website type wipes its identity everywhere (the type row,
 * fields, template versions, email/password-page templates, AI output
 * fields, SEO pages aimed at it, and every name snapshot in the activity
 * log) while keeping deployment history and revenue truthful: every real
 * deployment is re-pointed at ONE shared, permanent placeholder website
 * type called "Deleted Website Types". Existing per-type grouping queries
 * then sum all deleted types together as a single row with no changes to
 * their grouping logic.
 *
 * The placeholder is a real website_types row (deployed_sites.website_type_id
 * is a foreign key to that table) flagged is_deleted_placeholder = true. It
 * is always inactive, hidden from the types list / dropdowns / public site,
 * and can never be edited or deleted.
 */

const crypto = require('crypto');

const PLACEHOLDER_NAME = 'Deleted Website Types';
const PLACEHOLDER_SLUG = 'deleted-website-types';
// Sorts last in any display_order-ordered list (INTEGER max).
const PLACEHOLDER_DISPLAY_ORDER = 2147483647;

class DeleteBlockedError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getOrCreatePlaceholder(client) {
  const existing = await client.query(
    'SELECT id FROM website_types WHERE is_deleted_placeholder = true LIMIT 1'
  );
  if (existing.rowCount > 0) return existing.rows[0].id;

  // A real type could (very unlikely) already own the preferred slug.
  const slugTaken = await client.query('SELECT 1 FROM website_types WHERE slug = $1', [PLACEHOLDER_SLUG]);
  const slug = slugTaken.rowCount > 0
    ? `${PLACEHOLDER_SLUG}-${crypto.randomBytes(3).toString('hex')}`
    : PLACEHOLDER_SLUG;

  // ON DELETE-free conflict handling: if two first-ever deletes race, the
  // partial unique index on is_deleted_placeholder makes the loser's INSERT
  // a no-op, and the re-select below picks up the winner's row.
  await client.query(
    `INSERT INTO website_types (slug, name, description, is_active, display_order, price_usd, is_deleted_placeholder)
     VALUES ($1, $2, '', false, $3, 0, true)
     ON CONFLICT DO NOTHING`,
    [slug, PLACEHOLDER_NAME, PLACEHOLDER_DISPLAY_ORDER]
  );
  const created = await client.query(
    'SELECT id FROM website_types WHERE is_deleted_placeholder = true LIMIT 1'
  );
  return created.rows[0].id;
}

/**
 * Deletes one inactive website type atomically. Returns
 * { placeholderId, removedSeoPageSlugs }. Throws DeleteBlockedError for
 * 404 / placeholder / still-active cases; any other error rolls back and
 * propagates.
 */
async function deleteWebsiteType(pool, typeId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const typeResult = await client.query(
      'SELECT id, is_active, is_deleted_placeholder FROM website_types WHERE id = $1 FOR UPDATE',
      [typeId]
    );
    if (typeResult.rowCount === 0) throw new DeleteBlockedError(404, 'Website type not found');
    const type = typeResult.rows[0];
    if (type.is_deleted_placeholder) {
      throw new DeleteBlockedError(400, 'This is the shared placeholder for deleted website types and cannot be deleted.');
    }
    if (type.is_active) {
      throw new DeleteBlockedError(409, 'Deactivate this website type before deleting it.');
    }

    const placeholderId = await getOrCreatePlaceholder(client);

    // 1. Test deployments have no business value once their type is gone
    //    (and their activity entries would name the type).
    await client.query(
      `DELETE FROM activity_events
       WHERE event_type = 'test_deployment_completed' AND metadata->>'websiteTypeId' = $1`,
      [String(typeId)]
    );
    await client.query('DELETE FROM deployed_sites WHERE website_type_id = $1 AND is_test = true', [typeId]);

    // 2. Re-point real history at the shared placeholder. Live sites, money,
    //    dates and references are untouched; only the link to the type's
    //    identity changes.
    await client.query('UPDATE deployed_sites SET website_type_id = $1 WHERE website_type_id = $2', [placeholderId, typeId]);
    // In-flight checkouts: a customer who already paid (or is about to) must
    // still get their site; the stored rendered_html is self-contained.
    await client.query('UPDATE pending_deployments SET website_type_id = $1 WHERE website_type_id = $2', [placeholderId, typeId]);
    // Anonymous funnel counts stay in the totals under the placeholder.
    await client.query('UPDATE funnel_events SET website_type_id = $1 WHERE website_type_id = $2', [placeholderId, typeId]);

    // 3. Overwrite every name snapshot in the activity log (a display-time
    //    relabel would leave the old name sitting in the database).
    await client.query(
      `UPDATE activity_events
       SET title = CASE event_type
             WHEN 'deployment_completed' THEN $1::text || ' site deployed'
             WHEN 'recovery_completed' THEN 'Recovered: ' || $1::text || ' site'
             ELSE title
           END,
           metadata = jsonb_set(jsonb_set(metadata, '{websiteTypeId}', to_jsonb($2::int)),
                                '{websiteTypeName}', to_jsonb($1::text))
       WHERE metadata->>'websiteTypeId' = $3`,
      [PLACEHOLDER_NAME, placeholderId, String(typeId)]
    );

    // 4. SEO pages aimed at this type (their content versions cascade).
    //    Their per-page landing_sections rows (legacy design) go too.
    const seoPages = await client.query(
      'DELETE FROM seo_pages WHERE target_website_type_id = $1 RETURNING slug',
      [typeId]
    );
    const removedSeoPageSlugs = seoPages.rows.map(r => r.slug);
    if (removedSeoPageSlugs.length > 0) {
      await client.query(
        `DELETE FROM landing_sections WHERE page_slug = ANY($1) AND page_slug <> 'home'`,
        [removedSeoPageSlugs]
      );
    }

    // 4b. Anything else that still points at the type by id and exists only
    //     because of it is removed by ON DELETE CASCADE: template_fields,
    //     templates (all versions), ai_output_fields, email_templates,
    //     password_page_templates.
    await client.query('DELETE FROM website_types WHERE id = $1', [typeId]);

    await client.query('COMMIT');
    return { placeholderId, removedSeoPageSlugs };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection may already be gone */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { PLACEHOLDER_NAME, PLACEHOLDER_SLUG, DeleteBlockedError, getOrCreatePlaceholder, deleteWebsiteType };
