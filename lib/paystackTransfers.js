'use strict';

// v1.2.18: the only place that talks to Paystack's Transfers API.
//
// Every call below follows Paystack's official docs (paystack.com/docs/api/).
// Where the docs do not say, the code says so in a comment and the admin page
// tells the owner. The secret key is read here, used in one header, and never
// logged, returned or put in an error message.
//
// Result shape for every call: { ok, status, data, message, kind }
//   kind 'ok'       Paystack answered with success
//   kind 'rejected' Paystack answered with a 4xx: it did NOT act on the request
//   kind 'unclear'  timeout, network failure, 5xx or an unreadable answer: the
//                   request may or may not have been acted on. Never retry it
//                   automatically for money-moving calls.

const { getActivePaystackKeys } = require('./paystack');

// Paystack's API address. Only change it for testing against a stand-in server.
const API = (process.env.PAYSTACK_API_BASE || 'https://api.paystack.co').replace(/\/+$/, '');
const TIMEOUT_MS = 20 * 1000;

const IP_HINT = 'If IP whitelisting is on in your Paystack dashboard (Settings, API Keys and Webhooks), add this server\'s outgoing IP address there. Also check that the secret key matches the mode (test or live) shown on this page.';

async function call(method, path, body) {
  const keys = await getActivePaystackKeys();
  if (!keys) {
    return { ok: false, status: 0, data: null, kind: 'rejected', message: 'Paystack is not set up. Add your keys on the Payments page.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API + path, {
      method,
      headers: Object.assign(
        { Authorization: 'Bearer ' + keys.secretKey },
        body ? { 'Content-Type': 'application/json' } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    let json = null;
    try { json = await res.json(); } catch (_e) { json = null; }
    const message = json && typeof json.message === 'string' ? json.message.slice(0, 300) : '';
    if (res.status >= 200 && res.status < 300 && json && json.status === true) {
      return { ok: true, status: res.status, data: json.data, message, kind: 'ok', mode: keys.mode };
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 408) {
      let shown = message || ('Paystack refused the request (HTTP ' + res.status + ').');
      if (res.status === 401 || res.status === 403 || /ip|whitelist|allow/i.test(message)) {
        shown += ' ' + IP_HINT;
      }
      return { ok: false, status: res.status, data: json && json.data, kind: 'rejected', message: shown };
    }
    return { ok: false, status: res.status, data: null, kind: 'unclear', message: 'Paystack did not give a clear answer (HTTP ' + res.status + ').' };
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    return { ok: false, status: 0, data: null, kind: 'unclear', message: timedOut ? 'Paystack did not answer in time.' : 'Could not reach Paystack.' };
  } finally {
    clearTimeout(timer);
  }
}

/** GET /balance: data is [{ currency, balance }]. Unit is NOT stated in the docs; treated as the smallest unit. */
async function fetchBalances() {
  const r = await call('GET', '/balance');
  if (!r.ok) return r;
  const list = Array.isArray(r.data) ? r.data : [];
  r.balances = list
    .filter((b) => b && typeof b.currency === 'string' && Number.isSafeInteger(b.balance))
    .map((b) => ({ currency: b.currency.toUpperCase(), balance: b.balance }));
  return r;
}

/** GET /bank. The docs show currency and type filters; the Kenyan bank list is not documented, so the caller handles an empty answer. */
async function listBanks(query) {
  return call('GET', '/bank?' + query);
}

/** POST /transferrecipient */
async function createRecipient({ type, name, accountNumber, bankCode, currency }) {
  return call('POST', '/transferrecipient', {
    type, name, account_number: accountNumber, bank_code: bankCode, currency
  });
}

/** DELETE /transferrecipient/:code (Paystack sets it inactive). */
async function deleteRecipient(code) {
  return call('DELETE', '/transferrecipient/' + encodeURIComponent(code));
}

/**
 * POST /transfer. NEVER retried by this code. `reference` is our unique value.
 * accountReference is sent only when given (Paystack documents it as required
 * in Kenya for Paybill and Till transfers).
 */
async function initiateTransfer({ amount, recipient, reference, reason, currency, accountReference }) {
  const body = { source: 'balance', amount, recipient, reference, currency };
  if (reason) body.reason = reason;
  if (accountReference) body.account_reference = accountReference;
  return call('POST', '/transfer', body);
}

/** POST /transfer/finalize_transfer { transfer_code, otp } */
async function finalizeTransfer(transferCode, otp) {
  return call('POST', '/transfer/finalize_transfer', { transfer_code: transferCode, otp });
}

/** GET /transfer/verify/:reference. Read data.status, not the top-level status. */
async function verifyTransfer(reference) {
  return call('GET', '/transfer/verify/' + encodeURIComponent(reference));
}

module.exports = { fetchBalances, listBanks, createRecipient, deleteRecipient, initiateTransfer, finalizeTransfer, verifyTransfer, IP_HINT };
