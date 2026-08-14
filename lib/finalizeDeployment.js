const { getPool } = require('../db/init');
const { getActivePaystackKeys } = require('./paystack');
const { deployToCloudflarePages } = require('./cloudflarePages');
const { sendSiteReadyEmail } = require('./email');
const sitePasswordCache = require('./sitePasswordCache');

/**
 * Injects a simple client-side password gate before </body>. This is
 * NOT real security — the full page content still ships to every visitor's
 * browser regardless (Cloudflare Pages serves static files; there's no
 * server-side enforcement without a Worker doing real auth, which is out
 * of scope here). It's obscurity: enough to stop a site from being
 * casually stumbled on by someone browsing *.pages.dev or guessing a URL,
 * not enough to stop anyone who opens DevTools or views page source. This
 * distinction matters for how it gets described to clients — "password
 * protected" oversells what this actually does.
 */
function injectPasswordGate(html, hashHex) {
  const gate = `
<div id="hc-gate-overlay" style="position:fixed;inset:0;background:#0b0b0f;color:#e8e8ee;display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:320px;width:100%;padding:1.5rem;text-align:center;">
    <h2 style="margin:0 0 1rem;font-size:1.2rem;">This site is password protected</h2>
    <input type="password" id="hc-gate-input" autocomplete="off" style="width:100%;padding:0.6rem;border-radius:6px;border:1px solid #2a2a35;background:#15151c;color:#fff;margin-bottom:0.75rem;box-sizing:border-box;">
    <button id="hc-gate-submit" style="width:100%;padding:0.6rem;border-radius:6px;border:none;background:#6c5ce7;color:#fff;cursor:pointer;">Enter</button>
    <p id="hc-gate-error" style="color:#e74c3c;margin-top:0.5rem;display:none;">Incorrect password</p>
  </div>
</div>
<script>
(function () {
  var HASH = ${JSON.stringify(hashHex)};
  function toHex(buf) {
    return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  async function check() {
    var input = document.getElementById('hc-gate-input').value;
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    if (toHex(digest) === HASH) {
      document.getElementById('hc-gate-overlay').style.display = 'none';
    } else {
      document.getElementById('hc-gate-error').style.display = 'block';
    }
  }
  document.getElementById('hc-gate-submit').addEventListener('click', check);
  document.getElementById('hc-gate-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') check();
  });
})();
</script>
`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, gate + '</body>') : html + gate;
}

/**
 * Idempotently finalizes a deployment for a given Paystack transaction
 * reference. Safe to call concurrently or repeatedly for the same
 * reference from either trigger (the webhook, the browser callback page,
 * or both at nearly the same instant) — exactly one Cloudflare deployment
 * and one email will ever happen per reference, regardless of call order
 * or timing. See the write-up alongside this file's delivery for a
 * concrete walkthrough of how the locking below achieves that; the short
 * version is that a plain "check deployed_sites first" guard is NOT
 * sufficient under real concurrency (both callers could pass the check
 * before either has inserted) — the SELECT ... FOR UPDATE below is what
 * actually serializes concurrent calls for the same reference.
 */
