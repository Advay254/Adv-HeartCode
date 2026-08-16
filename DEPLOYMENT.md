# Deploying HeartCode to Render

> This is the detailed version of the "Deploy this to Render" checklist in `README.md` — start there for the short version.

## 1. Create the Web Service

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In the Render dashboard: **New → Web Service**, then connect the repo.
3. Runtime: **Node**.
4. Build command: **`npm install && npm run build:css`** — as of v1.0.7, this is not just `npm install` anymore. `npm run build:css` compiles the Tailwind source (`src/styles/main.css`) into the actual stylesheet the landing page and type gallery load (`public/styles/main.css`). If you're updating an EXISTING Render service rather than creating a new one, you must go change this in **Settings → Build Command** yourself — applying this version's zip to your repo does not touch Render's own service settings.
5. Start command: `npm start` — this matches `package.json`'s `start` script and the `Procfile`; Render will pick either up automatically.

## 2. Set environment variables

In Render's dashboard, under the service's **Environment** tab, add the following. Status matches the table in the README exactly:

| Variable | Status |
|---|---|
| `DATABASE_URL` | Required |
| `ADMIN_USERNAME` | Required |
| `ADMIN_PASSWORD` | Required |
| `SESSION_SECRET` | Required |
| `ADMIN_PATH_SLUG` | Required |
| `ENCRYPTION_KEY` | Required |
| `CLOUDFLARE_API_TOKEN` | Required |
| `CLOUDFLARE_ACCOUNT_ID` | Required |
| `RESEND_API_KEY` | Required |
| `EMAIL_FROM_ADDRESS` | Required |
| `NODE_ENV` | Optional — not read by any of HeartCode's own code, but set it to `production` anyway as standard practice |
| `PORT` | Optional — Render injects this automatically; don't set it manually |

See the README's environment variables section for what each one does, its failure mode if missing, and how to get each value — no computer or terminal required for any of it.

## 3. Provision Postgres

**Supabase:**
1. Create a new project.
2. Go to **Project Settings → Database → Connection string**, and choose the **pooled** connection (Transaction mode, port 6543) — not the direct connection.
3. It looks like: `postgres://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres`
4. Paste it into Render's `DATABASE_URL`. `db/init.js` already sets `ssl: { rejectUnauthorized: false }`, which is what Supabase's pooled connection needs — you don't need to add `?sslmode=require` yourself.

**Aiven:**
1. Create a PostgreSQL service.
2. On the service overview page, copy the **Service URI** — it already includes credentials and SSL parameters.
3. It looks like: `postgres://avnadmin:[password]@[host]:[port]/defaultdb?sslmode=require`
4. Paste it into Render's `DATABASE_URL` as-is. Aiven's URI already specifies `?sslmode=require`, and it's compatible with the `rejectUnauthorized: false` setting already hardcoded in `db/init.js`.

## 4. Set up Cloudflare and Resend

**Cloudflare (deploys client sites):**
1. Cloudflare dashboard → **My Profile → API Tokens → Create Token**. Use a Custom Token with **Cloudflare Pages — Edit** permission for your account.
2. Paste the token into Render's `CLOUDFLARE_API_TOKEN`.
3. On any domain's **Overview** page in the Cloudflare dashboard, find your Account ID in the right-hand sidebar under "API". Paste it into `CLOUDFLARE_ACCOUNT_ID`.
4. Nothing else to set up — HeartCode creates a new Cloudflare Pages project per paid deployment automatically.

**Resend (sends the "your site is ready" email):**
1. Resend dashboard → add and verify a domain you control (follow their DNS instructions — this can take a few minutes to propagate).
2. Resend dashboard → **API Keys → Create API Key**. Paste it into `RESEND_API_KEY`.
3. Set `EMAIL_FROM_ADDRESS` to any address on that verified domain (e.g. `deploys@yourdomain.com`). Sends from an unverified domain will fail.

**Paystack (after your first deploy, once you have a live URL):**
1. Paystack dashboard → **Settings → API Keys & Webhooks**.
2. Set the webhook URL to `https://<your-app>.onrender.com/api/webhooks/paystack`.
3. This is what triggers deployment if the client closes their browser right after paying, before the redirect back to your site completes — without it, a payment could succeed on Paystack's side with nothing deployed until they happen to reload the callback page. The browser redirect (`callback_url`, sent automatically per-transaction) covers the normal case; the webhook is the safety net for the abnormal one.

## 5. Deploy and confirm

1. Trigger the deploy (push to the connected branch, or click **Deploy** in Render).
2. Watch the logs for the `[DB]` boot sequence. A healthy boot looks like:
   ```
   [DB] Connecting...
   [DB] Connected.
   [DB] Running schema...
   [DB] Schema ready.
   [DB] Running migrations...
   [DB] Migrations ready.
   [DB] Init complete.
   [SERVER] HeartCode listening on port ...
   [CURRENCY] Refreshed ... exchange rates.
   ```
   If `initDB()` throws, the process exits immediately by design — it won't serve traffic against a broken database — and you'll see the actual Postgres error logged just before the crash. The `[CURRENCY]` line (added in v1.0.6) comes from a separate, non-blocking exchange-rate fetch right after boot — if that line instead reads "Failed to refresh exchange rates", the app is still healthy; currency conversion just falls back to plain USD everywhere until the next refresh succeeds.
