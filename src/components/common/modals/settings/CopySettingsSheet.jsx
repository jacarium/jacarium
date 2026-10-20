import { useEffect, useId, useState } from 'react';
import BaseModal from '../BaseModal';
import { Button, Checkbox, Note } from './ui';
import { copyDeviceSettingsToAccount, deviceSettingsSummary, loadSettings, setSettingsScope } from '../../../../services/settingsStore';
import { isSecretKey } from '../../../../utils/secretKeys';
import { groupSettingsKeys, settingsFieldLabel } from './fieldCatalog';

/**
 * "Copy this device's settings to your account?" - the one-time offer when
 * a desktop profile is linked to a home server (and later from Settings >
 * General > Home server, or the This-device banner). It lists what the
 * profile's own settings file holds - plain values, and secrets by NAME
 * only (the main process reads the file and sends the chosen ones; no
 * secret value passes through this renderer) - each with a checkbox; a key
 * the account already sets is shown with both values and kept unless
 * ticked. Copy puts the chosen keys on the account and switches this device
 * to "My account"; Not now leaves everything on "This device".
 *
 * A dialog of its own, stacked over the Settings dialog (BaseModal at
 * z-index 55: above Settings' 50 and under the step-up password prompt's
 * 60), so the Settings footer is dimmed and out of reach while it is open
 * (SettingsModal marks itself inert). Focus is trapped inside, Esc is "Not
 * now", and focus goes back to the control that opened it (`returnFocusTo`,
 * the Settings dialog itself when the sheet opened on its own). Keys are named
 * as their Settings fields are and grouped by tab > sub-tab
 * (settings/fieldCatalog.js); the key itself is the row's tooltip.
 */
const SHEET_Z_INDEX = 55;

export default function CopySettingsSheet({ open, server, onClose, onCopied, returnFocusTo = null }) {
  const [device, setDevice] = useState(null);      // { values, secretKeys }
  const [account, setAccount] = useState(null);    // { values, secrets }
  const [chosen, setChosen] = useState({});        // key -> boolean
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const [summary, acct] = await Promise.all([deviceSettingsSummary(), loadSettings({ scope: 'account' }).catch(() => ({ values: {}, secrets: {} }))]);
        if (cancelled) return;
        setDevice(summary);
        setAccount(acct);
        const initial = {};
        for (const key of Object.keys(summary.values || {})) initial[key] = !(acct.values && acct.values[key]);
        for (const key of summary.secretKeys || []) initial[key] = !(acct.secrets && acct.secrets[key]);
        setChosen(initial);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;
  const plainKeys = Object.keys(device?.values || {});
  const secretKeys = [...(device?.secretKeys || [])];
  const groups = groupSettingsKeys([...plainKeys, ...secretKeys]);
  const count = [...plainKeys, ...secretKeys].filter((k) => chosen[k]).length;
  const accountHas = (key) => (isSecretKey(key) ? !!account?.secrets?.[key] : !!account?.values?.[key]);
  const notNow = () => { if (!busy) onClose?.(); };

  async function copy() {
    setBusy(true); setError('');
    try {
      const result = await copyDeviceSettingsToAccount({ plainKeys: plainKeys.filter((k) => chosen[k]), secretKeys: secretKeys.filter((k) => chosen[k]) });
      await setSettingsScope('account');
      onCopied?.(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // One key: its field's label, then the value (a secret only as "set")
  const row = (key) => {
    const secret = secretKeys.includes(key);
    return (
      <label key={key} className="flex items-start gap-2 text-xs text-os-text-primary" title={key}>
        <Checkbox checked={!!chosen[key]} onChange={(on) => setChosen((prev) => ({ ...prev, [key]: on }))} testId={`copy-${key}`} />
        <span className="min-w-0">
          <span data-testid={`copy-label-${key}`}>{settingsFieldLabel(key)}</span>
          {secret ? <span className="text-os-text-muted"> (set)</span> : <span className="font-mono text-os-text-muted break-all"> {device.values[key]}</span>}
          {accountHas(key) && (
            <span className="block text-os-text-muted" data-testid={`copy-conflict-${key}`}>
              Already on your account{secret ? ' (set)' : <>: <span className="font-mono break-all">{account.values[key]}</span></>} - tick to replace it with this device&apos;s.
            </span>
          )}
        </span>
      </label>
    );
  };

  return (
    <BaseModal isOpen onClose={notNow} closeOnBackdropClick={false} closeOnEscape={!busy} trapFocus returnFocusTo={returnFocusTo} zIndex={SHEET_Z_INDEX} className="w-full max-w-2xl max-h-full overflow-y-auto rounded-lg">
      <div className="p-4 sm:p-6" data-testid="copy-settings-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h3 id={titleId} className="text-sm font-semibold text-os-text-primary">Copy this device&apos;s settings to your account{server ? ` on ${server}` : ''}?</h3>
        <p className="mt-1 text-xs text-os-text-muted">
          Your phone and every device of your account will use them, and this device switches to &quot;My account&quot;. Secrets travel to your account over HTTPS, as the web app already stores them there. Nothing is removed from this device.
        </p>
        {error && <Note tone="danger" className="mt-3">{error}</Note>}
        {!device ? (
          <p className="mt-4 text-xs text-os-text-secondary">Reading this device&apos;s settings...</p>
        ) : groups.length === 0 ? (
          <p className="mt-4 text-xs text-os-text-secondary" data-testid="copy-nothing">This device has no settings of its own to copy.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {groups.map((group) => (
              <div key={group.id} className="space-y-2" data-testid={`copy-group-${group.id}`}>
                <p className="text-xs font-semibold text-os-text-secondary">{group.title ?? 'Other settings'}</p>
                {group.keys.map(row)}
              </div>
            ))}
          </div>
        )}
        <p className="mt-4 text-xs text-os-text-muted">
          &quot;localhost&quot; in an endpoint means the device that makes the call: your phone&apos;s AI calls run on the server, so a local Ollama address is only right where that Ollama runs.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={notNow} disabled={busy} data-testid="copy-not-now">Not now</Button>
          <Button variant="primary" onClick={copy} disabled={busy || !device || count === 0} data-testid="copy-confirm">{busy ? 'Copying...' : `Copy ${count} setting${count === 1 ? '' : 's'}`}</Button>
        </div>
      </div>
    </BaseModal>
  );
}
