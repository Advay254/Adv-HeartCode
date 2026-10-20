# Analytics (Umami)

Optional, off by default, and configured only in **Site Settings > Analytics**. Nothing in the code or templates holds an Umami address, website ID or domain.

## Setup

1. In Umami, add a website and open its tracking code.
2. Copy the **script address** (the `src` of the script tag) and the **website ID**.
3. In Site Settings > Analytics paste both, switch **Enable analytics** on and save.
4. If you pasted an Umami snippet into the Scripts page earlier, remove it, or visits are counted twice.

## What it does

- Loads the tracker with `defer`. A failing or blocked Umami has no visible effect.
- Keeps only `utm_*` query parameters on every address it sends (page and referrer). Everything else, including the `#` part, is dropped. This also drops ad click IDs such as `gclid`.
- Never loads on admin pages, review pages, the checkout return page, the live preview of a customer's site, promotion links or embed routes.
- `/hc.js` is the small loader. It defines the clean-up function first, then adds Umami's script, so a tracker can never run without it.

## Events

| Event | Where | Data |
|---|---|---|
| `type_viewed` | build page | type |
| `preview_opened` | demo Preview links | type |
| `build_started` | first edit in the build form | type |
| `checkout_started` | checkout page | type, currency, value |
| `checkout_return` | checkout return (server) | type |
| `payment_failed` | checkout return, not paid (server) | type |
| `review_submitted` | review form (server) | none |
| `details_resend_requested` | resend page | none |
| `payment_success` | after a confirmed payment (server) | revenue (USD), currency, type, paid_amount, paid_currency |

The checkout return and review pages carry secrets in their address, so they never load the tracker. Those three events are sent from the server instead, once per checkout reference, with no personal data and with the address fixed to a clean path.

`payment_success` is sent once, from the single place that creates the deployment, after the database commit. It never delays finalisation. If the checkout return page finalises the payment, the buyer's browser string and real IP are passed to Umami (never stored here). If the webhook does, they are not available and the event is sent under a neutral browser string made from the site title.

## Options

- **Count a visit only after first interaction.** Holds back the page view until a real scroll, tap, mouse move, click or key press. Needs Umami 3.2+ to start with no automatic page view. Referrer and `utm_` tags still arrive (they are read at send time). Page speed data is only sent if the first interaction happens within about 10 seconds of loading.
- **Collect page speed data.** Sets `data-performance`. Needs Umami 3.1+; older versions ignore it.
- **Heatmap recorder.** Loads Umami's recorder on `/`, `/explore`, `/explore/:category` and `/testimonials` only. Turn on Replays and Heatmaps for the website in Umami (Websites > Edit). Viewing a heatmap over a page preview in Umami needs this site to allow framing, which it deliberately does not.
- **Serve through this site.** Two routes, `/hc/s.js` (the tracker script, cached) and `/hc/api/send` (forwards data). The target is always built from the saved script address; the website ID and hostname are forced from settings. When the switch or analytics is off both routes behave as if absent.

## Umami side

- Behind Cloudflare, set `CLIENT_IP_HEADER=x-forwarded-for` in Umami so visitor addresses are read correctly.
- The collect address is the script address with the file name removed plus `/api/send` (Umami's default). A custom `COLLECT_API_ENDPOINT` is not supported.
- Dashboard: events appear under Events; revenue under Revenue (currency USD).

## Promotion links

`/go/...` redirects add `utm_source` (campaign name as a slug), `utm_medium=promo`, `utm_campaign` (campaign id) and, for ad cards, `utm_content` (ad card id). Added whether or not analytics is on.
