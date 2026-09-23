(function () {
  function csrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  // Wrapper around fetch() that automatically attaches the CSRF token (read
  // from the page's <meta name="csrf-token"> tag) as an X-CSRF-Token header,
  // and defaults to JSON content-type for requests with a body. Every admin
  // page script should use this instead of calling fetch() directly.
  window.adminFetch = function adminFetch(url, options) {
    options = options || {};
    const headers = Object.assign({}, options.headers || {}, {
      'X-CSRF-Token': csrfToken()
    });
    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetch(url, Object.assign({}, options, { headers }));
  };

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ---- card description character counter (v1.1.6 Part E) ----
  // Same 140-character ceiling as the server-side zod schemas in
  // routes/adminCategories.js and routes/adminWebsiteTypes.js — chosen to
  // keep a description card-height-consistent on /explore's grids (see
  // those cards' own line-clamp-2, added this same version) without
  // relying on truncation to hide an overly long one. This constant isn't
  // actually IMPORTED by the server (there's no shared build step between
  // this static file and the Express routes), so it's duplicated by
  // value, not by reference — if this number ever changes, it must be
  // changed in all four places (this constant, both website-types
  // schemas, and the categories schema) — same acknowledged, precedented
  // duplication as e.g. lib/cloudflarePages.js's MAX_SEED_LENGTH existing
  // independently of anything else.
  const CARD_DESCRIPTION_MAX_LENGTH = 140;

  // Attaches a live "N / 140 characters" counter directly after
  // `textareaEl`, turning red past the limit. Safe to call more than once
  // on the same element (e.g. a dynamically-recreated edit row) — reuses
  // an existing counter it already inserted rather than stacking a second
  // one, detected via the `data-char-counter-for` marker rather than
  // nextElementSibling (which would break the moment any OTHER element,
  // like a validation message, is ever inserted between the two).
  function attachCharCounter(textareaEl, maxLen) {
    if (!textareaEl) return;
    maxLen = maxLen || CARD_DESCRIPTION_MAX_LENGTH;
    let counter = textareaEl.parentElement.querySelector(`[data-char-counter-for="${textareaEl.id}"]`);
    if (!counter) {
      counter = document.createElement('p');
      counter.className = 'mt-1 text-xs text-gray-400';
      counter.dataset.charCounterFor = textareaEl.id;
      textareaEl.insertAdjacentElement('afterend', counter);
    }
    function update() {
      const len = textareaEl.value.length;
      counter.textContent = `${len} / ${maxLen} characters`;
      counter.classList.toggle('text-error-500', len > maxLen);
      counter.classList.toggle('text-gray-400', len <= maxLen);
    }
    textareaEl.addEventListener('input', update);
    update();
  }

  // ---- shared nav/logout, present on every dashboard page ----
  // v1.0.8 Part D: sidebar is a fixed column on desktop (lg:) and an
  // off-canvas drawer on mobile, toggled via the topbar hamburger button,
  // closed via the in-sidebar close button, the backdrop overlay, or the
  // Escape key. All three (toggle/close/overlay) just add/remove the same
  // .is-open class the CSS transform (see src/styles/admin.css) reads.
  function initNav() {
    const sidebar = document.getElementById('adminSidebar');
    const overlay = document.getElementById('sidebarOverlay');
    const openBtn = document.getElementById('sidebarToggle');
    const closeBtn = document.getElementById('sidebarClose');

    function openSidebar() {
      if (sidebar) sidebar.classList.add('is-open');
      if (overlay) overlay.classList.add('is-open');
      if (openBtn) openBtn.setAttribute('aria-expanded', 'true');
    }
    function closeSidebar() {
      if (sidebar) sidebar.classList.remove('is-open');
      if (overlay) overlay.classList.remove('is-open');
      if (openBtn) openBtn.setAttribute('aria-expanded', 'false');
    }

    if (openBtn) openBtn.addEventListener('click', openSidebar);
    if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
    if (overlay) overlay.addEventListener('click', closeSidebar);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeSidebar();
    });

    // v1.1.7: collapsible nav groups (Content/Revenue/System). The group
    // containing the current page is already rendered expanded
    // server-side (see views/partials/nav.ejs) — this just wires up
    // clicking any group's toggle button to open/close it. Each toggle
    // works independently (accordion-style "only one open at a time" was
    // considered and rejected: with the current page's group always
    // expanded on load, forcing others shut would fight a user who
    // opens a second group to jump to a different page without losing
    // their place in the first).
    document.querySelectorAll('[data-nav-toggle]').forEach(function (toggle) {
      toggle.addEventListener('click', function () {
        const panel = document.getElementById(toggle.getAttribute('aria-controls'));
        // aria-expanded is the single source of truth (rendered
        // server-side for the active group). Toggling a class on the
        // button itself meant the first tap on the already-open active
        // group did nothing.
        const isOpen = toggle.getAttribute('aria-expanded') !== 'true';
        if (panel) panel.classList.toggle('is-open', isOpen);
        toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async function () {
        try {
          await window.adminFetch('/api/admin/logout', { method: 'POST' });
        } catch (err) {
          // Ignore network errors — we're navigating to the login page
          // regardless, so a failed logout call isn't worth surfacing.
        }
        const slugSegment = window.location.pathname.split('/').slice(0, 2).join('/');
        window.location.href = slugSegment + '/login';
      });
    }

    initTruncatedText();
  }

  // ---- long-text "Show more" toggle (v1.0.8 Part D) ----
  // Applies to any element rendered with class="truncate-text" plus a
  // sibling <button class="truncate-toggle">. Delegated to `document` (one
  // listener, not one per truncated cell) since table content is
  // re-rendered dynamically on every page that uses this — a per-element
  // listener would leak on each re-render.
  function initTruncatedText() {
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('.truncate-toggle');
      if (!btn) return;
      const target = document.getElementById(btn.dataset.target);
      if (!target) return;
      const expanded = target.classList.toggle('is-expanded');
      btn.textContent = expanded ? 'Show less' : 'Show more';
    });
  }

  // Builds a truncate-with-toggle cell's inner HTML for any text that
  // might be long enough to blow out a table/card layout (descriptions,
  // script content previews, etc.) — every table-row-rendering function
  // below uses this instead of dropping raw (escaped) text straight in,
  // so the "does this need a toggle" judgment call lives in one place.
  let truncateIdCounter = 0;
  function truncatedHtml(text) {
    const safe = escapeHtml(text || '');
    if (!text || text.length <= 120) return safe;
    truncateIdCounter += 1;
    const id = 'trunc-' + truncateIdCounter;
    return (
      '<span class="truncate-text" id="' + id + '">' + safe + '</span>' +
      '<button type="button" class="truncate-toggle" data-target="' + id + '">Show more</button>'
    );
  }

  // ---- login page ----
  function initLoginPage() {
    const slug = document.body.dataset.slug;

    document.getElementById('togglePassword').addEventListener('click', () => {
      const input = document.getElementById('passwordInput');
      const btn = document.getElementById('togglePassword');
      const showIcon = document.getElementById('togglePasswordShowIcon');
      const hideIcon = document.getElementById('togglePasswordHideIcon');
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      showIcon.classList.toggle('hidden', !showing);
      hideIcon.classList.toggle('hidden', showing);
    });

    // No CSRF token on this form, deliberately: CSRF protection exists to
    // stop a forged request from riding on an EXISTING session's cookie.
    // Before login there is no session to bind a token to, and a forged
    // login request just logs the attacker's own browser in as admin --
    // which requires the attacker to already know the real credentials,
    // the one thing CSRF can't hand them. CSRF is enforced on every
    // state-changing request from the dashboard onward, once a session
    // (and therefore a token) exists.
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const body = { username: form.username.value, password: form.password.value };
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      const errorEl = document.getElementById('error');
      if (res.ok && data.success) {
        window.location.href = '/' + slug + '/';
      } else {
        errorEl.textContent = data.error || 'Login failed';
        errorEl.style.display = 'block';
      }
    });
  }

  // ---- payments page ----
  function initPaymentsPage() {
    const form = document.getElementById('paystackForm');
    const modeBadge = document.getElementById('modeBadge');
    const statusMsg = document.getElementById('statusMsg');

    function showStatus(text, type) {
      statusMsg.textContent = text;
      statusMsg.className = 'admin-msg admin-msg-' + type;
      statusMsg.style.display = 'block';
    }

    function renderMasked(el, masked) {
      if (masked) {
        el.textContent = 'Current secret: ' + masked;
        el.style.display = 'block';
      } else {
        el.style.display = 'none';
      }
    }

    function applyConfig(cfg) {
      document.getElementById('modeSelect').value = cfg.mode;
      modeBadge.textContent = cfg.mode;
      modeBadge.className = 'admin-badge admin-badge-brand';
      document.getElementById('publicKeyTest').value = cfg.publicKeyTest || '';
      document.getElementById('publicKeyLive').value = cfg.publicKeyLive || '';
      renderMasked(document.getElementById('secretTestMasked'), cfg.secretKeyTestMasked);
      renderMasked(document.getElementById('secretLiveMasked'), cfg.secretKeyLiveMasked);
    }

    async function load() {
      const res = await window.adminFetch('/api/admin/paystack');
      const cfg = await res.json();
      applyConfig(cfg);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        mode: document.getElementById('modeSelect').value,
        publicKeyTest: document.getElementById('publicKeyTest').value,
        publicKeyLive: document.getElementById('publicKeyLive').value,
        secretKeyTest: document.getElementById('secretKeyTest').value || null,
        secretKeyLive: document.getElementById('secretKeyLive').value || null
      };
      const res = await window.adminFetch('/api/admin/paystack', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        applyConfig(data);
        document.getElementById('secretKeyTest').value = '';
        document.getElementById('secretKeyLive').value = '';
        showStatus('Saved.', 'success');
      } else {
        showStatus(data.error || 'Failed to save.', 'error');
      }
    });

    document.getElementById('clearTestBtn').addEventListener('click', async () => {
      const res = await window.adminFetch('/api/admin/paystack', {
        method: 'PUT',
        body: JSON.stringify({ mode: document.getElementById('modeSelect').value, secretKeyTest: '' })
      });
      const data = await res.json();
      if (res.ok) { applyConfig(data); showStatus('Test secret cleared.', 'success'); }
    });

    document.getElementById('clearLiveBtn').addEventListener('click', async () => {
      const res = await window.adminFetch('/api/admin/paystack', {
        method: 'PUT',
        body: JSON.stringify({ mode: document.getElementById('modeSelect').value, secretKeyLive: '' })
      });
      const data = await res.json();
      if (res.ok) { applyConfig(data); showStatus('Live secret cleared.', 'success'); }
    });

    // v1.1.9 hotfix Part 3: currency display conversion master toggle.
    // A real toggle button, not a checkbox + separate Save -- clicking it
    // flips state and saves immediately, then re-renders from the
    // server's response (same immediate-effect pattern as notification
    // channels' Enable/Disable button).
    const currencyConversionBadge = document.getElementById('currencyConversionBadge');
    const toggleCurrencyConversionBtn = document.getElementById('toggleCurrencyConversionBtn');

    function applyCurrencyConversionState(enabled) {
      currencyConversionBadge.textContent = enabled ? 'on' : 'off';
      currencyConversionBadge.className = 'admin-badge ' + (enabled ? 'admin-badge-active' : 'admin-badge-error');
      toggleCurrencyConversionBtn.textContent = enabled ? 'Turn off' : 'Turn on';
    }

    async function loadCurrencyConversion() {
      const res = await window.adminFetch('/api/admin/settings/currency-conversion');
      const data = await res.json();
      applyCurrencyConversionState(data.enabled);
    }

    toggleCurrencyConversionBtn.addEventListener('click', async () => {
      const nextEnabled = currencyConversionBadge.textContent !== 'on';
      toggleCurrencyConversionBtn.disabled = true;
      try {
        const res = await window.adminFetch('/api/admin/settings/currency-conversion', {
          method: 'PUT',
          body: JSON.stringify({ enabled: nextEnabled })
        });
        const data = await res.json();
        const statusEl = document.getElementById('currencyConversionStatus');
        statusEl.style.display = 'block';
        if (res.ok) {
          applyCurrencyConversionState(data.enabled);
          statusEl.className = 'admin-msg admin-msg-success';
          statusEl.textContent = 'Saved.';
        } else {
          statusEl.className = 'admin-msg admin-msg-error';
          statusEl.textContent = data.error || 'Failed to save.';
        }
      } finally {
        toggleCurrencyConversionBtn.disabled = false;
      }
    });

    // v1.0.6: Kenyan visitor payment currency toggle.
    async function loadKenyanCurrency() {
      const res = await window.adminFetch('/api/admin/settings/kenyan-payment-currency');
      const data = await res.json();
      document.getElementById('kenyanCurrencySelect').value = data.value;
    }

    document.getElementById('saveKenyanCurrencyBtn').addEventListener('click', async () => {
      const value = document.getElementById('kenyanCurrencySelect').value;
      const res = await window.adminFetch('/api/admin/settings/kenyan-payment-currency', {
        method: 'PUT',
        body: JSON.stringify({ value })
      });
      const statusEl = document.getElementById('kenyanCurrencyStatus');
      statusEl.style.display = 'block';
      statusEl.className = 'admin-msg ' + (res.ok ? 'admin-msg-success' : 'admin-msg-error');
      statusEl.textContent = res.ok ? 'Saved.' : 'Failed to save.';
    });

    load();
    loadCurrencyConversion();
    loadKenyanCurrency();

    // v1.1.1 Part D: geolocation health check panel.
    document.getElementById('runGeoDiagnosticBtn').addEventListener('click', async () => {
      const btn = document.getElementById('runGeoDiagnosticBtn');
      const resultEl = document.getElementById('geoDiagnosticResult');
      const ip = document.getElementById('geoDiagnosticIp').value.trim();

      btn.disabled = true;
      btn.textContent = 'Running…';
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<p class="text-sm text-gray-500">Looking up this IP in the local database…</p>';

      try {
        const url = '/api/admin/settings/geo-diagnostic' + (ip ? '?ip=' + encodeURIComponent(ip) : '');
        const res = await window.adminFetch(url);
        const data = await res.json();

        if (!res.ok) {
          resultEl.innerHTML = `<p class="admin-msg admin-msg-error">${escapeHtml(data.error || 'Diagnostic failed to run.')}</p>`;
          return;
        }

        if (data.note) {
          resultEl.innerHTML = `
            <p class="admin-msg admin-msg-warning">${escapeHtml(data.note)}</p>
            <p class="mt-3 text-xs text-gray-400">
              Admin's own resolved IP: ${escapeHtml(data.adminOwnIp || 'n/a')} (source: ${escapeHtml(data.ipSource || 'n/a')})<br>
              CF-Connecting-IP header: ${escapeHtml(data.cfConnectingIpHeader || '(not sent — Cloudflare is not fronting this request)')}<br>
              Raw X-Forwarded-For: ${escapeHtml(data.rawForwardedFor || '(none sent)')}<br>
              Trusted hop chain (req.ips): ${escapeHtml(JSON.stringify(data.trustedHopChain || []))}
            </p>
          `;
          return;
        }

        const rows = data.attempts.map(a => `
          <tr>
            <td data-label="Provider">${escapeHtml(a.provider)}</td>
            <td data-label="Result">${a.success ? '<span class="admin-badge admin-badge-active">ok</span>' : '<span class="admin-badge admin-badge-error">failed</span>'}</td>
            <td data-label="Latency">${escapeHtml(a.latencyMs)}ms</td>
            <td data-label="Details">${escapeHtml(a.error || (a.success ? `country=${a.countryCode || 'n/a'} currency=${a.currency || 'n/a'}` : ''))}</td>
          </tr>
        `).join('');

        const finalOk = data.finalResult.countryCode !== null || data.finalResult.currency !== 'USD';
        resultEl.innerHTML = `
          <p class="text-sm text-hc-ink">Tested IP: <strong>${escapeHtml(data.ip)}</strong>, current Kenyan-visitor toggle: <strong>${escapeHtml(data.kenyanPaymentCurrency)}</strong></p>
          <table class="admin-table mt-3">
            <thead><tr><th>Provider</th><th>Result</th><th>Latency</th><th>Details</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="mt-3 text-sm ${finalOk ? 'text-success-700' : 'text-warning-700'}">
            Final result: currency=${escapeHtml(data.finalResult.currency)}, countryCode=${escapeHtml(data.finalResult.countryCode || 'null')}
            ${finalOk ? '' : ', the local database lookup failed for this IP, so USD was used as the safe default.'}
          </p>
          <p class="mt-3 text-xs text-gray-400">
            Admin's own resolved IP: ${escapeHtml(data.adminOwnIp || 'n/a')} (source: ${escapeHtml(data.ipSource || 'n/a')})<br>
            CF-Connecting-IP header: ${escapeHtml(data.cfConnectingIpHeader || '(not sent — Cloudflare is not fronting this request)')}<br>
            Raw X-Forwarded-For: ${escapeHtml(data.rawForwardedFor || '(none sent)')}<br>
            Trusted hop chain (req.ips): ${escapeHtml(JSON.stringify(data.trustedHopChain || []))}
          </p>
        `;
      } catch (err) {
        resultEl.innerHTML = '<p class="admin-msg admin-msg-error">Network error running the diagnostic.</p>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Run diagnostic';
      }
    });
  }

  // ---- Hosting page (v1.1.9 Part A: ClarityHeart config) ----
  function initHostingPage() {
    const form = document.getElementById('hostingForm');
    const configuredBadge = document.getElementById('configuredBadge');
    const statusMsg = document.getElementById('statusMsg');

    function showStatus(text, type) {
      statusMsg.textContent = text;
      statusMsg.className = 'admin-msg admin-msg-' + type;
      statusMsg.style.display = 'block';
    }

    function applyConfig(cfg) {
      document.getElementById('baseUrl').value = cfg.baseUrl || '';
      const maskedEl = document.getElementById('tokenMasked');
      if (cfg.apiTokenMasked) {
        maskedEl.textContent = 'Current token: ' + cfg.apiTokenMasked;
        maskedEl.style.display = 'block';
      } else {
        maskedEl.style.display = 'none';
      }
      configuredBadge.textContent = cfg.configured ? 'Configured' : 'Not set up';
      configuredBadge.className = 'admin-badge ' + (cfg.configured ? 'admin-badge-brand' : 'admin-badge-error');
    }

    async function load() {
      const res = await window.adminFetch('/api/admin/hosting');
      const cfg = await res.json();
      applyConfig(cfg);
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        baseUrl: document.getElementById('baseUrl').value,
        apiToken: document.getElementById('apiToken').value || null
      };
      const res = await window.adminFetch('/api/admin/hosting', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (res.ok) {
        applyConfig(data);
        document.getElementById('apiToken').value = '';
        showStatus('Saved.', 'success');
      } else {
        showStatus(data.error || 'Failed to save.', 'error');
      }
    });

    // Exercises the real ClarityHeart API end to end (see
    // routes/adminHosting.js's POST /test) — deploys a genuine throwaway
    // test page through the config saved above, not a mocked/simulated
    // check, so a green result here means the connection actually works.
    document.getElementById('testDeployBtn').addEventListener('click', async () => {
      const btn = document.getElementById('testDeployBtn');
      const resultEl = document.getElementById('testResult');

      btn.disabled = true;
      btn.textContent = 'Sending…';
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<p class="text-sm text-gray-500">Deploying a real throwaway test page through your saved Hosting config…</p>';

      try {
        const res = await window.adminFetch('/api/admin/hosting/test', { method: 'POST' });
        const data = await res.json();
        if (res.ok && data.success) {
          const safeUrl = escapeHtml(data.url);
          resultEl.innerHTML = `<p class="admin-msg admin-msg-success">Success — deployed to <a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeUrl}</a></p>`;
        } else {
          resultEl.innerHTML = `<p class="admin-msg admin-msg-error">${escapeHtml(data.error || 'Test deploy failed.')}</p>`;
        }
      } catch (err) {
        resultEl.innerHTML = '<p class="admin-msg admin-msg-error">Network error while running the test deploy.</p>';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send test deploy';
      }
    });

    load();
  }

  // ---- AI provider page ----
  function initAiProviderPage() {
    const providersList = document.getElementById('providersList');

    function providerCard(p) {
      const keyRows = p.keys.map(k => `
        <tr>
          <td data-label="Key">${escapeHtml(k.masked || 'unreadable')}</td>
          <td data-label="Priority">${escapeHtml(k.priority)}</td>
          <td data-label=""><button type="button" class="admin-btn-danger admin-btn-sm remove-key" data-provider="${p.id}" data-key="${k.id}">Remove</button></td>
        </tr>`).join('');

      return `
      <div class="admin-card ai-provider-card" data-provider-id="${p.id}">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-hc-ink">${escapeHtml(p.label)}</h2>
          ${p.isActive ? '<span class="admin-badge admin-badge-active">active</span>' : ''}
        </div>
        <p class="mt-0.5 text-sm text-gray-400">${escapeHtml(p.baseUrl)}</p>

        <label class="admin-label" for="model-select-${p.id}">Model</label>
        <select class="admin-select model-select" id="model-select-${p.id}">
          ${p.selectedModel ? `<option value="${escapeHtml(p.selectedModel)}" selected>${escapeHtml(p.selectedModel)}</option>` : '<option value="">-- none selected --</option>'}
        </select>
        <button type="button" class="admin-btn-outline admin-btn-sm mt-2 fetch-models">Load available models</button>

        <div class="mt-3 flex flex-wrap gap-2">
          <button type="button" class="admin-btn-outline admin-btn-sm save-model">Save model</button>
          <button type="button" class="admin-btn${p.isActive ? '-outline' : ''} admin-btn-sm set-active">${p.isActive ? 'Active provider' : 'Set as active'}</button>
          <button type="button" class="admin-btn-danger admin-btn-sm delete-provider">Delete provider</button>
        </div>

        <h3 class="mt-4 text-sm font-semibold text-hc-ink">Keys</h3>
        <div class="admin-table-wrap mt-2">
          <table class="admin-table is-responsive-stack">
            <thead><tr><th>Key</th><th>Priority</th><th></th></tr></thead>
            <tbody>${keyRows || '<tr><td colspan="3" data-label="">No keys yet</td></tr>'}</tbody>
          </table>
        </div>
        <form class="add-key-form mt-3">
          <label class="admin-label" for="new-key-${p.id}">New key</label>
          <input class="admin-input" type="password" name="key" id="new-key-${p.id}" required>
          <label class="admin-label" for="new-priority-${p.id}">Priority (lower = tried first)</label>
          <input class="admin-input" type="number" name="priority" id="new-priority-${p.id}" value="0">
          <button type="submit" class="admin-btn admin-btn-sm mt-2">Add key</button>
        </form>
        <p class="status-msg admin-msg" style="display:none;"></p>
      </div>`;
    }

    function showStatus(card, text, type) {
      const el = card.querySelector('.status-msg');
      el.textContent = text;
      el.className = 'admin-msg admin-msg-' + type;
      el.style.display = 'block';
    }

    async function load() {
      const res = await window.adminFetch('/api/admin/ai-providers');
      const providers = await res.json();
      providersList.innerHTML = providers.map(providerCard).join('') || '<p class="admin-msg admin-msg-warning">No providers configured yet.</p>';
      wireCards();
    }

    function wireCards() {
      document.querySelectorAll('.ai-provider-card[data-provider-id]').forEach(card => {
        const providerId = card.dataset.providerId;

        card.querySelector('.fetch-models').addEventListener('click', async () => {
          const btn = card.querySelector('.fetch-models');
          const originalText = btn.textContent;
          btn.textContent = 'Loading…';
          const res = await window.adminFetch(`/api/admin/ai-providers/${providerId}/fetch-models`, { method: 'POST' });
          const data = await res.json();
          btn.textContent = originalText;
          if (res.ok) {
            const select = card.querySelector('.model-select');
            const current = select.value;
            select.innerHTML = data.models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
            if (data.models.includes(current)) select.value = current;
            showStatus(card, `Loaded ${data.models.length} models.`, 'success');
          } else {
            showStatus(card, data.error || 'Failed to load models.', 'error');
          }
        });

        card.querySelector('.save-model').addEventListener('click', async () => {
          const model = card.querySelector('.model-select').value;
          const res = await window.adminFetch(`/api/admin/ai-providers/${providerId}`, {
            method: 'PUT',
            body: JSON.stringify({ selectedModel: model })
          });
          if (res.ok) showStatus(card, 'Model saved.', 'success');
        });

        card.querySelector('.set-active').addEventListener('click', async () => {
          const res = await window.adminFetch(`/api/admin/ai-providers/${providerId}`, {
            method: 'PUT',
            body: JSON.stringify({ isActive: true })
          });
          if (res.ok) load();
        });

        card.querySelector('.delete-provider').addEventListener('click', async () => {
          if (!confirm('Delete this provider and all its keys?')) return;
          const res = await window.adminFetch(`/api/admin/ai-providers/${providerId}`, { method: 'DELETE' });
          if (res.ok) load();
        });

        card.querySelectorAll('.remove-key').forEach(btn => {
          btn.addEventListener('click', async () => {
            const keyId = btn.dataset.key;
            const res = await window.adminFetch(`/api/admin/ai-providers/${providerId}/keys/${keyId}`, { method: 'DELETE' });
            if (res.ok) load();
          });
        });

        card.querySelector('.add-key-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const form = e.target;
          const res = await window.adminFetch(`/api/admin/ai-providers/${providerId}/keys`, {
            method: 'POST',
            body: JSON.stringify({ key: form.key.value, priority: Number(form.priority.value) || 0 })
          });
          if (res.ok) { form.reset(); load(); }
        });
      });
    }

    document.getElementById('addProviderForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/ai-providers', {
        method: 'POST',
        body: JSON.stringify({ label: form.label.value, baseUrl: form.baseUrl.value })
      });
      if (res.ok) { form.reset(); load(); }
    });

    load();
  }

  // ---- Email Providers page (v1.1.1 Part C) ----
  function initEmailProvidersPage() {
    const providersList = document.getElementById('providersList');

    // Gmail/Brevo are just presets that pre-fill known SMTP settings —
    // both submit as provider_type: 'smtp' underneath (see
    // routes/adminEmailProviders.js). Nothing server-side ever sees which
    // preset was picked, only the resulting host/port/security fields.
    const SMTP_PRESETS = {
      gmail: { host: 'smtp.gmail.com', port: 587, security: 'STARTTLS' },
      brevo: { host: 'smtp-relay.brevo.com', port: 587, security: 'STARTTLS' },
      smtp: { host: '', port: 587, security: 'STARTTLS' }
    };

    function applyPreset() {
      const preset = document.getElementById('providerPreset').value;
      document.querySelectorAll('#addProviderForm [data-fields]').forEach(el => {
        el.style.display = (el.dataset.fields === (preset === 'resend' ? 'resend' : 'smtp')) ? 'block' : 'none';
      });
      if (preset !== 'resend') {
        const p = SMTP_PRESETS[preset];
        document.getElementById('smtpHost').value = p.host;
        document.getElementById('smtpPort').value = p.port;
        document.getElementById('smtpSecurity').value = p.security;
      }
    }
    document.getElementById('providerPreset').addEventListener('change', applyPreset);
    applyPreset();

    function providerCard(p) {
      const configRows = p.providerType === 'resend'
        ? `<p class="mt-1 text-sm text-gray-500">From: ${escapeHtml(p.config.fromAddress || '(not set)')} · API key: ${escapeHtml(p.config.apiKeyMasked || 'unreadable')}</p>`
        : `<p class="mt-1 text-sm text-gray-500">${escapeHtml(p.config.host || '(no host)')}:${escapeHtml(p.config.port || '?')} (${escapeHtml(p.config.connectionSecurity)}) · From: ${escapeHtml(p.config.fromAddress || '(not set)')} · Password: ${escapeHtml(p.config.passwordMasked || 'unreadable')}</p>`;

      return `
      <div class="admin-card email-provider-card" data-provider-id="${p.id}">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-hc-ink">${escapeHtml(p.label)}</h2>
          <span class="admin-badge admin-badge-brand">${escapeHtml(p.providerType)}</span>
          ${p.isActive ? '<span class="admin-badge admin-badge-active">active</span>' : ''}
        </div>
        ${configRows}

        <div class="mt-3 flex flex-wrap items-end gap-2">
          <div>
            <label class="admin-label" for="test-to-${p.id}">Send test email to</label>
            <input class="admin-input" type="email" id="test-to-${p.id}" placeholder="you@example.com">
          </div>
          <button type="button" class="admin-btn-outline admin-btn-sm send-test">Send test</button>
        </div>

        <div class="mt-3 flex flex-wrap gap-2">
          <button type="button" class="admin-btn${p.isActive ? '-outline' : ''} admin-btn-sm set-active">${p.isActive ? 'Active provider' : 'Set as active'}</button>
          <button type="button" class="admin-btn-danger admin-btn-sm delete-provider">Delete provider</button>
        </div>
        <p class="status-msg admin-msg" style="display:none;"></p>
      </div>`;
    }

    function showStatus(card, text, type) {
      const el = card.querySelector('.status-msg');
      el.textContent = text;
      el.className = 'admin-msg admin-msg-' + type;
      el.style.display = 'block';
    }

    async function load() {
      const res = await window.adminFetch('/api/admin/email-providers');
      const providers = await res.json();
      providersList.innerHTML = providers.map(providerCard).join('') || '<p class="admin-msg admin-msg-warning">No email providers configured yet. Nothing will be able to send email until one is added and activated.</p>';
      wireCards();
    }

    function wireCards() {
      document.querySelectorAll('.email-provider-card[data-provider-id]').forEach(card => {
        const providerId = card.dataset.providerId;

        card.querySelector('.send-test').addEventListener('click', async () => {
          const btn = card.querySelector('.send-test');
          const to = card.querySelector(`#test-to-${providerId}`).value.trim();
          if (!to) { showStatus(card, 'Enter a destination email address first.', 'error'); return; }
          const originalText = btn.textContent;
          btn.disabled = true;
          btn.textContent = 'Sending…';
          try {
            const res = await window.adminFetch(`/api/admin/email-providers/${providerId}/test`, {
              method: 'POST',
              body: JSON.stringify({ to })
            });
            const data = await res.json();
            if (res.ok && data.success) {
              showStatus(card, `Test email sent to ${to}.`, 'success');
            } else {
              showStatus(card, data.error || 'Test send failed.', 'error');
            }
          } catch (err) {
            showStatus(card, 'Network error sending test email.', 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = originalText;
          }
        });

        card.querySelector('.set-active').addEventListener('click', async () => {
          const res = await window.adminFetch(`/api/admin/email-providers/${providerId}`, {
            method: 'PUT',
            body: JSON.stringify({ isActive: true })
          });
          if (res.ok) load();
        });

        card.querySelector('.delete-provider').addEventListener('click', async () => {
          if (!confirm('Delete this email provider?')) return;
          const res = await window.adminFetch(`/api/admin/email-providers/${providerId}`, { method: 'DELETE' });
          if (res.ok) load();
        });
      });
    }

    document.getElementById('addProviderForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById('addProviderError');
      errorEl.style.display = 'none';

      const preset = document.getElementById('providerPreset').value;
      const label = document.getElementById('providerLabel').value;

      let payload;
      if (preset === 'resend') {
        payload = {
          providerType: 'resend',
          label,
          apiKey: document.getElementById('resendApiKey').value,
          fromAddress: document.getElementById('resendFromAddress').value
        };
      } else {
        payload = {
          providerType: 'smtp',
          label,
          host: document.getElementById('smtpHost').value,
          port: Number(document.getElementById('smtpPort').value) || 587,
          username: document.getElementById('smtpUsername').value,
          password: document.getElementById('smtpPassword').value,
          fromAddress: document.getElementById('smtpFromAddress').value,
          fromName: document.getElementById('smtpFromName').value,
          connectionSecurity: document.getElementById('smtpSecurity').value
        };
      }

      const res = await window.adminFetch('/api/admin/email-providers', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        e.target.reset();
        applyPreset();
        load();
      } else {
        const data = await res.json();
        errorEl.textContent = (data.details && data.details[0] && data.details[0].message) || data.error || 'Failed to add provider.';
        errorEl.style.display = 'block';
      }
    });

    load();
  }

  // ---- Notifications page (v1.1.2 Part B) ----
  function initNotificationsPage() {
    const channelsList = document.getElementById('channelsList');

    function applyFieldVisibility() {
      const type = document.getElementById('channelType').value;
      document.querySelectorAll('#addChannelForm [data-fields]').forEach(el => {
        el.style.display = (el.dataset.fields === type) ? 'block' : 'none';
      });
    }
    document.getElementById('channelType').addEventListener('change', applyFieldVisibility);
    applyFieldVisibility();

    function channelConfigSummary(c) {
      if (c.channelType === 'email') return `To: ${escapeHtml(c.config.address || '(not set)')}`;
      if (c.channelType === 'webhook') return `URL: ${escapeHtml(c.config.url || '(not set)')}`;
      if (c.channelType === 'gotify') return `Server: ${escapeHtml(c.config.serverUrl || '(not set)')} · Token: ${escapeHtml(c.config.tokenMasked || 'unreadable')}`;
      return '';
    }

    function channelCard(c) {
      return `
      <div class="admin-card notification-channel-card" data-channel-id="${c.id}">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-hc-ink">${escapeHtml(c.label)}</h2>
          <span class="admin-badge admin-badge-brand">${escapeHtml(c.channelType)}</span>
          ${c.isActive ? '<span class="admin-badge admin-badge-active">enabled</span>' : '<span class="admin-badge admin-badge-error">disabled</span>'}
        </div>
        <p class="mt-1 text-sm text-gray-500">${channelConfigSummary(c)}</p>

        <div class="mt-3 flex flex-wrap gap-2">
          <button type="button" class="admin-btn-outline admin-btn-sm send-test">Send test notification</button>
          <button type="button" class="admin-btn-outline admin-btn-sm toggle-active">${c.isActive ? 'Disable' : 'Enable'}</button>
          <button type="button" class="admin-btn-danger admin-btn-sm delete-channel">Delete</button>
        </div>
        <p class="status-msg admin-msg" style="display:none;"></p>
      </div>`;
    }

    function showStatus(card, text, type) {
      const el = card.querySelector('.status-msg');
      el.textContent = text;
      el.className = 'admin-msg admin-msg-' + type;
      el.style.display = 'block';
    }

    async function load() {
      const res = await window.adminFetch('/api/admin/notifications');
      const channels = await res.json();
      channelsList.innerHTML = channels.map(channelCard).join('') || '<p class="admin-msg admin-msg-warning">No notification channels configured yet. You won\'t be alerted when a sale completes.</p>';
      wireCards();
    }

    function wireCards() {
      document.querySelectorAll('.notification-channel-card[data-channel-id]').forEach(card => {
        const channelId = card.dataset.channelId;

        card.querySelector('.send-test').addEventListener('click', async () => {
          const btn = card.querySelector('.send-test');
          const originalText = btn.textContent;
          btn.disabled = true;
          btn.textContent = 'Sending…';
          try {
            const res = await window.adminFetch(`/api/admin/notifications/${channelId}/test`, { method: 'POST' });
            const data = await res.json();
            if (res.ok && data.success) {
              showStatus(card, 'Test notification sent.', 'success');
            } else {
              showStatus(card, data.error || 'Test send failed.', 'error');
            }
          } catch (err) {
            showStatus(card, 'Network error sending test notification.', 'error');
          } finally {
            btn.disabled = false;
            btn.textContent = originalText;
          }
        });

        card.querySelector('.toggle-active').addEventListener('click', async () => {
          const isCurrentlyActive = card.querySelector('.admin-badge-active') !== null;
          const res = await window.adminFetch(`/api/admin/notifications/${channelId}`, {
            method: 'PUT',
            body: JSON.stringify({ isActive: !isCurrentlyActive })
          });
          if (res.ok) load();
        });

        card.querySelector('.delete-channel').addEventListener('click', async () => {
          if (!confirm('Delete this notification channel?')) return;
          const res = await window.adminFetch(`/api/admin/notifications/${channelId}`, { method: 'DELETE' });
          if (res.ok) load();
        });
      });
    }

    document.getElementById('addChannelForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errorEl = document.getElementById('addChannelError');
      errorEl.style.display = 'none';

      const channelType = document.getElementById('channelType').value;
      const label = document.getElementById('channelLabel').value;

      let payload;
      if (channelType === 'email') {
        payload = { channelType, label, address: document.getElementById('emailAddress').value };
      } else if (channelType === 'webhook') {
        payload = { channelType, label, url: document.getElementById('webhookUrl').value };
      } else {
        payload = {
          channelType,
          label,
          serverUrl: document.getElementById('gotifyServerUrl').value,
          token: document.getElementById('gotifyToken').value
        };
      }

      const res = await window.adminFetch('/api/admin/notifications', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        e.target.reset();
        applyFieldVisibility();
        load();
      } else {
        const data = await res.json();
        errorEl.textContent = (data.details && data.details[0] && data.details[0].message) || data.error || 'Failed to add channel.';
        errorEl.style.display = 'block';
      }
    });

    load();
  }

  // ---- website types: list page ----
  function initWebsiteTypesIndexPage() {
    const slug = document.body.dataset.slug;
    attachCharCounter(document.getElementById('typeDescription'));

    async function load() {
      const res = await window.adminFetch('/api/admin/website-types');
      const types = await res.json();
      document.getElementById('typesTableBody').innerHTML = types.map(t => `
        <tr>
          <td data-label="Name"><a href="/${slug}/website-types/${t.id}" class="font-medium text-brand-500">${escapeHtml(t.name)}</a></td>
          <td data-label="Status"><span class="admin-badge ${t.isActive ? 'admin-badge-active' : 'admin-badge-error'}">${t.isActive ? 'active' : 'inactive'}</span></td>
          <td data-label="Fields">${t.fieldCount}</td>
          <td data-label="Template">${t.activeTemplateVersion ? 'v' + t.activeTemplateVersion : 'n/a'}</td>
          <td data-label="Price">$${Number(t.priceUsd).toFixed(2)}${t.aiEnabled ? ' <span class="admin-badge admin-badge-active">AI</span>' : ''}</td>
          <td data-label=""><button type="button" class="admin-btn-danger admin-btn-sm delete-type" data-id="${t.id}">Delete</button></td>
        </tr>`).join('') || '<tr><td colspan="6" data-label="">No website types yet.</td></tr>';

      document.querySelectorAll('.delete-type').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this website type? This permanently removes its fields and template history.')) return;
          const res = await window.adminFetch(`/api/admin/website-types/${btn.dataset.id}`, { method: 'DELETE' });
          if (res.ok) load();
        });
      });
    }

    document.getElementById('addTypeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const statusEl = document.getElementById('addStatus');
      const res = await window.adminFetch('/api/admin/website-types', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.value,
          slug: form.slug.value || undefined,
          description: form.description.value,
          priceUsd: Number(form.priceUsd.value) || 0,
          iconName: form.iconName.value
        })
      });
      const data = await res.json();
      if (res.ok) {
        form.reset();
        statusEl.style.display = 'none';
        load();
      } else {
        statusEl.textContent = data.error || 'Failed to create website type.';
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.style.display = 'block';
      }
    });

    load();
  }

  // ---- website types: detail page ----
  function initWebsiteTypesDetailPage() {
    const typeId = document.body.dataset.typeId;
    let currentFields = [];
    let currentOutputFields = [];
    attachCharCounter(document.getElementById('detailsDescription'));

    function placeholderTokenForField(f) {
      return `{{${f.fieldKey}}}`;
    }

    function placeholderTokenForOutput(f) {
      if (f.outputType === 'array_of_strings') {
        return `{{#each ${f.outputKey}}} {{this}} {{/each}}`;
      }
      if (f.outputType === 'array_of_objects') {
        const shapeKeys = f.objectShape ? Object.keys(f.objectShape) : [];
        const inner = shapeKeys.map(k => `{{this.${k}}}`).join(' ');
        return `{{#each ${f.outputKey}}} ${inner} {{/each}}`;
      }
      return `{{${f.outputKey}}}`;
    }

    // Combines raw fields and (if AI is enabled) AI output fields into one
    // reference list — flat outputs and raw fields both show as {{key}},
    // array-shaped outputs show the full {{#each key}}...{{/each}} syntax
    // so the admin never has to guess which form a given field needs in
    // the template.
    function renderPlaceholdersReference() {
      const tokens = currentFields.map(placeholderTokenForField).concat(currentOutputFields.map(placeholderTokenForOutput));
      document.getElementById('availablePlaceholders').textContent = tokens.length ? tokens.join(',  ') : 'none defined yet';
    }

    // v1.0.9: same reference list as the Template tab's, plus the five
    // system variables that are always available to an email template on
    // top of this type's own fields/outputs — kept in sync by hand with
    // routes/adminWebsiteTypes.js's SYSTEM_EMAIL_VARIABLES (small, stable
    // list, not worth a shared-module round trip for).
    const SYSTEM_EMAIL_VARIABLES = ['site_url', 'client_email', 'website_type_name', 'deployed_at', 'site_password'];
    function renderEmailPlaceholdersReference() {
      const tokens = SYSTEM_EMAIL_VARIABLES.map(v => `{{${v}}}`)
        .concat(currentFields.map(placeholderTokenForField))
        .concat(currentOutputFields.map(placeholderTokenForOutput));
      document.getElementById('availableEmailPlaceholders').textContent = tokens.join(',  ');
    }

    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';
      });
    });

    // v1.1.4 Part B: "Or upload a .txt/.html file" convenience, shared by
    // the Template tab, the Email tab's HTML body, and the new Password
    // Page tab — all three are "admin pastes a large chunk of HTML into a
    // textarea" in the exact same shape. Client-side only, via FileReader:
    // the file's text content just populates the existing textarea's
    // value, nothing is uploaded to the server as a file (there's no file
    // storage in this project, and this was never meant to persist as a
    // file). The admin still reviews the populated textarea and clicks
    // "Save new version" themselves, exactly as before — this doesn't
    // change the save flow at all, just how the content gets into the box.
    function wireFileUploadIntoTextarea(fileInputId, textareaId) {
      const fileInput = document.getElementById(fileInputId);
      const textarea = document.getElementById(textareaId);
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          textarea.value = typeof reader.result === 'string' ? reader.result : '';
          fileInput.value = ''; // so picking the exact same file again still fires 'change'
        };
        reader.onerror = () => {
          alert('Could not read that file.');
          fileInput.value = '';
        };
        reader.readAsText(file);
      });
    }
    wireFileUploadIntoTextarea('templateFileInput', 'htmlContent');
    wireFileUploadIntoTextarea('emailBodyFileInput', 'emailHtmlBody');
    wireFileUploadIntoTextarea('passwordPageFileInput', 'passwordPageHtmlContent');

    // v1.0.8 Part A: the field-type select's dropdown-options row only
    // makes sense for the three "pick from a list" types — hidden
    // otherwise so a text/number/date field doesn't show an irrelevant
    // "Options" input. OPTION_BASED_FIELD_TYPES mirrors
    // lib/fieldTypes.js's own list (kept in sync by hand since this is
    // client-side JS, not a shared module — small, stable list, low risk
    // of drift).
    const OPTION_BASED_FIELD_TYPES = ['dropdown', 'radio', 'checkboxes'];
    function toggleDropdownOptionsRow() {
      const isOptionBased = OPTION_BASED_FIELD_TYPES.includes(document.getElementById('fieldTypeSelect').value);
      document.getElementById('dropdownOptionsRow').style.display = isOptionBased ? 'block' : 'none';
      document.getElementById('fieldDropdownOptions').style.display = isOptionBased ? 'block' : 'none';
    }
    document.getElementById('fieldTypeSelect').addEventListener('change', toggleDropdownOptionsRow);
    toggleDropdownOptionsRow();

    document.getElementById('detailsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name.value,
          description: form.description.value,
          priceUsd: Number(form.priceUsd.value) || 0,
          demoUrl: form.demoUrl.value,
          displayOrder: Number(form.displayOrder.value) || 0,
          isActive: form.isActive.checked,
          iconName: form.iconName.value,
          deploySlugPattern: form.deploySlugPattern.value,
          seoTitle: form.seoTitle.value,
          seoDescription: form.seoDescription.value,
          // v1.1.4 Part D: "None" (empty option value) explicitly clears
          // the category back to null, rather than being omitted — see
          // routes/adminWebsiteTypes.js's updateTypeSchema comment on why
          // categoryId needs a real null, not just "don't send the field".
          categoryId: form.categoryId.value ? Number(form.categoryId.value) : null
        })
      });
      const data = await res.json();
      const statusEl = document.getElementById('detailsStatus');
      statusEl.style.display = 'block';
      if (!res.ok) {
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.textContent = data.error || 'Failed to save.';
        return;
      }
      const warnings = data.deploySlugWarnings || [];
      statusEl.className = 'admin-msg ' + (warnings.length ? 'admin-msg-warning' : 'admin-msg-success');
      statusEl.textContent = warnings.length ? `Saved, but: ${warnings.join(' | ')}` : 'Saved.';
    });

    // v1.1.4 Part A: null while adding a new field; the field's id while
    // editing an existing one in-place. addFieldForm (below) branches its
    // submit behavior (POST vs PUT) on this.
    let editingFieldId = null;

    function resetFieldForm() {
      editingFieldId = null;
      const form = document.getElementById('addFieldForm');
      form.reset();
      document.getElementById('fieldKeyInput').disabled = false;
      toggleDropdownOptionsRow();
      document.getElementById('fieldFormHeading').textContent = 'Add field';
      document.getElementById('fieldSubmitBtn').textContent = 'Add field';
      document.getElementById('cancelFieldEditBtn').style.display = 'none';
    }

    function startFieldEdit(field) {
      editingFieldId = field.id;
      const form = document.getElementById('addFieldForm');
      form.fieldKey.value = field.fieldKey;
      form.fieldLabel.value = field.fieldLabel;
      form.fieldType.value = field.fieldType;
      form.placeholderText.value = field.placeholderText || '';
      form.isRequired.checked = field.isRequired;
      form.dropdownOptions.value = Array.isArray(field.dropdownOptions) ? field.dropdownOptions.join(', ') : '';
      toggleDropdownOptionsRow();
      document.getElementById('fieldFormHeading').textContent = `Edit field: ${field.fieldLabel}`;
      document.getElementById('fieldSubmitBtn').textContent = 'Save changes';
      document.getElementById('cancelFieldEditBtn').style.display = 'inline-block';
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    document.getElementById('cancelFieldEditBtn').addEventListener('click', resetFieldForm);

    async function loadFields() {
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/fields`);
      const fields = await res.json();
      currentFields = fields;
      document.getElementById('fieldsTableBody').innerHTML = fields.map((f, i) => `
        <tr data-id="${f.id}">
          <td data-label="Order">
            <button type="button" class="admin-btn-outline admin-btn-sm move-field-up" data-id="${f.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="admin-btn-outline admin-btn-sm move-field-down" data-id="${f.id}" ${i === fields.length - 1 ? 'disabled' : ''}>↓</button>
          </td>
          <td data-label="Key">{{${escapeHtml(f.fieldKey)}}}</td>
          <td data-label="Label">${escapeHtml(f.fieldLabel)}</td>
          <td data-label="Type">${escapeHtml(f.fieldType)}</td>
          <td data-label="Required">${f.isRequired ? 'yes' : 'no'}</td>
          <td data-label="">
            <button type="button" class="admin-btn-outline admin-btn-sm edit-field" data-id="${f.id}">Edit</button>
            <button type="button" class="admin-btn-danger admin-btn-sm remove-field" data-id="${f.id}">Remove</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="6" data-label="">No fields yet.</td></tr>';

      renderPlaceholdersReference();
      renderEmailPlaceholdersReference();

      // v1.1.4 Part A: a misclick here previously destroyed a field with
      // zero recovery — confirm() is a simple, no-custom-modal-needed way
      // to close that gap (same pattern the codebase already uses
      // elsewhere, e.g. website type / notification channel deletion).
      document.querySelectorAll('.remove-field').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this field? Any Template, AI prompt, or Email content referencing it will stop working.')) return;
          const res = await window.adminFetch(`/api/admin/website-types/${typeId}/fields/${btn.dataset.id}`, { method: 'DELETE' });
          if (res.ok) {
            if (editingFieldId === Number(btn.dataset.id)) resetFieldForm();
            loadFields();
          }
        });
      });

      document.querySelectorAll('.edit-field').forEach(btn => {
        btn.addEventListener('click', () => {
          const field = currentFields.find(f => String(f.id) === String(btn.dataset.id));
          if (field) startFieldEdit(field);
        });
      });

      // v1.1.4 Part A: drag-and-drop reordering was considered, but native
      // HTML5 drag events (dragstart/dragover/drop) simply don't fire from
      // touch input on mobile browsers — Advay works exclusively from an
      // Android phone, so a drag-and-drop-only implementation would be
      // completely unusable for the one device that actually matters
      // here. Up/down arrow buttons (same pattern already used for footer
      // links and landing sections elsewhere in this admin) work
      // identically on touch and desktop, so that's what's implemented —
      // each click swaps this field with its neighbor in `currentFields`
      // and persists the FULL new order via the new
      // PUT /fields/reorder endpoint.
      document.querySelectorAll('.move-field-up, .move-field-down').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = Number(btn.dataset.id);
          const idx = currentFields.findIndex(f => f.id === id);
          const direction = btn.classList.contains('move-field-up') ? -1 : 1;
          const targetIdx = idx + direction;
          if (idx === -1 || targetIdx < 0 || targetIdx >= currentFields.length) return;
          const reordered = currentFields.slice();
          const [moved] = reordered.splice(idx, 1);
          reordered.splice(targetIdx, 0, moved);
          saveFieldOrder(reordered.map(f => f.id));
        });
      });
    }

    async function saveFieldOrder(fieldIds) {
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/fields/reorder`, {
        method: 'PUT',
        body: JSON.stringify({ fieldIds })
      });
      if (res.ok) loadFields();
    }

    document.getElementById('addFieldForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const dropdownOptions = form.dropdownOptions.value
        ? form.dropdownOptions.value.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const newFieldKey = form.fieldKey.value;
      const statusEl = document.getElementById('fieldFormStatus');
      statusEl.style.display = 'none';

      if (editingFieldId) {
        // v1.1.4 Part A: changing field_key specifically (not label/
        // placeholder/required/options) gets its own explicit confirm —
        // renaming a key doesn't automatically update any Template/AI
        // prompt/Email content that already references the OLD key.
        const originalField = currentFields.find(f => f.id === editingFieldId);
        if (originalField && newFieldKey !== originalField.fieldKey) {
          const confirmed = confirm(
            `Changing this field's key from "${originalField.fieldKey}" to "${newFieldKey}" will NOT update any Template, AI prompt, or Email content that already uses {{${originalField.fieldKey}}}. Those will stop resolving. Continue?`
          );
          if (!confirmed) return;
        }

        const res = await window.adminFetch(`/api/admin/website-types/${typeId}/fields/${editingFieldId}`, {
          method: 'PUT',
          body: JSON.stringify({
            fieldKey: newFieldKey,
            fieldLabel: form.fieldLabel.value,
            fieldType: form.fieldType.value,
            placeholderText: form.placeholderText.value,
            isRequired: form.isRequired.checked,
            dropdownOptions
          })
        });
        if (res.ok) {
          resetFieldForm();
          loadFields();
          loadAiConfig();
        } else {
          const data = await res.json();
          statusEl.className = 'admin-msg admin-msg-error';
          statusEl.textContent = data.error || 'Failed to save field.';
          statusEl.style.display = 'block';
        }
        return;
      }

      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/fields`, {
        method: 'POST',
        body: JSON.stringify({
          fieldKey: newFieldKey,
          fieldLabel: form.fieldLabel.value,
          fieldType: form.fieldType.value,
          placeholderText: form.placeholderText.value,
          isRequired: form.isRequired.checked,
          dropdownOptions
        })
      });
      if (res.ok) {
        resetFieldForm();
        loadFields();
      } else {
        const data = await res.json();
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.textContent = data.error || 'Failed to add field.';
        statusEl.style.display = 'block';
      }
    });

    async function loadTemplate() {
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/template`);
      const data = await res.json();
      document.getElementById('currentVersion').textContent = data.active ? 'v' + data.active.version : 'none yet';
      document.getElementById('htmlContent').value = data.active ? data.active.htmlContent : '';
      document.getElementById('historyTableBody').innerHTML = data.history.map(h => `
        <tr>
          <td data-label="Version">v${h.version}</td>
          <td data-label="Created">${new Date(h.createdAt).toLocaleString()}</td>
          <td data-label="">${data.active && data.active.version === h.version ? '' : `<button type="button" class="admin-btn-outline admin-btn-sm rollback" data-version="${h.version}">Rollback to this</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="3" data-label="">No versions yet.</td></tr>';

      document.querySelectorAll('.rollback').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Roll back to version ${btn.dataset.version}?`)) return;
          const res = await window.adminFetch(`/api/admin/website-types/${typeId}/template/rollback/${btn.dataset.version}`, { method: 'POST' });
          if (res.ok) loadTemplate();
        });
      });
    }

    document.getElementById('templateForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/template`, {
        method: 'PUT',
        body: JSON.stringify({ htmlContent: document.getElementById('htmlContent').value })
      });
      const data = await res.json();
      const statusEl = document.getElementById('templateStatus');
      statusEl.style.display = 'block';
      if (res.ok) {
        const warnings = []
          .concat(data.undefinedPlaceholders.length ? [`no matching field: ${data.undefinedPlaceholders.join(', ')}`] : [])
          .concat(data.shapeWarnings || []);
        statusEl.className = 'admin-msg ' + (warnings.length ? 'admin-msg-warning' : 'admin-msg-success');
        statusEl.textContent = warnings.length
          ? `Saved as v${data.version}, but: ${warnings.join(' | ')}`
          : `Saved as v${data.version}.`;
        loadTemplate();
      } else {
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.textContent = data.error || 'Failed to save template.';
      }
    });

    // ---- AI tab (v1.0.6) ----

    function renderOutputFieldsTable() {
      document.getElementById('outputFieldsTableBody').innerHTML = currentOutputFields.map(f => `
        <tr>
          <td data-label="Placeholder">${escapeHtml(placeholderTokenForOutput(f))}</td>
          <td data-label="Type">${escapeHtml(f.outputType)}</td>
          <td data-label="Description">${truncatedHtml(f.description || '')}</td>
          <td data-label=""><button type="button" class="admin-btn-danger admin-btn-sm remove-output-field" data-id="${f.id}">Remove</button></td>
        </tr>`).join('') || '<tr><td colspan="4" data-label="">No output fields yet.</td></tr>';

      document.querySelectorAll('.remove-output-field').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this output field? Any Template or Email content referencing it will stop working.')) return;
          const res = await window.adminFetch(`/api/admin/website-types/${typeId}/ai/output-fields/${btn.dataset.id}`, { method: 'DELETE' });
          if (res.ok) loadAiConfig();
        });
      });
    }

    async function loadAiConfig() {
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/ai`);
      const data = await res.json();

      document.getElementById('aiEnabledToggle').checked = data.aiEnabled;
      document.getElementById('aiConfigSection').style.display = data.aiEnabled ? 'block' : 'none';
      document.getElementById('aiSystemPrompt').value = data.aiSystemPrompt || '';
      document.getElementById('aiUserPromptTemplate').value = data.aiUserPromptTemplate || '';
      document.getElementById('aiAvailableFields').textContent =
        currentFields.length ? currentFields.map(placeholderTokenForField).join(', ') : 'none defined yet, add raw fields first';

      currentOutputFields = data.outputFields || [];
      renderOutputFieldsTable();
      renderPlaceholdersReference();
      renderEmailPlaceholdersReference();
    }

    document.getElementById('aiEnabledToggle').addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      document.getElementById('aiConfigSection').style.display = enabled ? 'block' : 'none';
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/ai`, {
        method: 'PUT',
        body: JSON.stringify({ aiEnabled: enabled })
      });
      if (res.ok) loadAiConfig();
    });

    document.getElementById('saveAiConfigBtn').addEventListener('click', async () => {
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/ai`, {
        method: 'PUT',
        body: JSON.stringify({
          aiSystemPrompt: document.getElementById('aiSystemPrompt').value,
          aiUserPromptTemplate: document.getElementById('aiUserPromptTemplate').value
        })
      });
      const statusEl = document.getElementById('aiConfigStatus');
      statusEl.style.display = 'block';
      statusEl.className = 'admin-msg ' + (res.ok ? 'admin-msg-success' : 'admin-msg-error');
      statusEl.textContent = res.ok ? 'Saved.' : 'Failed to save.';
    });

    // Bug fix: the object-shape-keys row had the exact same
    // "hide two elements, only ever un-hide one of them" bug that
    // toggleDropdownOptionsRow() above deliberately avoids — the change
    // listener only ever toggled `objectShapeRow` (the <label>), never
    // `objectShapeKeysInput` (the actual <input>, which starts with an
    // inline `style="display:none;"` in the markup and had nothing that
    // ever set it back to visible). The input was never actually
    // missing from the page — it was present in the DOM the whole
    // time, just permanently hidden, which looks identical to "missing"
    // from the browser and made it impossible to ever type a value into
    // it. Fixed the same way as the working dropdown-options pattern
    // just above: one named function toggles both elements together,
    // wired to `change`, and called once immediately so a browser
    // restoring previous form state (e.g. via back/forward navigation)
    // can't land on a mismatched label-visible-but-input-hidden state.
    function toggleObjectShapeRow() {
      const isObjectList = document.getElementById('outputTypeSelect').value === 'array_of_objects';
      document.getElementById('objectShapeRow').style.display = isObjectList ? 'block' : 'none';
      document.getElementById('objectShapeKeysInput').style.display = isObjectList ? 'block' : 'none';
    }
    document.getElementById('outputTypeSelect').addEventListener('change', toggleObjectShapeRow);
    toggleObjectShapeRow();

    document.getElementById('addOutputFieldForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const outputType = form.outputType.value;
      let objectShape;
      if (outputType === 'array_of_objects') {
        const keys = form.objectShapeKeys.value.split(',').map(s => s.trim()).filter(Boolean);
        objectShape = {};
        keys.forEach(k => { objectShape[k] = 'string'; });
      }
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/ai/output-fields`, {
        method: 'POST',
        body: JSON.stringify({
          outputKey: form.outputKey.value,
          outputType,
          description: form.description.value,
          objectShape
        })
      });
      if (res.ok) {
        form.reset();
        toggleObjectShapeRow();
        loadAiConfig();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add output field.');
      }
    });

    // ---- Email tab (v1.0.9 Part A) ----

    async function loadEmailTemplate() {
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/email-template`);
      const data = await res.json();
      document.getElementById('currentEmailVersion').textContent = data.active ? 'v' + data.active.version : 'none yet, generic fallback email is used';
      document.getElementById('emailSubject').value = data.active ? data.active.subject : '';
      document.getElementById('emailHtmlBody').value = data.active ? data.active.htmlBody : '';
      document.getElementById('emailHistoryTableBody').innerHTML = data.history.map(h => `
        <tr>
          <td data-label="Version">v${h.version}</td>
          <td data-label="Created">${new Date(h.createdAt).toLocaleString()}</td>
          <td data-label="">${data.active && data.active.version === h.version ? '' : `<button type="button" class="admin-btn-outline admin-btn-sm rollback-email" data-version="${h.version}">Rollback to this</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="3" data-label="">No versions yet. The generic fallback email is used.</td></tr>';

      document.querySelectorAll('.rollback-email').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Roll back to version ${btn.dataset.version}?`)) return;
          const res = await window.adminFetch(`/api/admin/website-types/${typeId}/email-template/rollback/${btn.dataset.version}`, { method: 'POST' });
          if (res.ok) loadEmailTemplate();
        });
      });
    }

    document.getElementById('emailTemplateForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/email-template`, {
        method: 'PUT',
        body: JSON.stringify({
          subject: document.getElementById('emailSubject').value,
          htmlBody: document.getElementById('emailHtmlBody').value
        })
      });
      const data = await res.json();
      const statusEl = document.getElementById('emailTemplateStatus');
      statusEl.style.display = 'block';
      if (res.ok) {
        const warnings = []
          .concat(data.undefinedPlaceholders.length ? [`no matching field: ${data.undefinedPlaceholders.join(', ')}`] : [])
          .concat(data.shapeWarnings || []);
        statusEl.className = 'admin-msg ' + (warnings.length ? 'admin-msg-warning' : 'admin-msg-success');
        statusEl.textContent = warnings.length
          ? `Saved as v${data.version}, but: ${warnings.join(' | ')}`
          : `Saved as v${data.version}.`;
        loadEmailTemplate();
      } else {
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.textContent = data.error || 'Failed to save email template.';
      }
    });

    // ---- Password Page tab (v1.1.4 Part C) ----

    async function loadPasswordPage() {
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/password-page`);
      const data = await res.json();
      document.getElementById('currentPasswordPageVersion').textContent = data.active ? 'v' + data.active.version : 'none yet, generic fallback gate is used';
      document.getElementById('passwordPageHtmlContent').value = data.active ? data.active.htmlContent : '';
      document.getElementById('passwordPageHistoryTableBody').innerHTML = data.history.map(h => `
        <tr>
          <td data-label="Version">v${h.version}</td>
          <td data-label="Created">${new Date(h.createdAt).toLocaleString()}</td>
          <td data-label="">${data.active && data.active.version === h.version ? '' : `<button type="button" class="admin-btn-outline admin-btn-sm rollback-password-page" data-version="${h.version}">Rollback to this</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="3" data-label="">No versions yet. The generic fallback gate is used.</td></tr>';

      document.querySelectorAll('.rollback-password-page').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm(`Roll back to version ${btn.dataset.version}?`)) return;
          const res = await window.adminFetch(`/api/admin/website-types/${typeId}/password-page/rollback/${btn.dataset.version}`, { method: 'POST' });
          if (res.ok) loadPasswordPage();
        });
      });
    }

    document.getElementById('passwordPageForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/password-page`, {
        method: 'PUT',
        body: JSON.stringify({ htmlContent: document.getElementById('passwordPageHtmlContent').value })
      });
      const data = await res.json();
      const statusEl = document.getElementById('passwordPageStatus');
      statusEl.style.display = 'block';
      if (res.ok) {
        const warnings = []
          .concat(data.undefinedPlaceholders.length ? [`unrecognized placeholder: ${data.undefinedPlaceholders.join(', ')}`] : [])
          .concat(data.missingFunctionalToken ? ['missing {{password_input_and_button}}, visitors won\'t be able to enter a password on this design'] : []);
        statusEl.className = 'admin-msg ' + (warnings.length ? 'admin-msg-warning' : 'admin-msg-success');
        statusEl.textContent = warnings.length
          ? `Saved as v${data.version}, but: ${warnings.join(' | ')}`
          : `Saved as v${data.version}.`;
        loadPasswordPage();
      } else {
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.textContent = data.error || 'Failed to save password page.';
      }
    });

    loadFields().then(loadAiConfig);
    loadTemplate();
    loadEmailTemplate();
    loadPasswordPage();
  }

  // ---- overview page ----
  // v1.1.7: the four stat-card shells (icon + label) are now rendered
  // server-side in overview.ejs, since their icons come from
  // getIconSvg(), a server-only helper. This function's job is just to
  // fill each card's value/badge/caption slots and the breakdown table
  // body -- no HTML structure is built here anymore. There's no real
  // trend percentage anywhere in this app's data model (no stored
  // period-over-period comparison), so nothing here fabricates one --
  // the badge/caption slots only ever show real, already-computed data.
  //
  // v1.1.8 (redo, exact structures): badges now use the four explicit
  // color modifiers (see src/styles/admin.css's badge comment) instead
  // of the old gray-default look, and the Payments card's mode indicator
  // specifically always uses admin-badge-brand (neutral/informational),
  // per this version's own build brief naming that exact badge as the
  // brand-color example -- it no longer changes color between live/test.
  // ==========================================================================
  // Activity feed (v1.2.5, Chunk C) -- shared between the Dashboard's
  // compact widget and the full Activity page.
  // ==========================================================================
  const ACTIVITY_LABELS = {
    payment_received: { label: 'Payment received', dot: 'is-payment' },
    deployment_completed: { label: 'Deployment completed', dot: 'is-deploy' },
    email_sent: { label: 'Email sent', dot: 'is-email' },
    recovery_completed: { label: 'Deployment recovered', dot: 'is-recovery' },
    site_details_resent: { label: 'Site details resent', dot: 'is-email' },
    admin_config_changed: { label: 'Configuration changed', dot: 'is-config' }
  };
  function formatRelativeTime(iso) {
    const then = new Date(iso).getTime();
    const diffSec = Math.round((Date.now() - then) / 1000);
    if (diffSec < 5) return 'just now';
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function renderActivityRows(container, events) {
    container.textContent = '';
    if (!events.length) {
      const p = document.createElement('p');
      p.className = 'admin-form-hint';
      p.textContent = 'No activity yet.';
      container.appendChild(p);
      return;
    }
    events.forEach((e) => {
      const meta = ACTIVITY_LABELS[e.eventType] || { label: e.eventType, dot: '' };
      const row = document.createElement('div');
      row.className = 'activity-row';
      const dot = document.createElement('span');
      dot.className = 'activity-dot ' + meta.dot;
      const body = document.createElement('div');
      body.className = 'activity-body';
      const title = document.createElement('p');
      title.className = 'activity-title';
      title.textContent = e.title || meta.label;
      body.appendChild(title);
      if (e.detail) {
        const detail = document.createElement('p');
        detail.className = 'activity-detail';
        detail.textContent = e.detail;
        body.appendChild(detail);
      }
      const time = document.createElement('span');
      time.className = 'activity-time';
      time.textContent = formatRelativeTime(e.createdAt);
      time.title = new Date(e.createdAt).toLocaleString();
      row.append(dot, body, time);
      container.appendChild(row);
    });
  }

  function initActivityPage() {
    const list = document.getElementById('activityList');
    const typeFilter = document.getElementById('activityTypeFilter');
    const pageInfo = document.getElementById('activityPageInfo');
    const prevBtn = document.getElementById('activityPrev');
    const nextBtn = document.getElementById('activityNext');
    const refreshBtn = document.getElementById('activityRefresh');
    const LIMIT = 20;

    let cursors = [null];
    let pageIndex = 0;
    let eventType = '';
    let requestSeq = 0;

    async function loadTypeFilter() {
      try {
        const res = await window.adminFetch('/api/admin/activity?limit=1');
        if (!res.ok) return;
        const data = await res.json();
        data.eventTypes.forEach((t) => {
          const opt = document.createElement('option');
          opt.value = t;
          opt.textContent = (ACTIVITY_LABELS[t] || { label: t }).label;
          typeFilter.appendChild(opt);
        });
      } catch (_err) { /* filter just stays at "All activity" */ }
    }

    async function load() {
      const seq = ++requestSeq;
      list.classList.add('is-loading');
      const p = new URLSearchParams();
      p.set('limit', String(LIMIT));
      if (eventType) p.set('eventType', eventType);
      if (cursors[pageIndex]) p.set('cursor', cursors[pageIndex]);
      try {
        const res = await window.adminFetch('/api/admin/activity?' + p.toString());
        if (seq !== requestSeq) return;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (seq !== requestSeq) return;
        cursors[pageIndex + 1] = data.nextCursor || null;
        renderActivityRows(list, data.events);
        const start = pageIndex * LIMIT + 1;
        pageInfo.textContent = data.events.length ? `Showing ${start}\u2013${start + data.events.length - 1}` : '';
        prevBtn.disabled = pageIndex === 0;
        nextBtn.disabled = !cursors[pageIndex + 1];
      } catch (_err) {
        if (seq !== requestSeq) return;
        list.textContent = '';
        const p2 = document.createElement('p');
        p2.className = 'admin-msg admin-msg-error';
        p2.textContent = 'Could not load activity. Reload the page or sign in again.';
        list.appendChild(p2);
      } finally {
        if (seq === requestSeq) list.classList.remove('is-loading');
      }
    }
    function reload() { cursors = [null]; pageIndex = 0; load(); }

    typeFilter.addEventListener('change', () => { eventType = typeFilter.value; reload(); });
    refreshBtn.addEventListener('click', reload);
    prevBtn.addEventListener('click', () => { if (pageIndex > 0) { pageIndex--; load(); } });
    nextBtn.addEventListener('click', () => { if (cursors[pageIndex + 1]) { pageIndex++; load(); } });

    loadTypeFilter();
    load();
  }

  function initOverviewPage() {
    // ---- configuration cards (unchanged: /api/admin/dashboard/stats) ----
    const paymentsValue = document.getElementById('statPaymentsValue');
    const paymentsBadge = document.getElementById('statPaymentsBadge');
    const aiProviderValue = document.getElementById('statAiProviderValue');
    const aiProviderCaption = document.getElementById('statAiProviderCaption');
    const websiteTypesValue = document.getElementById('statWebsiteTypesValue');
    const websiteTypesBadge = document.getElementById('statWebsiteTypesBadge');
    const errorEl = document.getElementById('statsError');

    window.adminFetch('/api/admin/dashboard/stats')
      .then(res => res.json())
      .then(stats => {
        if (stats.paystackConfigured) {
          paymentsValue.textContent = 'Configured';
          paymentsBadge.innerHTML = `<span class="admin-badge admin-badge-brand">${escapeHtml(stats.paystackMode)}</span>`;
        } else {
          paymentsValue.textContent = 'Not set up';
          paymentsBadge.innerHTML = '';
        }
        if (stats.activeProvider) {
          aiProviderValue.textContent = stats.activeProvider.label;
          aiProviderCaption.textContent = stats.activeProvider.selectedModel || 'No model selected';
        } else {
          aiProviderValue.textContent = 'None active';
          aiProviderCaption.textContent = 'Set one up on the AI Provider page';
        }
        websiteTypesValue.textContent = String(stats.activeTypeCount);
        websiteTypesBadge.innerHTML = `<span class="admin-badge admin-badge-brand">${stats.inactiveTypeCount} inactive</span>`;
      })
      .catch(() => {
        errorEl.style.display = 'block';
        [paymentsValue, aiProviderValue, websiteTypesValue].forEach(el => { el.textContent = 'Unavailable'; });
      });

    // ======================================================================
    // Analytics (v1.2.4, Chunk B) -- date-ranged overview metrics, two
    // zero-dependency inline-SVG time series charts, and a sortable
    // website-type breakdown. All three read from /api/admin/analytics/*,
    // which aggregates in Postgres (see lib/analyticsQueries.js) rather
    // than shipping rows to the browser to add up.
    // ======================================================================
    const API = '/api/admin/analytics';
    const $ = (id) => document.getElementById(id);
    const els = {
      range: $('analyticsRange'), refresh: $('analyticsRefresh'),
      customBox: $('analyticsCustomRange'), from: $('analyticsFrom'), to: $('analyticsTo'),
      error: $('analyticsError'), metrics: $('analyticsMetrics'),
      depValue: $('metricDeploymentsValue'), depChange: $('metricDeploymentsChange'),
      revValue: $('metricRevenueValue'), revChange: $('metricRevenueChange'),
      subValue: $('metricSubscribersValue'), subChange: $('metricSubscribersChange'),
      depChart: $('deploymentsChart'), revChart: $('revenueChart'),
      breakdownSort: $('breakdownSort'), breakdownList: $('breakdownList')
    };

    const state = { range: '30d', from: '', to: '', sort: 'deployments' };
    let requestSeq = 0;

    function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
    function parseDay(value) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }
    // Unlike the Deployments page's range filter (which leaves `to` open
    // for "last N days" so it always includes anything up to right now),
    // every preset here resolves to a CONCRETE [from, to) pair -- the
    // previous-period comparison needs an exact duration to mirror.
    function rangeBounds() {
      const now = new Date();
      const today = startOfDay(now);
      switch (state.range) {
        case 'today': return { from: today, to: addDays(today, 1) };
        case 'yesterday': return { from: addDays(today, -1), to: today };
        case '7d': return { from: addDays(today, -6), to: addDays(today, 1) };
        case '30d': return { from: addDays(today, -29), to: addDays(today, 1) };
        case '90d': return { from: addDays(today, -89), to: addDays(today, 1) };
        case 'year': return { from: new Date(today.getFullYear(), 0, 1), to: addDays(today, 1) };
        case 'custom': {
          const f = parseDay(state.from), t = parseDay(state.to);
          return { from: f, to: t ? addDays(t, 1) : null };
        }
        default: return { from: null, to: null }; // 'all'
      }
    }
    function customRangeInvalid() {
      if (state.range !== 'custom') return false;
      const f = parseDay(state.from), t = parseDay(state.to);
      return !!(f && t && f > t);
    }
    function rangeParams() {
      const p = new URLSearchParams();
      const b = rangeBounds();
      if (b.from) p.set('from', b.from.toISOString());
      if (b.to) p.set('to', b.to.toISOString());
      try { p.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (_err) { /* default UTC server-side */ }
      return p;
    }

    function formatMoney(n) {
      return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function formatCompact(n) {
      return Number(n).toLocaleString('en-US');
    }
    function renderChange(el, pct) {
      if (pct === null || pct === undefined) { el.textContent = state.range === 'all' ? '' : 'New this period'; el.className = 'admin-metric-change'; return; }
      const rounded = Math.abs(pct) < 0.05 ? 0 : pct;
      const arrow = rounded > 0 ? '\u2191' : rounded < 0 ? '\u2193' : '\u2192';
      el.textContent = `${arrow} ${Math.abs(rounded).toFixed(1)}% vs previous period`;
      el.className = 'admin-metric-change ' + (rounded > 0 ? 'is-up' : rounded < 0 ? 'is-down' : 'is-flat');
    }

    // ---- inline SVG line chart (no external library; CSP allows only
    // self-hosted script, so anything chart-shaped is either this or a
    // <canvas> -- SVG is simpler to keep accessible and crisp at any size) ----
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function svgEl(tag, attrs) {
      const node = document.createElementNS(SVG_NS, tag);
      Object.entries(attrs || {}).forEach(([k, v]) => node.setAttribute(k, v));
      return node;
    }
    function renderLineChart(svg, points, { formatValue, formatBucket }) {
      svg.textContent = '';
      const W = 600, H = 220, padL = 46, padR = 12, padT = 14, padB = 26;
      const innerW = W - padL - padR, innerH = H - padT - padB;
      if (!points.length) {
        const t = svgEl('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'admin-chart-empty' });
        t.textContent = 'No data for this range';
        svg.appendChild(t);
        return;
      }
      const values = points.map(p => p.value);
      const maxV = Math.max(...values, 0);
      const minV = Math.min(...values, 0);
      const span = maxV - minV || 1;
      const x = (i) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
      const y = (v) => padT + innerH - ((v - minV) / span) * innerH;

      // gridlines + y-axis labels (0%, 50%, 100% of the value range)
      [0, 0.5, 1].forEach((f) => {
        const yy = padT + innerH * (1 - f);
        svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: yy, y2: yy, class: 'admin-chart-grid' }));
        const label = svgEl('text', { x: padL - 8, y: yy + 4, 'text-anchor': 'end', class: 'admin-chart-axis' });
        label.textContent = formatValue(minV + span * f);
        svg.appendChild(label);
      });

      // area fill + line
      const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
      const areaPath = `${linePath} L ${x(points.length - 1).toFixed(1)} ${(padT + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;
      svg.appendChild(svgEl('path', { d: areaPath, class: 'admin-chart-area' }));
      svg.appendChild(svgEl('path', { d: linePath, class: 'admin-chart-line', fill: 'none' }));

      // a dot + native <title> tooltip per point (keeps this dependency-free;
      // native tooltips are enough at this stage rather than building a
      // custom hover/tooltip component for a first analytics pass)
      points.forEach((p, i) => {
        const dot = svgEl('circle', { cx: x(i), cy: y(p.value), r: 2.6, class: 'admin-chart-dot' });
        const title = document.createElementNS(SVG_NS, 'title');
        title.textContent = `${formatBucket(p.bucket)}: ${formatValue(p.value)}`;
        dot.appendChild(title);
        svg.appendChild(dot);
      });

      // x-axis labels: first, middle, last bucket only (avoids overlap at any width)
      [0, Math.floor((points.length - 1) / 2), points.length - 1].forEach((i, idx, arr) => {
        if (idx > 0 && arr[idx] === arr[idx - 1]) return;
        const label = svgEl('text', {
          x: x(i), y: H - 6,
          'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle',
          class: 'admin-chart-axis'
        });
        label.textContent = formatBucket(points[i].bucket);
        svg.appendChild(label);
      });
    }
    function bucketLabel(iso, granularity) {
      const d = new Date(iso);
      if (granularity === 'hour') return d.toLocaleTimeString(undefined, { hour: 'numeric' });
      if (granularity === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }
    function renderBreakdown(types) {
      els.breakdownList.textContent = '';
      if (!types.length) { els.breakdownList.appendChild(el('p', 'admin-form-hint', 'No website types yet.')); return; }
      const key = state.sort === 'revenue' ? 'revenueUsd' : 'deployments';
      const max = Math.max(...types.map(t => t[key]), 1);
      types.forEach((t) => {
        const row = el('div', 'admin-breakdown-row' + (t.isActive ? '' : ' is-inactive'));
        const label = el('div', 'admin-breakdown-label');
        label.appendChild(el('span', 'admin-breakdown-name', t.name));
        if (!t.isActive) label.appendChild(el('span', 'admin-badge admin-badge-inactive', 'inactive'));
        const track = el('div', 'admin-breakdown-track');
        const fill = el('div', 'admin-breakdown-fill');
        fill.style.width = Math.max(2, Math.round((t[key] / max) * 100)) + '%';
        track.appendChild(fill);
        const value = el('div', 'admin-breakdown-value', state.sort === 'revenue' ? formatMoney(t.revenueUsd) : formatCompact(t.deployments));
        row.append(label, track, value);
        els.breakdownList.appendChild(row);
      });
    }

    async function loadBreakdown() {
      const p = rangeParams();
      p.set('sort', state.sort);
      try {
        const res = await window.adminFetch(API + '/website-types?' + p.toString());
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        renderBreakdown(data.types);
      } catch (_err) {
        els.breakdownList.textContent = '';
        els.breakdownList.appendChild(el('p', 'admin-msg admin-msg-error', 'Could not load the website-type breakdown.'));
      }
    }

    async function loadAnalytics() {
      const seq = ++requestSeq;
      if (customRangeInvalid()) {
        els.error.style.display = 'block';
        els.error.textContent = 'Choose a valid date range.';
        return;
      }
      els.error.style.display = 'none';
      const p = rangeParams();
      try {
        const [ovRes, depRes, revRes] = await Promise.all([
          window.adminFetch(API + '/overview?' + p.toString()),
          window.adminFetch(API + '/deployments?' + p.toString()),
          window.adminFetch(API + '/revenue?' + p.toString())
        ]);
        if (seq !== requestSeq) return;
        if (!ovRes.ok || !depRes.ok || !revRes.ok) throw new Error('HTTP error');
        const overview = await ovRes.json();
        const depSeries = await depRes.json();
        const revSeries = await revRes.json();
        if (seq !== requestSeq) return;

        els.depValue.textContent = formatCompact(overview.current.deployments);
        els.revValue.textContent = formatMoney(overview.current.revenueUsd);
        els.subValue.textContent = formatCompact(overview.current.newSubscribers);
        if (overview.change) {
          renderChange(els.depChange, overview.change.deploymentsPct);
          renderChange(els.revChange, overview.change.revenuePct);
          renderChange(els.subChange, overview.change.newSubscribersPct);
        } else {
          [els.depChange, els.revChange, els.subChange].forEach(e => { e.textContent = ''; e.className = 'admin-metric-change'; });
        }

        renderLineChart(
          els.depChart,
          depSeries.series.map(p => ({ bucket: p.bucket, value: p.deployments })),
          { formatValue: formatCompact, formatBucket: (b) => bucketLabel(b, depSeries.granularity) }
        );
        renderLineChart(
          els.revChart,
          revSeries.series.map(p => ({ bucket: p.bucket, value: p.revenueUsd })),
          { formatValue: (v) => '$' + Math.round(v).toLocaleString('en-US'), formatBucket: (b) => bucketLabel(b, revSeries.granularity) }
        );
      } catch (_err) {
        if (seq !== requestSeq) return;
        els.error.style.display = 'block';
        els.error.textContent = 'Could not load analytics. Reload the page or sign in again.';
      }
      loadBreakdown();
    }

    els.range.addEventListener('change', () => {
      state.range = els.range.value;
      els.customBox.hidden = state.range !== 'custom';
      if (state.range !== 'custom') { state.from = ''; state.to = ''; els.from.value = ''; els.to.value = ''; }
      loadAnalytics();
    });
    els.from.addEventListener('change', () => { state.from = els.from.value; loadAnalytics(); });
    els.to.addEventListener('change', () => { state.to = els.to.value; loadAnalytics(); });
    els.refresh.addEventListener('click', loadAnalytics);
    els.breakdownSort.addEventListener('change', () => { state.sort = els.breakdownSort.value; loadBreakdown(); });

    loadAnalytics();

    // ---- Recent Activity widget (compact, latest 8, no pagination here --
    // see initActivityPage() for the full paginated/filterable feed) ----
    (async () => {
      const container = document.getElementById('recentActivityList');
      try {
        const res = await window.adminFetch('/api/admin/activity?limit=8');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        renderActivityRows(container, data.events);
      } catch (_err) {
        container.textContent = '';
        const p = document.createElement('p');
        p.className = 'admin-msg admin-msg-error';
        p.textContent = 'Could not load recent activity.';
        container.appendChild(p);
      }
    })();
  }

  // ---- submissions page (deployments + subscribers) ----
  function initSubmissionsPage() {
    // ======================================================================
    // Deployments -- "Deployment Center" (v1.2.3)
    //
    // Keyset (cursor) pagination: the server hands back an opaque
    // `nextCursor`, never a page number, so this page can't jump to "page
    // 40" -- it keeps a stack of the cursors it has seen instead, which is
    // what makes Previous work without re-deriving anything. The exact
    // total/revenue comes back only with the FIRST page of a given filter
    // set (see routes/adminDashboard.js), so it's remembered here rather
    // than expected on every response.
    //
    // Everything user-derived (client_email is typed by the public at
    // checkout) is rendered with textContent/DOM nodes, never innerHTML.
    // ======================================================================
    const API = '/api/admin/dashboard/deployments';
    const $ = (id) => document.getElementById(id);
    const els = {
      search: $('deploymentSearch'), type: $('deploymentTypeFilter'), range: $('deploymentRangeFilter'),
      sort: $('deploymentSortFilter'), exportLink: $('deploymentExportLink'),
      customBox: $('deploymentCustomRange'), from: $('deploymentFrom'), to: $('deploymentTo'),
      activeBox: $('deploymentActiveFilters'), chips: $('deploymentActiveChips'), clear: $('deploymentClearFilters'),
      body: $('deploymentsTableBody'), summary: $('deploymentsSummary'), info: $('deploymentsPageInfo'),
      prev: $('deploymentsPrev'), next: $('deploymentsNext'), refresh: $('deploymentsRefresh'), pageSize: $('deploymentPageSize'),
      drawer: $('deploymentDrawer'), overlay: $('deploymentDrawerOverlay'), drawerTitle: $('deploymentDrawerTitle'),
      drawerStatus: $('deploymentDrawerStatus'), drawerBody: $('deploymentDrawerBody'), drawerClose: $('deploymentDrawerClose')
    };

    const RANGE_LABELS = { today: 'Today', yesterday: 'Yesterday', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', year: 'This year' };
    const state = { search: '', typeId: '', range: '', from: '', to: '', sort: 'newest', limit: 25 };
    let cursors = [null];   // cursors[i] is the cursor that fetches page i
    let pageIndex = 0;
    let summary = null;
    let rows = [];
    let requestSeq = 0;     // ignore responses from superseded requests
    let searchTimer = null;
    let typeNames = {};
    let drawerRef = null;

    function formatDate(iso) {
      return new Date(iso).toLocaleString();
    }
    function formatMoney(n) {
      return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function formatDeploymentAmount(d) {
      // v1.0.6: chargeCurrency/chargeAmount hold the REAL amount actually
      // charged for deployments from that version onward. Older rows only
      // have the legacy amountUsd figure (from amount_kes, already
      // effectively USD -- see routes/adminDashboard.js), shown with an
      // "(est.)" hint rather than asserting a currency that was never
      // actually recorded.
      if (d.chargeCurrency && d.chargeAmount !== null) {
        return d.chargeCurrency + ' ' + Number(d.chargeAmount).toFixed(2);
      }
      return d.amountUsd !== null ? '~' + formatMoney(d.amountUsd) + ' (est.)' : 'n/a';
    }
    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }
    function safeHttpUrl(url) {
      return /^https?:\/\//i.test(url || '') ? url : null;
    }

    // ---- date range -> the [from, to) instants the API expects ----
    // Computed in the ADMIN'S OWN timezone, so "Today" means the admin's
    // today, not UTC's. `to` is exclusive.
    function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
    function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
    function parseDay(value) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
      if (!m) return null;
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(d.getTime()) ? null : d;
    }
    function rangeBounds() {
      const today = startOfDay(new Date());
      switch (state.range) {
        case 'today': return { from: today, to: addDays(today, 1) };
        case 'yesterday': return { from: addDays(today, -1), to: today };
        case '7d': return { from: addDays(today, -6), to: null };
        case '30d': return { from: addDays(today, -29), to: null };
        case '90d': return { from: addDays(today, -89), to: null };
        case 'year': return { from: new Date(today.getFullYear(), 0, 1), to: null };
        case 'custom': {
          const f = parseDay(state.from);
          const t = parseDay(state.to);
          return { from: f, to: t ? addDays(t, 1) : null };
        }
        default: return { from: null, to: null };
      }
    }
    function filterParams() {
      const p = new URLSearchParams();
      if (state.search) p.set('search', state.search);
      if (state.typeId) p.set('typeId', state.typeId);
      const b = rangeBounds();
      if (b.from) p.set('from', b.from.toISOString());
      if (b.to) p.set('to', b.to.toISOString());
      p.set('sort', state.sort);
      return p;
    }
    function hasActiveFilters() {
      return !!(state.search || state.typeId || state.range);
    }
    function customRangeInvalid() {
      if (state.range !== 'custom') return false;
      const f = parseDay(state.from);
      const t = parseDay(state.to);
      return !!(f && t && f > t);
    }

    // ---- URL <-> state (so a filtered view survives a refresh / can be shared) ----
    function syncUrl() {
      const p = new URLSearchParams();
      if (state.search) p.set('q', state.search);
      if (state.typeId) p.set('type', state.typeId);
      if (state.range) p.set('range', state.range);
      if (state.range === 'custom') { if (state.from) p.set('from', state.from); if (state.to) p.set('to', state.to); }
      if (state.sort !== 'newest') p.set('sort', state.sort);
      if (state.limit !== 25) p.set('limit', String(state.limit));
      if (drawerRef) p.set('ref', drawerRef);
      const qs = p.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    }
    function readUrl() {
      const p = new URLSearchParams(location.search);
      state.search = (p.get('q') || '').slice(0, 200);
      state.typeId = /^\d+$/.test(p.get('type') || '') ? p.get('type') : '';
      const range = p.get('range') || '';
      state.range = (range === 'custom' || RANGE_LABELS[range]) ? range : '';
      state.from = parseDay(p.get('from')) ? p.get('from') : '';
      state.to = parseDay(p.get('to')) ? p.get('to') : '';
      state.sort = p.get('sort') === 'oldest' ? 'oldest' : 'newest';
      state.limit = ['25', '50', '100'].includes(p.get('limit')) ? Number(p.get('limit')) : 25;
      return p.get('ref');
    }
    function applyStateToControls() {
      els.search.value = state.search;
      els.type.value = state.typeId;
      els.range.value = state.range;
      els.sort.value = state.sort;
      els.from.value = state.from;
      els.to.value = state.to;
      els.pageSize.value = String(state.limit);
      els.customBox.hidden = state.range !== 'custom';
    }

    // ---- rendering ----
    function renderActiveFilters() {
      els.chips.textContent = '';
      const add = (label, clearFn) => {
        const chip = el('button', 'admin-chip', label + ' ✕');
        chip.type = 'button';
        chip.setAttribute('aria-label', 'Remove filter: ' + label);
        chip.addEventListener('click', () => { clearFn(); applyStateToControls(); reload(); });
        els.chips.appendChild(chip);
      };
      if (state.search) add('“' + state.search + '”', () => { state.search = ''; });
      if (state.typeId) add(typeNames[state.typeId] || 'Type #' + state.typeId, () => { state.typeId = ''; });
      if (state.range) {
        const label = state.range === 'custom'
          ? (state.from || '…') + ' → ' + (state.to || 'now')
          : RANGE_LABELS[state.range];
        add(label, () => { state.range = ''; state.from = ''; state.to = ''; });
      }
      els.activeBox.hidden = !hasActiveFilters();
    }

    function renderSummary() {
      els.summary.textContent = '';
      if (customRangeInvalid()) { els.summary.textContent = 'The From date must be on or before the To date.'; return; }
      if (!summary) return;
      const strong = el('strong', null, summary.total.toLocaleString('en-US'));
      els.summary.appendChild(strong);
      els.summary.appendChild(document.createTextNode(
        (hasActiveFilters() ? ' matching' : ' total') + ' \u00b7 ' + formatMoney(summary.revenueUsd) + ' revenue'
      ));
    }

    function renderPagination() {
      const total = summary ? summary.total : null;
      if (rows.length === 0) {
        els.info.textContent = '';
      } else {
        const start = pageIndex * state.limit + 1;
        const end = start + rows.length - 1;
        els.info.textContent = total !== null
          ? 'Showing ' + start.toLocaleString('en-US') + '\u2013' + end.toLocaleString('en-US') + ' of ' + total.toLocaleString('en-US')
          : 'Showing ' + start + '\u2013' + end;
      }
      els.prev.disabled = pageIndex === 0;
      els.next.disabled = !cursors[pageIndex + 1];
    }

    function messageRow(text) {
      els.body.textContent = '';
      const tr = el('tr');
      const td = el('td', null, text);
      td.colSpan = 4;
      td.setAttribute('data-label', '');
      tr.appendChild(td);
      els.body.appendChild(tr);
    }

    function renderRows() {
      if (rows.length === 0) {
        messageRow(hasActiveFilters() ? 'No deployments match these filters.' : 'No deployments yet.');
        return;
      }
      els.body.textContent = '';
      rows.forEach((d) => {
        const tr = el('tr');
        tr.dataset.ref = d.reference;

        const customer = el('td'); customer.setAttribute('data-label', 'Customer');
        const link = el('button', 'admin-row-link', d.clientEmail);
        link.type = 'button';
        link.setAttribute('aria-label', 'View deployment for ' + d.clientEmail);
        customer.appendChild(link);

        const site = el('td', null, d.websiteTypeName || 'n/a'); site.setAttribute('data-label', 'Website');
        const amount = el('td', null, formatDeploymentAmount(d)); amount.setAttribute('data-label', 'Amount');
        const when = el('td', null, formatDate(d.deployedAt)); when.setAttribute('data-label', 'Deployed');

        tr.append(customer, site, amount, when);
        els.body.appendChild(tr);
      });
    }

    function updateExportLink() {
      const p = filterParams();
      els.exportLink.href = API + '/export?' + p.toString();
    }

    // ---- loading ----
    async function loadDeployments() {
      const seq = ++requestSeq;
      els.body.classList.add('is-loading');
      if (customRangeInvalid()) {
        rows = []; summary = null;
        cursors = [null];
        renderSummary(); renderPagination();
        messageRow('Choose a valid date range.');
        els.body.classList.remove('is-loading');
        return;
      }
      const p = filterParams();
      p.set('limit', String(state.limit));
      if (cursors[pageIndex]) p.set('cursor', cursors[pageIndex]);
      try {
        const res = await window.adminFetch(API + '?' + p.toString());
        if (seq !== requestSeq) return;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (seq !== requestSeq) return;
        if (data.summary) summary = data.summary;
        cursors[pageIndex + 1] = data.nextCursor || null;
        rows = data.deployments;
        renderRows(); renderSummary(); renderPagination();
      } catch (err) {
        if (seq !== requestSeq) return;
        rows = [];
        messageRow('Could not load deployments (' + err.message + '). Reload the page or sign in again.');
        els.info.textContent = '';
        els.prev.disabled = pageIndex === 0;
        els.next.disabled = true;
      } finally {
        if (seq === requestSeq) els.body.classList.remove('is-loading');
      }
    }

    // Any change to the filter set starts over from the first page.
    function reload() {
      cursors = [null];
      pageIndex = 0;
      summary = null;
      updateExportLink();
      renderActiveFilters();
      renderSummary();
      syncUrl();
      loadDeployments();
    }

    // ---- filter controls ----
    els.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = els.search.value.trim(); reload(); }, 300);
    });
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(searchTimer); state.search = els.search.value.trim(); reload(); }
    });
    els.type.addEventListener('change', () => { state.typeId = els.type.value; reload(); });
    els.range.addEventListener('change', () => {
      state.range = els.range.value;
      els.customBox.hidden = state.range !== 'custom';
      if (state.range !== 'custom') { state.from = ''; state.to = ''; els.from.value = ''; els.to.value = ''; }
      reload();
    });
    els.from.addEventListener('change', () => { state.from = els.from.value; reload(); });
    els.to.addEventListener('change', () => { state.to = els.to.value; reload(); });
    els.sort.addEventListener('change', () => { state.sort = els.sort.value; reload(); });
    els.pageSize.addEventListener('change', () => { state.limit = Number(els.pageSize.value); reload(); });
    els.clear.addEventListener('click', () => {
      state.search = ''; state.typeId = ''; state.range = ''; state.from = ''; state.to = '';
      applyStateToControls();
      reload();
    });
    els.refresh.addEventListener('click', reload);
    els.prev.addEventListener('click', () => { if (pageIndex > 0) { pageIndex--; loadDeployments(); } });
    els.next.addEventListener('click', () => { if (cursors[pageIndex + 1]) { pageIndex++; loadDeployments(); } });

    // ---- detail drawer ----
    let drawerTrigger = null;
    let drawerSeq = 0;

    function copyButton(value, label) {
      const btn = el('button', 'admin-btn-outline admin-btn-sm', 'Copy');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Copy ' + label);
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(value);
          btn.textContent = 'Copied';
        } catch (_err) {
          btn.textContent = 'Copy failed';
        }
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      });
      return btn;
    }

    function detailGroup(label, ...content) {
      const group = el('div', 'admin-detail-group');
      group.appendChild(el('dt', null, label));
      const dd = el('dd');
      content.forEach((c) => dd.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
      group.appendChild(dd);
      return group;
    }

    function renderDrawer(d) {
      els.drawerTitle.textContent = d.websiteTypeName || 'Unknown website type';
      els.drawerStatus.hidden = false;
      els.drawerBody.textContent = '';
      const dl = el('dl', 'admin-detail-list');

      dl.appendChild(detailGroup('Payment reference', el('span', 'admin-detail-mono', d.reference)));
      dl.lastChild.querySelector('dd').appendChild(el('div', 'admin-drawer-actions')).appendChild(copyButton(d.reference, 'payment reference'));

      const customer = detailGroup('Customer', d.clientEmail);
      customer.querySelector('dd').appendChild(el('div', 'admin-drawer-actions')).appendChild(copyButton(d.clientEmail, 'customer email'));
      dl.appendChild(customer);

      const wt = detailGroup('Website type', d.websiteTypeName || 'Unknown (type no longer exists)');
      if (d.websiteTypeSlug) wt.querySelector('dd').appendChild(el('div', 'admin-detail-sub', '/build/' + d.websiteTypeSlug));
      dl.appendChild(wt);

      const pay = detailGroup('Payment', formatDeploymentAmount(d));
      if (d.chargeCurrency && d.chargeCurrency !== 'USD' && d.amountUsd !== null) {
        pay.querySelector('dd').appendChild(el('div', 'admin-detail-sub', '\u2248 ' + formatMoney(d.amountUsd) + ' USD'));
      }
      dl.appendChild(pay);

      const when = detailGroup('Deployed', new Date(d.deployedAt).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'medium' }));
      when.querySelector('dd').appendChild(el('div', 'admin-detail-sub', new Date(d.deployedAt).toISOString()));
      dl.appendChild(when);

      const url = safeHttpUrl(d.siteUrl);
      const site = detailGroup('Site', el('span', 'admin-detail-mono', d.siteUrl));
      if (d.deployedSlug) site.querySelector('dd').appendChild(el('div', 'admin-detail-sub', 'Slug: ' + d.deployedSlug));
      if (url) {
        const actions = el('div', 'admin-drawer-actions');
        const open = el('a', 'admin-btn admin-btn-sm', 'Open site');
        open.href = url; open.target = '_blank'; open.rel = 'noopener noreferrer';
        actions.append(open, copyButton(d.siteUrl, 'site URL'));
        site.querySelector('dd').appendChild(actions);
      }
      dl.appendChild(site);

      dl.appendChild(detailGroup('Access', d.hasPassword ? 'Password protected' : 'Public (no password)'));
      els.drawerBody.appendChild(dl);
    }

    function drawerMessage(text) {
      els.drawerTitle.textContent = 'Deployment';
      els.drawerStatus.hidden = true;
      els.drawerBody.textContent = '';
      els.drawerBody.appendChild(el('p', 'admin-detail-sub', text));
    }

    function focusables() {
      return Array.from(els.drawer.querySelectorAll('a[href], button:not([disabled])')).filter(n => !n.hidden);
    }
    function onDrawerKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); closeDrawer(); return; }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); els.drawer.focus(); return; }
      const first = items[0]; const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === els.drawer)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    async function openDrawer(reference, trigger) {
      const seq = ++drawerSeq;
      drawerRef = reference;
      drawerTrigger = trigger || drawerTrigger;
      els.drawer.hidden = false;
      els.overlay.hidden = false;
      document.body.classList.add('admin-drawer-open');
      requestAnimationFrame(() => { els.drawer.classList.add('is-open'); els.overlay.classList.add('is-open'); });
      document.addEventListener('keydown', onDrawerKey);
      els.drawerTitle.textContent = 'Loading\u2026';
      els.drawerStatus.hidden = true;
      els.drawerBody.textContent = '';
      els.drawerClose.focus();
      syncUrl();
      try {
        const res = await window.adminFetch(API + '/' + encodeURIComponent(reference));
        if (seq !== drawerSeq) return;
        if (res.status === 404) { drawerMessage('This deployment could not be found.'); return; }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (seq !== drawerSeq) return;
        renderDrawer(data.deployment);
      } catch (err) {
        if (seq === drawerSeq) drawerMessage('Could not load this deployment (' + err.message + ').');
      }
    }

    function closeDrawer() {
      if (els.drawer.hidden) return;
      drawerSeq++;
      drawerRef = null;
      els.drawer.classList.remove('is-open');
      els.overlay.classList.remove('is-open');
      document.body.classList.remove('admin-drawer-open');
      document.removeEventListener('keydown', onDrawerKey);
      syncUrl();
      const trigger = drawerTrigger;
      drawerTrigger = null;
      setTimeout(() => {
        if (drawerRef) return; // reopened during the close animation
        els.drawer.hidden = true;
        els.overlay.hidden = true;
        if (trigger && document.body.contains(trigger)) trigger.focus();
      }, 220);
    }

    els.body.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-ref]');
      if (!tr) return;
      openDrawer(tr.dataset.ref, tr.querySelector('.admin-row-link') || tr);
    });
    els.drawerClose.addEventListener('click', closeDrawer);
    els.overlay.addEventListener('click', closeDrawer);

    // ---- website-type filter options ----
    async function loadTypeFilter() {
      try {
        const res = await window.adminFetch(API + '/facets');
        if (!res.ok) return;
        const data = await res.json();
        data.websiteTypes.forEach((t) => {
          typeNames[String(t.id)] = t.name;
          const opt = el('option', null, t.name);
          opt.value = String(t.id);
          els.type.appendChild(opt);
        });
        els.type.value = state.typeId;
        renderActiveFilters();
      } catch (_err) { /* the filter simply stays at "All types" */ }
    }

    // ======================================================================
    // Subscribers (unchanged behaviour; still simple page/OFFSET paging,
    // which is fine for a list that grows far more slowly than deployments)
    // ======================================================================
    let subscribersPage = 1;
    let subscribersSearch = '';
    let subscribersTimer = null;

    async function loadSubscribers() {
      const url = '/api/admin/dashboard/subscribers?page=' + subscribersPage + '&search=' + encodeURIComponent(subscribersSearch);
      const res = await window.adminFetch(url);
      const data = await res.json();

      document.getElementById('subscribersTableBody').innerHTML = data.subscribers.map(s => `
        <tr>
          <td data-label="Email">${escapeHtml(s.email)}</td>
          <td data-label="First seen">${formatDate(s.firstSeenAt)}</td>
          <td data-label="Status"><span class="admin-badge ${s.optedOut ? 'admin-badge-error' : 'admin-badge-active'}">${s.optedOut ? 'opted out' : 'subscribed'}</span></td>
          <td data-label=""><button type="button" class="admin-btn-outline admin-btn-sm toggle-opt-out" data-email="${escapeHtml(s.email)}" data-opted-out="${s.optedOut}">${s.optedOut ? 'Re-subscribe' : 'Opt out'}</button></td>
        </tr>`).join('') || '<tr><td colspan="4" data-label="">No subscribers yet.</td></tr>';

      document.getElementById('subscribersPageInfo').textContent = `Page ${data.page} of ${data.totalPages} (${data.total} total)`;
      document.getElementById('subscribersPrev').disabled = data.page <= 1;
      document.getElementById('subscribersNext').disabled = data.page >= data.totalPages;

      document.querySelectorAll('.toggle-opt-out').forEach(btn => {
        btn.addEventListener('click', async () => {
          const email = btn.dataset.email;
          const currentlyOptedOut = btn.dataset.optedOut === 'true';
          const res = await window.adminFetch(`/api/admin/dashboard/subscribers/${encodeURIComponent(email)}/opt-out`, {
            method: 'PUT',
            body: JSON.stringify({ optedOut: !currentlyOptedOut })
          });
          if (res.ok) loadSubscribers();
        });
      });
    }

    document.getElementById('subscriberSearch').addEventListener('input', (e) => {
      clearTimeout(subscribersTimer);
      subscribersTimer = setTimeout(() => {
        subscribersSearch = e.target.value;
        subscribersPage = 1;
        loadSubscribers();
      }, 300);
    });
    document.getElementById('subscribersPrev').addEventListener('click', () => {
      if (subscribersPage > 1) { subscribersPage--; loadSubscribers(); }
    });
    document.getElementById('subscribersNext').addEventListener('click', () => {
      subscribersPage++; loadSubscribers();
    });

    // ---- boot ----
    const initialRef = readUrl();
    applyStateToControls();
    updateExportLink();
    renderActiveFilters();
    loadTypeFilter();
    loadDeployments();
    loadSubscribers();
    if (initialRef) openDrawer(initialRef, null);
  }

  // ---- recovery page (v1.1.0 Part A) ----
  function initRecoveryPage() {
    let page = 1;
    let search = '';
    let searchDebounceTimer = null;

    function formatDate(iso) {
      return new Date(iso).toLocaleString();
    }

    function formatAmount(r) {
      return r.chargeCurrency && r.chargeAmount !== null
        ? `${escapeHtml(r.chargeCurrency)} ${Number(r.chargeAmount).toFixed(2)}`
        : 'n/a';
    }

    function statusBadge(status) {
      return status === 'needs_attention'
        ? '<span class="admin-badge admin-badge-warn">Needs attention</span>'
        : '<span class="admin-badge admin-badge-active">Active</span>';
    }

    async function load() {
      const url = '/api/admin/pending-deployments?page=' + page + '&search=' + encodeURIComponent(search);
      const res = await window.adminFetch(url);
      const data = await res.json();

      document.getElementById('recoveryTableBody').innerHTML = data.pending.map(p => `
        <tr data-reference="${escapeHtml(p.reference)}">
          <td data-label="Reference" class="font-mono text-xs">${escapeHtml(p.reference)}</td>
          <td data-label="Client">${escapeHtml(p.clientEmail)}</td>
          <td data-label="Type">${escapeHtml(p.websiteTypeName || 'n/a')}</td>
          <td data-label="Amount">${formatAmount(p)}</td>
          <td data-label="Created">${formatDate(p.createdAt)}</td>
          <td data-label="Status">${statusBadge(p.status)}</td>
          <td data-label="">
            <div class="flex flex-col items-end gap-1.5">
              <div class="flex gap-2">
                <button type="button" class="admin-btn-outline admin-btn-sm retry-btn" data-reference="${escapeHtml(p.reference)}">Check &amp; Deploy</button>
                <button type="button" class="admin-btn-danger admin-btn-sm delete-btn" data-reference="${escapeHtml(p.reference)}">Delete</button>
              </div>
              <p class="retry-result text-xs" style="display:none;"></p>
            </div>
          </td>
        </tr>`).join('') || '<tr><td colspan="7" data-label="">No pending deployments.</td></tr>';

      document.getElementById('recoveryPageInfo').textContent = `Page ${data.page} of ${data.totalPages} (${data.total} total)`;
      document.getElementById('recoveryPrev').disabled = data.page <= 1;
      document.getElementById('recoveryNext').disabled = data.page >= data.totalPages;

      document.querySelectorAll('.retry-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const reference = btn.dataset.reference;
          const row = document.querySelector(`tr[data-reference="${CSS.escape(reference)}"]`);
          const resultEl = row.querySelector('.retry-result');
          btn.disabled = true;
          btn.textContent = 'Checking…';

          const res = await window.adminFetch(`/api/admin/pending-deployments/${encodeURIComponent(reference)}/retry`, { method: 'POST' });
          const data = await res.json();

          resultEl.style.display = 'block';
          if (data.outcome === 'deployed') {
            resultEl.className = 'retry-result text-xs text-success-600';
            resultEl.innerHTML = `Deployed: <a href="${escapeHtml(data.siteUrl)}" target="_blank" rel="noopener" class="underline">${escapeHtml(data.siteUrl)}</a>`;
            setTimeout(load, 1500);
          } else if (data.outcome === 'not_paid') {
            resultEl.className = 'retry-result text-xs text-warning-600';
            resultEl.textContent = 'Payment not verified. Nothing was changed.';
            btn.disabled = false;
            btn.textContent = 'Check & Deploy';
          } else if (data.outcome === 'not_found') {
            resultEl.className = 'retry-result text-xs text-warning-600';
            resultEl.textContent = 'This reference no longer exists.';
            btn.disabled = false;
            btn.textContent = 'Check & Deploy';
          } else {
            resultEl.className = 'retry-result text-xs text-error-600';
            resultEl.textContent = data.error || 'Something went wrong. Nothing was changed.';
            btn.disabled = false;
            btn.textContent = 'Check & Deploy';
          }
        });
      });

      document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const reference = btn.dataset.reference;
          if (!confirm(`Permanently delete this pending deployment (${reference})? This can't be undone.`)) return;
          const res = await window.adminFetch(`/api/admin/pending-deployments/${encodeURIComponent(reference)}`, { method: 'DELETE' });
          if (res.ok) load();
        });
      });
    }

    document.getElementById('recoverySearch').addEventListener('input', (e) => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        search = e.target.value;
        page = 1;
        load();
      }, 300);
    });
    document.getElementById('recoveryPrev').addEventListener('click', () => {
      if (page > 1) { page--; load(); }
    });
    document.getElementById('recoveryNext').addEventListener('click', () => {
      page++; load();
    });

    load();
  }

  // ---- funnel page (v1.1.0 Part B) ----
  function initFunnelPage() {
    const rangeSelect = document.getElementById('funnelRange');
    const typeSelect = document.getElementById('funnelTypeFilter');
    const typeNote = document.getElementById('funnelTypeNote');
    const chartEl = document.getElementById('funnelChart');
    const emptyEl = document.getElementById('funnelEmpty');

    async function loadTypes() {
      const res = await window.adminFetch('/api/admin/website-types');
      const data = await res.json();
      const types = Array.isArray(data) ? data : (data.websiteTypes || []);
      types.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        typeSelect.appendChild(opt);
      });
    }

    function renderChart(stages) {
      const maxCount = Math.max(1, ...stages.map(s => s.count));
      const totalCount = stages.reduce((sum, s) => sum + s.count, 0);

      if (totalCount === 0) {
        chartEl.innerHTML = '';
        emptyEl.style.display = 'block';
        return;
      }
      emptyEl.style.display = 'none';

      chartEl.innerHTML = stages.map(s => {
        const widthPct = Math.round((s.count / maxCount) * 100);
        // v1.1.0: page_view_home and page_view_explore are actually two
        // PARALLEL entry points into the site (a visitor can land directly
        // on /explore, or on a shared /build/:slug link, without ever
        // visiting /home first) rather than sequential funnel steps — so
        // the count can genuinely go UP from one to the next, producing a
        // negative "drop-off". That's real data, not a bug — shown as a
        // neutral "grew X%" rather than folded into "no drop-off", which
        // would silently hide that the two aren't strictly sequential.
        const dropOffHtml = s.dropOffPct === null
          ? ''
          : s.dropOffPct > 0
            ? `<span class="ml-2 text-xs font-medium text-error-500">↓ ${s.dropOffPct}% drop-off</span>`
            : s.dropOffPct < 0
              ? `<span class="ml-2 text-xs font-medium text-brand-500">↑ grew ${Math.abs(s.dropOffPct)}%</span>`
              : `<span class="ml-2 text-xs font-medium text-success-600">no drop-off</span>`;
        return `
          <div class="mb-4 last:mb-0">
            <div class="mb-1 flex items-baseline justify-between">
              <span class="text-sm font-medium text-hc-ink">${escapeHtml(s.label)}</span>
              <span class="text-sm text-gray-500">${s.count}${dropOffHtml}</span>
            </div>
            <div class="h-3 w-full overflow-hidden rounded-full bg-gray-100">
              <div class="h-full rounded-full bg-brand-500" style="width:${widthPct}%"></div>
            </div>
          </div>`;
      }).join('');
    }

    async function load() {
      const days = rangeSelect.value;
      const websiteTypeId = typeSelect.value;
      typeNote.style.display = websiteTypeId ? 'block' : 'none';

      let url = '/api/admin/funnel/stats?days=' + encodeURIComponent(days);
      if (websiteTypeId) url += '&websiteTypeId=' + encodeURIComponent(websiteTypeId);

      const res = await window.adminFetch(url);
      const data = await res.json();
      renderChart(data.stages);
    }

    rangeSelect.addEventListener('change', load);
    typeSelect.addEventListener('change', load);

    loadTypes().then(load);
  }

  // ---- site settings page (v1.0.7) ----
  function initSiteSettingsPage() {
    async function load() {
      const res = await window.adminFetch('/api/admin/site-settings');
      const data = await res.json();
      const form = document.getElementById('siteSettingsForm');
      Object.keys(data).forEach(key => {
        if (form[key]) form[key].value = data[key];
      });
      // v1.1.9 Part B: a checkbox, not a text input -- the generic loop
      // above sets .value for every other field, but a checkbox's checked
      // state isn't driven by .value, so this needs its own line rather
      // than being folded into that loop.
      form.show_type_prices_early.checked = data.show_type_prices_early === 'true';
    }

    document.getElementById('siteSettingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/site-settings', {
        method: 'PUT',
        body: JSON.stringify({
          manual_stats_number: form.manual_stats_number.value,
          manual_stats_label: form.manual_stats_label.value,
          site_title: form.site_title.value,
          meta_description: form.meta_description.value,
          favicon_url: form.favicon_url.value,
          og_image_url: form.og_image_url.value,
          // v1.1.6 Part D
          logo_url: form.logo_url.value,
          contact_email: form.contact_email.value,
          social_twitter_url: form.social_twitter_url.value,
          social_facebook_url: form.social_facebook_url.value,
          social_instagram_url: form.social_instagram_url.value,
          social_linkedin_url: form.social_linkedin_url.value,
          // v1.1.9 Part B: checkbox -> 'true'/'false' string, matching
          // this table's existing all-strings convention (see
          // routes/adminSiteSettings.js's updateSchema).
          show_type_prices_early: form.show_type_prices_early.checked ? 'true' : 'false'
        })
      });
      const statusEl = document.getElementById('siteSettingsStatus');
      statusEl.style.display = 'block';
      statusEl.className = 'admin-msg ' + (res.ok ? 'admin-msg-success' : 'admin-msg-error');
      statusEl.textContent = res.ok ? 'Saved.' : 'Failed to save.';
    });

    // v1.1.2 Part C: resend-details daily rate limit.
    async function loadResendDetailsRateLimit() {
      const res = await window.adminFetch('/api/admin/settings/resend-details-rate-limit');
      const data = await res.json();
      document.getElementById('resendDetailsRateLimit').value = data.value;
    }

    document.getElementById('saveResendDetailsRateLimitBtn').addEventListener('click', async () => {
      const value = Number(document.getElementById('resendDetailsRateLimit').value) || 1;
      const res = await window.adminFetch('/api/admin/settings/resend-details-rate-limit', {
        method: 'PUT',
        body: JSON.stringify({ value })
      });
      const statusEl = document.getElementById('resendDetailsRateLimitStatus');
      statusEl.style.display = 'block';
      statusEl.className = 'admin-msg ' + (res.ok ? 'admin-msg-success' : 'admin-msg-error');
      statusEl.textContent = res.ok ? 'Saved.' : 'Failed to save.';
    });

    // v1.2.2 Part F: footer custom links. Same shape as
    // initLandingPagePage()'s own footer-links list (renderFooterLinks/
    // moveFooterLink/removeFooterLink), against the separate
    // custom-links endpoints/table (see routes/adminSiteSettings.js and
    // lib/footerExtras.js's comment on why this is a separate list).
    async function loadCustomLinks() {
      const res = await window.adminFetch('/api/admin/site-settings/custom-links');
      const links = await res.json();
      renderCustomLinks(links);
    }

    function renderCustomLinks(links) {
      const list = document.getElementById('customLinksList');
      list.innerHTML = links.map((l, i) => `
        <div class="flex flex-col gap-2 rounded-md border border-gray-200 p-2.5 sm:flex-row sm:items-center sm:gap-3" data-id="${l.id}">
          <div class="flex shrink-0 flex-row gap-1 sm:flex-col">
            <button type="button" class="admin-btn-outline admin-btn-sm move-custom-link-up" data-id="${l.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="admin-btn-outline admin-btn-sm move-custom-link-down" data-id="${l.id}" ${i === links.length - 1 ? 'disabled' : ''}>↓</button>
          </div>
          <div class="min-w-0 flex-1 text-sm">
            <span class="font-medium text-hc-ink">${escapeHtml(l.label)}</span>
            <span class="ml-2 text-gray-400 break-all">${escapeHtml(l.url)}</span>
          </div>
          <button type="button" class="admin-btn-danger admin-btn-sm shrink-0 remove-custom-link" data-id="${l.id}">Remove</button>
        </div>`).join('') || '<p class="text-sm text-gray-400">No custom links yet.</p>';

      list.querySelectorAll('.move-custom-link-up').forEach(btn => btn.addEventListener('click', () => moveCustomLink(btn.dataset.id, 'up')));
      list.querySelectorAll('.move-custom-link-down').forEach(btn => btn.addEventListener('click', () => moveCustomLink(btn.dataset.id, 'down')));
      list.querySelectorAll('.remove-custom-link').forEach(btn => btn.addEventListener('click', () => removeCustomLink(btn.dataset.id)));
    }

    async function moveCustomLink(id, direction) {
      const res = await window.adminFetch(`/api/admin/site-settings/custom-links/${id}/move`, {
        method: 'PUT',
        body: JSON.stringify({ direction })
      });
      if (res.ok) loadCustomLinks();
    }

    async function removeCustomLink(id) {
      if (!confirm('Remove this footer link?')) return;
      const res = await window.adminFetch(`/api/admin/site-settings/custom-links/${id}`, { method: 'DELETE' });
      if (res.ok) loadCustomLinks();
    }

    document.getElementById('addCustomLinkForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/site-settings/custom-links', {
        method: 'POST',
        body: JSON.stringify({ label: form.label.value, url: form.url.value })
      });
      if (res.ok) {
        form.reset();
        loadCustomLinks();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add custom link.');
      }
    });

    load();
    loadResendDetailsRateLimit();
    loadCustomLinks();
  }

  // ---- script injection manager page (v1.0.7) ----
  function initScriptsPage() {
    const CONTAINER_IDS = { head: 'headScripts', body_start: 'bodyStartScripts', footer: 'footerScripts' };
    const COUNT_IDS = { head: 'headCount', body_start: 'bodyStartCount', footer: 'footerCount' };

    async function load() {
      const res = await window.adminFetch('/api/admin/scripts');
      const data = await res.json();
      ['head', 'body_start', 'footer'].forEach(placement => renderPlacement(placement, data[placement] || []));
    }

    function renderPlacement(placement, scripts) {
      document.getElementById(COUNT_IDS[placement]).textContent = `${scripts.length} / 3`;
      const container = document.getElementById(CONTAINER_IDS[placement]);
      container.innerHTML = scripts.map(s => `
        <div class="admin-card mt-3">
          <div class="flex flex-wrap items-center gap-2">
            <strong class="text-sm text-hc-ink">${escapeHtml(s.name)}</strong>
            ${s.isActive ? '<span class="admin-badge admin-badge-active">Active</span>' : '<span class="admin-badge admin-badge-error">Inactive</span>'}
          </div>
          <pre class="mt-2 whitespace-pre-wrap break-all rounded-md bg-gray-50 p-2 font-mono text-xs">${truncatedHtml(s.scriptContent)}</pre>
          <div class="mt-3 flex flex-wrap gap-2">
            <button type="button" class="admin-btn-outline admin-btn-sm toggle-script" data-id="${s.id}" data-active="${s.isActive}">${s.isActive ? 'Deactivate' : 'Activate'}</button>
            <button type="button" class="admin-btn-danger admin-btn-sm remove-script" data-id="${s.id}">Remove</button>
          </div>
        </div>`).join('') || '<p class="mt-2 text-sm text-gray-400">No scripts in this section yet.</p>';

      container.querySelectorAll('.toggle-script').forEach(btn => {
        btn.addEventListener('click', async () => {
          const isActive = btn.dataset.active === 'true';
          const res = await window.adminFetch(`/api/admin/scripts/${btn.dataset.id}`, {
            method: 'PUT',
            body: JSON.stringify({ isActive: !isActive })
          });
          if (res.ok) load();
        });
      });
      container.querySelectorAll('.remove-script').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this script? This can\'t be undone.')) return;
          const res = await window.adminFetch(`/api/admin/scripts/${btn.dataset.id}`, { method: 'DELETE' });
          if (res.ok) load();
        });
      });
    }

    document.getElementById('addScriptForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/scripts', {
        method: 'POST',
        body: JSON.stringify({
          placement: form.placement.value,
          name: form.name.value,
          scriptContent: form.scriptContent.value,
          isActive: form.isActive.checked
        })
      });
      const statusEl = document.getElementById('addScriptStatus');
      statusEl.style.display = 'block';
      if (res.ok) {
        statusEl.className = 'admin-msg admin-msg-success';
        statusEl.textContent = 'Script added.';
        form.reset();
        load();
      } else {
        const data = await res.json();
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.textContent = data.error || 'Failed to add script.';
      }
    });

    load();
  }

  // ---- landing page CMS (v1.0.8 Part C) ----
  // v1.1.3: trimmed to footer-only — hero text and steps used to live
  // here too, but nothing reads landing_content's hero_headline/
  // hero_tagline/hero_cta_text/trust_line_text or landing_steps anymore
  // now that the homepage renders from landing_sections instead (see
  // db/init.js's v1.1.3 migration comment). footerText and footer links
  // are still real: views/partials/public-footer.ejs (/explore) reads
  // both. routes/adminLanding.js's now-unreachable hero/step endpoints
  // are left as-is server-side — see this version's delivery notes for
  // why removing them too felt like unnecessary extra surface area for a
  // vestigial-but-harmless capability.
  function initLandingPagePage() {
    async function load() {
      const res = await window.adminFetch('/api/admin/landing');
      const data = await res.json();
      document.getElementById('contentForm').footerText.value = data.content.footerText;
      renderFooterLinks(data.footerLinks);
    }

    document.getElementById('contentForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/landing/content', {
        method: 'PUT',
        body: JSON.stringify({ footerText: form.footerText.value })
      });
      const statusEl = document.getElementById('contentStatus');
      statusEl.style.display = 'block';
      statusEl.className = 'admin-msg ' + (res.ok ? 'admin-msg-success' : 'admin-msg-error');
      statusEl.textContent = res.ok ? 'Saved.' : 'Failed to save.';
    });

    // ---- footer links ----
    function renderFooterLinks(links) {
      const list = document.getElementById('footerLinksList');
      list.innerHTML = links.map((l, i) => `
        <div class="flex flex-col gap-2 rounded-md border border-gray-200 p-2.5 sm:flex-row sm:items-center sm:gap-3" data-id="${l.id}">
          <div class="flex shrink-0 flex-row gap-1 sm:flex-col">
            <button type="button" class="admin-btn-outline admin-btn-sm move-up" data-id="${l.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="admin-btn-outline admin-btn-sm move-down" data-id="${l.id}" ${i === links.length - 1 ? 'disabled' : ''}>↓</button>
          </div>
          <div class="min-w-0 flex-1 text-sm">
            <span class="font-medium text-hc-ink">${escapeHtml(l.label)}</span>
            <span class="ml-2 text-gray-400">${escapeHtml(l.url)}</span>
          </div>
          <button type="button" class="admin-btn-danger admin-btn-sm shrink-0 remove-footer-link" data-id="${l.id}">Remove</button>
        </div>`).join('') || '<p class="text-sm text-gray-400">No footer links yet.</p>';

      list.querySelectorAll('.move-up').forEach(btn => btn.addEventListener('click', () => moveFooterLink(btn.dataset.id, 'up')));
      list.querySelectorAll('.move-down').forEach(btn => btn.addEventListener('click', () => moveFooterLink(btn.dataset.id, 'down')));
      list.querySelectorAll('.remove-footer-link').forEach(btn => btn.addEventListener('click', () => removeFooterLink(btn.dataset.id)));
    }

    async function moveFooterLink(id, direction) {
      const res = await window.adminFetch(`/api/admin/landing/footer-links/${id}/move`, {
        method: 'PUT',
        body: JSON.stringify({ direction })
      });
      if (res.ok) load();
    }

    async function removeFooterLink(id) {
      if (!confirm('Remove this footer link?')) return;
      const res = await window.adminFetch(`/api/admin/landing/footer-links/${id}`, { method: 'DELETE' });
      if (res.ok) load();
    }

    document.getElementById('addFooterLinkForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/landing/footer-links', {
        method: 'POST',
        body: JSON.stringify({ label: form.label.value, url: form.url.value })
      });
      if (res.ok) {
        form.reset();
        load();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add footer link.');
      }
    });

    load();
  }

  /**
   * v1.1.3: Landing Sections admin page. Unlike every other admin list
   * page in this file, one section's "edit form" has a genuinely
   * different shape depending on section_type — rather than 7 near-
   * duplicate hand-written forms, each type gets a small
   * render+collect function pair (renderXForm/collectXForm) sharing one
   * repeatable-row convention: an array field's container carries
   * data-array="fieldName", each row inside it carries data-row, and each
   * input/select/textarea inside a row carries data-field="subFieldName"
   * — collectXForm() walks the DOM to rebuild the array on save rather
   * than tracking state in JS alongside it, so there's exactly one
   * source of truth (the form itself) at save time.
   *
   * image_asset_key (wherever a type has one) is deliberately never
   * rendered as an input anywhere below — see
   * lib/landingSectionTypes.js's preserveImageAssetKeys() comment. The
   * server strips/overwrites it regardless, but not exposing a control
   * for it here avoids implying it's editable at all.
   */
  function initLandingSectionsPage() {
    const config = JSON.parse(document.getElementById('landingSectionsConfigData').textContent);
    const listEl = document.getElementById('sectionsList');
    let sections = [];

    function iconOptionsHtml(selected) {
      return config.iconNames.map(name => `<option value="${escapeHtml(name)}" ${name === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
    }
    function colorOptionsHtml(selected) {
      return config.accentColors.map(c => `<option value="${escapeHtml(c)}" ${c === selected ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('');
    }
    function textField(label, name, value) {
      return `<label class="admin-label">${label}</label>
        <input class="admin-input" type="text" data-field="${name}" value="${escapeHtml(value || '')}">`;
    }
    function textareaField(label, name, value) {
      return `<label class="admin-label">${label}</label>
        <textarea class="admin-textarea" data-field="${name}">${escapeHtml(value || '')}</textarea>`;
    }
    function readField(panel, name) {
      const el = panel.querySelector(`[data-field="${name}"]`);
      return el ? el.value.trim() : '';
    }
    function readRows(panel, arrayName) {
      const container = panel.querySelector(`[data-array="${arrayName}"]`);
      if (!container) return [];
      return Array.from(container.querySelectorAll(':scope > [data-row]')).map(row => {
        const obj = {};
        row.querySelectorAll('[data-field]').forEach(el => { obj[el.dataset.field] = el.value.trim(); });
        return obj;
      });
    }
    // Row add/remove wiring for all array fields happens later via
    // wirePanelRows() below, which also handles nesting (footer's
    // link_columns rows each need their own inner "add link" wiring) —
    // see that function's comment.

    // ---- summary text for the collapsed card ----
    function summaryFor(section) {
      const c = section.content || {};
      if (section.sectionType === 'hero') return c.headline || '';
      if (section.sectionType === 'feature_cards') return `${c.heading || ''} (${(c.cards || []).length} card(s))`;
      if (section.sectionType === 'split_image_text') return c.heading || '';
      if (section.sectionType === 'cta_image_cards') return `${c.heading || ''} (${(c.cards || []).length} card(s))`;
      if (section.sectionType === 'bullet_list') return `${c.heading || ''} (${(c.items || []).length} item(s))`;
      if (section.sectionType === 'testimonials') return `${c.heading || ''} (${(c.items || []).length} testimonial(s))`;
      if (section.sectionType === 'footer') return `${(c.link_columns || []).length} link column(s)`;
      if (section.sectionType === 'category_teaser') return c.heading || '';
      if (section.sectionType === 'faq') return c.heading || '';
      if (section.sectionType === 'related_pages') return `${c.heading || ''} (${(c.links || []).length} link(s))`;
      return '';
    }

    // ---- hero ----
    function renderHeroForm(c) {
      return `
        ${textField('Headline', 'headline', c.headline)}
        ${textField('Highlighted word (must match a word/phrase in the headline exactly)', 'highlighted_word', c.highlighted_word)}
        ${textareaField('Tagline', 'tagline', c.tagline)}
        ${textField('Primary button text', 'primary_cta_text', c.primary_cta_text)}
        ${textField('Primary button link', 'primary_cta_url', c.primary_cta_url)}
        ${textField('Secondary button text (optional)', 'secondary_cta_text', c.secondary_cta_text)}
        ${textField('Secondary button link', 'secondary_cta_url', c.secondary_cta_url)}`;
    }
    function collectHeroForm(panel) {
      return {
        headline: readField(panel, 'headline'),
        highlighted_word: readField(panel, 'highlighted_word'),
        tagline: readField(panel, 'tagline'),
        primary_cta_text: readField(panel, 'primary_cta_text'),
        primary_cta_url: readField(panel, 'primary_cta_url'),
        secondary_cta_text: readField(panel, 'secondary_cta_text'),
        secondary_cta_url: readField(panel, 'secondary_cta_url')
      };
    }

    // ---- category_teaser (v1.1.5 Part B) ----
    // Deliberately the smallest form here — just the copy around the
    // cards. The cards themselves show live category/website-type data
    // (which categories exist, which type is cheapest in each), never
    // admin-authored JSON, so there's nothing to edit for them here — see
    // lib/landingSectionTypes.js's comment on categoryTeaserSchema.
    function renderCategoryTeaserForm(c) {
      return `
        ${textField('Eyebrow text (optional)', 'eyebrow_text', c.eyebrow_text)}
        ${textField('Heading', 'heading', c.heading)}
        ${textField('Highlighted word (must match a word/phrase in the heading exactly)', 'highlighted_word', c.highlighted_word)}
        <p class="mt-2 text-xs text-gray-500">
          The cards below this heading show your first 2 active Website Categories automatically (or, if you haven't set any up yet, your first 2 active website types instead). Manage which ones from the Categories page, not here.
        </p>`;
    }
    function collectCategoryTeaserForm(panel) {
      return {
        eyebrow_text: readField(panel, 'eyebrow_text'),
        heading: readField(panel, 'heading'),
        highlighted_word: readField(panel, 'highlighted_word')
      };
    }

    // ---- faq (v1.1.6 Part D) ----
    // Same shape as category_teaser above, for the same reason: the
    // actual questions live on their own dedicated FAQ admin page (see
    // lib/landingSectionTypes.js's faqSchema comment), so this form is
    // just the copy around them.
    function renderFaqForm(c) {
      return `
        ${textField('Eyebrow text (optional)', 'eyebrow_text', c.eyebrow_text)}
        ${textField('Heading', 'heading', c.heading)}
        ${textField('Highlighted word (must match a word/phrase in the heading exactly)', 'highlighted_word', c.highlighted_word)}
        <p class="mt-2 text-xs text-gray-500">
          The questions themselves are managed on the <a href="/${config.adminSlug || ''}/faq" class="text-brand-500">FAQ page</a>, not here.
        </p>`;
    }
    function collectFaqForm(panel) {
      return {
        eyebrow_text: readField(panel, 'eyebrow_text'),
        heading: readField(panel, 'heading'),
        highlighted_word: readField(panel, 'highlighted_word')
      };
    }

    // ---- related_pages (v1.2.0) ----
    // Reuses footerLinkRowHtml's exact { label, url } row shape below (see
    // wirePanelRows' TOP_LEVEL_ARRAY_BY_TYPE entry) rather than a new
    // near-identical row renderer — the two are structurally identical
    // (plain label+url pairs), just used in different sections.
    function renderRelatedPagesForm(c) {
      return `
        ${textField('Heading', 'heading', c.heading)}
        <p class="admin-label">Links</p>
        <div data-array="links">${(c.links || []).map(footerLinkRowHtml).join('')}</div>
        <button type="button" class="admin-btn-outline admin-btn-sm mt-2" data-add-links>Add link</button>
        <p class="mt-2 text-xs text-gray-500">
          Link to another SEO page (e.g. /thank-you-website), a website type's build page (/build/portfolio), /explore, or any external URL.
        </p>`;
    }
    function collectRelatedPagesForm(panel) {
      return {
        heading: readField(panel, 'heading'),
        links: readRows(panel, 'links')
      };
    }

    // ---- feature_cards ----
    function featureCardRowHtml(card) {
      card = card || {};
      return `<div class="admin-subitem mt-3 border-t border-gray-100 pt-3" data-row>
        <label class="admin-label">Icon</label>
        <select class="admin-select" data-field="icon_name">${iconOptionsHtml(card.icon_name)}</select>
        <label class="admin-label">Icon color</label>
        <select class="admin-select" data-field="icon_color">${colorOptionsHtml(card.icon_color)}</select>
        ${textField('Title', 'title', card.title)}
        ${textareaField('Description', 'description', card.description)}
        <button type="button" class="admin-btn-danger admin-btn-sm mt-2" data-remove-row>Remove card</button>
      </div>`;
    }
    function renderFeatureCardsForm(c) {
      return `
        ${textField('Heading', 'heading', c.heading)}
        ${textField('Highlighted word', 'highlighted_word', c.highlighted_word)}
        <p class="admin-label">Cards</p>
        <div data-array="cards">${(c.cards || []).map(featureCardRowHtml).join('')}</div>
        <button type="button" class="admin-btn-outline admin-btn-sm mt-2" data-add-cards>Add card</button>`;
    }
    function collectFeatureCardsForm(panel) {
      return { heading: readField(panel, 'heading'), highlighted_word: readField(panel, 'highlighted_word'), cards: readRows(panel, 'cards') };
    }

    // ---- split_image_text ----
    function renderSplitImageTextForm(c) {
      return `
        ${textField('Heading', 'heading', c.heading)}
        ${textField('Highlighted word', 'highlighted_word', c.highlighted_word)}
        ${textareaField('Body text', 'body_text', c.body_text)}
        <label class="admin-label">Image side</label>
        <select class="admin-select" data-field="image_side">
          <option value="left" ${c.image_side === 'left' ? 'selected' : ''}>Left</option>
          <option value="right" ${c.image_side === 'right' ? 'selected' : ''}>Right</option>
        </select>
        <label class="admin-label">Accent color</label>
        <select class="admin-select" data-field="decorative_accent_color">${colorOptionsHtml(c.decorative_accent_color)}</select>
        ${textField('Button text (optional)', 'cta_text', c.cta_text)}
        ${textField('Button link', 'cta_url', c.cta_url)}
        <p class="mt-2 text-xs text-gray-400">Image: ${escapeHtml(c.image_asset_key || 'none, fixed, not editable here')}</p>`;
    }
    function collectSplitImageTextForm(panel) {
      return {
        heading: readField(panel, 'heading'),
        highlighted_word: readField(panel, 'highlighted_word'),
        body_text: readField(panel, 'body_text'),
        image_side: readField(panel, 'image_side'),
        decorative_accent_color: readField(panel, 'decorative_accent_color'),
        cta_text: readField(panel, 'cta_text'),
        cta_url: readField(panel, 'cta_url')
      };
    }

    // ---- cta_image_cards ----
    function ctaCardRowHtml(card) {
      card = card || {};
      return `<div class="admin-subitem mt-3 border-t border-gray-100 pt-3" data-row>
        ${textField('Overlay label', 'overlay_label', card.overlay_label)}
        ${textField('Button text', 'button_text', card.button_text)}
        ${textField('Button link', 'button_url', card.button_url)}
        <p class="mt-1 text-xs text-gray-400">Image: ${escapeHtml(card.image_asset_key || 'none, fixed, not editable here')}</p>
        <button type="button" class="admin-btn-danger admin-btn-sm mt-2" data-remove-row>Remove card</button>
      </div>`;
    }
    function renderCtaImageCardsForm(c) {
      return `
        ${textField('Heading', 'heading', c.heading)}
        <p class="admin-label">Cards</p>
        <div data-array="cards">${(c.cards || []).map(ctaCardRowHtml).join('')}</div>
        <button type="button" class="admin-btn-outline admin-btn-sm mt-2" data-add-cards>Add card</button>`;
    }
    function collectCtaImageCardsForm(panel) {
      return { heading: readField(panel, 'heading'), cards: readRows(panel, 'cards') };
    }

    // ---- bullet_list ----
    function bulletItemRowHtml(item) {
      item = item || {};
      return `<div class="admin-subitem mt-3 border-t border-gray-100 pt-3" data-row>
        <label class="admin-label">Icon color</label>
        <select class="admin-select" data-field="icon_color">${colorOptionsHtml(item.icon_color)}</select>
        ${textField('Text', 'text', item.text)}
        <button type="button" class="admin-btn-danger admin-btn-sm mt-2" data-remove-row>Remove item</button>
      </div>`;
    }
    function renderBulletListForm(c) {
      return `
        ${textField('Heading', 'heading', c.heading)}
        ${textField('Highlighted word', 'highlighted_word', c.highlighted_word)}
        ${textareaField('Body text', 'body_text', c.body_text)}
        <p class="admin-label">Checklist items</p>
        <div data-array="items">${(c.items || []).map(bulletItemRowHtml).join('')}</div>
        <button type="button" class="admin-btn-outline admin-btn-sm mt-2" data-add-items>Add item</button>
        <p class="mt-2 text-xs text-gray-400">Image: ${escapeHtml(c.image_asset_key || 'none, fixed, not editable here')}</p>`;
    }
    function collectBulletListForm(panel) {
      return {
        heading: readField(panel, 'heading'),
        highlighted_word: readField(panel, 'highlighted_word'),
        body_text: readField(panel, 'body_text'),
        items: readRows(panel, 'items')
      };
    }

    // ---- testimonials ----
    function testimonialRowHtml(item) {
      item = item || {};
      return `<div class="admin-subitem mt-3 border-t border-gray-100 pt-3" data-row>
        ${textareaField('Quote', 'quote', item.quote)}
        ${textField('Author name', 'author_name', item.author_name)}
        ${textField('Author role (optional)', 'author_role', item.author_role)}
        <button type="button" class="admin-btn-danger admin-btn-sm mt-2" data-remove-row>Remove testimonial</button>
      </div>`;
    }
    function renderTestimonialsForm(c) {
      return `
        ${textField('Heading', 'heading', c.heading)}
        ${textField('Eyebrow text', 'eyebrow_text', c.eyebrow_text)}
        <p class="admin-label">Testimonials (section shows nothing on the live page until at least one exists)</p>
        <div data-array="items">${(c.items || []).map(testimonialRowHtml).join('')}</div>
        <button type="button" class="admin-btn-outline admin-btn-sm mt-2" data-add-items>Add testimonial</button>`;
    }
    function collectTestimonialsForm(panel) {
      return { heading: readField(panel, 'heading'), eyebrow_text: readField(panel, 'eyebrow_text'), items: readRows(panel, 'items') };
    }

    // ---- footer (the one doubly-nested type: link_columns[].links[]) ----
    function footerLinkRowHtml(link) {
      link = link || {};
      return `<div class="mt-2 flex gap-2" data-row>
        <input class="admin-input" type="text" data-field="label" placeholder="Label" value="${escapeHtml(link.label || '')}">
        <input class="admin-input" type="text" data-field="url" placeholder="URL" value="${escapeHtml(link.url || '')}">
        <button type="button" class="admin-btn-danger admin-btn-sm" data-remove-row>&times;</button>
      </div>`;
    }
    function footerColumnRowHtml(column) {
      column = column || {};
      const links = column.links || [];
      return `<div class="admin-subitem mt-3 border-t border-gray-100 pt-3" data-row>
        ${textField('Column heading', 'heading', column.heading)}
        <p class="admin-label">Links</p>
        <div data-array="links">${links.map(footerLinkRowHtml).join('')}</div>
        <button type="button" class="admin-btn-outline admin-btn-sm mt-2" data-add-links>Add link</button>
        <button type="button" class="admin-btn-danger admin-btn-sm mt-2 ml-2" data-remove-row>Remove column</button>
      </div>`;
    }
    function renderFooterForm(c) {
      return `
        ${textareaField('Bottom copyright line (shown at the very bottom of the footer, leave blank to fall back to a computed © line)', 'tagline', c.tagline)}
        <p class="admin-label">Link columns</p>
        <div data-array="link_columns">${(c.link_columns || []).map(footerColumnRowHtml).join('')}</div>
        <button type="button" class="admin-btn-outline admin-btn-sm mt-2" data-add-link_columns>Add column</button>`;
    }
    // footer's collect can't use the generic readRows() (which only reads
    // one flat level) — link_columns rows each contain their OWN nested
    // "links" array, so each column row is read individually here instead.
    function collectFooterForm(panel) {
      const columnsContainer = panel.querySelector('[data-array="link_columns"]');
      const columns = Array.from(columnsContainer.querySelectorAll(':scope > [data-row]')).map(colRow => {
        const heading = colRow.querySelector('[data-field="heading"]').value.trim();
        const linksContainer = colRow.querySelector('[data-array="links"]');
        const links = Array.from(linksContainer.querySelectorAll(':scope > [data-row]')).map(linkRow => ({
          label: linkRow.querySelector('[data-field="label"]').value.trim(),
          url: linkRow.querySelector('[data-field="url"]').value.trim()
        }));
        return { heading, links };
      });
      return { tagline: readField(panel, 'tagline'), link_columns: columns };
    }

    // Wires an array field's "Add row" button and every row's own
    // "Remove" button, scoped to `containerEl` specifically (not the
    // whole panel) — this is what makes footer's per-column nested
    // "links" arrays safe to wire individually below: there can be
    // several `[data-array="links"]` containers in one footer panel (one
    // per column), and scoping strictly to the one actually passed in
    // means each gets exactly its own listener, never a panel-wide
    // querySelector that would only ever find the first one.
    //
    // Takes a live reference to the just-inserted row (rather than using
    // insertAdjacentHTML, which returns nothing) so a nested array inside
    // that row — footer's links-within-a-column being the one case that
    // needs this — can be wired immediately via `onRowAdded`, exactly
    // once, with no need to ever re-wire anything else already on the
    // page. That "exactly once per row, at the moment it's created"
    // property is the actual fix for the duplicate-listener bug an
    // earlier version of this function had (it re-ran itself over the
    // whole panel on every "Add column" click, re-attaching a fresh
    // listener to every column already on the page each time).
    function wireArrayField(panel, containerEl, arrayName, rowHtmlFn, onRowAdded) {
      const addBtn = panel.querySelector(`[data-add-${arrayName}]`);
      if (addBtn) {
        addBtn.addEventListener('click', () => {
          const temp = document.createElement('div');
          temp.innerHTML = rowHtmlFn({}).trim();
          const newRow = temp.firstElementChild;
          containerEl.appendChild(newRow);
          if (onRowAdded) onRowAdded(newRow);
        });
      }
      containerEl.addEventListener('click', (e) => {
        const removeBtn = e.target.closest('[data-remove-row]');
        if (removeBtn && removeBtn.closest(`[data-array="${arrayName}"]`) === containerEl) {
          // Stops a "remove link" click (inside a footer column's nested
          // links array) from also bubbling up into the outer
          // link_columns container's own delegated listener — both would
          // otherwise independently call .remove() on the same row.
          // Harmless either way (Element.remove() on an already-detached
          // node is a no-op), but there's no reason to let it happen.
          e.stopPropagation();
          removeBtn.closest('[data-row]').remove();
        }
      });
    }

    // One footer column row's OWN nested "links" array — called once per
    // row, whether that row came from the server-rendered initial content
    // (wirePanelRows below) or was just added by clicking "Add column"
    // (wireArrayField's onRowAdded above).
    function wireColumnLinks(columnRow) {
      const linksContainer = columnRow.querySelector('[data-array="links"]');
      wireArrayField(columnRow, linksContainer, 'links', footerLinkRowHtml);
    }

    const TYPE_HANDLERS = {
      hero: { render: renderHeroForm, collect: collectHeroForm },
      feature_cards: { render: renderFeatureCardsForm, collect: collectFeatureCardsForm },
      split_image_text: { render: renderSplitImageTextForm, collect: collectSplitImageTextForm },
      cta_image_cards: { render: renderCtaImageCardsForm, collect: collectCtaImageCardsForm },
      bullet_list: { render: renderBulletListForm, collect: collectBulletListForm },
      testimonials: { render: renderTestimonialsForm, collect: collectTestimonialsForm },
      footer: { render: renderFooterForm, collect: collectFooterForm },
      category_teaser: { render: renderCategoryTeaserForm, collect: collectCategoryTeaserForm },
      faq: { render: renderFaqForm, collect: collectFaqForm },
      related_pages: { render: renderRelatedPagesForm, collect: collectRelatedPagesForm }
    };

    // Wires whichever single top-level array field a section's form has
    // (at most one, for every type except footer — see the `link_columns`
    // branch, which additionally wires each existing column's own nested
    // links array exactly once).
    function wirePanelRows(panel, sectionType) {
      const TOP_LEVEL_ARRAY_BY_TYPE = {
        feature_cards: { name: 'cards', rowHtmlFn: featureCardRowHtml },
        cta_image_cards: { name: 'cards', rowHtmlFn: ctaCardRowHtml },
        bullet_list: { name: 'items', rowHtmlFn: bulletItemRowHtml },
        testimonials: { name: 'items', rowHtmlFn: testimonialRowHtml },
        footer: { name: 'link_columns', rowHtmlFn: footerColumnRowHtml },
        related_pages: { name: 'links', rowHtmlFn: footerLinkRowHtml }
      };
      const arrayField = TOP_LEVEL_ARRAY_BY_TYPE[sectionType];
      if (!arrayField) return; // hero / split_image_text have no array field at all

      const containerEl = panel.querySelector(`[data-array="${arrayField.name}"]`);
      const onRowAdded = sectionType === 'footer' ? wireColumnLinks : undefined;
      wireArrayField(panel, containerEl, arrayField.name, arrayField.rowHtmlFn, onRowAdded);

      if (sectionType === 'footer') {
        // Every column already present in the server-rendered content
        // needs its own links-array wiring too — onRowAdded above only
        // covers columns added AFTER this initial wiring pass.
        containerEl.querySelectorAll(':scope > [data-row]').forEach(wireColumnLinks);
      }
    }

    function renderCard(section) {
      const handlers = TYPE_HANDLERS[section.sectionType];
      const wrap = document.createElement('div');
      wrap.className = 'admin-card';
      wrap.dataset.sectionId = section.id;
      wrap.innerHTML = `
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <span class="admin-badge admin-badge-brand">${escapeHtml(section.sectionType)}</span>
            <span class="admin-badge ${section.isActive ? 'admin-badge-active' : 'admin-badge-error'}">${section.isActive ? 'Active' : 'Inactive'}</span>
          </div>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="admin-btn-outline admin-btn-sm move-up">↑</button>
            <button type="button" class="admin-btn-outline admin-btn-sm move-down">↓</button>
            <button type="button" class="admin-btn-outline admin-btn-sm toggle-active">${section.isActive ? 'Deactivate' : 'Activate'}</button>
            <button type="button" class="admin-btn-outline admin-btn-sm toggle-edit">Edit</button>
            <button type="button" class="admin-btn-danger admin-btn-sm delete-section">Delete</button>
          </div>
        </div>
        <p class="mt-2 text-sm text-gray-500 break-words">${escapeHtml(summaryFor(section))}</p>
        <form class="edit-panel mt-4" style="display:none;">
          ${handlers ? handlers.render(section.content || {}) : '<p class="text-sm text-error-600">Unknown section type.</p>'}
          <p class="save-status admin-msg" style="display:none;"></p>
          <button type="submit" class="admin-btn mt-3">Save</button>
        </form>`;

      const panel = wrap.querySelector('.edit-panel');
      if (handlers) wirePanelRows(panel, section.sectionType);

      wrap.querySelector('.toggle-edit').addEventListener('click', () => {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
      wrap.querySelector('.move-up').addEventListener('click', () => moveSection(section.id, 'up'));
      wrap.querySelector('.move-down').addEventListener('click', () => moveSection(section.id, 'down'));
      wrap.querySelector('.toggle-active').addEventListener('click', () => toggleActive(section.id, !section.isActive));
      wrap.querySelector('.delete-section').addEventListener('click', () => deleteSection(section.id));

      panel.addEventListener('submit', async (e) => {
        e.preventDefault();
        const statusEl = panel.querySelector('.save-status');
        const content = handlers.collect(panel);
        const res = await window.adminFetch(`/api/admin/landing-sections/${section.id}/content`, {
          method: 'PUT',
          body: JSON.stringify({ content })
        });
        const data = await res.json();
        statusEl.style.display = 'block';
        if (!res.ok) {
          statusEl.className = 'save-status admin-msg admin-msg-error';
          statusEl.textContent = data.error || 'Failed to save.';
          return;
        }
        statusEl.className = 'save-status admin-msg admin-msg-success';
        statusEl.textContent = 'Saved.';
        load();
      });

      return wrap;
    }

    // v1.2.0: which page's sections this whole panel is currently showing
    // -- driven by the #pageSelector <select> added to this page's view.
    // Every other function above (renderCard's save/move/toggle/delete
    // handlers) operates on a section by its own global id and needs no
    // awareness of this at all; only load() (which page to fetch) and the
    // "Add section" handler (which page a new section belongs to) do.
    let currentPageSlug = 'home';

    async function load() {
      const res = await window.adminFetch(`/api/admin/landing-sections?page=${encodeURIComponent(currentPageSlug)}`);
      const data = await res.json();
      sections = data.sections;
      listEl.innerHTML = '';
      if (sections.length === 0) {
        listEl.innerHTML = '<p class="text-sm text-gray-500">No sections yet. Add one above.</p>';
        return;
      }
      sections.forEach(section => listEl.appendChild(renderCard(section)));
    }

    async function moveSection(id, direction) {
      const res = await window.adminFetch(`/api/admin/landing-sections/${id}/move`, {
        method: 'PUT',
        body: JSON.stringify({ direction })
      });
      if (res.ok) load();
    }
    async function toggleActive(id, isActive) {
      const res = await window.adminFetch(`/api/admin/landing-sections/${id}/active`, {
        method: 'PUT',
        body: JSON.stringify({ isActive })
      });
      if (res.ok) load();
    }
    async function deleteSection(id) {
      if (!confirm('Delete this section? This cannot be undone.')) return;
      const res = await window.adminFetch(`/api/admin/landing-sections/${id}`, { method: 'DELETE' });
      if (res.ok) load();
    }

    document.getElementById('addSectionForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const sectionType = document.getElementById('newSectionType').value;
      const res = await window.adminFetch('/api/admin/landing-sections', {
        method: 'POST',
        body: JSON.stringify({ sectionType, pageSlug: currentPageSlug })
      });
      if (res.ok) {
        load();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add section.');
      }
    });

    document.getElementById('pageSelector').addEventListener('change', (e) => {
      currentPageSlug = e.target.value;
      load();
    });

    load();
  }

  // ---- categories page (v1.1.4 Part D) ----
  function initCategoriesPage() {
    let editingId = null;

    function render(categories) {
      const list = document.getElementById('categoriesList');
      list.innerHTML = categories.map((c, i) => `
        <div class="admin-card" data-id="${c.id}">
          <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
            <div class="flex shrink-0 flex-row gap-1 sm:flex-col">
              <button type="button" class="admin-btn-outline admin-btn-sm move-up" data-id="${c.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="admin-btn-outline admin-btn-sm move-down" data-id="${c.id}" ${i === categories.length - 1 ? 'disabled' : ''}>↓</button>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <strong class="text-sm text-hc-ink">${escapeHtml(c.name)}</strong>
                <span class="text-xs text-gray-400">/${escapeHtml(c.slug)}</span>
                <span class="admin-badge ${c.isActive ? 'admin-badge-active' : 'admin-badge-error'}">${c.isActive ? 'active' : 'inactive'}</span>
                <span class="text-xs text-gray-400">${c.typeCount} type${c.typeCount === 1 ? '' : 's'}</span>
              </div>
              ${c.description ? `<p class="mt-1 text-sm text-hc-ink/60 break-words">${escapeHtml(c.description)}</p>` : ''}
              <div id="editRow-${c.id}" style="display:none;" class="mt-3"></div>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
              <button type="button" class="admin-btn-outline admin-btn-sm edit-category" data-id="${c.id}">Edit</button>
              <button type="button" class="admin-btn-outline admin-btn-sm toggle-category" data-id="${c.id}" data-active="${c.isActive}">${c.isActive ? 'Deactivate' : 'Activate'}</button>
              <button type="button" class="admin-btn-danger admin-btn-sm remove-category" data-id="${c.id}">Remove</button>
            </div>
          </div>
        </div>`).join('') || '<p class="text-sm text-gray-400">No categories yet. Every website type shows in one flat list on /explore until you add one.</p>';

      list.querySelectorAll('.move-up').forEach(btn => btn.addEventListener('click', () => move(btn.dataset.id, 'up')));
      list.querySelectorAll('.move-down').forEach(btn => btn.addEventListener('click', () => move(btn.dataset.id, 'down')));
      list.querySelectorAll('.toggle-category').forEach(btn => {
        btn.addEventListener('click', async () => {
          const isActive = btn.dataset.active === 'true';
          const res = await window.adminFetch(`/api/admin/categories/${btn.dataset.id}`, {
            method: 'PUT',
            body: JSON.stringify({ isActive: !isActive })
          });
          if (res.ok) load();
        });
      });
      list.querySelectorAll('.remove-category').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this category? Website types inside it are NOT deleted. They just become uncategorized.')) return;
          const res = await window.adminFetch(`/api/admin/categories/${btn.dataset.id}`, { method: 'DELETE' });
          if (res.ok) load();
        });
      });
      list.querySelectorAll('.edit-category').forEach(btn => {
        btn.addEventListener('click', () => openEditRow(btn.dataset.id, categories));
      });
    }

    function openEditRow(id, categories) {
      const category = categories.find(c => String(c.id) === String(id));
      if (!category) return;
      editingId = id;
      const row = document.getElementById(`editRow-${id}`);
      row.style.display = 'block';
      row.innerHTML = `
        <label class="admin-label">Name</label>
        <input class="admin-input" type="text" data-field="name" value="${escapeHtml(category.name)}">
        <label class="admin-label">Description</label>
        <textarea class="admin-textarea" id="editCategoryDescription-${id}" data-field="description">${escapeHtml(category.description || '')}</textarea>
        <label class="admin-label">Icon</label>
        <select class="admin-select" data-field="iconName"></select>
        <div class="mt-2 flex gap-2">
          <button type="button" class="admin-btn admin-btn-sm save-edit">Save changes</button>
          <button type="button" class="admin-btn-outline admin-btn-sm cancel-edit">Cancel</button>
        </div>`;
      attachCharCounter(row.querySelector('[data-field="description"]'));
      const iconSelect = row.querySelector('[data-field="iconName"]');
      window.HC_CATEGORY_ICON_NAMES.forEach(name => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        if (name === category.iconName) opt.selected = true;
        iconSelect.appendChild(opt);
      });
      row.querySelector('.cancel-edit').addEventListener('click', () => {
        editingId = null;
        row.style.display = 'none';
        row.innerHTML = '';
      });
      row.querySelector('.save-edit').addEventListener('click', async () => {
        const res = await window.adminFetch(`/api/admin/categories/${id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: row.querySelector('[data-field="name"]').value,
            description: row.querySelector('[data-field="description"]').value,
            iconName: row.querySelector('[data-field="iconName"]').value
          })
        });
        if (res.ok) {
          editingId = null;
          load();
        } else {
          const data = await res.json();
          alert(data.error || 'Failed to save category.');
        }
      });
    }

    async function move(id, direction) {
      const res = await window.adminFetch(`/api/admin/categories/${id}/move`, {
        method: 'PUT',
        body: JSON.stringify({ direction })
      });
      if (res.ok) load();
    }

    async function load() {
      const res = await window.adminFetch('/api/admin/categories');
      const categories = await res.json();
      render(categories);
    }

    document.getElementById('addCategoryForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/categories', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.value,
          slug: form.slug.value || undefined,
          description: form.description.value,
          iconName: form.iconName.value
        })
      });
      const statusEl = document.getElementById('addCategoryStatus');
      statusEl.style.display = 'block';
      if (res.ok) {
        statusEl.className = 'admin-msg admin-msg-success';
        statusEl.textContent = 'Category added.';
        form.reset();
        load();
      } else {
        const data = await res.json();
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.textContent = data.error || 'Failed to add category.';
      }
    });

    // Exposes the same curated icon set the "Add category" <select> is
    // server-rendered with (views/admin/categories.ejs), read client-side
    // from that already-rendered <select> rather than duplicating
    // lib/icons.js's CATEGORY_ICON_NAMES list a third time in JS.
    window.HC_CATEGORY_ICON_NAMES = Array.from(document.getElementById('categoryIconName').options).map(o => o.value);
    attachCharCounter(document.getElementById('categoryDescription'));

    load();
  }

  // ---- SEO Pages (v1.2.0) ----
  // Deliberately structured like initCategoriesPage() above -- same flat
  // list-management pattern -- but simpler in the ways that fall directly
  // out of the schema: no move up/down (seo_pages has no display_order;
  // each page is an independent URL, never browsed as an ordered list),
  // and slug isn't editable in the edit row at all (see
  // routes/adminSeoPages.js's updateSchema comment for why).
  function initSeoPagesPage() {
    function render(pages) {
      const list = document.getElementById('seoPagesList');
      list.innerHTML = pages.map(p => `
        <div class="admin-card" data-id="${p.id}">
          <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <strong class="text-sm text-hc-ink">${escapeHtml(p.pageTitle)}</strong>
                <span class="text-xs text-gray-400">/${escapeHtml(p.slug)}</span>
                <span class="admin-badge ${p.isActive ? 'admin-badge-active' : 'admin-badge-error'}">${p.isActive ? 'active' : 'inactive'}</span>
              </div>
              <p class="mt-1 text-sm text-hc-ink/60 break-words">${escapeHtml(p.metaDescription)}</p>
              <p class="mt-1 text-xs text-gray-400">
                Target: ${p.targetWebsiteTypeName ? escapeHtml(p.targetWebsiteTypeName) : 'none (CTA links to /explore)'}
                &middot; CTA: "${escapeHtml(p.ctaText)}"
              </p>
              <div id="editRow-${p.id}" style="display:none;" class="mt-3"></div>
              <div id="contentRow-${p.id}" style="display:none;" class="mt-3"></div>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
              <button type="button" class="admin-btn-outline admin-btn-sm edit-seo-page" data-id="${p.id}">Edit</button>
              <button type="button" class="admin-btn-outline admin-btn-sm content-seo-page" data-id="${p.id}">Content</button>
              <button type="button" class="admin-btn-outline admin-btn-sm toggle-seo-page" data-id="${p.id}" data-active="${p.isActive}">${p.isActive ? 'Deactivate' : 'Activate'}</button>
              <button type="button" class="admin-btn-danger admin-btn-sm remove-seo-page" data-id="${p.id}">Remove</button>
            </div>
          </div>
        </div>`).join('') || '<p class="text-sm text-gray-400">No SEO pages yet.</p>';

      list.querySelectorAll('.toggle-seo-page').forEach(btn => {
        btn.addEventListener('click', async () => {
          const isActive = btn.dataset.active === 'true';
          const res = await window.adminFetch(`/api/admin/seo-pages/${btn.dataset.id}`, {
            method: 'PUT',
            body: JSON.stringify({ isActive: !isActive })
          });
          if (res.ok) load();
        });
      });
      list.querySelectorAll('.remove-seo-page').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this SEO page? Its URL will stop working immediately, and its content history goes with it.')) return;
          const res = await window.adminFetch(`/api/admin/seo-pages/${btn.dataset.id}`, { method: 'DELETE' });
          if (res.ok) load();
        });
      });
      list.querySelectorAll('.edit-seo-page').forEach(btn => {
        btn.addEventListener('click', () => openEditRow(btn.dataset.id, pages));
      });
      list.querySelectorAll('.content-seo-page').forEach(btn => {
        btn.addEventListener('click', () => toggleContentRow(btn.dataset.id));
      });
    }

    function openEditRow(id, pages) {
      const seoPage = pages.find(p => String(p.id) === String(id));
      if (!seoPage) return;
      const row = document.getElementById(`editRow-${id}`);
      row.style.display = 'block';
      row.innerHTML = `
        <label class="admin-label">Page title</label>
        <input class="admin-input" type="text" data-field="pageTitle" maxlength="200" value="${escapeHtml(seoPage.pageTitle)}">
        <label class="admin-label">Meta description</label>
        <textarea class="admin-textarea" data-field="metaDescription" maxlength="500">${escapeHtml(seoPage.metaDescription)}</textarea>
        <label class="admin-label">Target website type</label>
        <select class="admin-select" data-field="targetWebsiteTypeId"></select>
        <label class="admin-label">CTA button text</label>
        <input class="admin-input" type="text" data-field="ctaText" maxlength="100" value="${escapeHtml(seoPage.ctaText)}">
        <div class="mt-2 flex gap-2">
          <button type="button" class="admin-btn admin-btn-sm save-edit">Save changes</button>
          <button type="button" class="admin-btn-outline admin-btn-sm cancel-edit">Cancel</button>
        </div>`;
      attachCharCounter(row.querySelector('[data-field="metaDescription"]'), 160);
      const typeSelect = row.querySelector('[data-field="targetWebsiteTypeId"]');
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = 'None (CTA links to /explore)';
      typeSelect.appendChild(noneOpt);
      window.HC_SEO_PAGE_WEBSITE_TYPES.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        if (String(t.id) === String(seoPage.targetWebsiteTypeId)) opt.selected = true;
        typeSelect.appendChild(opt);
      });
      row.querySelector('.cancel-edit').addEventListener('click', () => {
        row.style.display = 'none';
        row.innerHTML = '';
      });
      row.querySelector('.save-edit').addEventListener('click', async () => {
        const targetValue = row.querySelector('[data-field="targetWebsiteTypeId"]').value;
        const res = await window.adminFetch(`/api/admin/seo-pages/${id}`, {
          method: 'PUT',
          body: JSON.stringify({
            pageTitle: row.querySelector('[data-field="pageTitle"]').value,
            metaDescription: row.querySelector('[data-field="metaDescription"]').value,
            targetWebsiteTypeId: targetValue ? Number(targetValue) : null,
            ctaText: row.querySelector('[data-field="ctaText"]').value
          })
        });
        if (res.ok) {
          load();
        } else {
          const data = await res.json();
          alert(data.error || 'Failed to save SEO page.');
        }
      });
    }

    // Same helper as initWebsiteTypesDetailPage()'s Template tab and
    // initLegalPagesPage() -- each of those pages has its own copy too
    // (established convention in this file: small, self-contained
    // per-page helpers rather than one shared hoisted function).
    function wireFileUploadIntoTextarea(fileInputEl, textareaEl) {
      fileInputEl.addEventListener('change', () => {
        const file = fileInputEl.files && fileInputEl.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          textareaEl.value = typeof reader.result === 'string' ? reader.result : '';
          fileInputEl.value = ''; // so picking the exact same file again still fires 'change'
        };
        reader.onerror = () => {
          alert('Could not read that file.');
          fileInputEl.value = '';
        };
        reader.readAsText(file);
      });
    }

    // v1.2.2 Part C: matches the Template tab's UI pattern exactly (format
    // toggle here is the one addition Template doesn't need, since a
    // website type's template is always HTML) -- new version on save,
    // previous deactivated, nothing ever deleted, rollback as a pointer
    // flip. One real structural difference from openEditRow() above: this
    // fetches its data lazily (only when first opened, cached in
    // `loadedContentIds` after that) since a page with many SEO pages
    // would otherwise fire N content requests just to render the list.
    const loadedContentIds = new Set();

    function toggleContentRow(id) {
      const row = document.getElementById(`contentRow-${id}`);
      const isOpen = row.style.display !== 'none';
      if (isOpen) {
        row.style.display = 'none';
        return;
      }
      row.style.display = 'block';
      if (loadedContentIds.has(id)) return; // already rendered once, just re-showing
      loadedContentIds.add(id);

      row.innerHTML = `
        <div class="admin-card">
          <p class="text-sm text-gray-500">Content format</p>
          <select class="admin-select" data-field="contentFormat">
            <option value="html">HTML</option>
            <option value="markdown">Markdown</option>
          </select>
          <label class="admin-label">Or upload a .html/.md file (fills the box below, nothing is saved until you click "Save new version")</label>
          <input class="admin-input" type="file" data-field="contentFile" accept=".html,.htm,.md,.markdown,.txt,text/html,text/markdown,text/plain">
          <label class="admin-label">Raw content (current version: <span data-field="currentVersion">none</span>)</label>
          <textarea class="admin-textarea min-h-[16rem] font-mono text-xs" data-field="rawContent"></textarea>
          <button type="button" class="admin-btn mt-3 save-seo-content">Save new version</button>
          <p class="admin-msg" data-field="contentStatus" style="display:none;"></p>
        </div>
        <div class="admin-table-wrap mt-4">
          <table class="admin-table is-responsive-stack">
            <thead><tr><th>Version</th><th>Format</th><th>Created</th><th></th></tr></thead>
            <tbody data-field="historyTableBody"></tbody>
          </table>
        </div>`;

      const formatSelect = row.querySelector('[data-field="contentFormat"]');
      const fileInput = row.querySelector('[data-field="contentFile"]');
      const textarea = row.querySelector('[data-field="rawContent"]');
      const currentVersionEl = row.querySelector('[data-field="currentVersion"]');
      const statusEl = row.querySelector('[data-field="contentStatus"]');
      const historyBody = row.querySelector('[data-field="historyTableBody"]');

      wireFileUploadIntoTextarea(fileInput, textarea);

      async function loadContent() {
        const res = await window.adminFetch(`/api/admin/seo-pages/${id}/content`);
        const data = await res.json();
        formatSelect.value = data.contentFormat;
        currentVersionEl.textContent = data.active ? 'v' + data.active.version : 'none yet';
        textarea.value = data.active ? data.active.rawContent : '';
        historyBody.innerHTML = data.history.map(h => `
          <tr>
            <td data-label="Version">v${h.version}</td>
            <td data-label="Format">${h.contentFormat === 'markdown' ? 'Markdown' : 'HTML'}</td>
            <td data-label="Created">${new Date(h.createdAt).toLocaleString()}</td>
            <td data-label="">${data.active && data.active.version === h.version ? '' : `<button type="button" class="admin-btn-outline admin-btn-sm rollback-seo-content" data-version="${h.version}">Rollback to this</button>`}</td>
          </tr>`).join('') || '<tr><td colspan="4" data-label="">No versions yet.</td></tr>';

        historyBody.querySelectorAll('.rollback-seo-content').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm(`Roll back to version ${btn.dataset.version}?`)) return;
            const res = await window.adminFetch(`/api/admin/seo-pages/${id}/content/rollback/${btn.dataset.version}`, { method: 'POST' });
            if (res.ok) loadContent();
          });
        });
      }

      row.querySelector('.save-seo-content').addEventListener('click', async () => {
        const res = await window.adminFetch(`/api/admin/seo-pages/${id}/content`, {
          method: 'PUT',
          body: JSON.stringify({
            contentFormat: formatSelect.value,
            rawContent: textarea.value
          })
        });
        const data = await res.json();
        statusEl.style.display = 'block';
        if (res.ok) {
          statusEl.className = 'admin-msg admin-msg-success';
          statusEl.textContent = `Saved as v${data.version}.`;
          loadContent();
        } else {
          statusEl.className = 'admin-msg admin-msg-error';
          statusEl.textContent = data.error || 'Failed to save this page\'s content.';
        }
      });

      loadContent();
    }

    async function load() {
      const res = await window.adminFetch('/api/admin/seo-pages');
      const pages = await res.json();
      render(pages);
    }

    document.getElementById('addSeoPageForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/seo-pages', {
        method: 'POST',
        body: JSON.stringify({
          slug: form.slug.value,
          pageTitle: form.pageTitle.value,
          metaDescription: form.metaDescription.value,
          targetWebsiteTypeId: form.targetWebsiteTypeId.value ? Number(form.targetWebsiteTypeId.value) : undefined,
          ctaText: form.ctaText.value || undefined
        })
      });
      const statusEl = document.getElementById('addSeoPageStatus');
      statusEl.style.display = 'block';
      if (res.ok) {
        statusEl.className = 'admin-msg admin-msg-success';
        statusEl.textContent = 'SEO page added. Click "Content" below to write its page content.';
        form.reset();
        load();
      } else {
        const data = await res.json();
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.textContent = data.error || 'Failed to add SEO page.';
      }
    });

    // Same "read from the already-server-rendered <select>" pattern as
    // window.HC_CATEGORY_ICON_NAMES above -- avoids fetching or
    // duplicating the website-types list a second time just for the edit
    // row's dropdown.
    window.HC_SEO_PAGE_WEBSITE_TYPES = Array.from(document.getElementById('seoPageTargetType').options)
      .filter(o => o.value)
      .map(o => ({ id: o.value, name: o.textContent }));
    attachCharCounter(document.getElementById('seoPageMetaDescription'), 160);

    load();
  }

  // ---- FAQ page (v1.1.6 Part D) ----
  // Deliberately structured identically to initCategoriesPage() just
  // above -- same "same list-management pattern used for Categories/
  // Fields" reasoning as routes/adminFaq.js itself. Simpler than
  // categories in a few ways that fall directly out of the schema having
  // no slug and no icon: no dedicated icon-picker wiring, and the confirm
  // dialog needs no "children are uncategorized, not deleted" caveat
  // (deleting an FAQ entry has no downstream row anywhere else to worry
  // about).
  function initFaqPage() {
    function render(entries) {
      const list = document.getElementById('faqList');
      list.innerHTML = entries.map((f, i) => `
        <div class="admin-card" data-id="${f.id}">
          <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
            <div class="flex shrink-0 flex-row gap-1 sm:flex-col">
              <button type="button" class="admin-btn-outline admin-btn-sm move-up" data-id="${f.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="admin-btn-outline admin-btn-sm move-down" data-id="${f.id}" ${i === entries.length - 1 ? 'disabled' : ''}>↓</button>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <strong class="text-sm text-hc-ink">${escapeHtml(f.question)}</strong>
                <span class="admin-badge ${f.isActive ? 'admin-badge-active' : 'admin-badge-error'}">${f.isActive ? 'active' : 'inactive'}</span>
              </div>
              <p class="mt-1 text-sm text-hc-ink/60 break-words">${escapeHtml(f.answer)}</p>
              <div id="editRow-${f.id}" style="display:none;" class="mt-3"></div>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
              <button type="button" class="admin-btn-outline admin-btn-sm edit-faq" data-id="${f.id}">Edit</button>
              <button type="button" class="admin-btn-outline admin-btn-sm toggle-faq" data-id="${f.id}" data-active="${f.isActive}">${f.isActive ? 'Deactivate' : 'Activate'}</button>
              <button type="button" class="admin-btn-danger admin-btn-sm remove-faq" data-id="${f.id}">Remove</button>
            </div>
          </div>
        </div>`).join('') || '<p class="text-sm text-gray-400">No FAQ entries yet.</p>';

      list.querySelectorAll('.move-up').forEach(btn => btn.addEventListener('click', () => move(btn.dataset.id, 'up')));
      list.querySelectorAll('.move-down').forEach(btn => btn.addEventListener('click', () => move(btn.dataset.id, 'down')));
      list.querySelectorAll('.toggle-faq').forEach(btn => {
        btn.addEventListener('click', async () => {
          const isActive = btn.dataset.active === 'true';
          const res = await window.adminFetch(`/api/admin/faq/${btn.dataset.id}`, {
            method: 'PUT',
            body: JSON.stringify({ isActive: !isActive })
          });
          if (res.ok) load();
        });
      });
      list.querySelectorAll('.remove-faq').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this FAQ entry? This cannot be undone.')) return;
          const res = await window.adminFetch(`/api/admin/faq/${btn.dataset.id}`, { method: 'DELETE' });
          if (res.ok) load();
        });
      });
      list.querySelectorAll('.edit-faq').forEach(btn => {
        btn.addEventListener('click', () => openEditRow(btn.dataset.id, entries));
      });
    }

    function openEditRow(id, entries) {
      const entry = entries.find(f => String(f.id) === String(id));
      if (!entry) return;
      const row = document.getElementById(`editRow-${id}`);
      row.style.display = 'block';
      row.innerHTML = `
        <label class="admin-label">Question</label>
        <input class="admin-input" type="text" data-field="question" value="${escapeHtml(entry.question)}">
        <label class="admin-label">Answer</label>
        <textarea class="admin-textarea" data-field="answer">${escapeHtml(entry.answer)}</textarea>
        <div class="mt-2 flex gap-2">
          <button type="button" class="admin-btn admin-btn-sm save-edit">Save changes</button>
          <button type="button" class="admin-btn-outline admin-btn-sm cancel-edit">Cancel</button>
        </div>`;
      row.querySelector('.cancel-edit').addEventListener('click', () => {
        row.style.display = 'none';
        row.innerHTML = '';
      });
      row.querySelector('.save-edit').addEventListener('click', async () => {
        const res = await window.adminFetch(`/api/admin/faq/${id}`, {
          method: 'PUT',
          body: JSON.stringify({
            question: row.querySelector('[data-field="question"]').value,
            answer: row.querySelector('[data-field="answer"]').value
          })
        });
        if (res.ok) {
          load();
        } else {
          const data = await res.json();
          alert(data.error || 'Failed to save FAQ entry.');
        }
      });
    }

    async function move(id, direction) {
      const res = await window.adminFetch(`/api/admin/faq/${id}/move`, {
        method: 'PUT',
        body: JSON.stringify({ direction })
      });
      if (res.ok) load();
    }

    async function load() {
      const res = await window.adminFetch('/api/admin/faq');
      const entries = await res.json();
      render(entries);
    }

    document.getElementById('addFaqForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/faq', {
        method: 'POST',
        body: JSON.stringify({
          question: form.question.value,
          answer: form.answer.value
        })
      });
      const statusEl = document.getElementById('addFaqStatus');
      statusEl.style.display = 'block';
      if (res.ok) {
        statusEl.className = 'admin-msg admin-msg-success';
        statusEl.textContent = 'Question added.';
        form.reset();
        load();
      } else {
        const data = await res.json();
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.textContent = data.error || 'Failed to add question.';
      }
    });

    load();
  }

  // ---- legal pages (v1.2.1 Part A) ----
  //
  // Same version-save/rollback shape as website-types-detail's Template/
  // Password Page tabs above (see initWebsiteTypesDetailPage), just
  // looped over the three fixed page_key tabs instead of one call site
  // per website type, and with no placeholder reference/validation (legal
  // pages have no {{token}} set of their own). All three tabs load
  // eagerly on page load, same as that page's own tabs, not lazily on
  // tab click.
  function initLegalPagesPage() {
    const PAGE_KEYS = ['privacy_policy', 'terms', 'cookie_policy'];

    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';
      });
    });

    function wireFileUploadIntoTextarea(fileInputId, textareaId) {
      const fileInput = document.getElementById(fileInputId);
      const textarea = document.getElementById(textareaId);
      fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          textarea.value = typeof reader.result === 'string' ? reader.result : '';
          fileInput.value = ''; // so picking the exact same file again still fires 'change'
        };
        reader.onerror = () => {
          alert('Could not read that file.');
          fileInput.value = '';
        };
        reader.readAsText(file);
      });
    }

    PAGE_KEYS.forEach(pageKey => {
      wireFileUploadIntoTextarea('legalFileInput_' + pageKey, 'legalHtmlContent_' + pageKey);

      async function loadLegalPage() {
        const res = await window.adminFetch(`/api/admin/legal-pages/${pageKey}`);
        const data = await res.json();
        document.getElementById('legalCurrentVersion_' + pageKey).textContent = data.active ? 'v' + data.active.version : 'none yet';
        document.getElementById('legalHtmlContent_' + pageKey).value = data.active ? data.active.htmlContent : '';
        const historyBody = document.getElementById('legalHistoryTableBody_' + pageKey);
        historyBody.innerHTML = data.history.map(h => `
          <tr>
            <td data-label="Version">v${h.version}</td>
            <td data-label="Created">${new Date(h.createdAt).toLocaleString()}</td>
            <td data-label="">${data.active && data.active.version === h.version ? '' : `<button type="button" class="admin-btn-outline admin-btn-sm rollback-legal-page" data-version="${h.version}">Rollback to this</button>`}</td>
          </tr>`).join('') || '<tr><td colspan="3" data-label="">No versions yet.</td></tr>';

        historyBody.querySelectorAll('.rollback-legal-page').forEach(btn => {
          btn.addEventListener('click', async () => {
            if (!confirm(`Roll back to version ${btn.dataset.version}?`)) return;
            const res = await window.adminFetch(`/api/admin/legal-pages/${pageKey}/rollback/${btn.dataset.version}`, { method: 'POST' });
            if (res.ok) loadLegalPage();
          });
        });
      }

      const section = document.querySelector(`[data-page-key="${pageKey}"]`);
      const form = section.querySelector('.legal-page-form');
      const statusEl = document.getElementById('legalStatus_' + pageKey);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const res = await window.adminFetch(`/api/admin/legal-pages/${pageKey}`, {
          method: 'PUT',
          body: JSON.stringify({ htmlContent: document.getElementById('legalHtmlContent_' + pageKey).value })
        });
        const data = await res.json();
        statusEl.style.display = 'block';
        if (res.ok) {
          statusEl.className = 'admin-msg admin-msg-success';
          statusEl.textContent = `Saved as v${data.version}.`;
          loadLegalPage();
        } else {
          statusEl.className = 'admin-msg admin-msg-error';
          statusEl.textContent = data.error || 'Failed to save this page.';
        }
      });

      loadLegalPage();
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initNav();
    const page = document.body.dataset.page;
    if (page === 'login') initLoginPage();
    if (page === 'payments') initPaymentsPage();
    if (page === 'hosting') initHostingPage();
    if (page === 'ai-provider') initAiProviderPage();
    if (page === 'email-providers') initEmailProvidersPage();
    if (page === 'notifications') initNotificationsPage();
    if (page === 'website-types-index') initWebsiteTypesIndexPage();
    if (page === 'website-types-detail') initWebsiteTypesDetailPage();
    if (page === 'overview') initOverviewPage();
    if (page === 'submissions') initSubmissionsPage();
    if (page === 'activity') initActivityPage();
    if (page === 'recovery') initRecoveryPage();
    if (page === 'funnel') initFunnelPage();
    if (page === 'site-settings') initSiteSettingsPage();
    if (page === 'scripts') initScriptsPage();
    if (page === 'landing-page') initLandingPagePage();
    if (page === 'landing-sections') initLandingSectionsPage();
    if (page === 'categories') initCategoriesPage();
    if (page === 'faq') initFaqPage();
    if (page === 'seo-pages') initSeoPagesPage();
    if (page === 'legal-pages') initLegalPagesPage();
  });
})();
