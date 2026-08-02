const { getPool } = require('../db/init');
const { decrypt } = require('./crypto');

/**
 * Returns { baseUrl, selectedModel, keys } for the currently active AI
 * provider, with keys decrypted and ordered by priority (lowest first —
 * tried first), or null if no provider is active / no keys decrypt
 * successfully. This version never calls the chat/completions endpoint —
 * config and model-listing only, for later versions to build on.
 */
async function getActiveProviderConfig() {
  const pool = getPool();
  const providerResult = await pool.query('SELECT * FROM ai_providers WHERE is_active = true LIMIT 1');
  if (providerResult.rowCount === 0) return null;

  const provider = providerResult.rows[0];
  const keysResult = await pool.query(
    'SELECT * FROM ai_provider_keys WHERE provider_id = $1 ORDER BY priority ASC',
    [provider.id]
  );

  const keys = [];
  for (const row of keysResult.rows) {
    try {
      keys.push(decrypt(row.key_encrypted));
    } catch (err) {
      console.error(`[AI-PROVIDER] Failed to decrypt key #${row.id}:`, err.message);
    }
  }

  if (keys.length === 0) return null;

  return {
    baseUrl: provider.base_url,
    selectedModel: provider.selected_model,
    keys
  };
}

module.exports = { getActiveProviderConfig };
