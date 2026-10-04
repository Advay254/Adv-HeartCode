# Promotions

Build a small promo for another website. Paste one snippet there and a short, light promo for this site appears right where you pasted it. Everything is read live from this site: its name, its brand colours and every website type that is active right now.

![](assets/divider.svg)

## Create a campaign

Open **Promotion** in the Content group.

| Setting | Meaning |
|---|---|
| Label | Your own note about where the snippet goes. |
| Mode | **General** shows the site message plus every active website type. **Category** shows only the active types in one category. |
| Style | Card, slim line or text link. All sit in normal page flow. |
| Theme | Light, dark or auto (follows the visitor's device). |
| Accent colour | Optional `#RRGGBB`. Blank uses the brand colours. |
| Headline, line | Optional custom text for the site message. Plain text only. |
| Button label | Up to 24 characters, default "Build yours". |

Limits: headline 60, supporting line 120. HTML and links are rejected on the server.

A website type promotes under its own name. Its line is its **promo line** (Details tab, up to 100 characters) or, when empty, its public description trimmed to about 100 characters.

## Build the snippet

Press **Build script** on a campaign for three copyable variants.

| Variant | Use it when |
|---|---|
| Script tag | The host allows a script. Tiny, async, Shadow DOM, inherits the host font. |
| Iframe | The host blocks scripts. Lazy, sandboxed, fixed height per style, so nothing shifts. |
| HTML card | The host allows only static HTML. Plain links, no script. |

The script builds the whole promo first and inserts it once after the host's script tag, so it never reflows in steps. That single insertion can still move content below it when the promo sits above the fold. The iframe has a fixed height and never shifts anything.

## What a visitor sees

One item picked at random per page view. The pool is worked out live on every request, so new types appear on their own and inactive or deleted types never do.

| Situation | Result |
|---|---|
| Category deleted, inactive or empty | The general promotion, returning to the category when it recovers. |
| No active website types | Only the site message. |
| Campaign deleted | The general promotion, not counted. |
| Campaign switched off | Nothing renders. |

Changing or deleting a category never deletes or breaks a campaign. The admin shows a notice on affected campaigns.

## Tracking

Counts only, per campaign per day. No cookies, no IP addresses, no browser storage.

- One impression per page view, sent after the promo has been visible for a moment.
- Clicks go through `/go/:token`, which records the click and redirects to a site path built on the server, so it can never be an open redirect.
- Rows older than 90 days are removed by the existing scheduled job.
- Impression and click endpoints are rate limited by IP.

## Good to know

- Snippets keep the address they were built with. If the public domain ever changes, keep the old one redirecting here. Set `PUBLIC_BASE_URL` so built snippets never depend on how the dashboard was opened.
- Only `/embed/frame/:token` can be framed. Every other page keeps its no-framing headers.
- Deleting a campaign deletes its stats.
