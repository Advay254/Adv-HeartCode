/**
 * v1.0.8 Part D: scoped to ADMIN dashboard views only. See
 * tailwind.config.js's own comment for why this is a separate config
 * (and separate compiled output) rather than one shared bundle with the
 * public site.
 */
module.exports = {
  content: [
    './views/admin/**/*.ejs',
    './views/partials/nav.ejs',
    './views/partials/head.ejs',
    './public/dashboard-assets/admin.js'
  ],
  theme: require('./tailwind.theme')
};
