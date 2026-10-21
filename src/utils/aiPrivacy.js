/**
 * The user's own say over the AI-context redaction (src/utils/aiContext.js),
 * remembered on this device: values never to hide (allow: a public
 * registry the detector gets wrong, the lab domain the model may see) and
 * values always to hide (deny). Kept in localStorage, per device - never in
 * the settings scopes (This device / My account / Everyone), never in a
 * settings payload: a hostname that is private in one place need not be in
 * another, and the lists are the user's privacy choice, not configuration.
 * Settings > AI > Privacy edits them; the context dialog adds to them.
 */
import { useSyncExternalStore } from 'react';

export const PRIVACY_STORAGE_KEY = 'jacarium.aiPrivacy';
const listeners = new Set();
let cached = null;

function read() {
  if (cached) return cached;
  try {
    const raw = JSON.parse(localStorage.getItem(PRIVACY_STORAGE_KEY) || 'null');
    cached = { allow: Array.isArray(raw?.allow) ? raw.allow.filter((v) => typeof v === 'string' && v) : [], deny: Array.isArray(raw?.deny) ? raw.deny.filter((v) => typeof v === 'string' && v) : [] };
  } catch { cached = { allow: [], deny: [] }; }
  return cached;
}

function write(next) {
  cached = { allow: [...new Set(next.allow)], deny: [...new Set(next.deny)] };
  try { localStorage.setItem(PRIVACY_STORAGE_KEY, JSON.stringify({ version: 1, ...cached })); } catch { /* storage unavailable */ }
  for (const fn of listeners) fn();
}

/** { allow: string[], deny: string[] } */
export function getPrivacyLists() {
  return read();
}

export function subscribePrivacy(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The lists, re-rendering on change. */
export function usePrivacyLists() {
  return useSyncExternalStore(subscribePrivacy, read, read);
}

const norm = (v) => String(v || '').trim();

/** Never hide this value (and take it off the deny list). */
export function allowValue(value) {
  const v = norm(value); if (!v) return;
  const cur = read();
  write({ allow: [...cur.allow, v], deny: cur.deny.filter((d) => d.toLowerCase() !== v.toLowerCase()) });
}
/** Always hide this value (and take it off the allow list). */
export function denyValue(value) {
  const v = norm(value); if (!v) return;
  const cur = read();
  write({ allow: cur.allow.filter((a) => a.toLowerCase() !== v.toLowerCase()), deny: [...cur.deny, v] });
}
export function forgetValue(value) {
  const v = norm(value).toLowerCase();
  const cur = read();
  write({ allow: cur.allow.filter((a) => a.toLowerCase() !== v), deny: cur.deny.filter((d) => d.toLowerCase() !== v) });
}
/** Tests: drop the cache after writing localStorage directly. */
export function resetPrivacyCache() {
  cached = null;
}
