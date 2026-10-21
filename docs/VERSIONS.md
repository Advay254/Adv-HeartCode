# Version history

The short story of every release, newest first. The full original notes, with every test and every bug story, live in [archive/README-full-original.md](archive/README-full-original.md).

Two numbers exist on purpose. The **app version** is in `package.json` and `/health`. The **schema version** (`CURRENT_VERSION` in `db/init.js`) only moves when the database changes, so the two can differ.

![](assets/divider.svg)

## Contents

[v1.2.x](#v12x-operations-reviews-and-promotion) | [v1.1.x](#v11x-polish-seo-and-hosting) | [v1.0.x](#v10x-foundation-and-the-first-full-flow)

## v1.2.x: operations, reviews and promotion

| Version | What changed |
|---|---|
| **1.2.17** | **Admin login hardening.** The visitor address helper believes `CF-Connecting-IP` only when the request really came from Cloudflare's published ranges (works the same on any host). Login throttling is bounded and has a global slow mode with alerts. Two-step login with an authenticator app, recovery codes and an emergency environment switch. Session idle timeout, scheduled cleanup, and log out everywhere. Startup warnings for weak settings. New Security page. See [SECURITY.md](SECURITY.md). |
| **1.2.16** | **Umami analytics.** An Analytics card in Site Settings (off by default): script address, website ID, allowed domains, Do Not Track, count after first interaction, page speed data, heatmap recorder and "serve through this site". Query strings reduced to `utm_` tags, eight named events, server-side `payment_success` revenue, UTM tags on promotion links. No database change. See [ANALYTICS.md](ANALYTICS.md). |
| **1.2.14** | **Promotion reliability and card.** Delivery routes are never rate limited, the promo renders at once from a single per-campaign script (`/embed/:token.js`), edge cache headers, a container placed by the snippet, beacon plus image-ping tracking, ES5 script with a no-Shadow-DOM fallback, a `data-debug` switch and troubleshooting help. The card is the only style (slim and text campaigns are converted), with accent, background, text, corner and density options, a contrast check, and a new default design. See [PROMOTIONS.md](PROMOTIONS.md). |
| **1.2.15 (part B)** | **Ad cards.** Cards you design yourself, including cards with linked media (image, GIF or video, never uploaded or fetched by the app), a schedule, weights, per-card appearance and daily counts per card. Campaigns choose automatic cards, ad cards or both. See [AD-CARDS.md](AD-CARDS.md). |
| **1.2.15** | **Reviews are text only.** The optional review photo is gone end to end: the upload field, image processing, the ClarityHeart upload and delete calls, its rate limit and security allowance, the database column, and every place a photo was shown. Review cards look the same without it. |
| **1.2.13** | **Promotion page and embeddable script.** Campaigns, a live preview, three copyable snippets (script, iframe, HTML card), counts-only tracking, 90-day cleanup. New `promo_line` field on website types. Also a UI alignment pass on the review screens. See [PROMOTIONS.md](PROMOTIONS.md). |
| **1.2.12** | **Public review display.** A `/testimonials` page, up to 3 top reviews on each build page, reviews inside landing blocks, an optional scrolling message, and a fourth Scripts slot for the checkout confirmation. |
| **1.2.11** | **Review collection and moderation.** One unguessable single-use review link per paid deployment, a public review page, a reminder email, auto-publish after 14 days, and an admin Reviews queue. |
| **1.2.10** | **Version cap.** Versioned templates (site, email, password page, legal, review reminder) keep the latest 4 versions. |
| **1.2.9** | **Safe website type deletion.** A type can be deleted only while inactive, and its deployment history is kept under one shared "Deleted Website Types" placeholder. |
| **1.2.8** | **Hotfix.** A test-deployed website type can be deleted again, and a real deployment now blocks deletion with a clear message. |
| **1.2.7** | **Test Deploy.** Run a website type through the real form, generation, hosting and email pipeline with a `-test` slug, separate from revenue and analytics. |
| **1.2.6** | **Image upload field type.** JPEG, PNG or WebP, resized and re-encoded to WebP, with an admin quality setting. |
| **1.2.5** | **Activity feed.** An append-only event log for payments, deployments, emails, recoveries and curated config changes. |
| **1.2.4** | **Analytics.** Dashboard date ranges, previous-period comparison, two dependency-free SVG charts and a per-type breakdown. |
| **1.2.3** | **Deployment Center.** Keyset pagination, filters, trigram search, a detail drawer and a streaming CSV export, built for hundreds of thousands of rows. Plus a new admin shell. |
| **1.2.2** | **Fixes and content.** Homepage stats readable without JavaScript, SEO pages move to one versioned content block, site-wide footer links, more icons, and the `postinstall` CSS build that ended stale-CSS bugs. |
| **1.2.1** | **Legal pages** (privacy, terms, cookies) with versioning, and a loading animation on the build button. |
| **1.2.0** | **SEO landing pages.** Keyword-targeted pages that point at a website type without changing the product itself. |

## v1.1.x: polish, SEO and hosting

| Version | What changed |
|---|---|
| **1.1.9** | **ClarityHeart hosting** replaces Cloudflare Pages, an alt-text audit, AI-crawler rules in `robots.txt`, and self-hosted MaxMind geolocation. A hotfix fixed visitor IP resolution behind the proxy and a WAF-blocked test deploy. |
| **1.1.8** | The admin redesign redone against the real TailAdmin reference, and a cross-cutting text overflow fix. |
| **1.1.7** | First admin redesign in the TailAdmin visual language: brand colour scale, cards, tables, sidebar and header. |
| **1.1.6** | **Reliability and FAQ.** Global async error handling, an admin-managed FAQ with its own structured data, 140-character description limits, and a same-day fix for a boot-time constraint failure. |
| **1.1.5** | **Interactive preview** with fullscreen, external links in new tabs, and a Category Teaser landing section. |
| **1.1.4** | **Fields UX and categories.** Confirm before removing a field, reorder buttons, a per-type Password Page editor, website Categories, and a 24 hour admin session. |
| **1.1.3** | **Homepage redesign** as a section-based landing page CMS with seven section types, recoloured into the brand palette. |
| **1.1.2** | **SEO fundamentals** (sitemap, robots, structured data), real-time sale notifications over up to three channels, and self-service site details recovery. |
| **1.1.1** | **Multi-provider email** (Resend, Gmail, Brevo or any SMTP), clean permanent deployment URLs, and a safer success page. |
| **1.1.0** | **Recovery and funnel.** Retry a paid deployment that never finished, and a privacy-conscious first-party conversion funnel. |

## v1.0.x: foundation and the first full flow

| Version | What changed |
|---|---|
| **1.0.9** | Per-type email templates and a visual pass on the build, checkout and result pages. |
| **1.0.8** | More field types (number, date, radio, checkboxes), custom deploy slug patterns, the first landing page CMS, and a full admin redesign. |
| **1.0.7** | Design system (Anton, Inter, brand blue and yellow), landing page, type gallery, Site Settings, and the script injection manager. |
| **1.0.6** | Real currency conversion, per-type AI configuration, and loop syntax in templates. |
| **1.0.5** | Security hardening: strict CSP with no inline scripts, zod validation everywhere, and the webhook raw-body fix. |
| **1.0.4** | Real payment and deployment: Paystack checkout, signed webhook, idempotent finalization, and the confirmation email. |
| **1.0.3** | The public builder flow: pick a type, fill the form, AI copy, sandboxed preview. |
| **1.0.2** | Admin shell, Paystack and AI provider config, website types, fields and versioned templates. |
| **1.0.1** | Rebrand and admin authentication behind a secret path slug. |
| **1.0.0** | Express and Postgres skeleton with `/health`. |

## Known open items

- The Cloudflare Pages deploy path was removed in 1.1.9, so it no longer applies.
- `lib/reviews.js` still falls back to a built-in default address for review links when `PUBLIC_BASE_URL` is not set.
- The frame CSS for promotions exists in two places (`public/embed.js` and `lib/promoRender.js`). Change both together.
- `.admin-help` is still used as a plain hint line on three older screens (Test Deploy, Scripts and the review picker). `.admin-form-hint` is the right class.
