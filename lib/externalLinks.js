/**
 * v1.1.5 Part A: post-processes rendered site HTML so any external link
 * opens in a new tab, rather than navigating the visitor away from the
 * (previewed-in-iframe, or eventually deployed) site itself.
 *
 * Applied in TWO places, deliberately, not one:
 *   - routes/apiBuild.js, on the html returned for the interactive
 *     preview (this app's own iframe now runs untrusted third-party-ish
 *     admin-pasted script via allow-scripts — an un-target-blanked
 *     external link would navigate the SANDBOXED iframe itself away, with
 *     no back button, since the iframe has no navigation chrome).
 *   - lib/finalizeDeployment.js, on pending.rendered_html right before it
 *     ships to Cloudflare Pages, so the actually-deployed site behaves
 *     the same way for real visitors, not just inside this app's preview.
 * In today's checkout flow the client happens to echo back the exact
 * same html string the preview already processed (see
 * routes/public.js's checkout handler), so applying this twice is
 * currently redundant in the common case — but idempotent (checks for an
 * existing target/rel before adding either), and it's the only way to
 * guarantee the actually-deployed bytes are correct regardless of that
 * client-trust detail, rather than relying on an implicit assumption
 * about how two otherwise-independent code paths happen to be wired
 * together today.
 */

// Absolute URL = has an explicit http(s): scheme, or is protocol-relative
// ("//host/path"). A bare leading "/" (site-root-relative) is NOT
// external — same origin regardless of what that origin turns out to be
// — and is deliberately excluded here, along with #anchors, mailto:,
// tel:, javascript:, and ordinary relative paths ("about.html"), all of
// which stay untouched as in-page/same-site navigation.
const ABSOLUTE_URL_RE = /^(https?:)?\/\//i;

function isExternalHref(href) {
  return ABSOLUTE_URL_RE.test(href.trim());
}

function extractHref(attrs) {
  const match = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i);
  if (!match) return null;
  return match[1] !== undefined ? match[1] : (match[2] !== undefined ? match[2] : match[3]);
}

/**
 * Adds target="_blank" rel="noopener noreferrer" to every external <a>
 * tag that doesn't already have its own target/rel — an admin's
 * deliberate existing target="_self" (or any other explicit choice) is
 * left exactly as authored, "added if not already present" per this
 * feature's own spec. An <a> with no href at all (an in-page JS-driven
 * anchor, or a named anchor with no href) is left completely untouched.
 */
function addTargetBlankToExternalLinks(html) {
  return html.replace(/<a\b([^>]*)>/gi, (fullMatch, attrs) => {
    const href = extractHref(attrs);
    if (href === null || !isExternalHref(href)) return fullMatch;

    const hasTarget = /\btarget\s*=/i.test(attrs);
    const hasRel = /\brel\s*=/i.test(attrs);

    let newAttrs = attrs;
    if (!hasTarget) newAttrs += ' target="_blank"';
    if (!hasRel) newAttrs += ' rel="noopener noreferrer"';

    return `<a${newAttrs}>`;
  });
}

module.exports = { addTargetBlankToExternalLinks, isExternalHref };
