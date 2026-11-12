/**
 * The faces of a reading font (src/utils/readingFonts.js READING_FONTS) as
 * @font-face rules with data: URLs - the same latin woff2 files, inlined by
 * Vite's `?inline` imports - for a document that cannot load the app's
 * stylesheets or files: the sandboxed Diagnostics report frame (an opaque
 * origin, which the theme bridge serves). A module of its own, imported by
 * the Diagnostics page only, so the inlined files travel with that chunk.
 * Loaded only when asked for, once per font; '' for the default font or an
 * unknown id.
 */
const faceFiles = {
  atkinson: () => Promise.all([
    import('@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-normal.woff2?inline').then((m) => ['Atkinson Hyperlegible', 400, 'normal', m.default]),
    import('@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-700-normal.woff2?inline').then((m) => ['Atkinson Hyperlegible', 700, 'normal', m.default]),
    import('@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin-400-italic.woff2?inline').then((m) => ['Atkinson Hyperlegible', 400, 'italic', m.default]),
  ]),
  lexend: () => Promise.all([
    import('@fontsource/lexend/files/lexend-latin-400-normal.woff2?inline').then((m) => ['Lexend', 400, 'normal', m.default]),
    import('@fontsource/lexend/files/lexend-latin-700-normal.woff2?inline').then((m) => ['Lexend', 700, 'normal', m.default]),
  ]),
  opendyslexic: () => Promise.all([
    import('@fontsource/opendyslexic/files/opendyslexic-latin-400-normal.woff2?inline').then((m) => ['OpenDyslexic', 400, 'normal', m.default]),
    import('@fontsource/opendyslexic/files/opendyslexic-latin-700-normal.woff2?inline').then((m) => ['OpenDyslexic', 700, 'normal', m.default]),
    import('@fontsource/opendyslexic/files/opendyslexic-latin-400-italic.woff2?inline').then((m) => ['OpenDyslexic', 400, 'italic', m.default]),
  ]),
  // the code font (readingAids.js CODE_FONTS): the report's monospace parts read --font-mono
  atkinsonMono: () => Promise.all([
    import('@fontsource/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-400-normal.woff2?inline').then((m) => ['Atkinson Hyperlegible Mono', 400, 'normal', m.default]),
    import('@fontsource/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-700-normal.woff2?inline').then((m) => ['Atkinson Hyperlegible Mono', 700, 'normal', m.default]),
    import('@fontsource/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-400-italic.woff2?inline').then((m) => ['Atkinson Hyperlegible Mono', 400, 'italic', m.default]),
  ]),
};
const faceCss = new Map();

/** The @font-face rules of the font with `id`, each src a data: URL; '' for the default font. */
export function readingFontFaceCss(id) {
  const load = faceFiles[id];
  if (!load) return Promise.resolve('');
  if (!faceCss.has(id)) {
    faceCss.set(id, load().then(
      (faces) => faces.map(([family, weight, style, data]) => `@font-face { font-family: '${family}'; font-style: ${style}; font-weight: ${weight}; font-display: swap; src: url(${data}) format('woff2'); }`).join('\n'),
      (err) => { faceCss.delete(id); throw err; },
    ));
  }
  return faceCss.get(id);
}
