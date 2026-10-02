// v1.2.12: behavior for the /testimonials broadcast banner. Sets a CONSTANT
// scrolling speed (pixels per second) so a short message and a long one both
// move at the same comfortable reading pace: the animation duration is the
// distance travelled divided by the speed. Pauses while touched (hover is
// handled in CSS). Does nothing when reduced motion is on (the CSS shows
// static wrapping text instead). No inline script exists on the page, which
// is what lets its CSP block inline scripts.
(function () {
  'use strict';

  var banner = document.getElementById('rvdBroadcast');
  if (!banner) return;
  var marquee = banner.querySelector('.rvd-marquee');
  var track = banner.querySelector('.rvd-track');
  if (!marquee || !track) return;

  var SPEED = Number(banner.getAttribute('data-speed')) || 60; // pixels per second
  var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

  function layout() {
    if (reduce && reduce.matches) return;
    marquee.style.removeProperty('--rvd-item-min');
    var first = track.querySelector('.rvd-item');
    if (!first) return;
    var natural = first.getBoundingClientRect().width;
    // Each of the two copies is at least as wide as the banner, so the loop
    // never shows a gap, however short the message is.
    var itemWidth = Math.max(natural, marquee.clientWidth);
    marquee.style.setProperty('--rvd-item-min', itemWidth + 'px');
    marquee.style.setProperty('--rvd-duration', (itemWidth / SPEED).toFixed(2) + 's');
  }

  var timer = null;
  window.addEventListener('resize', function () {
    clearTimeout(timer);
    timer = setTimeout(layout, 150);
  });
  if (reduce && reduce.addEventListener) reduce.addEventListener('change', layout);

  function pause() { marquee.classList.add('is-paused'); }
  function resume() { marquee.classList.remove('is-paused'); }
  marquee.addEventListener('touchstart', pause, { passive: true });
  marquee.addEventListener('touchend', resume, { passive: true });
  marquee.addEventListener('touchcancel', resume, { passive: true });

  layout();
})();
