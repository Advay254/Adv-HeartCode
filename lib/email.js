/**
 * Shared low-level Resend sender. https://api.resend.com/emails — POST,
 * Bearer auth, JSON body. Both exported functions below go through this so
 * there's exactly one place that knows about the Resend HTTP contract.
 */
async function postToResend(toEmail, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.EMAIL_FROM_ADDRESS;

  if (!apiKey || !fromAddress) {
    throw new Error('RESEND_API_KEY / EMAIL_FROM_ADDRESS are not set');
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: fromAddress,
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
 * Sends the original generic "your site is ready" email. Behavior is
 * byte-for-byte unchanged from before v1.0.9 — this is the fallback path
 * used whenever a website type has no active email_templates row (see
 * lib/finalizeDeployment.js and Key Decision in v1.0.9's notes).
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

  return postToResend(toEmail, 'Your website is ready', html);
}

/**
 * v1.0.9: sends an admin-authored, per-website-type email whose subject
 * and HTML body have already been fully rendered (placeholders substituted)
 * by lib/emailTemplates.js. This function does no templating of its own —
 * it's a thin, generic "send this exact email" wrapper, same as
 * sendSiteReadyEmail is for the hardcoded fallback content.
 */
async function sendCustomEmail(toEmail, subject, html) {
  return postToResend(toEmail, subject, html);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { sendSiteReadyEmail, sendCustomEmail };
