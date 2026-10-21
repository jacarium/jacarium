import { useId, useState } from 'react';
import { Eye, EyeOff, FileText, Trello, GitBranch } from 'lucide-react';
import BaseModal from './modals/BaseModal';
import ConfirmationModal from './modals/ConfirmationModal';
import { Badge, Button, Note, SubTabs, Toggle } from '../ui/primitives';
import { REDACTION_TYPES, maskValue, renderContext } from '../../utils/aiContext';
import { allowValue, denyValue, usePrivacyLists } from '../../utils/aiPrivacy';

/**
 * The eye on an AI chat context chip: exactly what the model receives for
 * that context, and the say over the redaction (src/utils/aiContext.js),
 * on two tabs (SubTabs, the app's straight underline):
 *
 *   Document / Board / Selection (the default): the text itself, editable
 *   and as large as the dialog allows - a hand edit freezes it (the
 *   switches stop applying until Reset), so the preview is always what is
 *   sent - with "Reset to the document / board / selection" (the content
 *   again from its source, redacted afresh, the edit dropped).
 *
 *   Privacy (its label carries the count, "Privacy 4/5"): the redaction
 *   switch for this chat (off needs a confirmation); per type (Tokens &
 *   keys, Hosts, IPs, Emails, Usernames) Hide all / Send all - tokens off
 *   shows a warning; each finding: its type, the value masked (click to
 *   reveal), the placeholder, Keep hidden / Send as is, and Never hide /
 *   Always hide for this device's lists (src/utils/aiPrivacy.js). Every
 *   change applies live to the text on the first tab.
 *
 * The header's summary ("4 of 5 hidden", "edited", "Off for this chat")
 * shows the privacy state on either tab. Both panels stay mounted (the
 * inactive one hidden) so the text and the switches keep their state and
 * their ids while the tabs switch.
 *
 * Everything is a draft until Save; Cancel drops it (the sidebar mounts the
 * dialog per context, keyed by its id). Props: context (as kept on the
 * conversation), onSave(nextContext), onCancel, reload(): Promise<string|
 * null> - the source's current content, ordinal (the block's number when
 * the chat holds several contexts).
 */
