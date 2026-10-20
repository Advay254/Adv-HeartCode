'use strict';

// v1.2.16: Umami analytics.
//
// Everything about the connection (script address, website ID, allowed
// domains, switches) lives in site_settings and is read through the existing
// cached lib/siteSettings.js. Nothing in this file contains an Umami address,
// a website ID, a site name or a domain. Defaults below are only on/off
// switches and empty values.
//
// What is in here:
//   - settings keys, defaults and validation (used by the admin route)
//   - the per page context the public head partial renders from
//   - the browser event allowlist (kept in sync with public/hc.js)
//   - the server side sender (revenue and the events that happen on pages
//     that must never load the tracker)
//   - the "serve through this site" helpers (script cache, collect forward)

// siteSettings.js reads this file's defaults, so it is required lazily here.
function getSiteSettings() {
  return require('./siteSettings').getSiteSettings();
}
const { resolvePublicBaseUrl } = require('./publicUrl');

// ---- keys and defaults ----

const SETTING_KEYS = {
  enabled: 'analytics_enabled',
  scriptUrl: 'analytics_script_url',
  websiteId: 'analytics_website_id',
  domains: 'analytics_domains',
  dnt: 'analytics_dnt',
  afterInteraction: 'analytics_after_interaction',
  performance: 'analytics_performance',
  recorder: 'analytics_recorder',
  recorderUrl: 'analytics_recorder_url',
  proxy: 'analytics_proxy'
};

// Merged into lib/siteSettings.js DEFAULTS, so a missing row reads as these.
const SETTING_DEFAULTS = {
  analytics_enabled: 'false',
  analytics_script_url: '',
  analytics_website_id: '',
  analytics_domains: '',
  analytics_dnt: 'true',
  analytics_after_interaction: 'false',
  analytics_performance: 'true',
  analytics_recorder: 'false',
  analytics_recorder_url: '',
  analytics_proxy: 'false'
};

// Paths of this site's own routes for "serve through this site". The tracker
// builds its data address as <host-url> + /api/send, so the collect path has
// to end in /api/send.
const LOADER_PATH = '/hc.js';
const PROXY_BASE_PATH = '/hc';
const PROXY_SCRIPT_PATH = '/hc/s.js';
const PROXY_COLLECT_PATH = '/hc/api/send';

// ---- validation ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const PATH_RE = /^\/[A-Za-z0-9._~\-/]*$/;
const BLOCKED_SUFFIXES = [
  'local', 'localhost', 'internal', 'localdomain', 'lan', 'home', 'corp',
  'intranet', 'private', 'test', 'invalid', 'example', 'onion', 'arpa'
];

/** A normal public host name: not an IP address, not localhost, not an internal name. */
function isPublicHostname(host) {
  if (typeof host !== 'string') return false;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h.length < 4 || h.length > 253) return false;
  if (h.includes(':') || h.startsWith('[')) return false;
  if (/^[0-9.]+$/.test(h)) return false;
  const labels = h.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((l) => LABEL_RE.test(l))) return false;
  const tld = labels[labels.length - 1];
  if (!TLD_RE.test(tld)) return false;
  if (BLOCKED_SUFFIXES.includes(tld)) return false;
  return true;
}

/** Validates an https address. Returns { ok, value } or { ok:false, error }. */
function parseSecureAddress(raw, label, { requireFile }) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, error: `${label} is required.` };
  if (text.length > 500) return { ok: false, error: `${label} is too long.` };
  if (!/^https:\/\//i.test(text)) return { ok: false, error: `${label} must start with https://` };
  let url;
  try {
    url = new URL(text);
  } catch (err) {
    return { ok: false, error: `${label} is not a valid web address.` };
  }
  if (url.username || url.password) {
    return { ok: false, error: `${label} must not contain a username or password.` };
  }
  if (url.port && url.port !== '443') {
    return { ok: false, error: `${label} must not include a port number.` };
  }
  if (!isPublicHostname(url.hostname)) {
    return { ok: false, error: `${label} must use a normal public host name, not an IP address, localhost or an internal name.` };
  }
  if (url.search || url.hash) {
    return { ok: false, error: `${label} must not include a query string or anything after a # sign.` };
  }
  if (!PATH_RE.test(url.pathname)) {
    return { ok: false, error: `${label} contains characters that are not allowed in the path.` };
  }
  if (requireFile && (url.pathname === '/' || url.pathname.endsWith('/'))) {
    return { ok: false, error: `${label} must end with the script file name, exactly as Umami shows it in its tracking code.` };
  }
  return { ok: true, value: url.origin + url.pathname };
}

