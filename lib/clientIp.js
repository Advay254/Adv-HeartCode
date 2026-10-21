'use strict';

// The ONE place that works out a visitor's address. Every caller (rate limits,
// geolocation, analytics, the admin diagnostics) goes through this file, and
// nothing else in the app reads req.ip, X-Forwarded-For or CF-Connecting-IP.
//
// How it works (v1.2.17, replaces the v1.1.9 header-first rule):
//
// 1. server.js sets `trust proxy` to 'loopback, linklocal, uniquelocal'.
//    Express walks back through proxy hops whose address is private and stops
//    at the first public one, so req.ip is the address of the last PUBLIC
//    machine that connected to this app. A visitor cannot make a public
//    address look private, so this cannot be forged with X-Forwarded-For.
//
// 2. The CF-Connecting-IP header is only text any client can send. It is
//    believed ONLY when req.ip itself is inside Cloudflare's published ranges
//    (lib/cloudflareRanges.js), because only then did the request really come
//    through Cloudflare, which overwrites that header. Anywhere else (a direct
//    hit on the host's own address, no Cloudflare at all, another proxy) the
//    header is ignored completely and req.ip is used.
//
// 3. If nothing usable is found, a fixed placeholder is returned so limits
//    still apply to those requests instead of being skipped.
//
// Nothing here depends on Cloudflare, Render or any host: with Cloudflare
// absent the header is never believed, and the result is req.ip.
//
// Setting (environment): CLIENT_IP_CLOUDFLARE = auto (default, rule above) or
// off (never believe the header, always use req.ip). Any other value is
// treated as auto and reported once in the startup log.
// Optional override of the range list: CLOUDFLARE_IP_RANGES (see
// lib/cloudflareRanges.js).

const net = require('net');
const { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } = require('./cloudflareRanges');

const PLACEHOLDER = 'unknown-address';

// ---- address parsing (no dependencies) ----

function parseV4(text) {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(Number(p));
  }
  return n;
}

function parseV6(text) {
  let s = text;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (v4 === null) return null;
    s = s.slice(0, lastColon + 1) + ((v4 >> 16n) & 0xffffn).toString(16) + ':' + (v4 & 0xffffn).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** Returns { v: 4 | 6, n: BigInt } or null. IPv4-mapped IPv6 becomes IPv4. */
function parseIp(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  const kind = net.isIP(t);
  if (kind === 4) {
    const n = parseV4(t);
    return n === null ? null : { v: 4, n };
  }
  if (kind === 6) {
    const n = parseV6(t);
    if (n === null) return null;
    if ((n >> 32n) === 0xffffn) return { v: 4, n: n & 0xffffffffn }; // ::ffff:a.b.c.d
    return { v: 6, n };
  }
  return null;
}

function parseCidr(text) {
  const [addr, bitsText] = String(text).trim().split('/');
  const ip = parseIp(addr);
  if (!ip || bitsText === undefined || !/^\d{1,3}$/.test(bitsText)) return null;
  const bits = Number(bitsText);
  const width = ip.v === 4 ? 32 : 128;
  if (bits > width) return null;
  const shift = BigInt(width - bits);
  return { v: ip.v, prefix: ip.n >> shift, shift };
}

function cidrContains(cidr, ip) {
  return cidr.v === ip.v && (ip.n >> cidr.shift) === cidr.prefix;
}

// ---- configuration (read from the environment on first use) ----

let config = null;

function loadConfig() {
  const env = process.env;
  const rawMode = String(env.CLIENT_IP_CLOUDFLARE || '').trim().toLowerCase();
  const mode = rawMode === 'off' ? 'off' : 'auto';
  const modeValid = rawMode === '' || rawMode === 'auto' || rawMode === 'off';

  let sources;
  let rangesFrom = 'built in (lib/cloudflareRanges.js)';
  const override = String(env.CLOUDFLARE_IP_RANGES || '').trim();
  if (override) {
    sources = override.split(/[\s,]+/).filter(Boolean);
    rangesFrom = 'CLOUDFLARE_IP_RANGES';
  } else {
    sources = [...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6];
  }
  const ranges = [];
  const rejected = [];
  for (const s of sources) {
    const c = parseCidr(s);
    if (c) ranges.push(c); else rejected.push(s);
  }
  return { mode, modeValid, rawMode, ranges, rejected, rangesFrom };
}

function getConfig() {
  if (!config) config = loadConfig();
  return config;
}

/** For tests: forget the cached configuration so the environment is read again. */
function resetClientIpConfig() {
  config = null;
}

/** One line per problem, for the startup log. Empty when all is well. */
function describeConfigProblems() {
  const c = getConfig();
  const out = [];
  if (!c.modeValid) out.push(`CLIENT_IP_CLOUDFLARE="${c.rawMode.slice(0, 20)}" is not auto or off, so auto is used.`);
  if (c.rejected.length) out.push(`${c.rejected.length} entr${c.rejected.length === 1 ? 'y' : 'ies'} in CLOUDFLARE_IP_RANGES could not be read and were ignored.`);
  if (c.ranges.length === 0 && c.mode === 'auto') out.push('No Cloudflare ranges are loaded, so CF-Connecting-IP is never trusted.');
  return out;
}

function describeConfig() {
  const c = getConfig();
  return { mode: c.mode, rangesFrom: c.rangesFrom, rangeCount: c.ranges.length };
}

// ---- the helper ----

function isInCloudflare(ip) {
  return getConfig().ranges.some((r) => cidrContains(r, ip));
}

function cleanText(ip) {
  const parsed = parseIp(ip);
  if (!parsed) return null;
  if (parsed.v === 4) {
    const n = parsed.n;
    return [24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 255n)).join('.');
  }
  const groups = [];
  for (let i = 7n; i >= 0n; i -= 1n) groups.push(((parsed.n >> (i * 16n)) & 0xffffn).toString(16));
  return groups.join(':');
}

