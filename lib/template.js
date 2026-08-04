/**
 * Escapes a string for safe inclusion inside HTML markup. Used on every
 * AI-generated value before it's dropped into a template — these are
 * content values, not markup, regardless of how trustworthy the AI
 * provider is assumed to be.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Replaces {{field_key}} placeholders in `html` with the corresponding
 * value from `values` (keyed by field_key), tolerating internal whitespace
 * like {{ field_key }} — the same tolerance the admin template editor uses
 * when checking for undefined placeholders (v1.0.2's routes/adminWebsiteTypes.js),
 * so a template that validates there also substitutes correctly here.
 *
 * Every value is HTML-escaped before substitution. The replacement is done
 * with a replacer FUNCTION, not a string, specifically so a value
 * containing "$" sequences (e.g. generated copy mentioning a price like
 * "$500") can't be misinterpreted as a special String.replace() pattern
 * (like $&, $', $1) — a plain string replacement would silently corrupt
 * output containing a literal "$".
 *
 * field_key itself is not attacker-controlled free text — it's restricted
 * to ^[a-z0-9_]+$ at creation time (v1.0.2) — so it's safe to interpolate
 * directly into the RegExp source here.
 */
function substitutePlaceholders(html, values) {
  let result = html;
  for (const key of Object.keys(values)) {
    const escaped = escapeHtml(values[key]);
    const placeholderRegex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    result = result.replace(placeholderRegex, () => escaped);
  }
  return result;
}

module.exports = { escapeHtml, substitutePlaceholders };
