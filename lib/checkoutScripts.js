'use strict';

const { formatDeployedAt } = require('./deploymentEmail');

// v1.2.12: variables for the checkout-confirmation script slot (a
// site_scripts row with placement 'checkout_confirmation'), filled with the
// real values of the one completed transaction being shown.
//
// Names match the email template variables wherever the data is the same:
//   site_url, client_email, website_type_name, deployed_at
// Three transaction details have no email-template equivalent, so they get
// plain new names: reference, amount, currency.
//
// DELIBERATELY NOT AVAILABLE here: site_password and review_link. A third
// party script (Trustpilot or any other) must never be handed a client's
// plaintext site password, and the review link is a private single-use
// credential. Form fields and AI outputs are not offered either: by the time
// a client reaches this page the checkout's field values are normally gone
// (the webhook may already have finalized the deployment).
const CHECKOUT_SCRIPT_VARIABLES = [
  'reference', 'amount', 'currency',
  'client_email', 'site_url', 'website_type_name', 'deployed_at'
];

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Escapes a value for use INSIDE a JavaScript string literal in an inline
 * script (the place a post-purchase snippet puts these values, for example
 * `email: "{{client_email}}"`). Quotes, backslashes, line breaks and angle
 * brackets are written as \uXXXX escapes, so a value can neither end the
 * string, run code, nor close the script tag. Values are meant to sit
 * inside quotes; they are not HTML-escaped.
 */
function escapeForJsString(value) {
  return String(value == null ? '' : value).replace(/[\\"'`<>&\u2028\u2029\u0000-\u001f\u007f]/g, (ch) => {
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

function buildCheckoutScriptVariables(site, websiteTypeName) {
  const amount = Number(site.charge_amount);
  return {
    reference: site.reference || '',
    amount: Number.isFinite(amount) ? amount.toFixed(2) : '',
    currency: site.charge_currency || '',
    client_email: site.client_email || '',
    site_url: site.site_url || '',
    website_type_name: websiteTypeName || '',
    deployed_at: formatDeployedAt(site.deployed_at)
  };
}

/** Substitutes {{variable}} in one stored script. Unknown names become empty. */
function renderCheckoutScript(scriptContent, variables) {
  return String(scriptContent).replace(PLACEHOLDER_RE, (match, name) => {
    return Object.prototype.hasOwnProperty.call(variables, name) ? escapeForJsString(variables[name]) : '';
  });
}

module.exports = {
  CHECKOUT_SCRIPT_VARIABLES,
  escapeForJsString,
  buildCheckoutScriptVariables,
  renderCheckoutScript
};
