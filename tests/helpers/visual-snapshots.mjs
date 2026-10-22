/**
 * Full-page screenshot capture and pixel comparison for the real app, built
 * on tests/helpers/live-documents-app.mjs (Vite dev server + headless Chrome
 * over CDP). Written for the Tailwind 3 -> 4 migration so the main views
 * could be captured before and after and diffed, but generic: any CSS or
 * dependency change can be checked the same way.
 *
 *   captureSnapshots({ outDir })
 *     Opens every main page of the app (the CompactSidebar nav items) in the
 *     light and the dark theme and writes <page>-<theme>.png.
 *
 *     When the Flask backend can run here (backend/venv exists, :8080 free)
 *     it is also started with a throwaway X-App-Token and the SYNTHETIC
 *     sosreport fixture from tests/helpers/diagnostics-driver/make_fixture.py
 *     (no real data) is loaded, so the Diagnostics page's sandboxed tab
 *     frames (diag-<tab>-<theme>.png, styled by the app's own compiled
 *     Tailwind, inlined into each srcdoc frame) and the legacy standalone
 *     dashboard pages served by Flask (flask-<tab>-<theme>.png, styled by the
 *     compiled backend/static/vendor/tailwind.css) are captured too.
 *     Otherwise those are skipped with a reason.
 *
 *   compareSnapshotDirs(beforeDir, afterDir, diffDir)
 *     Per-pixel diff of same-named PNGs (pngjs, already a transitive
 *     dependency); writes a diff image per changed file and returns one
 *     record per file.
 *
 * CDP only - no Playwright/Puppeteer. Animations, transitions and the text
 * caret are disabled in the page so captures are stable.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { launchDocumentsApp, REPO, sleep } from './live-documents-app.mjs';

/** Sidebar labels (CompactSidebar navItems) in display order. */
export const APP_PAGES = [
  'Documents', 'Calendars', 'Robin', 'Kanban', 'Tasks',
  'Workflow Builder', 'Diagnostics', 'JQL Search', 'Tools',
];

/** The Vite port Flask's CORS allow-list accepts (backend/extensions.py). */
export const VITE_PORT = 5173;
export const FLASK_PORT = 8080;

const FIXTURE_ROOT = '/tmp/diag-reports';
const FIXTURE_REPORT = 'sosreport-synthetic-2026';

/**
 * Standalone dashboard tabs to capture, as switchTab(tab, parent) pairs,
 * limited to what the synthetic fixture populates. Pairs whose button is
 * not in the sidebar are skipped.
 */
const FLASK_TABS = [
  ['system', null], ['processes', 'system'], ['services', 'system'], ['dmidecode', 'system'],
  ['cgroups', null], ['cgroups_cpu', 'cgroups'], ['cgroups_memory', 'cgroups'],
  ['kernel', null], ['kernel_oom_killer', 'kernel'], ['log_collection', null], ['log_viewer', 'log_collection'],
  ['sos_report', null], ['blame', 'sos_report'],
];
/** In-app Diagnostics sidebar labels to capture (first match wins). */
const DIAG_LABELS = ['System', 'Processes', 'Services', 'Cgroups', 'CPU', 'Memory', 'Kernel', 'OOM Killer', 'Log Collection', 'Log Viewer', 'Sos Report', 'Blame'];

export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

const STABILIZE_CSS = `*, *::before, *::after { transition: none !important; animation: none !important; caret-color: transparent !important; scroll-behavior: auto !important; }`;

function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

const stop = (child) => new Promise((resolve) => {
  if (!child || child.exitCode !== null || child.signalCode) return resolve();
  child.once('exit', resolve);
  child.kill();
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
});

/** Build the synthetic sosreport tree; returns its path or null. */
export function makeFixture() {
  const script = path.join(REPO, 'tests', 'helpers', 'diagnostics-driver', 'make_fixture.py');
  const r = spawn('python3', [script], { stdio: 'ignore' });
  return new Promise((resolve) => {
    r.once('exit', (code) => resolve(code === 0 && existsSync(path.join(FIXTURE_ROOT, FIXTURE_REPORT)) ? path.join(FIXTURE_ROOT, FIXTURE_REPORT) : null));
    r.once('error', () => resolve(null));
  });
}

/**
 * Start the Flask backend on :8080 with a fresh random token. Resolves to
 * { token, stop } or { skip }.
 */
