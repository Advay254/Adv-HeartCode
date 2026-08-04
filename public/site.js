(function () {
  var STORAGE_PREFIX = 'heartcode_';

  function draftKey(slug) { return STORAGE_PREFIX + 'draft_' + slug; }
  function previewKey(slug) { return STORAGE_PREFIX + 'preview_' + slug; }

  // Deliberately simple — just enough to catch obvious typos before a
  // network round trip. The server re-validates properly and is the only
  // check that actually matters.
  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function initBuildPage() {
    var slug = document.body.dataset.slug;
    var fieldKeysEl = document.getElementById('fieldKeysData');
    var fieldKeys = fieldKeysEl ? JSON.parse(fieldKeysEl.textContent) : [];
    var form = document.getElementById('buildForm');
    var errorEl = document.getElementById('formError');
    var submitBtn = document.getElementById('submitBtn');

    // Restore a draft from a previous visit or "back" navigation from preview.
    try {
      var raw = sessionStorage.getItem(draftKey(slug));
      if (raw) {
        var draft = JSON.parse(raw);
        if (draft.client_email) document.getElementById('client_email').value = draft.client_email;
        fieldKeys.forEach(function (key) {
          var el = document.getElementById('field_' + key);
          if (el && draft[key] !== undefined) el.value = draft[key];
        });
      }
    } catch (err) {
      // Corrupt/unreadable draft — ignore and start fresh.
    }

    function saveDraft() {
      var draft = { client_email: document.getElementById('client_email').value };
      fieldKeys.forEach(function (key) {
        var el = document.getElementById('field_' + key);
        if (el) draft[key] = el.value;
      });
      try {
        sessionStorage.setItem(draftKey(slug), JSON.stringify(draft));
      } catch (err) {
        // sessionStorage full/unavailable — draft persistence is a nicety,
        // not a hard requirement, so this fails silently.
      }
    }

    form.addEventListener('input', saveDraft);

    function showError(text) {
      errorEl.textContent = text;
      errorEl.style.display = 'block';
    }

    function clearError() {
      errorEl.style.display = 'none';
    }

    function resetSubmitButton() {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Generate my site';
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearError();

      var email = document.getElementById('client_email').value.trim();
      if (!isValidEmail(email)) {
        showError('Please enter a valid email address.');
        return;
      }

      var values = { client_email: email };
      var missing = [];
      fieldKeys.forEach(function (key) {
        var el = document.getElementById('field_' + key);
        var val = el ? el.value.trim() : '';
        values[key] = val;
        if (el && el.required && !val) missing.push(key);
      });

      if (missing.length > 0) {
        showError('Please fill in all required fields.');
        return;
      }

      saveDraft();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Generating…';

      fetch('/api/build/' + encodeURIComponent(slug) + '/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values)
      })
        .then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok, data: data }; });
        })
        .then(function (result) {
          if (!result.ok) {
            showError(result.data.error || 'Something went wrong. Please try again.');
            resetSubmitButton();
            return;
          }
          try {
            sessionStorage.setItem(previewKey(slug), result.data.html);
          } catch (err) {
            showError('Your browser blocked local storage, so the preview can\'t be shown. Please enable storage and try again.');
            resetSubmitButton();
            return;
          }
          window.location.href = '/build/' + encodeURIComponent(slug) + '/preview';
        })
        .catch(function () {
          showError('Network error. Please try again.');
          resetSubmitButton();
        });
    });
  }

  function initPreviewPage() {
    var slug = document.body.dataset.slug;
    var html = sessionStorage.getItem(previewKey(slug));

    if (!html) {
      window.location.href = '/build/' + encodeURIComponent(slug);
      return;
    }

    var iframe = document.getElementById('previewFrame');
    // srcdoc (a string already in hand), not src (a URL to fetch).
    // sandbox="allow-same-origin" only, no allow-scripts: this is a
    // passive visual preview of static generated markup with no current
    // need for scripts to run inside it — the more restrictive default.
    iframe.srcdoc = html;

    var backBtn = document.getElementById('backBtn');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        window.location.href = '/build/' + encodeURIComponent(slug);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.dataset.page;
    if (page === 'build') initBuildPage();
    if (page === 'preview') initPreviewPage();
  });
})();
