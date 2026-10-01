'use strict';

const { getPool } = require('../db/init');
const { substitutePlaceholders, substitutePlainText, escapeHtml } = require('./template');
const { sendCustomEmail } = require('./email');
const { formatDeployedAt } = require('./deploymentEmail');
const { buildReviewUrl } = require('./reviews');

// v1.2.11: the one-time "how did it go" reminder email.
//
// Variables a reminder template can use. Only these exist, because by the
// time a reminder goes out (2 days after deployment) the checkout's form
// values are long gone (pending_deployments is deleted at finalization), and
// the review link row deliberately carries nothing else. Field-based
// variables that the confirmation email offers therefore cannot be offered
// here. Kept in sync by hand with routes/adminWebsiteTypes.js and admin.js.
const REMINDER_VARIABLES = ['review_link', 'site_url', 'client_email', 'website_type_name', 'deployed_at'];

const DEFAULT_SUBJECT = 'Would you share a quick review of your website?';

// Default copy: friendly, general, plain. No em dashes, no emojis. Inline
// styles only, since email clients ignore stylesheets. Colours are the
// site's brand blue and yellow.
function defaultReminderHtml() {
  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.6;color:#14151d;max-width:560px;">',
    '<p>Hello,</p>',
    '<p>Thank you again for building your website with HeartCode. Your support means a lot to us.</p>',
    '<p>If you have a minute, we would be very grateful for a short review of your experience. It helps other people decide with confidence, and it helps us keep improving.</p>',
    '<p style="margin:24px 0;"><a href="{{review_link}}" style="background:#183fad;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:bold;">Leave a review</a></p>',
    '<p style="font-size:14px;color:#555555;">If the button does not work, copy this address into your browser:<br>{{review_link}}</p>',
    '<p style="font-size:14px;color:#555555;">This link can be used once and will stop working after a short time.</p>',
    '<p>With thanks,<br>The HeartCode team</p>',
    '</div>'
  ].join('\n');
}

async function getActiveReminderTemplate(websiteTypeId) {
  if (!websiteTypeId) return null;
  const result = await getPool().query(
    'SELECT * FROM review_reminder_templates WHERE website_type_id = $1 AND is_active = true LIMIT 1',
    [websiteTypeId]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

function renderReminder(subjectTemplate, htmlTemplate, variables) {
  return {
    subject: substitutePlainText(subjectTemplate, variables),
    html: substitutePlaceholders(htmlTemplate, variables, {})
  };
}

/**
 * Sends the reminder for one link row (joined with its deployment, see
 * lib/reviewJobs.js). THROWS on a failed send so the caller leaves
 * reminder_sent_at untouched and the send is retried on a later run. A bad
 * or missing custom template falls back to the built-in copy instead of
 * sending nothing.
 */
async function sendReviewReminder(row) {
  const variables = {
    review_link: buildReviewUrl(row.token),
    site_url: row.site_url || '',
    client_email: row.client_email || '',
    website_type_name: row.website_type_name || '',
    deployed_at: formatDeployedAt(row.deployed_at)
  };

  let rendered = null;
  try {
    const template = await getActiveReminderTemplate(row.website_type_id);
    if (template) {
      rendered = renderReminder(template.subject, template.html_body, variables);
    }
  } catch (err) {
    console.error('[REVIEWS] Could not load or render the reminder template, using the default copy:', err.message);
  }
  if (!rendered) {
    rendered = renderReminder(DEFAULT_SUBJECT, defaultReminderHtml(), variables);
  }

  await sendCustomEmail(row.client_email, rendered.subject, rendered.html);
}

module.exports = {
  REMINDER_VARIABLES,
  DEFAULT_SUBJECT,
  defaultReminderHtml,
  getActiveReminderTemplate,
  sendReviewReminder,
  escapeHtml
};
