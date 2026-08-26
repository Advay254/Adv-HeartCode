/**
 * v1.1.4 Part C: per-website-type password page CMS.
 *
 * Deliberately its OWN small module, not a reuse of lib/template.js's
 * generic substitutePlaceholders/expandLoops engine — this page renders
 * BEFORE any site content is unlocked (it IS the gate), so it must never
 * have access to the full raw/AI field set a site template can reference.
 * Its supported token set is exactly two entries, both handled here by
 * hand:
 *
 *   {{website_type_name}}         — plain text, HTML-escaped like any
 *                                    other admin-authored value dropped
 *                                    into markup.
 *   {{password_input_and_button}} — a FIXED functional element: the
 *                                    admin designs everything around it,
 *                                    but never hand-builds the input/
 *                                    button/JS logic itself (that stays
 *                                    code-controlled for correctness —
 *                                    the actual password check is a
 *                                    client-side SHA-256 compare against
 *                                    the hash baked into the deployed
 *                                    page, same mechanism the original
 *                                    hardcoded gate has always used).
 *                                    Substituted RAW (unescaped) since
 *                                    it's real markup, not a text value —
 *                                    this is why it's handled as its own
 *                                    dedicated replace() pass, separate
 *                                    from the escaped {{website_type_name}}
 *                                    pass below, rather than folded into
 *                                    one generic "values" map the way
 *                                    lib/template.js's substitutePlaceholders
 *                                    would (which escapes every value
 *                                    unconditionally).
 */

const { getPool } = require('../db/init');
const { escapeHtml } = require('./template');

const PASSWORD_PAGE_PLACEHOLDERS = ['website_type_name', 'password_input_and_button'];

const PASSWORD_INPUT_TOKEN_RE = /\{\{\s*password_input_and_button\s*\}\}/g;
const WEBSITE_TYPE_NAME_TOKEN_RE = /\{\{\s*website_type_name\s*\}\}/g;

/**
 * Returns the active password_page_templates row for a website type, or
 * null if none has ever been saved — the caller (lib/finalizeDeployment.js)
 * treats null as "use the original generic hardcoded gate", never as an
 * error, exactly the same non-breaking fallback pattern email_templates
 * (v1.0.9) already established.
 */
async function getActivePasswordPageTemplate(websiteTypeId) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT * FROM password_page_templates WHERE website_type_id = $1 AND is_active = true LIMIT 1',
    [websiteTypeId]
  );
  return result.rowCount > 0 ? result.rows[0] : null;
}

/**
 * The actual input/button/error markup the {{password_input_and_button}}
 * token expands to. Fixed ids (hc-gate-input/hc-gate-submit/hc-gate-error)
 * are load-bearing — the checking script injected alongside this (see
 * lib/finalizeDeployment.js's injectPasswordGate) wires up to these exact
 * ids regardless of which password page design (custom or default) is in
 * play. Classes of the same names are included too, purely so an admin's
 * custom CSS has an easy, readable selector to style against without
 * needing to know these are also DOM ids.
 */
function buildFunctionalWidgetHtml() {
  return (
    '<input type="password" id="hc-gate-input" class="hc-gate-input" autocomplete="off">' +
    '<button type="button" id="hc-gate-submit" class="hc-gate-submit">Enter</button>' +
    '<p id="hc-gate-error" class="hc-gate-error" style="display:none;">Incorrect password</p>'
  );
}

/**
 * Substitutes both supported tokens in a custom password page's
 * html_content. `websiteTypeName` is escaped (it's a text value being
 * dropped into markup); the functional widget is not (it's real markup).
 * Any OTHER {{...}} token in the admin's HTML is left exactly as typed —
 * there is no raw/AI field set for this page to draw from, so anything
 * else is simply not a recognized placeholder here (the admin UI warns
 * about this at save time, same "warn, don't block" pattern as the
 * Template/Email tabs).
 */
function renderPasswordPageContent(htmlContent, websiteTypeName) {
  let result = htmlContent.replace(PASSWORD_INPUT_TOKEN_RE, () => buildFunctionalWidgetHtml());
  result = result.replace(WEBSITE_TYPE_NAME_TOKEN_RE, () => escapeHtml(websiteTypeName || ''));
  return result;
}

module.exports = {
  PASSWORD_PAGE_PLACEHOLDERS,
  getActivePasswordPageTemplate,
  buildFunctionalWidgetHtml,
  renderPasswordPageContent
};
