// Hard cap on stored versions per versioned item (templates, emails,
// password page, legal pages, SEO page content, review reminder emails). Called INSIDE the same
// transaction that inserts the new version row, right after the insert, so
// the total never exceeds MAX_VERSIONS at commit time.

const MAX_VERSIONS = 4;

// Whitelist — table/column names are interpolated into SQL, so they are
// never taken from anywhere but this map.
const VERSIONED_TABLES = {
  templates: 'website_type_id',
  email_templates: 'website_type_id',
  review_reminder_templates: 'website_type_id',
  password_page_templates: 'website_type_id',
  legal_pages: 'page_key',
  seo_page_content: 'seo_page_id'
};

/**
 * Permanently deletes the oldest version rows for ONE item so at most
 * MAX_VERSIONS remain. Keeps the highest version numbers. The row just
 * inserted has the highest version, so it is always kept.
 *
 * @param {import('pg').PoolClient} client  client inside an open transaction
 * @param {string} table   one of VERSIONED_TABLES
 * @param {*} ownerValue   value of the owner column for the item being saved
 * @returns {Promise<number>} number of rows deleted
 */
async function pruneOldVersions(client, table, ownerValue) {
  const ownerColumn = VERSIONED_TABLES[table];
  if (!ownerColumn) {
    throw new Error(`pruneOldVersions: unsupported table "${table}"`);
  }
  const result = await client.query(
    `DELETE FROM ${table}
      WHERE id IN (
        SELECT id FROM ${table}
         WHERE ${ownerColumn} = $1
         ORDER BY version DESC, id DESC
        OFFSET $2
      )`,
    [ownerValue, MAX_VERSIONS]
  );
  return result.rowCount;
}

module.exports = { MAX_VERSIONS, pruneOldVersions };