function validateWebsiteId(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, error: 'Website ID is required.' };
  if (!UUID_RE.test(text)) {
    return { ok: false, error: 'Website ID must be a UUID, the long ID with dashes that Umami shows for this website.' };
  }
  return { ok: true, value: text.toLowerCase() };
}

/** Accepts commas, spaces or new lines. Tolerates a pasted https://domain/ form. */
function normalizeDomains(raw) {
  const parts = String(raw == null ? '' : raw).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const host = part.toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '');
    if (!isPublicHostname(host)) {
      return { ok: false, error: `"${part.slice(0, 60)}" is not a valid domain name. Use plain domain names separated by commas.` };
    }
    if (!out.includes(host)) out.push(host);
  }
  if (out.length > 10) return { ok: false, error: 'Add at most 10 allowed domains.' };
  return { ok: true, value: out.join(',') };
}

/**
 * Validates and normalizes the admin form. Returns { ok:true, values } where
 * values maps stored keys to stored strings, or { ok:false, error }.
 */
function validateSettingsInput(input) {
  const enabled = input.enabled === true;
  const wantsAny = enabled || String(input.scriptUrl || '').trim() || String(input.websiteId || '').trim();

  let scriptUrl = '';
  let websiteId = '';
  if (wantsAny) {
    const script = parseSecureAddress(input.scriptUrl, 'Script address', { requireFile: true });
    if (!script.ok) {
      if (enabled || String(input.scriptUrl || '').trim()) return { ok: false, error: script.error };
    } else {
      scriptUrl = script.value;
    }
    const id = validateWebsiteId(input.websiteId);
    if (!id.ok) {
      if (enabled || String(input.websiteId || '').trim()) return { ok: false, error: id.error };
    } else {
      websiteId = id.value;
    }
  }
  if (enabled && (!scriptUrl || !websiteId)) {
    return { ok: false, error: 'Add the script address and the website ID before turning analytics on.' };
  }

  const domains = normalizeDomains(input.domains);
  if (!domains.ok) return { ok: false, error: domains.error };

  let recorderUrl = '';
  if (String(input.recorderUrl || '').trim()) {
    const rec = parseSecureAddress(input.recorderUrl, 'Recorder script address', { requireFile: true });
    if (!rec.ok) return { ok: false, error: rec.error };
    recorderUrl = rec.value;
  }
  if (input.recorder === true && !recorderUrl && !scriptUrl) {
    return { ok: false, error: 'Add the script address, or a recorder script address, before turning the recorder on.' };
  }

  return {
    ok: true,
    values: {
      [SETTING_KEYS.enabled]: enabled ? 'true' : 'false',
      [SETTING_KEYS.scriptUrl]: scriptUrl,
      [SETTING_KEYS.websiteId]: websiteId,
      [SETTING_KEYS.domains]: domains.value,
      [SETTING_KEYS.dnt]: input.dnt === true ? 'true' : 'false',
      [SETTING_KEYS.afterInteraction]: input.afterInteraction === true ? 'true' : 'false',
      [SETTING_KEYS.performance]: input.performance === true ? 'true' : 'false',
      [SETTING_KEYS.recorder]: input.recorder === true ? 'true' : 'false',
      [SETTING_KEYS.recorderUrl]: recorderUrl,
      [SETTING_KEYS.proxy]: input.proxy === true ? 'true' : 'false'
    }
  };
}

// ---- reading settings ----

const configCache = new WeakMap();

/**
 * Reads the analytics settings out of a settings object (the one from
 * getSiteSettings) and derives addresses. Re-validates, so a bad stored value
 * can never switch analytics on. Cached per settings object.
 */
