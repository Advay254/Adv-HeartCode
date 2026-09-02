const { getPool } = require('../db/init');
const { getActivePaystackKeys } = require('./paystack');
const { deployToClarityHeart } = require('./clarityheart');
const { sendSiteReadyEmail, sendCustomEmail } = require('./email');
const { notifySaleCompleted } = require('./notifications');
const sitePasswordCache = require('./sitePasswordCache');
const { resolveDeploySlugPattern } = require('./deploySlug');
const { getActiveEmailTemplate, buildEmailVariables, renderEmailContent } = require('./emailTemplates');
const { getActivePasswordPageTemplate, renderPasswordPageContent } = require('./passwordPageTemplates');
const { addTargetBlankToExternalLinks } = require('./externalLinks');

/**
 * v1.0.9: formats deployed_sites.deployed_at (a TIMESTAMPTZ, DEFAULT NOW())
 * into the {{deployed_at}} system variable email templates can reference.
 * A locale string reads naturally in an email body ("Aug 21, 2026, 2:30 PM")
 * — a raw ISO timestamp would technically be correct but looks out of place
 * next to admin-authored copy. Falls back to a plain String() on any
 * unexpected input rather than throwing — this runs post-commit, after a
 * real deployment already succeeded, so a formatting hiccup here should
 * never be what makes the client's confirmation email fail to send.
 */
function formatDeployedAt(date) {
  try {
    return new Date(date).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch (err) {
    return String(date);
  }
}

/**
 * The password-check script shared by BOTH the default gate design and
 * any admin-authored custom one (v1.1.4 Part C) — identical hash-check
 * logic either way, wired up to the same fixed ids
 * (hc-gate-overlay/hc-gate-input/hc-gate-submit/hc-gate-error) regardless
 * of which HTML surrounds them. Kept as its own function so the two
 * gate-building functions below share exactly one copy of this logic
 * rather than drifting apart over time.
 */
function buildGateCheckScript(hashHex) {
  return `
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
  var submitBtn = document.getElementById('hc-gate-submit');
  if (submitBtn) submitBtn.addEventListener('click', check);
  var inputEl = document.getElementById('hc-gate-input');
  if (inputEl) inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') check();
  });
})();
</script>`;
}

/**
 * The original, hardcoded generic gate design — UNCHANGED from before
 * v1.1.4, byte-for-byte, since it's still exactly what a website type
 * with no custom password_page_templates row falls back to (see
 * injectPasswordGate below). This is NOT real security — the full page
 * content still ships to every visitor's browser regardless (ClarityHeart
 * serves static HTML by slug; there's no server-side enforcement without
 * a real auth layer in front of it, which is out of scope here). It's
 * obscurity: enough to stop a site from being casually stumbled on by
 * someone guessing a URL, not enough to stop anyone who opens DevTools or
 * views page source. This distinction matters for how it gets described
 * to clients — "password protected" oversells what this actually does.
 */
function buildDefaultGateHtml(hashHex) {
  const gate = `
<div id="hc-gate-overlay" style="position:fixed;inset:0;background:#0b0b0f;color:#e8e8ee;display:flex;align-items:center;justify-content:center;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:320px;width:100%;padding:1.5rem;text-align:center;">
    <h2 style="margin:0 0 1rem;font-size:1.2rem;">This site is password protected</h2>
    <input type="password" id="hc-gate-input" autocomplete="off" style="width:100%;padding:0.6rem;border-radius:6px;border:1px solid #2a2a35;background:#15151c;color:#fff;margin-bottom:0.75rem;box-sizing:border-box;">
    <button id="hc-gate-submit" style="width:100%;padding:0.6rem;border-radius:6px;border:none;background:#6c5ce7;color:#fff;cursor:pointer;">Enter</button>
    <p id="hc-gate-error" style="color:#e74c3c;margin-top:0.5rem;display:none;">Incorrect password</p>
  </div>
</div>`;
  return gate + buildGateCheckScript(hashHex);
}

/**
 * v1.1.4 Part C: the custom-password-page counterpart to
 * buildDefaultGateHtml above. Wraps the admin's own design (after
 * substituting its two supported tokens — see
 * lib/passwordPageTemplates.js) in the same full-screen, top-layer
 * overlay div the default gate uses, so hiding it on a correct password
 * behaves identically either way. Deliberately a MINIMAL wrapper
 * (position/z-index only, no background/centering) — the admin's own
 * HTML supplies all of that ("the admin designs everything around" the
 * functional element, per this feature's own spec), unlike the default
 * gate's wrapper, which also supplies the background/centering because
 * there's no admin design to defer to there.
 */
function buildCustomGateHtml(renderedPageHtml, hashHex) {
  const gate = `
<div id="hc-gate-overlay" style="position:fixed;inset:0;z-index:2147483647;overflow:auto;">
${renderedPageHtml}
</div>`;
  return gate + buildGateCheckScript(hashHex);
}

/**
 * Injects the password gate before </body> — the default hardcoded
 * design, or (v1.1.4 Part C) an admin-authored custom password page for
 * this website type if one has been saved and activated. Falls back to
 * the default the same non-breaking way email_templates already does
 * (v1.0.9): a type with no active password_page_templates row, or any
 * unexpected failure while building the custom one, silently uses the
 * default gate rather than the deployment ever failing over this.
 */
async function injectPasswordGate(html, hashHex, websiteTypeId, websiteTypeName) {
  let gateHtml;
  try {
    const customTemplate = await getActivePasswordPageTemplate(websiteTypeId);
    gateHtml = customTemplate
      ? buildCustomGateHtml(renderPasswordPageContent(customTemplate.html_content, websiteTypeName), hashHex)
      : buildDefaultGateHtml(hashHex);
  } catch (err) {
    console.error('[FINALIZE] Failed to build custom password page, falling back to the default gate:', err.message);
    gateHtml = buildDefaultGateHtml(hashHex);
  }
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, gateHtml + '</body>') : html + gateHtml;
}

