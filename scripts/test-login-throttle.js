#!/usr/bin/env node
'use strict';

// Local test for lib/loginThrottle.js. No server, no database, no network.
//   node scripts/test-login-throttle.js

const throttle = require('../lib/loginThrottle');

let failures = 0;
function check(name, ok, info = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${info}`}`);
}

(async () => {
  process.env.LOGIN_SLOW_MODE_THRESHOLD = '20';
  const alerts = [];
  throttle.startThrottleSweep(async (payload) => { alerts.push(payload); });
  const t0 = Date.now();

  // per address lockout
  for (let i = 0; i < 4; i += 1) throttle.recordFailure('a', t0);
  check('4 failures: not locked', !throttle.isLockedOut('a', t0));
  throttle.recordFailure('a', t0);
  check('5th failure: locked', throttle.isLockedOut('a', t0 + 1000));
  check('lock ends after 15 minutes', !throttle.isLockedOut('a', t0 + 15 * 60 * 1000 + 1));
  throttle.resetThrottleForTests();

  // bounded memory
  for (let i = 0; i < 25000; i += 1) throttle.recordFailure(`addr-${i}`, t0);
  const stats = throttle.getThrottleStats();
  check(`tracked addresses never pass the cap (${stats.trackedAddresses} of ${throttle.MAX_TRACKED})`, stats.trackedAddresses <= throttle.MAX_TRACKED);
  check('the oldest address was dropped first', !throttle.isLockedOut('addr-0', t0) && throttle.getThrottleStats().trackedAddresses === throttle.MAX_TRACKED);
  throttle.sweep(t0 + 16 * 60 * 1000);
  check('scheduled sweep prunes old entries without anyone coming back', throttle.getThrottleStats().trackedAddresses === 0);
  throttle.resetThrottleForTests();
  alerts.length = 0;

  // global slow mode across many addresses
  for (let i = 0; i < 19; i += 1) throttle.recordFailure(`x-${i}`, t0);
  check('19 failures from 19 addresses: slow mode not yet on', !throttle.getThrottleStats().slowModeActive);
  throttle.recordFailure('x-19', t0);
  await new Promise((r) => setTimeout(r, 10));
  check('20th failure turns slow mode on', throttle.getThrottleStats().slowModeActive);
  check('exactly one "started" alert', alerts.length === 1 && alerts[0].event === 'login_slow_mode_started');
  throttle.recordFailure('x-20', t0);
  await new Promise((r) => setTimeout(r, 10));
  check('no second start alert while it stays on', alerts.length === 1);
  check('no address is locked out by slow mode alone', !throttle.isLockedOut('brand-new-address', t0));

  const started = Date.now();
  await throttle.applySlowModeDelay();
  check('every attempt now waits about 2 seconds', Date.now() - started >= 1900, `waited ${Date.now() - started} ms`);

  throttle.sweep(t0 + 16 * 60 * 1000);
  await new Promise((r) => setTimeout(r, 10));
  check('slow mode ends when failures age out', !throttle.getThrottleStats().slowModeActive);
  check('exactly one "ended" alert', alerts.length === 2 && alerts[1].event === 'login_slow_mode_ended');
  const text = JSON.stringify(alerts);
  check('alerts contain only counts and fixed wording (no usernames or passwords)', !/user|pass(?!word)|admin@/i.test(text.replace(/admin login|admin logins/gi, '')));

  console.log(failures === 0 ? '\nAll cases passed.' : `\n${failures} case(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