async function finalizeDeployment(reference) {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Row lock on the pending_deployments row for this reference. If
    // another call for the SAME reference is already inside this
    // transaction, this blocks here until that call commits or rolls back.
    const pendingResult = await client.query(
      'SELECT * FROM pending_deployments WHERE reference = $1 FOR UPDATE',
      [reference]
    );

    if (pendingResult.rowCount === 0) {
      // No pending row. Either this reference never existed, or (far more
      // likely, if we just unblocked from another call's lock) that other
      // call already finished and deleted the pending row as the last step
      // of finalizing. Check deployed_sites before declaring "not found".
      const existing = await client.query(
        'SELECT * FROM deployed_sites WHERE reference = $1',
        [reference]
      );
      await client.query('COMMIT');
      return existing.rowCount > 0
        ? { status: 'already_deployed', site: existing.rows[0] }
        : { status: 'not_found' };
    }

    const pending = pendingResult.rows[0];

    if (new Date(pending.expires_at) < new Date()) {
      await client.query('COMMIT');
      return { status: 'expired' };
    }

    // Verify with Paystack — read-only, safe to do while holding the lock.
    const keys = await getActivePaystackKeys();
    if (!keys) {
      await client.query('COMMIT');
      return { status: 'error', error: 'Paystack is not configured' };
    }

    let verifyData;
    try {
      const verifyRes = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${keys.secretKey}` } }
      );
      verifyData = await verifyRes.json();
    } catch (err) {
      await client.query('COMMIT');
      return { status: 'error', error: 'Could not reach Paystack to verify the transaction' };
    }

    // v1.0.6: verified against the SNAPSHOT taken at checkout time
    // (pending.charge_amount / pending.charge_currency), never recomputed
    // here — this is what makes the snapshot meaningful even if the
    // cached exchange rate refreshes between checkout and now. Currency is
    // now checked too (previously only amount was), since a Paystack
    // account could in principle return a transaction in an unexpected
    // currency and an amount-only check wouldn't catch that.
    const txn = verifyData && verifyData.data;
    const expectedAmountMinorUnits = Math.round(Number(pending.charge_amount) * 100);
    if (
      !txn ||
      txn.status !== 'success' ||
      txn.amount !== expectedAmountMinorUnits ||
      txn.currency !== pending.charge_currency
    ) {
      await client.query('COMMIT');
      return { status: 'not_paid' };
    }

    // Deploy to Cloudflare Pages — held inside the lock deliberately. This
    // ties up one DB connection for the duration of a slow external call,
    // which is a real tradeoff, but it's the only thing that guarantees a
    // second concurrent caller can't slip through and deploy a duplicate
    // site while this one is mid-flight. Acceptable at this project's
    // scale (occasional payments, not high throughput); would need
    // rethinking (e.g. an advisory lock released before the external call)
    // if deployment volume grew much higher.
    let htmlToDeploy = pending.rendered_html;
    if (pending.site_password_hash) {
      htmlToDeploy = injectPasswordGate(htmlToDeploy, pending.site_password_hash);
    }

    const deployResult = await deployToCloudflarePages(pending.reference, htmlToDeploy);

    // v1.0.6: back-calculate a USD-equivalent figure from the snapshotted
    // charge, purely so admin revenue totals (routes/adminDashboard.js)
    // stay meaningful when deployments are charged in a mix of USD and
    // KES — summed directly, they'd be summing two different currencies
    // together as if they were the same number. amount_kes is
    // deliberately left NULL for new rows (it's nullable as of this
    // version) — see db/init.js's v1.0.6 migration comment for why it's
    // kept around at all.
    const chargeAmountUsd = pending.charge_currency === 'USD'
      ? Number(pending.charge_amount)
      : (pending.exchange_rate_snapshot
        ? Math.round((Number(pending.charge_amount) / Number(pending.exchange_rate_snapshot) + Number.EPSILON) * 100) / 100
        : null);

    const insertResult = await client.query(
      `INSERT INTO deployed_sites
         (reference, website_type_id, client_email, site_url, cloudflare_project_name,
          charge_currency, charge_amount, charge_amount_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        pending.reference,
        pending.website_type_id,
        pending.client_email,
        deployResult.url,
        deployResult.projectName,
        pending.charge_currency,
        pending.charge_amount,
        chargeAmountUsd
      ]
    );
    const site = insertResult.rows[0];

    await client.query(
      'INSERT INTO subscriber_emails (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [pending.client_email]
    );

    await client.query('DELETE FROM pending_deployments WHERE reference = $1', [reference]);

    await client.query('COMMIT');

    // Email is sent AFTER commit — a delivery hiccup here shouldn't roll
    // back a real, already-live deployment. takeOnce() both reads and
    // discards the plaintext password in one step, whether or not the
    // send actually succeeds.
    const plaintextPassword = sitePasswordCache.takeOnce(reference);
    try {
      await sendSiteReadyEmail(pending.client_email, deployResult.url, plaintextPassword);
    } catch (err) {
      console.error('[FINALIZE] Failed to send site-ready email:', err.message);
      // Deployment already succeeded and is live — don't fail the whole
      // finalize over an email delivery problem. There's no retry path
      // for just the email once finalize succeeds (idempotency short-
      // circuits future calls at the top of this function), so this is a
      // known, accepted gap: the site is fine, the client just might not
      // get the reminder email.
    }

    return { status: 'deployed', site };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[FINALIZE] Error finalizing deployment for reference ${reference}:`, err.message);
    return { status: 'error', error: 'Failed to finalize deployment' };
  } finally {
    client.release();
  }
}

module.exports = { finalizeDeployment };
