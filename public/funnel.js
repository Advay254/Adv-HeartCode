/**
 * v1.1.0 Part B: lightweight, first-party, anonymous funnel event
 * tracking. Loaded on every public page via views/partials/public-head.ejs
 * — entirely separate from anything an admin might inject via the v1.0.7
 * script manager (lib/siteScripts.js), which is for THIRD-PARTY snippets
 * an admin pastes in; this file is first-party code shipped with the app
 * itself, purpose-built to answer one question: where do people drop off
 * between "visited the site" and "actually paid".
 *
 * PRIVACY: the session identifier generated below is NOT a persistent
 * cookie, is NEVER tied to an email address, IP address, or any other
 * identifying information, and lives only in sessionStorage — gone the
 * moment the browser tab/session ends. Its only job is letting the admin
 * Funnel page count how many (anonymous) visits reached each stage of the
 * client journey; it is never sent anywhere except this app's own
 * same-origin /api/events endpoint. The one event fired from
 * server-side code rather than here (`payment_completed`) is documented
 * in lib/finalizeDeployment.js.
 */
(function () {
  var SESSION_KEY = 'hc_funnel_session_id';

  function getSessionId() {
    try {
      var existing = sessionStorage.getItem(SESSION_KEY);
      if (existing) return existing;
      var id = (window.crypto && typeof window.crypto.randomUUID === 'function')
        ? window.crypto.randomUUID()
        : (Date.now().toString(36) + Math.random().toString(36).slice(2));
      sessionStorage.setItem(SESSION_KEY, id);
      return id;
    } catch (err) {
      // sessionStorage blocked (locked-down private browsing, etc.) —
      // fall back to a per-call random id rather than throwing. Funnel
      // tracking degrading silently is fine; it must never break the page.
      return 'no-storage-' + Math.random().toString(36).slice(2);
    }
  }

  /**
   * Fire-and-forget: the page must never wait on this call or feel slower
   * because of it. navigator.sendBeacon is preferred — it's designed for
   * exactly this (survives page navigation/unload, never blocks) — with a
   * non-blocking fetch as the fallback where sendBeacon isn't available.
   * websiteTypeId is optional (home/explore views aren't tied to a type).
   */
  function trackEvent(eventType, websiteTypeId) {
    try {
      var payload = { event_type: eventType, session_id: getSessionId() };
      if (websiteTypeId) payload.website_type_id = Number(websiteTypeId);
      var body = JSON.stringify(payload);

      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true
        }).catch(function () {});
      }
    } catch (err) {
      // Analytics must never break the page it's tracking.
    }
  }

  // Exposed globally so other page-specific scripts (public/site.js) can
  // fire events tied to something other than a plain page load —
  // `preview_generated` (after a successful /api/build/:slug/generate
  // response) and the session id itself (threaded through the checkout
  // POST body so the server-side `payment_completed` event, fired from
  // lib/finalizeDeployment.js, can be attached to the same anonymous
  // session as the rest of that visit's funnel).
  window.hcTrackEvent = trackEvent;
  window.hcGetSessionId = getSessionId;

  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.dataset.page;
    var websiteTypeId = document.body.dataset.websiteTypeId || null;

    // Page-load-triggered stages. checkout_started fires on CHECKOUT PAGE
    // LOAD specifically (not on the "Deploy this site" click on the
    // preview page) — chosen for consistency with every other stage in
    // this funnel, which are all page-load signals, and because a click
    // can happen without the visitor actually landing on checkout (e.g.
    // preview session data went missing and site.js redirects back to the
    // build page instead) — counting the click itself would overstate how
    // many visits genuinely reached the checkout stage.
    if (page === 'home') trackEvent('page_view_home');
    if (page === 'explore') trackEvent('page_view_explore');
    if (page === 'build') trackEvent('form_started', websiteTypeId);
    if (page === 'checkout') trackEvent('checkout_started', websiteTypeId);
  });
})();
