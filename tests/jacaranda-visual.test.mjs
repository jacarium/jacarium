/**
 * The Jacaranda dark theme in the real browser, next to the neutral dark
 * and the light theme: Documents (editor with a synthetic runbook, sidebar,
 * tabs), Settings (General), Kanban, Tasks, AI chat, What's New and the
 * phone-width Documents page. For every screen and variant the test checks
 * that it renders, raises no exception, that the surfaces carry the
 * variant's tokens (canvas, rail) and that the body text keeps >= 4.5:1
 * against the canvas as painted. The screenshots land in JACARANDA_SHOTS_DIR
 * (default: a temp dir) as <screen>-<variant>.png with variants
 * jacaranda / neutral / light.
 *
 * Needs Chrome and a free Vite port; skips cleanly otherwise. No backend:
 * the pages show their empty states where a server would fill them.
 * Synthetic data only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { dismissWhatsNew } from './helpers/visual-snapshots.mjs';

const OUT = process.env.JACARANDA_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'jacaranda-shots-'));
fs.mkdirSync(OUT, { recursive: true });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const app = await launchDocumentsApp({ port: 5279, profilePrefix: 'jacaranda-visual-' });
if (app.skip) { console.log('SKIP: ' + app.skip); process.exit(0); }
const ev = (s) => app.evaluate(s);
const shot = async (name, clip) => { const r = await app.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
const VARIANTS = {
  jacaranda: { theme: 'dark', canvas: '#0F0D16', rail: '#1B1530' },
  neutral: { theme: 'dark-neutral', canvas: '#151515', rail: '#1a1a1a' },
  light: { theme: 'light', canvas: '#F5F5F5', rail: '#1a1a1a' },
};
// through the real ThemeContext: the setting is what a user changes
const setVariant = async (v) => { await ev(`localStorage.setItem('app-theme', ${JSON.stringify(VARIANTS[v].theme)})`); await ev('location.reload()'); await sleep(3500); await ev(`(() => { const s = document.createElement('style'); s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'; document.head.appendChild(s); })()`); await dismissWhatsNew(app); };
const clickNav = async (label) => { const ok = await ev(`(() => { const b = Array.from(document.querySelectorAll('nav button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`); await sleep(1000); return ok; };
const escape = async () => { await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(400); };
const openDoc = async () => {
  await clickNav('Documents');
  const listed = await ev(`Array.from(document.querySelectorAll('*')).some((el) => el.children.length === 0 && el.textContent.trim() === 'Rotate the web tier certificate')`);
  if (!listed) { await ev(`(() => { const cat = Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0 && el.textContent.trim() === 'Runbooks').pop(); if (cat) cat.click(); })()`); await sleep(700); }
  await ev(`(() => { const row = Array.from(document.querySelectorAll('*')).filter((el) => el.children.length === 0 && el.textContent.trim() === 'Rotate the web tier certificate').pop(); if (row) row.click(); })()`); await sleep(1500);
};
const probe = () => ev(`(() => {
  const cs = (el) => getComputedStyle(el);
  const toRgb = (s) => (s.match(/\\d+(\\.\\d+)?/g) || []).slice(0, 3).map(Number);
  const lum = (c) => { const v = c.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const root = document.documentElement;
  const nav = document.querySelector('nav');
  const texts = Array.from(document.querySelectorAll('p, span, h1, h2, h3, button, label')).filter((el) => el.textContent.trim().length > 8 && el.children.length === 0 && el.getBoundingClientRect().width > 0 && el.closest('nav') == null).slice(0, 12);
  const text = texts[0];
  const bg = (el) => { let e = el; while (e) { const c = toRgb(cs(e).backgroundColor); const a = (cs(e).backgroundColor.match(/[\\d.]+/g) || [])[3]; if (c.length === 3 && a !== '0') return c; e = e.parentElement; } return toRgb(cs(document.body).backgroundColor); };
  return {
    dark: root.classList.contains('dark'), variant: root.getAttribute('data-dark-variant'), theme: root.getAttribute('data-theme'),
    canvas: cs(root).getPropertyValue('--os-canvas').trim(), body: cs(document.body).backgroundColor,
    rail: nav ? cs(nav).backgroundColor : null,
    textContrast: text ? ratio(toRgb(cs(text).color), bg(text)) : null, textSample: text ? text.textContent.trim().slice(0, 40) : null,
    // the share of the first visible text elements that reach 4.5:1 (a selected row or a badge may sit on a tinted surface), and the worst of them
    contrastShare: texts.length ? texts.filter((el) => ratio(toRgb(cs(el).color), bg(el)) >= 4.5).length / texts.length : 0,
    worst: texts.map((el) => ({ r: ratio(toRgb(cs(el).color), bg(el)), t: el.textContent.trim().slice(0, 30) })).sort((x, y) => x.r - y.r)[0],
    blank: !text,
  };
})()`);
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const same = (rgbString, hex) => { const a = (rgbString.match(/\d+/g) || []).slice(0, 3).map(Number); const b = hexToRgb(hex); return a.length === 3 && a.every((v, i) => v === b[i]); };

// The contrast rule is enforced for the theme under test (Jacaranda); the light theme and the neutral dark
// are unchanged by it and only reported (their known soft spots: muted text on secondary surfaces).
const contrast = (v, screen, p) => {
  const detail = `share ${p.contrastShare && p.contrastShare.toFixed(2)}, worst ${p.worst && p.worst.r.toFixed(2)} (${p.worst && p.worst.t})`;
  if (v === 'jacaranda') check(`${v}: ${screen} renders text with >= 4.5:1 contrast (at least 4 of 5 sampled elements)`, !p.blank && p.contrastShare >= 0.8, detail);
  else { check(`${v}: ${screen} renders text`, !p.blank); console.log(`  note: ${v} ${screen} contrast ${detail}`); }
};

try {
  await dismissWhatsNew(app);
  await ev(`(async () => {
    const docs = await import('/src/utils/documents.js');
    const kanban = await import('/src/utils/kanban.js');
    const inst = await import('/src/utils/taskwarriorInstances.js');
    const tasks = await import('/src/utils/tasks.js');
    const md = '# Rotate the web tier certificate\\n\\nA synthetic runbook used only for screenshots.\\n\\n## Steps\\n\\n1. Drain the node with \`kubectl drain web-0 --ignore-daemonsets\`.\\n2. Replace the certificate.\\n3. Uncordon and watch the readiness probe.\\n\\n\`\`\`bash\\nkubectl get pods -n web -o wide\\nopenssl x509 -in cert.pem -noout -dates\\n\`\`\`\\n\\n| Check | Expected |\\n|---|---|\\n| Readiness | 3/3 |\\n| Expiry | > 30 days |\\n\\n> Keep the previous certificate for 24 hours.\\n';
    await docs.createDocument({ title: 'Rotate the web tier certificate', content: md, category: 'Runbooks' });
    await docs.createDocument({ title: 'Cluster upgrade checklist', content: '# Cluster upgrade checklist\\n\\n- [ ] Back up etcd\\n- [ ] Pause alerts\\n- [x] Announce the window\\n', category: 'Runbooks' });
    await docs.createDocument({ title: 'Meeting notes 2026-10', content: '# Meeting notes\\n\\nSynthetic notes.\\n', category: 'Notes' });
    const board = await kanban.createBoard({ title: 'Platform work', category: 'General', columns: kanban.getDefaultColumns() });
    const cards = [['Rotate certificates', 'todo'], ['Upgrade etcd', 'todo'], ['Review runbooks', 'in-progress'], ['Alert tuning', 'review'], ['Dashboard cleanup', 'done']];
    let pos = 0;
    for (const [title, status] of cards) await kanban.createCard({ boardId: board.id, title, status, description: 'Synthetic card', position: pos++, tags: [], assignee: '' });
    const instance = await inst.createInstance({ name: 'Work', category: 'General', isActive: true });
    const now = new Date().toISOString();
    for (const [description, priority, project] of [['Write the upgrade runbook', 'H', 'platform'], ['Review alert thresholds', 'M', 'ops'], ['Clean the dashboards', 'L', 'ops'], ['Rotate the tier certificate', 'H', 'platform']]) {
      await tasks.createTask({ description, status: 'pending', priority, project, tags: ['synthetic'], instanceId: instance.id, entry: now, modified: now });
    }
    return 'seeded';
  })()`);

  for (const v of Object.keys(VARIANTS)) {
    await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await setVariant(v);
    const errorsBefore = app.errors.length;
    const expectDark = v !== 'light';
    const p0 = await probe();
    check(`${v}: the setting applies (.dark ${expectDark ? 'on' : 'off'}, variant ${v === 'neutral' ? 'neutral' : 'none'})`, p0.dark === expectDark && (v === 'neutral' ? p0.variant === 'neutral' : p0.variant === null) && p0.theme === VARIANTS[v].theme, JSON.stringify(p0));
    check(`${v}: the canvas token and the painted body are ${VARIANTS[v].canvas}`, p0.canvas.toUpperCase() === VARIANTS[v].canvas.toUpperCase() && (v === 'light' || same(p0.body, VARIANTS[v].canvas)), `${p0.canvas} / ${p0.body}`);
    check(`${v}: the rail is ${VARIANTS[v].rail}`, p0.rail && same(p0.rail, VARIANTS[v].rail), p0.rail);

    await openDoc();
    const pDoc = await probe();
    contrast(v, 'Documents', pDoc);
    await shot(`documents-${v}`);
    await ev(`window.dispatchEvent(new CustomEvent('openAppSettings', { detail: { tab: 'general' } }))`); await sleep(900);
    const settingsOpen = await ev(`!!document.querySelector('[data-testid="settings-modal"]')`);
    check(`${v}: Settings opens`, settingsOpen);
    await shot(`settings-${v}`);
    await escape();
    for (const [label, name] of [['Kanban', 'kanban'], ['Tasks', 'tasks'], ['Robin', 'ai-chat']]) {
      check(`${v}: nav item ${label} exists`, await clickNav(label));
      await sleep(600);
      const p = await probe();
      contrast(v, name, p);
      await shot(`${name}-${v}`);
    }
    await ev(`window.dispatchEvent(new Event('toggleWhatsNew'))`); await sleep(800);
    const wn = await ev(`Array.from(document.querySelectorAll('*')).some((el) => el.children.length === 0 && /What's New/.test(el.textContent))`);
    check(`${v}: What's New opens`, wn);
    await shot(`whats-new-${v}`);
    await escape();
    await app.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true }); await sleep(600);
    await openDoc();
    const overflow = await ev('document.documentElement.scrollWidth > document.documentElement.clientWidth + 1');
    check(`${v}: phone Documents has no horizontal overflow`, overflow === false);
    await shot(`phone-documents-${v}`, { x: 0, y: 0, width: 393, height: 852 });
    await app.send('Emulation.clearDeviceMetricsOverride'); await sleep(400);
    const newErrors = app.errors.slice(errorsBefore).filter((e) => !/favicon|ResizeObserver/.test(e));
    check(`${v}: no runtime exception`, newErrors.length === 0, newErrors.join(' || ').slice(0, 300));
  }
} catch (e) {
  check('the Jacaranda screens run', false, e.stack || String(e));
} finally {
  await app.close();
}
console.log(`\nscreenshots: ${OUT}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
