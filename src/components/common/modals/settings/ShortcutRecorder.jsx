import { useEffect, useId, useRef, useState } from 'react';
import BaseModal from '../BaseModal';
import { Button, Note } from './ui';
import { chordFromEvent, formatChord, hasAnyModifier, hasChordModifier, platformOf, validateChord } from '../../../../shortcuts/registry';
import { setRecording } from '../../../../shortcuts/store';

/**
 * "Press the new shortcut for ..." - records the next chord for an action
 * (Settings > Shortcuts > Change). A dialog over the Settings dialog
 * (BaseModal at z 55, focus trapped), so the keys go nowhere else: the
 * shortcut dispatcher is paused while it is open (store.setRecording) and
 * every keydown here is consumed.
 *
 *   - held modifiers show live; a key with them becomes the candidate,
 *     checked at once (src/shortcuts/registry.js validateChord): a
 *     reserved chord is refused with the reason, a chord another action
 *     holds offers Replace, a Linux terminal / GTK habit warns and can be
 *     used anyway;
 *   - Esc cancels; Backspace or Delete alone clears the binding;
 *   - Use / Replace commits (the button takes focus once a candidate is
 *     recorded, so Enter confirms).
 *
 * Props: action, os ('mac' | 'linux' | 'win'), build ('desktop' | 'web'),
 * bindings (the current map), labelOf(id) for the conflicting action's
 * name, layout (KeyboardLayoutMap or null), onCommit(chord | null, {
 * replaceId }), onCancel.
 */
export default function ShortcutRecorder({ action, os, build, bindings, labelOf, layout = null, onCommit, onCancel }) {
  const [held, setHeld] = useState([]);          // modifier tokens held right now
  const [candidate, setCandidate] = useState(null); // { chord, result }
  const titleId = useId();
  const useRef_ = useRef(null);
  const mac = os === 'mac';

  useEffect(() => {
    setRecording(true);
    return () => setRecording(false);
  }, []);

  // The keys are read at the window (capture), not on the dialog: the focus
  // sits on BaseModal's panel or the Use button, and nothing underneath -
  // the shortcut dispatcher (paused while recording), the Settings dialog's
  // Esc, the browser's own Ctrl+F - may see a chord meant for the recorder.
  const onKeyDownRef = useRef(null);
  const onKeyUpRef = useRef(null);
  useEffect(() => {
    const down = (e) => onKeyDownRef.current?.(e);
    const up = (e) => onKeyUpRef.current?.(e);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); };
  }, []);

  useEffect(() => {
    if (candidate && (candidate.result.ok || candidate.result.level === 'conflict')) useRef_.current?.focus();
  }, [candidate]);

  const modsOf = (e) => {
    const m = [];
    if (mac ? e.metaKey : e.ctrlKey) m.push('Mod');
    if (mac && e.ctrlKey) m.push('Ctrl');
    if (!mac && e.metaKey) m.push('Meta');
    if (e.altKey) m.push('Alt');
    if (e.shiftKey) m.push('Shift');
    return m;
  };

  const onKeyDown = (e) => {
    // the focused Use / Replace button takes Enter and Space itself
    if (candidate && e.target === useRef_.current && (e.key === 'Enter' || e.key === ' ')) return;
    // a plain Tab moves the focus between Cancel and Use (the trap wraps it) - unless Tab itself can be the chord (the canvas's quick-add)
    if (e.key === 'Tab' && !hasChordModifier(e) && !e.altKey && !action.plainKeys) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { onCancel(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !hasAnyModifier(e)) { onCommit(null, {}); return; }
    const chord = chordFromEvent(e, platformOf(os));
    if (!chord) { setHeld(modsOf(e)); return; }
    const result = validateChord(chord, { actionId: action.id, os, build, bindings });
    setHeld([]);
    setCandidate({ chord, result });
  };
  const onKeyUp = (e) => { if (!candidate) setHeld(modsOf(e)); };
  useEffect(() => { onKeyDownRef.current = onKeyDown; onKeyUpRef.current = onKeyUp; });

  const result = candidate?.result;
  const shown = candidate ? formatChord(candidate.chord, { mac, layout }) : (mac ? held.map((m) => ({ Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }[m])).join('') : held.map((m) => ({ Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Super' }[m])).join('+'));
  const canUse = !!candidate && (result.ok || result.level === 'conflict');
  const commit = () => { if (!canUse) return; onCommit(candidate.chord, { replaceId: result.level === 'conflict' ? result.conflictId : null }); };

  return (
    <BaseModal isOpen onClose={onCancel} closeOnBackdropClick={false} closeOnEscape={false} trapFocus zIndex={55} className="w-full max-w-md rounded-lg">
      <div className="p-4 sm:p-5" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="shortcut-recorder" data-action={action.id}>
        <h3 id={titleId} className="text-sm font-semibold text-os-text-primary">Press the new shortcut for &quot;{action.label}&quot;</h3>
        <p className="mt-1 text-xs text-os-text-muted">
          {action.plainKeys ? 'A key, with or without modifiers.' : `Hold ${mac ? '⌘, ⌥ or ⌃' : 'Ctrl or Alt'} and press a key.`} Esc cancels{bindings[action.id] ? '; Backspace clears the shortcut' : ''}.
        </p>
        <div className="mt-4 flex items-center justify-center">
          <kbd className={`min-w-24 px-3 py-2 text-center text-base font-mono border border-os-border rounded-sm bg-os-card-secondary ${candidate ? 'text-os-text-primary' : 'text-os-text-muted'}`} data-testid="recorder-preview">
            {shown || '…'}
          </kbd>
        </div>
        {candidate && result.level === 'block' && <Note tone="danger" className="mt-3" testId="recorder-blocked">{result.message}</Note>}
        {candidate && result.level === 'conflict' && <Note tone="warning" className="mt-3" testId="recorder-conflict">{result.message} Replace it? {labelOf(result.conflictId)} loses its shortcut.</Note>}
        {candidate && result.level === 'warn' && <Note tone="warning" className="mt-3" testId="recorder-warning">{result.message}</Note>}
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} data-testid="recorder-cancel">Cancel</Button>
          <Button ref={useRef_} variant="primary" onClick={commit} disabled={!canUse} data-testid="recorder-use">
            {candidate && result.level === 'conflict' ? `Replace ${labelOf(result.conflictId)}` : candidate && result.level === 'warn' ? `Use ${shown} anyway` : `Use ${shown || 'shortcut'}`}
          </Button>
        </div>
      </div>
    </BaseModal>
  );
}

