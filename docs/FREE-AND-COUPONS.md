# Free deployments and coupons (v1.2.21)

Needs **ClarityHeart v1.5.1 or newer** for the folder and auto-delete features. An older ClarityHeart still deploys, but free sites will not expire and nothing is filed into folders.

## Free deployments

Set a website type's price to `0` and it becomes free. Nothing is sent to Paystack.

1. The visitor builds their page and taps **Send my free link**.
2. We email a one-time link, valid for the minutes you set (default 30).
3. Opening the link deploys the site. Opening it again shows the same site and never deploys twice.
4. The site lasts the days you set (default 7, never above 30), then ClarityHeart deletes it.
5. A small "Built with HeartCode" badge is added to the site.

Free sites are left out of revenue, sales counts, admin sale alerts and the Recovery list. They still get the one-time review link and the review reminder, because reviews are the point of the free offer.

### Abuse controls (admin, Sales, Free Deployments)

| Control | Default | Notes |
|---|---|---|
| Free deployments per day | 10 | 0 closes free deployments. The day resets at midnight UTC. Visitors see "Today's free deployments have been used up. Please try again early tomorrow." |
| Confirmation emails per day | 30 | Hard ceiling so free requests can never eat the 300 a day. |
| Free site lasts | 7 days | 1 to 30. |
| Link works for | 30 minutes | 5 to 120. |
| Extra blocked list | empty | Emails or domains, one per line. Duplicates and blanks are removed on save. |

Also built in: about 135 disposable domains blocked, one free site per person (lowercase, `+tag` removed, Gmail dots removed, googlemail = gmail), at most 3 requests per network per day, and no second email while a link is still live.

## Coupons (admin, Marketing, Coupons)

- At most 25% off, enforced by the server and the database.
- Only on website types priced above $2.
- One coupon per order. Each email can use a code once.
- Optional expiry, total uses and website types.
- Counted when payment completes, not when the code is typed.

## ClarityHeart folders

HeartCode files each deployment automatically: **Free**, **Paid**, **Test**. Manual deploys stay Unassigned.