function readConfig(settings) {
  const s = settings || {};
  if (configCache.has(s)) return configCache.get(s);

  const str = (k) => (s[SETTING_KEYS[k]] == null ? '' : String(s[SETTING_KEYS[k]]));
  const bool = (k, d) => {
    const v = str(k);
    return v === '' ? d : v === 'true';
  };

  const script = parseSecureAddress(str('scriptUrl'), 'Script address', { requireFile: true });
  const id = validateWebsiteId(str('websiteId'));
  const enabled = bool('enabled', false) && script.ok && id.ok;

  const domains = str('domains') ? str('domains').split(',').filter(Boolean) : [];

  let collectBase = '';
  let origin = '';
  if (script.ok) {
    const u = new URL(script.value);
    origin = u.origin;
    collectBase = origin + u.pathname.replace(/\/[^/]*$/, '');
  }

  let recorderSrc = '';
  const rec = str('recorderUrl') ? parseSecureAddress(str('recorderUrl'), 'x', { requireFile: true }) : null;
  if (rec && rec.ok) recorderSrc = rec.value;
  else if (collectBase) recorderSrc = collectBase + '/recorder.js';

  const cfg = {
    enabled,
    scriptUrl: script.ok ? script.value : '',
    websiteId: id.ok ? id.value : '',
    domains,
    dnt: bool('dnt', true),
    afterInteraction: bool('afterInteraction', false),
    performance: bool('performance', true),
    recorder: bool('recorder', false),
    recorderSrc,
    proxy: bool('proxy', false),
    origin,
    collectBase
  };
  configCache.set(s, cfg);
  return cfg;
}

// ---- paths ----

// Pages that must never load the tracker: anything whose address carries a
// secret or one-time value, the live preview of a customer's own content,
// the admin API, and this feature's own routes.
const EXCLUDED_PATH_RES = [
  /^\/review(\/|$)/i,
  /^\/api(\/|$)/i,
  /^\/go(\/|$)/i,
  /^\/embed(\/|\.|$)/i,
  /^\/hc(\/|\.|$)/i,
  /^\/build\/[^/]+\/preview\/?$/i,
  /^\/build\/[^/]+\/checkout\/callback\/?$/i
];

// The only pages the recorder may load on. Never the build page (it has a
// form where a customer types personal text), checkout, review pages, the
// resend page or previews.
const RECORDER_PATH_RES = [
  /^\/$/,
  /^\/explore(\/[^/]+)?\/?$/i,
  /^\/testimonials\/?$/i
];

function isTrackablePath(path) {
  const p = String(path || '').split('?')[0];
  return !EXCLUDED_PATH_RES.some((re) => re.test(p));
}

// ---- default domain ----

let lastSeenHost = '';

function defaultDomain(req) {
  try {
    return new URL(resolvePublicBaseUrl(req).url).hostname.toLowerCase();
  } catch (err) {
    return '';
  }
}

function effectiveDomains(cfg, req) {
  if (cfg.domains.length) return cfg.domains;
  const d = defaultDomain(req);
  if (d) lastSeenHost = d;
  return d ? [d] : [];
}

/** Hostname the server side events are sent under. */
function serverHostname(cfg) {
  if (cfg.domains.length) return cfg.domains[0];
  try {
    const fromEnv = new URL(process.env.PUBLIC_BASE_URL || '').hostname.toLowerCase();
    if (fromEnv) return fromEnv;
  } catch (err) { /* not set */ }
  return lastSeenHost;
}

// ---- page context ----

/**
 * What the public head partial renders from. Returns null (nothing at all is
 * added to the page) when analytics is off or the path is excluded.
 */
function buildPageContext(settings, req) {
  const cfg = readConfig(settings);
  if (!cfg.enabled) return null;
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (!isTrackablePath(path)) return null;

  const domains = effectiveDomains(cfg, req);
  const host = String(req.hostname || '').toLowerCase();
  const recorderOn = cfg.recorder
    && RECORDER_PATH_RES.some((re) => re.test(path))
    && (domains.length === 0 || domains.includes(host));

  return {
    loaderSrc: LOADER_PATH,
    trackerSrc: cfg.proxy ? PROXY_SCRIPT_PATH : cfg.scriptUrl,
    websiteId: cfg.websiteId,
    domains: domains.join(','),
    dnt: cfg.dnt,
    perf: cfg.performance,
    lazy: cfg.afterInteraction,
    proxy: cfg.proxy,
    recorderSrc: recorderOn ? cfg.recorderSrc : '',
    events: []
  };
}

