/* v1.2.20: shared admin experience, loaded on every admin page after admin.js.
   Two things, both generic so every page gets them without per-page code:

   1. Save feedback. When a button is pressed and the page then sends a
      change to the server (POST, PUT, PATCH, DELETE), the button shows a
      working state, then a Saved (or failed) state, and a small popup
      appears next to the button and disappears by itself. A new press
      clears whatever the last one left behind, so the screen never shows
      an old result for a new press.

   2. Lists. Every table gets clickable column headings (sort), a search box
      and next / previous pages once it has more than a page of rows. When
      a table has no sort chosen it shows newest first.

   Nothing here changes what the page sends or how its own script works: the
   server answer is passed through untouched. */
(function () {
  'use strict';
  if (/\/login\/?$/.test(location.pathname)) return;

  var SAVED_MS = 1800;      // how long the button shows "saved"
  var POP_OK_MS = 2600;     // how long a success popup stays
  var POP_ERR_MS = 6000;    // how long an error popup stays
  var INLINE_OK_MS = 2600;  // how long an old inline success line stays
  var PAGE_SIZES = [10, 25, 50];

  function svg(paths, cls) {
    return '<svg class="' + (cls || '') + '" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  var ICON = {
    up: svg('<path d="m5 12 7-7 7 7" /><path d="M12 19V5" />'),
    down: svg('<path d="M12 5v14" /><path d="m19 12-7 7-7-7" />'),
    both: svg('<path d="m7 15 5 5 5-5" /><path d="m7 9 5-5 5 5" />'),
    left: svg('<path d="m15 18-6-6 6-6" />'),
    right: svg('<path d="m9 18 6-6-6-6" />'),
    search: svg('<path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" />'),
    ok: svg('<circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" />'),
    warn: svg('<circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" />')
  };

  /* ------------------------------------------------------------------ */
  /* 1. Save feedback                                                    */
  /* ------------------------------------------------------------------ */

  var actor = null;        // { btn, at }
  var popup = null;        // { el, btn, timer }
  var btnTimers = new WeakMap();

  function isFeedbackButton(el) {
    if (!el || !el.closest) return null;
    var b = el.closest('button, a.admin-btn, input[type="submit"]');
    if (!b) return null;
    if (b.closest('.admin-sidebar, .admin-topbar, [role="tablist"], .admin-tabs, [data-no-feedback]')) return null;
    if (b.id === 'logoutBtn' || b.hasAttribute('data-no-feedback')) return null;
    return b;
  }

  function clearButton(btn) {
    var t = btnTimers.get(btn);
    if (t) { clearTimeout(t); btnTimers.delete(btn); }
    btn.classList.remove('is-saving', 'is-saved', 'is-failed');
    btn.removeAttribute('aria-busy');
  }

  function clearPopup() {
    if (!popup) return;
    clearTimeout(popup.timer);
    if (popup.el && popup.el.parentNode) popup.el.parentNode.removeChild(popup.el);
    popup = null;
  }

  function placePopup() {
    if (!popup || !popup.btn || !document.body.contains(popup.btn)) { clearPopup(); return; }
    var r = popup.btn.getBoundingClientRect();
    var el = popup.el;
    var w = el.offsetWidth, h = el.offsetHeight;
    var vw = document.documentElement.clientWidth;
    var left, top, side;
    if (r.right + 12 + w <= vw - 8) {          // room on the right of the button
      left = r.right + 12; top = r.top + (r.height - h) / 2; side = 'right';
    } else if (r.left - 12 - w >= 8) {         // otherwise on the left
      left = r.left - 12 - w; top = r.top + (r.height - h) / 2; side = 'left';
    } else {                                    // narrow screen: above the button
      left = Math.min(Math.max(8, r.left), vw - w - 8); top = r.top - h - 10; side = 'top';
      if (top < 8) { top = r.bottom + 10; side = 'bottom'; }
    }
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.setAttribute('data-side', side);
  }

  function showPopup(btn, text, kind) {
    clearPopup();
    var el = document.createElement('div');
    el.className = 'admin-save-pop is-' + kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.innerHTML = (kind === 'error' ? ICON.warn : ICON.ok) + '<span></span>';
    el.lastChild.textContent = text;
    document.body.appendChild(el);
    popup = { el: el, btn: btn, timer: setTimeout(clearPopup, kind === 'error' ? POP_ERR_MS : POP_OK_MS) };
    placePopup();
    requestAnimationFrame(function () { el.classList.add('is-in'); });
  }

  window.addEventListener('scroll', placePopup, true);
  window.addEventListener('resize', placePopup);

  function hideStaleMessages(btn) {
    var scope = btn.closest('form, .admin-card');
    if (!scope) return;
    scope.querySelectorAll('.admin-msg-success, .admin-msg-error, .admin-msg-warning').forEach(function (m) {
      // Only lines the page itself shows after an action (they carry an inline style); fixed notes stay.
      if (m.hasAttribute('data-keep') || !m.hasAttribute('style')) return;
      m.style.display = 'none';
    });
  }

  function remember(btn) {
    if (actor && actor.btn !== btn) clearButton(actor.btn);
    clearButton(btn);
    clearPopup();
    hideStaleMessages(btn);
    actor = { btn: btn, at: Date.now(), pending: 0 };
  }

  document.addEventListener('click', function (e) {
    var b = isFeedbackButton(e.target);
    if (b && !b.disabled) remember(b);
  }, true);

  document.addEventListener('submit', function (e) {
    var b = e.submitter && isFeedbackButton(e.submitter);
    if (!b) b = e.target && e.target.querySelector && isFeedbackButton(e.target.querySelector('button[type="submit"], input[type="submit"]'));
    if (b && (!actor || actor.btn !== b || Date.now() - actor.at > 400)) remember(b);
  }, true);

  function wordsFor(method, btn) {
    var custom = btn && btn.getAttribute('data-saved-text');
    if (custom) return custom;
    if (method === 'DELETE') return 'Deleted';
    if (btn && /^\s*add\b/i.test(btn.textContent)) return 'Added';
    if (method === 'POST') return 'Done';
    return 'Saved';
  }

  var realFetch = window.fetch;
  if (typeof realFetch === 'function') {
    window.fetch = function (input, init) {
      var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var mine = null;
      if (method !== 'GET' && method !== 'HEAD' && actor && document.body.contains(actor.btn) && Date.now() - actor.at < 4000) {
        mine = actor;
        mine.pending++;
        mine.btn.classList.remove('is-saved', 'is-failed');
        mine.btn.classList.add('is-saving');
        mine.btn.setAttribute('aria-busy', 'true');
        clearPopup();
      }
      var p = realFetch.apply(this, arguments);
      if (!mine) return p;

      function settle(kind, text) {
        mine.pending = Math.max(0, mine.pending - 1);
        if (mine.pending > 0 && kind === 'ok') return;
        var btn = mine.btn;
        if (!document.body.contains(btn)) { clearPopup(); return; }
        clearButton(btn);
        btn.classList.add(kind === 'ok' ? 'is-saved' : 'is-failed');
        btnTimers.set(btn, setTimeout(function () { clearButton(btn); }, kind === 'ok' ? SAVED_MS : 2600));
        showPopup(btn, text, kind === 'ok' ? 'success' : 'error');
        if (kind === 'ok') btn.dispatchEvent(new CustomEvent('admin:saved', { bubbles: true }));
      }

      p.then(function (res) {
        if (res && res.ok) { settle('ok', wordsFor(method, mine.btn)); return; }
        var fallback = 'Could not save. Please try again.';
        try {
          res.clone().json().then(function (d) {
            settle('fail', (d && typeof d.error === 'string' && d.error) ? d.error : fallback);
          }, function () { settle('fail', fallback); });
        } catch (_e) { settle('fail', fallback); }
      }, function () {
        settle('fail', 'Network problem. Please try again.');
      });
      return p;
    };
  }

  // Old inline success lines fade away by themselves too.
  function watchInlineMessages() {
    var timers = new WeakMap();
    function check(node) {
      if (!node || node.nodeType !== 1 || !node.classList) return;
      if (!node.classList.contains('admin-msg-success') || node.hasAttribute('data-keep')) return;
      if (node.style.display === 'none' || !node.textContent.trim() || node.querySelector('a')) return;
      // The popup beside the button already said it: do not say it twice.
      if (popup && popup.btn && popup.el.classList.contains('is-success') && node.closest('form, .admin-card') && node.closest('form, .admin-card').contains(popup.btn) && node.textContent.length < 60) {
        node.style.display = 'none';
        return;
      }
      var t = timers.get(node);
      if (t) clearTimeout(t);
      timers.set(node, setTimeout(function () { node.style.display = 'none'; }, INLINE_OK_MS));
    }
    var mo = new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (m.type === 'attributes') check(m.target);
        else if (m.type === 'characterData') check(m.target.parentNode);
        else m.addedNodes.forEach(function (n) { check(n); if (n.nodeType === 1 && n.querySelectorAll) n.querySelectorAll('.admin-msg-success').forEach(check); });
      });
    });
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  /* ------------------------------------------------------------------ */
  /* 2. Lists: sort, search, pages                                       */
  /* ------------------------------------------------------------------ */

  // Tables whose row order is an order the admin sets on purpose.
  var SKIP_TABLE_IDS = { fieldsTableBody: 1, outputFieldsTableBody: 1 };
  var DATE_HEAD_RE = /^(created|date|time|when|submitted|deployed|updated|started|paid|last)/i;

  function cellValue(tr, col) {
    var td = tr.children[col];
    return td ? td.textContent.replace(/\s+/g, ' ').trim() : '';
  }
  function toNumber(s) {
    var t = s.replace(/[,$%\s]|KES|USD|Ksh/gi, '');
    if (t === '' || !/^-?\d+(\.\d+)?$/.test(t)) return null;
    return parseFloat(t);
  }
  function toTime(s) {
    if (!/\d/.test(s) || s.length < 6) return null;
    var t = Date.parse(s);
    return isNaN(t) ? null : t;
  }
  function compare(a, b) {
    var na = toNumber(a), nb = toNumber(b);
    if (na !== null && nb !== null) return na - nb;
    var ta = toTime(a), tb = toTime(b);
    if (ta !== null && tb !== null) return ta - tb;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  function enhanceTable(table) {
    var tbody = table.tBodies[0];
    var thead = table.tHead;
    if (!tbody || !thead || tbody.id && SKIP_TABLE_IDS[tbody.id] || table.hasAttribute('data-no-enhance') || table.closest('[data-no-enhance]')) return;
    var heads = Array.prototype.slice.call(thead.rows[0] ? thead.rows[0].cells : []);
    if (!heads.length) return;

    var state = { all: [], sortCol: -1, dir: 1, page: 1, size: PAGE_SIZES[0], q: '' };
    var internal = false;
    var wrap = table.closest('.admin-table-wrap') || table.parentNode;
    var top = document.createElement('div');
    top.className = 'admin-list-top';
    top.hidden = true;
    top.innerHTML = '<label class="admin-list-search">' + ICON.search + '<input type="search" class="admin-input" placeholder="Search this list" aria-label="Search this list"></label>';
    var bar = document.createElement('div');
    bar.className = 'admin-list-bar';
    bar.hidden = true;
    wrap.parentNode.insertBefore(top, wrap);
    wrap.parentNode.insertBefore(bar, wrap.nextSibling);
    var search = top.querySelector('input');

    heads.forEach(function (th, i) {
      if (!th.textContent.trim()) return;
      th.classList.add('is-sortable');
      th.tabIndex = 0;
      th.setAttribute('role', 'columnheader');
      th.setAttribute('aria-sort', 'none');
      var ico = document.createElement('span');
      ico.className = 'admin-sort-ico';
      ico.innerHTML = ICON.both;
      th.appendChild(ico);
      function go() {
        if (state.sortCol === i) {
          if (state.dir === 1) state.dir = -1; else { state.sortCol = -1; state.dir = 1; }
        } else { state.sortCol = i; state.dir = 1; }
        state.page = 1;
        render();
      }
      th.addEventListener('click', go);
      th.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });

    search.addEventListener('input', function () { state.q = search.value.trim().toLowerCase(); state.page = 1; render(); });

    function dataRows() {
      return Array.prototype.filter.call(tbody.children, function (tr) { return tr.tagName === 'TR' && !tr.querySelector('td[colspan]'); });
    }

    function defaultOrder(rows) {
      var out = rows.slice();
      var withId = out.every(function (tr) { return tr.hasAttribute('data-id') && /^\d+$/.test(tr.getAttribute('data-id')); });
      if (withId && out.length > 1) {
        out.sort(function (a, b) { return Number(b.getAttribute('data-id')) - Number(a.getAttribute('data-id')); });
        return out;
      }
      var dateCol = -1;
      heads.forEach(function (th, i) { if (dateCol < 0 && DATE_HEAD_RE.test(th.textContent.trim())) dateCol = i; });
      if (dateCol >= 0 && out.length > 1 && out.every(function (tr) { return toTime(cellValue(tr, dateCol)) !== null; })) {
        out.sort(function (a, b) { return toTime(cellValue(b, dateCol)) - toTime(cellValue(a, dateCol)); });
      }
      return out;
    }

    function render() {
      var rows = state.all;
      if (state.q) rows = rows.filter(function (tr) { return tr.textContent.toLowerCase().indexOf(state.q) !== -1; });
      if (state.sortCol >= 0) {
        var col = state.sortCol, dir = state.dir;
        rows = rows.slice().sort(function (a, b) { return dir * compare(cellValue(a, col), cellValue(b, col)); });
      } else {
        rows = defaultOrder(rows);
      }
      var total = rows.length;
      var pages = Math.max(1, Math.ceil(total / state.size));
      if (state.page > pages) state.page = pages;
      var start = (state.page - 1) * state.size;
      var slice = rows.slice(start, start + state.size);

      internal = true;
      tbody.replaceChildren.apply(tbody, slice);
      if (!slice.length && state.all.length) {
        var empty = document.createElement('tr');
        empty.innerHTML = '<td colspan="' + heads.length + '" data-label="">Nothing matches your search.</td>';
        tbody.appendChild(empty);
      }
      mo.takeRecords();
      internal = false;

      heads.forEach(function (th, i) {
        if (!th.classList.contains('is-sortable')) return;
        var on = state.sortCol === i;
        th.classList.toggle('is-sorted', on);
        th.setAttribute('aria-sort', on ? (state.dir === 1 ? 'ascending' : 'descending') : 'none');
        th.querySelector('.admin-sort-ico').innerHTML = on ? (state.dir === 1 ? ICON.up : ICON.down) : ICON.both;
      });

      top.hidden = state.all.length <= PAGE_SIZES[0];
      var many = state.all.length > PAGE_SIZES[0];
      bar.hidden = !many;
      if (many) {
        var from = total ? start + 1 : 0, to = Math.min(total, start + state.size);
        var opts = PAGE_SIZES.map(function (n) { return '<option value="' + n + '"' + (n === state.size ? ' selected' : '') + '>' + n + ' per page</option>'; }).join('');
        bar.innerHTML =
          '<span class="admin-list-count">Showing ' + from + ' to ' + to + ' of ' + total + '</span>' +
          '<span class="admin-list-pager">' +
          '<select class="admin-select" aria-label="Rows per page">' + opts + '</select>' +
          '<button type="button" class="admin-btn-outline admin-btn-sm" data-no-feedback data-p="prev" aria-label="Previous page"' + (state.page <= 1 ? ' disabled' : '') + '>' + ICON.left + '<span>Previous</span></button>' +
          '<span class="admin-list-page">Page ' + state.page + ' of ' + pages + '</span>' +
          '<button type="button" class="admin-btn-outline admin-btn-sm" data-no-feedback data-p="next" aria-label="Next page"' + (state.page >= pages ? ' disabled' : '') + '><span>Next</span>' + ICON.right + '</button>' +
          '</span>';
      }
    }

    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-p]');
      if (!b || b.disabled) return;
      state.page += b.getAttribute('data-p') === 'next' ? 1 : -1;
      render();
      table.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    bar.addEventListener('change', function (e) {
      if (e.target.tagName === 'SELECT') { state.size = parseInt(e.target.value, 10) || PAGE_SIZES[0]; state.page = 1; render(); }
    });

    var mo = new MutationObserver(function () {
      if (internal) return;
      state.all = dataRows();
      if (state.all.length) render();
      else { top.hidden = true; bar.hidden = true; }
    });
    mo.observe(tbody, { childList: true });
    state.all = dataRows();
    if (state.all.length) render();
  }

  function initLists() {
    document.querySelectorAll('table.admin-table').forEach(function (t) {
      try { enhanceTable(t); } catch (err) { /* a list that cannot be enhanced stays as it was */ }
    });
  }

  /* 3. "Add" forms that live behind a button, so the list gets the whole width. */
  function initAddPanels() {
    document.querySelectorAll('[data-add-panel]').forEach(function (grid) {
      var card = grid.querySelector(':scope > .admin-card');
      if (!card) return;
      var label = grid.getAttribute('data-add-panel');
      grid.classList.add('admin-add-layout');
      card.hidden = true;
      var bar = document.createElement('div');
      bar.className = 'admin-list-actions';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'admin-btn';
      btn.setAttribute('data-no-feedback', '');
      btn.setAttribute('aria-expanded', 'false');
      function paint(open) {
        btn.innerHTML = (open ? svg('<path d="M18 6 6 18" /><path d="m6 6 12 12" />') : svg('<path d="M5 12h14" /><path d="M12 5v14" />')) + '<span></span>';
        btn.lastChild.textContent = open ? 'Close' : label;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      function toggle(open) {
        card.hidden = !open;
        paint(open);
        if (open) { var f = card.querySelector('input, textarea, select'); if (f) f.focus({ preventScroll: false }); }
      }
      paint(false);
      btn.addEventListener('click', function () { toggle(card.hidden); });
      bar.appendChild(btn);
      grid.parentNode.insertBefore(bar, grid);
      card.addEventListener('admin:saved', function () { setTimeout(function () { toggle(false); }, 1300); });
    });
  }

  function start() {
    watchInlineMessages();
    initAddPanels();
    initLists();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
