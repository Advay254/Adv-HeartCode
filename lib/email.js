const nodemailer = require('nodemailer');
const { getActiveEmailProvider } = require('./emailProvider');

/**
 * Low-level Resend sender — behavior unchanged from before v1.1.1, except
 * the API key and from address now come from a normalized, DB-sourced
 * provider config object instead of reading process.env directly.
 */
async function sendViaResend(config, toEmail, subject, html) {
  if (!config.apiKey || !config.fromAddress) {
    throw new Error('Resend provider is missing an API key or from address');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      from: config.fromAddress,
      to: toEmail,
      subject,
      html
    })
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Resend request failed: HTTP ${response.status} ${errorBody.slice(0, 300)}`);
  }

  return response.json();
}

/**
 * v1.1.1 Part C: SMTP send path via nodemailer, for the three SMTP-based
 * options the admin UI offers (Gmail SMTP, Brevo SMTP, Generic SMTP — all
 * three are the SAME provider_type='smtp' underneath, differing only in
 * which host/port/security the admin UI pre-fills; see
 * routes/adminEmailProviders.js). This runs on Node/Render, not Cloudflare
 * Workers, so nodemailer (a normal Node package, not Web-Crypto-only) is a
 * fine dependency here.
 *
 * Explicit connection/greeting/socket timeouts below are deliberate and
 * NOT just defensive boilerplate: this is the first place in the codebase
 * that opens a raw TCP socket to an external host, rather than an HTTP
 * fetch() — a wrong host/port, or a network that silently drops the
 * connection instead of refusing it, means the underlying TCP handshake
 * can hang indefinitely with no error and no built-in timeout from
 * nodemailer itself. Discovered this firsthand while testing this exact
 * function during this version's build: an admin's "send test email"
 * click against an unreachable host hung the request indefinitely rather
 * than failing. That's a real regression risk beyond just the test-send
 * button, too — lib/finalizeDeployment.js's idempotent transaction (see
 * HANDOFF's Key Decision #3) holds a Postgres row lock for the full
 * duration of the site-ready email send; an unbounded hang there would
 * hold that lock indefinitely and block a legitimate retry of the SAME
 * deployment reference. Bounded timeouts turn "hangs forever" into "fails
 * within ~20s with a clear error", which callers already handle.
 *
 * connectionSecurity maps to nodemailer's secure/requireTLS flags:
 * - 'SSL'      -> secure: true (implicit TLS from the first byte, typically port 465)
 * - 'STARTTLS' -> secure: false, requireTLS: true (upgrade after connecting, typically port 587)
 * - 'none'     -> secure: false, requireTLS: false (plaintext — offered for completeness/
 *                 self-hosted relays, not recommended, never the default in the admin UI)
 */
function buildSmtpTransport(config) {
  const security = config.connectionSecurity || 'STARTTLS';
  return nodemailer.createTransport({
    host: config.host,
    port: Number(config.port) || 587,
    secure: security === 'SSL',
    requireTLS: security === 'STARTTLS',
    auth: config.username ? { user: config.username, pass: config.password } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000
  });
}

async function sendViaSmtp(config, toEmail, subject, html) {
  if (!config.host || !config.fromAddress) {
    throw new Error('SMTP provider is missing a host or from address');
  }

  const transporter = buildSmtpTransport(config);
  const from = config.fromName ? `"${config.fromName}" <${config.fromAddress}>` : config.fromAddress;

  await transporter.sendMail({ from, to: toEmail, subject, html });
}

/**
 * Dispatches to the right send path for an already-normalized (decrypted)
 * provider config object — the shape lib/emailProvider.js's
 * normalizeProviderRow() produces. Exported separately from sendEmail()
 * below because routes/adminEmailProviders.js's "send test email" button
 * needs to test ANY provider row (not necessarily the currently active
 * one) before the admin commits to activating it.
 */
async function sendViaProviderConfig(config, toEmail, subject, html) {
  if (config.type === 'resend') return sendViaResend(config, toEmail, subject, html);
  if (config.type === 'smtp') return sendViaSmtp(config, toEmail, subject, html);
  throw new Error(`Unsupported email provider type: ${config.type}`);
}

/**
 * The one function everything else in the codebase should call to
 * actually send an email — reads whichever provider is currently marked
 * active and dispatches through sendViaProviderConfig above. Neither
 * lib/finalizeDeployment.js nor any future caller needs to know or care
 * whether that's Resend or SMTP under the hood.
 *
 * If no provider is active at all (shouldn't happen after the boot-time
 * migration seed in lib/emailProvider.js, but handled defensively here —
 * e.g. an admin deletes their only provider and hasn't added a
 * replacement yet), this throws with a clear message rather than silently
 * pretending the email sent; it's also logged directly here so the
 * failure is visible in Render's logs even if some future caller forgets
 * to log its own catch block.
 */
async function sendEmail(toEmail, subject, html) {
  const provider = await getActiveEmailProvider();
  if (!provider) {
    const message = 'No active email provider is configured — email was not sent. Add and activate one on the Email Providers admin page.';
    console.error(`[EMAIL] ${message} (to=${toEmail}, subject="${subject}")`);
    throw new Error(message);
  }
  return sendViaProviderConfig(provider, toEmail, subject, html);
}

/**
 * Sends the original generic "your site is ready" email. Behavior is
 * byte-for-byte unchanged from before v1.1.1 — this is the fallback path
 * used whenever a website type has no active email_templates row (see
 * lib/finalizeDeployment.js). Only the underlying transport (sendEmail,
 * above) changed; this function's own content-building logic did not.
 *
 * `sitePassword` is the PLAINTEXT password (if the client set one on
 * checkout) — this is the one place it's acceptable to handle it in
 * plaintext, since the client genuinely needs to know it and a hash can't
 * be reversed. It arrives here already read out of the one-time in-memory
 * cache (lib/sitePasswordCache.js) by the caller — this function itself
 * never touches the database or logs it.
 */
async function sendSiteReadyEmail(toEmail, siteUrl, sitePassword) {
  const passwordSection = sitePassword
    ? `<p>Your site is password-protected. Here's the password you set: <strong>${escapeHtml(sitePassword)}</strong></p>`
    : '';

  const html = `
    <p>Your website is live!</p>
    <p><a href="${escapeHtml(siteUrl)}">${escapeHtml(siteUrl)}</a></p>
    ${passwordSection}
    <p>Thanks for using HeartCode.</p>
  `.trim();

  return sendEmail(toEmail, 'Your website is ready', html);
}

