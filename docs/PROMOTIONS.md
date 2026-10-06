# Promotions

Build a small promo card for another website. Paste one snippet there and a short card for this site appears right where you pasted it. Everything is read live from this site: its name, its brand colours and every website type that is active right now.

![](assets/divider.svg)

## Create a campaign

Open **Promotion** in the Content group.

| Setting | Meaning |
|---|---|
| Label | Your own note about where the snippet goes. |
| Mode | **General** shows the site message plus every active website type. **Category** shows only the active types in one category. |
| Theme | Light, dark or auto (follows the visitor's device). |
| Density | Comfortable (default) or compact. |
| Corners | Soft (default), sharp or round. |
| Accent colour | Optional `#RRGGBB`. Blank uses the brand colours. |
| Card background, text colour | Optional `#RRGGBB` each. Blank uses the brand defaults for the theme. |
| Headline, line | Optional custom text for the site message. Plain text only. |
| Button label | Up to 24 characters, default "Build yours". |
| Cards shown | Automatic cards only (default), your ad cards only, or both. See [AD-CARDS.md](AD-CARDS.md). |

The card is the only style (v1.2.14). The site name and its mark always show. Text against the card and the button text against the button are checked for contrast: below 4.5:1 you get a warning, below 2:1 saving is refused.

Limits: headline 60, supporting line 120. HTML and links are rejected on the server.

A website type promotes under its own name. Its line is its **promo line** (Details tab, up to 100 characters) or, when empty, its public description trimmed to about 100 characters.

## Build the snippet

Press **Build script** on a campaign for three copyable variants.

| Variant | Use it when |
|---|---|
| Script tag | The host allows a script. Three lines: an empty container, the script, and a link for visitors without JavaScript. One request, the card appears at once. Inherits the host font. |
| Iframe | The host blocks scripts. Lazy, sandboxed, fixed height per density, so nothing shifts. |
| HTML card | The host allows only static HTML. Plain links, no script. |

The script builds the whole promo first and inserts it once into the container (the container reserves space, so the page barely moves). It does not wait for idle time, the page load, the host's images or visibility. Only the impression count waits for the card to be on screen. Two snippets on one page work independently.

Snippets built before v1.2.14 (`/embed.js` with `data-token`) keep working: they render at once after one config request with a long timeout and two retries.

## Delivery and caching

| Address | Cache-Control |
|---|---|
| `/embed/:token.js` (campaign script with settings inside) | `public, max-age=300, s-maxage=900, stale-while-revalidate=3600, stale-if-error=604800` |
| `/api/embed/config/:token` (older snippets) | the same |
| `/embed.js` (shared script) | `public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400, stale-if-error=604800` |

None of these, nor the iframe page or `/go/*`, is rate limited. A change to a campaign reaches visitors within about 15 minutes at the edge.

**Cloudflare.** `.js` files are cached by default, so new snippets need no rule. Older snippets fetch an extensionless config address, which Cloudflare does not cache by default. To cache it, add a Cache Rule: if URI Path starts with `/api/embed/config/`, then Eligible for cache, Edge TTL "Use cache-control header if present, bypass cache if not", Browser TTL "Respect origin".

## If a promo does not show

Speed and caching plugins on the host can delay, combine or remove third-party scripts. Exclude the script address from delaying, combining and minifying (the exact address is shown on the Promotion page, under Build script), then clear the host's cache. Add `data-debug` to the container div, reload and read the browser console to see what the script did. Without it nothing is printed.

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
- Counting endpoints have generous per-IP limits. A limit only skips the count. It never changes what is shown or where a click goes.
- Impressions use a beacon, with an image ping as the fallback.

## Good to know

- Snippets keep the address they were built with. If the public domain ever changes, keep the old one redirecting here. Set `PUBLIC_BASE_URL` so built snippets never depend on how the dashboard was opened.
- Only `/embed/frame/:token` can be framed. Every other page keeps its no-framing headers.
- Deleting a campaign deletes its stats.
