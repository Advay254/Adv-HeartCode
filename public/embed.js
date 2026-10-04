/* Embeddable promotion script. Served by the site that owns it.
 *
 * Contains no site name, no domain and no brand values. It works out its own
 * origin from the address it was loaded from, fetches one small config from
 * that origin and renders what comes back inside a closed Shadow DOM, right
 * after its own script tag. It reads nothing from the host page, sets no
 * cookies, uses no browser storage, and never throws into the host page:
 * if anything goes wrong it renders nothing and says nothing.
 *
 * The rules in the CSS string below mirror the frame page in
 * lib/promoRender.js. If one changes, change the other.
 */
(function () {
  'use strict';
  try {
    var s = document.currentScript;
    if (!s) {
      var all = document.querySelectorAll('script[data-token][src*="embed.js"]');
      s = all[all.length - 1];
    }
    if (!s || !s.src) return;
    var token = s.getAttribute('data-token') || '';
    var inline = s.getAttribute('data-config'); // set by the admin preview only
    var origin = new URL(s.src, location.href).origin;
    if (!inline && !/^[\w-]{1,64}$/.test(token)) return;

    var idle = window.requestIdleCallback || function (f) { setTimeout(f, 1); };
    idle(start, { timeout: 2000 });
  } catch (e) { /* never reach the host page */ }

  function start() {
    try {
      if (inline) { render(JSON.parse(inline), true); return; }
      var late = false;
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () { late = true; if (ctl) ctl.abort(); }, 4000);
      fetch(origin + '/api/embed/config/' + encodeURIComponent(token), {
        credentials: 'omit', mode: 'cors', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        clearTimeout(timer);
        return r.ok ? r.json() : null;
      }).then(function (cfg) {
        if (cfg && !late) render(cfg, false);
      }).catch(function () {});
    } catch (e) { /* silent */ }
  }

  function ok(u) {
    try {
      return typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/' &&
        new URL(u, origin).origin === origin;
    } catch (e) { return false; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text; // text only, never markup
    return n;
  }

  function heart(cls) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    var p = document.createElementNS(ns, 'path');
    svg.setAttribute('width', '14'); svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    p.setAttribute('d', 'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5');
    svg.appendChild(p);
    svg.setAttribute('class', cls);
    return svg;
  }

  function render(cfg, preview) {
    var items = (cfg && !cfg.off && cfg.items || []).filter(function (i) { return i && ok(i.u); });
    if (!items.length || !s.parentNode || !Element.prototype.attachShadow) return;

    var item = items[Math.floor(Math.random() * items.length)];
    var c = cfg.c || {};
    var dark = cfg.theme === 'dark' ||
      (cfg.theme === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    var ink = c.i || '#111111', ac = c.a || ink, hv = c.h || ac;
    var name = cfg.name || '', head = item.h || '', line = item.l || '';
    var showHead = head && head !== name;
    var style = cfg.style === 'slim' || cfg.style === 'text' ? cfg.style : 'card';

    var css = ':host{display:block}*{box-sizing:border-box}' +
      '.w{margin:12px 0;font-family:inherit;font-size:14px;line-height:1.45;color:' + (dark ? '#fff' : ink) + '}' +
      '.c{max-width:420px;padding:16px 18px;border:1px solid ' + (dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)') +
      ';border-radius:14px;background:' + (dark ? ink : '#fff') + '}' +
      '.nm{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:' + (dark ? hv : ac) + '}' +
      '.hd{margin:6px 0 2px;font-size:17px;font-weight:700;line-height:1.25}.ln{margin:6px 0 0;opacity:.78}' +
      '.s{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid ' +
      (dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)') + ';border-radius:10px;background:' + (dark ? ink : '#fff') +
      ';white-space:nowrap}.s .tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}' +
      '.s .mk{display:flex;flex:none;color:' + (dark ? hv : ac) + '}.s .b{margin:0;padding:6px 14px;flex:none}' +
      '.t{margin:0;line-height:1.5}' +
      '.b{display:inline-block;margin-top:12px;padding:8px 16px;border-radius:999px;background:' + ac +
      ';color:' + (c.t || '#fff') + ';font-weight:600;font-size:14px;line-height:1.2;text-decoration:none;' +
      'transition:background-color .3s ease-out,color .3s ease-out}' +
      '.k{color:' + (dark ? hv : ac) + ';font-weight:600;text-decoration:underline;border-radius:3px;' +
      'transition:background-color .3s ease-out,color .3s ease-out}' +
      '.b:hover,.b:active,.b:focus-visible,.k:hover,.k:active,.k:focus-visible{background:' + hv + ';color:' + (c.ht || ink) + '}' +
      'a:focus-visible{outline:2px solid ' + ac + ';outline-offset:2px}' +
      '@media (prefers-reduced-motion:reduce){.b,.k{transition:none}}';

    var a = el('a', style === 'text' ? 'k' : 'b', cfg.btn || '');
    a.href = new URL(item.u, origin).href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.setAttribute('aria-label', (cfg.btn || '') + ': ' + head);

    var w = el('div', 'w');
    if (style === 'slim') {
      var row = el('div', 's');
      var mk = el('span', 'mk'); mk.appendChild(heart('ic'));
      var parts = [name].concat(showHead ? [head] : [], line ? [line] : []).filter(Boolean);
      row.appendChild(mk);
      row.appendChild(el('span', 'tx', parts.join(': ')));
      row.appendChild(a);
      w.appendChild(row);
    } else if (style === 'text') {
      var p = el('p', 't', (showHead ? head + (name ? ' on ' + name : '') : (name || head)) + (line ? ': ' + line : '') + ' ');
      p.appendChild(a);
      w.appendChild(p);
    } else {
      var card = el('div', 'c');
      if (name) {
        var nm = el('div', 'nm'); nm.appendChild(heart('ic')); nm.appendChild(el('span', '', name));
        card.appendChild(nm);
      }
      if (showHead) card.appendChild(el('p', 'hd', head));
      if (line) card.appendChild(el('p', 'ln', line));
      card.appendChild(a);
      w.appendChild(card);
    }

    // Built completely before it touches the page, then inserted in one step,
    // so the host page changes once and never again.
    var host = document.createElement('div');
    var root = host.attachShadow({ mode: 'closed' });
    root.appendChild(el('style', '', css));
    root.appendChild(w);
    s.parentNode.insertBefore(host, s.nextSibling);

    if (!preview) countView(host);
  }

  // One count per page view, only after the promo has been on screen for a
  // moment. A tiny request with no body, no cookies and no stored state.
  function countView(host) {
    var sent = false, seen = false, t = 0;
    function send() {
      if (sent) return;
      if (document.hidden) { document.addEventListener('visibilitychange', check); return; }
      sent = true;
      try {
        var url = origin + '/api/embed/impression/' + encodeURIComponent(token);
        if (navigator.sendBeacon) navigator.sendBeacon(url);
        else fetch(url, { method: 'POST', mode: 'no-cors', credentials: 'omit', keepalive: true }).catch(function () {});
      } catch (e) { /* silent */ }
    }
    function check() {
      document.removeEventListener('visibilitychange', check);
      if (seen && !document.hidden) send();
    }
    if (!('IntersectionObserver' in window)) return;
    new IntersectionObserver(function (entries) {
      seen = entries[entries.length - 1].isIntersecting;
      clearTimeout(t);
      if (seen && !sent) t = setTimeout(send, 1000);
    }, { threshold: 0.5 }).observe(host);
  }
})();
