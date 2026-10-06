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

  // Random pick by weight (an item's w, default 1). Done here, in the visitor's
  // browser, so the cached script is identical for every visitor.
  function pick(items) {
    var total = 0, i;
    for (i = 0; i < items.length; i++) total += items[i].w || 1;
    var roll = Math.random() * total;
    for (i = 0; i < items.length; i++) {
      roll -= items[i].w || 1;
      if (roll < 0) return items[i];
    }
    return items[items.length - 1];
  }

  // Reduced motion or a data saver: no animated files.
  function calm() {
    try {
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
      var c = navigator.connection;
      return !!(c && c.saveData);
    } catch (e) { return false; }
  }

  function httpsOnly(u) { return typeof u === 'string' && u.indexOf('https://') === 0; }

  function tell(host, name) {
    // Lets the admin preview show the outcome. Nothing else listens.
    try { var ev = d.createEvent('Event'); ev.initEvent(name, true, false); host.dispatchEvent(ev); } catch (e) { /* silent */ }
  }

  /**
   * Builds the media area of an ad card, or returns null when there is nothing
   * to show. The card text never waits for it: the area is created empty with
   * its space reserved from the ratio, and the file is requested separately
   * once the card is visible or close to visible. Only an img or a video
   * element is ever used, never a frame, embed or markup from the link, so an
   * SVG is only ever an image.
   */
  function buildMedia(m, host, onFail) {
    if (!m || !httpsOnly(m.u)) return null;
    var moving = m.an === true || m.k === 'v';
    var still = httpsOnly(m.s) ? m.s : '';
    var src, asVideo = false;
    if (calm() && moving) {
      // No still image: do not download the animated file at all.
      if (!still) { log('media skipped: reduced motion or data saver, and no still image'); tell(host, 'hcp-media-skipped'); return null; }
      src = still;
    } else {
      src = m.u;
      asVideo = m.k === 'v';
    }

    var r = m.r || [16, 9];
    var w = Number(r[0]) || 16, h = Number(r[1]) || 9;
    var box = el('span', 'hcp-mbox' + (m.f === 'n' ? ' hcp-fit' : ''));
    box.style.setProperty('--hcp-ar', w + ' / ' + h);
    box.style.setProperty('--hcp-arn', String(w / h));

    var node = null, started = false, failed = false, timer = 0;

    function fail(why) {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      log('media failed (' + why + '), showing the text card');
      tell(host, 'hcp-media-failed');
      onFail();
    }

    function start() {
      if (started) return;
      started = true;
      // A request that never answers is treated as a failure too.
      timer = setTimeout(function () { fail('timeout'); }, 20000);
      if (asVideo) {
        node = d.createElement('video');
        node.muted = true; node.defaultMuted = true; node.loop = true; node.controls = false;
        node.setAttribute('muted', ''); node.setAttribute('loop', '');
        node.setAttribute('playsinline', ''); node.setAttribute('webkit-playsinline', '');
        node.setAttribute('preload', 'metadata');
        node.setAttribute('disablepictureinpicture', '');
        node.setAttribute('aria-label', m.a || '');
        if (still) node.poster = still;
        node.onerror = function () { fail('video error'); };
        node.onloadeddata = function () { clearTimeout(timer); };
        node.src = src;
        box.appendChild(node);
        watchVideo(node, box);
      } else {
        node = d.createElement('img');
        node.alt = m.a || '';
        node.setAttribute('referrerpolicy', 'no-referrer');
        node.decoding = 'async';
        node.onerror = function () { fail('image error'); };
        node.onload = function () { clearTimeout(timer); };
        node.src = src;
        box.appendChild(node);
      }
    }

    // Load straight away when visible or close to visible, later when far away.
    if (window.IntersectionObserver) {
      var near = new IntersectionObserver(function (entries) {
        if (entries[entries.length - 1].isIntersecting) { near.disconnect(); start(); }
      }, { rootMargin: '300px 0px' });
      near.observe(box);
    } else {
      start();
    }
    return box;
  }

  // Video plays only while it is on screen, and pauses when scrolled away.
  function watchVideo(v, box) {
    function play() { try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* silent */ } }
    if (!window.IntersectionObserver) { play(); return; }
    new IntersectionObserver(function (entries) {
      if (entries[entries.length - 1].isIntersecting) play();
      else { try { v.pause(); } catch (e) { /* silent */ } }
    }, { threshold: 0.25 }).observe(box);
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

    var item = pick(items);
    var name = String(cfg.name || '');
    var head = String(item.h || '');
    var line = String(item.l || '');
    var label = String(item.b || cfg.btn || '');
    var href = origin + item.u;
    var m = item.m || null;
    var lay = item.lay === 'media' || item.lay === 'banner' ? item.lay : 'text';
    if (!m) lay = 'text';

    // The host element is created first so the media can report to it.
    var host = d.createElement('div');
    host.style.display = 'block';

    var tree = el('div', 'hcp-root' + (item.v ? ' hcp-v' : ''));
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

    var a = el('a', 'hcp-btn', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', label + (head ? ': ' + head : ''));

    // The text card is always built. For a banner it starts hidden and takes
    // over if the media cannot be shown.
    cardEl.appendChild(main);
    cardEl.appendChild(a);

    var banner = null;
    if (lay === 'media') {
      var body = el('div', 'hcp-body');
      var mbox = buildMedia(m, host, function () {
        // Media failed: leave the plain text card in place.
        if (mbox && mbox.parentNode) mbox.parentNode.removeChild(mbox);
        if (body.parentNode) body.parentNode.removeChild(body);
        cardEl.className = 'hcp-card';
        cardEl.appendChild(main);
        cardEl.appendChild(a);
      });
      if (mbox) {
        // appendChild moves the text and button out of the plain card.
        body.appendChild(main);
        body.appendChild(a);
        cardEl.className = 'hcp-card hcp-hasm' + (m.r && m.r[0] / m.r[1] >= 2.4 ? ' hcp-top' : '');
        cardEl.appendChild(mbox);
        cardEl.appendChild(body);
      }
    } else if (lay === 'banner') {
      var bbox = buildMedia(m, host, function () {
        if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
        cardEl.hidden = false;
      });
      if (bbox) {
        banner = el('a', 'hcp-banner');
        banner.href = href;
        banner.target = '_blank';
        banner.rel = 'noopener';
        banner.setAttribute('aria-label', (m.a || head) + (label ? ' (' + label + ')' : ''));
        banner.appendChild(bbox);
        // The site name mark stays visible on the banner.
        var chip = el('span', 'hcp-chip');
        var ctile = el('span', 'hcp-tile'); ctile.appendChild(icon());
        chip.appendChild(ctile); chip.appendChild(el('span', 'hcp-name', name));
        banner.appendChild(chip);
        cardEl.hidden = true;
      }
    }
    tree.appendChild(cardEl);
    if (banner) tree.insertBefore(banner, cardEl);

    // Built completely before it touches the page, then inserted in one step.
    var root = null;
    if (host.attachShadow) { try { root = host.attachShadow({ mode: 'closed' }); } catch (e) { root = null; } }
    var shadow = !!root;
    if (!root) root = host;
    var style = d.createElement('style');
    style.appendChild(d.createTextNode(String(cfg.css || '') + String(item.v || '')));
    root.appendChild(style);
    root.appendChild(tree);

    if (box) {
      box.setAttribute('data-hc-done', '1');
      box.appendChild(host);
    } else {
      parent.insertBefore(host, s.nextSibling);
    }
    log('rendered', lay, 'card', shadow ? '(Shadow DOM)' : '(page DOM, prefixed classes)');

    if (!preview) countView(host, token, origin, item.id || 0);
  }

  // One count per page view, only after the card has been on screen for a
  // moment. The only thing here that waits for visibility.
  function countView(host, token, origin, adId) {
    var extra = adId ? '?a=' + adId : '';
    var sent = false, seen = false, timer = 0;

    function send() {
      if (sent) return;
      sent = true;
      var ok = false;
      try {
        if (navigator.sendBeacon) ok = navigator.sendBeacon(origin + '/api/embed/impression/' + encodeURIComponent(token) + extra);
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