/** Adds a page load event to the context (a no-op when analytics is off). */
function addPageEvent(res, name, data) {
  if (res.locals && res.locals.analytics && Array.isArray(res.locals.analytics.events)) {
    res.locals.analytics.events.push({ name, data });
  }
}

/** Extra origins a strict Content-Security-Policy must allow while analytics is on. */
function cspOrigins(settings, req) {
  try {
    const cfg = readConfig(settings);
    const out = { script: [], connect: [] };
    if (!cfg.enabled) return out;
    if (!cfg.proxy && cfg.origin) {
      out.script.push(cfg.origin);
      out.connect.push(cfg.origin);
    }
    const path = (req.originalUrl || '').split('?')[0];
    if (cfg.recorder && RECORDER_PATH_RES.some((re) => re.test(path))) {
      const o = new URL(cfg.recorderSrc).origin;
      const c = cfg.collectBase ? new URL(cfg.collectBase).origin : o;
      out.script.push(o);
      out.connect.push(c, o);
    }
    return out;
  } catch (err) {
    return { script: [], connect: [] };
  }
}

// ---- browser event rules (keep in sync with public/hc.js) ----

// Events the browser may send, and the only fields each may carry. The three
// events below that happen on pages which must never load the tracker, and
// payment_success, are sent by the server only.
const BROWSER_EVENT_FIELDS = {
  type_viewed: ['type'],
  preview_opened: ['type'],
  build_started: ['type'],
  checkout_started: ['type', 'currency', 'value'],
  details_resend_requested: []
};

const FIELD_CHECKS = {
  type: (v) => (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(v) ? v : null),
  currency: (v) => (typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? v : null),
  value: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1e9 ? Math.round(n * 100) / 100 : null;
  }
};

/** Returns the cleaned data object (possibly undefined) or null to drop the event. */
function cleanBrowserEventData(name, data) {
  const fields = BROWSER_EVENT_FIELDS[name];
  if (!fields) return null;
  const src = data && typeof data === 'object' ? data : {};
  const out = {};
  for (const f of fields) {
    const v = FIELD_CHECKS[f](src[f]);
    if (v === null) return null;
    out[f] = v;
  }
  return fields.length ? out : undefined;
}

/** Keeps only utm_ query parameters and drops the hash. Same rule as public/hc.js. */
function cleanUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2000) return undefined;
  try {
    const absolute = /^https?:\/\//i.test(value);
    const u = new URL(value, 'https://placeholder.invalid');
    const keep = new URLSearchParams();
    u.searchParams.forEach((v, k) => {
      if (/^utm_/i.test(k)) keep.append(k.toLowerCase(), v.slice(0, 200));
    });
    const qs = keep.toString();
    return (absolute ? u.origin : '') + u.pathname + (qs ? '?' + qs : '');
  } catch (err) {
    return undefined;
  }
}

// ---- visitor info for server side events ----

/**
 * The visitor's browser string and real client address, only for requests that
 * come from the visitor's own browser, and only to pass along to Umami for its
 * own visitor grouping. Never stored by this app. Null when the visitor sends
 * Do Not Track and the setting respects it.
 */
function visitorFromRequest(req, cfg) {
  try {
    if (cfg && cfg.dnt && String(req.headers.dnt || '') === '1') return null;
    const { getRealClientIp } = require('./clientIp');
    const ua = String(req.headers['user-agent'] || '').slice(0, 500);
    const ip = String(getRealClientIp(req) || '');
    if (!ua || !ip) return null;
    const language = String(req.headers['accept-language'] || '').split(',')[0].trim().slice(0, 35);
    return { userAgent: ua, ip, language: language || undefined };
  } catch (err) {
    return null;
  }
}

// ---- the server side sender ----

const SEND_TIMEOUT_MS = 3000;

function serverUserAgent(siteTitle) {
  // Umami drops requests whose browser string looks like a robot, and words
  // such as "server" or "bot" trigger that. The site name comes from settings.
  const clean = String(siteTitle || '').replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 40) || 'Site';
  return `Mozilla/5.0 (compatible; ${clean})`;
}

/**
 * Sends one event to Umami's collect address. Never throws. Resolves to true
 * when Umami accepted it. Logs a single short line on failure.
 */
