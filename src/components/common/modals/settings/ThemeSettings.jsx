import { useEffect, useState } from 'react';
import { useThemeOptional, isCustomScheme } from '../../../../contexts/ThemeContext';
import { Button, ButtonRow, Field, Note, Section, Select } from './ui';
import ConfirmationModal from '../ConfirmationModal';
import ImportJsonModal from '../../ImportJsonModal';
import ExportJsonModal from '../../ExportJsonModal';
import CustomThemeEditor from './CustomThemeEditor';
import SchemeGallery from './SchemeGallery';
import {
  MAX_THEME_FILE_BYTES, loadCustomThemes, newThemeId, normalizeThemeName, planThemeImport, readThemeImport, schemeThemeId, themeFileName, themeFileObject, themeSchemeId, uniqueThemeName, validateCustomTheme,
} from '../../../../utils/customThemes';
import { schemeStarter, starterForScheme, themeFromStarter } from '../../../../utils/themeStarters';

const systemPrefersDark = () => typeof window === 'undefined' || !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;

/** The built-in scheme on screen ('auto' resolved through the system). */
function resolvedScheme(scheme) {
  if (scheme !== 'auto') return scheme;
  return systemPrefersDark() ? 'dark' : 'light';
}

/**
 * The model the Customize block starts from for a scheme: one of the user's themes as it is saved (kind 'custom'),
 * or a copy of the built-in scheme's / the palette's template named "<scheme> (custom)" (kind 'starter').
 */
