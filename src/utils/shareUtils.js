/**
 * Share utilities for encoding/decoding builder state to URL
 */

/**
 * Encode builder state to Base64 URL-safe string
 * @param {Object} state - Builder state {rules, logic, sortFields}
 * @returns {string} - Base64 encoded string
 */
export function encodeBuilderState(state) {
  try {
    const json = JSON.stringify(state);
    // Convert to Base64 and make URL-safe
    const base64 = btoa(json);
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  } catch (error) {
    console.error('Failed to encode builder state:', error);
    return null;
  }
}

/**
 * Decode Base64 URL-safe string to builder state
 * @param {string} encoded - Base64 encoded string
 * @returns {Object|null} - Decoded state or null if invalid
 */
export function decodeBuilderState(encoded) {
  try {
    // Restore URL-safe Base64 to regular Base64
    let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');

    // Add padding if needed
    while (base64.length % 4) {
      base64 += '=';
    }

    const json = atob(base64);
    const state = JSON.parse(json);

    // Validate state structure - support both old (rules/logic) and new (rootGroup) formats
    const hasOldFormat = state.rules && Array.isArray(state.rules) && state.logic;
    const hasNewFormat = state.rootGroup && state.rootGroup.type === 'group';

    if (!hasOldFormat && !hasNewFormat) {
      throw new Error('Invalid state structure');
    }

    // Validate sortFields if present
    if (state.sortFields && !Array.isArray(state.sortFields)) {
      throw new Error('Invalid sortFields structure');
    }

    return state;
  } catch (error) {
    console.error('Failed to decode builder state:', error);
    return null;
  }
}

/**
 * Get shareable URL for current builder state
 * @param {Object} state - Builder state
 * @returns {string} - Full URL with encoded state
 */
export function getShareableURL(state) {
  const encoded = encodeBuilderState(state);
  if (!encoded) return null;

  // In Electron, window.location.href is file://, so just return the encoded state
  if (window.electronAPI?.isElectron) {
    return encoded; // Return just the encoded query state
  }

  const url = new URL(window.location.href);
  url.searchParams.set('q', encoded);
  return url.toString();
}

/**
 * Get builder state from current URL
 * @returns {Object|null} - Decoded state or null
 */
export function getStateFromURL() {
  const params = new URLSearchParams(window.location.search);
  const encoded = params.get('q');

  if (!encoded) return null;

  return decodeBuilderState(encoded);
}

/**
 * Clear query parameter from URL without reload
 */
export function clearURLState() {
  const url = new URL(window.location.href);
  url.searchParams.delete('q');
  window.history.replaceState({}, '', url.toString());
}