/**
 * Idempotently finalizes a deployment for a given Paystack transaction
 * reference. Safe to call concurrently or repeatedly for the same
 * reference from either trigger (the webhook, the browser callback page,
 * or both at nearly the same instant) — exactly one deployment
 * and one email will ever happen per reference, regardless of call order
 * or timing. See the write-up alongside this file's delivery for a
 * concrete walkthrough of how the locking below achieves that; the short
 * version is that a plain "check deployed_sites first" guard is NOT
 * sufficient under real concurrency (both callers could pass the check
 * before either has inserted) — the SELECT ... FOR UPDATE below is what
 * actually serializes concurrent calls for the same reference.
 *
 * v1.1.0: `skipExpiryCheck` (default false) — when true, bypasses the
 * `pending.expires_at` short-circuit below entirely and proceeds straight
 * to a real Paystack verification regardless of how long ago that 1-hour
 * window closed. The webhook (routes/webhooks.js) and the browser's own
 * checkout-callback page (routes/public.js) both call this function with
 * NO second argument, so their behavior is completely unchanged — a
 * client landing on a genuinely stale callback page still gets exactly
 * the same fast, no-network-call "expired" response as before. ONLY the
 * new admin-triggered retry route (routes/adminRecovery.js) ever passes
 * `true` — that's a deliberate trust-boundary line: only an authenticated
 * admin deliberately clicking "Check & Deploy" gets the bypass, not the
 * public unauthenticated callback URL. This is what makes recovering a
 * payment whose webhook never fired possible at all: without this, ANY
 * row an admin could see in the new Recovery view (by definition already
 * past its 1-hour expires_at — that's what "Needs attention" means) would
 * always hit the old short-circuit and never actually get re-verified.
 */
