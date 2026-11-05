/**
 * Settings > About: the mark, the wordmark and the tagline (from
 * package.json through src/brand/brand.js), the versions (this app, the
 * sync protocol, the home server when there is one), the release check
 * (UpdateSettings: off by default, see electron/update-check.cjs), What's New, the
 * desktop downloads page of the home server, the website (a plain link that
 * opens in the browser - nothing is fetched from it), the author, the source
 * code (the repository - the AGPL's offer of the source), where to support
 * the project (a tip on Ko-fi), where to report an issue, the licence, and the credits for the fonts and libraries it ships.
 */
import { useEffect, useState } from 'react';
import { Globe, Scale, User, Github, Bug, Coffee, ShieldCheck, ShieldAlert, Award, BadgeCheck } from 'lucide-react';
import { copyToClipboard } from '../../../../utils/markdownToJira';
import { SECURITY_LINKS, BEST_PRACTICES_PROJECT, desktopRuntimes, serverRuntimes, runtimeLine, platformLabel, versionInfoText } from '../../../../utils/aboutInfo';
import BrandMark, { BrandWordmark } from '../../../../brand/BrandMark';
import { brandTagline, brandHomepage, brandHomepageLabel, brandRepository, brandRepositoryLabel, brandAuthor, brandFunding } from '../../../../brand/brand';
import { latestVersion } from '../../../../whats-new/versions';
import protocolJson from '../../../../../protocol.json';
import { Section, InfoRows, Button, ButtonRow, ExternalLink, Note, TextInput } from './ui';
import UpdateSettings from './UpdateSettings';
import { isDesktopApp } from '../../../../utils/platform';
import { apiFetch, getBackendUrl } from '../../../../utils/backendUrl';
import { getHomeServerStatus, checkHomeServerVersion } from '../../../../utils/homeServer';

const PROTOCOL = Number(protocolJson?.protocol) || 1;

const LICENCE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

// Third-party work the app ships, with its licence (the README's Licence
// section says the same). No version numbers: the versions that run are in
// the Version section, read live; every package that ships, with its licence
// text, is the generated list below (public/licences.json).
const OFL = { licence: 'SIL Open Font License', licenceUrl: 'https://openfontlicense.org' };
const MIT_NODE = 'https://github.com/nodejs/node/blob/main/LICENSE';
const CREDITS = [
  { name: 'React', what: 'the user interface', url: 'https://react.dev', licence: 'MIT', licenceUrl: 'https://github.com/facebook/react/blob/main/LICENSE' },
  { name: 'Electron', what: 'the desktop app', url: 'https://www.electronjs.org', licence: 'MIT', licenceUrl: 'https://github.com/electron/electron/blob/main/LICENSE' },
  { name: 'Node.js', what: 'the central server, the desktop app\'s main process', url: 'https://nodejs.org', licence: 'MIT', licenceUrl: MIT_NODE },
  { name: 'Lucide', what: 'icons', url: 'https://lucide.dev', licence: 'ISC', licenceUrl: 'https://github.com/lucide-icons/lucide/blob/main/LICENSE' },
  { name: 'Yjs', what: 'live documents (the shared editing)', url: 'https://yjs.dev', licence: 'MIT', licenceUrl: 'https://github.com/yjs/yjs/blob/main/LICENSE' },
  { name: 'Red Hat Text', what: 'font', url: 'https://fonts.google.com/specimen/Red+Hat+Text', ...OFL },
  { name: 'Red Hat Mono', what: 'font', url: 'https://fonts.google.com/specimen/Red+Hat+Mono', ...OFL },
  { name: 'Sora', what: 'font', url: 'https://fonts.google.com/specimen/Sora', ...OFL },
  // Font Awesome Free: the icons are CC BY 4.0 (this attribution is what the licence asks for), the fonts SIL OFL 1.1, the code MIT
  { name: 'Font Awesome Free', what: 'the Diagnostics pages\' icons', url: 'https://fontawesome.com', licence: 'CC BY 4.0 icons, SIL OFL 1.1 fonts, MIT code', licenceUrl: 'https://fontawesome.com/license/free' },
  // the spell-checking dictionaries of the Windows and Linux builds, unchanged from Chromium's (electron/spellcheck-dictionaries-NOTICE.txt)
  { name: 'SCOWL English dictionaries', what: 'spell checking, en-US / en-GB / en-AU (Windows and Linux builds)', url: 'http://wordlist.aspell.net/', licence: 'SCOWL notice (BSD affix rules, WordNet notice)', licenceUrl: 'https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/refs/heads/main/README_en_US.txt' },
  { name: 'Czech dictionary', what: 'spell checking, cs-CZ (Windows and Linux builds)', url: 'https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/', licence: 'GPL-2.0', licenceUrl: 'https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/refs/heads/main/README_cs_CZ.txt' },
  { name: 'Slovak dictionary', what: 'spell checking, sk-SK (Windows and Linux builds)', url: 'https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/', licence: 'GPL-2.0, LGPL-2.1 or MPL-1.1', licenceUrl: 'https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/refs/heads/main/README_sk_SK.txt' },
  { name: 'React Flow', what: 'workflow canvas', url: 'https://reactflow.dev', licence: 'MIT', licenceUrl: 'https://github.com/xyflow/xyflow/blob/main/LICENSE' },
  { name: 'CodeMirror', what: 'document editor', url: 'https://codemirror.net', licence: 'MIT', licenceUrl: 'https://github.com/codemirror/view/blob/main/LICENSE' },
  { name: 'y-codemirror.next', what: 'live-document binding', url: 'https://github.com/yjs/y-codemirror.next', licence: 'MIT', licenceUrl: 'https://github.com/yjs/y-codemirror.next/blob/main/LICENSE' },
];

