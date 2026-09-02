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
        const isOpen = toggle.classList.toggle('is-open');
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
    loadKenyanCurrency();

    // v1.1.1 Part D: geolocation health check panel.
    document.getElementById('runGeoDiagnosticBtn').addEventListener('click', async () => {
      const btn = document.getElementById('runGeoDiagnosticBtn');
      const resultEl = document.getElementById('geoDiagnosticResult');
      const ip = document.getElementById('geoDiagnosticIp').value.trim();

      btn.disabled = true;
      btn.textContent = 'Running…';
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<p class="text-sm text-gray-500">Running a live lookup. This can take a few seconds if a provider is slow or unreachable…</p>';

      try {
        const url = '/api/admin/settings/geo-diagnostic' + (ip ? '?ip=' + encodeURIComponent(ip) : '');
        const res = await window.adminFetch(url);
        const data = await res.json();

        if (!res.ok) {
          resultEl.innerHTML = `<p class="admin-msg admin-msg-error">${escapeHtml(data.error || 'Diagnostic failed to run.')}</p>`;
          return;
        }

        if (data.note) {
          resultEl.innerHTML = `<p class="admin-msg admin-msg-warning">${escapeHtml(data.note)}</p>`;
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
            ${finalOk ? '' : ', every provider failed for this IP, so USD was used as the safe default.'}
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
  function initOverviewPage() {
    const paymentsValue = document.getElementById('statPaymentsValue');
    const paymentsBadge = document.getElementById('statPaymentsBadge');
    const aiProviderValue = document.getElementById('statAiProviderValue');
    const aiProviderCaption = document.getElementById('statAiProviderCaption');
    const websiteTypesValue = document.getElementById('statWebsiteTypesValue');
    const websiteTypesBadge = document.getElementById('statWebsiteTypesBadge');
    const deploymentsValue = document.getElementById('statDeploymentsValue');
    const deploymentsCaption = document.getElementById('statDeploymentsCaption');
    const breakdownBody = document.getElementById('statsBreakdownBody');
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

        deploymentsValue.textContent = String(stats.totalDeployments);
        deploymentsCaption.textContent = `$${stats.totalRevenueUsd.toFixed(2)} revenue, ${stats.subscriberCount} subscriber(s)`;

        breakdownBody.innerHTML = stats.breakdown.map(b => `
          <tr>
            <td data-label="Type">${escapeHtml(b.name)}</td>
            <td data-label="Deployments">${b.deploymentCount}</td>
            <td data-label="Revenue">$${b.revenueUsd.toFixed(2)}</td>
          </tr>`).join('') || '<tr><td colspan="3" data-label="">No website types yet.</td></tr>';
      })
      .catch(() => {
        errorEl.style.display = 'block';
        [paymentsValue, aiProviderValue, websiteTypesValue, deploymentsValue].forEach(el => { el.textContent = 'Unavailable'; });
      });
  }

  // ---- submissions page (deployments + subscribers) ----
  function initSubmissionsPage() {
    let deploymentsPage = 1;
    let deploymentsSearch = '';
    let subscribersPage = 1;
    let subscribersSearch = '';
    let searchDebounceTimer = null;

    function formatDate(iso) {
      return new Date(iso).toLocaleString();
    }

    async function loadDeployments() {
      const url = '/api/admin/dashboard/deployments?page=' + deploymentsPage + '&search=' + encodeURIComponent(deploymentsSearch);
      const res = await window.adminFetch(url);
      const data = await res.json();

      function formatDeploymentAmount(d) {
        // v1.0.6: chargeCurrency/chargeAmount hold the REAL amount actually
        // charged for deployments from this version onward. Pre-1.0.6 rows
        // only have the legacy amountUsd figure (from amount_kes, which was
        // already effectively USD — see routes/adminDashboard.js) with no
        // real currency on record, shown with an "(est.)" hint instead of
        // asserting a currency that was never actually recorded.
        if (d.chargeCurrency && d.chargeAmount !== null) {
          return `${escapeHtml(d.chargeCurrency)} ${Number(d.chargeAmount).toFixed(2)}`;
        }
        return d.amountUsd !== null ? `~$${Number(d.amountUsd).toFixed(2)} (est.)` : 'n/a';
      }

      document.getElementById('deploymentsTableBody').innerHTML = data.deployments.map(d => `
        <tr>
          <td data-label="Client">${escapeHtml(d.clientEmail)}</td>
          <td data-label="Type">${escapeHtml(d.websiteTypeName || 'n/a')}</td>
          <td data-label="Site"><a href="${escapeHtml(d.siteUrl)}" target="_blank" rel="noopener" class="text-brand-500 underline">${escapeHtml(d.siteUrl)}</a></td>
          <td data-label="Amount">${formatDeploymentAmount(d)}</td>
          <td data-label="Deployed">${formatDate(d.deployedAt)}</td>
        </tr>`).join('') || '<tr><td colspan="5" data-label="">No deployments yet.</td></tr>';

      document.getElementById('deploymentsPageInfo').textContent = `Page ${data.page} of ${data.totalPages} (${data.total} total)`;
      document.getElementById('deploymentsPrev').disabled = data.page <= 1;
      document.getElementById('deploymentsNext').disabled = data.page >= data.totalPages;
    }

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

    document.getElementById('deploymentSearch').addEventListener('input', (e) => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        deploymentsSearch = e.target.value;
        deploymentsPage = 1;
        loadDeployments();
      }, 300);
    });

    document.getElementById('subscriberSearch').addEventListener('input', (e) => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        subscribersSearch = e.target.value;
        subscribersPage = 1;
        loadSubscribers();
      }, 300);
    });

    document.getElementById('deploymentsPrev').addEventListener('click', () => {
      if (deploymentsPage > 1) { deploymentsPage--; loadDeployments(); }
    });
    document.getElementById('deploymentsNext').addEventListener('click', () => {
      deploymentsPage++; loadDeployments();
    });
    document.getElementById('subscribersPrev').addEventListener('click', () => {
      if (subscribersPage > 1) { subscribersPage--; loadSubscribers(); }
    });
    document.getElementById('subscribersNext').addEventListener('click', () => {
      subscribersPage++; loadSubscribers();
    });

    loadDeployments();
    loadSubscribers();
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
          social_linkedin_url: form.social_linkedin_url.value
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

    load();
    loadResendDetailsRateLimit();
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
      faq: { render: renderFaqForm, collect: collectFaqForm }
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
        footer: { name: 'link_columns', rowHtmlFn: footerColumnRowHtml }
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

    async function load() {
      const res = await window.adminFetch('/api/admin/landing-sections');
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
        body: JSON.stringify({ sectionType })
      });
      if (res.ok) {
        load();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add section.');
      }
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

  document.addEventListener('DOMContentLoaded', function () {
    initNav();
    const page = document.body.dataset.page;
    if (page === 'login') initLoginPage();
    if (page === 'payments') initPaymentsPage();
    if (page === 'ai-provider') initAiProviderPage();
    if (page === 'email-providers') initEmailProvidersPage();
    if (page === 'notifications') initNotificationsPage();
    if (page === 'website-types-index') initWebsiteTypesIndexPage();
    if (page === 'website-types-detail') initWebsiteTypesDetailPage();
    if (page === 'overview') initOverviewPage();
    if (page === 'submissions') initSubmissionsPage();
    if (page === 'recovery') initRecoveryPage();
    if (page === 'funnel') initFunnelPage();
    if (page === 'site-settings') initSiteSettingsPage();
    if (page === 'scripts') initScriptsPage();
    if (page === 'landing-page') initLandingPagePage();
    if (page === 'landing-sections') initLandingSectionsPage();
    if (page === 'categories') initCategoriesPage();
    if (page === 'faq') initFaqPage();
  });
})();
