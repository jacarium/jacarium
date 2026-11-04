/**
 * The custom spelling words through the REAL Electron app (a fresh profile,
 * tests/helpers/electron-app.mjs; the dictionary is the profile's): the
 * validated spellcheck bridge and the real export / import modules, served
 * by the Vite dev server the helper starts.
 *
 *   1. add a word through the bridge -> it is in listWords;
 *   2. collectExportData() (src/utils/exportDatabase.js, imported into the
 *      page) carries it in customWords;
 *   3. remove the word -> gone from listWords;
 *   4. runImport() of that export (merge mode) adds it back - the summary
 *      says 1 added - and listWords has it again; importing the same file
 *      once more adds nothing (1 already there);
 *   5. Settings > Editor shows the list and the Export / Import buttons;
 *      screenshots of the page in light and dark go to
 *      CUSTOM_WORDS_SHOTS_DIR (default: a temporary directory).
 *
 * The modules are imported from the dev server (/src/...), so with
 * LIVE_BUILD=production the round trip is SKIPped (the UI check still runs).
 * SKIPs (exit 0) when the app cannot be launched. Run:
 *   node tests/electron-custom-words-roundtrip.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchElectronApp, sleep } from './helpers/electron-app.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 400) : ''}`); if (!ok) failed++; };
const WORD = 'jacariumroundtrip';
const OTHER = 'zzjacariumother';

const launched = await launchElectronApp({ profilePrefix: 'electron-custom-words-' });
if (launched.skip) { console.log(`SKIP: ${launched.skip}`); process.exit(0); }
const { page, close } = launched;
try {
  const api = (method, ...args) => page.evaluate(([m, a]) => window.electronAPI.spellcheck[m](...a), [method, args]);

  // 1. two words in the profile's dictionary, through the validated import call (addWord is the
  // menu's: it takes only the word of the last right-click)
  const added = await api('importWords', [WORD, OTHER, 'two words', 'x'.repeat(65)]);
  let words = await api('listWords');
  check('1. importWords through the bridge puts the words in listWords and counts the invalid entries', added?.ok === true && added.added === 2 && added.skipped === 2 && words.includes(WORD) && words.includes(OTHER), JSON.stringify({ added, words }));
  const refused = await api('addWord', 'notthemenuword');
  check('1. addWord stays the menu\'s: a word that was not the last right-click\'s is refused', refused?.ok === false, JSON.stringify(refused));

  if (process.env.LIVE_BUILD === 'production') {
    console.log('SKIP (round trip): LIVE_BUILD=production serves no /src modules to import into the page');
  } else {
    // 2. the export carries it
    const exported = await page.evaluate(async () => {
      const { collectExportData } = await import('/src/utils/exportDatabase.js');
      const data = await collectExportData(() => {});
      return { customWords: data.customWords, keys: Object.keys(data) };
    });
    check('2. collectExportData() carries the dictionary as customWords { formatVersion: 1, words } (desktop)', exported.customWords?.formatVersion === 1 && exported.customWords.words.includes(WORD) && exported.keys.includes('customWords'), JSON.stringify(exported.customWords));

    // 3. the word is removed
    const removed = await api('removeWord', WORD);
    words = await api('listWords');
    check('3. removeWord takes it out of listWords', removed?.ok === true && !words.includes(WORD) && words.includes(OTHER), JSON.stringify(words));

    // 4. importing the export brings it back, merged
    const imported = await page.evaluate(async (customWords) => {
      const { runImport } = await import('/src/utils/importDatabase.js');
      // the export's other sections are empty here on purpose: only the words are under test
      const file = { version: '1.0', formatVersion: 2, documents: [], documentTemplates: [], jqlTemplates: [], engineTemplates: [], customWords };
      const first = await runImport(JSON.parse(JSON.stringify(file)), true);
      const again = await runImport(JSON.parse(JSON.stringify(file)), true);
      return { first: first.summary.customWords, again: again.summary.customWords };
    }, exported.customWords);
    words = await api('listWords');
    check('4. runImport() (merge) adds the missing word back: 1 added, the other one already there', imported.first?.created === 1 && imported.first.skipped === 1 && words.includes(WORD) && words.includes(OTHER), JSON.stringify({ summary: imported.first, words }));
    check('4. importing the same file again adds nothing: 0 added, 2 already there', imported.again?.created === 0 && imported.again.skipped === 2, JSON.stringify(imported.again));
  }

  // 5. Settings > Editor: the list and the two buttons, in both themes
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('openAppSettings', { detail: { tab: 'editor' } })));
  await page.waitForSelector('[data-testid="editor-section"]', { timeout: 15000 });
  await sleep(500);
  const ui = await page.evaluate(() => ({
    words: [...document.querySelectorAll('[data-testid="spellcheck-words"] span')].map((s) => s.textContent),
    exportButton: document.querySelector('[data-testid="spellcheck-words-export"]')?.textContent,
    importButton: document.querySelector('[data-testid="spellcheck-words-import"]')?.textContent,
    exportDisabled: document.querySelector('[data-testid="spellcheck-words-export"]')?.disabled,
  }));
  check('5. Settings > Editor lists the words and offers Export / Import custom words', ui.words.includes(OTHER) && ui.exportButton === 'Export custom words' && ui.importButton === 'Import custom words' && ui.exportDisabled === false, JSON.stringify(ui));
  const shots = process.env.CUSTOM_WORDS_SHOTS_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'custom-words-shots-'));
  fs.mkdirSync(shots, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
    await sleep(400);
    const modal = await page.$('[data-testid="settings-modal"]');
    await (modal || page).screenshot({ path: path.join(shots, `settings-editor-${theme}.png`) });
  }
  check('5. screenshots of the Editor page in light and dark', fs.existsSync(path.join(shots, 'settings-editor-light.png')) && fs.existsSync(path.join(shots, 'settings-editor-dark.png')), shots);
  console.log(`screenshots in ${shots}`);
} finally {
  await close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