/**
 * "All open-source licences": every package that ships, with its licence
 * text - public/licences.json, generated at build time by
 * scripts/generate-licences.mjs from the lock files (never by hand, nothing
 * fetched from the network: the file is a static asset of the app, loaded
 * from the app's own origin when the list is opened).
 */
function LicencesList() {
  const [state, setState] = useState({ status: 'closed', doc: null, error: '' });   // closed | loading | open | failed
  const [filter, setFilter] = useState('');
  const open = async () => {
    setState({ status: 'loading', doc: null, error: '' });
    try {
      const r = await fetch('licences.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const doc = await r.json();
      if (!Array.isArray(doc?.packages)) throw new Error('not a licence list');
      setState({ status: 'open', doc, error: '' });
    } catch (e) {
      setState({ status: 'failed', doc: null, error: e?.message || String(e) });
    }
  };
  if (state.status === 'closed' || state.status === 'loading') {
    return <Button onClick={open} disabled={state.status === 'loading'} data-testid="about-licences-open">{state.status === 'loading' ? 'Loading…' : 'View all licences'}</Button>;
  }
  if (state.status === 'failed') {
    return <Note tone="warning" testId="about-licences-error">The licence list is not part of this build ({state.error}). It is generated by the build from the lock files (scripts/generate-licences.mjs).</Note>;
  }
  const q = filter.trim().toLowerCase();
  const shown = q ? state.doc.packages.filter((p) => `${p.name} ${p.licence} ${p.ecosystem}`.toLowerCase().includes(q)) : state.doc.packages;
  return (
    <div className="space-y-3" data-testid="about-licences">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-os-text-muted" data-testid="about-licences-count">
          {state.doc.packages.length} packages ({state.doc.counts?.npm ?? 0} npm, {state.doc.counts?.pypi ?? 0} Python), {state.doc.counts?.withText ?? 0} with their licence text
          {state.doc.counts?.pypi === 0 ? ' - the Python packages of the backend are not in this build\'s list' : ''}
        </p>
        <Button size="sm" onClick={() => setState({ status: 'closed', doc: null, error: '' })} data-testid="about-licences-close">Close</Button>
      </div>
      <TextInput value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or licence" aria-label="Filter the licences" data-testid="about-licences-filter" />
      <div className="max-h-96 overflow-y-auto rounded-sm border border-os-border divide-y divide-os-border" data-testid="about-licences-list">
        {shown.map((p) => (
          <details key={`${p.ecosystem}:${p.name}@${p.version}`} className="group px-3 py-2 text-sm" data-testid="about-licence-package">
            <summary className="cursor-pointer flex flex-wrap items-baseline gap-x-2 text-os-text-primary">
              <span className="font-mono">{p.name}</span>
              <span className="text-os-text-muted text-xs">{p.version}{p.ecosystem === 'pypi' ? ' · Python' : p.where === 'central' ? ' · central server' : ''}</span>
              <span className="text-os-text-secondary text-xs ml-auto">{p.licence || 'licence not declared'}</span>
            </summary>
            <div className="mt-2 space-y-2 text-xs text-os-text-secondary">
              {p.url && <ExternalLink href={p.url} className="brand-link">{p.url}</ExternalLink>}
              {p.texts.length === 0 && <p className="text-os-text-muted">No licence file in the package; its licence is the one declared above.</p>}
              {p.texts.map((t) => (
                <pre key={t.file} className="whitespace-pre-wrap font-mono text-[11px] leading-snug p-2 rounded-sm bg-os-card-secondary border border-os-border max-h-64 overflow-y-auto"><span className="text-os-text-muted">{t.file}</span>{'\n'}{t.text}</pre>
              ))}
            </div>
          </details>
        ))}
        {shown.length === 0 && <p className="px-3 py-2 text-xs text-os-text-muted">Nothing matches.</p>}
      </div>
    </div>
  );
}

function Row({ label, children, testId }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm" data-testid={testId}>
      <span className="text-os-text-primary">{label}</span>
      <span className="text-os-text-secondary text-right min-w-0">{children}</span>
    </div>
  );
}

