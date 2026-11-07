import { useEffect, useState } from 'react';
import { Field, Note, Section, Select, StatusLine } from './ui';
import { isDesktopApp } from '../../../../utils/platform';
import { apiFetch, getBackendUrl } from '../../../../utils/backendUrl';

/**
 * Settings > Performance: how many CPU cores the backend's parallel work uses (Diagnostics > Log Collection: the Histogram and
 * the Log Viewer's large logs). The backend answers for its own machine - the desktop's computer, or the server in a
 * browser - through /api/settings/parallel (backend/parallel_settings.py): its cores, what Auto means there, the
 * stored choice, JACARIUM_WORKERS when it overrides, and whether this user may change it (on a server with accounts,
 * administrators only). A change applies to the next analysis or load.
 */
export default function PerformanceSettings() {
  const [view, setView] = useState(null);
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch(`${await getBackendUrl()}/api/settings/parallel`);
        if (cancelled) return;
        if (r.ok) setView(await r.json());
        else setUnreachable(true);
      } catch {
        if (!cancelled) setUnreachable(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  if (!view) {
    return (
      <Section title="Performance" testId="performance-section">
        {unreachable
          ? <Note testId="parallel-unavailable">The backend did not answer: the parallel processing setting shows when it is running.</Note>
          : <p className="text-xs text-os-text-secondary">Loading...</p>}
      </Section>
    );
  }
  const machine = isDesktopApp() ? 'This computer' : 'The server';
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : (word.endsWith('s') ? 'es' : 's')}`;   // 1 core, 2 cores; 1 process, 2 processes
  async function choose(raw) {
    const workers = raw === 'auto' ? 'auto' : Number(raw);
    setSaving(true);
    setStatus(null);
    try {
      const r = await apiFetch(`${await getBackendUrl()}/api/settings/parallel`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workers }) });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        setView(body);
        setStatus({ ok: true, text: `Saved: the next analysis uses ${plural(body.effective, 'process')}.` });
      } else {
        setStatus({ ok: false, text: body.error || `Not saved (HTTP ${r.status})` });
      }
    } catch (e) {
      setStatus({ ok: false, text: `Not saved: ${e.message}` });
    } finally {
      setSaving(false);
    }
  }
  const options = [];
  for (let n = 1; n <= view.max; n += 1) options.push(n);
  if (typeof view.value === 'number' && view.value > view.max) options.push(view.value);   // stored on a larger machine: shown, used as the cores allow
  return (
    <Section title="Performance" testId="performance-section">
      <Field
        label="Parallel processing"
        htmlFor="parallel-workers"
        hint="How many processes read large logs at once (Diagnostics: the Log Collection Histogram and the Log Viewer). More is faster on a machine with cores to spare; 1 reads in one process."
      >
        <Select id="parallel-workers" value={String(view.value)} onChange={(e) => choose(e.target.value)} disabled={!view.canChange || saving} data-testid="parallel-workers">
          <option value="auto">{`Auto (${plural(view.auto, 'process')})`}</option>
          {options.map((n) => <option key={n} value={String(n)}>{n === 1 ? '1 (off: one process)' : `${n} processes`}</option>)}
        </Select>
      </Field>
      <p className="text-xs text-os-text-secondary" data-testid="parallel-cores">
        {`${machine} has ${plural(view.cores, 'core')}; Auto uses ${view.auto}.`}
        {view.override != null ? ` Set to ${view.override} by JACARIUM_WORKERS in the backend's environment.` : ''}
        {view.override == null && view.reason ? ` ${view.reason[0].toUpperCase()}${view.reason.slice(1)}.` : ''}
      </p>
      <StatusLine status={status} testId="parallel-status" />
    </Section>
  );
}
