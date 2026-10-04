# Architecture

![](assets/divider.svg)

## Stack

- Node.js and Express 4 (CommonJS), EJS views
- PostgreSQL through `pg`, with schema and migrations in `db/init.js`
- Tailwind CSS compiled into two separate bundles, public and admin, sharing one palette in `tailwind.theme.js`
- `zod` for validation, `helmet` for headers, `sharp` and `multer` for image fields
- Paystack for payments, ClarityHeart for hosting, a configurable provider for email

## Repository layout

```
db/           schema, migrations, getPool()
lib/          framework-free helpers (auth, crypto, templates, currency, reviews, promotions, ...)
middleware/   admin slug gating, session auth, CSRF
routes/       admin API by feature, public pages, build API, webhooks
views/        admin/ and public/ EJS, plus partials/
public/       static assets, admin.js, site.js, embed.js, review.css, built CSS
src/          Tailwind sources (never edit the built output)
docs/         everything you are reading
```

## Ideas worth knowing

**Secret admin path.** The dashboard lives under `ADMIN_PATH_SLUG`. Requests are rewritten to an internal path that is never mounted publicly, so `/admin` always 404s.

**Strict CSP, no inline scripts.** Page behaviour lives in `public/dashboard-assets/admin.js` and `public/site.js`, dispatched by `data-page` on the body. Pages that must stay standalone (the review page) load only their own files.

**Idempotent finalization.** The payment webhook and the browser callback can race. `finalizeDeployment()` takes a row lock so exactly one deployment and one email happen.

**Webhook order.** The webhook router mounts before the public router so its raw body is never consumed by a JSON parser. Body parsers are scoped to the routes that need them.

**Versioned content.** Templates, emails, password pages, legal pages and reminders are new rows per save with a pointer to the active one, so rollback is instant. The latest 4 versions are kept.

**Migrations.** Additive and repeatable: `ADD COLUMN IF NOT EXISTS`, constraints re-added `NOT VALID`, and `ON DELETE SET NULL` so a parent delete never hides child content.

**Rate limiting.** `lib/rateLimit.js` is a generic sliding window keyed by the real client IP.

**Admin UI.** Cards, entry lists, hints and badges come from one stylesheet. Use `.admin-form-hint` for hint text, never `.admin-help`, which is a collapsible panel.

## Testing approach

Run it for real: a local Postgres, a running server, real HTTP, and a headless browser for anything visual. Mock only external services. Say plainly when a check is indirect.
