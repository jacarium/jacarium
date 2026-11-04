import { useEffect, useRef, useState } from 'react';
import { isDesktopApp } from '../../../../utils/platform';
import { isSpellcheckEnabled, setSpellcheckEnabled } from '../../../../utils/editorSurface';
import { downloadBlob } from '../../../../utils/exportHelpers';
import { CUSTOM_WORDS_FILENAME, customWordsText, formatCustomWordsResult, mergeCustomWords, parseCustomWordsText } from '../../../../utils/customWords';
import { Button, ButtonRow, Checkbox, Field, Note, Section, Toggle } from './ui';

/**
 * Settings > Editor: the Documents editor's spell checking
 * (src/utils/editorSurface.js; applies to open editors at once) and, in the
 * desktop app, the languages and the custom words of the checker - listed,
 * removable, exported as a plain text file (one word per line) and imported
 * from one (merged: src/utils/customWords.js validates every word and skips
 * what is already there). The file is read here, in the renderer, from the
 * File the user picked: no path crosses the bridge, only the words, which
 * electron/spellcheck.cjs checks again.
 */
export default function EditorSettings() {
  const [spellcheck, setSpellcheck] = useState(() => isSpellcheckEnabled());
  const desktop = isDesktopApp();
  const api = desktop ? window.electronAPI?.spellcheck : null;
  // the desktop app's languages ({ native, available: [{ code, label }], selected }) and custom words
  const [languages, setLanguages] = useState(null);
  const [words, setWords] = useState(null);
  const [languageError, setLanguageError] = useState(null);
  const [wordsResult, setWordsResult] = useState(null);   // { tone, text } after an import or export
  const fileInput = useRef(null);
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
  const exportWords = () => {
    const text = customWordsText(words || []);
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), CUSTOM_WORDS_FILENAME);
    setWordsResult({ tone: 'neutral', text: `Saved ${CUSTOM_WORDS_FILENAME} (${(words || []).length} ${(words || []).length === 1 ? 'word' : 'words'}).` });
  };
  const importWords = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const result = await mergeCustomWords(parseCustomWordsText(await file.text()), api);
      const list = await api.listWords().catch(() => null);
      if (Array.isArray(list)) setWords(list);
      setWordsResult({ tone: result.skipped && !result.added ? 'warning' : 'success', text: formatCustomWordsResult(result) });
    } catch (e) {
      setWordsResult({ tone: 'danger', text: `Could not read ${file.name}: ${e?.message || e}` });
    }
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
        <Field label="Custom words" hint="Words added from the editor's right-click menu (Add to dictionary); the spell checker no longer flags them. They are part of the database export too (Settings > General), and travel on their own as a text file, one word per line.">
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
          <ButtonRow align="start" className="mt-2">
            <Button size="sm" onClick={exportWords} disabled={words.length === 0} data-testid="spellcheck-words-export">Export custom words</Button>
            <Button size="sm" onClick={() => fileInput.current?.click()} data-testid="spellcheck-words-import">Import custom words</Button>
            <input ref={fileInput} type="file" accept=".txt,.json,text/plain,application/json" className="hidden" onChange={importWords} data-testid="spellcheck-words-file" />
          </ButtonRow>
          {wordsResult && <Note tone={wordsResult.tone} className="mt-3" testId="spellcheck-words-result">{wordsResult.text}</Note>}
        </Field>
      )}
    </Section>
  );
}
