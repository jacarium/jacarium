#!/usr/bin/env node
/**
 * Before/after screenshot driver for the real app (see
 * tests/helpers/visual-snapshots.mjs). Used to review the Tailwind 3 -> 4
 * migration view by view; reusable for any styling or dependency change.
 *
 *   node tests/visual-snapshots.mjs capture <outDir>
 *       Every main page in light and dark (plus the Diagnostics tab frames
 *       and the standalone Flask dashboard when the backend can run here)
 *       as PNGs in <outDir>.
 *
 *   node tests/visual-snapshots.mjs compare <beforeDir> <afterDir> <diffDir>
 *       Pixel-diffs same-named PNGs, writes <name>.diff.png for every
 *       changed capture (red = changed pixels over the faded "after" image)
 *       and prints a table. Exit code 0 either way - the diffs are for a
 *       human to look at, not a pass/fail oracle (data in the views such as
 *       the clock or calendar legitimately changes between runs).
 *
 * Deliberately NOT named *.test.mjs: tests/run-all.sh auto-runs that glob
 * and this is a tool, not a test. The pass/fail check that every page still
 * renders in both themes with the Tailwind v3 defaults the app relies on is
 * tests/tailwind-visual-regression.test.mjs.
 *
 * Needs Chrome/Chromium (CHROME_BIN) like every real-browser test; the Vite
 * dev server is started on :5173 (the only origin the Flask CORS allow-list
 * accepts). Set SMOKE_PORT to use another port and skip the Flask parts.
 */
import { captureSnapshots, compareSnapshotDirs, VITE_PORT } from './helpers/visual-snapshots.mjs';

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'capture' && args[0]) {
  const port = Number(process.env.SMOKE_PORT || VITE_PORT);
  const r = await captureSnapshots({ outDir: args[0], port, flask: port === VITE_PORT, log: (l) => console.log('  ' + l) });
  if (r.skip) { console.log('SKIP: ' + r.skip); process.exit(0); }
  console.log(`\n${r.files.length} captures in ${args[0]}`);
  for (const m of r.missing) console.log(`  missing nav item: ${m}`);
  for (const s of r.skipped) console.log(`  skipped: ${s}`);
  for (const e of r.errors) console.log(`  page exception: ${e}`);
} else if (cmd === 'compare' && args.length === 3) {
  const rows = await compareSnapshotDirs(args[0], args[1], args[2]);
  for (const r of rows) {
    const extra = r.status === 'changed' ? `${r.diffPixels} px (${r.percent}%)  ${r.diffFile}` : '';
    console.log(`${r.status.padEnd(8)} ${r.name.padEnd(36)} ${extra}`);
  }
  const changed = rows.filter((r) => r.status !== 'same').length;
  console.log(`\n${rows.length} compared, ${changed} differ`);
} else {
  console.log('usage: visual-snapshots.mjs capture <outDir> | compare <beforeDir> <afterDir> <diffDir>');
  process.exit(2);
}
