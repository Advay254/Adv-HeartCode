// v1.0.8: single source of truth for template_fields.field_type, shared
// between routes/adminWebsiteTypes.js (validation on save) and
// routes/apiBuild.js (validation on submit) — previously this constant
// only lived in adminWebsiteTypes.js since nothing else needed it; Part A
// added a second consumer, so it moved here rather than being duplicated
// or awkwardly hung off the router export.

const VALID_FIELD_TYPES = ['text', 'textarea', 'email', 'password', 'dropdown', 'number', 'date', 'checkboxes', 'radio', 'image'];

// dropdown, radio, and checkboxes are all "pick from a list" fields that
// share the same dropdown_options JSONB column — just rendered as
// different widgets (see views/public/build.ejs) and, for checkboxes,
// submitted as an array instead of a single string.
const OPTION_BASED_FIELD_TYPES = ['dropdown', 'radio', 'checkboxes'];

// Of the option-based types, only checkboxes is multi-select — dropdown
// and radio both submit a single selected string.
const MULTI_SELECT_FIELD_TYPES = ['checkboxes'];

// v1.2.6: image is submitted as an uploaded file (multipart), not a string
// or array of strings like every other type — routes/apiBuild.js branches
// on this list BEFORE the generic isValuePresent/isValidFieldValue checks
// below ever run, since a file has no meaningful "string value" to check
// the shape of. By the time a field's raw value reaches rawFlatValues (see
// apiBuild.js), it's a base64 data URI string — same shape as any other
// field from that point on, just never checked as one.
const FILE_UPLOAD_FIELD_TYPES = ['image'];

module.exports = { VALID_FIELD_TYPES, OPTION_BASED_FIELD_TYPES, MULTI_SELECT_FIELD_TYPES, FILE_UPLOAD_FIELD_TYPES };
