/**
 * Tiny in-memory bridge for plaintext site passwords, between checkout
 * initiation and deployment finalization.
 *
 * WHY THIS EXISTS: only the SHA-256 hash of a site password is ever written
 * to Postgres (pending_deployments.site_password_hash) — the plaintext is
 * never persisted anywhere. But the "your site is ready" email needs to
 * tell the client their actual password (a hash can't be reversed), and
 * that email is sent later, from finalizeDeployment(), which is triggered
 * by either the Paystack webhook or the browser's callback redirect —
 * both of which run as entirely separate HTTP requests, long after the
 * original checkout POST has already responded. This cache is the bridge:
 * checkout initiation stores the plaintext here (keyed by reference),
 * finalizeDeployment reads and immediately deletes it (single-use) when
 * building the email.
 *
 * Never logged, never written to the database. Resets on server restart,
 * like the rate limiters elsewhere in this codebase — if the process
 * restarts between checkout and payment completion (rare; the whole flow
 * normally completes within minutes), the email simply omits the
 * password rather than erroring. The deployed site itself is unaffected
 * either way, since the password gate on the deployed page checks against
 * the hash baked into that page, not against anything in this cache.
 */
const cache = new Map(); // reference -> { password, createdAt }

function store(reference, plaintextPassword) {
  cache.set(reference, { password: plaintextPassword, createdAt: Date.now() });
}

/**
 * Reads and immediately deletes the entry. Single-use by design, so an
 * idempotent re-run of finalizeDeployment for an already-finalized
 * reference never re-reads (or re-sends) a stale password.
 */
function takeOnce(reference) {
  const entry = cache.get(reference);
  cache.delete(reference);
  return entry ? entry.password : null;
}

/**
 * Sweeps entries older than maxAgeMs — for abandoned checkouts that never
 * completed payment, so this cache doesn't grow unbounded. Called from the
 * same periodic cleanup job in server.js that sweeps pending_deployments.
 */
function pruneExpired(maxAgeMs) {
  const now = Date.now();
  for (const [reference, entry] of cache.entries()) {
    if (now - entry.createdAt > maxAgeMs) {
      cache.delete(reference);
    }
  }
}

module.exports = { store, takeOnce, pruneExpired };
