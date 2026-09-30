import { activeTheme, type Theme } from '../../mochiforge/src/themes';

// The ohagi logo, drawn by mochi's rules so the two sit together: monoline
// strokes of width 10 with round caps, curves of radius 15 centred on the
// x-height's middle line (y = 40), stems from y = 25 to the baseline at 55,
// ascenders from y = 5, and 8 units of air between letters. o, h, and i are
// mochi's own letters. a is the o with a stem on its right; g is the same
// with the stem carried below the baseline and turned back, the one descender
// mochi's word does not need, so the box runs to y = 80 rather than 60 and
// the top bar draws it taller (see ohagi.css) to keep the x-height mochi's.
//
// The mark is the sweet itself: a rounded mound of rice under bean paste,
// drawn as one flattened ellipse with a short arc of highlight across its
// shoulder.

/** The logotype. 202 x 80. */
export const WORDMARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 202 80" fill="none" role="img" aria-label="ohagi"><g stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"><circle cx="20" cy="40" r="15"/><path d="M53 5V55"/><path d="M53 40A15 15 0 0 1 83 40"/><path d="M83 40V55"/><circle cx="116" cy="40" r="15"/><path d="M131 25V55"/><circle cx="164" cy="40" r="15"/><path d="M179 25V60A15 15 0 0 1 151.01 67.5"/><path d="M197 25V55"/><circle cx="197" cy="5" r="5" stroke="none" fill="currentColor"/></g></svg>`;

/** The mark. 64 x 64. */
export const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-label="ohagi"><ellipse cx="32" cy="36" rx="23" ry="17" stroke="currentColor" stroke-width="6"/><path d="M20 32A14 10 0 0 1 31 25" stroke="currentColor" stroke-width="6" stroke-linecap="round"/></svg>`;

/** The mark on a rounded tile in the shelf's theme colours, as mochi draws its favicon. */
export function faviconSvg(theme: Theme = activeTheme()): string {
  const bg = theme.vars.accent;
  const fg = theme.vars.bg;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="ohagi"><rect width="64" height="64" rx="14" fill="${bg}"/><g transform="translate(9.6 9.6) scale(0.7)" fill="none" stroke="${fg}" stroke-width="7"><ellipse cx="32" cy="36" rx="23" ry="17"/><path d="M20 32A14 10 0 0 1 31 25" stroke-linecap="round"/></g></svg>`;
}
