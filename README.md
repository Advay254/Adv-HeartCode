# HeartCode

HeartCode is a client-facing website builder platform: a client picks a website type, fills in a short form, gets AI-polished copy dropped into a live preview, and (starting in v1.0.4) pays to have the site deployed for real.

## Deploy this to Render

1. Push this repo to GitHub.
2. Render dashboard → **New → Web Service** → connect the repo. Build command: `npm install`. Start command: `npm start`.
3. Add every env var from the table below under the service's **Environment** tab.
4. Provision a Postgres database on Supabase or Aiven, and paste its pooled connection string into `DATABASE_URL`.
5. Deploy.
6. Hit `https://<your-app>.onrender.com/health` — confirm `{ "status": "ok", "db": "connected" }`.
7. Visit `https://<your-app>.onrender.com/<ADMIN_PATH_SLUG>/login` and log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

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
| `ADMIN_PASSWORD` | Required | Admin login password, typed directly | Type your real password — no tool, no hashing |
| `SESSION_SECRET` | Required | Signs session cookies and derives CSRF tokens | Any long random string — a password generator app works fine |
| `ADMIN_PATH_SLUG` | Required | Secret URL segment where the admin dashboard lives | Make one up yourself, e.g. `raven-portal-92` |
| `ENCRYPTION_KEY` | Required | Encrypts Paystack/AI provider secrets at rest | Any string, any length — type a memorable phrase |
| `CLOUDFLARE_API_TOKEN` | Required | Deploys client sites to Cloudflare Pages | Cloudflare dashboard → My Profile → API Tokens → Create Token, with "Cloudflare Pages — Edit" permission |
| `CLOUDFLARE_ACCOUNT_ID` | Required | Identifies which Cloudflare account to deploy into | Cloudflare dashboard → any domain's Overview page → right sidebar under "API" |
| `RESEND_API_KEY` | Required | Sends the "your site is ready" email to clients | Resend dashboard → API Keys → Create API Key |
| `EMAIL_FROM_ADDRESS` | Required | The "from" address on that email | Any address on a domain you've verified in the Resend dashboard first |

A few notes on what "Required" means in practice, since the failure modes differ:
- Missing `DATABASE_URL` — the app won't boot at all (`initDB()` fails fast, `process.exit(1)`).
- Missing `SESSION_SECRET` — the app boots fine, but crashes the request on the first login/session attempt.
- Missing `ADMIN_PATH_SLUG` — the app boots fine, but the entire admin dashboard becomes silently unreachable (404 everywhere, by design — no fallback to a guessable path).
- Missing `ADMIN_USERNAME`/`ADMIN_PASSWORD` — the app boots fine, but login will never succeed.
- Missing `ENCRYPTION_KEY` — the app boots fine, and read-only admin pages still load, but saving a Paystack key or an AI provider key will fail.
- Missing `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` — the app boots fine, checkout and payment still work, but the deployment step fails right after payment succeeds (the client's money is taken and the deployment simply doesn't happen — set these before accepting real payments).
- Missing `RESEND_API_KEY`/`EMAIL_FROM_ADDRESS` — the app boots fine, deployment still succeeds, but the "your site is ready" email fails to send. The site is still live and shown directly on the checkout result page either way.

### Getting each value — no computer or terminal needed

Everything below assumes you're setting these directly in Render's dashboard (Environment tab), on your phone.

- **`ADMIN_USERNAME`** — type anything, e.g. `advay`.
- **`ADMIN_PASSWORD`** — type your real admin password, directly. No hashing, no tool — the app compares it as-is at login time.
- **`ADMIN_PATH_SLUG`** — type any word or short phrase nobody would guess, e.g. `wolfden-42`. No special characters needed beyond letters, numbers, and hyphens.
- **`SESSION_SECRET`** and **`ENCRYPTION_KEY`** — both just need to be long and unpredictable. Easiest option: open any password generator app (or a site like a password manager's built-in generator), generate a 40+ character password, and paste the same one into both fields (or generate two separately — either is fine, they don't need to match each other). If you ever do have Node/a terminal handy, `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` works too — it's just no longer required.

That's every value from the previous versions — nothing there needs a separate generation step or a website. The four new v1.0.4 variables (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS`) do each need a quick trip to Cloudflare's or Resend's dashboard — both work fine from a phone browser, no computer needed, just an extra step beyond "type something."


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
              substitution, rate limiting, Cloudflare Pages deployment, email,
              deployment finalization, the site-password bridge cache
middleware/ — Express middleware: admin slug gating, session auth, CSRF
routes/     — route handlers, split by area: admin pages, admin API (by
              feature), public pages (incl. checkout), public build API,
              the Paystack webhook
views/      — EJS templates, split into admin/ (dashboard) and public/
              (client-facing builder + checkout flow)
public/     — static assets served as-is (CSS, JS) — no server-rendered
              content lives here anymore as of v1.0.3
```

## Versions

- **v1.0.0** — Foundation: Express skeleton, Postgres bootstrapping (`site_settings`, `schema_version`), `/health`, Render deploy readiness.
- **v1.0.1** — Rebrand (SiteForge → HeartCode) + admin authentication: slug-gated login, signed session cookies, CSRF groundwork, brute-force protection on login.
- **v1.0.2** — Admin dashboard shell + Paystack config + AI provider config + website types/fields/versioned templates, all CSRF-protected, all backed by real DB transactions where single-row/single-active state matters.
- **v1.0.3** — Public builder flow (type selection → dynamic form → AI content-fill → sandboxed preview), plus this README and `DEPLOYMENT.md`.
- **v1.0.4** — Real payment and deployment: Paystack checkout, a signature-verified webhook, idempotent deployment finalization, live Cloudflare Pages deploys, and the "your site is ready" email via Resend.

## What's next

Payment and deployment are live as of v1.0.4. Not yet built: a way for you (the admin) to see the list of paid deployments and subscriber emails collected in `deployed_sites`/`subscriber_emails` — those tables exist and are being written to, but there's no dashboard page for them yet.
