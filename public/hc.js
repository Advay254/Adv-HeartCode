/* HeartCode analytics loader (v1.2.16).
 *
 * Only ever requested when analytics is switched on in Site Settings, and
 * never on admin pages or on pages whose address carries a secret. Every
 * value it uses (tracker address, website ID, domains, switches) is read from
 * data-* attributes the server renders from saved settings. Nothing is
 * hardcoded here.
 *
 * Fail closed: the tracker is added by this file only after the function that
 * strips query strings exists, so a tracker can never run without it.
 * Nothing here throws or prints to the console, and nothing it does is
 * visible to the visitor.
 */
(function () {
  'use strict';

  var EVENT_FIELDS = {
    type_viewed: ['type'],
    preview_opened: ['type'],
    build_started: ['type'],
    checkout_started: ['type', 'currency', 'value'],
    details_resend_requested: []
  };
  var CHECKS = {
    type: function (v) { return typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(v) ? v : null; },
    currency: function (v) { return typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : null; },
    value: function (v) {
      var n = Number(v);
      return isFinite(n) && n >= 0 && n <= 1e9 ? Math.round(n * 100) / 100 : null;
    }
  };

  function safe(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  // Keeps only utm_ query parameters and drops the hash.
  function cleanUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 2000) return undefined;
    return safe(function () {
      var absolute = /^https?:\/\//i.test(value);
      var u = new URL(value, location.href);
      var keep = new URLSearchParams();
      u.searchParams.forEach(function (v, k) {
        if (/^utm_/i.test(k)) keep.append(k.toLowerCase(), v.slice(0, 200));
      });
      var qs = keep.toString();
      return (absolute ? u.origin : '') + u.pathname + (qs ? '?' + qs : '');
    });
  }

  // Returns the cleaned data (an object, or null for "no data"), or false to drop.
  function cleanData(name, data) {
    var fields = EVENT_FIELDS[name];
    if (!fields) return false;
    var src = data && typeof data === 'object' ? data : {};
    var out = {};
    for (var i = 0; i < fields.length; i++) {
      var v = CHECKS[fields[i]](src[fields[i]]);
      if (v === null) return false;
      out[fields[i]] = v;
    }
    return fields.length ? out : null;
  }

  var tag = document.currentScript || document.querySelector('script[data-hc-loader]');
  if (!tag) return;
  var cfg = {
    src: tag.getAttribute('data-src') || '',
    id: tag.getAttribute('data-website-id') || '',
    domains: tag.getAttribute('data-domains') || '',
    dnt: tag.getAttribute('data-dnt') === 'true',
    perf: tag.getAttribute('data-perf') === 'true',
    lazy: tag.getAttribute('data-lazy') === 'true',
    proxy: tag.getAttribute('data-proxy') === 'true',
    rec: tag.getAttribute('data-rec') || ''
  };
  var pageEvents = safe(function () { return JSON.parse(tag.getAttribute('data-events') || '[]'); }) || [];

  // ---- state ----
  var interacted = !cfg.lazy; // in lazy mode this flips on the first real interaction
  var pageViewSent = false;
  var lastView = '';
  var pending = []; // events waiting for the tracker, or for the first interaction
  var ready = false;
  var gaveUp = false;

  function umamiReady() {
    return !!(window.umami && typeof window.umami.track === 'function');
  }

  function sendPageView() {
    if (pageViewSent || !umamiReady()) return;
    pageViewSent = true;
    safe(function () { window.umami.track(); });
  }

  // The before-send hook. Umami calls it for every payload.
  // - keeps only utm_ query parameters (url and referrer)
  // - allows only the named events, with only their named fields
  // - in "after first interaction" mode, holds back the automatic page view
  //   and the page speed data until a real interaction has happened
  // Anything unexpected cancels the send (returns undefined).
  window.hcBeforeSend = function (type, payload) {
    try {
      if (!payload || typeof payload !== 'object') return;
      if (type === 'identify') return;
      if (type !== 'event' && type !== 'performance') return;
      if (!interacted) return;

      var url = cleanUrl(payload.url);
      if (payload.url !== undefined && url === undefined) return;
      var out = {};
      var keys = ['website', 'hostname', 'screen', 'language', 'title', 'id', 'cache',
        'lcp', 'inp', 'cls', 'fcp', 'ttfb'];
      for (var i = 0; i < keys.length; i++) {
        if (payload[keys[i]] !== undefined) out[keys[i]] = payload[keys[i]];
      }
      if (url !== undefined) out.url = url;
      var ref = cleanUrl(payload.referrer);
      if (ref !== undefined) out.referrer = ref;

      if (type === 'event' && payload.name !== undefined) {
        var data = cleanData(payload.name, payload.data);
        if (data === false) return;
        out.name = payload.name;
        if (data) out.data = data;
        return out;
      }
      if (type === 'event') {
        // A page view. Send each cleaned address once.
        var key = (out.hostname || '') + (out.url || '');
        if (key === lastView) return;
        lastView = key;
        pageViewSent = true;
      }
      return out;
    } catch (e) {
      return; // fail closed
    }
  };

  function flush() {
    if (!ready || !interacted) return;
    sendPageView();
    var queued = pending;
    pending = [];
    for (var i = 0; i < queued.length; i++) {
      var q = queued[i];
      safe(function () { window.umami.track(q.name, q.data); });
    }
  }

  // Shared helper for events. Never throws, never prints, and does nothing at
  // all when analytics did not start.
  window.hcTrack = function (name, data) {
    try {
      if (gaveUp || typeof name !== 'string') return;
      var clean = cleanData(name, data);
      if (clean === false) return;
      pending.push({ name: name, data: clean || undefined });
      flush();
    } catch (e) { /* never */ }
  };

  // ---- should we run at all ----
  var host = location.hostname.toLowerCase();
  if (cfg.domains && cfg.domains.split(',').indexOf(host) === -1) { gaveUp = true; return; }
  var dntOn = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.msDoNotTrack === '1';
  if (cfg.dnt && dntOn) { gaveUp = true; return; }
  if (window.umami) { gaveUp = true; return; } // a tracker is already on the page

  // ---- interaction detection (lazy mode) ----
  var EVENTS = ['scroll', 'touchstart', 'mousemove', 'click', 'keydown'];
  function onInteract(e) {
    if (!e || e.isTrusted !== true) return;
    interacted = true;
    for (var i = 0; i < EVENTS.length; i++) {
      document.removeEventListener(EVENTS[i], onInteract, true);
      window.removeEventListener(EVENTS[i], onInteract, true);
    }
    flush();
    loadRecorder();
  }
  if (cfg.lazy) {
    for (var i = 0; i < EVENTS.length; i++) {
      document.addEventListener(EVENTS[i], onInteract, { capture: true, passive: true });
      window.addEventListener(EVENTS[i], onInteract, { capture: true, passive: true });
    }
  }

  // ---- the tracker ----
  function loadRecorder() {
    if (!cfg.rec || loadRecorder.done) return;
    if (cfg.lazy && !interacted) return;
    loadRecorder.done = true;
    var tries = 0;
    (function wait() {
      // The recorder needs the tracker's session, so it waits for the tracker.
      if (!umamiReady() && tries++ < 40) return setTimeout(wait, 250);
      safe(function () {
        var r = document.createElement('script');
        r.src = cfg.rec;
        r.defer = true;
        r.setAttribute('data-website-id', cfg.id);
        if (cfg.proxy === false) {
          var h = safe(function () { return new URL(cfg.rec).origin + new URL(cfg.rec).pathname.replace(/\/[^/]*$/, ''); });
          if (h) r.setAttribute('data-host-url', h);
        }
        r.onerror = function () {};
        document.head.appendChild(r);
      });
    })();
  }

  safe(function () {
    var s = document.createElement('script');
    s.src = cfg.src;
    s.defer = true;
    s.async = false;
    s.setAttribute('data-website-id', cfg.id);
    if (cfg.domains) s.setAttribute('data-domains', cfg.domains);
    s.setAttribute('data-do-not-track', cfg.dnt ? 'true' : 'false');
    if (cfg.perf) s.setAttribute('data-performance', 'true');
    if (cfg.proxy) s.setAttribute('data-host-url', location.origin + '/hc');
    if (cfg.lazy) s.setAttribute('data-auto-pageview', 'false');
    s.setAttribute('data-before-send', 'hcBeforeSend');
    s.onload = function () {
      ready = true;
      flush();
      if (!cfg.lazy) loadRecorder();
    };
    s.onerror = function () { gaveUp = true; pending = []; };
    document.head.appendChild(s);
  });

  // Give up quietly if the tracker never arrives.
  setTimeout(function () { if (!ready) { gaveUp = true; pending = []; } }, 6000);

  // ---- page wiring ----
  for (var p = 0; p < pageEvents.length; p++) {
    var ev = pageEvents[p];
    if (ev && typeof ev.name === 'string') window.hcTrack(ev.name, ev.data);
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  onReady(function () {
    // build_started: the first real edit in the build form.
    var form = document.getElementById('buildForm');
    if (form) {
      var slug = form.getAttribute('data-hc-type') || (location.pathname.match(/^\/build\/([^/]+)\/?$/) || [])[1];
      var fired = false;
      var started = function (e) {
        if (fired || !e || e.isTrusted !== true) return;
        fired = true;
        window.hcTrack('build_started', { type: slug });
      };
      form.addEventListener('focusin', started, true);
      form.addEventListener('input', started, true);
      form.addEventListener('change', started, true);
    }

    // details_resend_requested: the button is pressed with an address filled in.
    var resend = document.getElementById('resendDetailsSubmitBtn');
    if (resend) {
      resend.addEventListener('click', function () {
        var email = document.getElementById('resendEmail');
        if (email && email.value && email.value.trim()) window.hcTrack('details_resend_requested');
      });
    }

    // preview_opened: a click on a demo preview link.
    var open = function (e) {
      var a = e.target && e.target.closest ? e.target.closest('[data-hc-preview]') : null;
      if (!a || e.isTrusted !== true) return;
      window.hcTrack('preview_opened', { type: a.getAttribute('data-hc-preview') });
    };
    document.addEventListener('click', open, true);
    document.addEventListener('auxclick', open, true);
  });
})();
