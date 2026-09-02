const baseTheme = require('./tailwind.theme');

/**
 * v1.0.8 Part D: scoped to ADMIN dashboard views only. See
 * tailwind.config.js's own comment for why this is a separate config
 * (and separate compiled output) rather than one shared bundle with the
 * public site.
 *
 * v1.1.7 (TailAdmin visual redesign): adds a full brand/accent/gray/
 * success/error/warning color system, scoped to THIS file's own
 * theme.extend rather than the shared tailwind.theme.js — same reasoning
 * tailwind.config.js's own comment gives for its sk-* tokens: these are
 * admin-dashboard-only additions with no reason to exist in the public
 * site's compiled CSS.
 *
 * Where these colors came from:
 *
 *   brand-* — a full 25-950 tint/shade scale generated from HeartCode's
 *   existing --hc-blue anchor (#183FAD), using the same relative
 *   lightness/saturation structure as TailAdmin's own brand-* scale
 *   (anchored on #465FFF): tints (25-400) interpolate proportionally
 *   toward white using the same fractional position TailAdmin's tints
 *   sit at between its own anchor and white; shades (600-950) scale
 *   lightness/saturation down by the same proportional ratios TailAdmin's
 *   shades use relative to ITS anchor. brand-500 is the anchor color
 *   itself (#183FAD, matching --hc-blue exactly) so this scale is a
 *   strict superset of what hc-blue already provided, not a replacement
 *   of it — hc-blue/hc-yellow/hc-ink stay defined and available (they're
 *   shared with the public site via tailwind.theme.js) but this admin
 *   surface now reaches for brand-500/600/etc. instead of hc-blue plus
 *   opacity-modifier approximations (hc-blue/10, hc-blue/90) for anything
 *   that needs an actual distinct lighter or darker step.
 *
 *   accent-* — same generation method, anchored on HeartCode's existing
 *   --hc-yellow (#F1BF0A), using TailAdmin's warning-* scale as the
 *   structural template (TailAdmin's own closest equivalent to a
 *   secondary/accent role — badges, highlights). Used sparingly, the way
 *   TailAdmin itself uses accent colors, not as a primary UI color.
 *
 *   gray-* — TailAdmin's own literal neutral scale, unchanged (the build
 *   brief explicitly keeps this as-is: it's UI-neutral, not a brand
 *   color). Overrides Tailwind's default `gray` for this bundle only —
 *   the public site's separate config/compiled output is untouched.
 *
 *   success-* / error-* / warning-* — TailAdmin's own literal scales for
 *   these roles, unchanged, replacing this admin surface's previous
 *   direct use of Tailwind's stock emerald/red/amber for the same status
 *   meanings (active/success, destructive/error, caution/warning).
 *
 * All six are added as plain hex literals (not RGB-triplet CSS custom
 * properties like hc-blue/hc-yellow/hc-ink) because every one of them is
 * a static, build-time-known value with no runtime theming need —
 * Tailwind computes opacity modifiers (e.g. focus:ring-brand-500/20)
 * natively for plain hex colors. The RGB-triplet-via-CSS-variable pattern
 * in tailwind.theme.js exists specifically to work around Tailwind's
 * INABILITY to do that for a CSS-variable-valued color (see that file's
 * own comment for the real bug this caused in v1.0.7) — that workaround
 * doesn't apply here since these aren't CSS variables.
 *
 * boxShadow.theme-* / focus-ring — ported from TailAdmin's own shadow
 * scale verbatim (neutral elevation shadows, not a brand color), except
 * focus-ring's color channel, which is recolored from TailAdmin's own
 * rgba(70, 95, 255, 0.12) (their brand-500 in rgb) to rgba(24, 63, 173,
 * 0.12) — brand-500 in THIS scale.
 */
