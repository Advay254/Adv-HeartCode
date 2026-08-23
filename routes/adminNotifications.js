const express = require('express');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { encrypt, decrypt } = require('../lib/crypto');
const { normalizeChannelRow, sendViaChannelConfig } = require('../lib/notifications');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');

const router = express.Router();
router.use(requireAdminSession);

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

// Per-type caps, per the spec: up to 3 email addresses, 1 webhook, 1
// Gotify — enforced per channel_type below, same row-locked
// count-then-insert pattern as v1.0.7's script manager
// (routes/adminScripts.js's MAX_PER_PLACEMENT), not a DB-level constraint.
const MAX_PER_TYPE = { email: 3, webhook: 1, gotify: 1 };

const createChannelSchema = z.discriminatedUnion('channelType', [
  z.object({
    channelType: z.literal('email'),
    label: z.string().trim().min(1).max(200),
    address: z.string().trim().email().max(254)
  }),
  z.object({
    channelType: z.literal('webhook'),
    label: z.string().trim().min(1).max(200),
    url: z.string().trim().url().max(2000)
  }),
  z.object({
    channelType: z.literal('gotify'),
    label: z.string().trim().min(1).max(200),
    serverUrl: z.string().trim().url().max(2000),
    token: z.string().trim().min(1).max(2000)
  })
]);

// Same secrets convention as everywhere else in this app: a field omitted
// or null means "leave it unchanged," an empty string means "clear it."
// Only fields relevant to the ROW'S OWN channel_type are ever applied (see
// the PUT handler below) — channel_type itself is never changeable via
// update.
const updateChannelSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  address: z.string().trim().email().max(254).optional(),
  url: z.string().trim().url().max(2000).optional(),
  serverUrl: z.string().trim().url().max(2000).optional(),
  token: z.string().max(2000).nullable().optional()
});

function maskedConfig(row) {
  const config = row.config || {};

  if (row.channel_type === 'email') {
    return { address: config.address || '' };
  }

  if (row.channel_type === 'webhook') {
    let url = null;
    try { url = decrypt(config.url_encrypted); } catch (err) { url = null; }
    // Webhook URLs are shown in full (not masked to a few characters like
    // an API key) — the admin needs to actually read and verify the
    // endpoint, and a URL with a token embedded in its query string is a
    // materially different risk than an API key: it's already meant to be
    // handed to this app's own outbound HTTP call, not typed by a person
    // repeatedly. Consistent with how host/port/from-address are shown in
    // full for email_providers' SMTP config — only the credential-shaped
    // sub-field (the token itself, for Gotify below) gets masked.
    return { url: url || '(unreadable — check ENCRYPTION_KEY)' };
  }

  if (row.channel_type === 'gotify') {
    let tokenMasked = null;
    try {
      const token = decrypt(config.token_encrypted);
      tokenMasked = token ? ('••••••••' + token.slice(-4)) : null;
    } catch (err) {
      tokenMasked = null;
    }
    return { serverUrl: config.server_url || '', tokenMasked };
  }

  return {};
}

function serializeChannel(row) {
  return {
    id: row.id,
    channelType: row.channel_type,
    label: row.label,
    isActive: row.is_active,
    createdAt: row.created_at,
    config: maskedConfig(row)
  };
}

router.get('/', async (req, res) => {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM notification_channels ORDER BY channel_type ASC, id ASC');
  res.json(result.rows.map(serializeChannel));
});

