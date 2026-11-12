/**
 * Accessibility profiles (Settings > Accessibility, the row of cards at the
 * top): named bundles of the reading aids (src/utils/readingAids.js) for a
 * quick start. A profile sets every option - the ones it cares about to its
 * values, the rest back to the defaults - so profiles never stack: choosing
 * Focus after Low vision leaves no high contrast behind. The settings they
 * are made of are the ordinary ones, so a profile can be adjusted afterwards
 * (the cards then show "Custom, based on ..."), and the data goes through
 * the same normaliser as everything else, so a future option cannot break
 * a profile (every profile must normalise to itself: the unit test checks).
 *
 * The profile last applied is remembered on this device (PROFILE_KEY), for
 * the "based on" note and for the next / previous shortcuts; it is nothing
 * the settings depend on.
 */
import { DEFAULT_READING_AIDS, loadReadingAids, normalizeReadingAids, saveReadingAids } from './readingAids.js';

export const PROFILE_KEY = 'documentsReadingAidsProfile';

export const PROFILES = Object.freeze([
  {
    id: 'default', name: 'Default', description: "Today's look: every reading aid off.",
    settings: {}, preview: { kind: 'plain' },
  },
  {
    id: 'comfortable', name: 'Comfortable reading', description: 'A little more air: line height 1.8, more space after paragraphs, an 80-character column, text at 110 %, links underlined.',
    settings: { lineHeight: 1.8, paragraphSpacing: 1.5, lineWidth: 80, textScale: 110, highlightLinks: true }, preview: { kind: 'airy' },
  },
  {
    // Lexend over OpenDyslexic: Lexend was designed and tested for reading fluency and reads as an ordinary sans, so
    // it suits more readers as a first suggestion; OpenDyslexic stays one click away in the font list
    id: 'dyslexia', name: 'Dyslexia friendly', description: 'Lexend (made for reading fluency; OpenDyslexic is in the font list if you prefer it) with Atkinson Hyperlegible Mono for code, wider letters and words, left-aligned in a 70-character column, line height 1.8, a one-line ruler.',
    settings: { font: 'lexend', codeFont: 'atkinsonMono', letterSpacing: 0.05, wordSpacing: 0.2, textAlign: 'left', lineWidth: 70, lineHeight: 1.8, ruler: true, rulerLines: 1, rulerMode: 'highlight' }, preview: { kind: 'spaced', font: 'Lexend, "Red Hat Text", sans-serif' },
  },
  {
    id: 'lowVision', name: 'Low vision', description: 'Text at 150 % with the interface scaled too, high contrast, Atkinson Hyperlegible (and its Mono for code), links underlined.',
    settings: { textScale: 150, scaleChrome: true, highContrast: true, highlightLinks: true, font: 'atkinson', codeFont: 'atkinsonMono' }, preview: { kind: 'contrast', font: '"Atkinson Hyperlegible", "Red Hat Text", sans-serif' },
  },
  {
    id: 'focus', name: 'Focus', description: 'A three-line mask ruler, colours toned down to 60 %, images hidden, motion reduced, a 70-character column. Zen mode (Settings > Shortcuts) hides the chrome as well.',
    settings: { ruler: true, rulerLines: 3, rulerMode: 'mask', saturation: 60, hideImages: true, lineWidth: 70, reduceMotion: 'on' }, preview: { kind: 'mask' },
  },
  {
    id: 'cvRed', name: 'Red-weak', description: 'Colour-blind safe, protanopia: the Okabe-Ito palette for the accent, the status, severity and syntax colours; links underlined.',
    settings: { colorVision: 'protanopia', highlightLinks: true }, preview: { kind: 'palette', colors: ['#0072b2', '#e69f00', '#d55e00'] },
  },
  {
    id: 'cvGreen', name: 'Green-weak', description: 'Colour-blind safe, deuteranopia: the Okabe-Ito palette for the accent, the status, severity and syntax colours; links underlined.',
    settings: { colorVision: 'deuteranopia', highlightLinks: true }, preview: { kind: 'palette', colors: ['#0072b2', '#e69f00', '#d55e00'] },
  },
  {
    id: 'cvBlue', name: 'Blue-weak', description: 'Colour-blind safe, tritanopia: the Okabe-Ito palette for the accent, the status, severity and syntax colours; links underlined.',
    settings: { colorVision: 'tritanopia', highlightLinks: true }, preview: { kind: 'palette', colors: ['#009e73', '#e69f00', '#d55e00'] },
  },
  {
    id: 'calm', name: 'Calm', description: 'Colours toned down to 60 %, images hidden and motion reduced; nothing else changes.',
    settings: { saturation: 60, hideImages: true, reduceMotion: 'on' }, preview: { kind: 'calm' },
  },
]);

const byId = Object.fromEntries(PROFILES.map((p) => [p.id, p]));

/** The profile with `id`, or null. */
export function profileById(id) { return byId[id] || null; }

/** The complete settings a profile stands for (its values over the defaults, normalised). */
export function profileSettings(id) {
  const p = byId[id];
  return normalizeReadingAids(p ? { ...DEFAULT_READING_AIDS, ...p.settings } : DEFAULT_READING_AIDS);
}

const sameSettings = (a, b) => Object.keys(DEFAULT_READING_AIDS).every((k) => a[k] === b[k]);

/** The id of the profile `settings` equal exactly, or null (a custom mix). */
export function matchProfile(settings) {
  const s = normalizeReadingAids(settings);
  const hit = PROFILES.find((p) => sameSettings(profileSettings(p.id), s));
  return hit ? hit.id : null;
}

const storage = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };

/** The profile applied last on this device (for the "based on" note), or null. */
export function lastProfile(store = storage()) {
  try { const v = store && store.getItem(PROFILE_KEY); return v && byId[v] ? v : null; } catch { return null; }
}

/** Apply a profile: every option becomes the profile's (the rest the defaults), live and stored like any setting. */
export function applyProfile(id, store = storage()) {
  if (!byId[id]) return null;
  const next = saveReadingAids(profileSettings(id), store);
  try { if (store) store.setItem(PROFILE_KEY, id); } catch { /* storage absent */ }
  return next;
}

/** What the cards should show for `settings`: the matching profile, or "Custom" with the profile it was based on. */
export function profileState(settings, store = storage()) {
  const match = matchProfile(settings);
  return { match, basedOn: match ? null : lastProfile(store) };
}

/** Apply the next (`direction` 1) or previous (-1) profile after the one matching or last applied; wraps around. */
export function cycleProfile(direction, store = storage()) {
  const current = loadReadingAids(store);
  const from = matchProfile(current) || lastProfile(store);
  const i = from ? PROFILES.findIndex((p) => p.id === from) : -1;
  const next = PROFILES[(i + (direction > 0 ? 1 : -1) + PROFILES.length) % PROFILES.length];
  applyProfile(next.id, store);
  return next.id;
}