/**
 * Resolves the visitor address plus where it came from, for diagnostics.
 * Prefer getRealClientIp() for normal call sites.
 *   source: 'cf-connecting-ip'  the header, believed because req.ip is a Cloudflare address
 *           'req.ip'            the address of the last public machine that connected
 *           'placeholder'       nothing usable was found
 */
function resolveClientIp(req) {
  const c = getConfig();
  const headerRaw = req && req.headers ? req.headers['cf-connecting-ip'] : undefined;
  const header = typeof headerRaw === 'string' ? headerRaw.trim() : '';
  // Shown on the admin geolocation check only. Never used to decide anything.
  const diag = {
    forwardedForHeader: (req && req.headers && typeof req.headers['x-forwarded-for'] === 'string') ? req.headers['x-forwarded-for'] : null,
    trustedHops: (req && Array.isArray(req.ips)) ? req.ips : []
  };
  const peer = req ? parseIp(typeof req.ip === 'string' ? req.ip : '') : null;
  const peerText = peer ? cleanText(req.ip) : null;

  if (c.mode === 'auto' && header && peer && isInCloudflare(peer)) {
    const claimed = cleanText(header);
    if (claimed) {
      return {
        ip: claimed,
        source: 'cf-connecting-ip',
        cfConnectingIpHeader: header,
        peerIp: peerText,
        peerIsCloudflare: true,
        mode: c.mode,
        ...diag
      };
    }
  }

  const peerIsCloudflare = peer ? isInCloudflare(peer) : false;
  if (peerText) {
    return { ip: peerText, source: 'req.ip', cfConnectingIpHeader: header || null, peerIp: peerText, peerIsCloudflare, mode: c.mode, ...diag };
  }
  return { ip: PLACEHOLDER, source: 'placeholder', cfConnectingIpHeader: header || null, peerIp: null, peerIsCloudflare: false, mode: c.mode, ...diag };
}

/** The visitor's address as text. Use this anywhere a "real address" is needed. */
function getRealClientIp(req) {
  return resolveClientIp(req).ip;
}

/**
 * A key for counting attempts. Same as the address, except an IPv6 address is
 * reduced to its /64 network, because one person normally controls a whole
 * /64 and could otherwise rotate through billions of "different" addresses.
 */
function getRateLimitKey(req) {
  const ip = getRealClientIp(req);
  const parsed = parseIp(ip);
  if (parsed && parsed.v === 6) {
    return `${((parsed.n >> 64n) & 0xffffffffffffffffn).toString(16)}::/64`;
  }
  return ip;
}

module.exports = {
  getRealClientIp,
  getRateLimitKey,
  resolveClientIp,
  resetClientIpConfig,
  describeConfig,
  describeConfigProblems,
  PLACEHOLDER
};
