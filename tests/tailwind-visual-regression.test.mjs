/**
 * Real-browser guard for the Tailwind 3 -> 4 migration (and any later
 * Tailwind/CSS change): every main page still renders in the light AND the
 * dark theme without a runtime exception or a blank viewport, and the
 * Tailwind v3 defaults the UI was written against still hold - Tailwind 4
 * silently changed them, and src/index.css restores them:
 *
 *   - a bare `border` (no border-color utility) is gray-200, not currentColor
 *   - an input's placeholder is gray-400, not currentColor at 50%
 *   - <button> shows the pointer cursor, not the default arrow
 *   - `ring-N` without a ring colour is blue-500 at 50%, not currentColor
 *   - hover: utilities apply without the (hover: hover) media guard, so a
 *     touch-capable laptop still gets hover styles from its trackpad
 *
 * Each page is screenshotted (viewport 1400x900) and the PNG's pixel
 * variance checked, so a page whose stylesheet failed to load (all one
 * colour) fails here even if React mounted fine.
 *
 * Skips (exit 0 with a SKIP line) without Chrome/Chromium or when
 * SKIP_BROWSER_TESTS is set, like the other live tests. Uses :5190 so it
 * can run next to a developer's own dev server.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchDocumentsApp, sleep } from './helpers/live-documents-app.mjs';
import { APP_PAGES, dismissWhatsNew, slug } from './helpers/visual-snapshots.mjs';

const port = Number(process.env.SMOKE_PORT || 5190);
let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + detail : ''}`);
  if (!ok) failed++;
};

async function pixelSpread(file) {
  const { PNG } = await import('pngjs');
  const png = PNG.sync.read(readFileSync(file));
  let min = 255, max = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const lum = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }
  return max - min;
}

const app = await launchDocumentsApp({ port, profilePrefix: 'tailwind-regression-' });
if (app.skip) { console.log('SKIP: ' + app.skip); process.exit(0); }
const shots = mkdtempSync(path.join(tmpdir(), 'tailwind-regression-shots-'));

try {
  await app.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  // Headless Chrome's page is not the focused window, so :focus styles do
  // not apply to a programmatically focused element unless focus is emulated.
  await app.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await dismissWhatsNew(app);

  // --- v3 default guards, measured on probe elements inside the live page ---
  const probe = await app.evaluate(`(() => {
    const host = document.createElement('div'); host.id = '__tw_probe'; host.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(host);
    const el = (tag, cls, attrs = {}) => { const e = document.createElement(tag); if (cls) e.className = cls; Object.assign(e, attrs); host.appendChild(e); return e; };
    const bordered = el('div', 'border');
    const input = el('input', '', { placeholder: 'x' });
    const button = el('button', '', { textContent: 'b' });
    const ringed = el('input', 'focus:ring-2');
    ringed.focus();
    const cs = (e, pseudo) => getComputedStyle(e, pseudo);
    // Tailwind 4 defines its palette in oklch(), which getComputedStyle
    // reports verbatim; paint the colour to compare it as sRGB.
    const ctx = document.createElement('canvas').getContext('2d');
    const rgb = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); return Array.from(ctx.getImageData(0, 0, 1, 1).data).slice(0, 3); };
    // the corner radius scale (src/index.css @theme; tests/rounded-corners.test.mjs)
    // (Tailwind emits a utility only where a source file uses it: a size no
    // component uses yet is checked through its token on :root instead.)
    const rules = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) rules.push(rule); } catch { /* cross-origin sheet */ } }
    const hasUtility = (u) => rules.some((rule) => rule.selectorText && rule.selectorText.split(',').some((sel) => sel.trim() === '.' + u));
    const token = (name) => cs(document.documentElement).getPropertyValue(name).trim();
    const radius = {};
    for (const u of ['rounded-xs', 'rounded-sm', 'rounded', 'rounded-md', 'rounded-lg', 'rounded-xl', 'rounded-2xl', 'rounded-3xl']) radius[u] = hasUtility(u) ? cs(el('div', u)).borderTopLeftRadius : 'token ' + token('--radius' + u.slice('rounded'.length));
    const pill = cs(el('div', 'rounded-full')).borderTopLeftRadius;
    const tab = el('div', 'rounded-lg'); tab.setAttribute('data-testid', 'document-tab');
    const table = el('table', 'rounded-lg'); const td = document.createElement('td'); td.className = 'rounded-lg'; table.appendChild(document.createElement('tr')).appendChild(td);
    const editor = el('textarea', 'rounded-lg resize-none h-full');
    const thumbRule = rules.find((rule) => rule.selectorText && /^\\*?::-webkit-scrollbar-thumb$/.test(rule.selectorText.trim())); const thumb = thumbRule ? thumbRule.style.borderRadius : 'no rule';
    // controls: the base rules give every button/field the control radius and the normal weight
    const plainButton = el('button', '', { textContent: 'b' }); const plainInput = el('input', '', { type: 'text' }); const plainSelect = el('select'); const plainTextarea = el('textarea'); const plainCheck = el('input', '', { type: 'checkbox' }); const plainRadio = el('input', '', { type: 'radio' }); const plainLabel = el('label', '', { textContent: 'l' });
    const controls = { button: cs(plainButton).borderTopLeftRadius + '/' + cs(plainButton).fontWeight, input: cs(plainInput).borderTopLeftRadius + '/' + cs(plainInput).fontWeight, select: cs(plainSelect).borderTopLeftRadius, textarea: cs(plainTextarea).borderTopLeftRadius, checkbox: cs(plainCheck).borderTopLeftRadius + '/' + cs(plainCheck).accentColor, radio: cs(plainRadio).borderTopLeftRadius, label: cs(plainLabel).fontWeight };
    // the dark themes: the plain .dark is Jacaranda, the variant attribute selects the neutral greys
    const root = document.documentElement; const hadDark = root.classList.contains('dark'); const hadVariant = root.getAttribute('data-dark-variant');
    root.classList.add('dark'); root.removeAttribute('data-dark-variant'); const jacaranda = { canvas: token('--os-canvas'), text: token('--os-text-primary'), rail: token('--os-rail'), success: token('--os-status-success') };
    root.setAttribute('data-dark-variant', 'neutral'); const neutral = { canvas: token('--os-canvas'), text: token('--os-text-primary'), rail: token('--os-rail'), success: token('--os-status-success') };
    if (!hadDark) root.classList.remove('dark'); if (hadVariant) root.setAttribute('data-dark-variant', hadVariant); else root.removeAttribute('data-dark-variant');
    const r = {
      controls, jacaranda, neutral,
      radius, pill, tab: cs(tab).borderTopLeftRadius + '/' + cs(tab).borderBottomLeftRadius, td: cs(td).borderTopLeftRadius, editor: cs(editor).borderTopLeftRadius, thumb,
      borderColor: rgb(cs(bordered).borderTopColor),
      placeholderColor: rgb(cs(input, '::placeholder').color),
      buttonCursor: cs(button).cursor,
      ringShadow: cs(ringed).boxShadow,
      hoverMedia: Array.from(document.styleSheets).some((s) => { try { return Array.from(s.cssRules).some((rule) => rule.media && /hover:\\s*hover/.test(rule.media.mediaText)); } catch { return false; } }),
    };
    host.remove();
    return r;
  })()`);
  // v3 hex values; v4's oklch palette lands within a couple of sRGB steps.
  const near = (a, b, tol = 4) => a.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tol);
  check('bare `border` keeps the v3 gray-200 default colour', near(probe.borderColor, [229, 231, 235]), `rgb(${probe.borderColor})`);
  check('placeholder keeps the v3 gray-400 default colour', near(probe.placeholderColor, [156, 163, 175]), `rgb(${probe.placeholderColor})`);
  check('<button> keeps the pointer cursor', probe.buttonCursor === 'pointer', probe.buttonCursor);
  // a colourless focus:ring-2 shows the shared blue focus ring: the v3 blue-500/50 ring, or on a field the base rule's os-blue at 40%
  check('colourless focus:ring-2 shows the blue focus ring', /rgba\(59, 130, 246, 0\.5\)|srgb 0 0\.4 0\.8 \/ 0\.4|rgb\(0,? 102,? 204/.test(probe.ringShadow), probe.ringShadow.slice(0, 120));
  check('hover: utilities are not gated behind @media (hover: hover)', probe.hoverMedia === false);
  const SCALE = { 'rounded-xs': '6px', 'rounded-sm': '8px', 'rounded': '8px', 'rounded-md': '10px', 'rounded-lg': '14px', 'rounded-xl': '16px', 'rounded-2xl': '20px', 'rounded-3xl': '28px' };
  for (const [u, v] of Object.entries(SCALE)) check(`.${u} renders a ${v} corner (or its token says so where no component uses it yet)`, probe.radius[u] === v || probe.radius[u] === 'token ' + v, probe.radius[u]);
  check('.rounded-full stays a pill', parseFloat(probe.pill) > 100, probe.pill);
  check('a document tab is square (0 / 0, whatever utility it carries)', probe.tab === '0px/0px', probe.tab);
  check('table cells and the editor textarea stay square whatever utility they carry', probe.td === '0px' && probe.editor === '0px', `${probe.td} ${probe.editor}`);
  check('scrollbar thumbs stay square', probe.thumb === '0px', probe.thumb);
  check('a plain <button> takes the control radius (8px) and the normal weight', probe.controls.button === '8px/400', probe.controls.button);
  check('a plain <input>, <select> and <textarea> take the control radius and the normal weight', probe.controls.input === '8px/400' && probe.controls.select === '8px' && probe.controls.textarea === '8px', JSON.stringify(probe.controls));
  // native checkboxes/radios are drawn by the platform (appearance: auto): the accent colour is what shows; the radius rule is checked statically
  check('checkboxes and radios take the accent colour (the action blue)', /rgb\(0, 102, 204\)|#0066cc/i.test(probe.controls.checkbox) , probe.controls.checkbox);
  check('labels are normal weight', probe.controls.label === '400', probe.controls.label);
  check('.dark alone is the Jacaranda theme (night-ink canvas, lilac text, violet rail, leaf-green success)', probe.jacaranda.canvas.toUpperCase() === '#0F0D16' && probe.jacaranda.text.toUpperCase() === '#EDE6FF' && probe.jacaranda.rail.toUpperCase() === '#1B1530' && probe.jacaranda.success.toUpperCase() === '#3FA37A', JSON.stringify(probe.jacaranda));
  check('.dark[data-dark-variant="neutral"] keeps the neutral greys', probe.neutral.canvas === '#151515' && probe.neutral.text === '#f0f0f0' && probe.neutral.rail === '#1a1a1a' && probe.neutral.success.toUpperCase() === '#3E8635', JSON.stringify(probe.neutral));

  // --- every page, both themes: no exception, no blank viewport ---
  for (const label of APP_PAGES) {
    const errorsBefore = app.errors.length;
    const clicked = await app.evaluate(`(() => { const b = Array.from(document.querySelectorAll('button')).find((el) => el.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`);
    check(`nav item "${label}" exists`, clicked);
    if (!clicked) continue;
    await sleep(2000);
    for (const theme of ['light', 'dark']) {
      await app.evaluate(`document.documentElement.classList.${theme === 'dark' ? 'add' : 'remove'}('dark')`);
      await sleep(400);
      const file = path.join(shots, `${slug(label)}-${theme}.png`);
      const r = await app.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      const spread = await pixelSpread(file);
      check(`${label} (${theme}) renders a non-blank viewport`, spread > 40, `luminance spread ${spread}`);
    }
    await app.evaluate(`document.documentElement.classList.remove('dark')`);
    const newErrors = app.errors.slice(errorsBefore);
    check(`${label}: no runtime exception while rendering`, newErrors.length === 0, newErrors.join(' || ').slice(0, 300));
  }
} finally {
  await app.close();
  rmSync(shots, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
