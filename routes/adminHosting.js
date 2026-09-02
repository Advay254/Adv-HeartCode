const express = require('express');
const { asyncHandler } = require('../lib/asyncHandler');
const { z } = require('zod');
const { getPool } = require('../db/init');
const { encrypt, decrypt, maskSecret } = require('../lib/crypto');
const { requireAdminSession } = require('../middleware/requireAdminSession');
const { requireCsrf } = require('../middleware/requireCsrf');
const { deployToClarityHeart } = require('../lib/clarityheart');

const router = express.Router();
router.use(requireAdminSession);

// v1.1.9 Part A: same "one active config, encrypted secret, masked on
// display" pattern as paystack_config/email providers. baseUrl is a
// plain (non-secret) field so it keeps the ordinary null/omitted ("leave
// unchanged") vs "" ("clear it") convention used everywhere else in this
// project. apiToken deliberately does NOT support the "" = clear
// convention — see the PUT handler's own comment for why.
const hostingUpdateSchema = z.object({
  baseUrl: z.string().trim().max(500).nullable().optional(),
  apiToken: z.string().max(2000).nullable().optional()
});

function decryptForMask(encrypted) {
  if (!encrypted) return null;
  try {
    return maskSecret(decrypt(encrypted));
  } catch (err) {
    // Missing/wrong ENCRYPTION_KEY or malformed value — treat as
    // "not configured" rather than letting this crash the request.
    return null;
  }
}

function serialize(row) {
  if (!row) {
    return { baseUrl: '', apiTokenMasked: null, updatedAt: null, configured: false };
  }
  return {
    baseUrl: row.base_url || '',
    apiTokenMasked: decryptForMask(row.api_token_encrypted),
    updatedAt: row.updated_at,
    configured: Boolean(row.base_url && row.api_token_encrypted)
  };
}

router.get('/', asyncHandler(async (req, res) => {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM hosting_config WHERE id = 1');
  res.json(serialize(result.rows[0] || null));
}));

// baseUrl follows the standard convention (null/omitted = don't change,
// "" = clear). apiToken does NOT support "" = clear the way a Paystack
// secret does: a hosting config with a base URL but no token is not a
// meaningful intermediate state anyone would deliberately want (unlike
// Paystack, where clearing just one of two independent secret keys is a
// real, reachable state) — so an empty/omitted/null apiToken here always
// means "leave whatever's currently saved alone," never "blank it out."
// The one way to actually replace the token is to type a new one.
router.put('/', requireCsrf, asyncHandler(async (req, res) => {
  const parsed = hostingUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.issues });
  }
  const { baseUrl, apiToken } = parsed.data;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Row-level lock so two concurrent saves can't both read the same
    // "current" values and clobber each other (lost-update race).
    const existing = await client.query('SELECT * FROM hosting_config WHERE id = 1 FOR UPDATE');
    const current = existing.rows[0] || null;

    const nextBaseUrl = (baseUrl === undefined || baseUrl === null)
      ? (current ? current.base_url : '')
      : baseUrl.replace(/\/+$/, ''); // strip trailing slash(es) — lib/clarityheart.js builds "${base_url}/api/deploy" assuming none is present

    const nextTokenEncrypted = (apiToken !== undefined && apiToken !== null && apiToken !== '')
      ? encrypt(apiToken)
      : (current ? current.api_token_encrypted : null);

    // hosting_config.base_url/api_token_encrypted are both NOT NULL — a
    // brand new row with either one still missing can't be saved yet.
    // Caught here with a clear message rather than letting a raw
    // Postgres NOT NULL violation surface as a generic 500.
    if (!nextBaseUrl || !nextTokenEncrypted) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Both a base URL and an API token are required to save the hosting configuration.' });
    }

    const result = await client.query(
      `INSERT INTO hosting_config (id, base_url, api_token_encrypted, updated_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET
         base_url = EXCLUDED.base_url,
         api_token_encrypted = EXCLUDED.api_token_encrypted,
         updated_at = NOW()
       RETURNING *`,
      [nextBaseUrl, nextTokenEncrypted]
    );

    await client.query('COMMIT');
    res.json(serialize(result.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[HOSTING] Failed to save config:', err.message);
    res.status(500).json({ error: 'Failed to save hosting configuration' });
  } finally {
    client.release();
  }
}));

// "Send test deploy" — deploys a tiny, genuinely real throwaway HTML
// snippet through the exact same deployToClarityHeart() function
// lib/finalizeDeployment.js calls for an actual client site, using
// whatever hosting_config is currently saved. This is a real end-to-end
// API call, not a mocked/simulated success — a green result here means
// the connection genuinely works, not just that the form fields look
// plausible.
router.post('/test', requireCsrf, asyncHandler(async (req, res) => {
  const testSlug = `heartcode-test-${Date.now().toString(36)}`;
  const testHtml = '<!DOCTYPE html><html><head><title>HeartCode hosting test</title></head>'
    + '<body><p>This is a throwaway test page from HeartCode\'s admin dashboard, '
    + 'confirming the ClarityHeart connection works.</p></body></html>';

  try {
    const result = await deployToClarityHeart(testSlug, testHtml);
    res.json({ success: true, url: result.url, slug: result.slug });
  } catch (err) {
    console.error('[HOSTING] Test deploy failed:', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
}));

module.exports = router;
