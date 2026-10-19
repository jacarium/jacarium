import { useEffect, useState } from 'react';
import { Button, Checkbox, Note } from './ui';
import { copyDeviceSettingsToAccount, deviceSettingsSummary, loadSettings, setSettingsScope } from '../../../../services/settingsStore';
import { isSecretKey } from '../../../../utils/secretKeys';

/**
 * "Copy this device's settings to your account?" - the one-time offer when
 * a desktop profile is linked to a home server (and later from Settings >
 * General > Home server). It lists what the profile's own settings file
 * holds - plain values, and secrets by NAME only (the main process reads
 * the file and sends the chosen ones; no secret value passes through this
 * renderer) - each with a checkbox; a key the account already sets is
 * shown with both values and kept unless ticked. Copy puts the chosen keys
 * on the account and switches this device to "My account"; Not now leaves
 * everything on "This device".
 */
export default function CopySettingsSheet({ open, server, onClose, onCopied }) {
  const [device, setDevice] = useState(null);      // { values, secretKeys }
  const [account, setAccount] = useState(null);    // { values, secrets }
  const [chosen, setChosen] = useState({});        // key -> boolean
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
  const plainKeys = Object.keys(device?.values || {}).sort();
  const secretKeys = [...(device?.secretKeys || [])].sort();
  const count = [...plainKeys, ...secretKeys].filter((k) => chosen[k]).length;
  const accountHas = (key) => (isSecretKey(key) ? !!account?.secrets?.[key] : !!account?.values?.[key]);

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

  const row = (key, secret) => (
    <label key={key} className="flex items-start gap-2 text-xs text-os-text-primary">
      <Checkbox checked={!!chosen[key]} onChange={(on) => setChosen((prev) => ({ ...prev, [key]: on }))} testId={`copy-${key}`} />
      <span className="min-w-0">
        <span className="font-mono">{key}</span>
        {secret ? <span className="text-os-text-muted"> (set)</span> : <span className="text-os-text-muted"> {device.values[key]}</span>}
        {accountHas(key) && (
          <span className="block text-os-text-muted" data-testid={`copy-conflict-${key}`}>
            Already on your account{secret ? ' (set)' : `: ${account.values[key]}`} - tick to replace it with this device&apos;s.
          </span>
        )}
      </span>
    </label>
  );

  return (
    <div className="absolute inset-0 z-10 bg-os-modal p-4 sm:p-6 overflow-y-auto" data-testid="copy-settings-sheet" role="dialog" aria-label="Copy this device's settings to your account">
      <h3 className="text-sm font-semibold text-os-text-primary">Copy this device&apos;s settings to your account{server ? ` on ${server}` : ''}?</h3>
      <p className="mt-1 text-xs text-os-text-muted">
        Your phone and every device of your account will use them, and this device switches to &quot;My account&quot;. Secrets travel to your account over HTTPS, as the web app already stores them there. Nothing is removed from this device.
      </p>
      {error && <Note tone="danger" className="mt-3">{error}</Note>}
      {!device ? (
        <p className="mt-4 text-xs text-os-text-secondary">Reading this device&apos;s settings...</p>
      ) : plainKeys.length + secretKeys.length === 0 ? (
        <p className="mt-4 text-xs text-os-text-secondary" data-testid="copy-nothing">This device has no settings of its own to copy.</p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs font-semibold text-os-text-secondary">Settings</p>
            {plainKeys.length ? plainKeys.map((k) => row(k, false)) : <p className="text-xs text-os-text-muted">none</p>}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-os-text-secondary">Secrets</p>
            {secretKeys.length ? secretKeys.map((k) => row(k, true)) : <p className="text-xs text-os-text-muted">none</p>}
          </div>
        </div>
      )}
      <p className="mt-4 text-xs text-os-text-muted">
        &quot;localhost&quot; in an endpoint means the device that makes the call: your phone&apos;s AI calls run on the server, so a local Ollama address is only right where that Ollama runs.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => onClose?.()} disabled={busy} data-testid="copy-not-now">Not now</Button>
        <Button variant="primary" onClick={copy} disabled={busy || !device || count === 0} data-testid="copy-confirm">{busy ? 'Copying...' : `Copy ${count} setting${count === 1 ? '' : 's'}`}</Button>
      </div>
    </div>
  );
}
