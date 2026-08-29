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
 * v1.1.3: wraps the first occurrence of `word` inside `text` in a
 * `<span class="${colorClass}">` — the "highlight one word in this
 * heading" pattern used by hero/feature_cards/split_image_text/bullet_list
 * on the redesigned landing page. Everything outside the match is HTML
 * escaped via escapeHtml() above; `word` itself is escaped too, so this
 * is safe to output with EJS's raw `<%-%>` even though `text`/`word` are
 * admin-authored content, not trusted markup. Returns the plain escaped
 * text unchanged (no span) if `word` is empty or isn't actually found in
 * `text` — a stale/mistyped highlighted_word degrades to no highlight,
 * never a broken/missing render.
 */
function highlightWord(text, word, colorClass) {
  const safeText = String(text || '');
  const idx = word ? safeText.indexOf(word) : -1;
  if (idx === -1) return escapeHtml(safeText);
  return escapeHtml(safeText.slice(0, idx))
    + '<span class="' + colorClass + '">' + escapeHtml(word) + '</span>'
    + escapeHtml(safeText.slice(idx + word.length));
}

// v1.0.6: loop syntax for array-shaped AI output fields. Deliberately
// minimal -- this is NOT a general templating engine, just the smallest
// extension that supports the two array shapes ai_output_fields can
// produce (array_of_strings via {{this}}, array_of_objects via
// {{this.sub_key}}). No nesting, no conditionals, no expressions. The
// block-content capture is non-greedy specifically because nested
// {{#each}} is out of scope (see routes/adminWebsiteTypes.js's AI output
// field validation, which only allows flat string sub-properties in
// object_shape -- there is no legitimate shape that would need nesting).
const EACH_BLOCK_RE = /\{\{#each\s+([a-zA-Z0-9_]+)\s*\}\}([\s\S]*?)\{\{\/each\}\}/g;
const THIS_SUB_RE = /\{\{\s*this\.([a-zA-Z0-9_]+)\s*\}\}/g;
const THIS_RE = /\{\{\s*this\s*\}\}/g;

/**
 * Expands every {{#each key}}...{{/each}} block in `html` using
 * `arrayValues[key]` (an array of strings, for {{this}}, or an array of
 * objects, for {{this.sub_key}}). A key referenced in a loop that isn't
 * actually present in `arrayValues` (undefined field, or a field that
 * isn't array-shaped) renders as an empty string rather than throwing or
 * leaving raw {{#each}} syntax visible to a client -- the admin is warned
 * about this exact mismatch at template SAVE time instead (see
 * routes/adminWebsiteTypes.js's PUT /:id/template shape validation), so by
 * the time this runs at request time it's a last-resort fallback, not the
 * primary line of defense.
 *
 * Runs BEFORE substitutePlaceholders's flat pass so that every {{this}} /
 * {{this.sub_key}} token is fully resolved (or removed, if the array was
 * unknown) before the flat pass ever sees the HTML -- this keeps the two
 * passes cleanly separated with no ordering ambiguity.
 */
function expandLoops(html, arrayValues) {
  const values = arrayValues || {};
  return html.replace(EACH_BLOCK_RE, (fullMatch, key, blockContent) => {
    const arr = values[key];
    if (!Array.isArray(arr)) return '';

    return arr
      .map(item => {
        if (item !== null && typeof item === 'object') {
          return blockContent.replace(THIS_SUB_RE, (m, subKey) => {
            const v = item[subKey];
            return escapeHtml(v === undefined || v === null ? '' : v);
          });
        }
        return blockContent.replace(THIS_RE, () =>
          escapeHtml(item === undefined || item === null ? '' : item)
        );
      })
      .join('');
  });
}

/**
 * Replaces {{field_key}} placeholders in `html` with the corresponding
 * value from `values` (keyed by field_key), tolerating internal whitespace
 * like {{ field_key }} — the same tolerance the admin template editor uses
 * when checking for undefined placeholders (v1.0.2's routes/adminWebsiteTypes.js),
 * so a template that validates there also substitutes correctly here.
 *
 * Every value in `values` is HTML-escaped before substitution. The
 * replacement is done with a replacer FUNCTION, not a string, specifically
 * so a value containing "$" sequences (e.g. generated copy mentioning a
 * price like "$500") can't be misinterpreted as a special
 * String.replace() pattern (like $&, $', $1) — a plain string replacement
 * would silently corrupt output containing a literal "$".
 *
 * field_key itself is not attacker-controlled free text — it's restricted
 * to ^[a-z0-9_]+$ at creation time (v1.0.2) — so it's safe to interpolate
 * directly into the RegExp source here.
 *
 * `arrayValues` (v1.0.6, optional, defaults to {}) is a SEPARATE map for
 * array-shaped AI output fields (array_of_strings / array_of_objects),
 * expanded via {{#each key}}...{{/each}} BEFORE this function's own flat
 * {{key}} pass runs (see expandLoops above). `values` and `arrayValues`
 * never share a key in practice -- ai_output_fields.output_key is
 * validated against template_fields.field_key (and against other output
 * keys) at save time specifically so the two namespaces can't collide.
 * Existing two-argument callers are unaffected: arrayValues defaults to an
 * empty object, so expandLoops is a no-op when there's nothing to loop
 * over.
 *
 * `rawValues` (v1.1.6, optional, defaults to {}) is a THIRD, separate map
 * for the rare token that must expand to real markup rather than escaped
 * text -- added specifically so lib/passwordPageTemplates.js's
 * {{password_input_and_button}} could move onto this shared engine
 * instead of hand-rolling its own substitution (see that file's own
 * comment for the full history). Substituted BEFORE the escaped `values`
 * pass, on the original `html` -- matching the exact order the old
 * hand-rolled version used (password_input_and_button first, then
 * website_type_name) so behavior for any existing caller stays
 * byte-for-byte identical. Existing two- and three-argument callers are
 * unaffected: rawValues defaults to an empty object, so this pass is a
 * no-op when there's nothing raw to substitute.
 */
function substitutePlaceholders(html, values, arrayValues, rawValues) {
  let result = expandLoops(html, arrayValues);

  for (const key of Object.keys(rawValues || {})) {
    const raw = rawValues[key];
    const value = raw === undefined || raw === null ? '' : String(raw);
    const placeholderRegex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    result = result.replace(placeholderRegex, () => value);
  }

  for (const key of Object.keys(values)) {
    const raw = values[key];
    // v1.0.6 fix: an omitted optional field previously rendered the
    // literal text "undefined" (escapeHtml(undefined) -> String(undefined)
    // -> "undefined") -- a real, pre-existing bug in this function
    // surfaced by adding test coverage for the loop extension, not
    // something new to this version. Guarded the same way expandLoops
    // already guards missing/null loop item values.
    const escaped = escapeHtml(raw === undefined || raw === null ? '' : raw);
    const placeholderRegex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    result = result.replace(placeholderRegex, () => escaped);
  }
  return result;
}

/**
 * Same placeholder-substitution mechanics as substitutePlaceholders
 * (replacer-function based, so a literal "$" in a value can't be
 * misinterpreted as a String.replace() special pattern), but WITHOUT
 * HTML-escaping. Used exclusively for building AI prompts (v1.0.6's
 * per-website-type ai_system_prompt / ai_user_prompt_template) -- that
 * output is going into an LLM's context window, not into markup, so
 * escaping would just inject literal "&amp;"-style noise into the prompt
 * text instead of protecting anything.
 */
function substitutePlainText(text, values) {
  let result = text;
  for (const key of Object.keys(values)) {
    const raw = values[key];
    const value = raw === undefined || raw === null ? '' : String(raw);
    const placeholderRegex = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
    result = result.replace(placeholderRegex, () => value);
  }
  return result;
}

module.exports = { escapeHtml, substitutePlaceholders, substitutePlainText, highlightWord };
