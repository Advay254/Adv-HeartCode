'use strict';

// Cloudflare's own published address ranges (the addresses its edge servers
// connect FROM). Used only by lib/clientIp.js, to decide whether a request
// really arrived through Cloudflare before the CF-Connecting-IP header is
// believed.
//
// Source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
// Fetched: 2026-10-21 (v1.2.17).
//
// Cloudflare changes this list rarely, and announces changes on those two
// pages. To use a newer list WITHOUT a code change, set the environment
// variable CLOUDFLARE_IP_RANGES to a comma or space separated list of CIDR
// ranges (IPv4 and IPv6); when it is set it REPLACES the list below.
// Re-check the two pages above now and then.

const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22'
];

const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32'
];

module.exports = { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 };
