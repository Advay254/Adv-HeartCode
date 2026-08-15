// v1.0.7: shared micro-interactions for public-facing pages. Pure
// IntersectionObserver + CSS transitions for scroll-reveal (no
// JS-driven animation frames there — see [data-reveal]/.is-visible in
// src/styles/main.css) and requestAnimationFrame for the count-up numeric
// animation specifically, since animating a text number smoothly needs
// per-frame control that a CSS transition can't give a plain text node.
// One shared IntersectionObserver instance handles both — a page with a
// dozen reveal targets and a stats counter doesn't need a dozen separate
// observers.
(function () {
  'use strict';

  var prefersReducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function easeOutQuad(t) {
    return t * (2 - t);
  }

  function runCountUp(el) {
    var target = parseInt(el.getAttribute('data-countup'), 10);
    if (!isFinite(target)) return;

    if (prefersReducedMotion) {
      el.textContent = target.toLocaleString();
      return;
    }

    var duration = 1500;
    var start = null;

    function step(timestamp) {
      if (start === null) start = timestamp;
      var elapsed = timestamp - start;
      var progress = Math.min(elapsed / duration, 1);
      var eased = easeOutQuad(progress);
      var current = Math.round(target * eased);
      el.textContent = current.toLocaleString();
      if (progress < 1) {
        window.requestAnimationFrame(step);
      }
    }

    window.requestAnimationFrame(step);
  }

  function handleIntersect(entries, observer) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;

      if (entry.target.hasAttribute('data-reveal')) {
        entry.target.classList.add('is-visible');
      }
      if (entry.target.hasAttribute('data-countup')) {
        runCountUp(entry.target);
      }

      // Both effects are one-shot (reveal-on-first-view, count up once) —
      // no reason to keep observing an element that's already done its
      // one job.
      observer.unobserve(entry.target);
    });
  }

  function init() {
    var targets = document.querySelectorAll('[data-reveal], [data-countup]');
    if (targets.length === 0) return;

    if (!('IntersectionObserver' in window)) {
      // No IntersectionObserver support — show everything immediately
      // rather than leaving reveal targets permanently invisible.
      targets.forEach(function (el) {
        el.classList.add('is-visible');
        if (el.hasAttribute('data-countup')) runCountUp(el);
      });
      return;
    }

    var observer = new IntersectionObserver(handleIntersect, {
      threshold: 0.15,
      rootMargin: '0px 0px -10% 0px'
    });

    targets.forEach(function (el) {
      observer.observe(el);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
