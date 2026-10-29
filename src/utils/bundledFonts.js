/**
 * The app's bundled fonts as data: URLs, for the places that cannot load the
 * bundled woff2 files by URL: the sandboxed diagnostics frame (an opaque
 * origin, no file:// subresources) and the PDF export's hidden window (it
 * may read only its own temp directory, and the export used to re-fetch
 * the files from the app's origin - which, in the packaged app, resolved
 * the stylesheet's relative url(./red-hat-*.woff2) against dist/index.html
 * instead of dist/assets/ and failed, so the export printed in the OS
 * fallback: Helvetica on macOS, heavier than Red Hat Text, and a different
 * face on Linux).
 *
 * Vite's `?inline` imports embed the same @fontsource woff2 files the app
 * loads through src/main.jsx, at build time; a data: URL is neither a
 * network nor a file-system request, so it works the same in dev, in the
 * packaged app and offline. Only the latin subsets are inlined (glyphs
 * outside them fall back per character to the next family in the stack).
 * Explicit weights: Red Hat Text 400/500/600 for text and headings, 700 so
 * bold is the designed Bold rather than the nearest lighter face, and the
 * 400 / 700 italics so emphasis is the designed Italic rather than a slanted
 * Regular; Red Hat Mono 400/500 for code; Sora 400/500/600 for the UI.
 * tests/diagnostics-frame-fonts.test.mjs and tests/pdf-export-fonts.test.mjs
 * keep this list in step with src/main.jsx.
 */
import soraRegular from '@fontsource/sora/files/sora-latin-400-normal.woff2?inline';
import soraMedium from '@fontsource/sora/files/sora-latin-500-normal.woff2?inline';
import soraSemibold from '@fontsource/sora/files/sora-latin-600-normal.woff2?inline';
import textRegular from '@fontsource/red-hat-text/files/red-hat-text-latin-400-normal.woff2?inline';
import textMedium from '@fontsource/red-hat-text/files/red-hat-text-latin-500-normal.woff2?inline';
import textSemibold from '@fontsource/red-hat-text/files/red-hat-text-latin-600-normal.woff2?inline';
import textBold from '@fontsource/red-hat-text/files/red-hat-text-latin-700-normal.woff2?inline';
import textItalic from '@fontsource/red-hat-text/files/red-hat-text-latin-400-italic.woff2?inline';
import textBoldItalic from '@fontsource/red-hat-text/files/red-hat-text-latin-700-italic.woff2?inline';
import monoRegular from '@fontsource/red-hat-mono/files/red-hat-mono-latin-400-normal.woff2?inline';
import monoMedium from '@fontsource/red-hat-mono/files/red-hat-mono-latin-500-normal.woff2?inline';

/** The families whose faces are bundled here (and loaded by src/main.jsx). */
export const BUNDLED_FAMILIES = ['Sora', 'Red Hat Text', 'Red Hat Mono'];

/** Every bundled face: family, weight, style and the woff2 as a data: URL. */
export const BUNDLED_FONTS = [
  { family: 'Sora', weight: 400, style: 'normal', data: soraRegular },
  { family: 'Sora', weight: 500, style: 'normal', data: soraMedium },
  { family: 'Sora', weight: 600, style: 'normal', data: soraSemibold },
  { family: 'Red Hat Text', weight: 400, style: 'normal', data: textRegular },
  { family: 'Red Hat Text', weight: 500, style: 'normal', data: textMedium },
  { family: 'Red Hat Text', weight: 600, style: 'normal', data: textSemibold },
  { family: 'Red Hat Text', weight: 700, style: 'normal', data: textBold },
  { family: 'Red Hat Text', weight: 400, style: 'italic', data: textItalic },
  { family: 'Red Hat Text', weight: 700, style: 'italic', data: textBoldItalic },
  { family: 'Red Hat Mono', weight: 400, style: 'normal', data: monoRegular },
  { family: 'Red Hat Mono', weight: 500, style: 'normal', data: monoMedium },
];

/** @font-face rules for every bundled face, each src an inline data: URL. */
export const BUNDLED_FONT_CSS = BUNDLED_FONTS
  .map(({ family, weight, style, data }) =>
    `@font-face { font-family: '${family}'; font-style: ${style}; font-weight: ${weight}; font-display: swap; src: url(${data}) format('woff2'); }`)
  .join('\n');

/** True when a CSS font-family value (quoted or not) names one of the bundled families. */
export function isBundledFamily(fontFamily) {
  const name = String(fontFamily || '').trim().replace(/^["']|["']$/g, '');
  return BUNDLED_FAMILIES.includes(name);
}

/** "Red Hat Text 400/500/600/700 + italic 400/700, Red Hat Mono 400/500, Sora 400/500/600" - for a log line. */
export function describeBundledFonts() {
  return BUNDLED_FAMILIES.map((family) => {
    const normal = BUNDLED_FONTS.filter((f) => f.family === family && f.style === 'normal').map((f) => f.weight).join('/');
    const italic = BUNDLED_FONTS.filter((f) => f.family === family && f.style === 'italic').map((f) => f.weight).join('/');
    return `${family} ${normal}${italic ? ` + italic ${italic}` : ''}`;
  }).join(', ');
}
