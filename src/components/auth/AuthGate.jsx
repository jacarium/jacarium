/**
 * What a browser sees on a server with sign-in before the app loads
 * (src/main.jsx): the first-run setup page while no account exists, the
 * sign-in page otherwise, and - right after signing in for the first time
 * in a browser that still holds the pre-sign-in database - the offer to
 * adopt that data into the account (src/utils/legacyImport.js).
 *
 * Every success reloads the page: main.jsx then finds the session, names
 * the account's database and loads the app.
 */
import BrandMark, { BrandWordmark } from '../../brand/BrandMark';
import { brandTagline, brandHomepage, brandHomepageLabel } from '../../brand/brand';
import { latestVersion } from '../../whats-new/versions';
import { useEffect, useState } from 'react';
import { KeyRound, Database, ShieldCheck } from 'lucide-react';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { changePassword, login, logout, setup } from '../../utils/auth';

function Field({ label, type = 'text', value, onChange, autoFocus = false, autoComplete, placeholder, hint }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-os-text-secondary mb-1">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm bg-os-input-bg border border-os-input-border rounded-sm text-os-text-primary placeholder:text-os-text-muted focus:outline-hidden focus:border-os-blue"
      />
      {hint && <span className="block text-xs text-os-text-muted mt-1">{hint}</span>}
    </label>
  );
}

function Card({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="brand-page min-h-screen w-full flex flex-col items-center justify-center gap-5 p-4" data-testid="brand-page">
      <div className="brand-hero w-full max-w-md px-6 pt-8 pb-6 text-center" data-testid="brand-hero">
        <BrandMark size={72} className="mx-auto" />
        <BrandWordmark size={40} className="brand-hero-title block mt-3" />
        <p className="brand-tagline brand-hero-sub mt-2 text-sm" data-testid="brand-tagline">{brandTagline()}</p>
      </div>
      <div className="brand-form-card w-full max-w-md p-6 space-y-5">
        <div className="flex items-center gap-3">
          {Icon && <div className="p-2 rounded-md bg-blue-600 text-white"><Icon size={20} /></div>}
          <div>
            <h1 className="text-base font-semibold text-os-text-primary">{title}</h1>
            {subtitle && <p className="text-xs text-os-text-secondary">{subtitle}</p>}
          </div>
        </div>
        {children}
      </div>
      <p className="brand-page-foot text-[11px] text-center" data-testid="brand-foot">
        Jacarium {latestVersion} &middot; <a href={brandHomepage()} target="_blank" rel="noopener noreferrer" className="brand-link hover:underline">{brandHomepageLabel()}</a> (opens in your browser)
      </p>
    </div>
  );
}

function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <div role="alert" className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm p-2">
      {error}
    </div>
  );
}

export function SetupPage({ onDone = () => window.location.reload() }) {
  const [setupCode, setSetupCode] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (password !== confirm) { setError('The two passwords differ'); return; }
    setBusy(true); setError('');
    try {
      await setup({ setupCode, username, password, displayName });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Card icon={ShieldCheck} title="Set up Jacarium" subtitle="No account exists yet. Create the administrator account.">
      <form onSubmit={submit} className="space-y-3" data-testid="setup-form">
        <Field label="Setup code" value={setupCode} onChange={setSetupCode} autoFocus autoComplete="off" placeholder="xxxxxx-xxxxxx-xxxxxx"
          hint="Printed in the server log when it started, and stored in the file setup-code on the server's data volume." />
        <Field label="Username" value={username} onChange={setUsername} autoComplete="username" hint="Letters, digits, dots, dashes and underscores." />
        <Field label="Display name" value={displayName} onChange={setDisplayName} autoComplete="name" placeholder="Shown to others (optional)" />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters." />
        <Field label="Password again" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
        <ErrorBox error={error} />
        <button type="submit" disabled={busy} className="btn btn-primary w-full flex items-center justify-center gap-2 px-4 py-2 text-sm">
          Create the administrator account
        </button>
      </form>
    </Card>
  );
}

export function LoginPage({ onDone = () => window.location.reload() }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await login(username, password);
      onDone();
    } catch (err) {
      if (err.data?.setupRequired) {
        setError('No account exists yet. Reload the page to set up the first one.');
      } else if (err.status === 429) {
        setError(`Too many attempts. Try again in ${err.data?.retryAfter || 60} seconds.`);
      } else {
        setError(err.message);
      }
      setBusy(false);
    }
  }

  return (
    <Card title="Sign in to Jacarium" subtitle="Your documents, tasks and settings are kept per account.">
      <form onSubmit={submit} className="space-y-3" data-testid="login-form">
        <Field label="Username" value={username} onChange={setUsername} autoFocus autoComplete="username" />
        <Field label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        <ErrorBox error={error} />
        <button type="submit" disabled={busy} className="btn btn-primary w-full flex items-center justify-center gap-2 px-4 py-2 text-sm">
          Sign in
        </button>
        <p className="text-[11px] text-os-text-muted" data-testid="download-desktop-hint">
          Prefer the desktop app? <a href="/api/downloads/" target="_blank" rel="noopener noreferrer" className="link hover:underline">Download it from this server</a> and link it to your account.
        </p>
      </form>
    </Card>
  );
}

