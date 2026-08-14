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
  function initNav() {
    const toggle = document.getElementById('navToggle');
    const links = document.getElementById('navLinks');
    if (toggle && links) {
      toggle.addEventListener('click', function () {
        links.classList.toggle('open');
      });
    }

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
      statusMsg.className = 'msg msg-' + type;
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
      modeBadge.className = 'badge ' + (cfg.mode === 'live' ? 'badge-live' : 'badge-test');
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
      statusEl.className = 'msg ' + (res.ok ? 'msg-success' : 'msg-error');
      statusEl.textContent = res.ok ? 'Saved.' : 'Failed to save.';
    });

    load();
    loadKenyanCurrency();
  }

  // ---- AI provider page ----
  function initAiProviderPage() {
    const providersList = document.getElementById('providersList');

    function providerCard(p) {
      const keyRows = p.keys.map(k => `
        <tr>
          <td>${escapeHtml(k.masked || 'unreadable')}</td>
          <td>${escapeHtml(k.priority)}</td>
          <td><button type="button" class="btn-danger remove-key" data-provider="${p.id}" data-key="${k.id}">Remove</button></td>
        </tr>`).join('');

      return `
      <div class="card" data-provider-id="${p.id}">
        <h2>${escapeHtml(p.label)} ${p.isActive ? '<span class="badge badge-active">active</span>' : ''}</h2>
        <p style="color:var(--text-dim);">${escapeHtml(p.baseUrl)}</p>

        <label>Model
          <select class="model-select">
            ${p.selectedModel ? `<option value="${escapeHtml(p.selectedModel)}" selected>${escapeHtml(p.selectedModel)}</option>` : '<option value="">-- none selected --</option>'}
          </select>
        </label>
        <button type="button" class="btn-secondary fetch-models">Load available models</button>

        <p style="margin-top:0.75rem;">
          <button type="button" class="save-model">Save model</button>
          <button type="button" class="${p.isActive ? 'btn-secondary' : ''} set-active">${p.isActive ? 'Active provider' : 'Set as active'}</button>
          <button type="button" class="btn-danger delete-provider">Delete provider</button>
        </p>

        <h3>Keys</h3>
        <table>
          <thead><tr><th>Key</th><th>Priority</th><th></th></tr></thead>
          <tbody>${keyRows || '<tr><td colspan="3">No keys yet</td></tr>'}</tbody>
        </table>
        <form class="add-key-form">
          <label>New key <input type="password" name="key" required></label>
          <label>Priority (lower = tried first) <input type="number" name="priority" value="0"></label>
          <button type="submit" style="margin-top:0.5rem;">Add key</button>
        </form>
        <p class="status-msg msg" style="display:none;"></p>
      </div>`;
    }

    function showStatus(card, text, type) {
      const el = card.querySelector('.status-msg');
      el.textContent = text;
      el.className = 'msg msg-' + type;
      el.style.display = 'block';
    }

    async function load() {
      const res = await window.adminFetch('/api/admin/ai-providers');
      const providers = await res.json();
      providersList.innerHTML = providers.map(providerCard).join('') || '<p class="msg msg-warning">No providers configured yet.</p>';
      wireCards();
    }

    function wireCards() {
      document.querySelectorAll('.card[data-provider-id]').forEach(card => {
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

  // ---- website types: list page ----
  function initWebsiteTypesIndexPage() {
    const slug = document.body.dataset.slug;

    async function load() {
      const res = await window.adminFetch('/api/admin/website-types');
      const types = await res.json();
      document.getElementById('typesTableBody').innerHTML = types.map(t => `
        <tr>
          <td><a href="/${slug}/website-types/${t.id}">${escapeHtml(t.name)}</a></td>
          <td><span class="badge ${t.isActive ? 'badge-active' : 'badge-inactive'}">${t.isActive ? 'active' : 'inactive'}</span></td>
          <td>${t.fieldCount}</td>
          <td>${t.activeTemplateVersion ? 'v' + t.activeTemplateVersion : '—'}</td>
          <td>$${Number(t.priceUsd).toFixed(2)}${t.aiEnabled ? ' <span class="badge badge-active">AI</span>' : ''}</td>
          <td><button type="button" class="btn-danger delete-type" data-id="${t.id}">Delete</button></td>
        </tr>`).join('') || '<tr><td colspan="6">No website types yet.</td></tr>';

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
          priceUsd: Number(form.priceUsd.value) || 0
        })
      });
      const data = await res.json();
      if (res.ok) {
        form.reset();
        statusEl.style.display = 'none';
        load();
      } else {
        statusEl.textContent = data.error || 'Failed to create website type.';
        statusEl.className = 'msg msg-error';
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

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).style.display = 'block';
      });
    });

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
          isActive: form.isActive.checked
        })
      });
      const statusEl = document.getElementById('detailsStatus');
      statusEl.style.display = 'block';
      statusEl.className = 'msg ' + (res.ok ? 'msg-success' : 'msg-error');
      statusEl.textContent = res.ok ? 'Saved.' : 'Failed to save.';
    });

    async function loadFields() {
      const res = await window.adminFetch(`/api/admin/website-types/${typeId}/fields`);
      const fields = await res.json();
      currentFields = fields;
      document.getElementById('fieldsTableBody').innerHTML = fields.map(f => `
        <tr>
          <td>{{${escapeHtml(f.fieldKey)}}}</td>
          <td>${escapeHtml(f.fieldLabel)}</td>
          <td>${escapeHtml(f.fieldType)}</td>
          <td>${f.isRequired ? 'yes' : 'no'}</td>
          <td><button type="button" class="btn-danger remove-field" data-id="${f.id}">Remove</button></td>
        </tr>`).join('') || '<tr><td colspan="5">No fields yet.</td></tr>';

      renderPlaceholdersReference();

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
          <td>v${h.version}</td>
          <td>${new Date(h.createdAt).toLocaleString()}</td>
          <td>${data.active && data.active.version === h.version ? '' : `<button type="button" class="btn-secondary rollback" data-version="${h.version}">Rollback to this</button>`}</td>
        </tr>`).join('') || '<tr><td colspan="3">No versions yet.</td></tr>';

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
        statusEl.className = 'msg ' + (warnings.length ? 'msg-warning' : 'msg-success');
        statusEl.textContent = warnings.length
          ? `Saved as v${data.version}, but: ${warnings.join(' | ')}`
          : `Saved as v${data.version}.`;
        loadTemplate();
      } else {
        statusEl.className = 'msg msg-error';
        statusEl.textContent = data.error || 'Failed to save template.';
      }
    });

    // ---- AI tab (v1.0.6) ----

    function renderOutputFieldsTable() {
      document.getElementById('outputFieldsTableBody').innerHTML = currentOutputFields.map(f => `
        <tr>
          <td>${escapeHtml(placeholderTokenForOutput(f))}</td>
          <td>${escapeHtml(f.outputType)}</td>
          <td>${escapeHtml(f.description || '')}</td>
          <td><button type="button" class="btn-danger remove-output-field" data-id="${f.id}">Remove</button></td>
        </tr>`).join('') || '<tr><td colspan="4">No output fields yet.</td></tr>';

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
      statusEl.className = 'msg ' + (res.ok ? 'msg-success' : 'msg-error');
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

    loadFields().then(loadAiConfig);
    loadTemplate();
  }

  // ---- overview page ----
  function initOverviewPage() {
    const container = document.getElementById('statsContainer');

    window.adminFetch('/api/admin/dashboard/stats')
      .then(res => res.json())
      .then(stats => {
        const breakdownRows = stats.breakdown.map(b => `
          <tr>
            <td>${escapeHtml(b.name)}</td>
            <td>${b.deploymentCount}</td>
            <td>$${b.revenueUsd.toFixed(2)}</td>
          </tr>`).join('') || '<tr><td colspan="3">No website types yet.</td></tr>';

        container.innerHTML = `
          <div class="card">
            <h2>Payments</h2>
            ${stats.paystackConfigured
              ? `<p>Mode: <span class="badge ${stats.paystackMode === 'live' ? 'badge-live' : 'badge-test'}">${escapeHtml(stats.paystackMode)}</span></p>`
              : '<p class="msg msg-warning">Paystack is not configured yet.</p>'}
          </div>

          <div class="card">
            <h2>AI Provider</h2>
            ${stats.activeProvider
              ? `<p>${escapeHtml(stats.activeProvider.label)} — model: ${escapeHtml(stats.activeProvider.selectedModel || 'not selected')}</p>`
              : '<p class="msg msg-warning">No active AI provider configured.</p>'}
          </div>

          <div class="card">
            <h2>Website Types</h2>
            <p>${stats.activeTypeCount} active, ${stats.inactiveTypeCount} inactive</p>
          </div>

          <div class="card">
            <h2>Deployments</h2>
            <p>${stats.totalDeployments} total &middot; $${stats.totalRevenueUsd.toFixed(2)} revenue &middot; ${stats.subscriberCount} subscriber(s)</p>
          </div>

          <div class="card">
            <h2>Revenue by website type</h2>
            <table>
              <thead><tr><th>Type</th><th>Deployments</th><th>Revenue</th></tr></thead>
              <tbody>${breakdownRows}</tbody>
            </table>
          </div>
        `;
      })
      .catch(() => {
        container.innerHTML = '<p class="msg msg-error">Failed to load stats.</p>';
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
          <td>${escapeHtml(d.clientEmail)}</td>
          <td>${escapeHtml(d.websiteTypeName || '—')}</td>
          <td><a href="${escapeHtml(d.siteUrl)}" target="_blank" rel="noopener">${escapeHtml(d.siteUrl)}</a></td>
          <td>${formatDeploymentAmount(d)}</td>
          <td>${formatDate(d.deployedAt)}</td>
        </tr>`).join('') || '<tr><td colspan="5">No deployments yet.</td></tr>';

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
          <td>${escapeHtml(s.email)}</td>
          <td>${formatDate(s.firstSeenAt)}</td>
          <td><span class="badge ${s.optedOut ? 'badge-inactive' : 'badge-active'}">${s.optedOut ? 'opted out' : 'subscribed'}</span></td>
          <td><button type="button" class="btn-secondary toggle-opt-out" data-email="${escapeHtml(s.email)}" data-opted-out="${s.optedOut}">${s.optedOut ? 'Re-subscribe' : 'Opt out'}</button></td>
        </tr>`).join('') || '<tr><td colspan="4">No subscribers yet.</td></tr>';

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

  document.addEventListener('DOMContentLoaded', function () {
    initNav();
    const page = document.body.dataset.page;
    if (page === 'login') initLoginPage();
    if (page === 'payments') initPaymentsPage();
    if (page === 'ai-provider') initAiProviderPage();
    if (page === 'website-types-index') initWebsiteTypesIndexPage();
    if (page === 'website-types-detail') initWebsiteTypesDetailPage();
    if (page === 'overview') initOverviewPage();
    if (page === 'submissions') initSubmissionsPage();
  });
})();