export default function AIContextDialog({ context, onSave, onCancel, reload, ordinal = null }) {
  const lists = usePrivacyLists();
  const [draft, setDraft] = useState(context);
  const [tab, setTab] = useState('text');
  const [revealed, setRevealed] = useState({});
  const [confirmOff, setConfirmOff] = useState(false);
  const [reloading, setReloading] = useState(false);
  const titleId = useId();

  const rendered = renderContext(draft, lists, { ordinal });
  const findings = rendered.findings;
  const edited = rendered.edited;
  const policy = draft.policy;
  const setPolicy = (next) => setDraft((d) => ({ ...d, policy: { ...d.policy, ...next, types: { ...d.policy.types, ...(next.types || {}) } } }));
  const decide = (id, choice) => setDraft((d) => ({ ...d, decisions: { ...d.decisions, [id]: choice } }));
  const Icon = draft.kind === 'kanban' ? Trello : draft.kind === 'workflow' ? GitBranch : FileText;
  const sourceLabel = draft.kind === 'kanban' ? 'board' : draft.kind === 'selection' ? 'selection' : draft.kind === 'workflow' ? 'workflow' : 'document';
  const tokensOff = policy.enabled && policy.types.token === false;
  const hiddenCount = findings.filter((f) => f.hidden).length;
  const summaryParts = [];
  if (!policy.enabled) summaryParts.push('Off for this chat');
  else summaryParts.push(`${hiddenCount} of ${findings.length} hidden`);
  if (edited) summaryParts.push('edited');
  const summary = summaryParts.join(' · ');

  async function reset() {
    setReloading(true);
    try {
      const fresh = reload ? await reload() : null;
      setDraft((d) => ({ ...d, raw: fresh ?? d.raw, manual: null, error: fresh == null ? d.error : null }));
    } finally { setReloading(false); }
  }

  const typeRow = (t) => {
    const count = findings.filter((f) => f.type === t.id).length;
    const on = policy.types[t.id] !== false;
    return (
      <div key={t.id} className="flex items-center justify-between gap-3 py-1" data-testid={`ctx-type-${t.id}`}>
        <div className="min-w-0">
          <span className="text-xs text-os-text-primary">{t.label}</span>
          <span className="text-[11px] text-os-text-muted"> {count ? `${count} found` : 'none found'}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-os-text-muted">{on ? 'Hide all' : 'Send all'}</span>
          <Toggle checked={on} disabled={!policy.enabled || edited} onChange={(v) => setPolicy({ types: { [t.id]: v } })} testId={`ctx-type-toggle-${t.id}`} />
        </div>
      </div>
    );
  };

  const findingRow = (f) => (
    <div key={f.id} className="flex flex-wrap items-center gap-2 py-1.5 border-t border-os-border text-xs" data-testid={`ctx-finding-${f.id}`} data-hidden={f.hidden ? 'true' : 'false'}>
      <Badge tone={f.type === 'token' ? 'danger' : 'neutral'}>{f.type === 'custom' ? 'always hide' : (REDACTION_TYPES.find((t) => t.id === f.type)?.label || f.type)}</Badge>
      <button type="button" onClick={() => setRevealed((r) => ({ ...r, [f.id]: !r[f.id] }))} className="font-mono text-os-text-primary hover:underline inline-flex items-center gap-1" title={revealed[f.id] ? 'Hide the value' : 'Reveal the value'} data-testid={`ctx-finding-value-${f.id}`}>
        {revealed[f.id] ? <EyeOff size={12} /> : <Eye size={12} />}{revealed[f.id] ? f.value : maskValue(f.value)}
      </button>
      <span className="text-os-text-muted">{'→'} <span className="font-mono">{f.placeholder}</span>{f.count > 1 ? ` ×${f.count}` : ''}</span>
      <span className="flex-1" />
      <label className="inline-flex items-center gap-1.5 text-os-text-secondary">
        <span>{f.hidden ? 'Keep hidden' : 'Send as is'}</span>
        <Toggle checked={f.hidden} disabled={!policy.enabled || edited || (f.type !== 'custom' && policy.types[f.type] === false)} onChange={(v) => decide(f.id, v ? 'hide' : 'send')} testId={`ctx-finding-toggle-${f.id}`} />
      </label>
      {f.type !== 'custom'
        ? <Button size="sm" variant="ghost" onClick={() => allowValue(f.value)} title="Never hide this value on this device" data-testid={`ctx-finding-allow-${f.id}`}>Never hide</Button>
        : <Button size="sm" variant="ghost" onClick={() => allowValue(f.value)} title="Take this value off the always-hide list" data-testid={`ctx-finding-allow-${f.id}`}>Stop hiding</Button>}
      {f.type !== 'custom' && <Button size="sm" variant="ghost" onClick={() => denyValue(f.value)} title="Always hide this value on this device" data-testid={`ctx-finding-deny-${f.id}`}>Always hide</Button>}
    </div>
  );

  const textLabel = sourceLabel.charAt(0).toUpperCase() + sourceLabel.slice(1);
  const frozenNote = (testId) => (
    <Note tone="info" testId={testId}>Edited by hand: the privacy switches no longer apply - this text is sent as it is. Reset to the {sourceLabel} to drop the edit.</Note>
  );

  return (
    <BaseModal isOpen onClose={onCancel} closeOnBackdropClick={false} trapFocus zIndex={60} className="w-full max-w-3xl max-h-full overflow-y-auto rounded-lg">
      <div className="p-4 sm:p-6 space-y-3" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="ai-context-dialog">
        <div className="flex items-start gap-2">
          <Icon size={18} className="text-os-blue shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="text-sm font-semibold text-os-text-primary truncate">Context: {draft.title}</h3>
            <p className="text-xs text-os-text-muted">This is exactly what the AI receives for this context, after the privacy redaction.</p>
          </div>
          <span data-testid="ctx-summary" className="shrink-0"><Badge tone={!policy.enabled ? 'warning' : hiddenCount ? 'blue' : 'neutral'}>{summary}</Badge></span>
        </div>

        <SubTabs
          active={tab}
          onChange={setTab}
          className="mb-1"
          tabs={[
            { id: 'text', label: textLabel, testId: 'ctx-tab-text' },
            { id: 'privacy', label: `Privacy ${hiddenCount}/${findings.length}`, testId: 'ctx-tab-privacy' },
          ]}
        />

        {/* Both panels stay mounted; the inactive one is hidden */}
        <div hidden={tab !== 'text'} className="space-y-3" data-testid="ctx-panel-text">
          <p className="text-xs text-os-text-muted">Edit the text to restore a value, remove parts or add a note; the Privacy tab decides what is hidden.</p>
          {(draft.error || rendered.empty) && !edited && (
            <Note tone="danger" testId="ctx-error">{draft.error || 'No content was loaded for this context.'} It will not be sent as it is: reset to the {sourceLabel}, or write the text yourself.</Note>
          )}
          {edited && frozenNote('ctx-edited-note')}
          <textarea value={rendered.text} onChange={(e) => setDraft((d) => ({ ...d, manual: e.target.value }))} spellCheck={false} aria-label="Context text"
            className="w-full min-h-[50vh] bg-os-input-bg text-os-text-primary border border-os-border rounded-sm p-3 text-xs font-mono resize-y focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40" data-testid="ctx-text" />
        </div>

        <div hidden={tab !== 'privacy'} className="space-y-3" data-testid="ctx-panel-privacy">
          {edited && frozenNote('ctx-edited-note-privacy')}
          <div className="flex items-center justify-between gap-3" data-testid="ctx-redaction-switch">
            <div>
              <span className="text-xs text-os-text-primary">Hide private values</span>
              <span className="block text-[11px] text-os-text-muted">{policy.enabled ? `${hiddenCount} of ${findings.length} finding${findings.length === 1 ? '' : 's'} hidden` : 'Off for this chat - the context goes to the AI provider as it is'}</span>
            </div>
            <Toggle checked={policy.enabled} disabled={edited} onChange={(v) => { if (v) setPolicy({ enabled: true }); else setConfirmOff(true); }} testId="ctx-redaction-toggle" />
          </div>

          {policy.enabled && (
            <div className="rounded-sm border border-os-border px-3 py-1" data-testid="ctx-types">
              {REDACTION_TYPES.map(typeRow)}
              {tokensOff && <Note tone="warning" className="my-2" testId="ctx-tokens-warning">Tokens, keys and passwords in this context will be sent to the AI provider as they are.</Note>}
            </div>
          )}

          {policy.enabled && findings.length > 0 && (
            <div data-testid="ctx-findings">
              <p className="text-xs font-semibold text-os-text-secondary mb-1">What was found</p>
              {findings.map(findingRow)}
            </div>
          )}
          {policy.enabled && findings.length === 0 && <p className="text-xs text-os-text-muted" data-testid="ctx-no-findings">Nothing private was found in this context.</p>}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={reset} disabled={reloading} data-testid="ctx-reset">Reset to the {sourceLabel}</Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel} data-testid="ctx-cancel">Cancel</Button>
            <Button variant="primary" onClick={() => onSave(draft)} data-testid="ctx-save">Save</Button>
          </div>
        </div>
      </div>
      <ConfirmationModal isOpen={confirmOff} type="warning" title="Send this chat's context unredacted?" message="Hosts, addresses, names, tokens and keys in this context will go to the AI provider as they are. This applies to this chat only."
        confirmLabel="Off for this chat" onConfirm={() => { setConfirmOff(false); setPolicy({ enabled: false }); }} onCancel={() => setConfirmOff(false)} />
    </BaseModal>
  );
}
