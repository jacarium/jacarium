/**
 * The legible reading fonts of Settings > Accessibility (src/utils/readingAids.js
 * READING_FONTS), bundled through @fontsource (SIL Open Font License 1.1) so
 * they work offline, and loaded only when chosen: each font's latin
 * regular, bold and italic faces come as their own stylesheet chunk with
 * the woff2 files as assets (Vite), fetched the first time a surface shows
 * that font. Nothing of this reaches the PDF export, which builds its own
 * container outside any reading-aids surface.
 */
const loaders = {
  atkinson: () => Promise.all([
    import('@fontsource/atkinson-hyperlegible/latin-400.css'),
    import('@fontsource/atkinson-hyperlegible/latin-700.css'),
    import('@fontsource/atkinson-hyperlegible/latin-400-italic.css'),
  ]),
  lexend: () => Promise.all([
    import('@fontsource/lexend/latin-400.css'),
    import('@fontsource/lexend/latin-700.css'),
  ]),
  opendyslexic: () => Promise.all([
    import('@fontsource/opendyslexic/latin-400.css'),
    import('@fontsource/opendyslexic/latin-700.css'),
    import('@fontsource/opendyslexic/latin-400-italic.css'),
  ]),
  // the code font (CODE_FONTS): the same mechanism, for everything that reads --font-mono
  atkinsonMono: () => Promise.all([
    import('@fontsource/atkinson-hyperlegible-mono/latin-400.css'),
    import('@fontsource/atkinson-hyperlegible-mono/latin-700.css'),
    import('@fontsource/atkinson-hyperlegible-mono/latin-400-italic.css'),
  ]),
};
const loaded = new Map();

/** The ids of the fonts that can be loaded. */
export const LOADABLE_READING_FONTS = Object.freeze(Object.keys(loaders));

/** Load the font's faces once; resolves when the stylesheet is in the page (false for the default font or an unknown id). */
export function ensureReadingFont(id) {
  const load = loaders[id];
  if (!load) return Promise.resolve(false);
  if (!loaded.has(id)) {
    const p = load().then(() => true, (err) => { loaded.delete(id); throw err; });
    loaded.set(id, p);
  }
  return loaded.get(id);
}