async function sendServerEvent({ name, data, url, visitor }) {
  try {
    const settings = await getSiteSettings();
    const cfg = readConfig(settings);
    if (!cfg.enabled) return false;

    const hostname = serverHostname(cfg);
    if (!hostname) {
      console.error(`[ANALYTICS] ${name} not sent: no site domain is known yet.`);
      return false;
    }

    const userAgent = visitor ? visitor.userAgent : serverUserAgent(settings.site_title);
    const payload = { website: cfg.websiteId, hostname, url, name };
    if (data && Object.keys(data).length) payload.data = data;
    const headers = { 'Content-Type': 'application/json', 'User-Agent': userAgent };
    if (visitor) {
      payload.userAgent = visitor.userAgent;
      payload.ip = visitor.ip;
      if (visitor.language) payload.language = visitor.language;
      headers['X-Forwarded-For'] = visitor.ip;
    }

    const res = await fetch(cfg.collectBase + '/api/send', {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'event', payload }),
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (!res.ok) {
      console.error(`[ANALYTICS] ${name} was not accepted by Umami (HTTP ${res.status}).`);
      return false;
    }
    const body = await res.json().catch(() => null);
    if (body && body.beep) {
      console.error(`[ANALYTICS] ${name} was ignored by Umami as a robot request.`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[ANALYTICS] ${name} could not be sent: ${String(err && err.message).slice(0, 120)}`);
    return false;
  }
}

/** Fire and forget. Safe to call from anywhere: it can never throw or delay. */
function fire(args) {
  try {
    sendServerEvent(args).catch(() => {});
  } catch (err) { /* never */ }
}

/** payment_success: called once per deployment from finalizeDeployment. */
function firePaymentSuccess({ typeSlug, revenueUsd, paidAmount, paidCurrency, visitor }) {
  if (!Number.isFinite(revenueUsd)) return;
  const slug = typeSlug || '';
  fire({
    name: 'payment_success',
    url: slug ? `/build/${slug}/checkout/callback` : '/',
    visitor,
    data: {
      revenue: Math.round(revenueUsd * 100) / 100,
      currency: 'USD',
      type: slug,
      paid_amount: Number(paidAmount),
      paid_currency: String(paidCurrency || '')
    }
  });
}

// Remembers recently reported callback references so a page refresh does not
// report the same return twice. In memory, bounded, short lived.
const reported = new Map();
function firstTime(key) {
  const now = Date.now();
  for (const [k, t] of reported) {
    if (now - t > 60 * 60 * 1000 || reported.size > 5000) reported.delete(k);
    else break;
  }
  if (reported.has(key)) return false;
  reported.set(key, now);
  return true;
}

/**
 * Events caused by the visitor's own browser on pages that never load the
 * tracker (the checkout return and the review form). Sent from the server.
 */
function fireFromRequest(req, { name, data, url, onceKey }) {
  (async () => {
    try {
      const settings = await getSiteSettings();
      const cfg = readConfig(settings);
      if (!cfg.enabled) return;
      if (String(req.headers.dnt || '') === '1' && cfg.dnt) return;
      if (onceKey && !firstTime(onceKey + ':' + name)) return;
      await sendServerEvent({ name, data, url, visitor: visitorFromRequest(req, cfg) });
    } catch (err) { /* never */ }
  })();
}

// ---- serve through this site ----

const SCRIPT_TTL_MS = 10 * 60 * 1000;
const SCRIPT_MAX_BYTES = 512 * 1024;
let scriptCache = { url: '', body: null, at: 0 };
let scriptInflight = null;

/** The tracker script, fetched from the saved address only, cached in memory. */
async function getTrackerScript(cfg) {
  const now = Date.now();
  if (scriptCache.url === cfg.scriptUrl && scriptCache.body && now - scriptCache.at < SCRIPT_TTL_MS) {
    return scriptCache.body;
  }
  if (scriptInflight && scriptInflight.url === cfg.scriptUrl) return scriptInflight.promise;

  const promise = (async () => {
    try {
      const res = await fetch(cfg.scriptUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/javascript, text/javascript, */*;q=0.1' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > SCRIPT_MAX_BYTES) throw new Error('unexpected script size');
      scriptCache = { url: cfg.scriptUrl, body: buf, at: Date.now() };
      return buf;
    } catch (err) {
      console.error(`[ANALYTICS] Could not fetch the tracker script: ${String(err && err.message).slice(0, 120)}`);
      // Serve the last good copy for the same address rather than nothing.
      return scriptCache.url === cfg.scriptUrl ? scriptCache.body : null;
    } finally {
      scriptInflight = null;
    }
  })();
  scriptInflight = { url: cfg.scriptUrl, promise };
  return promise;
}

function clearScriptCache() {
  scriptCache = { url: '', body: null, at: 0 };
}

const PERF_LIMITS = { lcp: 60000, inp: 60000, fcp: 60000, ttfb: 60000, cls: 100 };

/**
 * Builds the body to forward to Umami from what the tracker posted. The target
 * address and the website ID always come from settings. Returns null when the
 * request should be quietly dropped.
 */
function sanitizeCollectBody(body, cfg, req, visitor) {
  if (!body || typeof body !== 'object') return null;
  const type = body.type;
  if (type !== 'event' && type !== 'performance') return null;
  const src = body.payload;
  if (!src || typeof src !== 'object') return null;

  const domains = effectiveDomains(cfg, req);
  const hostname = typeof src.hostname === 'string' ? src.hostname.toLowerCase() : '';
  if (!hostname || (domains.length && !domains.includes(hostname))) return null;

  const payload = { website: cfg.websiteId, hostname };
  const url = cleanUrl(src.url);
  if (src.url !== undefined && url === undefined) return null;
  if (url !== undefined) payload.url = url;
  const referrer = cleanUrl(src.referrer);
  if (referrer !== undefined) payload.referrer = referrer;
  if (typeof src.title === 'string') payload.title = src.title.slice(0, 300);
  if (typeof src.language === 'string') payload.language = src.language.slice(0, 35);
  if (typeof src.screen === 'string' && /^\d{1,5}x\d{1,5}$/.test(src.screen)) payload.screen = src.screen;

  if (type === 'event' && src.name !== undefined) {
    const data = cleanBrowserEventData(src.name, src.data);
    if (data === null) return null;
    payload.name = src.name;
    if (data) payload.data = data;
  }
  if (type === 'performance') {
    for (const [k, max] of Object.entries(PERF_LIMITS)) {
      if (typeof src[k] === 'number' && src[k] >= 0 && src[k] <= max) payload[k] = src[k];
    }
  }
  if (visitor) {
    payload.ip = visitor.ip;
    payload.userAgent = visitor.userAgent;
  }
  return { type, payload };
}

/** Forwards one collect request. Always resolves to { status, body }. */
async function forwardCollect(cfg, req, parsedBody) {
  const quiet = { status: 200, body: '{}' };
  try {
    const visitor = visitorFromRequest(req, null);
    const clean = sanitizeCollectBody(parsedBody, cfg, req, visitor);
    if (!clean) return quiet;

    const headers = { 'Content-Type': 'application/json' };
    if (visitor) {
      headers['User-Agent'] = visitor.userAgent;
      headers['X-Forwarded-For'] = visitor.ip;
    } else {
      headers['User-Agent'] = serverUserAgent('');
    }
    const cache = String(req.headers['x-umami-cache'] || '');
    if (/^[A-Za-z0-9._-]{20,2000}$/.test(cache)) headers['x-umami-cache'] = cache;

    const res = await fetch(cfg.collectBase + '/api/send', {
      method: 'POST',
      headers,
      body: JSON.stringify(clean),
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    });
    if (!res.ok) return quiet;
    const text = await res.text();
    if (text.length > 4000) return quiet;
    try {
      JSON.parse(text);
    } catch (err) {
      return quiet;
    }
    return { status: 200, body: text };
  } catch (err) {
    return quiet;
  }
}

module.exports = {
  SETTING_KEYS,
  SETTING_DEFAULTS,
  LOADER_PATH,
  PROXY_BASE_PATH,
  PROXY_SCRIPT_PATH,
  PROXY_COLLECT_PATH,
  isPublicHostname,
  parseSecureAddress,
  validateSettingsInput,
  readConfig,
  isTrackablePath,
  defaultDomain,
  buildPageContext,
  addPageEvent,
  cspOrigins,
  BROWSER_EVENT_FIELDS,
  cleanBrowserEventData,
  cleanUrl,
  visitorFromRequest,
  sendServerEvent,
  firePaymentSuccess,
  fireFromRequest,
  getTrackerScript,
  clearScriptCache,
  sanitizeCollectBody,
  forwardCollect
};
