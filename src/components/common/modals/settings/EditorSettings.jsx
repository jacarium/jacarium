import { useEffect, useState } from 'react';
import { isDesktopApp } from '../../../../utils/platform';
import { isSpellcheckEnabled, setSpellcheckEnabled } from '../../../../utils/editorSurface';
import { Button, Checkbox, Field, Note, Section, Toggle } from './ui';

/**
 * Settings > Editor: the Documents editor's spell checking
 * (src/utils/editorSurface.js; applies to open editors at once) and, in the
 * desktop app, the languages and the custom words of the checker.
 */
export default function EditorSettings() {
  const [spellcheck, setSpellcheck] = useState(() => isSpellcheckEnabled());
  const desktop = isDesktopApp();
  const api = desktop ? window.electronAPI?.spellcheck : null;
  // the desktop app's languages ({ native, available: [{ code, label }], selected }) and custom words
  const [languages, setLanguages] = useState(null);
  const [words, setWords] = useState(null);
  const [languageError, setLanguageError] = useState(null);
  useEffect(() => {
    if (!api) return undefined;
    let cancelled = false;
    api.getLanguages().then((l) => { if (!cancelled) setLanguages(l); }).catch(() => {});
    api.listWords().then((w) => { if (!cancelled) setWords(w); }).catch(() => {});
    return () => { cancelled = true; };
  }, [api]);
  const changeSpellcheck = (on) => { setSpellcheckEnabled(on); setSpellcheck(on); };
  const toggleLanguage = async (code, on) => {
    const next = on ? [...new Set([...(languages.selected || []), code])] : (languages.selected || []).filter((c) => c !== code);
    const result = await api.setLanguages(next).catch((e) => ({ ok: false, reason: e.message }));
    if (result?.ok) { setLanguages((l) => ({ ...l, selected: result.selected })); setLanguageError(null); } else setLanguageError(result?.reason || 'not changed');
  };
  const removeWord = async (word) => {
    const result = await api.removeWord(word).catch(() => ({ ok: false }));
    if (result?.ok) setWords((list) => list.filter((w) => w !== word));
  };
  return (
    <Section title="Editor" testId="editor-section">
      <Toggle label="Check spelling" checked={spellcheck} onChange={changeSpellcheck} testId="editor-spellcheck-toggle"
        hint={desktop
          ? 'Misspelled words are underlined as you type; right-click one for suggestions and "Add to dictionary". Code blocks, inline code, links and the [[toc]]-style directives are not checked.'
          : 'Misspelled words are underlined by your browser as you type; Shift + right-click opens the browser\'s own menu with its suggestions. Code blocks, inline code, links and the [[toc]]-style directives are not checked.'} />
      {languages && (
        <Field label="Spelling languages" hint={languages.native
          ? 'On macOS the system spell checker is used: its languages follow System Settings > Keyboard > Edit... > Spelling.'
          : 'The dictionaries shipped with the app (none is downloaded). Several can be on at once.'}>
          {languages.native ? null : (
            <div className="flex flex-col gap-1" data-testid="spellcheck-languages">
              {languages.available.map((l) => (
                <Checkbox key={l.code} label={`${l.label} (${l.code})`} checked={(languages.selected || []).includes(l.code)} onChange={(on) => toggleLanguage(l.code, on)} testId={`spellcheck-language-${l.code}`} />
              ))}
              {languageError && <Note tone="warning" testId="spellcheck-language-error">{languageError}</Note>}
            </div>
          )}
        </Field>
      )}
      {words && (
        <Field label="Custom words" hint="Words added from the editor's right-click menu (Add to dictionary); the spell checker no longer flags them.">
          {words.length === 0 ? (
            <p className="text-xs text-os-text-muted" data-testid="spellcheck-words-empty">None yet. Right-click a flagged word in a document and choose Add to dictionary.</p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="spellcheck-words">
              {words.map((w) => (
                <li key={w} className="flex items-center justify-between gap-2 text-sm text-os-text-primary">
                  <span className="font-mono">{w}</span>
                  <Button size="sm" onClick={() => removeWord(w)} data-testid="spellcheck-word-remove">Remove</Button>
                </li>
              ))}
            </ul>
          )}
        </Field>
      )}
    </Section>
  );
}
