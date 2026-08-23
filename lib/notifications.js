const { getPool } = require('../db/init');
const { encrypt, decrypt } = require('./crypto');
const { escapeHtml } = require('./template');
const { sendEmail } = require('./email');

const FETCH_TIMEOUT_MS = 10000;

/**
 * Same lesson v1.1.1 learned the hard way with nodemailer (see lib/email.js's
 * buildSmtpTransport comment): an external call with no timeout can hang a
 * request indefinitely rather than failing. webhook/gotify below both go
 * through fetch(), which — unlike a raw TCP socket — usually fails fast
 * through normal HTTP error handling, but "usually" isn't "always" (a
 * server that accepts the connection and then never responds is a real,
 * if less common, failure mode). Bounded here defensively for the same
 * reason: this fires after finalizeDeployment's transaction has already
 * committed, but a hung request here would still tie up the HTTP request
 * that triggered it (the checkout callback page, or the webhook handler)
 * for as long as it hangs.
 */
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Turns a raw notification_channels row into its normalized, DECRYPTED
 * config shape — mirrors lib/emailProvider.js's normalizeProviderRow for
 * the same reason: both the real trigger path (notifySaleCompleted below)
 * and the admin "send test notification" route
 * (routes/adminNotifications.js) need the exact same decrypt/shape logic
 * for an arbitrary row, not just the currently-active ones.
 */
function normalizeChannelRow(row) {
  const config = row.config || {};

  if (row.channel_type === 'email') {
    return { type: 'email', address: config.address || '' };
  }

  if (row.channel_type === 'webhook') {
    return { type: 'webhook', url: decrypt(config.url_encrypted) };
  }

  if (row.channel_type === 'gotify') {
    return { type: 'gotify', serverUrl: config.server_url || '', token: decrypt(config.token_encrypted) };
  }

  throw new Error(`Unknown notification channel_type: ${row.channel_type}`);
}

function formatSalePayloadForHumans(payload) {
  return {
    subject: `New sale — ${payload.websiteType}`,
    line: `${payload.websiteType} — ${payload.amount} ${payload.currency} — ${payload.clientEmail}`
  };
}

/**
 * Routed through lib/email.js's sendEmail — i.e. through whichever email
 * provider the admin already has active (v1.1.1), not a separate email
 * path of its own. This means a sale-notification email is subject to the
 * exact same "no active provider configured" failure as any other email
 * this app sends, which is the correct behavior: it's still just email.
 */
async function sendViaEmailChannel(config, payload) {
  if (!config.address) {
    throw new Error('Email notification channel is missing a destination address');
  }
  const { subject } = formatSalePayloadForHumans(payload);
  const html = `
    <p>A new site was just deployed.</p>
    <ul>
      <li>Website type: ${escapeHtml(payload.websiteType)}</li>
      <li>Client: ${escapeHtml(payload.clientEmail)}</li>
      <li>Site: <a href="${escapeHtml(payload.siteUrl)}">${escapeHtml(payload.siteUrl)}</a></li>
      <li>Amount: ${escapeHtml(String(payload.amount))} ${escapeHtml(payload.currency)}</li>
      <li>Deployed: ${escapeHtml(payload.deployedAtDisplay)}</li>
    </ul>
  `.trim();
  await sendEmail(config.address, subject, html);
}

/**
 * POSTs exactly the payload shape specified for this feature — event,
 * websiteType, clientEmail, siteUrl, amount, currency, deployedAt — as
 * plain JSON, unwrapped. `deployedAt` here is a real ISO timestamp
 * (Date#toISOString), not the human-formatted string the email channel
 * uses — this is a payload meant for another program to parse, not a
 * person to read.
 */
async function sendViaWebhookChannel(config, payload) {
  if (!config.url) {
    throw new Error('Webhook notification channel is missing a URL');
  }
  const res = await fetchWithTimeout(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'sale_completed',
      websiteType: payload.websiteType,
      clientEmail: payload.clientEmail,
      siteUrl: payload.siteUrl,
      amount: payload.amount,
      currency: payload.currency,
      deployedAt: payload.deployedAtIso
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webhook endpoint responded with HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
}

/**
 * Gotify's own REST API: POST {server_url}/message?token={token}. Priority
 * 5 is Gotify's own default/"normal" priority — not urgent enough to
 * override a phone's do-not-disturb on most Gotify client configurations,
 * but still shown promptly in the normal notification list. Not made
 * admin-configurable here — a sale notification is a single, well-defined
 * event type, not a general-purpose alerting channel that needs tunable
 * severity.
 */
async function sendViaGotifyChannel(config, payload) {
  if (!config.serverUrl) {
    throw new Error('Gotify notification channel is missing a server URL');
  }
  const { subject, line } = formatSalePayloadForHumans(payload);
  const url = `${config.serverUrl.replace(/\/+$/, '')}/message?token=${encodeURIComponent(config.token)}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: subject, message: line, priority: 5 })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gotify server responded with HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  }
}

async function sendViaChannelConfig(config, payload) {
  if (config.type === 'email') return sendViaEmailChannel(config, payload);
  if (config.type === 'webhook') return sendViaWebhookChannel(config, payload);
  if (config.type === 'gotify') return sendViaGotifyChannel(config, payload);
  throw new Error(`Unsupported notification channel type: ${config.type}`);
}

/**
 * Fires a sale notification to every ACTIVE notification_channels row,
 * independently of one another — Promise.allSettled, deliberately not
 * Promise.all, specifically so one channel's rejection can never prevent
 * the others from being attempted or affect whether they succeed.
 * Never throws; every failure is caught and logged per-channel, with
 * enough detail (channel id, type, label) to find and fix it from Render's
 * logs alone.
 *
 * Called from lib/finalizeDeployment.js AFTER its transaction has already
 * committed — the exact same point the client's own confirmation email
 * fires (see that file). This means a slow or hanging channel here can
 * only ever delay finishing the HTTP response for whichever request
 * triggered it (the checkout callback page, or the Paystack webhook) —
 * it can never hold the Postgres row lock that guards deployment
 * idempotency, and it can never affect whether the deployment itself
 * succeeded, since that already happened and was already committed
 * before this function is ever called.
 */
async function notifySaleCompleted(payload) {
  const pool = getPool();
  let channels;
  try {
    const result = await pool.query('SELECT * FROM notification_channels WHERE is_active = true');
    channels = result.rows;
  } catch (err) {
    console.error('[NOTIFICATIONS] Failed to load notification channels — no sale notifications sent for this deployment:', err.message);
    return;
  }

  if (channels.length === 0) return;

  const results = await Promise.allSettled(channels.map(async (row) => {
    const config = normalizeChannelRow(row);
    await sendViaChannelConfig(config, payload);
  }));

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      const row = channels[i];
      const reason = result.reason && result.reason.message ? result.reason.message : String(result.reason);
      console.error(`[NOTIFICATIONS] Channel #${row.id} (${row.channel_type} "${row.label}") failed to send:`, reason);
    }
  });
}

module.exports = { notifySaleCompleted, normalizeChannelRow, sendViaChannelConfig };
