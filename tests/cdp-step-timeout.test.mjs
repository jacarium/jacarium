#!/usr/bin/env node
/**
 * The CDP harness (tests/helpers/live-documents-app.mjs) fails instead of
 * hanging: every call is bounded by cdpStepTimeout (CDP_STEP_TIMEOUT_MS,
 * default 60 s) and rejects with the method's name when the page does not
 * answer, and the driver gives the page up after the first timeout, so the
 * CDP-driven audits (pages-visual-audit, settings-visual-audit,
 * jacaranda-visual, brand-pages-visual and the rest) end with a failed check
 * and a message, never an endless wait that blocks a full suite.
 *
 * Run: node tests/cdp-step-timeout.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cdpStepTimeout, CDP_TIMEOUT_MS } from './helpers/live-documents-app.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 600) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

check('the default step timeout is 60 s (CDP_STEP_TIMEOUT_MS overrides it)', CDP_TIMEOUT_MS === (process.env.CDP_STEP_TIMEOUT_MS ? Number(process.env.CDP_STEP_TIMEOUT_MS) : 60000));
const quick = await cdpStepTimeout(Promise.resolve({ id: 1, result: { value: 2 } }), 'Runtime.evaluate', 200);
check('a reply in time comes back unchanged', quick && quick.result && quick.result.value === 2);
const t = Date.now();
let err = null;
try { await cdpStepTimeout(new Promise(() => {}), 'Page.captureScreenshot', 150); } catch (e) { err = e; }
check('a call that never answers rejects after the timeout, naming the method and the likely cause', !!err && /CDP Page\.captureScreenshot did not answer within 0 s/.test(err.message) && /not responding/.test(err.message) && Date.now() - t >= 140 && Date.now() - t < 2000, err && err.message);
let late = false;
await cdpStepTimeout(sleep(50).then(() => { late = true; return 'ok'; }), 'Runtime.evaluate', 500);
check('the timer is cleared when the reply arrives (no stray rejection)', late);

const driver = fs.readFileSync(path.join(REPO, 'tests/helpers/live-documents-app.mjs'), 'utf8');
check('the driver routes every send() through cdpStepTimeout and gives the page up after the first timeout', /return cdpStepTimeout\(reply, method, timeoutMs\)\.catch\(\(e\) => \{ pending\.delete\(mid\); dead = dead \|\| e\.message; throw e; \}\);/.test(driver) && /if \(dead\) return Promise\.reject\(new Error\(dead\)\);/.test(driver));
const audits = ['tests/pages-visual-audit.test.mjs', 'tests/settings-visual-audit.test.mjs', 'tests/jacaranda-visual.test.mjs', 'tests/brand-pages-visual.test.mjs'];
check('the CDP audits all drive the page through this harness (launchDocumentsApp), so the bound applies to each', audits.every((f) => /launchDocumentsApp/.test(fs.readFileSync(path.join(REPO, f), 'utf8'))));
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
