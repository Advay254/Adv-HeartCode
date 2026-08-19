/**
 * v1.0.8: scoped to PUBLIC-facing views only. Content scanning is kept
 * separate per bundle (this file vs. tailwind.admin.config.js) rather
 * than one shared config scanning everything, so public's compiled
 * main.css doesn't end up bundling unused admin-only utility classes and
 * vice versa — each output stays scoped to what that surface actually
 * uses. Theme tokens (colors/fonts) are still shared, via tailwind.theme.js,
 * so the palette can't drift between the two.
 */
module.exports = {
  content: [
    './views/public/**/*.ejs',
    './views/partials/public-*.ejs',
    './public/site.js',
    './public/site-interactions.js'
  ],
  theme: require('./tailwind.theme')
};
