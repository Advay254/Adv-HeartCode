# HeartCode

HeartCode is a client-facing website builder platform: a client picks a website type, fills in a short form, gets AI-polished copy dropped into a live preview, and (starting in v1.0.4) pays to have the site deployed for real.

## Tech stack

- Node.js + Express (CommonJS)
- PostgreSQL via `pg`, hosted on Supabase or Aiven
- EJS server-rendered views for both the admin dashboard and the public builder flow
- Deployed on Render (see `DEPLOYMENT.md`)
- Generated client sites are intended to deploy to Cloudflare Pages — not yet implemented, planned for a later version

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Supabase/Aiven pooled URI) |
| `PORT` | Port the server listens on. Render sets this automatically; mainly relevant for local dev |
| `NODE_ENV` | `development` or `production` |
| `ADMIN_USERNAME` | Admin login username (plain — not a secret by itself, but keep it private) |
| `ADMIN_PASSWORD_HASH` | bcrypt hash of the admin password — the plaintext password is never stored or compared |
| `SESSION_SECRET` | 32+ byte random string used to HMAC-sign session cookies and derive CSRF tokens |
| `ADMIN_PATH_SLUG` | Secret URL segment where the admin dashboard lives, e.g. `/mgmt-9f2a/` — there is no `/admin` route; it always 404s by design |
| `ENCRYPTION_KEY` | 32-byte hex key (AES-256-GCM) used to encrypt Paystack and AI provider secrets at rest in Postgres |

That's the full list as of v1.0.3 — nothing new was added this version (Paystack and AI provider credentials are stored encrypted in the database via the admin dashboard, not as env vars).

## Local setup

```bash
git clone <repo-url> heartcode
cd heartcode
npm install
cp .env.example .env
```

Fill in `.env`:

- `DATABASE_URL` — point at a local or hosted Postgres instance
- Generate the rest with these one-liners (same ones referenced in `.env.example`):

```bash
# ADMIN_PASSWORD_HASH
node -e "console.log(require('bcrypt').hashSync('your-password', 12))"

# SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ADMIN_PATH_SLUG
node -e "console.log(require('crypto').randomBytes(8).toString('hex'))"

# ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then:

```bash
npm start
```

The server runs `initDB()` on every boot, which creates/updates all tables and is safe to run repeatedly — it fails fast (`process.exit(1)`) rather than serving traffic against a broken database.

Once running, visit `http://localhost:3000/` for the public builder flow, or `http://localhost:3000/<ADMIN_PATH_SLUG>/login` for the admin dashboard. A fresh database has no website types yet, so the homepage will show "nothing available right now" until you create one from the dashboard.

## Project structure

```
db/         — database bootstrapping: init.js (schema, migrations, getPool())
lib/        — framework-free helpers: crypto, auth, ai-provider, paystack, template
              substitution, rate limiting
middleware/ — Express middleware: admin slug gating, session auth, CSRF
routes/     — route handlers, split by area: admin pages, admin API (by
              feature), public pages, public build API
views/      — EJS templates, split into admin/ (dashboard) and public/
              (client-facing builder flow)
public/     — static assets served as-is (CSS, JS) — no server-rendered
              content lives here anymore as of v1.0.3
```

## Versions

- **v1.0.0** — Foundation: Express skeleton, Postgres bootstrapping (`site_settings`, `schema_version`), `/health`, Render deploy readiness.
- **v1.0.1** — Rebrand (SiteForge → HeartCode) + admin authentication: slug-gated login, signed session cookies, CSRF groundwork, brute-force protection on login.
- **v1.0.2** — Admin dashboard shell + Paystack config + AI provider config + website types/fields/versioned templates, all CSRF-protected, all backed by real DB transactions where single-row/single-active state matters.
- **v1.0.3** — Public builder flow (type selection → dynamic form → AI content-fill → sandboxed preview), plus this README and `DEPLOYMENT.md`.

## What's next

v1.0.4 is expected to add payment — the "Deploy this site" button on the preview page currently links to a placeholder `/build/:slug/checkout` stub that just says so.
