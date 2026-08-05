# Deploying HeartCode to Render

> This is the detailed version of the "Deploy this to Render" checklist in `README.md` — start there for the short version.

## 1. Create the Web Service

1. Push this repo to GitHub (or GitLab/Bitbucket).
2. In the Render dashboard: **New → Web Service**, then connect the repo.
3. Runtime: **Node**.
4. Build command: `npm install`
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

## 4. Deploy and confirm

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
   ```
   If `initDB()` throws, the process exits immediately by design — it won't serve traffic against a broken database — and you'll see the actual Postgres error logged just before the crash.
3. Hit `https://<your-app>.onrender.com/health`. You should get:
   ```json
   { "status": "ok", "db": "connected", "version": "1.0.3" }
   ```

## 5. Log into the admin dashboard for the first time

1. Go to `https://<your-app>.onrender.com/<ADMIN_PATH_SLUG>/login`, using the exact value you set for `ADMIN_PATH_SLUG` in Render's environment variables. There is no `/admin` route — that path (and `/__internal_admin`) always 404s, by design.
2. Log in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` exactly as set in Render's environment variables.
3. From the dashboard: set up Paystack keys (Payments), at least one AI provider with a key and selected model (AI Provider), and at least one website type with fields and a saved template (Website Types) — the public homepage at `/` has nothing to show until a website type is both active and has an active template.

## Troubleshooting

**Deploy crashes immediately / logs show `[SERVER] Database init failed`**
`initDB()` failed and the process fail-fast exited before serving any traffic. This is almost always a `DATABASE_URL` problem — wrong password, wrong host, or the database isn't reachable from Render yet. Cross-check the connection string against what your provider's dashboard shows *right now*; Supabase and Aiven credentials can be regenerated, which silently invalidates an old string still sitting in Render's environment variables.

**Connects locally but not from Render (SSL-related error)**
Most managed Postgres providers require SSL for external connections. `db/init.js` already sets `ssl: { rejectUnauthorized: false }`, which works for both Supabase's pooled connection and Aiven's `?sslmode=require` URIs. If you're using a different provider and still see an SSL error, it may need a stricter `ssl` config (e.g. a specific CA certificate) than what's currently hardcoded.

**Can't find the login page / `/admin` returns 404**
That's expected — `/admin` is designed to never resolve to anything. Use `/<ADMIN_PATH_SLUG>/login` with the exact slug from Render's **Environment** tab. If you're not sure what you set it to, that's the place to check — the slug is never displayed anywhere in the running app itself.

**Forgot to set `ADMIN_PATH_SLUG` at all**
Without it, `adminSlugMiddleware` has nothing to match against and the entire admin dashboard becomes unreachable (by design — no fallback to a guessable default path). Set the env var in Render and redeploy.

**`/health` returns `db: "disconnected"` even though the app didn't crash on boot**
The database was reachable at boot but became unreachable afterward — commonly a connection pool limit on Supabase/Aiven, or the database pausing itself after inactivity on a free tier. Check your Postgres provider's own dashboard/logs for its current status.
