import { useState } from 'react';
import { X } from 'lucide-react';
import { Button, Section, TextInput } from '../ui';
import { allowValue, denyValue, forgetValue, usePrivacyLists } from '../../../../../utils/aiPrivacy';

/**
 * Settings > AI > Privacy: this device's own say over the redaction of
 * what the AI chat sends as context (src/utils/aiContext.js) - values never
 * to hide (a registry the detector gets wrong, a lab domain the model may
 * see) and values always to hide. Just the two lists and a one-line hint:
 * the redaction itself is explained where it happens, in the chip's eye
 * dialog (AIContextDialog). Kept on this device only (src/utils/
 * aiPrivacy.js): not a setting of the device / account / everyone scopes,
 * never in a settings payload.
 */
export default function PrivacySettings() {
  const lists = usePrivacyLists();
  const [allowInput, setAllowInput] = useState('');
  const [denyInput, setDenyInput] = useState('');
  const list = (values, remove, testId) => (
    <ul className="flex flex-wrap gap-1.5" data-testid={testId}>
      {values.length === 0 && <li className="text-xs text-os-text-muted">none</li>}
      {values.map((v) => (
        <li key={v} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-mono border border-os-border rounded-sm bg-os-card-secondary text-os-text-primary">
          {v}
          <button type="button" onClick={() => remove(v)} className="p-0.5 rounded-sm text-os-text-muted hover:text-os-text-primary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40" aria-label={`Remove ${v}`} title="Remove"><X size={12} /></button>
        </li>
      ))}
    </ul>
  );
  const add = (value, fn, clear) => { const v = value.trim(); if (!v) return; fn(v); clear(''); };
  return (
    <Section title="Privacy" testId="privacy-settings" description="Applies to every chat on this device.">
      <div className="space-y-2" data-testid="privacy-allow">
        <p className="text-xs font-semibold text-os-text-secondary">Never hide</p>
        <p className="text-xs text-os-text-muted">A hostname here covers its subdomains. Any other value is matched as written.</p>
        {list(lists.allow, forgetValue, 'privacy-allow-list')}
        <div className="flex items-center gap-2">
          <TextInput mono value={allowInput} onChange={(e) => setAllowInput(e.target.value)} placeholder="lab.example.internal" aria-label="Value never to hide" data-testid="privacy-allow-input" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(allowInput, allowValue, setAllowInput); } }} />
          <Button size="sm" onClick={() => add(allowInput, allowValue, setAllowInput)} data-testid="privacy-allow-add">Add</Button>
        </div>
      </div>
      <div className="space-y-2" data-testid="privacy-deny">
        <p className="text-xs font-semibold text-os-text-secondary">Always hide</p>
        <p className="text-xs text-os-text-muted">Replaced wherever it appears, whatever the rules say - a project name, a customer, a hostname the rules would let through.</p>
        {list(lists.deny, forgetValue, 'privacy-deny-list')}
        <div className="flex items-center gap-2">
          <TextInput mono value={denyInput} onChange={(e) => setDenyInput(e.target.value)} placeholder="acme-corp" aria-label="Value always to hide" data-testid="privacy-deny-input" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(denyInput, denyValue, setDenyInput); } }} />
          <Button size="sm" onClick={() => add(denyInput, denyValue, setDenyInput)} data-testid="privacy-deny-add">Add</Button>
        </div>
      </div>
    </Section>
  );
}