/**
 * Shown after a sign-in with a temporary password (host-side recovery,
 * backend/accounts.py reset-password): the server refuses everything but
 * this until a password of the user's own is set.
 */
export function ChangePasswordPage({ user, onDone = () => window.location.reload() }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (next !== again) { setError('The new passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      await changePassword(current, next);
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Card icon={KeyRound} title="Choose a new password" subtitle={`${user?.username || 'Your account'} signed in with a temporary password. Pick your own before continuing - the temporary one stops working then.`}>
      <form onSubmit={submit} className="space-y-3" data-testid="change-password-form">
        <Field label="Temporary password" type="password" value={current} onChange={setCurrent} autoFocus autoComplete="current-password" />
        <Field label="New password (8+ characters)" type="password" value={next} onChange={setNext} autoComplete="new-password" />
        <Field label="New password again" type="password" value={again} onChange={setAgain} autoComplete="new-password" />
        <ErrorBox error={error} />
        <button type="submit" disabled={busy || next.length < 8 || !current} className="btn btn-primary w-full flex items-center justify-center gap-2 px-4 py-2 text-sm">
          Save password
        </button>
        <button type="button" onClick={() => logout().finally(onDone)} className="w-full px-4 py-2 text-xs text-os-text-secondary hover:bg-os-card-secondary rounded-sm">Sign out instead</button>
      </form>
    </Card>
  );
}

/**
 * Offered once per account per browser when the pre-sign-in database is
 * still there. "Import" copies it into the account's database (which is
 * empty: a first sign-in), "Skip" leaves it; either way the old database
 * stays until it is deleted from Settings > General.
 */
export function LegacyImportPage({ user, onDone = () => window.location.reload() }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');

  async function decide(doImport) {
    setBusy(true); setError('');
    try {
      const { importLegacyDatabase, rememberLegacyDecision } = await import('../../utils/legacyImport.js');
      if (doImport) {
        const { db } = await import('../../db/database.js');
        const result = await importLegacyDatabase(db, ({ table, rows }) => setProgress(`${table}: ${rows} rows`));
        console.log('[LegacyImport] copied', result);
      }
      rememberLegacyDecision(user.id, doImport ? 'imported' : 'skipped');
      onDone();
    } catch (err) {
      setError(`The import did not complete: ${err.message}. Nothing was deleted; you can try again after reloading, or use Settings > Import Database with an export of the old data.`);
      setBusy(false);
    }
  }

  return (
    <Card icon={Database} title="Data from before sign-in" subtitle={`Signed in as ${user.displayName || user.username}`}>
      <p className="text-sm text-os-text-primary">
        This browser still holds documents, tasks, boards and other data from before accounts existed on this server.
        Import it into your account? Your account's data is empty right now, so nothing is overwritten.
        The old data stays in this browser either way until you delete it from Settings &gt; General.
      </p>
      {progress && <p className="text-xs text-os-text-muted font-mono">{progress}</p>}
      <ErrorBox error={error} />
      <div className="flex gap-2">
        <button onClick={() => decide(true)} disabled={busy} className="btn btn-primary flex-1 flex items-center justify-center gap-2 px-4 py-2 text-sm" data-testid="legacy-import">
          Import into my account
        </button>
        <button onClick={() => decide(false)} disabled={busy} className="px-4 py-2 text-sm text-os-text-secondary hover:bg-os-card-secondary border border-os-border rounded-sm disabled:opacity-50" data-testid="legacy-skip">
          Skip
        </button>
      </div>
    </Card>
  );
}

export default function AuthGate({ setupRequired = false, legacyImportFor = null, changePasswordFor = null, onDone }) {
  useEffect(() => { document.title = 'Jacarium'; }, []);
  let page;
  if (changePasswordFor) page = <ChangePasswordPage user={changePasswordFor} onDone={onDone} />;
  else if (legacyImportFor) page = <LegacyImportPage user={legacyImportFor} onDone={onDone} />;
  else if (setupRequired) page = <SetupPage onDone={onDone} />;
  else page = <LoginPage onDone={onDone} />;
  return <ThemeProvider>{page}</ThemeProvider>;
}
