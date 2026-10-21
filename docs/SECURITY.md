# Admin security (v1.2.17)

HeartCode protects itself. Nothing here depends on Cloudflare, Render or any other provider. Anything those add is an extra layer.

## Visitor address

`lib/clientIp.js` is the only place that works out a visitor's address. `server.js` keeps `trust proxy` at `loopback, linklocal, uniquelocal`, so `req.ip` is the last public machine that connected. The `CF-Connecting-IP` header is believed only when `req.ip` is inside Cloudflare's published ranges (`lib/cloudflareRanges.js`, fetched 2026-10-21). Everywhere else it is ignored.

- `CLIENT_IP_CLOUDFLARE=auto` (default) or `off`.
- `CLOUDFLARE_IP_RANGES` replaces the built in list without a code change. Re-check https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6 now and then.
- If no address can be found, the fixed placeholder `unknown-address` is used, so limits still apply.
- Login counting uses the IPv6 /64 network as the key.
- Assumption: the host's own proxy (if any) sits on a private address and appends the real visitor to `X-Forwarded-For`, as Render and most hosts do. A host that passes a client-supplied `X-Forwarded-For` through untouched from a public address cannot be fully protected by any app.
- Local test: `node scripts/test-client-ip.js`.

## Login throttling

`lib/loginThrottle.js`. Five wrong tries from one address lock that address out for 15 minutes. At most 10,000 addresses are tracked and old entries are swept every 5 minutes. If wrong logins across all addresses pass `LOGIN_SLOW_MODE_THRESHOLD` (default 20 in 15 minutes) every attempt waits 2 seconds; the login is never locked and a correct login still works. One alert is sent when slow mode starts and one when it ends, to webhook and Gotify channels. Counts live in memory of one running copy and reset on restart; to share them across copies, move the maps to the database or Redis behind the same functions. Local test: `node scripts/test-login-throttle.js`.

## Two-step login

Security page in the admin. Standard time based codes (RFC 6238, HMAC-SHA1, 30 seconds, 6 digits, one step either side), built with Node's crypto. Setup shows the key as text with a Copy button and an `otpauth://` button for the app on the same phone. It turns on only after the first code is typed. 10 recovery codes are shown once and stored only as salted scrypt hashes. The secret is encrypted with `ENCRYPTION_KEY`.

- If `ENCRYPTION_KEY` is missing or has changed, app codes cannot be checked (the page and login say so), but recovery codes still work.
- A code cannot be used twice. A wrong code counts as a failed login attempt.
- Turning off, and making new recovery codes, need the password and a current code.
- Emergency switch: set `ADMIN_DISABLE_TWO_STEP=true` and restart. The second step is skipped, the saved setup is cleared, and a warning is printed at startup. Remove it afterwards.

## Sessions

24 hour maximum plus an idle timeout (`ADMIN_SESSION_IDLE_MINUTES`, default 120). Use is recorded at most once a minute. Expired and idle sessions are deleted by the scheduled cleanup. The Security page can log out every other device, or everywhere, after confirming the password.

## Weak settings

At startup a warning is printed when `SESSION_SECRET` or `ENCRYPTION_KEY` is under 32 characters, `ADMIN_PASSWORD` is under 14, or a value looks weak. The Security page shows the same notice. Nothing blocks startup, and values are never shown.
