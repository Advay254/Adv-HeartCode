# Withdrawals (v1.2.18)

Send money from your Paystack balance to your own M-Pesa number or Kenyan bank account, from the admin (Commerce, Withdrawals). Real money moves, so every choice favours safety.

## The principle

- Money can only go to a **saved recipient**. There is no way to type a number into a withdrawal.
- A new recipient waits (default 24 hours, Settings) before it can be used. The wait is fixed when it is added.
- Every sensitive step asks the admin password again. With two-step login on (see [SECURITY.md](SECURITY.md)), every withdrawal and every recipient addition also asks for a current authenticator code (recovery codes are not accepted for money).
- Only the admin session can reach any of it. HeartCode has one admin account and no roles.

## Tabs

- **Withdraw**: live Paystack balance (with a Refresh button and the time it was read), the form, a review step, password confirmation, the Paystack code step if Paystack asks for it, and a status page that updates itself.
- **Recipients**: saved recipients (label, type, masked number, status) and the add form. Only the last 3 or 4 digits are kept. The full number is held by Paystack only.
- **History**: totals for this month, every withdrawal, and the audit log with type and date filters.
- **Settings**: Withdrawals enabled (default off), currency, maximum per withdrawal (default 1,000.00), maximum per day over any 24 hours (default 3,000.00), reserve to keep (default 0) and the waiting period. Saving needs the password.

The **Emergency stop** button on every tab switches withdrawals off at once with no password. Turning them on again needs the password.

## Checks (all on the server)

Withdrawals enabled, recipient saved, active, past its waiting period and in the chosen currency, amount greater than zero in whole minor units, within the per withdrawal limit, within what is left of the daily limit, and the balance after (less anything still in flight and the optional fee allowance) at or above the reserve. These run inside one database transaction holding an advisory lock, so simultaneous requests are handled one at a time.

## Sending

1. A row is saved first, with a unique reference (`hcwd-` plus a UUID) and a one-time submit key. The same submit key again does nothing.
2. Paystack is called once with that reference.
3. A clear refusal (4xx) marks it failed. A timeout, network failure or 5xx marks it **Unknown**. It is never retried. The reconcile job (every 2 minutes) looks the reference up with `GET /transfer/verify/:reference` and settles it.
4. If Paystack answers `otp`, an entry screen appears. The code must be entered within 10 minutes (`POST /transfer/finalize_transfer`), otherwise the withdrawal expires and nothing is sent. If OTP is off in Paystack, the transfer simply continues.
5. `transfer.success`, `transfer.failed` and `transfer.reversed` arrive on the existing Paystack webhook (signature checked first). They are matched by reference and are safe to repeat or arrive out of order: a late success never undoes a reversal, and a late failure never undoes a success.

Three wrong passwords, authenticator codes or Paystack codes in a row (since the last completed withdrawal) switch withdrawals off and send a notification.

## Audit log and notifications

`withdrawal_audit` is insert only. A database trigger refuses UPDATE, DELETE and TRUNCATE. It holds no passwords, codes or full numbers, and (like the rest of the app) no visitor addresses. Notifications use the webhook and Gotify channels from the Notifications page and carry no full numbers.

## What Paystack's documentation does and does not say

- Confirmed: `POST /transferrecipient`, `POST /transfer` (`source`, `amount`, `recipient`, `reference` 16 to 50 characters of a-z 0-9 - _), `POST /transfer/finalize_transfer` (`transfer_code`, `otp`), status `otp` when a code is needed, `GET /transfer/verify/:reference`, `GET /balance`, the three transfer webhook events, and `DELETE /transferrecipient/:code`.
- Not stated: the phone number format for Kenya (set `WITHDRAWAL_MPESA_FORMAT` if the default is refused), what a Kenyan Till or Paybill transfer needs as `account_reference` (Till is off by default, Paybill is not offered), the Kenyan bank list and required fields, account name checks for Kenyan accounts (none documented, so you type the name), the unit of `GET /balance` (treated as the smallest unit, check against your dashboard), how long a Paystack code lasts, and the failure reasons in webhooks.
- IP whitelisting is an optional Paystack feature that blocks secret key requests from other addresses (Settings, API Keys and Webhooks). If you turn it on, add this server's outgoing address. The admin error says so when Paystack refuses a call.

## Testing safely

1. Use Paystack **test mode** first (test keys on the Payments page). Test transfers always succeed.
2. In Settings keep the limits low, turn Withdrawals on, and add your own M-Pesa number. Wait out the waiting period (set it to 1 hour for the test, then back).
3. Withdraw the smallest amount (for example 10.00 KES) and watch the status page.
4. In live mode repeat with 10.00 KES. In the Paystack dashboard open Transfers and check the amount, recipient, reference (it matches History) and the fee, and check Balance dropped by amount plus fee.
