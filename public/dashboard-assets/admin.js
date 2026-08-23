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
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
      btn.textContent = showing ? '👁' : '🙈';
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
      modeBadge.className = 'admin-badge ' + (cfg.mode === 'live' ? 'admin-badge-active' : 'admin-badge-warn');
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
      resultEl.innerHTML = '<p class="text-sm text-slate-500">Running a live lookup — this can take a few seconds if a provider is slow or unreachable…</p>';

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
            <td data-label="Result">${a.success ? '<span class="admin-badge admin-badge-active">ok</span>' : '<span class="admin-badge admin-badge-warn">failed</span>'}</td>
            <td data-label="Latency">${escapeHtml(a.latencyMs)}ms</td>
            <td data-label="Details">${escapeHtml(a.error || (a.success ? `country=${a.countryCode || 'n/a'} currency=${a.currency || 'n/a'}` : ''))}</td>
          </tr>
        `).join('');

        const finalOk = data.finalResult.countryCode !== null || data.finalResult.currency !== 'USD';
        resultEl.innerHTML = `
          <p class="text-sm text-hc-ink">Tested IP: <strong>${escapeHtml(data.ip)}</strong> — current Kenyan-visitor toggle: <strong>${escapeHtml(data.kenyanPaymentCurrency)}</strong></p>
          <table class="admin-table mt-3">
            <thead><tr><th>Provider</th><th>Result</th><th>Latency</th><th>Details</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="mt-3 text-sm ${finalOk ? 'text-emerald-700' : 'text-amber-700'}">
            Final result: currency=${escapeHtml(data.finalResult.currency)}, countryCode=${escapeHtml(data.finalResult.countryCode || 'null')}
            ${finalOk ? '' : ' — every provider failed for this IP, so USD was used as the safe default.'}
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
        <p class="mt-0.5 text-sm text-slate-400">${escapeHtml(p.baseUrl)}</p>

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
        ? `<p class="mt-1 text-sm text-slate-500">From: ${escapeHtml(p.config.fromAddress || '(not set)')} · API key: ${escapeHtml(p.config.apiKeyMasked || 'unreadable')}</p>`
        : `<p class="mt-1 text-sm text-slate-500">${escapeHtml(p.config.host || '(no host)')}:${escapeHtml(p.config.port || '?')} (${escapeHtml(p.config.connectionSecurity)}) · From: ${escapeHtml(p.config.fromAddress || '(not set)')} · Password: ${escapeHtml(p.config.passwordMasked || 'unreadable')}</p>`;

      return `
      <div class="admin-card email-provider-card" data-provider-id="${p.id}">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-base font-semibold text-hc-ink">${escapeHtml(p.label)}</h2>
          <span class="admin-badge">${escapeHtml(p.providerType)}</span>
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
      providersList.innerHTML = providers.map(providerCard).join('') || '<p class="admin-msg admin-msg-warning">No email providers configured yet — nothing will be able to send email until one is added and activated.</p>';
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
          <span class="admin-badge">${escapeHtml(c.channelType)}</span>
          ${c.isActive ? '<span class="admin-badge admin-badge-active">enabled</span>' : '<span class="admin-badge">disabled</span>'}
        </div>
        <p class="mt-1 text-sm text-slate-500">${channelConfigSummary(c)}</p>

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
      channelsList.innerHTML = channels.map(channelCard).join('') || '<p class="admin-msg admin-msg-warning">No notification channels configured yet — you won\'t be alerted when a sale completes.</p>';
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

    async function load() {
      const res = await window.adminFetch('/api/admin/website-types');
      const types = await res.json();
      document.getElementById('typesTableBody').innerHTML = types.map(t => `
        <tr>
          <td data-label="Name"><a href="/${slug}/website-types/${t.id}" class="font-medium text-hc-blue">${escapeHtml(t.name)}</a></td>
          <td data-label="Status"><span class="admin-badge ${t.isActive ? 'admin-badge-active' : ''}">${t.isActive ? 'active' : 'inactive'}</span></td>
          <td data-label="Fields">${t.fieldCount}</td>
          <td data-label="Template">${t.activeTemplateVersion ? 'v' + t.activeTemplateVersion : '—'}</td>
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
          seoDescription: form.seoDescription.value
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

    async function loadFields() {
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/fields`);
      const fields = await res.json();
      currentFields = fields;
      document.getElementById('fieldsTableBody').innerHTML = fields.map(f => `
        <tr>
          <td data-label="Key">{{${escapeHtml(f.fieldKey)}}}</td>
          <td data-label="Label">${escapeHtml(f.fieldLabel)}</td>
          <td data-label="Type">${escapeHtml(f.fieldType)}</td>
          <td data-label="Required">${f.isRequired ? 'yes' : 'no'}</td>
          <td data-label=""><button type="button" class="admin-btn-danger admin-btn-sm remove-field" data-id="${f.id}">Remove</button></td>
        </tr>`).join('') || '<tr><td colspan="5" data-label="">No fields yet.</td></tr>';

      renderPlaceholdersReference();
      renderEmailPlaceholdersReference();

      document.querySelectorAll('.remove-field').forEach(btn => {
        btn.addEventListener('click', async () => {
          const res = await window.adminFetch(`/api/admin/website-types/${typeId}/fields/${btn.dataset.id}`, { method: 'DELETE' });
          if (res.ok) loadFields();
        });
      });
    }

    document.getElementById('addFieldForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const dropdownOptions = form.dropdownOptions.value
        ? form.dropdownOptions.value.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/fields`, {
        method: 'POST',
        body: JSON.stringify({
          fieldKey: form.fieldKey.value,
          fieldLabel: form.fieldLabel.value,
          fieldType: form.fieldType.value,
          placeholderText: form.placeholderText.value,
          isRequired: form.isRequired.checked,
          dropdownOptions
        })
      });
      if (res.ok) {
        form.reset();
        toggleDropdownOptionsRow();
        loadFields();
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to add field.');
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
        currentFields.length ? currentFields.map(placeholderTokenForField).join(', ') : 'none defined yet — add raw fields first';

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

    document.getElementById('outputTypeSelect').addEventListener('change', (e) => {
      document.getElementById('objectShapeRow').style.display = e.target.value === 'array_of_objects' ? 'block' : 'none';
    });

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
        document.getElementById('objectShapeRow').style.display = 'none';
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
      document.getElementById('currentEmailVersion').textContent = data.active ? 'v' + data.active.version : 'none yet — generic fallback email is used';
      document.getElementById('emailSubject').value = data.active ? data.active.subject : '';
      document.getElementById('emailHtmlBody').value = data.active ? data.active.htmlBody : '';
      document.getElementById('emailHistoryTableBody').innerHTML = data.history.map(h => `
        <tr>
          <td data-label="Version">v${h.version}</td>
          <td data-label="Created">${new Date(h.createdAt).toLocaleString()}</td>
          <td data-label="">${data.active && data.active.version === h.version ? '' : `<button type="button" class="admin-btn-outline admin-btn-sm rollback-email" data-version="${h.version}">Rollback to this</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="3" data-label="">No versions yet — the generic fallback email is used.</td></tr>';

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

    loadFields().then(loadAiConfig);
    loadTemplate();
    loadEmailTemplate();
  }

  // ---- overview page ----
  function initOverviewPage() {
    const container = document.getElementById('statsContainer');

    window.adminFetch('/api/admin/dashboard/stats')
      .then(res => res.json())
      .then(stats => {
        const breakdownRows = stats.breakdown.map(b => `
          <tr>
            <td data-label="Type">${escapeHtml(b.name)}</td>
            <td data-label="Deployments">${b.deploymentCount}</td>
            <td data-label="Revenue">$${b.revenueUsd.toFixed(2)}</td>
          </tr>`).join('') || '<tr><td colspan="3" data-label="">No website types yet.</td></tr>';

        container.innerHTML = `
          <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div class="admin-card">
              <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Payments</p>
              ${stats.paystackConfigured
                ? `<p class="mt-2"><span class="admin-badge ${stats.paystackMode === 'live' ? 'admin-badge-active' : 'admin-badge-warn'}">${escapeHtml(stats.paystackMode)}</span></p>`
                : '<p class="admin-msg admin-msg-warning">Not configured yet.</p>'}
            </div>

            <div class="admin-card">
              <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">AI Provider</p>
              ${stats.activeProvider
                ? `<p class="mt-2 text-sm text-slate-700">${escapeHtml(stats.activeProvider.label)}<br><span class="text-slate-400">${escapeHtml(stats.activeProvider.selectedModel || 'no model selected')}</span></p>`
                : '<p class="admin-msg admin-msg-warning">No active provider.</p>'}
            </div>

            <div class="admin-card">
              <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Website Types</p>
              <p class="mt-2 text-2xl font-semibold text-hc-ink">${stats.activeTypeCount}</p>
              <p class="text-sm text-slate-400">${stats.inactiveTypeCount} inactive</p>
            </div>

            <div class="admin-card">
              <p class="text-xs font-semibold uppercase tracking-wide text-slate-400">Deployments</p>
              <p class="mt-2 text-2xl font-semibold text-hc-ink">${stats.totalDeployments}</p>
              <p class="text-sm text-slate-400">$${stats.totalRevenueUsd.toFixed(2)} revenue &middot; ${stats.subscriberCount} subscriber(s)</p>
            </div>
          </div>

          <div class="admin-table-wrap mt-6">
            <table class="admin-table is-responsive-stack">
              <thead><tr><th>Type</th><th>Deployments</th><th>Revenue</th></tr></thead>
              <tbody>${breakdownRows}</tbody>
            </table>
          </div>
        `;
      })
      .catch(() => {
        container.innerHTML = '<p class="admin-msg admin-msg-error">Failed to load stats.</p>';
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
        return d.amountUsd !== null ? `~$${Number(d.amountUsd).toFixed(2)} (est.)` : '—';
      }

      document.getElementById('deploymentsTableBody').innerHTML = data.deployments.map(d => `
        <tr>
          <td data-label="Client">${escapeHtml(d.clientEmail)}</td>
          <td data-label="Type">${escapeHtml(d.websiteTypeName || '—')}</td>
          <td data-label="Site"><a href="${escapeHtml(d.siteUrl)}" target="_blank" rel="noopener" class="text-hc-blue underline">${escapeHtml(d.siteUrl)}</a></td>
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
          <td data-label="Status"><span class="admin-badge ${s.optedOut ? '' : 'admin-badge-active'}">${s.optedOut ? 'opted out' : 'subscribed'}</span></td>
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
        : '—';
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
          <td data-label="Type">${escapeHtml(p.websiteTypeName || '—')}</td>
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
            resultEl.className = 'retry-result text-xs text-emerald-600';
            resultEl.innerHTML = `Deployed: <a href="${escapeHtml(data.siteUrl)}" target="_blank" rel="noopener" class="underline">${escapeHtml(data.siteUrl)}</a>`;
            setTimeout(load, 1500);
          } else if (data.outcome === 'not_paid') {
            resultEl.className = 'retry-result text-xs text-amber-600';
            resultEl.textContent = 'Payment not verified — nothing was changed.';
            btn.disabled = false;
            btn.textContent = 'Check & Deploy';
          } else if (data.outcome === 'not_found') {
            resultEl.className = 'retry-result text-xs text-amber-600';
            resultEl.textContent = 'This reference no longer exists.';
            btn.disabled = false;
            btn.textContent = 'Check & Deploy';
          } else {
            resultEl.className = 'retry-result text-xs text-red-600';
            resultEl.textContent = data.error || 'Something went wrong — nothing was changed.';
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
            ? `<span class="ml-2 text-xs font-medium text-red-500">↓ ${s.dropOffPct}% drop-off</span>`
            : s.dropOffPct < 0
              ? `<span class="ml-2 text-xs font-medium text-hc-blue">↑ grew ${Math.abs(s.dropOffPct)}%</span>`
              : `<span class="ml-2 text-xs font-medium text-emerald-600">no drop-off</span>`;
        return `
          <div class="mb-4 last:mb-0">
            <div class="mb-1 flex items-baseline justify-between">
              <span class="text-sm font-medium text-hc-ink">${escapeHtml(s.label)}</span>
              <span class="text-sm text-slate-500">${s.count}${dropOffHtml}</span>
            </div>
            <div class="h-3 w-full overflow-hidden rounded-full bg-slate-100">
              <div class="h-full rounded-full bg-hc-blue" style="width:${widthPct}%"></div>
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
          og_image_url: form.og_image_url.value
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
            ${s.isActive ? '<span class="admin-badge admin-badge-active">Active</span>' : '<span class="admin-badge">Inactive</span>'}
          </div>
          <pre class="mt-2 whitespace-pre-wrap break-all rounded-md bg-slate-50 p-2 font-mono text-xs">${truncatedHtml(s.scriptContent)}</pre>
          <div class="mt-3 flex flex-wrap gap-2">
            <button type="button" class="admin-btn-outline admin-btn-sm toggle-script" data-id="${s.id}" data-active="${s.isActive}">${s.isActive ? 'Deactivate' : 'Activate'}</button>
            <button type="button" class="admin-btn-danger admin-btn-sm remove-script" data-id="${s.id}">Remove</button>
          </div>
        </div>`).join('') || '<p class="mt-2 text-sm text-slate-400">No scripts in this section yet.</p>';

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
  function initLandingPagePage() {
    async function load() {
      const res = await window.adminFetch('/api/admin/landing');
      const data = await res.json();

      const form = document.getElementById('contentForm');
      form.heroHeadline.value = data.content.heroHeadline;
      form.heroTagline.value = data.content.heroTagline;
      form.heroCtaText.value = data.content.heroCtaText;
      form.trustLineText.value = data.content.trustLineText;
      form.footerText.value = data.content.footerText;

      renderSteps(data.steps);
      renderFooterLinks(data.footerLinks);
    }

    document.getElementById('contentForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/landing/content', {
        method: 'PUT',
        body: JSON.stringify({
          heroHeadline: form.heroHeadline.value,
          heroTagline: form.heroTagline.value,
          heroCtaText: form.heroCtaText.value,
          trustLineText: form.trustLineText.value,
          footerText: form.footerText.value
        })
      });
      const statusEl = document.getElementById('contentStatus');
      statusEl.style.display = 'block';
      statusEl.className = 'admin-msg ' + (res.ok ? 'admin-msg-success' : 'admin-msg-error');
      statusEl.textContent = res.ok ? 'Saved.' : 'Failed to save.';
    });

    // ---- steps ----
    function renderSteps(steps) {
      const list = document.getElementById('stepsList');
      list.innerHTML = steps.map((s, i) => `
        <div class="flex items-start gap-3 rounded-md border border-slate-200 p-3" data-id="${s.id}">
          <div class="flex shrink-0 flex-col gap-1">
            <button type="button" class="admin-btn-outline admin-btn-sm move-up" data-id="${s.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="admin-btn-outline admin-btn-sm move-down" data-id="${s.id}" ${i === steps.length - 1 ? 'disabled' : ''}>↓</button>
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-hc-ink">${escapeHtml(s.title)} <span class="font-mono text-xs font-normal text-slate-400">(${escapeHtml(s.iconName)})</span></p>
            <p class="mt-1 text-sm text-slate-500">${escapeHtml(s.description)}</p>
          </div>
          <button type="button" class="admin-btn-danger admin-btn-sm shrink-0 remove-step" data-id="${s.id}">Remove</button>
        </div>`).join('') || '<p class="text-sm text-slate-400">No steps yet.</p>';

      list.querySelectorAll('.move-up').forEach(btn => btn.addEventListener('click', () => moveStep(btn.dataset.id, 'up')));
      list.querySelectorAll('.move-down').forEach(btn => btn.addEventListener('click', () => moveStep(btn.dataset.id, 'down')));
      list.querySelectorAll('.remove-step').forEach(btn => btn.addEventListener('click', () => removeStep(btn.dataset.id)));
    }

    async function moveStep(id, direction) {
      const res = await window.adminFetch(`/api/admin/landing/steps/${id}/move`, {
        method: 'PUT',
        body: JSON.stringify({ direction })
      });
      if (res.ok) load();
    }

    async function removeStep(id) {
      if (!confirm('Remove this step?')) return;
      const res = await window.adminFetch(`/api/admin/landing/steps/${id}`, { method: 'DELETE' });
      if (res.ok) load();
    }

    document.getElementById('addStepForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const res = await window.adminFetch('/api/admin/landing/steps', {
        method: 'POST',
        body: JSON.stringify({
          iconName: form.iconName.value,
          title: form.title.value,
          description: form.description.value
        })
      });
      const statusEl = document.getElementById('stepStatus');
      if (res.ok) {
        form.reset();
        statusEl.style.display = 'none';
        load();
      } else {
        const data = await res.json();
        statusEl.style.display = 'block';
        statusEl.className = 'admin-msg admin-msg-error';
        statusEl.textContent = data.error || 'Failed to add step.';
      }
    });

    // ---- footer links ----
    function renderFooterLinks(links) {
      const list = document.getElementById('footerLinksList');
      list.innerHTML = links.map((l, i) => `
        <div class="flex items-center gap-3 rounded-md border border-slate-200 p-2.5" data-id="${l.id}">
          <div class="flex shrink-0 flex-col gap-1">
            <button type="button" class="admin-btn-outline admin-btn-sm move-up" data-id="${l.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="admin-btn-outline admin-btn-sm move-down" data-id="${l.id}" ${i === links.length - 1 ? 'disabled' : ''}>↓</button>
          </div>
          <div class="min-w-0 flex-1 text-sm">
            <span class="font-medium text-hc-ink">${escapeHtml(l.label)}</span>
            <span class="ml-2 text-slate-400">${escapeHtml(l.url)}</span>
          </div>
          <button type="button" class="admin-btn-danger admin-btn-sm shrink-0 remove-footer-link" data-id="${l.id}">Remove</button>
        </div>`).join('') || '<p class="text-sm text-slate-400">No footer links yet.</p>';

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
  });
})();
