// v1.2.11: behavior for the public review page. Everything here is
// convenience only (live counters, a local photo preview, inline messages):
// the server re-checks every rule and is the only enforcement that counts.
// No inline script exists on the page, which is what lets its CSP block
// inline scripts entirely.
(function () {
  'use strict';

  var form = document.getElementById('reviewForm');
  if (!form) return;

  var NAME_MAX = Number(form.dataset.nameMax);
  var TEXT_MAX = Number(form.dataset.textMax);
  var IMAGE_MAX = Number(form.dataset.imageMax);
  var ACTION = form.dataset.action;
  var CSRF = form.dataset.csrf;
  var ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  var nameEl = document.getElementById('rvName');
  var textEl = document.getElementById('rvText');
  var imageEl = document.getElementById('rvImage');
  var submitBtn = document.getElementById('rvSubmit');
  var submitLabel = document.getElementById('rvSubmitLabel');
  var formAlert = document.getElementById('formAlert');
  var imageFailedEl = document.getElementById('rvImageUploadFailed');
  var previewBox = document.getElementById('rvPreviewBox');
  var previewImg = document.getElementById('rvPreview');
  var imageNameEl = document.getElementById('rvImageName');
  var removeBtn = document.getElementById('rvImageRemove');
  var previewUrl = null;

  var errorEls = {
    name: document.getElementById('rvNameError'),
    rating: document.getElementById('rvRatingError'),
    testimonial: document.getElementById('rvTextError'),
    image: document.getElementById('rvImageError')
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
    imageFailedEl.hidden = true;
    imageFailedEl.textContent = '';
  }

  function clearPhoto() {
    imageEl.value = '';
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    previewImg.removeAttribute('src');
    previewBox.hidden = true;
    removeBtn.hidden = true;
    imageNameEl.textContent = '';
  }

  imageEl.addEventListener('change', function () {
    setError('image', '');
    imageFailedEl.hidden = true;
    var file = imageEl.files && imageEl.files[0];
    if (!file) { clearPhoto(); return; }
    if (ALLOWED_TYPES.indexOf(file.type) === -1) {
      clearPhoto();
      setError('image', 'The photo must be a JPEG, PNG or WebP image.');
      return;
    }
    if (file.size > IMAGE_MAX) {
      clearPhoto();
      setError('image', 'The photo is too large. Please choose one under 5 MB.');
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    previewImg.src = previewUrl;
    imageNameEl.textContent = file.name;
    previewBox.hidden = false;
    removeBtn.hidden = false;
  });
  removeBtn.addEventListener('click', function () {
    clearPhoto();
    setError('image', '');
  });

  function showInvalidLink() {
    // Same generic outcome the server gives for any invalid link.
    window.location.reload();
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearErrors();

    var checked = form.querySelector('input[name="rating"]:checked');
    var body = new FormData();
    body.append('name', nameEl.value);
    body.append('rating', checked ? checked.value : '');
    body.append('testimonial', textEl.value);
    if (imageEl.files && imageEl.files[0]) body.append('image', imageEl.files[0]);

    submitBtn.disabled = true;
    submitLabel.textContent = 'Sending...';

    fetch(ACTION, {
      method: 'POST',
      headers: { 'X-CSRF-Token': CSRF },
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

        if (r.data && r.data.code === 'image_upload_failed') {
          // Keep every typed value. Drop the photo so a second press of the
          // button sends the review without it.
          clearPhoto();
          imageFailedEl.textContent = r.data.error;
          imageFailedEl.hidden = false;
          return;
        }
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
