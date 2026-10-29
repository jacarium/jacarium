/**
 * THE one switch for the seasonal decoration on the in-app mark (the
 * top-left logo and Settings > About):
 *
 *   'auto'       the date decides (each decoration's window in src/brand/seasonal/)
 *   'none'       no decoration, whatever the date - today's plain logo
 *   'pumpkin'    (or any decoration id) that one, whatever the date - for a
 *                preview, a test, a special occasion
 *
 * A release that changes this value is the predictable way to turn a
 * decoration off; nothing else needs to change.
 */
export const ACTIVE_DECORATION = 'auto';

/**
 * A preview knob for the browser / the screenshots / the tests: a value in
 * localStorage under this key overrides ACTIVE_DECORATION for that browser
 * only ('auto', 'none' or a decoration id). Nothing in the app sets it.
 */
export const PREVIEW_STORAGE_KEY = 'brand-decoration';
