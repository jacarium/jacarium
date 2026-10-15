/**
 * Browser-local storage scoped to the signed-in account.
 *
 * The app's database is one per account (src/db/database.js), but a few
 * things live in localStorage or in a second IndexedDB (the AI chat
 * history, the Taskwarrior purge list, custom grids and quizzes). They are
 * per BROWSER by nature, so when two accounts share one browser they must
 * not see each other's: every key gets the account's id appended while an
 * account is signed in (a browser session, or a desktop profile linked to
 * a home server - src/main.jsx sets the scope before the app loads).
 * Without an account the keys are what they always were.
 */
import { currentUser } from './auth';

let desktopScope = null;   // the linked account of a desktop profile (set by main.jsx)

/** Pin the account scope (desktop: the linked account's id; null = none). */
export function setAccountScope(id) {
  desktopScope = id || null;
}

/** The id of the account this browser session belongs to, or null. */
export function accountScope() {
  if (desktopScope) return desktopScope;
  const user = currentUser();
  return user?.id || null;
}

/** A localStorage key for this account (`key:<account id>`), or the plain key without one. */
export function scopedKey(key) {
  const scope = accountScope();
  return scope ? `${key}:${scope}` : key;
}

/** A database name for this account (`base-<account id>`), or the plain name. */
export function scopedDbName(base) {
  const scope = accountScope();
  return scope ? `${base}-${scope}` : base;
}