function sourceFor(scheme, customThemes) {
  if (isCustomScheme(scheme)) {
    const t = customThemes.find((c) => c.id === schemeThemeId(scheme));
    return t ? { kind: 'custom', theme: { ...t, colors: { ...t.colors }, fills: { ...t.fills } } } : null;
  }
  const starter = schemeStarter(scheme) || starterForScheme(resolvedScheme(scheme));
  return starter ? { kind: 'starter', theme: themeFromStarter(starter, customThemes, `${starter.name} (custom)`) } : null;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Settings > Theme: the scheme gallery (the built-in schemes, the palettes,
 * the user's themes - a click switches at once; src/contexts/ThemeContext.jsx
 * remembers the choice), then Customize: the scheme on screen as an editable
 * theme (name, base, the colours, the rail's fill, the logo) that previews
 * live and saves as a new theme of the user's - or, for one of theirs, in
 * place (Save as new keeps the original) - with Reset, Delete, Export JSON
 * (the shared ExportJsonModal: copy or download) and Import JSON (the shared
 * ImportJsonModal). In the desktop app the UI scale (the Electron main
 * process owns and persists it). Everything applies as you make it -
 * nothing here goes through Save Settings. The props come from
 * SettingsModal, which keeps the same state it kept when these lived under
 * General.
 */
export default function ThemeSettings({ theme, setTheme }) {
  // the custom themes live in the ThemeContext; a panel rendered without the provider (a test) shows the gallery only
  const ctx = useThemeOptional();
  const customThemes = ctx ? ctx.customThemes : [];
  const selectedCustom = isCustomScheme(theme) ? customThemes.find((t) => t.id === schemeThemeId(theme)) || null : null;
  // the Customize block: its source (the scheme on screen) and the draft; the draft follows a new selection
  // (derived during render: the key is the scheme and, for a theme of the user's, its last save)
  const key = `${theme}|${selectedCustom ? selectedCustom.updatedAt : ''}`;
  const [seen, setSeen] = useState(null);
  const [source, setSource] = useState(null);
  const [draft, setDraft] = useState(null);
  if (ctx && key !== seen) {
    const s = sourceFor(theme, customThemes);
    setSeen(key);
    setSource(s);
    setDraft(s ? s.theme : null);
  }
  const dirty = !!(source && draft) && !same(draft, source.theme);
  const [pendingScheme, setPendingScheme] = useState(null);   // a tile clicked while the draft has changes
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState(null);       // { tone, text } after an import / a save that failed

  // an import from Settings > General (the database) changed the list: re-read it
  const replaceCustomThemes = ctx ? ctx.replaceCustomThemes : null;
  useEffect(() => {
    if (!replaceCustomThemes) return undefined;
    const reload = () => replaceCustomThemes(loadCustomThemes());
    window.addEventListener('jacarium-custom-themes-changed', reload);
    return () => window.removeEventListener('jacarium-custom-themes-changed', reload);
  }, [replaceCustomThemes]);
  // a changed draft previews on the whole app; an unchanged one lets the scheme itself paint
  const setPreviewTheme = ctx ? ctx.setPreviewTheme : null;
  useEffect(() => {
    if (!setPreviewTheme) return undefined;
    if (!dirty) { setPreviewTheme(null); return undefined; }
    const v = validateCustomTheme(draft);
    if (v.ok) setPreviewTheme(v.theme);   // an incomplete colour keeps the last valid preview
    return undefined;
  }, [draft, dirty, setPreviewTheme]);
  // leaving the panel ends the preview; the setter is the provider's for the panel's life
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a cleanup only, run once on unmount
  useEffect(() => () => { if (setPreviewTheme) setPreviewTheme(null); }, []);

  const select = (id) => {
    if (id === theme) return;
    if (dirty) { setPendingScheme(id); return; }
    setNotice(null);
    setTheme(id);
  };
  const nameError = draft && !normalizeThemeName(draft.name) ? 'A name of 1 to 60 characters' : (draft && customThemes.some((t) => t.id !== draft.id && t.name.toLowerCase() === normalizeThemeName(draft.name)?.toLowerCase()) ? 'Another theme has this name' : '');
  const store = (candidate) => {
    const stored = ctx.saveCustomTheme(candidate);
    if (!stored) { setNotice({ tone: 'danger', text: 'The theme could not be saved: a colour or the rail fill is not complete.' }); return null; }
    setNotice(null);
    return stored;
  };
  // Save: one of the user's themes is saved in place; a built-in scheme or a palette becomes a new theme, chosen
  const save = () => {
    if (!draft || nameError) return;
    const now = new Date().toISOString();
    if (source.kind === 'custom') { store({ ...draft, updatedAt: now }); return; }
    const stored = store({ ...draft, id: newThemeId(), createdAt: now, updatedAt: now });
    if (stored) setTheme(themeSchemeId(stored));
  };
  // Save as new: the draft under its own id (a clashing name gets "(copy)"), the original untouched
  const saveAsNew = () => {
    if (!draft || !normalizeThemeName(draft.name)) return;
    const now = new Date().toISOString();
    const stored = store({ ...draft, id: newThemeId(), name: uniqueThemeName(draft.name, customThemes, 'copy'), createdAt: now, updatedAt: now });
    if (stored) setTheme(themeSchemeId(stored));
  };
  const reset = () => { if (source) setDraft(source.theme); };
  const remove = () => { if (selectedCustom) ctx.deleteCustomTheme(selectedCustom.id); setConfirmDelete(false); };
  // Export: the theme as shown (a changed draft included, once it validates)
  const exportTheme = (() => { if (!draft) return null; const v = validateCustomTheme(draft); return v.ok ? v.theme : (source ? source.theme : null); })();
  // Import JSON (the shared dialog): the text is read as themes (a theme file, a bare theme, an array, or a
  // database export's customThemes section) under the strict rules; the dry run says what would be added and how
  // a clashing name is renamed; the import adds each theme under its own id and applies the first
  const parseThemes = (text) => {
    if (text.length > MAX_THEME_FILE_BYTES) throw new Error(`the input is larger than ${Math.round(MAX_THEME_FILE_BYTES / 1024)} KB (a theme file is a few KB)`);
    return readThemeImport(JSON.parse(text));
  };
  const validateThemes = (r) => (r.errors.length ? `Not imported: ${r.errors.join('; ')}` : (r.themes.length ? true : 'No theme in the input'));
  const dryRunThemes = (r) => {
    const plan = planThemeImport(r.themes, customThemes);
    const lines = plan.map((p) => (p.skipped ? `"${p.name}" would be skipped: ${p.skipped}` : `"${p.finalName}" would be added${p.renamed ? ` (renamed: "${p.name}" exists)` : ''}`));
    return { lines: [`${plan.filter((p) => !p.skipped).length} theme${plan.filter((p) => !p.skipped).length === 1 ? '' : 's'} would be added`, ...lines], errors: [] };
  };
  const importThemes = (r) => {
    const plan = planThemeImport(r.themes, customThemes);
    let first = null;
    const added = [];
    r.themes.forEach((t, i) => {
      const p = plan[i];
      if (!p || p.skipped) return;
      const stored = ctx.saveCustomTheme({ ...t, id: newThemeId(), name: p.finalName });
      if (stored) { added.push(stored.name); if (!first) first = stored; }
    });
    if (first) setTheme(themeSchemeId(first));
    setNotice(added.length ? { tone: 'success', text: `Imported ${added.map((n) => `"${n}"`).join(', ')}${first ? ` and applied "${first.name}"` : ''}.` } : { tone: 'danger', text: 'Nothing imported: the list of custom themes is full.' });
  };

  const isCustomSource = source?.kind === 'custom';
  return (
    <Section title="Theme" testId="theme-section">
      <p className="text-xs text-os-text-muted">Click a scheme to switch to it (the arrow keys move between them). Auto follows the system and uses Jacaranda as its dark theme; Dark (neutral) is the grey dark theme; the gradient schemes paint the sidebar. A palette applies as it is; Your themes are the ones you saved below.</p>
      <SchemeGallery theme={theme} customThemes={customThemes} onSelect={select} systemDark={systemPrefersDark()} />
      {ctx && draft && (
        <div className="pt-2" data-testid="theme-customize">
          <p className="text-xs font-medium text-os-text-primary mb-1">Customize</p>
          <p className="text-xs text-os-text-muted mb-3">{isCustomSource ? 'This is one of your themes: change what you like and Save; Save as new keeps the original. Changes preview on the whole app as you make them.' : 'The scheme on screen as a theme of your own: give it a name, change what you like and Save - the scheme itself never changes. Changes preview on the whole app as you make them.'}</p>
          <ButtonRow align="start" className="mb-3">
            <Button size="sm" onClick={() => { setNotice(null); setExportOpen(true); }} disabled={!exportTheme} data-testid="custom-theme-export" title="the theme as shown, as JSON to copy or download">Export JSON</Button>
            <Button size="sm" onClick={() => { setNotice(null); setImportOpen(true); }} disabled={dirty} data-testid="custom-theme-import" title={dirty ? 'save or reset your changes first' : 'a theme file, pasted or chosen'}>Import JSON</Button>
          </ButtonRow>
          {notice && <Note tone={notice.tone} className="mb-3" testId="custom-theme-notice">{notice.text}</Note>}
          <CustomThemeEditor
            theme={draft}
            onChange={setDraft}
            nameError={nameError}
            footer={(
              <ButtonRow>
                {isCustomSource && <Button variant="danger" onClick={() => setConfirmDelete(true)} data-testid="custom-theme-delete">Delete</Button>}
                <Button onClick={reset} disabled={!dirty} data-testid="custom-theme-reset" title="back to the scheme's own values">Reset</Button>
                {isCustomSource && <Button onClick={saveAsNew} disabled={!normalizeThemeName(draft.name)} data-testid="custom-theme-save-as-new" title="a new theme with these values; this one stays as it is">Save as new</Button>}
                <Button variant="primary" onClick={save} disabled={!!nameError || (isCustomSource && !dirty)} data-testid="custom-theme-save">{isCustomSource ? 'Save' : 'Save as new theme'}</Button>
              </ButtonRow>
            )}
          />
        </div>
      )}
      <ConfirmationModal
        isOpen={pendingScheme !== null}
        onConfirm={() => { const next = pendingScheme; setPendingScheme(null); setNotice(null); setTheme(next); }}
        onCancel={() => setPendingScheme(null)}
        title="Discard your changes?"
        message={`The Customize block has changes that are not saved. Switching to another scheme discards them${isCustomSource ? '' : ' (Save as new theme keeps them)'}.`}
        type="warning"
        confirmLabel="Discard and switch"
      />
      <ConfirmationModal
        isOpen={confirmDelete}
        onConfirm={remove}
        onCancel={() => setConfirmDelete(false)}
        title="Delete this theme?"
        message={selectedCustom ? `"${selectedCustom.name}" is removed from this device; the colour scheme goes back to Auto. An exported copy is not affected.` : ''}
        type="danger"
        confirmLabel="Delete"
      />
      {ctx && exportTheme && (
        <ExportJsonModal
          isOpen={exportOpen}
          onClose={() => setExportOpen(false)}
          title="Export Theme"
          description={`"${exportTheme.name}" as a theme file: copy it to paste into another Jacarium's Import JSON, or download it as ${themeFileName(exportTheme)}.`}
          text={JSON.stringify(themeFileObject(exportTheme), null, 2)}
          filename={themeFileName(exportTheme)}
          testId="export-theme-modal"
        />
      )}
      {ctx && (
        <ImportJsonModal
          isOpen={importOpen}
          onClose={() => setImportOpen(false)}
          title="Import Theme"
          description={`Upload a theme file (.jacarium-theme.json, as Export JSON writes it) or paste its JSON; several themes come as an array or as a database export's customThemes. The file is checked (at most ${Math.round(MAX_THEME_FILE_BYTES / 1024)} KB, known keys, colours as #rgb / #rrggbb / rgb() / hsl(), structured gradients) and nothing of it is used before it passes. Dry Run shows what would be added.`}
          importLabel="Import Theme"
          placeholder='{ "format": "jacarium-theme", "formatVersion": 1, "theme": { ... } }'
          parse={parseThemes}
          validateFn={validateThemes}
          onDryRun={(r) => dryRunThemes(r)}
          onValidated={(r) => importThemes(r)}
          accept=".json,application/json"
          testId="import-theme-modal"
        />
      )}
    </Section>
  );
}
