'use strict';

// v1.2.19: the server keeps what it built.
//
// When the build step renders a site, the result is stored here and the browser
// only gets an unguessable id. Checkout accepts that id, never HTML, raw values
// or AI values from the browser, and what is deployed is only ever what the
// server itself stored. A render can be used for more than one checkout attempt
// until it expires, and is deleted after a successful deployment and by the
// scheduled cleanup.

const crypto = require('crypto');
const { getPool } = require('../db/init');

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** How long a render can be used for checkout. Default 120 minutes. */
function ttlMs() { return intEnv('RENDER_TTL_MINUTES', 120, 5, 24 * 60) * 60 * 1000; }
/** Most renders stored at once, across everyone. Default 1000. */
function maxStored() { return intEnv('RENDER_MAX_STORED', 1000, 10, 100000); }
/** Most total stored HTML, in megabytes, across everyone. Default 250. */
function maxTotalBytes() { return intEnv('RENDER_MAX_TOTAL_MB', 250, 5, 20000) * 1024 * 1024; }
/** Largest single render accepted, in characters. */
const MAX_RENDER_CHARS = 12 * 1000 * 1000;

const ID_RE = /^[A-Za-z0-9_-]{43}$/;

function newId() { return crypto.randomBytes(32).toString('base64url'); }

/**
 * Stores a render. Returns { ok:true, id, expiresAt } or { ok:false, reason }
 * where reason is 'too_large' or 'busy'.
 */
async function createRender({ websiteTypeId, html, rawFieldValues, aiOutputValues }) {
  if (typeof html !== 'string' || html.length === 0) return { ok: false, reason: 'too_large' };
  if (html.length > MAX_RENDER_CHARS) return { ok: false, reason: 'too_large' };
  const pool = getPool();

  // Make room first: expired renders are removed before the caps are checked.
  await pool.query('DELETE FROM build_renders WHERE expires_at < NOW()');
  const used = await pool.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(octet_length(rendered_html)), 0)::bigint AS bytes FROM build_renders');
  if (used.rows[0].n >= maxStored() || Number(used.rows[0].bytes) + Buffer.byteLength(html) > maxTotalBytes()) {
    return { ok: false, reason: 'busy' };
  }

  const id = newId();
  const expiresAt = new Date(Date.now() + ttlMs());
  await pool.query(
    `INSERT INTO build_renders (id, website_type_id, rendered_html, raw_field_values, ai_output_values, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, websiteTypeId, html, rawFieldValues ? JSON.stringify(rawFieldValues) : null, aiOutputValues ? JSON.stringify(aiOutputValues) : null, expiresAt]
  );
  return { ok: true, id, expiresAt };
}

/** Returns { ok:true, render } or { ok:false, reason: 'invalid'|'missing'|'expired'|'wrong_type' }. */
async function loadRender(id, websiteTypeId) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, reason: 'invalid' };
  const r = await getPool().query('SELECT * FROM build_renders WHERE id = $1', [id]);
  if (r.rowCount === 0) return { ok: false, reason: 'missing' };
  const row = r.rows[0];
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (row.website_type_id !== websiteTypeId) return { ok: false, reason: 'wrong_type' };
  return { ok: true, render: row };
}

async function deleteExpiredRenders() {
  const r = await getPool().query('DELETE FROM build_renders WHERE expires_at < NOW()');
  return r.rowCount;
}

const REBUILD_MESSAGE = 'Your page preview has expired or was made before an update. Please go back and build your page again, it only takes a moment.';

module.exports = { createRender, loadRender, deleteExpiredRenders, REBUILD_MESSAGE, ID_RE, ttlMs, maxStored, maxTotalBytes, MAX_RENDER_CHARS };
