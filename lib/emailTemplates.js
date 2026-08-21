/**
 * v1.0.9 Part A: per-website-type email templates.
 *
 * This module is the email-side counterpart to what routes/apiBuild.js
 * already does for site templates -- look up the active template, build
 * the merged variable set (raw form fields + AI output fields, now plus a
 * handful of "system" variables that only exist at deploy time), and
 * substitute. It's deliberately kept separate from lib/template.js (which
 * stays a generic, template-agnostic substitution engine) and from
 * lib/finalizeDeployment.js (which stays focused on the payment/deploy
 * pipeline and just calls into this).
 */

const { getPool } = require('../db/init');
const { substitutePlaceholders, substitutePlainText } = require('./template');

/**
 * Reserved variable names always available to an email template, on top of
 * whatever the website type's own raw fields / AI output fields provide.
 * These win on any name collision (see buildEmailVariables) so a template
 * can rely on them being accurate regardless of how an admin has named
 * their fields.
 */
const SYSTEM_EMAIL_VARIABLES = ['site_url', 'client_email', 'website_type_name', 'deployed_at', 'site_password'];

/**
 * Returns the active email_templates row for a website type, or null if
 * none has ever been saved -- the caller (lib/finalizeDeployment.js) treats
 * null as "use the original generic fallback email", never as an error.
 */
async function getActiveEmailTemplate(websiteTypeId) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM email_templates WHERE website_type_id = $1 AND is_active = true LIMIT 1',
    [websiteTypeId]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

/**
 * Rebuilds the same {flatValues, arrayValues} shape routes/apiBuild.js
 * builds live at generate time, but from data that survived to deploy
 * time: `rawFieldValues` (pending_deployments.raw_field_values, v1.0.8)
 * and `aiOutputValues` (pending_deployments.ai_output_values, v1.0.9 --
 * the AI's raw parsed JSON output, keyed by output_key, unescaped).
 *
 * Field/output SHAPE (is this key flat or array-shaped?) is re-derived from
 * template_fields / ai_output_fields here rather than stored alongside the
 * values, the same way apiBuild.js derives it live -- one source of truth
 * for "what shape is this field" regardless of when the lookup happens.
 *
 * `systemVars` is applied last so it always wins on a name collision with
 * an admin-defined field_key or output_key -- see SYSTEM_EMAIL_VARIABLES.
 */
async function buildEmailVariables(websiteTypeId, systemVars, rawFieldValues, aiOutputValues) {
  const pool = getPool();
  const flatValues = {};
  const arrayValues = {};
  const raw = rawFieldValues || {};

  const fieldsResult = await pool.query(
    'SELECT field_key, field_type FROM template_fields WHERE website_type_id = $1',
    [websiteTypeId]
  );
  for (const f of fieldsResult.rows) {
    const val = raw[f.field_key];
    if (f.field_type === 'checkboxes') {
      const arr = Array.isArray(val) ? val : [];
      arrayValues[f.field_key] = arr;
      flatValues[f.field_key] = arr.join(', ');
    } else {
      flatValues[f.field_key] = val;
    }
  }

  if (aiOutputValues && typeof aiOutputValues === 'object') {
    const outputFieldsResult = await pool.query(
      'SELECT output_key, output_type FROM ai_output_fields WHERE website_type_id = $1',
      [websiteTypeId]
    );
    for (const f of outputFieldsResult.rows) {
      const val = aiOutputValues[f.output_key];
      if (val === undefined) continue;
      if (f.output_type === 'array_of_strings' || f.output_type === 'array_of_objects') {
        arrayValues[f.output_key] = val;
      } else {
        flatValues[f.output_key] = val;
      }
    }
  }

  Object.assign(flatValues, systemVars);

  return { flatValues, arrayValues };
}

/**
 * Renders a template row (from getActiveEmailTemplate) into a ready-to-send
 * { subject, html }. Subject is plain text (an email client renders it
 * verbatim, never as HTML) so it goes through substitutePlainText -- the
 * same loop-free, non-escaping engine used for AI prompts -- rather than
 * substitutePlaceholders, which would leave literal "&#39;"-style entities
 * visible in a subject line. Loop syntax ({{#each field}}...{{/each}})
 * therefore only works in the HTML body, not the subject; this is
 * surfaced to the admin as UI copy in the Email tab, not silently.
 */
function renderEmailContent(template, flatValues, arrayValues) {
  const subject = substitutePlainText(template.subject, flatValues);
  const html = substitutePlaceholders(template.html_body, flatValues, arrayValues);
  return { subject, html };
}

module.exports = {
  SYSTEM_EMAIL_VARIABLES,
  getActiveEmailTemplate,
  buildEmailVariables,
  renderEmailContent
};
