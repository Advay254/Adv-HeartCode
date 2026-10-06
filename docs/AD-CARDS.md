# Ad cards

Cards you design yourself, shown by promotion campaigns. A card can be text only, sit beside or above a looping demo, or be a media banner that is one big link. They promote this site only.

![](assets/divider.svg)

## How it fits together

- **Campaigns** (Promotion page) are placements. Each has its own snippet and a **Cards shown** setting: automatic cards only (the default for every existing campaign), my ad cards only, or both.
- **Ad cards** (Ad Cards page) are the cards you design. Each is assigned to all campaigns or to chosen ones.
- If a campaign would have nothing to show (ad cards only, but none eligible), it shows the automatic cards, so a script is never blank.

## An ad card

| Field | Notes |
|---|---|
| Name | For you only. |
| Layout | **Text card**, **Card with media** (media left when wide, on top when narrow), or **Media only banner** (the whole banner is the link). |
| Media link | A direct `https` link to the file itself, ending in a type such as gif or mp4. Not a page that shows the file. |
| Kind, shape, fit | Kind is guessed from the link and can be changed. Shape is a width to height ratio (presets or your own two numbers) that decides how much space is reserved. Fit is fill or fit inside. |
| Alternative text | Required with media, up to 125 characters. |
| Still image link | Optional. The poster for a video, and what visitors with reduced motion or a data saver see. |
| Headline, line, button | 60, 120 and 24 characters. Plain text, no HTML or web addresses. |
| Destination | The home page, or the build page of one active website type. Worked out on the server at click time. An inactive or deleted type sends visitors home. |
| Appearance | Accent, background and text colours, corners and density. They win over the campaign's choices. Same readability check as campaigns (warn below 4.5:1, block below 2:1). |
| Schedule, weight | On or off, optional start and end date (UTC), weight 1 to 10. |

## Media rules

- This app never uploads, stores, fetches or measures media. Links are checked as text only. The visitor's browser (and the admin preview) are the only things that load them.
- Only `https` links are accepted. Media is shown only with an image or video element, never a frame, embed or markup. SVG is only ever an image.
- The text and card frame appear at once. The media area reserves its exact space from the shape, with a soft placeholder colour, and loads separately. It loads when visible or within about 300 px of the screen, and later when far below.
- If the media fails to load (or does not answer within 20 seconds) the area is removed and the text card stays. A broken picture is never visible.
- Video is muted, looping, without controls, plays inline on phones, starts only when on screen and pauses when scrolled away. Animated images simply play.
- Reduced motion or a data saver: the still image is shown if there is one. With no still image the animated file or video is never downloaded and the card is text only.
- Images send no referrer to the media host. Browsers offer no way to set that for a video, so a video request carries the usual referrer (the host page's address without its path). Say so to anyone who cares about that.
- The iframe variant runs no script and loads no media, so an ad card there appears as a text card. The plain HTML variant only ever shows the automatic or brand card.

## What is shown

A campaign's script holds a small pool (about 20 items at most): its eligible ad cards and, depending on its setting, the automatic cards. The visitor's browser picks one at random by weight on each page view, so the cached script is identical for everyone and edge caching still works. An ad card is eligible while it is on, today (UTC) is inside its dates, and it is assigned to the campaign. Each automatic card counts as weight 1. A card that is off, ended, unassigned or deleted leaves the pool within the cache time (about 15 minutes at the edge).

## Tracking

One row per ad card per campaign per day, updated in place: impressions and clicks only. No cookies, no IP addresses, no personal data. Rows older than 90 days are removed by the scheduled job. Deleting an ad card deletes its rows. Clicks go through `/go/:token/card/:id`, which records the click and redirects to the destination worked out on the server. Nothing in the request is ever used as an address.

The Promotion page shows each campaign's totals split into automatic cards and ad cards. The Ad Cards page shows each card's own impressions, clicks and click rate.

## The admin preview

The Ad Cards page shows the real card in a narrow and a wide box, in light and dark, loading the media from your link right there. It tells you when the link does not load. This one admin page allows images and video from any `https` address (its other security rules are unchanged).
