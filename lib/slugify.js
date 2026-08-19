// v1.0.8: extracted so there's exactly ONE slug-sanitization
// implementation in the codebase. Previously there were two near-identical
// copies of this same logic — a local `slugify()` in
// routes/adminWebsiteTypes.js (for website type slugs) and separate,
// slightly different inline logic inside lib/cloudflarePages.js's
// buildProjectName (for deploy project names). Both now import this.
// Part B's deploy-slug-pattern resolution (lib/deploySlug.js) reuses it
// too, per that feature's own requirement to reuse the existing function
// rather than write a third implementation.

/**
 * Lowercases, strips to URL/subdomain-safe characters, collapses repeated
 * separators, trims leading/trailing separators. Deliberately simple —
 * every caller further constrains/truncates the result for its own
 * context (website type slugs check DB uniqueness; Cloudflare project
 * names have their own length limit) rather than this function trying to
 * guess a caller-specific length bound.
 */
function slugify(input) {
  return String(input)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { slugify };
