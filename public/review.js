// v1.2.11: behavior for the public review page. Everything here is
// convenience only (live counters, inline messages):
// the server re-checks every rule and is the only enforcement that counts.
// No inline script exists on the page, which is what lets its CSP block
// inline scripts entirely.
(function () {
  'use strict';

  var form = document.getElementById('reviewForm');
  if (!form) return;

  var NAME_MAX = Number(form.dataset.nameMax);
  var TEXT_MAX = Number(form.dataset.textMax);
  var ACTION = form.dataset.action;
  var CSRF = form.dataset.csrf;

  var nameEl = document.getElementById('rvName');
  var textEl = document.getElementById('rvText');
  var submitBtn = document.getElementById('rvSubmit');
  var submitLabel = document.getElementById('rvSubmitLabel');
  var formAlert = document.getElementById('formAlert');

  var errorEls = {
    name: document.getElementById('rvNameError'),
    rating: document.getElementById('rvRatingError'),
    testimonial: document.getElementById('rvTextError')
  };

  function charCount(value) {
    return Array.from(value).length;
  }

  function bindCounter(input, counterId, max) {
    var counter = document.getElementById(counterId);
    function update() {
      var n = charCount(input.value);
      counter.textContent = n + ' / ' + max;
      counter.classList.toggle('is-over', n > max);
      counter.classList.toggle('is-near', n <= max && n >= max * 0.9);
    }
    input.addEventListener('input', update);
    update();
  }
  bindCounter(nameEl, 'rvNameCount', NAME_MAX);
  bindCounter(textEl, 'rvTextCount', TEXT_MAX);

  function setError(field, message) {
    var el = errorEls[field];
    if (!el) return;
    if (message) {
      el.textContent = message;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
    if (field === 'name') nameEl.classList.toggle('is-invalid', Boolean(message));
    if (field === 'testimonial') textEl.classList.toggle('is-invalid', Boolean(message));
  }

  function clearErrors() {
    Object.keys(errorEls).forEach(function (f) { setError(f, ''); });
    formAlert.hidden = true;
    formAlert.textContent = '';
  }

  function showInvalidLink() {
    // Same generic outcome the server gives for any invalid link.
    window.location.reload();
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearErrors();

    var checked = form.querySelector('input[name="rating"]:checked');
    var body = JSON.stringify({
      name: nameEl.value,
      rating: checked ? checked.value : '',
      testimonial: textEl.value
    });

    submitBtn.disabled = true;
    submitLabel.textContent = 'Sending...';

    fetch(ACTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF },
      body: body,
      credentials: 'same-origin'
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (r) {
        if (r.status === 201) {
          document.getElementById('reviewFormView').hidden = true;
          document.getElementById('reviewDoneView').hidden = false;
          window.scrollTo(0, 0);
          return;
        }
        if (r.status === 404) { showInvalidLink(); return; }

        submitBtn.disabled = false;
        submitLabel.textContent = 'Send review';

        if (r.data && r.data.errors) {
          Object.keys(r.data.errors).forEach(function (f) { setError(f, r.data.errors[f]); });
          var first = form.querySelector('.rv-error:not([hidden])');
          if (first && first.scrollIntoView) first.scrollIntoView({ block: 'center' });
          return;
        }
        formAlert.textContent = (r.data && r.data.error) || 'Something went wrong. Please try again.';
        formAlert.hidden = false;
      })
      .catch(function () {
        submitBtn.disabled = false;
        submitLabel.textContent = 'Send review';
        formAlert.textContent = 'We could not reach the server. Your review is still here, please try again.';
        formAlert.hidden = false;
      });
  });
})();