export async function startFlask() {
  const python = path.join(REPO, 'backend', 'venv', 'bin', 'python');
  if (!existsSync(python)) return { skip: 'backend/venv missing - Flask-backed captures skipped' };
  if (!(await portFree(FLASK_PORT))) return { skip: `:${FLASK_PORT} in use - Flask-backed captures skipped` };
  const token = randomBytes(16).toString('hex');
  const child = spawn(python, ['app.py'], {
    cwd: path.join(REPO, 'backend'),
    env: { ...process.env, APP_AUTH_TOKEN: token, PORT: String(FLASK_PORT), FLASK_DEBUG: '0' },
    stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${FLASK_PORT}/health`)).ok; } catch { await sleep(250); }
    if (child.exitCode !== null) break;
  }
  if (!ready) { await stop(child); return { skip: 'Flask backend did not come up on :8080 - Flask-backed captures skipped' }; }
  return { token, stop: () => stop(child) };
}

async function screenshot(app, file) {
  const r = await app.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(file, Buffer.from(r.result.data, 'base64'));
}

async function setTheme(app, theme) {
  // the plain .dark is the Jacaranda theme; SNAPSHOT_DARK_VARIANT=neutral captures the neutral dark instead
  await app.evaluate(`document.documentElement.classList.${theme === 'dark' ? 'add' : 'remove'}('dark'); document.documentElement.${theme === 'dark' && process.env.SNAPSHOT_DARK_VARIANT === 'neutral' ? "setAttribute('data-dark-variant', 'neutral')" : "removeAttribute('data-dark-variant')"}`);
  await sleep(500);
}

async function clickNav(app, label) {
  return app.evaluate(`(() => {
    const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return false; b.click(); return true;
  })()`);
}

/**
 * A fresh profile opens the What's New window on first run; "Got it!" marks
 * the version as seen so it stays closed. Exported for other live tests.
 */
export async function dismissWhatsNew(app) {
  for (let i = 0; i < 10; i++) {
    const closed = await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === 'Got it!'); if (!b) return false; b.click(); return true; })()`);
    if (closed) { await sleep(500); return true; }
    await sleep(300);
  }
  return false;
}

async function stabilize(app) {
  await app.evaluate(`(() => {
    if (document.getElementById('__snapshot_stabilize')) return;
    const s = document.createElement('style'); s.id = '__snapshot_stabilize';
    s.textContent = ${JSON.stringify(STABILIZE_CSS)}; document.head.appendChild(s);
  })()`);
}

/**
 * @param {{ outDir: string, port?: number, flask?: boolean, log?: (line: string) => void }} o
 * @returns {Promise<{ skip: string } | { files: string[], missing: string[], skipped: string[], errors: string[] }>}
 */
export async function captureSnapshots({ outDir, port = VITE_PORT, flask = true, log = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const app = await launchDocumentsApp({ port, profilePrefix: 'visual-snapshots-' });
  if (app.skip) return app;
  const files = [];
  const missing = [];
  const skipped = [];
  const shot = async (name) => { const f = path.join(outDir, `${name}.png`); await screenshot(app, f); files.push(f); log(`captured ${name}`); };
  let backend = null;
  try {
    await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await stabilize(app);
    await dismissWhatsNew(app);
    await sleep(500);

    for (const label of APP_PAGES) {
      if (!(await clickNav(app, label))) { missing.push(label); continue; }
      await sleep(2000); // lazy page chunk + data load
      for (const theme of ['light', 'dark']) {
        await setTheme(app, theme);
        await shot(`${slug(label)}-${theme}`);
      }
      await setTheme(app, 'light');
    }

    if (flask) {
      backend = await startFlask();
      if (backend.skip) {
        skipped.push(backend.skip);
      } else if (!(await makeFixture())) {
        skipped.push('could not build the synthetic diagnostics fixture (python3 missing?) - Flask-backed captures skipped');
      } else {
        await app.send('Network.enable');
        await app.send('Network.setExtraHTTPHeaders', { headers: { 'X-App-Token': backend.token } });

        // In-app Diagnostics: point the report scanner at the fixture, remount
        // the page so it reads that setting, open the report, walk its tabs.
        await app.evaluate(`localStorage.setItem('diagnosticsReportsDirectory', ${JSON.stringify(FIXTURE_ROOT)})`);
        await clickNav(app, 'Tools');
        await sleep(500);
        await clickNav(app, 'Diagnostics');
        const opened = await app.waitFor(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.includes(${JSON.stringify(FIXTURE_REPORT)})); if (!b) return false; b.click(); return true; })()`, 20000);
        if (!opened) {
          skipped.push('in-app Diagnostics: the synthetic report never appeared in the report list');
        } else {
          const labels = await app.waitFor(`(() => { const l = Array.from(document.querySelectorAll('div.cursor-pointer span')).map((s) => s.textContent.trim()); return l.length ? l : null; })()`, 20000) || [];
          for (const label of DIAG_LABELS.filter((l) => labels.includes(l))) {
            await app.evaluate(`(() => { const s = Array.from(document.querySelectorAll('div.cursor-pointer span')).find((el) => el.textContent.trim() === ${JSON.stringify(label)}); s && s.closest('div.cursor-pointer').click(); })()`);
            await sleep(3000); // fragment fetch + iframe srcdoc render
            for (const theme of ['light', 'dark']) {
              await setTheme(app, theme);
              await shot(`diag-${slug(label)}-${theme}`);
            }
            await setTheme(app, 'light');
          }
        }

        // Standalone Flask dashboard (vendored Tailwind build).
        await app.send('Page.navigate', { url: `http://127.0.0.1:${FLASK_PORT}/` });
        await sleep(1500);
        await app.evaluate(`(() => { document.getElementById('report_type').value = 'sosreport'; document.getElementById('directory').value = ${JSON.stringify(path.join(FIXTURE_ROOT, FIXTURE_REPORT))}; document.querySelector('form').submit(); })()`);
        const ok = await app.waitFor(`typeof switchTab === 'function'`, 15000);
        if (!ok) {
          skipped.push('standalone Flask dashboard: the report form did not lead to the dashboard');
        } else {
          await stabilize(app);
          const available = await app.evaluate(`Array.from(document.querySelectorAll('[onclick^="switchTab("]')).map((el) => el.getAttribute('onclick'))`);
          for (const [tab, parent] of FLASK_TABS) {
            const call = parent ? `switchTab('${tab}', '${parent}')` : `switchTab('${tab}')`;
            if (!available.includes(call)) continue;
            await app.evaluate(call);
            await app.waitFor(`!document.querySelector('#tab-container .fa-spinner')`, 15000);
            await sleep(1500);
            for (const theme of ['light', 'dark']) {
              await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
              await sleep(400);
              await shot(`flask-${slug(tab)}-${theme}`);
            }
            await app.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
          }
        }
      }
    }
    return { files, missing, skipped, errors: app.errors.slice() };
  } finally {
    await app.close();
    if (backend && backend.stop) await backend.stop();
  }
}

