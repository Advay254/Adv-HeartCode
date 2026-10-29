/* v1.2.21: the Free Deployments and Coupons admin pages. Uses the shared
   window.adminFetch from admin.js. The generic save feedback and table
   sorting from admin-ux.js apply on their own. */
(function () {
  'use strict';

  function esc(v) {
    var d = document.createElement('div');
    d.textContent = v == null ? '' : String(v);
    return d.innerHTML;
  }
  function fmt(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function say(el, text, kind) {
    el.textContent = text;
    el.className = 'admin-msg admin-msg-' + kind;
    el.style.display = text ? 'block' : 'none';
  }

  /* ---------------- Free Deployments ---------------- */
  function initFree() {
    var form = document.getElementById('freeForm');
    var msg = document.getElementById('freeMsg');

    function render(data) {
      var s = data.settings;
      document.getElementById('dailyCap').value = s.dailyCap;
      document.getElementById('verifyDailyMax').value = s.verifyDailyMax;
      document.getElementById('expiryDays').value = s.expiryDays;
      document.getElementById('linkMinutes').value = s.linkMinutes;
      document.getElementById('blockedList').value = s.blockedList;
      document.getElementById('builtInCount').textContent = data.builtInBlockedCount;

      var open = Math.max(0, s.dailyCap - data.today.deployed);
      document.getElementById('freeStats').innerHTML =
        '<div class="admin-stat-card"><p class="admin-stat-label">Free sites today</p><p class="admin-stat-value">' + data.today.deployed + ' / ' + s.dailyCap + '</p></div>' +
        '<div class="admin-stat-card"><p class="admin-stat-label">Still available today</p><p class="admin-stat-value">' + open + '</p></div>' +
        '<div class="admin-stat-card"><p class="admin-stat-label">Link emails today</p><p class="admin-stat-value">' + data.today.emailsSent + ' / ' + s.verifyDailyMax + '</p></div>' +
        '<div class="admin-stat-card"><p class="admin-stat-label">Free sites ever</p><p class="admin-stat-value">' + data.totalVerified + '</p></div>';

      var ins = data.insights;
      if (ins) {
        document.getElementById('insightsGrid').innerHTML =
          '<div class="admin-stat-card"><p class="admin-stat-label">Reviews from free sites</p><p class="admin-stat-value">' + ins.freeReviews + '</p></div>' +
          '<div class="admin-stat-card"><p class="admin-stat-label">Review rate (free)</p><p class="admin-stat-value">' + ins.freeReviewRate + '%</p></div>' +
          '<div class="admin-stat-card"><p class="admin-stat-label">Average rating</p><p class="admin-stat-value">' + (ins.freeReviews ? ins.freeAvgRating.toFixed(1) : 'None') + '</p></div>' +
          '<div class="admin-stat-card"><p class="admin-stat-label">Review rate (paid, for comparison)</p><p class="admin-stat-value">' + ins.paidReviewRate + '%</p></div>' +
          '<div class="admin-stat-card"><p class="admin-stat-label">Badge visits, last 7 days</p><p class="admin-stat-value">' + ins.referral.last7 + '</p></div>' +
          '<div class="admin-stat-card"><p class="admin-stat-label">Badge visits, last 30 days</p><p class="admin-stat-value">' + ins.referral.last30 + '</p></div>' +
          '<div class="admin-stat-card"><p class="admin-stat-label">Badge visits, all time</p><p class="admin-stat-value">' + ins.referral.total + '</p></div>' +
          '<div class="admin-stat-card"><p class="admin-stat-label">Free sites built</p><p class="admin-stat-value">' + ins.freeSites + '</p></div>';
      }

      var rows = document.getElementById('freeRows');
      rows.innerHTML = data.recent.map(function (r) {
        var status = r.status === 'verified' ? 'Published' : (new Date(r.linkExpiresAt) < new Date() ? 'Link expired' : 'Waiting for link');
        var site = r.siteUrl ? '<a href="' + esc(r.siteUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(r.siteUrl) + '</a>' : '';
        return '<tr><td data-label="Email">' + esc(r.email) + '</td><td data-label="Status">' + esc(status) + '</td><td data-label="Requested">' + esc(fmt(r.createdAt)) + '</td><td data-label="Site">' + site + '</td><td data-label="Site ends">' + esc(fmt(r.siteExpiresAt)) + '</td></tr>';
      }).join('');
      document.getElementById('freeEmpty').style.display = data.recent.length ? 'none' : 'block';
      document.getElementById('freeTable').style.display = data.recent.length ? '' : 'none';
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var body = {
        dailyCap: document.getElementById('dailyCap').value,
        verifyDailyMax: document.getElementById('verifyDailyMax').value,
        expiryDays: document.getElementById('expiryDays').value,
        linkMinutes: document.getElementById('linkMinutes').value,
        blockedList: document.getElementById('blockedList').value
      };
      window.adminFetch('/api/admin/free', { method: 'PUT', body: JSON.stringify(body) })
        .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
        .then(function (r) {
          if (r.ok) { render(r.d); say(msg, 'Saved.', 'success'); }
          else say(msg, r.d.error || 'Could not save.', 'error');
        })
        .catch(function () { say(msg, 'Network error. Please try again.', 'error'); });
    });

    window.adminFetch('/api/admin/free').then(function (r) { return r.json(); }).then(render);
  }

  /* ---------------- Coupons ---------------- */
  function initCoupons() {
    var form = document.getElementById('couponForm');
    var msg = document.getElementById('couponMsg');
    var typeNames = {};

    function renderTypes(types) {
      var box = document.getElementById('couponTypes');
      box.innerHTML = types.filter(function (t) { return t.priceUsd > 2; }).map(function (t) {
        typeNames[t.id] = t.name;
        return '<label class="admin-option-item"><input type="checkbox" value="' + t.id + '"> ' + esc(t.name) + ' ($' + t.priceUsd.toFixed(2) + ')</label>';
      }).join('') || '<p class="admin-hint">No website type is priced above $2 yet.</p>';
      types.forEach(function (t) { typeNames[t.id] = t.name; });
    }

    function renderList(coupons) {
      var orders = 0, revenue = 0, discount = 0;
      coupons.forEach(function (c) { orders += c.orders; revenue += c.revenueUsd; discount += c.discountUsd; });
      document.getElementById('couponStats').innerHTML =
        '<div class="admin-stat-card"><p class="admin-stat-label">Orders with a coupon</p><p class="admin-stat-value">' + orders + '</p></div>' +
        '<div class="admin-stat-card"><p class="admin-stat-label">Revenue from them</p><p class="admin-stat-value">$' + revenue.toFixed(2) + '</p></div>' +
        '<div class="admin-stat-card"><p class="admin-stat-label">Discount given</p><p class="admin-stat-value">$' + discount.toFixed(2) + '</p></div>' +
        '<div class="admin-stat-card"><p class="admin-stat-label">Active coupons</p><p class="admin-stat-value">' + coupons.filter(function (c) { return c.isActive; }).length + '</p></div>';
      var rows = document.getElementById('couponRows');
      rows.innerHTML = coupons.map(function (c) {
        var types = c.websiteTypeIds.length ? c.websiteTypeIds.map(function (id) { return typeNames[id] || ('#' + id); }).join(', ') : 'All above $2';
        var used = c.usesCount + (c.maxUses ? ' / ' + c.maxUses : '');
        var expired = c.expiresAt && new Date(c.expiresAt) < new Date();
        var status = !c.isActive ? 'Off' : (expired ? 'Expired' : (c.maxUses && c.usesCount >= c.maxUses ? 'Used up' : 'Active'));
        return '<tr data-id="' + c.id + '"><td data-label="Code"><strong>' + esc(c.code) + '</strong></td><td data-label="Off">' + c.percent + '%</td><td data-label="Orders">' + c.orders + '</td><td data-label="Revenue">$' + c.revenueUsd.toFixed(2) + '</td><td data-label="Discount given">$' + c.discountUsd.toFixed(2) + '</td><td data-label="Uses">' + esc(used) + '</td><td data-label="Expires">' + esc(c.expiresAt ? fmt(c.expiresAt) : 'Never') + '</td><td data-label="Types">' + esc(types) + '</td><td data-label="Status">' + status + '</td>' +
          '<td data-label=""><button type="button" class="admin-btn-outline admin-btn-sm" data-act="toggle" data-active="' + (c.isActive ? '1' : '0') + '">' + (c.isActive ? 'Turn off' : 'Turn on') + '</button> ' +
          '<button type="button" class="admin-btn-danger admin-btn-sm" data-act="delete">Delete</button></td></tr>';
      }).join('');
      document.getElementById('couponEmpty').style.display = coupons.length ? 'none' : 'block';
      document.getElementById('couponTable').style.display = coupons.length ? '' : 'none';
    }

    function load() {
      return window.adminFetch('/api/admin/coupons').then(function (r) { return r.json(); }).then(function (d) {
        renderTypes(d.types);
        renderList(d.coupons);
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var ids = Array.prototype.slice.call(document.querySelectorAll('#couponTypes input:checked')).map(function (i) { return Number(i.value); });
      var body = {
        code: document.getElementById('couponCode').value,
        percent: document.getElementById('couponPercent').value,
        expiresAt: document.getElementById('couponExpires').value || null,
        maxUses: document.getElementById('couponMax').value || null,
        websiteTypeIds: ids
      };
      window.adminFetch('/api/admin/coupons', { method: 'POST', body: JSON.stringify(body) })
        .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
        .then(function (r) {
          if (r.ok) { say(msg, 'Coupon created.', 'success'); form.reset(); document.getElementById('couponPercent').value = 10; load(); }
          else say(msg, r.d.error || 'Could not create the coupon.', 'error');
        })
        .catch(function () { say(msg, 'Network error. Please try again.', 'error'); });
    });

    document.getElementById('couponRows').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var id = btn.closest('tr').getAttribute('data-id');
      if (btn.getAttribute('data-act') === 'delete') {
        if (!window.confirm('Delete this coupon? Past orders are not affected.')) return;
        window.adminFetch('/api/admin/coupons/' + id, { method: 'DELETE' }).then(load);
      } else {
        window.adminFetch('/api/admin/coupons/' + id, { method: 'PATCH', body: JSON.stringify({ isActive: btn.getAttribute('data-active') !== '1' }) }).then(load);
      }
    });

    load();
  }

  /* ---------------- Email budget meter ---------------- */
  function initEmailBudget() {
    var body = document.getElementById('emailBudgetBody');
    var input = document.getElementById('emailQuotaInput');
    var msg = document.getElementById('emailBudgetMsg');
    if (!body || !input) return;

    function render(d) {
      input.value = d.quota == null ? '' : d.quota;
      if (d.quota == null) {
        body.innerHTML = '<p style="margin:0;color:#667085;font-size:13.5px;">Enter your daily email limit below to see how much of it you have used today.</p>';
        return;
      }
      var pct = Math.min(100, Math.round((d.sentToday / d.quota) * 100));
      var cls = d.sentToday >= d.quota ? 'is-full' : (pct >= 80 ? 'is-warn' : '');
      var days = (d.lastDays || []).map(function (x) { return '<li><span>' + esc(x.day) + '</span><span>' + x.count + '</span></li>'; }).join('');
      body.innerHTML =
        '<div class="eb-meter"><div class="eb-fill ' + cls + '" style="width:' + pct + '%;"></div></div>' +
        '<div class="eb-line"><span><strong>' + d.sentToday + '</strong> of ' + d.quota + ' used today (' + pct + '%)</span><span>' + d.remaining + ' left</span></div>' +
        (d.failedToday ? '<div class="eb-line"><span>' + d.failedToday + ' failed today (not counted above)</span></div>' : '') +
        (days ? '<ul class="eb-days">' + days + '</ul>' : '');
    }

    function load() {
      return window.adminFetch('/api/admin/email-budget').then(function (r) { return r.json(); }).then(render);
    }

    document.getElementById('emailBudgetForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = input.value.trim();
      window.adminFetch('/api/admin/email-budget', { method: 'PUT', body: JSON.stringify({ quota: v === '' ? null : v }) })
        .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
        .then(function (r) {
          if (r.ok) { render(r.d); say(msg, v === '' ? 'Meter turned off.' : 'Saved.', 'success'); }
          else say(msg, r.d.error || 'Could not save.', 'error');
        })
        .catch(function () { say(msg, 'Network error. Please try again.', 'error'); });
    });

    load();
  }

  /* ---------------- Test deploy cleanup setting ---------------- */
  function initTestCleanup() {
    var input = document.getElementById('testExpiryDays');
    var msg = document.getElementById('testExpiryMsg');
    if (!input) return;
    window.adminFetch('/api/admin/test-deploy/_settings').then(function (r) { return r.json(); }).then(function (d) { input.value = d.expiryDays; });
    document.getElementById('testExpirySave').addEventListener('click', function () {
      window.adminFetch('/api/admin/test-deploy/_settings', { method: 'PUT', body: JSON.stringify({ expiryDays: input.value }) })
        .then(function (res) { return res.json().then(function (d) { return { ok: res.ok, d: d }; }); })
        .then(function (r) { msg.textContent = r.ok ? 'Saved' : (r.d.error || 'Could not save'); });
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.dataset.page;
    initEmailBudget();
    if (page === 'test-deploy') initTestCleanup();
    if (page === 'free') initFree();
    if (page === 'coupons') initCoupons();
  });
})();
