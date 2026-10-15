/**
 * Settings > Audit (administrators): the server's account audit log -
 * sign-ins and failed attempts, password changes, resets and host-side
 * recoveries, user administration, sessions and devices ended, and every
 * "delete all data on the server" (backend/accounts.py audit(),
 * /data/accounts-audit.log). Newest first; never a secret.
 */
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { admin } from '../../../../utils/auth';
import { Button, Section, StatusLine } from './ui';

const LABELS = {
  'sign-in': 'Signed in',
  'sign-in-failed': 'Sign-in failed',
  'password-changed': 'Password changed',
  'password-changed-after-recovery': 'Password changed (after recovery)',
  'password-reset': 'Password reset by an administrator',
  'password-recovered': 'Password recovered from the server',
  'user-created': 'Account created',
  'user-disabled': 'Account disabled',
  'user-enabled': 'Account enabled',
  'user-deleted': 'Account deleted',
  'role-changed': 'Role changed',
  'session-ended': 'Session signed out',
  'sessions-ended': 'Other sessions signed out',
  'device-linked': 'Desktop profile linked',
  'device-revoked': 'Device revoked',
  'data-deleted': 'All data deleted on the server',
  'data-delete-refused': 'Data deletion refused',
};
const TONE = {
  'sign-in-failed': 'text-amber-700 dark:text-amber-300',
  'data-deleted': 'text-red-700 dark:text-red-300',
  'data-delete-refused': 'text-amber-700 dark:text-amber-300',
  'user-deleted': 'text-red-700 dark:text-red-300',
  'password-recovered': 'text-amber-700 dark:text-amber-300',
};

function describe(entry) {
  const f = entry.fields || {};
  const parts = [];
  if (f.user) parts.push(f.user);
  if (f.by && f.by !== f.user) parts.push(`by ${f.by}`);
  if (f.role) parts.push(`-> ${f.role}`);
  if (f.device) parts.push(f.device.replace(/_/g, ' '));
  if (f.records) parts.push(`${f.records} record(s)`);
  if (f.files === '1') parts.push('files too');
  if (f.count) parts.push(`${f.count} session(s)`);
  if (f.reason) parts.push(f.reason.replace(/-/g, ' '));
  if (f.devices_revoked && f.devices_revoked !== '0') parts.push(`${f.devices_revoked} device(s) revoked`);
  if (f.made_admin === '1') parts.push('made administrator');
  if (f.temporary === '1') parts.push('with a temporary password');
  if (f.ip) parts.push(`from ${f.ip}`);
  return parts.join(' ');
}

export default function AuditSettings({ server = null }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(200);

  async function load(n = limit) {
    setError('');
    try {
      const data = await admin.audit(n);
      setEntries(data.entries || []);
    } catch (err) {
      setError(err.message);
      setEntries([]);
    }
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  return (
    <Section title={server ? `Audit log of ${server}` : 'Audit log'} testId="audit-settings"
      description="Who signed in (and who failed to), password changes, resets and recoveries, accounts created, disabled, promoted or deleted, sessions and devices ended, and every deletion of an account's data on the server. Newest first; the file is /data/accounts-audit.log on the server."
      actions={<Button onClick={() => load(limit)}>Refresh</Button>}>
      <StatusLine status={error ? { ok: false, text: error } : null} />
      {entries === null ? (
        <p className="text-xs text-os-text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading...</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-os-text-muted">Nothing recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="audit-table">
            <thead>
              <tr className="text-left text-os-text-secondary">
                <th className="py-1 pr-3 font-medium whitespace-nowrap">When</th>
                <th className="py-1 pr-3 font-medium">Event</th>
                <th className="py-1 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={`${e.at}-${i}`} className="border-t border-os-divider text-os-text-primary">
                  <td className="py-1 pr-3 font-mono whitespace-nowrap text-os-text-secondary">{e.at.replace('T', ' ').replace(/[+-]\d{4}$/, '')}</td>
                  <td className={`py-1 pr-3 whitespace-nowrap ${TONE[e.action] ||''}`}>{LABELS[e.action] || e.action}</td>
                  <td className="py-1 text-os-text-secondary">{describe(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {entries && entries.length >= limit && <Button onClick={() => setLimit(limit + 500)}>Show more</Button>}
    </Section>
  );
}