router.post('/', requireCsrf, async (req, res) => {
  const parsed = createChannelSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
  }
  const data = parsed.data;

  let config;
  if (data.channelType === 'email') {
    config = { address: data.address };
  } else if (data.channelType === 'webhook') {
    config = { url_encrypted: encrypt(data.url) };
  } else {
    config = { server_url: data.serverUrl, token_encrypted: encrypt(data.token) };
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Row-locked count-then-insert, same reasoning as
    // routes/adminScripts.js's per-placement cap: without the lock, two
    // concurrent admin requests for the same channel_type have the same
    // TOCTOU gap every other capped-count insert in this app guards
    // against.
    const countResult = await client.query(
      'SELECT id FROM notification_channels WHERE channel_type = $1 FOR UPDATE',
      [data.channelType]
    );
    const max = MAX_PER_TYPE[data.channelType];
    if (countResult.rowCount >= max) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `You already have ${max} ${data.channelType} channel${max > 1 ? 's' : ''} — delete one first before adding another.`
      });
    }

    const insertResult = await client.query(
      'INSERT INTO notification_channels (channel_type, label, config) VALUES ($1, $2, $3) RETURNING *',
      [data.channelType, data.label, JSON.stringify(config)]
    );

    await client.query('COMMIT');
    res.status(201).json(serializeChannel(insertResult.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[NOTIFICATIONS] Failed to create channel:', err.message);
    res.status(500).json({ error: 'Failed to save notification channel' });
  } finally {
    client.release();
  }
});

router.put('/:id', requireCsrf, async (req, res) => {
  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: 'Invalid channel id' });
  }
  const bodyParsed = updateChannelSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: bodyParsed.error.issues });
  }
  const { id } = paramsParsed.data;
  const body = bodyParsed.data;

  const pool = getPool();
  const existing = await pool.query('SELECT * FROM notification_channels WHERE id = $1', [id]);
  if (existing.rowCount === 0) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  const current = existing.rows[0];
  const currentConfig = current.config || {};

  let nextConfig = currentConfig;
  if (current.channel_type === 'email') {
    nextConfig = { address: body.address === undefined ? currentConfig.address : body.address };
  } else if (current.channel_type === 'webhook') {
    nextConfig = {
      url_encrypted: body.url === undefined ? currentConfig.url_encrypted : encrypt(body.url)
    };
  } else if (current.channel_type === 'gotify') {
    nextConfig = {
      server_url: body.serverUrl === undefined ? currentConfig.server_url : body.serverUrl,
      token_encrypted: body.token === undefined || body.token === null
        ? currentConfig.token_encrypted
        : (body.token === '' ? '' : encrypt(body.token))
    };
  }

  const nextLabel = body.label === undefined ? current.label : body.label;
  const nextIsActive = body.isActive === undefined ? current.is_active : body.isActive;

  const result = await pool.query(
    'UPDATE notification_channels SET label = $1, config = $2, is_active = $3 WHERE id = $4 RETURNING *',
    [nextLabel, JSON.stringify(nextConfig), nextIsActive, id]
  );
  res.json(serializeChannel(result.rows[0]));
});

router.delete('/:id', requireCsrf, async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid channel id' });
  }
  const pool = getPool();
  const result = await pool.query('DELETE FROM notification_channels WHERE id = $1 RETURNING id', [parsed.data.id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  res.json({ success: true });
});

// v1.1.1 established this exact pattern for email providers — fires a
// real test payload through THIS SPECIFIC channel (not gated on
// is_active) so the admin can confirm it actually works before relying on
// it during a real sale.
router.post('/:id/test', requireCsrf, async (req, res) => {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid channel id' });
  }

  const pool = getPool();
  const result = await pool.query('SELECT * FROM notification_channels WHERE id = $1', [parsed.data.id]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  let config;
  try {
    config = normalizeChannelRow(result.rows[0]);
  } catch (err) {
    return res.status(400).json({ error: `Could not read this channel's configuration: ${err.message}` });
  }

  const testPayload = {
    websiteType: 'Test website type',
    clientEmail: 'test-client@example.com',
    siteUrl: 'https://example.pages.dev',
    amount: 0,
    currency: 'USD',
    deployedAtDisplay: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    deployedAtIso: new Date().toISOString()
  };

  try {
    await sendViaChannelConfig(config, testPayload);
    res.json({ success: true });
  } catch (err) {
    console.error(`[NOTIFICATIONS] Test send failed for channel #${parsed.data.id}:`, err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

module.exports = router;
