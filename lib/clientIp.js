// v1.1.9 hotfix Part 2 (see server.js's trust-proxy comment for Part 1's
// full history of the SAME underlying symptom): trust proxy correctly
// peels back a hop's address ONLY when that hop's address falls inside a
// private/reserved range (loopback, link-local, RFC1918/unique-local) --
// see server.js's 'loopback, linklocal, uniquelocal' setting and the long
// comment above it. Cloudflare's own edge addresses are genuinely PUBLIC
// (e.g. the reported 104.23.241.68), so trust proxy can never see through
// them, by design -- that's exactly why a visitor testing from Kenya was
// resolving to Belgium/EUR: req.ip was landing on Cloudflare's edge
// address, not the visitor's own. Widening trust proxy further would
// reopen the door to X-Forwarded-For spoofing (see server.js's comment on
// why 'true' is deliberately avoided), so this fixes it a different way
// instead of touching trust proxy at all.
//
// Cloudflare sets the CF-Connecting-IP header at its own edge to the
// original visitor's IP on every request it proxies. This can be trusted
// specifically because a client can never set it themselves and have it
// survive to this app -- Cloudflare's edge overwrites/strips whatever a
// client sends under that header name before forwarding the request
// onward, so whatever value arrives here came from Cloudflare's own
// infrastructure, not from anything a client controlled. If Cloudflare
// genuinely isn't in front of a given request (a direct hit on the
// Render URL, or Cloudflare not yet being in the path for some traffic),
// the header is simply absent and this falls straight through to the
// exact same req.ip resolution that was already in place -- additive and
// safe regardless of whether Cloudflare ends up fronting all, some, or
// none of this app's traffic.
//
// This must be used everywhere req.ip was previously read for a
// real-world-identity purpose -- geolocation/currency lookups and every
// IP-keyed rate limiter -- not just the admin geolocation health check
// that first surfaced this bug.

/**
 * Resolves the real client IP plus which source it came from, for
 * diagnostics. Prefer getRealClientIp() below for normal call sites that
 * just need the IP string.
 */
function resolveClientIp(req) {
  const raw = req.headers['cf-connecting-ip'];
  const cfIp = typeof raw === 'string' ? raw.trim() : '';

  if (cfIp.length > 0) {
    return { ip: cfIp, source: 'cf-connecting-ip', cfConnectingIpHeader: cfIp };
  }

  return { ip: req.ip, source: 'req.ip', cfConnectingIpHeader: null };
}

/**
 * The IP to use anywhere geolocation, currency resolution, or IP-based
 * rate limiting needs "the visitor's real address" -- CF-Connecting-IP
 * when Cloudflare set it, otherwise req.ip exactly as before this file
 * existed.
 */
function getRealClientIp(req) {
  return resolveClientIp(req).ip;
}

module.exports = { getRealClientIp, resolveClientIp };
