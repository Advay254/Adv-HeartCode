#!/usr/bin/env node
'use strict';

// Local test for lib/clientIp.js. No live site, no database, no network.
//   node scripts/test-client-ip.js
// Prints PASS or FAIL for each case and exits with code 1 if any case fails.

const fs = require('fs');
const path = require('path');
const express = require('express');
const clientIp = require('../lib/clientIp');

// Use the exact proxy setting server.js uses, so this tests the real thing.
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const match = serverSource.match(/app\.set\('trust proxy', '([^']+)'\)/);
if (!match) {
  console.error('FAIL: could not find the trust proxy setting in server.js');
  process.exit(1);
}
const app = express();
app.set('trust proxy', match[1]);

// Builds a request the way Express would see it: a TCP peer address plus headers.
// req.ip is computed by Express itself from the trust proxy setting.
function makeReq(peer, headers) {
  const req = Object.create(app.request);
  req.app = app;
  req.headers = headers || {};
  req.socket = { remoteAddress: peer };
  req.connection = req.socket;
  return req;
}

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${actual}, wanted ${expected})`}`);
}

function runMode(mode) {
  if (mode === 'auto') delete process.env.CLIENT_IP_CLOUDFLARE;
  else process.env.CLIENT_IP_CLOUDFLARE = mode;
  clientIp.resetClientIpConfig();
  console.log(`\n--- mode: ${mode} ---`);
  const get = (peer, headers) => clientIp.getRealClientIp(makeReq(peer, headers));
  const believed = mode === 'auto';

  check('1. direct request with a forged CF-Connecting-IP header is refused',
    get('203.0.113.5', { 'cf-connecting-ip': '1.2.3.4' }), '203.0.113.5');

  check('2. request from a Cloudflare address with the header: ' + (believed ? 'header used' : 'header ignored'),
    get('104.23.241.68', { 'cf-connecting-ip': '198.51.100.9' }), believed ? '198.51.100.9' : '104.23.241.68');

  check('3. request from a Cloudflare address without the header uses the peer address',
    get('104.23.241.68', {}), '104.23.241.68');

  check('4. no proxy at all, plain visitor',
    get('198.51.100.20', {}), '198.51.100.20');

  check('5a. IPv6 Cloudflare peer with the header: ' + (believed ? 'header used' : 'header ignored'),
    get('2606:4700::6810:1', { 'cf-connecting-ip': '203.0.113.77' }), believed ? '203.0.113.77' : '2606:4700:0:0:0:0:6810:1');

  check('5b. IPv6 visitor, direct, forged header refused',
    get('2001:db8::25', { 'cf-connecting-ip': '1.2.3.4' }), '2001:db8:0:0:0:0:0:25');

  check('5c. IPv4-mapped IPv6 Cloudflare peer is recognised: ' + (believed ? 'header used' : 'header ignored'),
    get('::ffff:104.23.241.68', { 'cf-connecting-ip': '198.51.100.9' }), believed ? '198.51.100.9' : '104.23.241.68');

  check('6. forged X-Forwarded-For from a public visitor is ignored',
    get('203.0.113.5', { 'x-forwarded-for': '1.2.3.4' }), '203.0.113.5');

  check('6b. forged X-Forwarded-For plus forged CF header together are both ignored',
    get('203.0.113.5', { 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' }), '203.0.113.5');

  check('7. header with garbage text from a Cloudflare address falls back to the peer',
    get('104.23.241.68', { 'cf-connecting-ip': 'not-an-address' }), '104.23.241.68');

  check('8. no address at all gives the fixed placeholder',
    get(undefined, {}), clientIp.PLACEHOLDER);

  // A private proxy hop (a host's own load balancer) in front of a real visitor.
  check('9. private proxy hop: the public visitor address is used',
    get('10.0.0.5', { 'x-forwarded-for': '198.51.100.30' }), '198.51.100.30');

  check('10. private hop cannot be used to hide a forged leftmost X-Forwarded-For value',
    get('10.0.0.5', { 'x-forwarded-for': '9.9.9.9, 198.51.100.30' }), '198.51.100.30');
}

runMode('auto');
runMode('off');

// The override list replaces the built in one.
process.env.CLOUDFLARE_IP_RANGES = '192.0.2.0/24';
delete process.env.CLIENT_IP_CLOUDFLARE;
clientIp.resetClientIpConfig();
console.log('\n--- override list (CLOUDFLARE_IP_RANGES=192.0.2.0/24) ---');
check('11. an address in the override list is believed',
  clientIp.getRealClientIp(makeReq('192.0.2.7', { 'cf-connecting-ip': '198.51.100.9' })), '198.51.100.9');
check('12. a built in Cloudflare address is no longer believed once overridden',
  clientIp.getRealClientIp(makeReq('104.23.241.68', { 'cf-connecting-ip': '198.51.100.9' })), '104.23.241.68');

// IPv6 visitors share one counting key per /64.
delete process.env.CLOUDFLARE_IP_RANGES;
clientIp.resetClientIpConfig();
console.log('\n--- counting key ---');
check('13. two addresses in one IPv6 /64 share a counting key',
  clientIp.getRateLimitKey(makeReq('2001:db8:1:2::1', {})), clientIp.getRateLimitKey(makeReq('2001:db8:1:2:ffff::9', {})));
check('14. an IPv4 address is its own counting key',
  clientIp.getRateLimitKey(makeReq('198.51.100.20', {})), '198.51.100.20');

console.log(failures === 0 ? '\nAll cases passed.' : `\n${failures} case(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
