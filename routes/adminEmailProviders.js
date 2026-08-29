const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { encrypt, decrypt, maskSecret } = require('../lib/crypto');
const { normalizeProviderRow } = require('../lib/emailProvider');
const { sendViaProviderConfig } = require('../lib/email');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');

const router = express.Router();
router.use(requireAdminSession);

// Same NaN-guarding discipline as routes/adminAiProviders.js — every :id
// below is validated before it ever reaches a query.
const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

// Two real provider_types (`resend` and `smtp` — matching the DB CHECK
// constraint in db/init.js), but the admin UI offers FOUR choices (Resend /
// Gmail SMTP / Brevo SMTP / Generic SMTP). The latter three are all
// provider_type='smtp' underneath — "Gmail SMTP" and "Brevo SMTP" are
// purely a client-side convenience that pre-fills the known host/port/
// connection_security for those services before the admin ever sees the
// form (see public/dashboard-assets/admin.js) — nothing server-side needs
// to know which preset was used, only the resulting smtp fields.
const createProviderSchema = z.discriminatedUnion('providerType', [
  z.object({
    providerType: z.literal('resend'),
    label: z.string().trim().min(1).max(200),
    apiKey: z.string().trim().min(1).max(2000),
    fromAddress: z.string().trim().email().max(254)
  }),
  z.object({
    providerType: z.literal('smtp'),
    label: z.string().trim().min(1).max(200),
    host: z.string().trim().min(1).max(255),
    port: z.coerce.number().int().min(1).max(65535),
    username: z.string().trim().max(255).optional().default(''),
    password: z.string().min(1).max(2000),
    fromAddress: z.string().trim().email().max(254),
    fromName: z.string().trim().max(200).optional().default(''),
    connectionSecurity: z.enum(['STARTTLS', 'SSL', 'none']).default('STARTTLS')
  })
]);

// Update: label/isActive apply to either type; the rest are per-type
// fields, all optional here since a single PUT might only be toggling
// `isActive` or renaming the label. Follows the SAME "secrets convention"
// as routes/adminPaystack.js / adminAiProviders.js: apiKey/password
// omitted or null = keep the current value, "" = clear it. Only the
// fields relevant to the ROW'S OWN provider_type are ever applied (see the
// PUT handler below) — provider_type itself is never changeable via
// update; delete and re-add instead.
const updateProviderSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  apiKey: z.string().max(2000).nullable().optional(),
  fromAddress: z.string().trim().email().max(254).optional(),
  host: z.string().trim().max(255).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  username: z.string().trim().max(255).optional(),
  password: z.string().max(2000).nullable().optional(),
  fromName: z.string().trim().max(200).optional(),
  connectionSecurity: z.enum(['STARTTLS', 'SSL', 'none']).optional()
});

const testSendSchema = z.object({
  to: z.string().trim().email().max(254)
});

function decryptForMask(encryptedValue) {
  if (!encryptedValue) return null;
  try {
    return maskSecret(decrypt(encryptedValue));
  } catch (err) {
    // Missing/wrong ENCRYPTION_KEY or malformed value — treat as
    // "not configured" rather than letting this crash the request.
    return null;
  }
}

// Masks whichever sensitive sub-field(s) this row's provider_type has,
// leaving every non-sensitive field (host, port, from address, etc.) as
// plain readable JSON — same "encrypt only the sensitive sub-field(s)"
// convention db/init.js documents for the config JSONB column itself.
function maskedConfig(row) {
  const config = row.config || {};

  if (row.provider_type === 'resend') {
    return {
      apiKeyMasked: decryptForMask(config.api_key_encrypted),
      fromAddress: config.from_address || ''
    };
  }

  if (row.provider_type === 'smtp') {
    return {
      host: config.host || '',
      port: config.port || null,
      username: config.username || '',
      passwordMasked: decryptForMask(config.password_encrypted),
      fromAddress: config.from_address || '',
      fromName: config.from_name || '',
      connectionSecurity: config.connection_security || 'STARTTLS'
    };
  }

  return {};
}

function serializeProvider(row) {
  return {
    id: row.id,
    providerType: row.provider_type,
    label: row.label,
    isActive: row.is_active,
    createdAt: row.created_at,
    config: maskedConfig(row)
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM email_providers ORDER BY created_at ASC');
  res.json(result.rows.map(serializeProvider));
}));

