# Configuration on the admin pages

Most setup happens in the dashboard, not in environment variables. Secrets saved here are encrypted with `ENCRYPTION_KEY`. A secret field left blank on save means "keep the current value".

![](assets/divider.svg)

## Hosting (ClarityHeart)

Every paid deployment is stored and served by ClarityHeart, a separate hosting service. Open **Hosting** in the System section and enter:

- **Base URL**, for example `https://manage.example.com`. A trailing slash is removed for you.
- **API token**, the Bearer token ClarityHeart issued.

Press **Send test deploy**. It deploys a tiny throwaway page through the same code path a paying client uses, so a wrong URL or token shows up now rather than during a real checkout. There is no environment variable fallback for hosting.

## Email providers

Open **Email Providers**. Add as many as you like, exactly one is active.

| Provider | Notes |
|---|---|
| Resend | API key plus a from address on a verified domain. |
| Gmail SMTP | Host and port are pre-filled. Use an App Password, not your normal password. |
| Brevo SMTP | Host and port are pre-filled. Credentials are under SMTP and API in Brevo. |
| Generic SMTP | Any other mail server. Fill in host, port and security. |

Use **Send test email** on a card, then **Set as active**.

## Payments and currency

**Payments** holds the Paystack keys and currency settings. Visitors see prices converted to their own currency, always labelled correctly. When no rate is available the price falls back to USD. Kenyan visitors get a USD or KES switch.

## Geolocation

Currency is resolved from your own copy of MaxMind's free GeoLite2-Country database, with no third-party request.

1. Create a free account at maxmind.com and download **GeoLite2-Country** in `.mmdb` format.
2. Commit it to the repo at `data/GeoLite2-Country.mmdb`. It is a normal non-secret file.
3. Deploy. The file is opened once at boot.

If the file is missing the app does not crash, every visitor simply sees USD. The **Geolocation health check** on the Payments page confirms it loaded. MaxMind refreshes the data about monthly, so replacing the file every month or two keeps it current.

## AI provider

**AI Provider** stores keys for one or more providers in priority order. AI is off by default for every website type and is switched on per type on its AI tab, so types without AI make no AI calls and cost nothing.

## Other admin pages

| Page | Purpose |
|---|---|
| Website Types | Fields, versioned templates, email, password page, AI, pricing, categories. |
| Landing Sections | The homepage as reorderable sections. |
| SEO Pages, FAQ, Legal Pages | Public content, with structured data and versioning. |
| Site Settings, Scripts | Titles, metadata, image quality, and pasted third-party scripts. |
| Deployments, Activity, Recovery, Funnel | Operations, analytics and retrying a paid deployment that did not finish. |
| Reviews | Moderate client reviews and run the public reviews page. |
| Promotion | Build promotions for other websites. See [PROMOTIONS.md](PROMOTIONS.md). |
| Notifications | Sale alerts on up to three channels. |