export default function AboutSettings({ onShowWhatsNew }) {
  const [server, setServer] = useState(null);   // { app, protocol, url, runtimes } | null
  const [copied, setCopied] = useState(false);
  const desktop = desktopRuntimes();

  // The home server's version: a browser asks the server it runs on; the
  // desktop asks the main process about the linked server (if any).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isDesktopApp()) {
          const status = await getHomeServerStatus();
          if (!status?.linked) return;
          const check = await checkHomeServerVersion();
          if (!cancelled && check?.server?.app) setServer({ app: check.server.app, protocol: check.server.protocol, url: status.url, runtimes: serverRuntimes(check.server.runtimes) });
        } else {
          const base = await getBackendUrl();
          const r = await apiFetch(`${base}/api/version`);
          if (r.ok) { const v = await r.json(); if (!cancelled && v?.app) setServer({ app: v.app, protocol: v.protocol, url: '', runtimes: serverRuntimes(v.runtimes) }); }
        }
      } catch { /* no server: the row says so */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const copyVersionInfo = async () => {
    const ok = await copyToClipboard(versionInfoText({ app: latestVersion, protocol: PROTOCOL, desktop, server, platform: platformLabel() }));
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const serverRuntimeLine = server ? runtimeLine([['Python', server.runtimes?.python], ['Node', server.runtimes?.node]]) : '';

  return (
    <div className="space-y-6" data-testid="about-settings">
      <div className="brand-hero brand-hero-strip flex items-center gap-4 p-5">
        <BrandMark size={56} seasonal />
        <div className="min-w-0">
          <BrandWordmark size={30} className="brand-hero-title" />
          <p className="brand-tagline brand-hero-sub mt-1 text-sm" data-testid="about-tagline">{brandTagline()}</p>
        </div>
      </div>

      <Section title="Version" testId="about-version">
        <InfoRows>
          <Row label="App" testId="about-app-version">{latestVersion}</Row>
          <Row label="Sync protocol">{PROTOCOL}</Row>
          {desktop && (
            <Row label="Desktop runtime" testId="about-desktop-runtime">{runtimeLine([['Electron', desktop.electron], ['Chromium', desktop.chrome], ['Node', desktop.node]])}</Row>
          )}
          <Row label="Home server" testId="about-home-server">
            {server ? `Jacarium ${server.app} (protocol ${server.protocol ?? '?'})${serverRuntimeLine ? ` · ${serverRuntimeLine}` : ''}${server.url ? ` - ${server.url}` : ''}` : (isDesktopApp() ? 'not linked' : 'this server')}
          </Row>
        </InfoRows>
        <ButtonRow align="start">
          <Button size="sm" onClick={copyVersionInfo} data-testid="about-copy-version">{copied ? 'Copied' : 'Copy version info'}</Button>
        </ButtonRow>
      </Section>

      <UpdateSettings />

      <Section title="More" testId="about-more">
        <div className="flex flex-wrap gap-2">
          {onShowWhatsNew && <Button onClick={onShowWhatsNew}>What&apos;s New</Button>}
          {!isDesktopApp() && <Button onClick={() => window.open('/api/downloads/', '_blank', 'noopener')} data-testid="about-downloads">Desktop app downloads</Button>}
        </div>
        <InfoRows>
          <Row label={<span className="flex items-center gap-2"><User size={14} className="text-os-text-secondary" /> Created by</span>} testId="about-author">
            {brandAuthor().url
              ? <ExternalLink href={brandAuthor().url} className="brand-link">{brandAuthor().name}</ExternalLink>
              : brandAuthor().name}
          </Row>
          <Row label={<span className="flex items-center gap-2"><Globe size={14} className="text-os-text-secondary" /> Website</span>} testId="about-website">
            <ExternalLink href={brandHomepage()} className="brand-link">{brandHomepageLabel()}</ExternalLink>
            <span className="text-os-text-muted"> - opens in your browser</span>
          </Row>
          <Row label={<span className="flex items-center gap-2"><Github size={14} className="text-os-text-secondary" /> Source code</span>} testId="about-source">
            <ExternalLink href={brandRepository()} className="brand-link">{brandRepositoryLabel()}</ExternalLink>
          </Row>
          {brandFunding().length > 0 && (
            <Row label={<span className="flex items-center gap-2"><Coffee size={14} className="text-os-text-secondary" /> Support Jacarium</span>} testId="about-support">
              {brandFunding().map(({ url, label }, i) => (
                <span key={url}>
                  {i > 0 && <span className="text-os-text-muted"> · </span>}
                  <ExternalLink href={url} className="brand-link">{label}</ExternalLink>
                </span>
              ))}
            </Row>
          )}
          <Row label={<span className="flex items-center gap-2"><Bug size={14} className="text-os-text-secondary" /> Report an issue</span>} testId="about-issues">
            <ExternalLink href={`${brandRepository()}/issues`} className="brand-link">GitHub Issues</ExternalLink>
          </Row>
          <Row label={<span className="flex items-center gap-2"><Scale size={14} className="text-os-text-secondary" /> Licence</span>} testId="about-licence">
            <ExternalLink href={LICENCE_URL} className="brand-link">AGPL-3.0</ExternalLink>
          </Row>
        </InfoRows>
      </Section>

      <Section title="Security & verification" testId="about-security">
        <InfoRows>
          <Row label={<span className="flex items-center gap-2"><ShieldCheck size={14} className="text-os-text-secondary" /> Security policy</span>} testId="about-security-policy">
            <ExternalLink href={SECURITY_LINKS.policy} className="brand-link">SECURITY.md</ExternalLink>
          </Row>
          <Row label={<span className="flex items-center gap-2"><ShieldAlert size={14} className="text-os-text-secondary" /> Report a vulnerability</span>} testId="about-security-report">
            <ExternalLink href={SECURITY_LINKS.report} className="brand-link">privately, on GitHub</ExternalLink>
          </Row>
          <Row label={<span className="flex items-center gap-2"><Award size={14} className="text-os-text-secondary" /> OpenSSF Best Practices</span>} testId="about-security-bestpractices">
            <ExternalLink href={SECURITY_LINKS.bestPractices} className="brand-link">project {BEST_PRACTICES_PROJECT}</ExternalLink>
          </Row>
          <Row label={<span className="flex items-center gap-2"><BadgeCheck size={14} className="text-os-text-secondary" /> Verify this release</span>} testId="about-security-verify">
            <ExternalLink href={SECURITY_LINKS.verify} className="brand-link">signatures, provenance, SBOM</ExternalLink>
          </Row>
        </InfoRows>
        {isDesktopApp() && typeof window !== 'undefined' && typeof window.electronAPI?.openDataFolder === 'function' && (
          <ButtonRow align="start">
            <Button size="sm" onClick={() => window.electronAPI.openDataFolder().catch(() => {})} data-testid="about-open-data-folder">Show data folder</Button>
          </ButtonRow>
        )}
      </Section>

      <Section title="Credits" testId="about-credits">
        <InfoRows>
          {CREDITS.map((c) => (
            <Row key={c.name} label={<span><ExternalLink href={c.url} className="brand-link">{c.name}</ExternalLink><span className="text-os-text-muted"> - {c.what}</span></span>} testId="about-credit">
              <ExternalLink href={c.licenceUrl} className="brand-link">{c.licence}</ExternalLink>
            </Row>
          ))}
        </InfoRows>
      </Section>

      <Section title="All open-source licences" description="Every package that ships with this build - the app's, the desktop app's, the central server's and the backend's - with its licence and, where the package provides one, the licence text. Generated from the lock files when the app is built." testId="about-licences-section">
        <LicencesList />
      </Section>
    </div>
  );
}
