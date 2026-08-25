const baseTheme = require('./tailwind.theme');

/**
 * v1.0.8: scoped to PUBLIC-facing views only. Content scanning is kept
 * separate per bundle (this file vs. tailwind.admin.config.js) rather
 * than one shared config scanning everything, so public's compiled
 * main.css doesn't end up bundling unused admin-only utility classes and
 * vice versa — each output stays scoped to what that surface actually
 * uses. Theme tokens (colors/fonts) are still shared, via tailwind.theme.js,
 * so the palette can't drift between the two.
 *
 * v1.1.3: the Skilline-styled landing page redesign added a
 * `views/partials/landing-sections/` directory alongside the existing
 * flat `public-*.ejs` partial naming, so it needs its own content glob
 * entry — the existing `public-*.ejs` pattern doesn't reach into
 * subdirectories.
 *
 * v1.1.3 also adds a handful of new theme tokens, but deliberately
 * INSIDE this file's own theme.extend rather than tailwind.theme.js
 * (the file the admin bundle also reads) — these are landing-page-only
 * additions and have no reason to exist in the admin dashboard's
 * compiled CSS at all:
 *
 *   sk-* ("Skilline") colors — every one is a tint or shade of the
 *   EXISTING hc-blue/hc-yellow tokens above, not any of Skilline's own
 *   template palette (purples/oranges/cyans/greens/reds) — reusing the
 *   template's layout/motion while recoloring it to this app's existing
 *   brand colors is the one deliberate recolor deviation from the source
 *   template, per this version's build brief:
 *     sk-blue        = hc-blue as-is                    (#183FAD)
 *     sk-blue-deep   = hc-blue shaded  ~35% toward black (#102970)
 *     sk-blue-soft   = hc-blue tinted ~45% toward white  (#8095D2)
 *     sk-blue-pale   = hc-blue tinted ~85% toward white  (#DCE2F3)
 *     sk-yellow      = hc-yellow as-is                   (#F1BF0A)
 *     sk-yellow-deep = hc-yellow shaded ~25% toward black(#B58F08)
 *     sk-yellow-soft = hc-yellow tinted ~35% toward white(#F6D560)
 *     sk-yellow-pale = hc-yellow tinted ~80% toward white(#FCF2CE)
 *   Defined as RGB-triplet custom properties in src/styles/main.css's
 *   :root (--sk-*-rgb), read here through the same
 *   `rgb(var(...) / <alpha-value>)` pattern as hc-blue/hc-yellow above —
 *   see tailwind.theme.js's own comment for the real opacity-modifier
 *   bug that pattern exists to avoid. A plain hex custom property here
 *   would silently reintroduce that exact bug for every `bg-sk-blue/10`-
 *   style class this redesign uses.
 *
 *   font-poppins — additive only: font-sans (Inter) and font-display
 *   (Anton) above keep their existing meaning everywhere else on the
 *   public site. Only views/public/landing.ejs and its section partials
 *   use `font-poppins`; nothing else in the scanned content ever
 *   references it, so it never affects any other page's rendered output
 *   even though the utility class itself is available site-wide.
 *
 *   sk-float* keyframes/animations — the floating-decoration motion
 *   Skilline's own css/skilline.css implements with three near-duplicate
 *   hand-written @keyframes blocks and matching classes; reimplemented
 *   here as Tailwind utilities (`animate-sk-float`, `-slow`, `-delay`)
 *   instead of carrying that separate stylesheet into this app.
 */
module.exports = {
  content: [
    './views/public/**/*.ejs',
    './views/partials/public-*.ejs',
    './views/partials/landing-sections/**/*.ejs',
    './public/site.js',
    './public/site-interactions.js'
  ],
  // v1.1.3: feature_cards/bullet_list/split_image_text all pick an
  // ACCENT_COLOR_NAMES value (lib/landingSectionTypes.js) at RUNTIME and
  // build a class string like `bg-${icon_color}/10` inside an EJS
  // template — Tailwind's JIT scanner only generates classes it finds as
  // LITERAL text in the files listed under `content` above, so a
  // runtime-interpolated class name is invisible to it and would
  // silently produce no CSS at all (the exact same failure category
  // tailwind.theme.js's own comment describes for a different reason —
  // opacity modifiers on a hex-only custom property. This one is "the
  // class string itself never appears in scanned source," not an
  // opacity-blending problem, but the visible symptom is identical:
  // classes that are present in the rendered HTML but do nothing).
  // safelist forces Tailwind to generate every bg-/text-/border- variant
  // of every accent color regardless of whether it can find a literal
  // match — the fix for exactly this failure mode.
  safelist: [
    { pattern: /^(bg|text|border)-sk-(blue|yellow)(-deep|-soft|-pale)?$/ },
    { pattern: /^bg-sk-(blue|yellow)(-deep|-soft|-pale)?\/(10|20|30)$/ }
  ],
  theme: {
    extend: {
      ...baseTheme.extend,
      colors: {
        ...baseTheme.extend.colors,
        'sk-blue': 'rgb(var(--sk-blue-rgb) / <alpha-value>)',
        'sk-blue-deep': 'rgb(var(--sk-blue-deep-rgb) / <alpha-value>)',
        'sk-blue-soft': 'rgb(var(--sk-blue-soft-rgb) / <alpha-value>)',
        'sk-blue-pale': 'rgb(var(--sk-blue-pale-rgb) / <alpha-value>)',
        'sk-yellow': 'rgb(var(--sk-yellow-rgb) / <alpha-value>)',
        'sk-yellow-deep': 'rgb(var(--sk-yellow-deep-rgb) / <alpha-value>)',
        'sk-yellow-soft': 'rgb(var(--sk-yellow-soft-rgb) / <alpha-value>)',
        'sk-yellow-pale': 'rgb(var(--sk-yellow-pale-rgb) / <alpha-value>)'
      },
      fontFamily: {
        ...baseTheme.extend.fontFamily,
        poppins: ['Poppins', 'sans-serif']
      },
      keyframes: {
        'sk-float': {
          '0%, 100%': { transform: 'translateY(0px) rotate(0deg)' },
          '50%': { transform: 'translateY(-14px) rotate(3deg)' }
        }
      },
      animation: {
        'sk-float': 'sk-float 4s ease-in-out infinite',
        'sk-float-slow': 'sk-float 6.5s ease-in-out infinite',
        'sk-float-delay': 'sk-float 5.5s ease-in-out 1.2s infinite'
      }
    }
  }
};
