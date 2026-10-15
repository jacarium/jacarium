/**
 * Settings > Users: account administration on a server with sign-in
 * (accounts mode, administrators only). Lists the accounts; creates one;
 * disables / enables, promotes / demotes, deletes one (never the last
 * administrator, never oneself); resets a password; sees and ends a user's
 * sessions and linked devices; deletes a user's data on the server (with
 * the administrator's own password and the user's typed username).
 * Everything goes through src/utils/auth.js (backend/auth.py,
 * backend/account_data.py).
 */
import { Fragment, useEffect, useState } from 'react';
import { Loader2, Users, ChevronDown, ChevronRight, Laptop, Download } from 'lucide-react';
import { admin, currentUser } from '../../../../utils/auth';
import { useConfirmation } from '../../../../hooks/useConfirmation';
import ConfirmationModal from '../ConfirmationModal';
import { Button, Checkbox, Field, Note, PasswordInput, Section, Select, StatusLine, TextInput } from './ui';

const when = (seconds) => (seconds ? new Date(seconds * 1000).toLocaleString() : 'never');

/** One user's sessions, devices, backups and the data deletion (expanded row). */
function UserDetails({ user, me, onError }) {
  const { confirm, confirmationProps } = useConfirmation();
  const [details, setDetails] = useState(null);
  const [backups, setBackups] = useState([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [password, setPassword] = useState('');
  const [includeFiles, setIncludeFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function load() {
    try {
      const [d, b] = await Promise.all([admin.sessions(user.id), admin.backups(user.id).catch(() => ({ backups: [] }))]);
      setDetails(d);
      setBackups(b.backups || []);
    } catch (err) {
      onError(err.message);
    }
  }
  useEffect(() => {
    // the lists arrive after an await; nothing is set synchronously here
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  async function endSession(id) {
    try { await admin.endSession(user.id, id); await load(); } catch (err) { onError(err.message); }
  }
  async function revokeDevice(id) {
    if (!(await confirm({ title: `Revoke ${user.username}'s device?`, message: 'The desktop profile will have to be linked again with the password.', type: 'warning', confirmLabel: 'Revoke' }))) return;
    try { await admin.revokeDevice(user.id, id); await load(); } catch (err) { onError(err.message); }
  }
  async function download(name) {
    const a = document.createElement('a');
    a.href = await admin.backupUrl(user.id, name);
    a.download = name;
    a.click();
  }
  async function deleteData(e) {
    e.preventDefault();
    setBusy(true); setResult(null);
    try {
      const answer = await admin.deleteData(user.id, { password, confirmUsername: typed, includeFiles });
      setResult({ ok: true, text: `Done: ${answer.deleted?.records ?? 0} record(s) of ${user.username} removed from the server (backup ${answer.backups?.[0] || ''}); every device of that account empties itself at its next synchronisation.` });
      setDeleteOpen(false); setTyped(''); setPassword('');
      await load();
    } catch (err) {
      setResult({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  if (!details) return <p className="text-xs text-os-text-muted flex items-center gap-2 py-2"><Loader2 size={12} className="animate-spin" /> Loading...</p>;
  const devices = (details.devices || []).filter((d) => !d.revoked);
  return (
    <div className="space-y-3 py-2 text-xs" data-testid={`user-details-${user.username}`}>
      <div>
        <p className="font-medium text-os-text-primary mb-1">Sessions</p>
        {details.sessions.length === 0 ? <p className="text-os-text-muted">Not signed in anywhere.</p> : (
          <ul className="space-y-1">
            {details.sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 text-os-text-secondary">
                <span className="min-w-0 truncate">{s.current ? 'This browser' : (s.userAgent || 'Browser').slice(0, 80)} - last seen {when(s.lastSeen)}</span>
                {!s.current && <Button className="px-2 py-0.5" onClick={() => endSession(s.id)}>Sign out</Button>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="font-medium text-os-text-primary mb-1 flex items-center gap-1"><Laptop size={12} /> Linked devices</p>
        {devices.length === 0 ? <p className="text-os-text-muted">None.</p> : (
          <ul className="space-y-1">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 text-os-text-secondary">
                <span>{d.name} - last seen {when(d.lastSeen)}</span>
                <Button className="px-2 py-0.5" onClick={() => revokeDevice(d.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {backups.length > 0 && (
        <div>
          <p className="font-medium text-os-text-primary mb-1">Backups on the server</p>
          <ul className="space-y-1">
            {backups.map((b) => (
              <li key={b.name} className="flex items-center justify-between gap-3 text-os-text-secondary">
                <span className="font-mono truncate">{b.name}</span>
                <Button className="px-2 py-0.5" onClick={() => download(b.name)}>Download</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        {!deleteOpen ? (
          <Button variant="danger" onClick={() => { setDeleteOpen(true); setResult(null); }} data-testid={`delete-data-open-${user.username}`}>Delete {user.username}&apos;s data on the server...</Button>
        ) : (
          <form onSubmit={deleteData} className="space-y-3" data-testid={`delete-data-form-${user.username}`}>
            <Note tone="danger">
              You are deleting the data of <span className="font-semibold">{user.username}</span>{user.id === me?.id ? ' (your own account)' : ''}: their documents, boards, tasks, templates and settings data
              leave the server and every device of that account empties those records at its next synchronisation. A backup is written first (kept with the account, the last 3).
              Type <span className="font-mono">{user.username}</span> and YOUR password to confirm.
            </Note>
            <Checkbox label={`Also delete ${user.username}'s files on the server`} checked={includeFiles} onChange={setIncludeFiles}
              hint="Taskwarrior data, SSH keys and known_hosts, the settings file, the calendar token, the RAG index, the reports directory - archived next to the backup first. Off by default." />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label={<>Type the username (<span className="font-mono">{user.username}</span>)</>}>
                <TextInput mono value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" data-testid="delete-data-username" />
              </Field>
              <Field label="Your password (the administrator's)">
                <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" data-testid="delete-data-password" />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="dangerSolid" disabled={busy || typed.trim().toLowerCase() !== user.username || !password} data-testid="delete-data-confirm">{busy ? 'Deleting...' : `Delete ${user.username}'s data on the server`}</Button>
              <Button onClick={() => { setDeleteOpen(false); setTyped(''); setPassword(''); }}>Cancel</Button>
            </div>
          </form>
        )}
        <StatusLine status={result} testId="delete-data-result" />
      </div>
      <ConfirmationModal {...confirmationProps} />
    </div>
  );
}

export default function UsersSettings({ server = null }) {
  const { confirm, confirmationProps } = useConfirmation();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ username: '', displayName: '', password: '', role: 'user' });
  const [resetFor, setResetFor] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [expanded, setExpanded] = useState(null);
  const me = currentUser();

  async function reload() {
    try {
      const data = await admin.listUsers();
      setUsers(data.users || []);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    // the list arrives after an await; nothing is set synchronously here
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, []);

  async function run(action) {
    setBusy(true); setError('');
    try {
      await action();
      await reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function create(e) {
    e.preventDefault();
    await run(async () => {
      await admin.createUser(form);
      setForm({ username: '', displayName: '', password: '', role: 'user' });
    });
  }

  async function submitReset(e) {
    e.preventDefault();
    const id = resetFor;
    await run(async () => {
      await admin.resetPassword(id, resetPassword);
      setResetFor(null);
      setResetPassword('');
    });
  }

  async function toggleRole(u) {
    const promote = u.role !== 'admin';
    if (!(await confirm({ title: promote ? `Make ${u.username} an administrator?` : `Remove ${u.username}'s administrator role?`, message: promote ? 'Administrators manage accounts and server defaults, and can delete any account\'s data.' : 'The account keeps its data and signs in as a regular user.', type: 'warning', confirmLabel: promote ? 'Make administrator' : 'Remove role' }))) return;
    await run(() => admin.setRole(u.id, promote ? 'admin' : 'user'));
  }

  async function deleteUser(u) {
    if (!(await confirm({ title: `Delete the account ${u.username}?`, message: 'The account can no longer sign in; its sessions and linked devices end. Its data directory stays on the server volume (delete the data first if it should go too). This cannot be undone.', type: 'danger', confirmLabel: 'Delete account', confirmPhrase: u.username }))) return;
    await run(() => admin.deleteUser(u.id, u.username));
  }

  const admins = (users || []).filter((u) => u.role === 'admin' && !u.disabled).length;
  const lastAdmin = (u) => u.role === 'admin' && !u.disabled && admins <= 1;

  return (
    <div className="space-y-6" data-testid="users-settings">
      <Section title={server ? `Accounts on ${server}` : 'Accounts on this server'} description={server ? 'The home server this profile is linked to. Changing an account asks for your password once per action (the device token alone may only read).' : undefined}>
        <StatusLine status={error ? { ok: false, text: error } : null} />
        {users === null ? (
          <p className="text-xs text-os-text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading accounts...</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-os-text-secondary">
                  <th className="py-1 pr-2 font-medium w-6"></th>
                  <th className="py-1 pr-2 font-medium">Username</th>
                  <th className="py-1 pr-2 font-medium">Name</th>
                  <th className="py-1 pr-2 font-medium">Role</th>
                  <th className="py-1 pr-2 font-medium">Status</th>
                  <th className="py-1 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <Fragment key={u.id}>
                    <tr className="border-t border-os-border text-os-text-primary" data-testid={`user-row-${u.username}`}>
                      <td className="py-1.5 pr-1">
                        <button type="button" onClick={() => setExpanded(expanded === u.id ? null : u.id)} className="p-0.5 rounded-sm hover:bg-os-card-secondary focus:outline-hidden focus-visible:ring-2 focus-visible:ring-os-blue/40" aria-label={expanded === u.id ? 'Hide details' : 'Show sessions, devices and data'} data-testid={`user-expand-${u.username}`}>
                          {expanded === u.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      </td>
                      <td className="py-1.5 pr-2 font-mono">{u.username}{me?.id === u.id ? ' (you)' : ''}</td>
                      <td className="py-1.5 pr-2">{u.displayName}</td>
                      <td className="py-1.5 pr-2">{u.role === 'admin' ? 'administrator' : 'user'}{lastAdmin(u) ? <span className="text-os-text-muted"> (last)</span> : ''}</td>
                      <td className="py-1.5 pr-2">{u.disabled ? <span className="text-red-600 dark:text-red-400">disabled</span> : u.mustChangePassword ? <span className="text-amber-600">must change password</span> : 'active'}</td>
                      <td className="py-1.5 text-right whitespace-nowrap space-x-1">
                        <Button className="px-2 py-1" disabled={busy} onClick={() => { setResetFor(u.id); setResetPassword(''); }} title="Set a new password">Password</Button>
                        <Button className="px-2 py-1" disabled={busy || lastAdmin(u) || me?.id === u.id} onClick={() => toggleRole(u)}
                          title={lastAdmin(u) ? 'The last administrator keeps the role' : me?.id === u.id ? 'Ask another administrator to change your role' : u.role === 'admin' ? 'Remove the administrator role' : 'Make an administrator'} data-testid={`user-role-${u.username}`}>
                          {u.role === 'admin' ? 'Demote' : 'Promote'}
                        </Button>
                        {u.disabled ? (
                          <Button className="px-2 py-1" disabled={busy} onClick={() => run(() => admin.enableUser(u.id))}>Enable</Button>
                        ) : (
                          <Button variant="danger" className="px-2 py-1" disabled={busy || me?.id === u.id || lastAdmin(u)} onClick={() => run(() => admin.disableUser(u.id))} title={lastAdmin(u) ? 'The last administrator cannot be disabled' : me?.id === u.id ? 'You cannot disable your own account' : 'Disable the account'}>Disable</Button>
                        )}
                        <Button variant="danger" className="px-2 py-1" disabled={busy || me?.id === u.id || lastAdmin(u)} onClick={() => deleteUser(u)} title={lastAdmin(u) ? 'The last administrator cannot be deleted' : me?.id === u.id ? 'You cannot delete your own account' : 'Delete the account'} data-testid={`user-delete-${u.username}`}>Delete</Button>
                      </td>
                    </tr>
                    {expanded === u.id && (
                      <tr className="border-t border-os-divider">
                        <td></td>
                        <td colSpan={5}><UserDetails user={u} me={me} onError={setError} /></td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-os-text-muted">
          Every account has its own documents, tasks, settings and SSH keys on this server. A disabled account cannot sign in; its data stays.
          The last administrator can neither be disabled, demoted nor deleted. Forgot the only administrator&apos;s password? It can be reset with a command on the server.
        </p>
      </Section>

      {resetFor && (
        <form onSubmit={submitReset} className="flex flex-wrap items-end gap-2 p-3 rounded-sm border border-os-border bg-os-card-secondary" data-testid="reset-password-form">
          <Field label={`New password for ${users?.find((u) => u.id === resetFor)?.username}`} className="flex-1 min-w-[12rem]">
            <PasswordInput value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} autoComplete="new-password" />
          </Field>
          <Button type="submit" variant="primary" disabled={busy || resetPassword.length < 8}>Set</Button>
          <Button onClick={() => setResetFor(null)}>Cancel</Button>
        </form>
      )}

      <Section title="New account">
        <form onSubmit={create} className="space-y-3" data-testid="create-user-form">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <TextInput value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="username" autoComplete="off" required />
            <TextInput value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="display name (optional)" autoComplete="off" />
            <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="password (8+ characters)" autoComplete="new-password" required />
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">user</option>
              <option value="admin">administrator</option>
            </Select>
          </div>
          <Button type="submit" variant="primary" disabled={busy}>Create account</Button>
        </form>
      </Section>
      <ConfirmationModal {...confirmationProps} />
    </div>
  );
}
