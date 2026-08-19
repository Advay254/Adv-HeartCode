// v1.0.8: shared theme extension for BOTH tailwind.config.js (public) and
// tailwind.admin.config.js (admin) — one definition of the palette/font
// tokens, required by both, so hc-blue/hc-yellow/hc-ink and the
// display/sans font stacks can never drift between the two surfaces even
// though they compile to two separate CSS bundles (see those two config
// files' own comments for why they're kept separate rather than one
// shared bundle).
// v1.0.8: colors reference the RGB-TRIPLET custom properties
// (--hc-blue-rgb etc., space-separated "R G B", not hex) via Tailwind's
// `<alpha-value>` placeholder — this is what lets opacity-modifier
// utilities (bg-hc-blue/10, text-hc-ink/60, etc.) actually generate
// real, working CSS.
//
// Real bug found and fixed in this same pass, not just for this new
// admin config: v1.0.7's original color definitions pointed straight at
// hex-string custom properties (`'hc-blue': 'var(--hc-blue)'`), which
// Tailwind CANNOT blend an alpha channel into — every opacity-modified
// class using hc-blue/hc-yellow/hc-ink throughout the ALREADY-SHIPPED
// public site (landing.ejs, explore.ejs, the public nav/footer partials)
// was silently never generated at all. Confirmed by grepping the actual
// compiled v1.0.7 output: `.bg-hc-blue{background-color:var(--hc-blue)}`
// existed, but no `/10`, `/40`, `/60`, `/70` variant did anywhere in the
// file — those elements were rendering with no color from that class at
// all, not a slightly-off shade. Caught while building this file (an
// `@apply bg-hc-blue/10` inside a custom component class hit a hard
// build error — direct utility-class usage in scanned HTML doesn't fail
// the same way, it just silently drops the class, which is how this went
// unnoticed in the delivered v1.0.7 site).
module.exports = {
  extend: {
    colors: {
      'hc-blue': 'rgb(var(--hc-blue-rgb) / <alpha-value>)',
      'hc-yellow': 'rgb(var(--hc-yellow-rgb) / <alpha-value>)',
      'hc-ink': 'rgb(var(--hc-ink-rgb) / <alpha-value>)'
    },
    fontFamily: {
      display: ['Anton', 'sans-serif'],
      sans: ['Inter', 'sans-serif']
    }
  }
};