async function finalizeDeployment(reference, { skipExpiryCheck = false } = {}) {
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

    if (!skipExpiryCheck && new Date(pending.expires_at) < new Date()) {
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

    // v1.0.9: selects the full row (not just deploy_slug_pattern) so it can
    // also be reused post-commit for the email template's
    // {{website_type_name}} system variable, without a second query.
    // v1.1.4: moved up ahead of the password-gate injection below (it used
    // to run after) — the gate now also needs this row's id/name to look
    // up an active custom password_page_templates row, so the query has
    // to happen before it's used rather than after.
    const typeResult = await client.query(
      'SELECT * FROM website_types WHERE id = $1',
      [pending.website_type_id]
    );
    const websiteTypeRow = typeResult.rowCount > 0 ? typeResult.rows[0] : null;
    const deploySlugPattern = websiteTypeRow ? websiteTypeRow.deploy_slug_pattern : null;

    // Deploy to ClarityHeart — held inside the lock deliberately, same
    // reasoning as before this version (this used to be a Cloudflare
    // Pages deploy via wrangler; it's now an HTTP call to ClarityHeart's
    // own API instead, but the tradeoff is identical either way). This
    // ties up one DB connection for the duration of a slow external call,
    // which is a real tradeoff, but it's the only thing that guarantees a
    // second concurrent caller can't slip through and deploy a duplicate
    // site while this one is mid-flight. Acceptable at this project's
    // scale (occasional payments, not high throughput); would need
    // rethinking (e.g. an advisory lock released before the external call)
    // if deployment volume grew much higher.
    let htmlToDeploy = addTargetBlankToExternalLinks(pending.rendered_html);
    if (pending.site_password_hash) {
      htmlToDeploy = await injectPasswordGate(
        htmlToDeploy,
        pending.site_password_hash,
        pending.website_type_id,
        websiteTypeRow ? websiteTypeRow.name : ''
      );
    }

    // v1.0.8 Part B: if this website type has a custom deploy_slug_pattern,
    // resolve it against the raw form values captured at checkout
    // (pending.raw_field_values) and use THAT as the deploy seed instead
    // of the default reference-based one. If there's no pattern, or it
    // resolves to nothing usable (e.g. only referenced fields that weren't
    // submitted), this falls through to the default — the reference
    // itself.
    //
    // pending.reference is a Paystack reference (routes/public.js:
    // `hc-${crypto.randomBytes(8).toString('hex')}`) — that "hc-" belongs
    // to the payment reference format, not to any hosting backend's
    // naming, and is unconditionally stripped here before use as a
    // deploy seed (otherwise it would flow straight through slugify()
    // into the final slug unchanged).
    //
    // v1.1.9 Part A: this no longer pre-checks deployed_sites for a
    // collision or carries an "appendRandom" decision the way the old
    // Cloudflare Pages path did — that responsibility now belongs
    // entirely to ClarityHeart itself, per its own documented contract
    // (a collision on its side changes the returned `slug`, which is
    // always what actually gets used — see lib/clarityheart.js and the
    // INSERT below, which stores deployResult.slug, never this seed).
    // Removing that pre-check isn't a corner cut: it's what the spec for
    // this migration explicitly calls for ("always use the returned
    // url/slug, never assume the requested one was honored"), and it
    // removes a whole class of TOCTOU-shaped staleness this function
    // never needed once ClarityHeart owns uniqueness on its own side.
    let seed = pending.reference.replace(/^hc-/, '');

    if (deploySlugPattern) {
      const resolvedSlug = resolveDeploySlugPattern(deploySlugPattern, pending.raw_field_values || {});
      if (resolvedSlug) {
        seed = resolvedSlug;
      }
    }

    const deployResult = await deployToClarityHeart(seed, htmlToDeploy);

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
         (reference, website_type_id, client_email, site_url, deployed_slug,
          charge_currency, charge_amount, charge_amount_usd, has_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        pending.reference,
        pending.website_type_id,
        pending.client_email,
        deployResult.url,
        deployResult.slug,
        pending.charge_currency,
        pending.charge_amount,
        chargeAmountUsd,
        Boolean(pending.site_password_hash)
      ]
    );
    const site = insertResult.rows[0];

    await client.query(
      'INSERT INTO subscriber_emails (email) VALUES ($1) ON CONFLICT (email) DO NOTHING',
      [pending.client_email]
    );

    // v1.1.0 Part B: the ONLY place in the entire app that ever inserts a
    // 'payment_completed' funnel event — deliberately never accepted from
    // the public client-submitted POST /api/events (see routes/events.js,
    // which validates event_type against an enum that explicitly excludes
    // this value). A client-side event for "I paid" would be trivially
    // fakeable by anyone who opens devtools and replays the request, and
    // pointless to chart regardless — this is the one stage where only a
    // server-verified fact (we just committed a real deployment
    // for a Paystack-verified transaction, in the same transaction as this
    // insert) counts. Guarded on funnel_session_id being present — an
    // older pending row (pre-v1.1.0), or a checkout where the client never
    // captured a session_id (JS blocked, sendBeacon unsupported), simply
    // skips this one event rather than violating funnel_events.session_id's
    // NOT NULL constraint. An analytics gap here is acceptable; the
    // deployment itself is entirely unaffected either way. This also means
    // a deployment recovered LATER via the admin "Check & Deploy" retry
    // button (routes/adminRecovery.js, which calls this same function)
    // correctly fires payment_completed too — a payment recovered days
    // after the fact still genuinely completed, and should count.
    if (pending.funnel_session_id) {
      await client.query(
        'INSERT INTO funnel_events (event_type, website_type_id, session_id) VALUES ($1, $2, $3)',
        ['payment_completed', pending.website_type_id, pending.funnel_session_id]
      );
    }

    await client.query('DELETE FROM pending_deployments WHERE reference = $1', [reference]);

    await client.query('COMMIT');

    // Email is sent AFTER commit — a delivery hiccup here shouldn't roll
    // back a real, already-live deployment. takeOnce() both reads and
    // discards the plaintext password in one step, whether or not the
    // send actually succeeds.
    const plaintextPassword = sitePasswordCache.takeOnce(reference);
    try {
      // v1.0.9 Part A: if this website type has an active custom email
      // template, use it; otherwise fall back to the original generic
      // email exactly as before. The "does a custom template exist and can
      // it be built successfully" check is wrapped in its OWN inner
      // try/catch, separate from the outer one — a DB hiccup or unexpected
      // shape while looking up/building the custom template falls back to
      // the generic email rather than the client getting no email at all,
      // while a failure actually SENDING (either path) is still caught by
      // the outer catch below exactly like before.
      let sentCustom = false;
      try {
        const emailTemplate = await getActiveEmailTemplate(pending.website_type_id);
        if (emailTemplate) {
          const systemVars = {
            site_url: deployResult.url,
            client_email: pending.client_email,
            website_type_name: websiteTypeRow ? websiteTypeRow.name : '',
            deployed_at: formatDeployedAt(site.deployed_at),
            site_password: plaintextPassword || ''
          };
          const { flatValues, arrayValues } = await buildEmailVariables(
            pending.website_type_id,
            systemVars,
            pending.raw_field_values,
            pending.ai_output_values
          );
          const { subject, html } = renderEmailContent(emailTemplate, flatValues, arrayValues);
          await sendCustomEmail(pending.client_email, subject, html);
          sentCustom = true;
        }
      } catch (templateErr) {
        console.error('[FINALIZE] Failed to build/send custom email template, falling back to generic email:', templateErr.message);
      }

      if (!sentCustom) {
        await sendSiteReadyEmail(pending.client_email, deployResult.url, plaintextPassword);
      }
    } catch (err) {
      console.error('[FINALIZE] Failed to send site-ready email:', err.message);
      // Deployment already succeeded and is live — don't fail the whole
      // finalize over an email delivery problem. There's no retry path
      // for just the email once finalize succeeds (idempotency short-
      // circuits future calls at the top of this function), so this is a
      // known, accepted gap: the site is fine, the client just might not
      // get the reminder email.
    }

    // v1.1.2 Part B: admin sale notifications — same point, same "never
    // let a delivery problem here affect the deployment or the client's
    // own email" posture as the block above, but this is its own try/catch
    // (not folded into the one above) so a client-email failure and a
    // notification failure are logged and handled completely independently
    // of one another. notifySaleCompleted() itself already never throws
    // (see lib/notifications.js) — this try/catch is defense in depth in
    // case that contract is ever violated by a future change, not
    // something expected to trigger in practice.
    try {
      await notifySaleCompleted({
        websiteType: websiteTypeRow ? websiteTypeRow.name : 'Unknown type',
        clientEmail: pending.client_email,
        siteUrl: deployResult.url,
        amount: Number(pending.charge_amount),
        currency: pending.charge_currency,
        deployedAtDisplay: formatDeployedAt(site.deployed_at),
        deployedAtIso: new Date(site.deployed_at).toISOString()
      });
    } catch (err) {
      console.error('[FINALIZE] notifySaleCompleted threw unexpectedly (it should never throw) — sale notifications may not have been sent:', err.message);
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
