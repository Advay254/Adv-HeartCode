# Environment variables

Every configuration value comes from the environment. Nothing secret or platform specific is written into the code. The table reflects what the code actually does with each one.

![](assets/divider.svg)

| Variable | Needed? | What it does |
|---|---|---|
| `DATABASE_URL` | Required | PostgreSQL connection string from Supabase, Aiven or any Postgres host. |
| `ADMIN_USERNAME` | Required | Admin login name. |
| `ADMIN_PASSWORD` | Required | Admin login password, typed as plain text. It is compared in constant time. |
| `SESSION_SECRET` | Required | Signs session cookies and derives CSRF tokens. Any long random string. |
| `ADMIN_PATH_SLUG` | Required | The secret URL segment of the dashboard, for example `raven-portal-92`. |
| `ENCRYPTION_KEY` | Required | Encrypts stored Paystack, AI, email and hosting secrets. Any string, any length. |
| `PUBLIC_BASE_URL` | Optional | The live public address, for example `https://example.com`. Used by review links, the review notification and promotion snippets. Without it, promotion snippets use the address the admin is browsing from. |
| `PORT` | Optional | Defaults to `3000`. Render sets it for you. |
| `NODE_ENV` | Optional | Set to `production` on Render. |
| `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` | Optional | One-time migration into an Email Providers entry, only when that table is empty. Normal email setup is on the admin page. |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Deprecated | No longer read by any code. Remove them whenever convenient. |

## What happens when one is missing

| Missing | Result |
|---|---|
| `DATABASE_URL` | The app refuses to boot. |
| `SESSION_SECRET` | Boots, but the first login attempt fails. |
| `ADMIN_PATH_SLUG` | Boots, but the whole dashboard is unreachable (404 everywhere, on purpose). |
| `ADMIN_USERNAME` or `ADMIN_PASSWORD` | Boots, but login never succeeds. |
| `ENCRYPTION_KEY` | Boots and read-only pages load, but saving any secret fails. |
| Hosting not configured on the admin page | Checkout works, but the deployment step fails after payment. Set it up before taking real payments. |

## Getting the values on a phone

No terminal is needed.

- `ADMIN_USERNAME`, `ADMIN_PASSWORD`: type what you like.
- `ADMIN_PATH_SLUG`: any word nobody would guess, letters, numbers and hyphens.
- `SESSION_SECRET`, `ENCRYPTION_KEY`: generate a 40+ character password in any password manager. They do not need to match.
