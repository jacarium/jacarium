/**
 * The spell checker in the REAL Electron app (electron/spellcheck.cjs):
 * no request leaves the machine for a dictionary, and the checker works.
 *
 * THE PROBLEM: on Windows and Linux Electron downloads its Hunspell
 * dictionaries from Google's CDN (redirector.gvt1.com) on the first run of
 * a profile. The dictionaries are shipped instead and the download URL is
 * pointed at a local file: URL (tests/electron-spellcheck-dictionaries.test.mjs
 * covers the files, the hashes and the packaging without launching anything).
 *
 * What this test proves, against the app launched on a fresh throwaway
 * profile (tests/helpers/electron-app.mjs) with Chromium's proxy pointed at
 * a recording proxy started here (every request to a host other than the
 * loopback goes through it; the Vite dev server and the backend on
 * 127.0.0.1 bypass it, as Chromium's implicit rules say):
 *   - the proxy wiring itself: a probe request the page makes to an outside
 *     host does reach the proxy (so "nothing seen" below means something);
 *   - no request for a dictionary: nothing to gvt1.com, googleapis.com or
 *     any google host reaches the proxy, and the main process recorded no
 *     'spellcheck-dictionary-download-begin' event;
 *   - on Linux / Windows: the shipped en-US dictionary was copied into the
 *     profile's Dictionaries directory (sha256 checked by the module) and
 *     Electron reported it initialized; on macOS the module did nothing
 *     (the system checker) and no Dictionaries directory appeared;
 *   - the checker flags a misspelling: a word typed into a textarea with
 *     real key events is reported as `misspelledWord` in the main process'
 *     'context-menu' event when it is right-clicked (the suggestions that come
 *     with it are logged; macOS may hand none in a fresh profile).
 *
 * On Linux the dictionaries must be in build/dictionaries (the fetch script
 * is run first; without network the misspelling check is SKIPped, the
 * no-download checks still run). SKIPs (exit 0) when the Electron app
 * cannot be launched (SKIP_ELECTRON_TESTS, no playwright-core, no GUI).
 *
 * Run: node tests/electron-spellcheck-live.test.mjs
 * Exit code 0 = all checks passed (or SKIP), 1 = failure (details on stdout).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { launchElectronApp, REPO, sleep } from './helpers/electron-app.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const HUNSPELL = process.platform === 'linux' || process.platform === 'win32';
const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'electron', 'spellcheck-dictionaries.json'), 'utf8'));

// ---------------------------------------------------------------- the recording proxy
const seen = [];
const proxy = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(502, { 'content-type': 'text/plain' }); res.end('refused by the test proxy'); });
proxy.on('connect', (req, socket) => { seen.push(`CONNECT ${req.url}`); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); });
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const proxyPort = proxy.address().port;

// ---------------------------------------------------------------- the dictionaries of a checkout (Linux / Windows)
let dictionariesReady = !HUNSPELL;
if (HUNSPELL) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'fetch-spellcheck-dictionaries.mjs')], { cwd: REPO, encoding: 'utf8' });
  dictionariesReady = r.status === 0;
  if (!dictionariesReady) console.log(`SKIP (misspelling check): build/dictionaries could not be fetched or verified - ${(r.stdout + r.stderr).trim().split('\n').pop()}`);
}

const launched = await launchElectronApp({ profilePrefix: 'electron-spellcheck-', args: [`--proxy-server=127.0.0.1:${proxyPort}`] });
if (launched.skip) {
  console.log(`SKIP: ${launched.skip}`);
  proxy.close();
  process.exit(0);
}
const { app, page, userDataDir, close } = launched;
try {
  // the module's record of what it did at start-up, from the main process
  const moduleFile = path.join(REPO, 'electron', 'spellcheck.cjs');
  const status = () => app.evaluate((_electron, file) => process.mainModule.require(file).status(), moduleFile);

  // the proxy wiring: a request the page makes to an outside host reaches the proxy
  await page.evaluate(() => fetch('http://proxy-probe.example/jacarium-spellcheck-test', { mode: 'no-cors' }).catch(() => null));
  for (let i = 0; i < 40 && !seen.some((s) => s.includes('proxy-probe.example')); i++) await sleep(250);
  check('the test proxy sees the renderer\'s requests to outside hosts (the wiring works)', seen.some((s) => s.includes('proxy-probe.example')), seen.join('; ') || 'nothing seen');

  // the dictionaries: initialised from the shipped files, nothing downloaded
  let state = await status();
  if (HUNSPELL) {
    for (let i = 0; i < 60 && !(state.initialized || []).includes('en-US'); i++) { await sleep(250); state = await status(); }
    check('Linux / Windows: the module ran, copied the shipped dictionaries into the profile and set the local download URL', state.active && state.downloadURL && state.downloadURL.startsWith('file:///') && state.targetDir === path.join(userDataDir, 'Dictionaries') && [...state.installed, ...state.kept].includes('en-US-10-1.bdic') === manifest.dictionaries.some((d) => d.file === 'en-US-10-1.bdic'), JSON.stringify(state));
    if (dictionariesReady) {
      check('Electron reported the en-US dictionary initialized from the profile copy', (state.initialized || []).includes('en-US') && fs.existsSync(path.join(userDataDir, 'Dictionaries', manifest.dictionaries.find((d) => d.language === 'en-US').file)), JSON.stringify(state));
      check('the languages in use are among the shipped ones', state.languages.length > 0 && state.languages.every((l) => manifest.dictionaries.some((d) => d.language === l)), state.languages.join(', '));
    }
  } else {
    check('macOS: the module did nothing (the system checker) and no Dictionaries directory appeared', state.active === false && !fs.existsSync(path.join(userDataDir, 'Dictionaries')), JSON.stringify(state));
  }
  check('no dictionary download began (spellcheck-dictionary-download-begin never fired)', (state.downloads || []).length === 0, JSON.stringify(state.downloads));

  // the checker: a misspelling typed with real key events is flagged
  const probeText = 'This sentense is typed here ';
  const word = 'sentense';
  let misspelling = { skip: HUNSPELL && !dictionariesReady };
  if (!misspelling.skip) {
    await page.evaluate(() => {
      const t = document.createElement('textarea');
      t.id = 'spellcheck-probe';
      t.spellcheck = true;
      t.setAttribute('lang', 'en-US');
      t.style.cssText = 'position:fixed;top:12px;left:12px;width:640px;height:90px;z-index:2147483647;font:24px monospace;padding:4px;border:1px solid #888;background:#fff;color:#000';
      document.body.appendChild(t);
    });
    await page.click('#spellcheck-probe');
    await page.keyboard.type(probeText, { delay: 20 });
    // Chromium checks the text once typing pauses (the idle checker); give it time, then
    // select the word and right-click inside the selection: the context-menu params
    // carry the misspelling under the cursor
    await sleep(2500);
    const point = await page.evaluate(({ text, w }) => {
      const t = document.getElementById('spellcheck-probe');
      const start = text.indexOf(w);
      t.focus();
      t.setSelectionRange(start, start + w.length);
      const canvas = document.createElement('canvas').getContext('2d');
      canvas.font = getComputedStyle(t).font;
      const r = t.getBoundingClientRect();
      const x = r.left + 4 + 1 + canvas.measureText(text.slice(0, start)).width + canvas.measureText(w).width / 2;
      return { x, y: r.top + 4 + 1 + 14 };
    }, { text: probeText, w: word });
    await app.evaluate(({ BrowserWindow }) => {
      global.__spellcheckProbe = null;
      for (const w of BrowserWindow.getAllWindows()) {
        w.webContents.on('context-menu', (_event, params) => { global.__spellcheckProbe = { misspelledWord: params.misspelledWord, suggestions: params.dictionarySuggestions, selectionText: params.selectionText }; });
      }
    });
    let params = null;
    for (let attempt = 0; attempt < 3 && !(params && params.misspelledWord); attempt++) {
      await page.mouse.click(point.x, point.y, { button: 'right' });
      for (let i = 0; i < 20 && !params; i++) { await sleep(150); params = await app.evaluate(() => global.__spellcheckProbe); }
      if (!(params && params.misspelledWord)) { await sleep(1500); params = null; await app.evaluate(() => { global.__spellcheckProbe = null; }); }
    }
    misspelling = { params };
    // (dictionarySuggestions come with it on Hunspell; macOS' checker may hand none in a fresh profile - logged, not asserted)
    check(`the checker flags "${word}" typed into a textarea (context-menu misspelledWord)`, params && params.misspelledWord === word && Array.isArray(params.suggestions), JSON.stringify(params));
  }

  // after all that, still nothing to a dictionary host
  await sleep(1000);
  state = await status();
  const dictionaryRequests = seen.filter((s) => /gvt1\.com|googleapis\.com|google\.com|\.bdic/i.test(s));
  check('no request to gvt1.com / googleapis.com / google.com (or for a .bdic) reached the proxy', dictionaryRequests.length === 0, dictionaryRequests.join('; ') || `${seen.length} request(s) seen, none for a dictionary`);
  check('and the main process still recorded no download attempt', (state.downloads || []).length === 0, JSON.stringify(state.downloads));
} catch (error) {
  check('the test ran to the end', false, error?.stack || String(error));
} finally {
  await close();
  proxy.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
