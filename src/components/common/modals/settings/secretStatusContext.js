import { createContext, useContext } from 'react';

/**
 * Which secrets (API keys, tokens, passwords) are stored - without their
 * values, which never reach the UI. Provided by SettingsModal as
 * { stored: {KEY: true|false}, onClear(key) }; SecretInput reads it to
 * show "saved" instead of an empty box and to offer "Clear".
 */
export const SecretStatusContext = createContext({ stored: {}, onClear: null });

export function useSecretStatus() {
  return useContext(SecretStatusContext) || { stored: {}, onClear: null };
}
