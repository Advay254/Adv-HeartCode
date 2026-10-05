/* Embeddable promotion script. Served by the site that owns it.
 *
 * Contains no site name, no domain and no brand values. Two ways to load it:
 *
 *   /embed/<token>.js   The campaign's settings are inside the file, so one
 *                       request is enough. The server adds them in place of
 *                       the HC_INJECT marker on the last line.
 *   /embed.js           The original form (data-token on the script tag). It
 *                       fetches the settings once, with a generous timeout and
 *                       a couple of retries.
 *
 * Both render at once. Nothing waits for idle time, the page load, the host's
 * images or the card scrolling into view. Only the impression count waits for
 * the card to be on screen, because that is what an impression means.
 *
 * It reads nothing from the host page, sets no cookies, uses no browser
 * storage, and never throws into the host page. It prints nothing unless the
 * container (or the script tag) has a data-debug attribute.
 *
 * Plain ES5 on purpose, so old browsers and strict host pages run it. The card
 * is drawn in a closed Shadow DOM when the browser has one, and otherwise
 * directly in the page, where every class name starts with hcp- so it does not
 * collide with the host's styles. The stylesheet comes from the server
 * (lib/promoCard.js), the same text the iframe page uses.
 */
(function (INJ) {
  'use strict';

  var d = document;
  var debug = false;

  function log() {
    if (!debug) return;
    try {
      if (window.console && console.log) {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[promo]');
        console.log.apply(console, args);
      }
    } catch (e) { /* silent */ }
  }

  try { run(); } catch (e) { log('stopped by an error:', e && e.message); }

  function run() {
    var s = d.currentScript;
    if (!s) {
      var tags = d.getElementsByTagName('script');
      for (var i = tags.length - 1; i >= 0; i--) {
        var src = tags[i].getAttribute('src') || '';
        if (src.indexOf('/embed') !== -1 && (tags[i].getAttribute('data-token') || /\/embed\/[\w-]+\.js/.test(src))) { s = tags[i]; break; }
      }
    }

    var token = INJ ? String(INJ.t || '') : ((s && s.getAttribute('data-token')) || '');
    var inline = s ? s.getAttribute('data-config') : null; // set by the admin preview only
    var origin = originOf(s && s.src) || (INJ && originOf(INJ.o)) || '';
    var tokenOk = /^[\w-]{1,64}$/.test(token);

    if (s && s.hasAttribute && s.hasAttribute('data-debug')) debug = true;
    log('script found:', !!s, '| token:', token || '(none)', '| origin:', origin || '(none)');

    if (!inline && !INJ && !tokenOk) { log('not rendered: the script tag has no valid data-token'); return; }
    if (!origin) { log('not rendered: could not work out the site address'); return; }

    function begin() {
      var box = tokenOk ? findContainer(token) : null;
      if (box && box.hasAttribute('data-debug')) debug = true;
      log('container:', box ? 'found by id' : 'none, using the script position');

      if (inline) { var pre; try { pre = JSON.parse(inline); } catch (e) { log('not rendered: bad data-config'); return; } show(pre, true); return; }
      if (INJ && INJ.c) { show(INJ.c, false); return; }
      fetchConfig(function (cfg) { show(cfg, false); });

      function show(cfg, preview) { render(cfg, preview, box, s, token, origin); }
    }

    function fetchConfig(done) {
      var url = origin + '/api/embed/config/' + encodeURIComponent(token);
      var waits = [0, 800, 2500];
      var n = 0;
      (function attempt() {
        var finished = false;
        function fail(why) {
          if (finished) return;
          finished = true;
          log('config request failed (' + why + '), attempt', n + 1, 'of', waits.length);
          n++;
          if (n < waits.length) setTimeout(attempt, waits[n]);
          else log('not rendered: the config could not be loaded');
        }
        try {
          var x = new XMLHttpRequest();
          x.open('GET', url, true);
          x.timeout = 10000;
          x.onload = function () {
            if (finished) return;
            if (x.status < 200 || x.status > 299) return fail('status ' + x.status);
            var cfg;
            try { cfg = JSON.parse(x.responseText); } catch (e) { return fail('bad JSON'); }
            finished = true;
            done(cfg);
          };
          x.onerror = function () { fail('network error'); };
          x.ontimeout = function () { fail('timeout'); };
          x.send();
        } catch (e) { fail('exception'); }
      })();
    }

    // The container normally sits right before the script, so it exists now.
    // If a host runs the script from the head, wait for the page to be parsed.
    if (!inline && tokenOk && !findContainer(token) && d.readyState === 'loading' && d.addEventListener) {
      log('container not parsed yet, waiting for the document');
      d.addEventListener('DOMContentLoaded', begin);
    } else {
      begin();
    }
  }

  function originOf(u) {
    if (typeof u !== 'string') return '';
    var m = /^(https?:\/\/[^\/?#]+)/i.exec(u);
    return m ? m[1] : '';
  }

  // Finds this campaign's container by id. Two snippets for the same campaign
  // share an id, so a container that already has a card is skipped.
  function findContainer(token) {
    var id = 'hc-promo-' + token;
    var list = [];
    try {
      list = d.querySelectorAll('[id="' + id + '"]');
    } catch (e) {
      var one = d.getElementById(id);
      if (one) list = [one];
    }
    for (var i = 0; i < list.length; i++) {
      if (!list[i].getAttribute('data-hc-done')) return list[i];
    }
    return null;
  }

  function okPath(u) {
    return typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/' && u.indexOf('\\') === -1;
  }

  function el(tag, cls, text) {
    var n = d.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.appendChild(d.createTextNode(text)); // text only, never markup
    return n;
  }

  function icon() {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = d.createElementNS(ns, 'svg');
    var p = d.createElementNS(ns, 'path');
    svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    p.setAttribute('d', 'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5');
    svg.appendChild(p);
    return svg;
  }

  function release(box) {
    // Nothing to show: give the reserved space back.
    if (box) { try { box.style.minHeight = '0'; } catch (e) { /* silent */ } }
  }

  function render(cfg, preview, box, s, token, origin) {
    if (!cfg) { log('not rendered: no config'); release(box); return; }
    if (cfg.off) { log('not rendered: this campaign is switched off'); release(box); return; }

    var items = [];
    var all = cfg.items || [];
    for (var i = 0; i < all.length; i++) { if (all[i] && okPath(all[i].u)) items.push(all[i]); }
    if (!items.length) { log('not rendered: the config has nothing to show'); release(box); return; }

    var parent = box || (s && s.parentNode);
    if (!parent) { log('not rendered: nowhere to put the card'); return; }

    var item = items[Math.floor(Math.random() * items.length)];
    var name = String(cfg.name || '');
    var head = String(item.h || '');
    var line = String(item.l || '');

    var tree = el('div', 'hcp-root');
    var cardEl = el('div', 'hcp-card');
    var main = el('div', 'hcp-main');
    var brand = el('div', 'hcp-brand');
    var tile = el('span', 'hcp-tile');
    tile.appendChild(icon());
    brand.appendChild(tile);
    brand.appendChild(el('p', 'hcp-name', name)); // the site name is always shown
    main.appendChild(brand);
    if (head && head !== name) main.appendChild(el('p', 'hcp-head', head));
    if (line) main.appendChild(el('p', 'hcp-line', line));
    cardEl.appendChild(main);

    var a = el('a', 'hcp-btn', String(cfg.btn || ''));
    a.href = origin + item.u;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', String(cfg.btn || '') + (head ? ': ' + head : ''));
    cardEl.appendChild(a);
    tree.appendChild(cardEl);

    // Built completely before it touches the page, then inserted in one step.
    var host = d.createElement('div');
    host.style.display = 'block';
    var root = null;
    if (host.attachShadow) { try { root = host.attachShadow({ mode: 'closed' }); } catch (e) { root = null; } }
    var shadow = !!root;
    if (!root) root = host;
    var style = d.createElement('style');
    style.appendChild(d.createTextNode(String(cfg.css || '')));
    root.appendChild(style);
    root.appendChild(tree);

    if (box) {
      box.setAttribute('data-hc-done', '1');
      box.appendChild(host);
    } else {
      parent.insertBefore(host, s.nextSibling);
    }
    log('rendered the card', shadow ? '(Shadow DOM)' : '(page DOM, prefixed classes)');

    if (!preview) countView(host, token, origin);
  }

  // One count per page view, only after the card has been on screen for a
  // moment. The only thing here that waits for visibility.
  function countView(host, token, origin) {
    var sent = false, seen = false, timer = 0;

    function send() {
      if (sent) return;
      sent = true;
      var ok = false;
      try {
        if (navigator.sendBeacon) ok = navigator.sendBeacon(origin + '/api/embed/impression/' + encodeURIComponent(token));
      } catch (e) { ok = false; }
      if (!ok) {
        try { (new Image()).src = origin + '/api/embed/ping/' + encodeURIComponent(token) + '?r=' + (new Date()).getTime(); } catch (e2) { /* silent */ }
      }
      log('impression sent', ok ? '(beacon)' : '(image ping)');
    }

    function check() {
      if (sent || d.hidden || !seen) return;
      send();
    }

    d.addEventListener('visibilitychange', function () { if (!d.hidden && seen && !sent) timer = setTimeout(check, 1000); });

    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        seen = entries[entries.length - 1].isIntersecting;
        clearTimeout(timer);
        if (seen && !sent) timer = setTimeout(check, 1000);
      }, { threshold: 0.5 }).observe(host);
    } else {
      // Without IntersectionObserver there is no way to know it is on screen,
      // so count after a moment on a visible page.
      seen = true;
      timer = setTimeout(check, 1000);
    }
  }
})(/*HC_INJECT*/null);