router.post('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = createProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
  }
  const data = parsed.data;

  let config;
  if (data.providerType === 'resend') {
    config = {
      api_key_encrypted: encrypt(data.apiKey),
      from_address: data.fromAddress
    };
  } else {
    config = {
      host: data.host,
      port: data.port,
      username: data.username,
      password_encrypted: encrypt(data.password),
      from_address: data.fromAddress,
      from_name: data.fromName,
      connection_security: data.connectionSecurity
    };
  }

  const pool = getPool();
  const result = await pool.query(
    'INSERT INTO email_providers (provider_type, label, config) VALUES ($1, $2, $3) RETURNING *',
    [data.providerType, data.label, JSON.stringify(config)]
  );
  res.status(201).json(serializeProvider(result.rows[0]));
}));

router.put('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid provider id' });
  }
  const bodyParsed = updateProviderSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: bodyParsed.error.issues });
  }
  const { id: providerId } = paramsParsed.data;
  const body = bodyParsed.data;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existing = await client.query('SELECT * FROM email_providers WHERE id = $1 FOR UPDATE', [providerId]);
    if (existing.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Provider not found' });
    }
    const current = existing.rows[0];
    const currentConfig = current.config || {};

    if (body.isActive === true) {
      // Enforce "only one active provider" atomically — same pattern as
      // routes/adminAiProviders.js's PUT /:id.
      await client.query('UPDATE email_providers SET is_active = false WHERE id != $1', [providerId]);
    }

    let nextConfig = currentConfig;
    if (current.provider_type === 'resend') {
      nextConfig = {
        api_key_encrypted: body.apiKey === undefined || body.apiKey === null
          ? currentConfig.api_key_encrypted
          : (body.apiKey === '' ? '' : encrypt(body.apiKey)),
        from_address: body.fromAddress === undefined ? currentConfig.from_address : body.fromAddress
      };
    } else if (current.provider_type === 'smtp') {
      nextConfig = {
        host: body.host === undefined ? currentConfig.host : body.host,
        port: body.port === undefined ? currentConfig.port : body.port,
        username: body.username === undefined ? currentConfig.username : body.username,
        password_encrypted: body.password === undefined || body.password === null
          ? currentConfig.password_encrypted
          : (body.password === '' ? '' : encrypt(body.password)),
        from_address: body.fromAddress === undefined ? currentConfig.from_address : body.fromAddress,
        from_name: body.fromName === undefined ? currentConfig.from_name : body.fromName,
        connection_security: body.connectionSecurity === undefined ? currentConfig.connection_security : body.connectionSecurity
      };
    }

    const nextLabel = body.label === undefined ? current.label : body.label;
    const nextIsActive = body.isActive === undefined ? current.is_active : body.isActive;

    const result = await client.query(
      'UPDATE email_providers SET label = $1, config = $2, is_active = $3 WHERE id = $4 RETURNING *',
      [nextLabel, JSON.stringify(nextConfig), nextIsActive, providerId]
    );

    await client.query('COMMIT');
    res.json(serializeProvider(result.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[EMAIL-PROVIDERS] Failed to update provider:', err.message);
    res.status(500).json({ error: 'Failed to update provider' });
  } finally {
    client.release();
  }
}));

router.delete('/:id', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid provider id' });
  }
  const pool = getPool();
  const result = await pool.query('DELETE FROM email_providers WHERE id = $1 RETURNING id', [parsed.data.id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Provider not found' });
  }
  res.json({ success: true });
}));

// v1.1.1 Part C: sends a real test email through THIS SPECIFIC provider
// (not necessarily the active one) before the admin commits to activating
// it — a misconfigured SMTP provider silently failing is a much worse
// discovery moment during a real client deployment than during setup.
router.post('/:id/test', requireCsrf, asyncHandler(async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid provider id' });
  }
  const bodyParsed = testSendSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'A valid destination email address is required' });
  }
  const { id: providerId } = paramsParsed.data;
  const { to } = bodyParsed.data;

  const pool = getPool();
  const result = await pool.query('SELECT * FROM email_providers WHERE id = $1', [providerId]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Provider not found' });
  }

  let config;
  try {
    config = normalizeProviderRow(result.rows[0]);
  } catch (err) {
    return res.status(400).json({ error: `Could not read this provider's configuration: ${err.message}` });
  }

  try {
    await sendViaProviderConfig(
      config,
      to,
      'HeartCode test email',
      '<p>This is a test email from your HeartCode admin dashboard — if you\'re reading this, this email provider is configured correctly.</p>'
    );
    res.json({ success: true });
  } catch (err) {
    console.error(`[EMAIL-PROVIDERS] Test send failed for provider #${providerId}:`, err.message);
    res.status(502).json({ success: false, error: err.message });
  }
}));

module.exports = router;
