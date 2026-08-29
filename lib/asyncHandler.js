/**
 * v1.1.6 Part A: the actual mechanism that makes the new global error
 * middleware (see server.js) able to catch anything unhandled inside an
 * async route handler.
 *
 * Express 4 (what this app runs — see package.json) does NOT automatically
 * forward a rejected Promise from an async handler to `next(err)`. Without
 * this wrapper, an async handler that throws (or awaits something that
 * rejects) with no surrounding try/catch produces an unhandled promise
 * rejection — which, on Node 15+ (including whatever version Render
 * actually runs), terminates the whole process by default. This was
 * flagged as the single most important open reliability gap in
 * HANDOFF.md's "Known gaps" section (carried over from the v1.0.5 zod
 * audit, which only closed the malformed-ID special case, not the general
 * pattern) — this wrapper, applied to every async route handler across
 * every router in routes/, is what actually closes it.
 *
 * Usage: `router.get('/path', asyncHandler(async (req, res) => { ... }))`
 * — wraps the handler function itself, not the route registration. Any
 * number of handlers/middleware can precede it in the same router.METHOD()
 * call (e.g. `requireCsrf`, `express.json(...)`) — only the actual async
 * function needs wrapping, since those are the only functions in this
 * codebase capable of producing an unhandled rejection in the first place
 * (requireCsrf is synchronous; requireAdminSession is async but already
 * fully try/catches its own body — see middleware/requireAdminSession.js).
 *
 * Deliberately tiny and dependency-free — this is exactly the kind of
 * "smallest possible fix" this project prefers (see e.g. lib/reorder.js's
 * own extraction history) rather than pulling in a package like
 * express-async-handler for a five-line function.
 */
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
