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

  document.addEventListener('DOMContentLoaded', function () {
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
  });
})();
