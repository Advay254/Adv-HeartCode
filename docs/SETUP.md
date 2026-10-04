# Setup

Two ways to run HeartCode: deploy it on Render (the normal route, works entirely from a phone), or run it locally.

![](assets/divider.svg)

## Deploy on Render

1. Push the repo to GitHub.
2. In Render choose **New, Web Service** and connect the repo.
3. Build command `npm install`, start command `npm start`.
4. Add the variables from [ENVIRONMENT.md](ENVIRONMENT.md) on the **Environment** tab.
5. Create a Postgres database (Supabase or Aiven) and paste its pooled connection string into `DATABASE_URL`.
6. Deploy, then open `https://<your-app>.onrender.com/health`. You should see `"status": "ok"` and `"db": "connected"`.
7. Open `https://<your-app>.onrender.com/<ADMIN_PATH_SLUG>/login` and sign in.
8. In the dashboard set up **Hosting**, **Payments**, an **Email provider** and optionally an **AI provider**. See [CONFIGURATION.md](CONFIGURATION.md).

The longer walkthrough with troubleshooting is in [../DEPLOYMENT.md](../DEPLOYMENT.md).

## CSS builds itself

Tailwind is compiled into two bundles (public site and admin). `npm run build:css` runs automatically after every `npm install` through a `postinstall` script, so Render's build command does not need anything extra, and the compiled CSS can never go stale after a deploy.

The sources are `src/styles/main.css` (public) and `src/styles/admin.css` (admin). Never edit the compiled files under `public/`.

## Run locally

```bash
git clone <repo-url> heartcode
cd heartcode
npm install
cp .env.example .env     # then fill it in
npm start
```

- Public site: `http://localhost:3000/`
- Admin: `http://localhost:3000/<ADMIN_PATH_SLUG>/login`

After changing a Tailwind source, a config file or adding new classes to a view, run `npm run build:css` again (`build:css:public` or `build:css:admin` builds one side). The server runs the database setup on every boot and it is safe to repeat. A fresh database has no website types, so create one from the dashboard first.

## First checks after any deploy

- `/health` reports the version and database status.
- The dashboard loads and the Reviews and Promotion pages open.
- **Hosting, Send test deploy** succeeds before you accept real payments.
