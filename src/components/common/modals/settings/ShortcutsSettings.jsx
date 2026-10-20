import { useMemo, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import ConfirmationModal from '../ConfirmationModal';
import ShortcutRecorder from './ShortcutRecorder';
import { Button, Note, Section, SubTabs, TextInput } from './ui';
import { GROUPS, SCOPES, actionById, actionsForBuild, aliasesOf, defaultChord, formatChord, isRebindable, platformOf } from '../../../../shortcuts/registry';
import { bindAction, buildKind, detectOs, getOverrides, resetAction, resetAll } from '../../../../shortcuts/store';
import { useShortcutBindings } from '../../../../shortcuts/useShortcut';
import { useKeyboardLayout } from '../../../../shortcuts/layout';

/**
 * Settings > Shortcuts: every action of the registry (src/shortcuts/
 * registry.js) with the chord bound on this device - searchable, by group
 * - with Change (the recorder), x (unassign), Reset for one that differs
 * from its default and Reset all. Labels follow the platform (⌃⌥⇧⌘ on a
 * Mac, Ctrl/Alt/Shift elsewhere) and the keyboard layout. Changes apply
 * as they are made and are stored on this device only (src/shortcuts/
 * store.js): never part of the settings scopes or the copy sheet. A
 * browser shows the actions that exist there (no Settings / Toggle
 * sidebar / zoom / reload: those are the desktop menu's).
 */
export default function ShortcutsSettings() {
  const bindings = useShortcutBindings();
  const layout = useKeyboardLayout();
  const os = detectOs();
  const mac = os === 'mac';
  const build = buildKind();
  const platform = platformOf(os);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [recording, setRecordingFor] = useState(null);   // action id
  const [confirmReset, setConfirmReset] = useState(false);
  const [error, setError] = useState('');
  const overrides = getOverrides();
  const hasOverrides = Object.keys(overrides).length > 0;

  const actions = useMemo(() => actionsForBuild(build), [build]);
  const q = query.trim().toLowerCase();
  const visible = actions.filter((a) => (group === 'all' || a.group === group) && (!q || a.label.toLowerCase().includes(q) || formatChord(bindings[a.id], { mac, layout }).toLowerCase().includes(q) || a.id.includes(q)));
  const grouped = GROUPS.map((g) => ({ ...g, actions: visible.filter((a) => a.group === g.id) })).filter((g) => g.actions.length);
  const label = (chord) => formatChord(chord, { mac, layout });
  const labelOf = (id) => actionById(id)?.label || id;

  async function apply(promise) {
    setError('');
    const result = await promise;
    if (result && result.ok === false) setError(result.errors?.map((e) => e.message).join(' ') || 'The shortcut could not be saved.');
    return result;
  }
  const onCommit = async (chord, { replaceId }) => {
    const id = recording;
    setRecordingFor(null);
    if (id) await apply(bindAction(id, chord, { alsoUnassign: replaceId }));
  };

  const row = (action) => {
    const chord = bindings[action.id];
    const rebindable = isRebindable(action);
    const differs = rebindable && Object.prototype.hasOwnProperty.call(overrides, action.id) && chord !== defaultChord(action, platform);
    const aliases = aliasesOf(action, platform).map(label);
    return (
      <div key={action.id} className="flex items-center gap-3 py-2 border-b border-os-border last:border-b-0" data-testid={`shortcut-row-${action.id}`} data-chord={chord || ''}>
        <div className="flex-1 min-w-0">
          <span className="block text-xs text-os-text-primary truncate">{action.label}</span>
          {action.scope !== 'global' && <span className="block text-[11px] text-os-text-muted truncate">{SCOPES[action.scope]}</span>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {chord ? (
            <kbd className="px-1.5 py-0.5 text-[11px] font-mono text-os-text-primary border border-os-border rounded-sm bg-os-card-secondary" data-testid={`shortcut-chord-${action.id}`}>{label(chord)}</kbd>
          ) : (
            <span className="text-[11px] text-os-text-muted" data-testid={`shortcut-chord-${action.id}`}>Unassigned</span>
          )}
          {aliases.length > 0 && <span className="text-[11px] text-os-text-muted">or {aliases.join(', ')}</span>}
          {!rebindable && <span className="text-[11px] text-os-text-muted" data-testid={`shortcut-fixed-${action.id}`}>fixed</span>}
        </div>
        <div className="flex items-center gap-1 shrink-0 w-44 justify-end">
          {rebindable && <Button size="sm" variant="ghost" onClick={() => setRecordingFor(action.id)} data-testid={`shortcut-change-${action.id}`}>Change</Button>}
          {rebindable && chord && (
            <button type="button" onClick={() => apply(bindAction(action.id, null))} className="p-1 rounded-sm text-os-text-muted hover:text-os-text-primary hover:bg-os-card-secondary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40" aria-label={`Unassign ${action.label}`} title="Unassign" data-testid={`shortcut-unassign-${action.id}`}>
              <X size={14} />
            </button>
          )}
          {differs && (
            <button type="button" onClick={() => apply(resetAction(action.id))} className="p-1 rounded-sm text-os-text-muted hover:text-os-text-primary hover:bg-os-card-secondary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40" aria-label={`Reset ${action.label} to ${label(defaultChord(action, platform)) || 'unassigned'}`} title={`Reset to ${label(defaultChord(action, platform)) || 'unassigned'}`} data-testid={`shortcut-reset-${action.id}`}>
              <RotateCcw size={14} />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <Section title="Keyboard shortcuts" testId="shortcuts-settings"
      description={`Shortcuts are stored on this device${build === 'desktop' ? ' (this profile)' : ' (this browser)'}, not in your account's settings. A binding follows the physical key, so it stays in place when the keyboard layout changes.`}
      actions={<Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)} disabled={!hasOverrides} data-testid="shortcuts-reset-all">Reset all</Button>}>
      <TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search shortcuts..." aria-label="Search shortcuts" data-testid="shortcuts-search" />
      <SubTabs className="mb-2" active={group} onChange={setGroup} tabs={[{ id: 'all', label: 'All' }, ...GROUPS.map((g) => ({ id: g.id, label: g.label, testId: `shortcuts-group-${g.id}` }))]} />
      {error && <Note tone="danger" testId="shortcuts-error">{error}</Note>}
      {grouped.length === 0 && <p className="text-xs text-os-text-muted" data-testid="shortcuts-empty">No shortcut matches.</p>}
      {grouped.map((g) => (
        <div key={g.id} data-testid={`shortcuts-section-${g.id}`}>
          <p className="text-xs font-semibold text-os-text-secondary mt-2 mb-1">{g.label}</p>
          {g.actions.map(row)}
        </div>
      ))}
      {recording && (
        <ShortcutRecorder action={actionById(recording)} os={os} build={build} bindings={bindings} labelOf={labelOf} layout={layout}
          onCommit={onCommit} onCancel={() => setRecordingFor(null)} />
      )}
      <ConfirmationModal isOpen={confirmReset} type="warning" title="Reset all shortcuts?" message="Every shortcut on this device goes back to its default." confirmLabel="Reset all"
        onConfirm={async () => { setConfirmReset(false); await apply(resetAll()); }} onCancel={() => setConfirmReset(false)} />
    </Section>
  );
}
