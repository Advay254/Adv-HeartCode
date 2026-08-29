(function () {
  var STORAGE_PREFIX = 'heartcode_';

  function draftKey(slug) { return STORAGE_PREFIX + 'draft_' + slug; }
  function previewKey(slug) { return STORAGE_PREFIX + 'preview_' + slug; }
  // v1.0.9: carries the AI's raw output JSON (when this type is
  // AI-enabled) from the generate call through to checkout, the same way
  // previewKey already carries the rendered html — see routes/apiBuild.js
  // and lib/emailTemplates.js for why the email template needs this too.
  function aiOutputKey(slug) { return STORAGE_PREFIX + 'aiout_' + slug; }

  // Deliberately simple — just enough to catch obvious typos before a
  // network round trip. The server re-validates properly and is the only
  // check that actually matters.
  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function initBuildPage() {
    var slug = document.body.dataset.slug;
    var fieldMetaEl = document.getElementById('fieldKeysData');
    // v1.0.8: carries {key, type, required} per field now, not just a bare
    // key string — radio/checkboxes groups don't have one single DOM
    // element with a natural .value the way text/number/date/dropdown do,
    // so the collection logic below needs to know each field's type to
    // read (and later restore) its value correctly.
    var fieldMeta = fieldMetaEl ? JSON.parse(fieldMetaEl.textContent) : [];

    var form = document.getElementById('buildForm');
    var errorEl = document.getElementById('formError');
    var submitBtn = document.getElementById('submitBtn');

    function getFieldValue(key, type) {
      if (type === 'radio') {
        var checked = document.querySelector('input[name="field_' + key + '"]:checked');
        return checked ? checked.value : '';
      }
      if (type === 'checkboxes') {
        var boxes = document.querySelectorAll('input[name="field_' + key + '"]:checked');
        return Array.prototype.map.call(boxes, function (el) { return el.value; });
      }
      var el = document.getElementById('field_' + key);
      return el ? el.value.trim() : '';
    }

    function setFieldValue(key, type, value) {
      if (type === 'radio') {
        var radio = document.querySelector('input[name="field_' + key + '"][value="' + CSS.escape(String(value)) + '"]');
        if (radio) radio.checked = true;
        return;
      }
      if (type === 'checkboxes') {
        var selected = Array.isArray(value) ? value : [];
        var boxes = document.querySelectorAll('input[name="field_' + key + '"]');
        boxes.forEach(function (box) {
          box.checked = selected.indexOf(box.value) !== -1;
        });
        return;
      }
      var el = document.getElementById('field_' + key);
      if (el && value !== undefined) el.value = value;
    }

    // Restore a draft from a previous visit or "back" navigation from preview.
    try {
      var raw = sessionStorage.getItem(draftKey(slug));
      if (raw) {
        var draft = JSON.parse(raw);
        if (draft.client_email) document.getElementById('client_email').value = draft.client_email;
        fieldMeta.forEach(function (f) {
          if (draft[f.key] !== undefined) setFieldValue(f.key, f.type, draft[f.key]);
        });
      }
    } catch (err) {
      // Corrupt/unreadable draft — ignore and start fresh.
    }

    function saveDraft() {
      var draft = { client_email: document.getElementById('client_email').value };
      fieldMeta.forEach(function (f) {
        draft[f.key] = getFieldValue(f.key, f.type);
      });
      try {
        sessionStorage.setItem(draftKey(slug), JSON.stringify(draft));
      } catch (err) {
        // sessionStorage full/unavailable — draft persistence is a nicety,
        // not a hard requirement, so this fails silently.
      }
    }

    form.addEventListener('input', saveDraft);
    form.addEventListener('change', saveDraft);

    function showError(text) {
      errorEl.textContent = text;
      errorEl.style.display = 'block';
    }

    function clearError() {
      errorEl.style.display = 'none';
    }

    function resetSubmitButton() {
      submitBtn.disabled = false;
      // v1.1.5 Part D: "Generate my site" read like a generic AI/builder
      // tool action rather than something someone building a personal
      // occasion site would say — changed here and in build.ejs's initial
      // button text (kept in sync deliberately; this is the only other
      // place that string appears).
      submitBtn.textContent = 'Build my site';
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
      fieldMeta.forEach(function (f) {
        var val = getFieldValue(f.key, f.type);
        values[f.key] = val;
        var isEmpty = f.type === 'checkboxes' ? val.length === 0 : !val;
        if (f.required && isEmpty) missing.push(f.key);
      });

      if (missing.length > 0) {
        showError('Please fill in all required fields.');
        return;
      }

      saveDraft();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Building…';

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
            // aiOutputValues is only present for AI-enabled types (see
            // routes/apiBuild.js) — clear any stale value from a previous
            // draft/type before conditionally re-setting it, so a
            // non-AI type never carries forward a leftover value.
            sessionStorage.removeItem(aiOutputKey(slug));
            if (result.data.aiOutputValues) {
              sessionStorage.setItem(aiOutputKey(slug), JSON.stringify(result.data.aiOutputValues));
            }
          } catch (err) {
            showError('Your browser blocked local storage, so the preview can\'t be shown. Please enable storage and try again.');
            resetSubmitButton();
            return;
          }
          // v1.1.0 Part B: fired only on an actually-successful generate
          // response, from public/funnel.js's globally-exposed helper —
          // guarded in case that script somehow failed to load, since
          // analytics must never be what breaks the build flow.
          if (typeof window.hcTrackEvent === 'function') {
            window.hcTrackEvent('preview_generated', document.body.dataset.websiteTypeId);
          }
          window.location.href = '/build/' + encodeURIComponent(slug) + '/preview';
        })
        .catch(function () {
          showError('Network error. Please try again.');
          resetSubmitButton();
        });
    });
  }

  // v1.1.5 Part A: preview-only additions injected into the iframe's OWN
  // srcdoc html string — NOT reached into from outside afterward. This is
  // deliberate, not just a style choice: the iframe's sandbox no longer
  // includes allow-same-origin (see views/public/preview.ejs's own
  // comment on the sandbox attribute), so this parent page's JS has no
  // way to reach iframe.contentDocument even if it wanted to — the only
  // way to add behavior INSIDE the iframe's own document is to put it in
  // the HTML string before it's ever assigned to srcdoc.

  // Small, subtle, low-opacity corner badge — visible enough to notice,
  // not obtrusive enough to interfere with actually experiencing the
  // preview. pointer-events:none so it can never intercept a click meant
  // for the real page underneath it.
  function buildPreviewWatermarkHtml() {
    return '<div style="position:fixed;bottom:10px;right:10px;z-index:2147483647;pointer-events:none;' +
      'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;font-size:11px;font-weight:600;' +
      'letter-spacing:0.05em;color:rgba(0,0,0,0.35);background:rgba(255,255,255,0.55);padding:4px 10px;' +
      'border-radius:999px;">PREVIEW</div>';
  }

  // Casual, opportunistic-copying deterrent ONLY — not real protection,
  // and never described as such anywhere in this app's own copy (see
  // this version's delivery notes). Blocks the right-click context menu
  // and a few common "view/inspect source" keyboard shortcuts; does
  // nothing against the browser's own dev menu, a view-source: URL typed
  // directly, or anyone who knows another way in. Runs INSIDE the
  // iframe's own document (via allow-scripts) so it actually applies to
  // the generated site's content, not just this page's outer chrome — see
  // initPreviewPage below for the matching parent-page-level listener
  // that covers everything OUTSIDE the iframe.
  function buildPreviewDeterrentScript() {
    return '<script>(function(){' +
      "document.addEventListener('contextmenu',function(e){e.preventDefault();});" +
      "document.addEventListener('keydown',function(e){" +
      "var k=(e.key||'').toLowerCase();" +
      "if(k==='f12'){e.preventDefault();return;}" +
      "if((e.ctrlKey||e.metaKey)&&e.shiftKey&&k==='i'){e.preventDefault();return;}" +
      "if((e.ctrlKey||e.metaKey)&&k==='u'){e.preventDefault();return;}" +
      '});' +
      '})();</script>';
  }

  function injectPreviewExtras(html) {
    var extras = buildPreviewWatermarkHtml() + buildPreviewDeterrentScript();
    return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, extras + '</body>') : html + extras;
  }

  // Whitespace-only minification — NOT real minification (no attribute
  // reordering, no comment-aware edge cases beyond what's handled below).
  // The entire point is friction ("makes casual copy-paste-and-reuse
  // meaningfully less pleasant" per this feature's own spec), not
  // compression or protection — a determined person can trivially
  // reformat minified HTML back to readable form with any online
  // "beautify" tool in seconds. <script>/<style>/<pre>/<textarea>
  // contents are protected from whitespace collapsing (swapped for
  // placeholders before collapsing, restored after) since collapsing
  // whitespace inside those can change actual behavior or displayed
  // content, not just formatting.
  function minifyHtmlForPreview(html) {
    var protectedBlocks = [];
    var withPlaceholders = html.replace(/<(script|style|pre|textarea)\b[^>]*>[\s\S]*?<\/\1>/gi, function (block) {
      protectedBlocks.push(block);
      return '\u0000HC_PROTECTED_' + (protectedBlocks.length - 1) + '\u0000';
    });

    var collapsed = withPlaceholders
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/>\s+</g, '><')
      .trim();

    return collapsed.replace(/\u0000HC_PROTECTED_(\d+)\u0000/g, function (m, i) {
      return protectedBlocks[Number(i)];
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
    // sandbox="allow-scripts allow-popups allow-forms", deliberately
    // WITHOUT allow-same-origin — see the matching comment on the
    // <iframe> tag itself in views/public/preview.ejs for the full
    // reasoning (this is a documented sandbox-escape footgun to avoid,
    // not an oversight).
    iframe.srcdoc = minifyHtmlForPreview(injectPreviewExtras(html));

    var backBtn = document.getElementById('backBtn');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        window.location.href = '/build/' + encodeURIComponent(slug);
      });
    }

    // Fullscreen toggle — native Fullscreen API on the WRAPPER div (see
    // public/site.css's :fullscreen rules), not the iframe directly, so
    // the wrapper's existing border/rounding is cleanly reset rather than
    // fighting the fullscreen element's own UA styling. This is IN
    // ADDITION to nothing else — there is no pre-existing "mobile-frame
    // expand/collapse toggle" anywhere in this codebase to sit alongside;
    // this is the only frame-size control this page has ever had. (Flagged
    // explicitly rather than silently built as if replacing something —
    // see this version's delivery notes.)
    var fullscreenBtn = document.getElementById('fullscreenBtn');
    var frameWrap = document.getElementById('previewFrameWrap');
    if (fullscreenBtn && frameWrap) {
      fullscreenBtn.addEventListener('click', function () {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          if (document.exitFullscreen) document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } else if (frameWrap.requestFullscreen) {
          frameWrap.requestFullscreen();
        } else if (frameWrap.webkitRequestFullscreen) {
          frameWrap.webkitRequestFullscreen();
        }
      });
      var syncFullscreenLabel = function () {
        var isFullscreen = document.fullscreenElement === frameWrap || document.webkitFullscreenElement === frameWrap;
        fullscreenBtn.textContent = isFullscreen ? 'Exit fullscreen' : 'View fullscreen';
      };
      document.addEventListener('fullscreenchange', syncFullscreenLabel);
      document.addEventListener('webkitfullscreenchange', syncFullscreenLabel);
    }

    // Casual copy-protection deterrent, PARENT-page half (see
    // buildPreviewDeterrentScript above for the matching iframe-content
    // half — the two are separate because the sandboxed iframe's document
    // is no longer reachable from here at all once allow-same-origin is
    // removed, so this page's own chrome needs its own listener). Same
    // "deterrent, not protection" caveat applies here too.
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('keydown', function (e) {
      var key = (e.key || '').toLowerCase();
      if (key === 'f12') { e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && key === 'i') { e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && key === 'u') { e.preventDefault(); return; }
    });
  }

  function initCheckoutPage() {
    var slug = document.body.dataset.slug;
    var html = sessionStorage.getItem(previewKey(slug));
    var draftRaw = sessionStorage.getItem(draftKey(slug));

    // No generated site or no draft in this session — nothing to check
    // out. Send them back to fill in the form rather than showing a
    // checkout page with nothing behind it.
    if (!html || !draftRaw) {
      window.location.href = '/build/' + encodeURIComponent(slug);
      return;
    }

    var draft;
    try {
      draft = JSON.parse(draftRaw);
    } catch (err) {
      window.location.href = '/build/' + encodeURIComponent(slug);
      return;
    }

    var payBtn = document.getElementById('payBtn');
    var errorEl = document.getElementById('checkoutError');

    function showError(text) {
      errorEl.textContent = text;
      errorEl.style.display = 'block';
    }

    function resetButton() {
      payBtn.disabled = false;
      payBtn.textContent = 'Pay Now';
    }

    payBtn.addEventListener('click', function () {
      errorEl.style.display = 'none';
      payBtn.disabled = true;
      payBtn.textContent = 'Processing…';

      var sitePasswordInput = document.getElementById('sitePassword');
      // v1.0.8 Part B: `draft` already holds every raw field value (it's
      // the exact object initBuildPage's saveDraft() wrote) — strip out
      // client_email (sent separately, not a template/slug field) and
      // forward the rest as rawFieldValues so lib/deploySlug.js has real
      // data to resolve a custom deploy_slug_pattern against, later, at
      // actual deploy time.
      var rawFieldValues = {};
      Object.keys(draft).forEach(function (key) {
        if (key !== 'client_email') rawFieldValues[key] = draft[key];
      });

      // v1.0.9: only present for AI-enabled types (see initBuildPage above)
      // — omitted from the payload entirely when absent, same as any other
      // optional field, rather than sending an explicit null.
      var aiOutputRaw = sessionStorage.getItem(aiOutputKey(slug));
      var aiOutputValues = null;
      if (aiOutputRaw) {
        try {
          aiOutputValues = JSON.parse(aiOutputRaw);
        } catch (err) {
          aiOutputValues = null;
        }
      }

      var payload = {
        renderedHtml: html,
        clientEmail: draft.client_email,
        sitePassword: sitePasswordInput ? sitePasswordInput.value : '',
        rawFieldValues: rawFieldValues
      };
      if (aiOutputValues) payload.aiOutputValues = aiOutputValues;
      // v1.1.0 Part B: threads this visit's anonymous funnel session id
      // through to pending_deployments.funnel_session_id, so the
      // server-side 'payment_completed' event (lib/finalizeDeployment.js
      // — deliberately never accepted from a client-submitted event, see
      // routes/events.js) can be attached to the same session as the rest
      // of this visit's funnel. Guarded the same way as hcTrackEvent
      // above — omitted entirely if funnel.js somehow isn't loaded, never
      // a reason to block checkout.
      if (typeof window.hcGetSessionId === 'function') {
        payload.sessionId = window.hcGetSessionId();
      }

      fetch('/build/' + encodeURIComponent(slug) + '/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (res) {
          return res.json().then(function (data) { return { ok: res.ok, data: data }; });
        })
        .then(function (result) {
          if (!result.ok) {
            showError(result.data.error || 'Could not start checkout. Please try again.');
            resetButton();
            return;
          }
          // Redirect to Paystack's hosted checkout page.
          window.location.href = result.data.authorizationUrl;
        })
        .catch(function () {
          showError('Network error. Please try again.');
          resetButton();
        });
    });
  }

  /**
   * v1.1.1 Part B: gates the deployment success page's site link(s) behind
   * a short countdown before they're actually clickable. The deployment
   * itself already finished server-side before this page ever rendered —
   * this is purely a buffer against a client tapping through the instant
   * the page loads and landing on a Cloudflare Pages edge that hasn't
   * finished propagating the new deployment yet, which would just look
   * like a broken link to them for no visible reason.
   *
   * Both the raw-URL text link and the "Visit your site" pill button share
   * the .hc-site-link class (see views/public/checkout-callback.ejs) so
   * there's exactly one enabled/disabled state, not two links that could
   * disagree. `aria-disabled`/`tabindex="-1"` are removed once the
   * countdown ends so keyboard/screen-reader users get the same gating as
   * a mouse click would (removed, not just toggled to "false", since a
   * plain link has neither attribute when enabled).
   */
  function initCheckoutCallbackPage() {
    var links = document.querySelectorAll('.hc-site-link');
    if (!links.length) return;

    var secondsEl = document.getElementById('siteLinkCountdownSeconds');
    var countdownEl = document.getElementById('siteLinkCountdown');
    var remaining = 20;

    function enableLinks() {
      links.forEach(function (link) {
        link.classList.remove('is-disabled');
        link.removeAttribute('aria-disabled');
        link.removeAttribute('tabindex');
      });
      if (countdownEl) countdownEl.textContent = 'Ready — tap above to visit your site.';
    }

    // Defense in depth alongside the CSS (pointer-events: none) and the
    // aria-disabled/tabindex attributes above — belt-and-suspenders in
    // case any of those don't apply for some reason (e.g. a browser
    // extension or assistive tech that dispatches a click directly).
    links.forEach(function (link) {
      link.addEventListener('click', function (event) {
        if (link.classList.contains('is-disabled')) event.preventDefault();
      });
    });

    var timer = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timer);
        enableLinks();
        return;
      }
      if (secondsEl) secondsEl.textContent = String(remaining);
    }, 1000);
  }

  /**
   * v1.1.2 Part C: resend-details public page. Deliberately renders
   * whatever generic message the server responds with verbatim — even on
   * a network/unexpected error, this shows a message rather than letting
   * the person infer anything from a blank state or a differently-worded
   * error, though a genuine network failure (no response at all) is the
   * one case where a distinct "something went wrong, try again" message
   * is shown, since at that point there's no server response to leak
   * anything from either way.
   */
  function initResendDetailsPage() {
    var form = document.getElementById('resendDetailsForm');
    var resultBox = document.getElementById('resendDetailsResult');
    var errorEl = document.getElementById('resendDetailsError');
    var submitBtn = document.getElementById('resendDetailsSubmitBtn');
    var emailInput = document.getElementById('resendEmail');

    submitBtn.addEventListener('click', function () {
      var email = emailInput.value.trim();
      errorEl.style.display = 'none';

      if (!email) {
        errorEl.textContent = 'Enter your email address.';
        errorEl.style.display = 'block';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';

      fetch('/api/resend-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      })
        .then(function (res) {
          return res.json().then(function (data) { return { status: res.status, ok: res.ok, data: data }; });
        })
        .then(function (result) {
          if (result.status === 429) {
            errorEl.textContent = result.data.error || "You've reached today's check limit — try again tomorrow.";
            errorEl.style.display = 'block';
            return;
          }
          if (!result.ok) {
            errorEl.textContent = result.data.error || 'Something went wrong. Please try again.';
            errorEl.style.display = 'block';
            return;
          }
          form.style.display = 'none';
          resultBox.querySelector('p').textContent = result.data.message;
          resultBox.style.display = 'block';
        })
        .catch(function () {
          errorEl.textContent = 'Network error. Please try again.';
          errorEl.style.display = 'block';
        })
        .then(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Resend my site details';
        });
    });
  }

  /**
   * v1.1.3: the Skilline-styled landing page's mobile nav toggle
   * (views/partials/landing-sections/nav.ejs). The source template uses
   * Alpine.js (`x-data="{ open: false }"`) for this; this app has no
   * Alpine dependency anywhere else, so this is the plain-JS equivalent —
   * toggle a `.hidden` class on both the desktop-panel-hidden-on-mobile
   * nav and the separate stacked mobile panel, flip aria-expanded, and
   * swap which of the two icon <svg>s inside the toggle button is
   * visible. Two separate nav elements (not one reused via CSS) because
   * the desktop version needs a horizontal pill layout and the mobile
   * one needs a stacked list — see nav.ejs's own comment.
   */
  function initHomePage() {
    var toggleBtn = document.querySelector('[data-landing-nav-toggle]');
    if (!toggleBtn) return;
    var mobilePanel = document.getElementById('landing-nav-links-mobile');
    var iconOpen = document.querySelector('[data-landing-nav-icon-open]');
    var iconClose = document.querySelector('[data-landing-nav-icon-close]');

    toggleBtn.addEventListener('click', function () {
      var isOpen = toggleBtn.getAttribute('aria-expanded') === 'true';
      var next = !isOpen;
      toggleBtn.setAttribute('aria-expanded', String(next));
      if (mobilePanel) {
        mobilePanel.classList.toggle('hidden', !next);
        mobilePanel.classList.toggle('flex', next);
      }
      if (iconOpen) iconOpen.classList.toggle('hidden', next);
      if (iconClose) iconClose.classList.toggle('hidden', !next);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.dataset.page;
    if (page === 'home') initHomePage();
    if (page === 'build') initBuildPage();
    if (page === 'preview') initPreviewPage();
    if (page === 'checkout') initCheckoutPage();
    if (page === 'checkout-callback') initCheckoutCallbackPage();
    if (page === 'resend-details') initResendDetailsPage();
  });
})();
