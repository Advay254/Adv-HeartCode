/**
 * v1.1.4 Part C: per-website-type password page CMS.
 *
 * v1.1.6 Part C: substitution itself now goes through lib/template.js's
 * shared substitutePlaceholders() engine — the same one the Template and
 * Email tabs use — instead of the two hand-rolled replace() passes this
 * module used through v1.1.5. This module still fully controls WHICH
 * tokens exist here, though: the two entries below are the only keys ever
 * passed into substitutePlaceholders() from this file, so nothing else
 * the general engine supports (loop syntax, any other field) has any way
 * to leak into a password page's available token set. That guarantee was
 * the entire reason this stayed hand-rolled through v1.1.4/v1.1.5 (this
 * page renders BEFORE any site content is unlocked — it IS the gate — so
 * it must never have access to the full raw/AI field set a site template
 * can reference); it's preserved here by construction, just enforced by
 * "this is the only map we build," not by "this is the only substitution
 * function that exists."
 *
 *   {{website_type_name}}         — plain text, HTML-escaped like any
 *                                    other admin-authored value dropped
 *                                    into markup. Passed as an ESCAPED
 *                                    value (substitutePlaceholders' third
 *                                    positional argument).
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
 *                                    Passed as a RAW value
 *                                    (substitutePlaceholders' fourth
 *                                    positional argument, added in this
 *                                    version specifically to support this
 *                                    call site — see that function's own
 *                                    comment) since it's real markup, not
 *                                    a text value that should be escaped.
 *
 * substitutePlaceholders() substitutes raw values BEFORE escaped values
 * (see its own comment) — the exact same order the old hand-rolled
 * version used (password_input_and_button's replace() ran first, then
 * website_type_name's) — so output for any existing saved password page
 * is byte-for-byte identical to before this refactor.
 */

const { getPool } = require('../db/init');
const { substitutePlaceholders } = require('./template');

const PASSWORD_PAGE_PLACEHOLDERS = ['website_type_name', 'password_input_and_button'];

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
 * html_content, via lib/template.js's shared engine (see this file's own
 * top-of-file comment for exactly what's passed where and why). Any OTHER
 * {{...}} token in the admin's HTML is left exactly as typed — there is
 * no raw/AI field set for this page to draw from, so anything else is
 * simply not a recognized placeholder here (the admin UI warns about this
 * at save time, same "warn, don't block" pattern as the Template/Email
 * tabs) — substitutePlaceholders() already leaves any {{key}} with no
 * matching entry in either map completely untouched, so this module
 * doesn't need its own separate "leave unknown tokens alone" logic on top
 * of that.
 */
function renderPasswordPageContent(htmlContent, websiteTypeName) {
  return substitutePlaceholders(
    htmlContent,
    { website_type_name: websiteTypeName || '' },
    {},
    { password_input_and_button: buildFunctionalWidgetHtml() }
  );
}

module.exports = {
  PASSWORD_PAGE_PLACEHOLDERS,
  getActivePasswordPageTemplate,
  buildFunctionalWidgetHtml,
  renderPasswordPageContent
};