3. Hit `https://<your-app>.onrender.com/health`. You should get:
   ```json
   { "status": "ok", "db": "connected", "version": "1.0.7" }
   ```
4. Visit `https://<your-app>.onrender.com/` and confirm the landing page is actually styled (Anton headline font, blue hero section) — not a plain unstyled HTML page. An unstyled page means the build command wasn't updated (see step 4 in section 1 above) and `public/styles/main.css` was never (re)generated on this deploy. This delivery ships with an already-built copy of that file committed as a fallback, so this specific deploy should still look right regardless — but confirm anyway, and fix the build command before your next deploy either way, since that fallback file goes stale the moment anything changes.

## 6. Log into the admin dashboard for the first time

1. Go to `https://<your-app>.onrender.com/<ADMIN_PATH_SLUG>/login`, using the exact value you set for `ADMIN_PATH_SLUG` in Render's environment variables. There is no `/admin` route — that path (and `/__internal_admin`) always 404s, by design.
2. Log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` exactly as set in Render's environment variables.
3. From the dashboard: set up Paystack keys (Payments), at least one AI provider with a key and selected model (AI Provider), and at least one website type with fields, a price, an icon, and a saved template (Website Types) — the type gallery at `/explore` and the landing page's teaser both have nothing to show until a website type is active with an active template. Prices are set in USD; the app converts for display automatically. AI is off by default per website type — turn it on from that type's own "AI" tab if you want AI-generated copy for it, otherwise form submissions go straight to the template as typed. Kenyan visitors are charged in USD by card until you flip the "Kenyan visitor payment currency" toggle on the Payments page — leave it as-is until M-Pesa is actually set up on your Paystack account.
4. **Site Settings** (new in v1.0.7) — set your site title, meta description, and optionally a favicon/social-share image URL and the landing page's stats number/label. Takes effect on the very next public page load, no redeploy needed.
5. **Scripts** (new in v1.0.7) — if you use an analytics tool (Umami, etc.) or any other third-party snippet, paste it here rather than editing any template file. Choose which of the three placements it needs (usually `<head>` for analytics), up to 3 scripts per placement. Public pages only — nothing pasted here ever appears on this dashboard.

## Troubleshooting

**Deploy crashes immediately / logs show `[SERVER] Database init failed`**
`initDB()` failed and the process fail-fast exited before serving any traffic. This is almost always a `DATABASE_URL` problem — wrong password, wrong host, or the database isn't reachable from Render yet. Cross-check the connection string against what your provider's dashboard shows *right now*; Supabase and Aiven credentials can be regenerated, which silently invalidates an old string still sitting in Render's environment variables.

**Connects locally but not from Render (SSL-related error)**
Most managed Postgres providers require SSL for external connections. `db/init.js` already sets `ssl: { rejectUnauthorized: false }`, which works for both Supabase's pooled connection and Aiven's `?sslmode=require` URIs. If you're using a different provider and still see an SSL error, it may need a stricter `ssl` config (e.g. a specific CA certificate) than what's currently hardcoded.

**Can't find the login page / `/admin` returns 404**
That's expected — `/admin` is designed to never resolve to anything. Use `/<ADMIN_PATH_SLUG>/login` with the exact slug from Render's **Environment** tab. If you're not sure what you set it to, that's the place to check — the slug is never displayed anywhere in the running app itself.

**Forgot to set `ADMIN_PATH_SLUG` at all**
Without it, `adminSlugMiddleware` has nothing to match against and the entire admin dashboard becomes unreachable (by design — no fallback to a guessable default path). Set the env var in Render and redeploy.

**Build fails with `sh: 1: tailwindcss: not found`**
This was a real bug in the first cut of v1.0.7's delivery, since fixed: `tailwindcss` was listed under `devDependencies` in `package.json`, and `npm install` skips `devDependencies` entirely when `NODE_ENV=production` is set — which this app's own `.env`/Render guidance tells you to set as standard practice (see the `NODE_ENV` row above). The two pieces of advice contradicted each other. Fixed by moving `tailwindcss` into regular `dependencies`, where it installs regardless of `NODE_ENV`. If you're seeing this exact error, you're on a version from before that fix — take the current `package.json`.

**Landing page / type gallery load with no styling (plain black-and-white HTML)**
`public/styles/main.css` either doesn't exist or is stale. This means the Build Command isn't actually running `npm run build:css` on your Render service — go check **Settings → Build Command** and confirm it reads `npm install && npm run build:css`, not just `npm install`. This is a per-service Render setting, not something that comes from the repo automatically; if you applied this version's zip to an already-existing service, you have to change this yourself. After fixing it, trigger a new deploy (a settings change alone doesn't rebuild) — watch the build logs for a `tailwindcss` line confirming the build actually ran. The admin dashboard is unaffected either way — it uses its own separate, hand-written stylesheet, not this pipeline.

**`/health` returns `db: "disconnected"` even though the app didn't crash on boot**
The database was reachable at boot but became unreachable afterward — commonly a connection pool limit on Supabase/Aiven, or the database pausing itself after inactivity on a free tier. Check your Postgres provider's own dashboard/logs for its current status.
