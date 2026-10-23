# Render integrity (v1.2.19)

## The problem this closes

Before v1.2.19 the build step sent the finished page HTML to the visitor's browser, and at checkout the browser sent it back. The server stored whatever arrived and, after payment, published it on a subdomain of your domain. Anyone could pay for one site and publish any HTML or script they liked.

## How it works now

1. `POST /api/build/:slug/generate` renders the page, neutralises dangerous links, and stores the result in `build_renders` (page HTML, raw field values, AI output, type, expiry) under a 43 character random id. The browser receives the HTML (only to show the preview) and the id.
2. `POST /build/:slug/checkout` accepts only `renderId`, `clientEmail`, optional `sitePassword` and the funnel `sessionId`. Anything else (including the old `renderedHtml`, `rawFieldValues`, `aiOutputValues`) is refused with a friendly "build your page again" message and is never read. The server loads the stored render, checks it exists, has not expired and belongs to the same website type as the address, and creates the pending deployment from the stored values.
3. A render can be used for several checkout attempts until it expires. It is deleted when its deployment succeeds, and by the scheduled cleanup (every 15 minutes) and before each new build once expired.
4. A page opened before an update, or left open past the expiry, shows "Your page preview has expired or was made before an update. Please go back and build your page again" and its button becomes "Build my page again". The details already typed are kept.

## Limits

- Per address: unchanged, 20 builds an hour (5 for AI types) and 5 checkouts an hour, keyed by the corrected visitor address helper.
- Stored renders: at most 1000 at once and 250 MB of HTML in total , each at most 12 million characters, expiring after 120 minutes. Past a cap a build answers "We are very busy building pages right now".
- The checkout request body limit is 10 KB (it was 16 MB).

## Dangerous links

`lib/siteSanitizer.js` replaces the address of any `href`, `src`, `action`, `formaction` or `xlink:href` (and `data` on `<object>`) with `#` when it uses `javascript:` or `vbscript:`, or `data:` for anything other than an image source (`data:image/...` on `img`, `source` or `image`). It decodes entities and ignores spaces, tabs and control characters the way a browser does, so `JaVa\tScRiPt:` and `jav&#x61;script&colon;` are caught. It runs at build time, again at deploy time, and never changes scripts, style blocks, comments, event attributes or normal links. An admin-written template that itself uses `href="javascript:void(0)"` would also become `#`.

Escaping cannot protect a customer field placed inside a `<script>` block or an `on...` attribute (entities are decoded before an event attribute runs as script, and a backtick or `${` is code in a script). At startup the log names any website type whose active template does this, for example `[SECURITY] Template for "portfolio" puts customer fields inside script or event code: {{name}} in event attribute (onclick)`. No templates ship with the app; they are created in the admin, so this list is specific to your data. Move such values into page text or a `data-` attribute.

## Verifying the database certificate (optional)

Set `DATABASE_CA_CERT` to your provider's CA certificate (PEM, PEM with `\n`, or base64). The connection then fails if the certificate does not match, and the host name must match the certificate. Leave it empty and nothing changes. A wrong value only logs an error and keeps today's behaviour.

- Supabase: Project Settings, Database, SSL configuration, download the certificate.
- Aiven: the service overview page has a "CA certificate" download.
- Neon, Render and others: use the CA shown in the connection or SSL settings, or the provider's documented root certificate.

Open the downloaded `.crt` file in a text editor and paste everything. If your host's variable box dislikes line breaks, base64 encode the file first (any "base64 encode" tool).

## Health

`/health` answers `{"status":"ok"}` or `{"status":"error"}` (HTTP 500). The version and the failure reason are only in the server log (`[HEALTH]`).

## Testing safely

1. Build a page normally, open the preview, go to checkout and pay with Paystack test keys. The site should deploy and the email arrive exactly as before.
2. In the browser's network tab the checkout request contains only `renderId`, `clientEmail`, `sitePassword` and `sessionId`.
3. Go back from checkout, wait for expiry or change the id in session storage, press Pay: you see the rebuild message.
4. Put `javascript:alert(1)` in a field used as a link and check the preview and live site show `#`.
