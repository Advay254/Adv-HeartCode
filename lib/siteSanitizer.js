'use strict';

// v1.2.19: two small safety tools for rendered site HTML.
//
// 1. neutraliseDangerousLinks(html): after a site is rendered on the server,
//    any href, src, action, formaction or xlink:href whose address runs script
//    (javascript:, vbscript:, or data: for anything other than an image source)
//    is replaced with a harmless "#". Customer values are HTML-escaped, but a
//    value placed inside a link attribute such as href="{{link}}" can still be
//    "javascript:alert(1)", because that text contains nothing that escaping
//    touches. Admin-written markup, scripts and event attributes are not
//    changed, except that an address using one of those schemes is neutralised
//    wherever it came from.
//
// 2. findUnsafePlaceholders(templateHtml): lists customer placeholders that sit
//    inside a <script> block or an on... event attribute. Escaping alone cannot
//    protect those places: HTML entities are decoded before an event attribute
//    is run as script, and a script block treats a backtick or ${ as code.
//
// Both work on text only (no HTML parser dependency) with a small tag scanner
// that respects quotes, comments and the raw text of script and style blocks.

const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title']);
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);
const IMAGE_SRC_TAGS = new Set(['img', 'source', 'image']);

// Characters a browser ignores inside an address: controls, spaces, soft hyphen, zero width and line separators.
const INVISIBLE_RE = new RegExp('[\\u0000-\\u0020\\u007f-\\u009f\\u00ad\\u200b-\\u200f\\u2028\\u2029\\ufeff]', 'g');

const NAMED = { colon: ':', tab: '\t', newline: '\n', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", lpar: '(', rpar: ')', sol: '/', num: '#', semi: ';' };

/** Decodes the character references a browser would decode inside an attribute value. */
function decodeEntities(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);?/gi, (m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (m, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => (Object.prototype.hasOwnProperty.call(NAMED, n.toLowerCase()) ? NAMED[n.toLowerCase()] : m));
}
function safeChar(code) {
  return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** The scheme-bearing start of an address the way a browser reads it: no entities, no spaces or control characters, lower case. */
function normaliseAddress(value) {
  return decodeEntities(value)
    .replace(INVISIBLE_RE, '')
    .toLowerCase();
}

function isDangerous(tag, attr, value) {
  const addr = normaliseAddress(value);
  if (addr.startsWith('javascript:') || addr.startsWith('vbscript:')) return true;
  if (addr.startsWith('data:')) {
    const imageSource = (attr === 'src' || attr === 'xlink:href') && IMAGE_SRC_TAGS.has(tag) && /^data:image\//.test(addr);
    return !imageSource;
  }
  return false;
}

/**
 * Walks every start tag, respecting quotes. Calls onAttr(tag, name, value, span)
 * for each attribute. Returns the tag list positions via the callback only.
 */
function scanTags(html, onTag) {
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const m = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 40));
    if (!m) { i = lt + 1; continue; }
    const tag = m[1].toLowerCase();
    let p = lt + m[0].length;
    const attrs = [];
    // attributes until an unquoted ">"
    while (p < n) {
      while (p < n && /[\s/]/.test(html[p])) p++;
      if (p >= n || html[p] === '>') break;
      const nameStart = p;
      while (p < n && !/[\s=/>]/.test(html[p])) p++;
      const name = html.slice(nameStart, p).toLowerCase();
      if (p === nameStart) { p++; continue; }
      while (p < n && /\s/.test(html[p])) p++;
      let value = null, valueStart = -1, valueEnd = -1, quote = '';
      if (html[p] === '=') {
        p++;
        while (p < n && /\s/.test(html[p])) p++;
        if (html[p] === '"' || html[p] === "'") {
          quote = html[p];
          const close = html.indexOf(quote, p + 1);
          valueStart = p + 1;
          valueEnd = close === -1 ? n : close;
          p = close === -1 ? n : close + 1;
        } else {
          valueStart = p;
          while (p < n && !/[\s>]/.test(html[p])) p++;
          valueEnd = p;
        }
        value = html.slice(valueStart, valueEnd);
      }
      attrs.push({ name, value, valueStart, valueEnd, quote });
    }
    const tagEnd = p < n ? p + 1 : n;
    onTag(tag, attrs, lt, tagEnd);
    i = tagEnd;
    if (RAW_TEXT_TAGS.has(tag) && html[tagEnd - 1] === '>' && !/\/\s*>$/.test(html.slice(lt, tagEnd))) {
      const close = new RegExp('</' + tag + '[\\s/>]', 'i');
      const rest = html.slice(tagEnd);
      const found = close.exec(rest);
      if (tag === 'script' || tag === 'style' || tag === 'textarea' || tag === 'title') {
        i = found ? tagEnd + found.index : n;
      }
    }
  }
}

/** Returns html with dangerous link addresses replaced by "#". */
function neutraliseDangerousLinks(html) {
  const text = String(html == null ? '' : html);
  const edits = [];
  scanTags(text, (tag, attrs) => {
    for (const a of attrs) {
      const watched = URL_ATTRS.has(a.name) || (a.name === 'data' && (tag === 'object')) ;
      if (!watched || a.value === null) continue;
      if (isDangerous(tag, a.name === 'data' ? 'href' : a.name, a.value)) edits.push({ start: a.valueStart, end: a.valueEnd, quote: a.quote });
    }
  });
  if (edits.length === 0) return text;
  let out = '';
  let last = 0;
  for (const e of edits) {
    out += text.slice(last, e.start) + '#';
    last = e.end;
  }
  return out + text.slice(last);
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
const FIXED_TOKENS = new Set(['this', 'password_input_and_button', 'website_type_name']);

/** Customer placeholders found inside <script> blocks or on... attributes. */
function findUnsafePlaceholders(templateHtml) {
  const text = String(templateHtml == null ? '' : templateHtml);
  const found = [];
  const add = (where, key) => { if (!FIXED_TOKENS.has(key) && !found.some((f) => f.where === where && f.key === key)) found.push({ where, key }); };
  scanTags(text, (tag, attrs, start, end) => {
    for (const a of attrs) {
      if (a.name.startsWith('on') && a.value) {
        for (const m of a.value.matchAll(PLACEHOLDER_RE)) add('event attribute (' + a.name + ')', m[1]);
      }
    }
    if (tag === 'script') {
      const close = /<\/script[\s/>]/i.exec(text.slice(end));
      const body = close ? text.slice(end, end + close.index) : text.slice(end);
      for (const m of body.matchAll(PLACEHOLDER_RE)) add('script block', m[1]);
    }
  });
  return found;
}

module.exports = { neutraliseDangerousLinks, findUnsafePlaceholders, normaliseAddress, decodeEntities };