/** Decode a PNG with pngjs (resolved from the repo's node_modules). */
async function loadPng(file) {
  const { PNG } = await import('pngjs');
  return PNG.sync.read(readFileSync(file));
}

/**
 * @returns {Promise<Array<{ name: string, status: 'same'|'changed'|'size'|'missing', diffPixels?: number, percent?: number, diffFile?: string }>>}
 */
export async function compareSnapshotDirs(beforeDir, afterDir, diffDir, { channelTolerance = 24 } = {}) {
  mkdirSync(diffDir, { recursive: true });
  const { PNG } = await import('pngjs');
  const names = new Set([...readdirSync(beforeDir), ...readdirSync(afterDir)].filter((f) => f.endsWith('.png')));
  const out = [];
  for (const name of [...names].sort()) {
    const a = path.join(beforeDir, name);
    const b = path.join(afterDir, name);
    if (!existsSync(a) || !existsSync(b)) { out.push({ name, status: 'missing' }); continue; }
    const [pa, pb] = await Promise.all([loadPng(a), loadPng(b)]);
    if (pa.width !== pb.width || pa.height !== pb.height) { out.push({ name, status: 'size' }); continue; }
    const diff = new PNG({ width: pa.width, height: pa.height });
    let diffPixels = 0;
    for (let i = 0; i < pa.data.length; i += 4) {
      const d = Math.max(Math.abs(pa.data[i] - pb.data[i]), Math.abs(pa.data[i + 1] - pb.data[i + 1]), Math.abs(pa.data[i + 2] - pb.data[i + 2]));
      if (d > channelTolerance) {
        diffPixels++;
        diff.data[i] = 255; diff.data[i + 1] = 0; diff.data[i + 2] = 0; diff.data[i + 3] = 255;
      } else {
        // faded "after" image as context
        diff.data[i] = 128 + (pb.data[i] >> 1); diff.data[i + 1] = 128 + (pb.data[i + 1] >> 1); diff.data[i + 2] = 128 + (pb.data[i + 2] >> 1); diff.data[i + 3] = 255;
      }
    }
    const total = pa.width * pa.height;
    if (diffPixels === 0) { out.push({ name, status: 'same', diffPixels: 0, percent: 0 }); continue; }
    const diffFile = path.join(diffDir, name.replace(/\.png$/, '.diff.png'));
    writeFileSync(diffFile, PNG.sync.write(diff));
    out.push({ name, status: 'changed', diffPixels, percent: +(100 * diffPixels / total).toFixed(3), diffFile });
  }
  return out;
}
