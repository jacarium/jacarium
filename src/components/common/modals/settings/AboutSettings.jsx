/**
 * Settings > About: the mark, the wordmark and the tagline (from
 * package.json through src/brand/brand.js), the versions (this app, the
 * sync protocol, the home server when there is one), What's New, the
 * desktop downloads page of the home server, the website (a plain link that
 * opens in the browser - nothing is fetched from it), the author, the source
 * code (the repository - the AGPL's offer of the source), where to support
 * the project (a tip on Ko-fi), where to report an issue, the licence, and the credits for the fonts and libraries it ships.
 */
import { useEffect, useState } from 'react';
import { Globe, Scale, User, Github, Bug, Coffee } from 'lucide-react';
import BrandMark, { BrandWordmark } from '../../../../brand/BrandMark';
import { brandTagline, brandHomepage, brandHomepageLabel, brandRepository, brandRepositoryLabel, brandAuthor, brandFunding } from '../../../../brand/brand';
import { latestVersion } from '../../../../whats-new/versions';
import protocolJson from '../../../../../protocol.json';
import { Section, InfoRows, Button, ExternalLink } from './ui';
import { isDesktopApp } from '../../../../utils/platform';
import { apiFetch, getBackendUrl } from '../../../../utils/backendUrl';
import { getHomeServerStatus, checkHomeServerVersion } from '../../../../utils/homeServer';

const PROTOCOL = Number(protocolJson?.protocol) || 1;

const LICENCE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

// Third-party work the app ships, with its licence (the README's Licence
// section says the same).
const OFL = { licence: 'SIL Open Font License', licenceUrl: 'https://openfontlicense.org' };
const CREDITS = [
  { name: 'Red Hat Text', what: 'font', url: 'https://fonts.google.com/specimen/Red+Hat+Text', ...OFL },
  { name: 'Red Hat Mono', what: 'font', url: 'https://fonts.google.com/specimen/Red+Hat+Mono', ...OFL },
  { name: 'Sora', what: 'font', url: 'https://fonts.google.com/specimen/Sora', ...OFL },
  { name: 'React Flow', what: 'workflow canvas', url: 'https://reactflow.dev', licence: 'MIT', licenceUrl: 'https://github.com/xyflow/xyflow/blob/main/LICENSE' },
];

function Row({ label, children, testId }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm" data-testid={testId}>
      <span className="text-os-text-primary">{label}</span>
      <span className="text-os-text-secondary text-right min-w-0">{children}</span>
    </div>
  );
}

export default function AboutSettings({ onShowWhatsNew }) {
  const [server, setServer] = useState(null);   // { app, protocol, url } | null

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
          if (!cancelled && check?.server?.app) setServer({ app: check.server.app, protocol: check.server.protocol, url: status.url });
        } else {
          const base = await getBackendUrl();
          const r = await apiFetch(`${base}/api/version`);
          if (r.ok) { const v = await r.json(); if (!cancelled && v?.app) setServer({ app: v.app, protocol: v.protocol, url: '' }); }
        }
      } catch { /* no server: the row says so */ }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="space-y-6" data-testid="about-settings">
      <div className="brand-hero brand-hero-strip flex items-center gap-4 p-5">
        <BrandMark size={56} />
        <div className="min-w-0">
          <BrandWordmark size={30} className="brand-hero-title" />
          <p className="brand-tagline brand-hero-sub mt-1 text-sm" data-testid="about-tagline">{brandTagline()}</p>
        </div>
      </div>

      <Section title="Version" testId="about-version">
        <InfoRows>
          <Row label="App" testId="about-app-version">{latestVersion}</Row>
          <Row label="Sync protocol">{PROTOCOL}</Row>
          <Row label="Home server">
            {server ? `Jacarium ${server.app} (protocol ${server.protocol ?? '?'})${server.url ? ` - ${server.url}` : ''}` : (isDesktopApp() ? 'not linked' : 'this server')}
          </Row>
        </InfoRows>
      </Section>

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

      <Section title="Credits" testId="about-credits">
        <InfoRows>
          {CREDITS.map((c) => (
            <Row key={c.name} label={<span><ExternalLink href={c.url} className="brand-link">{c.name}</ExternalLink><span className="text-os-text-muted"> - {c.what}</span></span>}>
              <ExternalLink href={c.licenceUrl} className="brand-link">{c.licence}</ExternalLink>
            </Row>
          ))}
        </InfoRows>
      </Section>
    </div>
  );
}