module.exports = {
  content: [
    './views/admin/**/*.ejs',
    './views/partials/nav.ejs',
    './views/partials/head.ejs',
    './public/dashboard-assets/admin.js'
  ],
  theme: {
    ...baseTheme,
    extend: {
      ...baseTheme.extend,
      // v1.1.7: title-* and theme-* sizes ported from TailAdmin's own
      // fontSize scale (title-sm for stat-card numbers, theme-xs/theme-sm
      // for badge and table text) — real TailAdmin design tokens, not
      // invented ones. v1.1.8 adds theme-xs/theme-sm/theme-xl (the v1.1.7
      // pass only added the title-* sizes it used at the time; this
      // redo's exact badge/table structures need theme-xs/theme-sm too).
      fontSize: {
        ...baseTheme.extend.fontSize,
        'title-sm': ['30px', '38px'],
        'title-md': ['36px', '44px'],
        'theme-xs': ['12px', '18px'],
        'theme-sm': ['14px', '20px'],
        'theme-xl': ['20px', '30px']
      },
      colors: {
        ...baseTheme.extend.colors,
        brand: {
          25: '#ECF4FC',
          50: '#E3EFFB',
          100: '#CCE1F8',
          200: '#A4C8F2',
          300: '#6CA1EB',
          400: '#326DE3',
          500: '#183FAD',
          600: '#1D3399',
          700: '#253377',
          800: '#212C5F',
          900: '#1E284C',
          950: '#12162C'
        },
        accent: {
          25: '#FFFEF5',
          50: '#FEFEEB',
          100: '#FDFBC7',
          200: '#FAF58A',
          300: '#F8E94E',
          400: '#F6DA25',
          500: '#F1BF0A',
          600: '#D69305',
          700: '#B06A09',
          800: '#8F520E',
          900: '#77440F',
          950: '#4C2B09'
        },
        gray: {
          25: '#FCFCFD',
          50: '#F9FAFB',
          100: '#F2F4F7',
          200: '#E4E7EC',
          300: '#D0D5DD',
          400: '#98A2B3',
          500: '#667085',
          600: '#475467',
          700: '#344054',
          800: '#1D2939',
          900: '#101828',
          950: '#0C111D'
        },
        success: {
          25: '#F6FEF9',
          50: '#ECFDF3',
          100: '#D1FADF',
          200: '#A6F4C5',
          300: '#6CE9A6',
          400: '#32D583',
          500: '#12B76A',
          600: '#039855',
          700: '#027A48',
          800: '#05603A',
          900: '#054F31',
          950: '#053321'
        },
        error: {
          25: '#FFFBFA',
          50: '#FEF3F2',
          100: '#FEE4E2',
          200: '#FECDCA',
          300: '#FDA29B',
          400: '#F97066',
          500: '#F04438',
          600: '#D92D20',
          700: '#B42318',
          800: '#912018',
          900: '#7A271A',
          950: '#55160C'
        },
        warning: {
          25: '#FFFCF5',
          50: '#FFFAEB',
          100: '#FEF0C7',
          200: '#FEDF89',
          300: '#FEC84B',
          400: '#FDB022',
          500: '#F79009',
          600: '#DC6803',
          700: '#B54708',
          800: '#93370D',
          900: '#7A2E0E',
          950: '#4E1D09'
        }
      },
      boxShadow: {
        'theme-xs': '0px 1px 2px 0px rgba(16, 24, 40, 0.05)',
        'theme-sm': '0px 1px 3px 0px rgba(16, 24, 40, 0.10), 0px 1px 2px 0px rgba(16, 24, 40, 0.06)',
        'theme-md': '0px 4px 8px -2px rgba(16, 24, 40, 0.10), 0px 2px 4px -2px rgba(16, 24, 40, 0.06)',
        'theme-lg': '0px 12px 16px -4px rgba(16, 24, 40, 0.08), 0px 4px 6px -2px rgba(16, 24, 40, 0.03)',
        'theme-xl': '0px 20px 24px -4px rgba(16, 24, 40, 0.08), 0px 8px 8px -4px rgba(16, 24, 40, 0.03)',
        'focus-ring': '0px 0px 0px 4px rgba(24, 63, 173, 0.12)'
      }
    }
  }
};
