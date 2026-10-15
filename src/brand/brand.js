/**
 * The brand's words, from one source: package.json. Vite injects the
 * description as __APP_TAGLINE__ and the homepage as __APP_HOMEPAGE__
 * (vite.config.js `define`), the same way the version reaches the app, so
 * the sign-in page, Settings > About, the downloads page (backend
 * version_info.py reads the same file) and the Electron About panel all say
 * the same sentence. tests/brand.test.mjs checks the static copies
 * (index.html, the metainfo and desktop files) against it.
 */
export const BRAND_NAME = 'Jacarium';

export function brandTagline() {
  return typeof __APP_TAGLINE__ !== 'undefined' ? __APP_TAGLINE__ : '';
}

export function brandHomepage() {
  return typeof __APP_HOMEPAGE__ !== 'undefined' ? __APP_HOMEPAGE__ : 'https://jacarium.com';
}

/** The author (package.json `author`): { name, url } - About's "Created by". */
export function brandAuthor() {
  return typeof __APP_AUTHOR__ !== 'undefined' ? __APP_AUTHOR__ : { name: 'Robin Cernin', url: 'https://github.com/zerodayz' };
}

const FUNDING_FALLBACK = ['https://ko-fi.com/robincernin', 'https://github.com/sponsors/zerodayz'];

/** Short names for the support pages About links to. */
function fundingLabel(url) {
  if (/ko-fi\.com/.test(url)) return 'Ko-fi';
  if (/github\.com\/sponsors/.test(url)) return 'GitHub Sponsors';
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** Where to support the project (package.json `funding`, one or a list): About's "Support Jacarium", [{ url, label }]. */
export function brandFunding() {
  const urls = typeof __APP_FUNDING__ !== 'undefined' ? __APP_FUNDING__ : FUNDING_FALLBACK;
  return urls.map((url) => ({ url, label: fundingLabel(url) }));
}

/** The source repository (package.json `repository.url`), for the About page's "Source code" link. */
export function brandRepository() {
  return typeof __APP_REPOSITORY__ !== 'undefined' ? __APP_REPOSITORY__ : 'https://github.com/jacarium/jacarium';
}

/** The repository without the scheme, for a link label ("github.com/jacarium/jacarium"). */
export function brandRepositoryLabel() {
  return brandRepository().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** The host of the homepage, for a link label ("jacarium.com"). */
export function brandHomepageLabel() {
  return brandHomepage().replace(/^https?:\/\//, '').replace(/\/$/, '');
}