/**
 * v1.0.9: sends an admin-authored, per-website-type email whose subject
 * and HTML body have already been fully rendered (placeholders substituted)
 * by lib/emailTemplates.js. This function does no templating of its own —
 * it's a thin, generic "send this exact email" wrapper, same as
 * sendSiteReadyEmail is for the hardcoded fallback content.
 */
async function sendCustomEmail(toEmail, subject, html) {
  return sendEmail(toEmail, subject, html);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * v1.1.2 Part C: sends the "here are your sites" email for the public
 * resend-details self-service flow (routes/public.js's POST
 * /api/resend-details). `sites` is the full list of matching
 * deployed_sites rows (already joined with website_types.name by the
 * caller) — a client may have purchased more than once, so this lists
 * every match in one email rather than just the most recent.
 *
 * Deliberately states plainly, per site, whenever `has_password` is true,
 * that the password itself can't be resent — see db/init.js's migration
 * comment on deployed_sites.has_password for why that's a genuine,
 * permanent architectural limitation (only a SHA-256 hash was ever
 * stored, by design — see lib/finalizeDeployment.js's injectPasswordGate)
 * and not something silently omitted. Saying nothing at all about the
 * password would leave a client who forgot it thinking the email missed
 * something, rather than understanding it genuinely cannot be recovered.
 */
async function sendResendDetailsEmail(toEmail, sites) {
  const itemsHtml = sites.map(site => {
    const typeName = site.website_type_name || 'Website';
    const deployedAt = (() => {
      try {
        return new Date(site.deployed_at).toLocaleDateString('en-US', { dateStyle: 'medium' });
      } catch (err) {
        return String(site.deployed_at);
      }
    })();
    const passwordNote = site.has_password
      ? '<br><em>This site is password-protected. The password itself can\'t be resent or recovered — only a one-way hash of it was ever stored, never the password itself. If you\'ve forgotten it, the site will need to be redeployed.</em>'
      : '';
    return `<li><strong>${escapeHtml(typeName)}</strong> — <a href="${escapeHtml(site.site_url)}">${escapeHtml(site.site_url)}</a> (deployed ${escapeHtml(deployedAt)})${passwordNote}</li>`;
  }).join('');

  const html = `
    <p>Here are the sites on file for this email address:</p>
    <ul>${itemsHtml}</ul>
    <p>If you didn't request this, you can safely ignore this email.</p>
  `.trim();

  return sendEmail(toEmail, 'Your HeartCode site details', html);
}

module.exports = { sendSiteReadyEmail, sendCustomEmail, sendEmail, sendViaProviderConfig, sendResendDetailsEmail };
