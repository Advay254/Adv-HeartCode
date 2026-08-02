const express = require('express');
const { getPool } = require('../db/init');
const { encrypt, decrypt, maskSecret } = require('../lib/crypto');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');

const router = express.Router();
router.use(requireAdminSession);

function maskKeyRow(row) {
  try {
    return {
      id: row.id,
      priority: row.priority,
      masked: maskSecret(decrypt(row.key_encrypted)),
      createdAt: row.created_at
    };
  } catch (err) {
    return { id: row.id, priority: row.priority, masked: null, createdAt: row.created_at };
  }
}

function serializeProvider(row, keys) {
  return {
    id: row.id,
    label: row.label,
    baseUrl: row.base_url,
    isActive: row.is_active,
    selectedModel: row.selected_model,
    createdAt: row.created_at,
    keys: keys || []
  };
}

router.get('/', async (req, res) => {
  const pool = getPool();
  const providers = await pool.query('SELECT * FROM ai_providers ORDER BY created_at ASC');
  const keys = await pool.query('SELECT * FROM ai_provider_keys ORDER BY provider_id ASC, priority ASC');

  const keysByProvider = {};
  for (const k of keys.rows) {
    if (!keysByProvider[k.provider_id]) keysByProvider[k.provider_id] = [];
    keysByProvider[k.provider_id].push(maskKeyRow(k));
  }

  res.json(providers.rows.map(p => serializeProvider(p, keysByProvider[p.id])));
});

router.post('/', requireCsrf, async (req, res) => {
  const { label, baseUrl } = req.body || {};

  if (typeof label !== 'string' || !label.trim()) {
    return res.status(400).json({ error: 'label is required' });
  }
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return res.status(400).json({ error: 'baseUrl is required' });
  }

  const pool = getPool();
  const result = await pool.query(
    'INSERT INTO ai_providers (label, base_url) VALUES ($1, $2) RETURNING *',
    [label.trim(), baseUrl.trim()]
  );
  res.status(201).json(serializeProvider(result.rows[0], []));
});

router.post('/:id/keys', requireCsrf, async (req, res) => {
  const providerId = Number(req.params.id);
  const { key, priority } = req.body || {};

  if (typeof key !== 'string' || !key.trim()) {
    return res.status(400).json({ error: 'key is required' });
  }

  const pool = getPool();
  const providerCheck = await pool.query('SELECT id FROM ai_providers WHERE id = $1', [providerId]);
  if (providerCheck.rowCount === 0) {
    return res.status(404).json({ error: 'Provider not found' });
  }

  const encrypted = encrypt(key.trim());
  const result = await pool.query(
    'INSERT INTO ai_provider_keys (provider_id, key_encrypted, priority) VALUES ($1, $2, $3) RETURNING *',
    [providerId, encrypted, Number.isInteger(priority) ? priority : 0]
  );
  res.status(201).json(maskKeyRow(result.rows[0]));
});

router.delete('/:id/keys/:keyId', requireCsrf, async (req, res) => {
  const { id, keyId } = req.params;
  const pool = getPool();
  const result = await pool.query(
    'DELETE FROM ai_provider_keys WHERE id = $1 AND provider_id = $2 RETURNING id',
    [keyId, id]
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Key not found' });
  }
  res.json({ success: true });
});

router.post('/:id/fetch-models', requireCsrf, async (req, res) => {
  const providerId = Number(req.params.id);
  const pool = getPool();

  const providerResult = await pool.query('SELECT * FROM ai_providers WHERE id = $1', [providerId]);
  if (providerResult.rowCount === 0) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  const provider = providerResult.rows[0];

  const keysResult = await pool.query(
    'SELECT * FROM ai_provider_keys WHERE provider_id = $1 ORDER BY priority ASC',
    [providerId]
  );
  if (keysResult.rowCount === 0) {
    return res.status(400).json({ error: 'No keys configured for this provider' });
  }

  const errors = [];

  for (const keyRow of keysResult.rows) {
    let plaintextKey;
    try {
      plaintextKey = decrypt(keyRow.key_encrypted);
    } catch (err) {
      errors.push(`key #${keyRow.id}: could not decrypt`);
      continue;
    }

    try {
      const url = `${provider.base_url.replace(/\/+$/, '')}/models`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${plaintextKey}` }
      });

      if (!response.ok) {
        errors.push(`key #${keyRow.id}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();
      const models = Array.isArray(data.data)
        ? data.data.map(m => m.id).filter(Boolean)
        : [];

      return res.json({ models });
    } catch (err) {
      errors.push(`key #${keyRow.id}: ${err.message}`);
    }
  }

  res.status(502).json({ error: 'All keys failed to fetch models', details: errors });
});

router.put('/:id', requireCsrf, async (req, res) => {
  const providerId = Number(req.params.id);
  const { selectedModel, isActive } = req.body || {};

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM ai_providers WHERE id = $1 FOR UPDATE', [providerId]);
    if (existing.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Provider not found' });
    }

    if (isActive === true) {
      // Enforce "only one active provider" atomically: deactivate every
      // other provider in the same transaction before activating this one.
      await client.query('UPDATE ai_providers SET is_active = false WHERE id != $1', [providerId]);
    }

    const nextSelectedModel = typeof selectedModel === 'string' ? selectedModel : existing.rows[0].selected_model;
    const nextIsActive = typeof isActive === 'boolean' ? isActive : existing.rows[0].is_active;

    const result = await client.query(
      'UPDATE ai_providers SET selected_model = $1, is_active = $2 WHERE id = $3 RETURNING *',
      [nextSelectedModel, nextIsActive, providerId]
    );

    await client.query('COMMIT');
    res.json(serializeProvider(result.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[AI-PROVIDER] Failed to update provider:', err.message);
    res.status(500).json({ error: 'Failed to update provider' });
  } finally {
    client.release();
  }
});

router.delete('/:id', requireCsrf, async (req, res) => {
  const providerId = Number(req.params.id);
  const pool = getPool();
  const result = await pool.query('DELETE FROM ai_providers WHERE id = $1 RETURNING id', [providerId]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  res.json({ success: true });
});

module.exports = router;
