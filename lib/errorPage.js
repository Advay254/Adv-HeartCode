/**
 * v1.1.6 Part A: the HTML branch of the new global error-handling
 * middleware (see server.js) renders through this, NOT through
 * res.render()/EJS — deliberately.
 *
 * This has to be the one page in the entire app that literally cannot
 * fail to render. res.render('public/some-view', ...) re-enters the
 * whole EJS include chain (public-head.ejs, public-footer.ejs, etc.),
 * which assumes res.locals.siteSettings/activeScripts/landingContent
 * already exist — set by routes/public.js's own router-level
 * middleware. An error thrown from somewhere that middleware never ran
 * (a completely different router, or a failure before it) would hit
 * this handler with none of those locals set, and public-head.ejs reads
 * `siteSettings.site_title` with no typeof guard — throwing a SECOND,
 * unhandled error from inside the error handler itself. Express's
 * documented behavior if an error handler itself errors is to fall
 * through to its own built-in default handler, which sends a raw stack
 * trace — exactly what this whole feature exists to prevent.
 *
 * So: a plain string of static HTML, zero EJS, zero dependence on
 * res.locals, zero includes. It still reuses the real design system
 * (hc-panel, the pill-button classes, the same Anton/Poppins font
 * stack) by linking the same two compiled stylesheets every public page
 * already loads (/styles/main.css, /site.css) — both plain static files
 * served by express.static, unaffected by anything that broke elsewhere.
 * No <script> tags at all, so this needs no CSP allowance beyond what's
 * already global (script-src 'self' with nothing inline to execute).
 */
function renderErrorPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Something went wrong</title>
<link rel="stylesheet" href="/styles/main.css">
<link rel="stylesheet" href="/site.css">
</head>
<body class="bg-white font-poppins text-hc-ink antialiased">
<main class="px-4 py-16 sm:px-6">
  <div class="hc-panel mx-auto max-w-md border border-black/5 p-6 text-center sm:p-8">
    <h1 class="font-display text-2xl uppercase tracking-wide text-hc-ink">Something went wrong</h1>
    <p class="mt-3 text-sm text-hc-ink/60">We hit a snag handling that request. Nothing on your end caused this — please try again in a moment.</p>
    <a href="/" class="hc-pill-btn-outline mt-6 inline-flex">&larr; Back home</a>
  </div>
</main>
</body>
</html>`;
}

module.exports = { renderErrorPageHtml };
