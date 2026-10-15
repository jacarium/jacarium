/**
 * Entry for tests/helpers/notice-banner-harness.html (see there). Exposes
 * window.__harness so tests/notice-banner-theme.test.mjs can toggle the
 * theme and read what the "Clean it?" action was clicked:
 *
 *   __harness.setDark(bool)   - same class ThemeContext toggles
 *   __harness.clicks          - number of times the tasks action was clicked
 *   __harness.setBusy(bool)   - render the tasks action in its busy state
 *
 * All content is synthetic.
 */
/* eslint-disable react-refresh/only-export-components -- test entry, renders as a side effect */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import NoticeBanner, { NoticeBannerAction } from '../../src/components/common/NoticeBanner.jsx';

function Harness() {
  const [busy, setBusy] = React.useState(false);
  const clicksRef = React.useRef(0);

  React.useEffect(() => {
    window.__harness = {
      setDark: (dark) => document.documentElement.classList.toggle('dark', !!dark),
      setBusy: (b) => setBusy(!!b),
      get clicks() { return clicksRef.current; },
    };
    window.__harnessReady = true;
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: 'var(--os-canvas)', padding: 24 }}>
      <p style={{ color: 'var(--os-text-secondary)', fontFamily: 'sans-serif', fontSize: 13 }}>
        Notice banner theme harness - tests only
      </p>
      <div className="bg-os-card border border-os-border" style={{ maxWidth: 760 }}>
        {/* Tasks page: orphaned cached tasks */}
        <NoticeBanner tone="warning" testId="orphaned-tasks-banner" className="border-b border-os-border">
          <span>3 Tasks in TaskWarrior not belonging to any TaskWarrior instance.</span>
          <NoticeBannerAction testId="orphaned-tasks-clean" busy={busy} onClick={() => { clicksRef.current += 1; }}>
            {busy ? 'Cleaning...' : 'Clean it?'}
          </NoticeBannerAction>
        </NoticeBanner>
        {/* Documents editor: the three notices */}
        <NoticeBanner tone="offline" title="Offline - Read Only" testId="document-offline-banner">
          <span>Shared documents require an online connection for editing. Reconnect to make changes.</span>
        </NoticeBanner>
        <NoticeBanner tone="readonly" title="Read-only:" testId="document-readonly-banner">
          <span>This document is shared by another team member. You can view but not edit.</span>
        </NoticeBanner>
        <NoticeBanner tone="warning" title="Server copy unavailable:" testId="document-server-copy-banner">
          <span>This document could not be loaded from the server. You are viewing your local cached copy, read-only.</span>
        </NoticeBanner>
        <div className="p-4 text-sm text-os-text-primary">Page content below the notices (synthetic).</div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
