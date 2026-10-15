// Styles for the sandboxed diagnostics iframe (DiagnosticsPage.jsx,
// buildDiagnosticsSrcDoc).
//
// The frame is <iframe sandbox="allow-scripts" srcdoc> WITHOUT
// allow-same-origin, so it has an opaque origin and Chromium refuses to load
// any file:// subresource for it ("Not allowed to load local resource",
// reported in DevTools as "blocked:other"). That is why the parent's
// stylesheets are not linked but serialized from document.styleSheets and
// inlined as text - no fetch happens for the CSS itself.
//
// The @font-face rules from the @fontsource packages (imported in
// src/main.jsx) came along in that serialization, and THEY reference the
// bundled woff2 files by URL: file://.../dist/assets/red-hat-*.woff2 in the
// packaged app. The frame's attempt to fetch those is what DevTools showed
// as red-hat-* "blocked:other" with initiator about:srcdoc, and the frame
// silently fell back to Inter/Roboto/Consolas.
//
// Fix: drop the parent's @font-face rules and emit our own whose src is a
// data: URL - the same @fontsource woff2 files, inlined at build time by Vite
// `?inline` imports. A data: URL is neither a network nor a file-system
// request, so it works identically in dev, packaged builds and with Offline
// Mode on (same approach as the inlined chart.js). Only the latin subsets
// are inlined (~165 KB base64 in the lazy DiagnosticsPage chunk); glyphs
// outside them fall back per character to the next family in the stack.
// tests/diagnostics-frame-fonts.test.mjs guards this.
import soraRegular from '@fontsource/sora/files/sora-latin-400-normal.woff2?inline';
import soraMedium from '@fontsource/sora/files/sora-latin-500-normal.woff2?inline';
import soraSemibold from '@fontsource/sora/files/sora-latin-600-normal.woff2?inline';
import textRegular from '@fontsource/red-hat-text/files/red-hat-text-latin-400-normal.woff2?inline';
import textMedium from '@fontsource/red-hat-text/files/red-hat-text-latin-500-normal.woff2?inline';
import textSemibold from '@fontsource/red-hat-text/files/red-hat-text-latin-600-normal.woff2?inline';
import monoRegular from '@fontsource/red-hat-mono/files/red-hat-mono-latin-400-normal.woff2?inline';
import monoMedium from '@fontsource/red-hat-mono/files/red-hat-mono-latin-500-normal.woff2?inline';

// Same families and weights src/main.jsx loads for the app itself.
const DIAGNOSTICS_FRAME_FONTS = [
  { family: 'Sora', weight: 400, data: soraRegular },
  { family: 'Sora', weight: 500, data: soraMedium },
  { family: 'Sora', weight: 600, data: soraSemibold },
  { family: 'Red Hat Text', weight: 400, data: textRegular },
  { family: 'Red Hat Text', weight: 500, data: textMedium },
  { family: 'Red Hat Text', weight: 600, data: textSemibold },
  { family: 'Red Hat Mono', weight: 400, data: monoRegular },
  { family: 'Red Hat Mono', weight: 500, data: monoMedium },
];

/** @font-face rules for the frame, every src an inline data: URL. */
export const DIAGNOSTICS_FRAME_FONT_CSS = DIAGNOSTICS_FRAME_FONTS
  .map(({ family, weight, data }) =>
    `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${weight}; font-display: swap; src: url(${data}) format('woff2'); }`)
  .join('\n');

/** True for a top-level @font-face rule (CSSRule.FONT_FACE_RULE === 5). */
export function isFontFaceRule(rule) {
  if (!rule) return false;
  if (rule.type === 5) return true;
  return typeof rule.cssText === 'string' && /^\s*@font-face\b/i.test(rule.cssText);
}

/**
 * Serialize the ALREADY-PARSED rules of every stylesheet in `doc` back to
 * text so the frame can inline them without a fetch. @font-face rules are
 * left out: their url() sources cannot load from the opaque-origin frame
 * (see the header) and DIAGNOSTICS_FRAME_FONT_CSS replaces them.
 */
export function serializeParentStyles(doc) {
  return Array.from(doc.styleSheets)
    .map((sheet) => {
      try {
        return Array.from(sheet.cssRules)
          .filter((rule) => !isFontFaceRule(rule))
          .map((rule) => rule.cssText)
          .join('\n');
      } catch {
        // A CORS-protected cross-origin sheet throws on cssRules access. This
        // app loads no such stylesheets, but never let one break the build.
        return '';
      }
    })
    .join('\n');
}

/** Everything that goes into the frame's first <style>: app rules + fonts. */
export function buildDiagnosticsFrameStyles(doc) {
  return `${serializeParentStyles(doc)}\n${DIAGNOSTICS_FRAME_FONT_CSS}`;
}
