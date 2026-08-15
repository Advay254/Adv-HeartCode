# HeartCode

HeartCode is a client-facing website builder platform: a client picks a website type, fills in a short form, gets AI-polished copy dropped into a live preview, and (starting in v1.0.4) pays to have the site deployed for real.

## Deploy this to Render

1. Push this repo to GitHub.
2. Render dashboard → **New → Web Service** → connect the repo. Build command: **`npm install && npm run build:css`** — not just `npm install` anymore as of v1.0.7 (see "Build command" note below; missing this half breaks every public page's styling). Start command: `npm start`.
3. Add every env var from the table below under the service's **Environment** tab.
4. Provision a Postgres database on Supabase or Aiven, and paste its pooled connection string into `DATABASE_URL`.
5. Deploy.
6. Hit `https://<your-app>.onrender.com/health` — confirm `{ "status": "ok", "db": "connected" }`.
7. Visit `https://<your-app>.onrender.com/<ADMIN_PATH_SLUG>/login` and log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

Full step-by-step walkthrough with more detail and troubleshooting: see `DEPLOYMENT.md`.

### Build command — read this if you're updating an existing Render service

As of v1.0.7, the public-facing pages (landing page, type gallery) are styled with Tailwind CSS, compiled ahead of time into `public/styles/main.css` by a build step — it is **not** checked into the repo as the source of truth; `src/styles/main.css` is the real source, and `public/styles/main.css` is generated from it.

If you already have a Render service running from an earlier version, you need to **update its Build Command** in the Render dashboard (Settings → Build Command) from `npm install` to:
```
npm install && npm run build:css
```
This is a setting on the Render service itself, not something in the repo — updating the code alone (applying this version's zip) does **not** change it. If you forget, `npm run build:css` never runs, `public/styles/main.css` never gets (re)generated on that deploy, and the landing page / type gallery load with no styling.

As a safety net, this delivery includes a real, already-built `public/styles/main.css` committed alongside the source files — so the site won't be broken even if you deploy without updating the build command first. But it will go stale the moment any future change touches the Tailwind source files or view markup, so update the build command as soon as you can rather than relying on this indefinitely.

## Tech stack

- Node.js + Express (CommonJS)
- PostgreSQL via `pg`, hosted on Supabase or Aiven
- EJS server-rendered views for both the admin dashboard and the public builder flow
- Tailwind CSS (CLI-compiled, v1.0.7) for the public-facing landing page and type gallery — the admin dashboard keeps its own hand-written stylesheet, untouched
- Deployed on Render (see `DEPLOYMENT.md`)
- Generated client sites deploy live to Cloudflare Pages, paid for via Paystack

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
npm run build:css
npm start
```

`npm run build:css` compiles `src/styles/main.css` into `public/styles/main.css` (Tailwind CLI) — needed once before first run, and again any time you change `src/styles/main.css`, `tailwind.config.js`, or add new Tailwind classes to a public view (there's no watch mode wired up; re-run it manually after each such change during local development).

The server runs `initDB()` on every boot, which creates/updates all tables and is safe to run repeatedly — it fails fast (`process.exit(1)`) rather than serving traffic against a broken database.

Once running, visit `http://localhost:3000/` for the public builder flow, or `http://localhost:3000/<ADMIN_PATH_SLUG>/login` for the admin dashboard. A fresh database has no website types yet, so the homepage will show "nothing available right now" until you create one from the dashboard.

## Project structure

```
db/         — database bootstrapping: init.js (schema, migrations, getPool())
lib/        — framework-free helpers: crypto, auth, ai-provider, paystack, template
              substitution (incl. v1.0.6 loop syntax), currency conversion,
              geolocation, rate limiting, Cloudflare Pages deployment, email,
              deployment finalization, the site-password bridge cache, site
              settings + site scripts reads (v1.0.7, cached), icon loading (v1.0.7)
middleware/ — Express middleware: admin slug gating, session auth, CSRF
routes/     — route handlers, split by area: admin pages, admin API (by
              feature, incl. v1.0.6's generic site-settings API and v1.0.7's
              site-settings/scripts APIs), public pages (incl. checkout,
              landing page, type gallery), public build API, the Paystack webhook
views/      — EJS templates, split into admin/ (dashboard) and public/
              (client-facing landing page, type gallery, builder + checkout flow)
public/     — static assets: dashboard-assets/ (admin CSS/JS), site.css/site.js
              (public builder flow), site-interactions.js (v1.0.7 scroll-reveal/
              count-up), icons/ (v1.0.7, 40 bundled Lucide SVGs), styles/main.css
              (v1.0.7, BUILT from src/styles/main.css — see "Build command" above)
src/        — v1.0.7: Tailwind source. src/styles/main.css is the real source of
              truth for the public design system; public/styles/main.css is
              generated from it and should not be hand-edited
```

## Versions

- **v1.0.0** — Foundation: Express skeleton, Postgres bootstrapping (`site_settings`, `schema_version`), `/health`, Render deploy readiness.
- **v1.0.1** — Rebrand (SiteForge → HeartCode) + admin authentication: slug-gated login, signed session cookies, CSRF groundwork, brute-force protection on login.
- **v1.0.2** — Admin dashboard shell + Paystack config + AI provider config + website types/fields/versioned templates, all CSRF-protected, all backed by real DB transactions where single-row/single-active state matters.
- **v1.0.3** — Public builder flow (type selection → dynamic form → AI content-fill → sandboxed preview), plus this README and `DEPLOYMENT.md`.
- **v1.0.4** — Real payment and deployment: Paystack checkout, a signature-verified webhook, idempotent deployment finalization, live Cloudflare Pages deploys, and the "your site is ready" email via Resend.
- **v1.0.5** — Security hardening: Helmet CSP with every inline `<script>` externalized to `public/dashboard-assets/admin.js`/`public/site.js`, same-origin CORS on every API surface except the Paystack webhook (deliberately — see `HANDOFF.md`), a global rate limiter, Zod validation across every route (closed a real crash vector — a malformed numeric ID could previously take the whole process down), and a real admin dashboard for deployments and subscribers. Also fixed a real pre-existing bug present since v1.0.4: the public router's unscoped `express.json()` was silently consuming the Paystack webhook's raw body before its signature check ever saw it.
- **v1.0.6** — Currency handling, per-website-type AI configuration, and loop-capable templates:
  - **Real currency conversion.** `website_types.price_kes` was never actually KES — it was a raw number with a hardcoded "KES" label and zero conversion anywhere. It's replaced by `price_usd` as the real source of truth (the old column is left in place, unused, for backward compatibility — nothing reads it anymore). Prices are now geolocated and converted for display in the visitor's own currency (via `open.er-api.com`, cached and refreshed every 24h), with a strict rule: if no rate is available for a currency, the display always falls back to correctly-labeled USD rather than ever showing a raw number under the wrong currency code. Kenyan visitors get a dedicated toggle (Payments page in the dashboard) — USD by default, flippable to real KES charging once M-Pesa is set up on the Paystack account. A separate, real bug was also fixed in the same pass: the Paystack `currency` field was never being sent at all in earlier versions, meaning charges silently relied on whatever currency the Paystack account itself defaulted to, regardless of the number sent as `amount`. It's now sent explicitly, snapshotted at checkout time and never recomputed later (so a mid-flight exchange-rate refresh can't cause a mismatch at verification).
  - **Per-website-type AI configuration.** AI is now off by default for every website type. Each type can be individually switched on from its dashboard page (new "AI" tab), with its own system prompt, user-prompt template (built from that type's raw fields), and a set of "output fields" describing exactly what structured JSON to request back from the configured provider — flat text, a list of texts, or a list of objects with a defined shape. When a type has AI off, form submissions go straight to the template with zero AI calls and zero cost; the AI provider is never even queried. A lighter rate limit applies to non-AI types (20/hour) versus AI-enabled ones (5/hour, unchanged from earlier versions), since only the latter cost real tokens.
  - **Loop-capable templates.** Templates can now use `{{#each field}}...{{/each}}` to render a list-shaped AI output field — `{{this}}` for a list of plain text, `{{this.sub_key}}` for a list of objects. Saving a template now also warns (without blocking) if a flat placeholder is used against a list-shaped field, or vice versa, so a shape mistake is caught immediately rather than silently rendering blank on a live client preview.
  - A real, pre-existing bug (present since the original template substitution was written) was also fixed in the same file: a genuinely-blank optional form field previously rendered as the literal text `"undefined"` in client-facing output.
- **v1.0.7** — Real design system, marketing landing page, type gallery, and a script injection manager:
  - **Design system.** Anton (display) + Inter (body) via Google Fonts, `--hc-blue` (#183fad) / `--hc-yellow` (#F1BF0A) as CSS custom properties, compiled through a real Tailwind CSS v3 pipeline (`src/styles/main.css` → `public/styles/main.css`, see "Build command" above — **this changes what Render's Build Command needs to be**). Two reusable component classes: `.hc-pill-btn` (pure-CSS hover fill-sweep, no JS) and `.hc-panel` (the site's signature asymmetric-corner card shape, with a uniform-rounding fallback below 480px). Scroll-reveal and a count-up stat number run off one shared `IntersectionObserver` in `public/site-interactions.js`, respecting `prefers-reduced-motion`. Scoped entirely to public-facing views — the admin dashboard's own stylesheet and look are untouched.
  - **Landing page (`/`)** — nav, hero, a genuinely-sequential "how it works" (pick a type → fill in details → get your live site), an admin-editable stats counter, a live teaser of real website types pulled from the DB (converted prices, v1.0.6's currency work included), a trust line, and a footer.
  - **Type gallery (`/explore`)** — replaces the old bare list that used to live at `/` with a real card grid: curated icon, name, description, converted price, and a "Build this" CTA per type. `/build/:slug` is unaffected — same route, same form, just linked to differently now.
  - **Site Settings** (new admin page) — site title, meta description, favicon URL, OG share image URL, and the landing page's stats number/label, all editable without a redeploy and reflected on public pages within the same request (the read-side cache is actively invalidated on save, not just left to expire).
  - **Script injection manager** (new admin page) — paste raw third-party script tags/inline code (analytics, pixels, etc.), targeting three placements (`<head>`, right after `<body>` opens, right before `</body>` closes), capped at 3 per placement. Rendered on **public pages only** — never reaches an admin-authenticated page. This required a real, deliberate CSP change: `script-src`/`connect-src`/`img-src` are loosened to `https:` (plus `'unsafe-inline'` for `script-src`, since real analytics snippets are often inline code, not just an external `src`) on public pages specifically, while the admin dashboard keeps the original strict `script-src 'self'` policy completely unchanged. `unsafe-eval` was deliberately never added to either policy.
  - **40 curated icons** (real Lucide SVGs, bundled as static files, inlined via a small cached loader) — a fixed set for layout/UI use, plus a smaller admin-selectable subset (`website_types.icon_name`, new column) shown on type gallery/teaser cards.

## What's next

Nothing is currently scoped for v1.0.8 yet. v1.0.7's own build prompt already flagged its own follow-ups: the admin dashboard's visual design, the live preview page, and the form/checkout/callback pages were deliberately left untouched this version (only their `<head>`/script-injection plumbing changed, not their layout) — a visual pass on those is expected to be a future version. Real photography/mockup assets for the landing page's hero are still a placeholder gradient panel (clearly marked in `views/public/landing.ejs` with the exact `<img>` tag to swap in once a real asset exists). Beyond that, the items already flagged in `HANDOFF.md`'s "Known gaps" remain open — most notably, there's still no global Express error-handling middleware wrapping every async route handler, and the Cloudflare Pages deploy path still hasn't completed a real successful deployment in testing (no network access to `api.cloudflare.com` from the build/test sandbox) — worth a deliberate first real-world test with actual credentials.
