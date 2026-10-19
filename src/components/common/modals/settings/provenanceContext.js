import { createContext, useContext } from 'react';

/**
 * Where a setting's value comes from, for the tag next to its label in the
 * Settings dialog (src/components/common/modals/settings/ui.jsx Field /
 * Toggle, `forKey`): in the "My account" scope 'your account', 'everyone'
 * (the server defaults) or 'not set'; nothing in the other scopes, where
 * there is one source. The dialog provides `tagFor(key)`.
 */
export const SettingsProvenanceContext = createContext({ tagFor: () => null });

export function useSettingsProvenance() {
  return useContext(SettingsProvenanceContext);
}

/**
 * The tag for a key in the account scope: { tag, detail } from the sources
 * map, the plain values and the stored secrets. `detail` carries the
 * inherited value when the field itself is empty (a browser shows the
 * account file's values only; the server default it inherits is named
 * next to the tag so "everyone" is not an empty field).
 */
export function provenanceTag({ scope, sources, values, secrets, inherited }, key) {
  if (scope !== 'account') return null;
  const source = sources?.[key];
  if (source === 'account') return { tag: 'your account' };
  if (source === 'everyone') {
    const own = values && values[key];
    const inheritedValue = inherited && typeof inherited[key] === 'string' ? inherited[key] : null;
    return { tag: 'everyone', detail: !own && inheritedValue ? inheritedValue : null };
  }
  if ((values && values[key]) || (secrets && secrets[key])) return { tag: 'your account' };
  return { tag: 'not set' };
}
