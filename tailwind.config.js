/**
 * v1.0.7: covers PUBLIC-facing views only (landing page, type gallery, and
 * the shared public partials) — the admin dashboard's own visual design is
 * untouched this version (see HANDOFF.md / the v1.0.7 build prompt), so
 * admin views intentionally aren't in `content` below. `hc-blue`/`hc-yellow`
 * resolve through the CSS custom properties defined in src/styles/main.css
 * (--hc-blue / --hc-yellow) rather than hardcoded hex here, so there's one
 * single source of truth for the palette regardless of whether a given use
 * is a Tailwind utility class or a plain CSS reference.
 */
module.exports = {
  content: [
    './views/public/**/*.ejs',
    './views/partials/*.ejs',
    './public/*.js'
  ],
  theme: {
    extend: {
      colors: {
        'hc-blue': 'var(--hc-blue)',
        'hc-yellow': 'var(--hc-yellow)',
        'hc-ink': 'var(--hc-ink)'
      },
      fontFamily: {
        display: ['Anton', 'sans-serif'],
        sans: ['Inter', 'sans-serif']
      }
    }
  },
  plugins: []
};
