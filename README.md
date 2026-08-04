# HeartCode

HeartCode is a client-facing website builder platform: a client picks a website type, fills in a short form, gets AI-polished copy dropped into a live preview, and (starting in v1.0.4) pays to have the site deployed for real.

## Deploy this to Render

1. Push this repo to GitHub.
2. Render dashboard → **New → Web Service** → connect the repo. Build command: `npm install`. Start command: `npm start`.
3. Add every env var from the table below under the service's **Environment** tab.
4. Provision a Postgres database on Supabase or Aiven, and paste its pooled connection string into `DATABASE_URL`.
5. Deploy.
6. Hit `https://<your-app>.onrender.com/health` — confirm `{ "status": "ok", "db": "connected" }`.
7. Visit `https://<your-app>.onrender.com/<ADMIN_PATH_SLUG>/login` and log in with `ADMIN_USERNAME` and the password behind `ADMIN_PASSWORD_HASH`.

Full step-by-step walkthrough with more detail and troubleshooting: see `DEPLOYMENT.md`.

## Tech stack

- Node.js + Express (CommonJS)
- PostgreSQL via `pg`, hosted on Supabase or Aiven
- EJS server-rendered views for both the admin dashboard and the public builder flow
- Deployed on Render (see `DEPLOYMENT.md`)
- Generated client sites are intended to deploy to Cloudflare Pages — not yet implemented, planned for a later version

## Environment variables

Not every variable is required — two have safe defaults. The table below reflects what the code actually does with each one, not just what's in `.env.example`.

| Variable | Required? | Purpose | Where do I get this? |
|---|---|---|---|
| `DATABASE_URL` | Required | PostgreSQL connection string | From your Postgres provider (Supabase/Aiven) |
| `PORT` | Optional | Port the server listens on — defaults to `3000` if unset, and Render overrides it automatically anyway | Leave it unset |
| `NODE_ENV` | Optional | Runtime mode (`development`/`production`) — not currently read by any of HeartCode's own code, but standard practice to set on Render | Type `production` |
| `ADMIN_USERNAME` | Required | Admin login username | Type anything you'll remember |
| `ADMIN_PASSWORD_HASH` | Required | bcrypt hash of the admin password | See below — this is the one that needs a tool |
| `SESSION_SECRET` | Required | Signs session cookies and derives CSRF tokens | Any long random string — a password generator app works fine |
| `ADMIN_PATH_SLUG` | Required | Secret URL segment where the admin dashboard lives | Make one up yourself, e.g. `raven-portal-92` |
| `ENCRYPTION_KEY` | Required | Encrypts Paystack/AI provider secrets at rest | Any string, any length — type a memorable phrase |

A few notes on what "Required" means in practice, since the failure modes differ:
- Missing `DATABASE_URL` — the app won't boot at all (`initDB()` fails fast, `process.exit(1)`).
- Missing `SESSION_SECRET` — the app boots fine, but crashes the request on the first login/session attempt.
- Missing `ADMIN_PATH_SLUG` — the app boots fine, but the entire admin dashboard becomes silently unreachable (404 everywhere, by design — no fallback to a guessable path).
- Missing `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH` — the app boots fine, but login will never succeed.
- Missing `ENCRYPTION_KEY` — the app boots fine, and read-only admin pages still load, but saving a Paystack key or an AI provider key will fail.

### Getting each value — no computer or terminal needed

Everything below assumes you're setting these directly in Render's dashboard (Environment tab), on your phone.

- **`ADMIN_USERNAME`** — type anything, e.g. `advay`.
- **`ADMIN_PATH_SLUG`** — type any word or short phrase nobody would guess, e.g. `wolfden-42`. No special characters needed beyond letters, numbers, and hyphens.
- **`SESSION_SECRET`** and **`ENCRYPTION_KEY`** — both just need to be long and unpredictable. Easiest option: open any password generator app (or a site like a password manager's built-in generator), generate a 40+ character password, and paste the same one into both fields (or generate two separately — either is fine, they don't need to match each other). If you ever do have Node/a terminal handy, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` works too — it's just no longer required.
- **`ADMIN_PASSWORD_HASH`** — this is the only one that genuinely needs a small tool, because it has to be a specific format (a bcrypt hash), not just any text. Two options:
  1. **Use the ready-made one below** — a working hash for a randomly generated password, so you can deploy right now and change it later whenever you want.
  2. **Generate your own** — search for a "bcrypt hash generator" that runs in your browser (many do the hashing entirely on-device, nothing sent anywhere), type your password, set the cost/rounds to `12`, and paste the result — it'll start with `$2a$` or `$2b$`.

**Ready-to-use starter credentials** (works right now, change it later whenever convenient):

```
ADMIN_PASSWORD_HASH=$2b$12$WzAJRciKJ.WYDkXubSwoqeCB.yaXatQ6ikvQdPpzJ5zjrmhpfRUze
```

Login password for that hash: `vkt3U2ksx2if`


## Local setup (optional — only needed if you're developing with Node installed on a computer; not required to deploy)

```bash
git clone <repo-url> heartcode
cd heartcode
npm install
cp .env.example .env
```

Fill in `.env` using the table and guidance above, then:

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
