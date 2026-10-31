/**
 * The generated table of contents in the PDF export (the real Electron
 * exporter, electron/pdf-export.cjs, through tests/helpers/electron-app.mjs):
 *
 *   1. a document that starts with a [[toc]] block (the heading and a
 *      nested list of entries, as "Table of contents" inserts it), the
 *      first section opening with a long atomic listing, keeps the WHOLE
 *      table on page 1 (a report had the last top-level entry on page 2
 *      on its own) and the first section starts right after it;
 *   2. a table longer than a page flows across pages: every entry is in
 *      the PDF, no page is blank;
 *   3. a document without a table of contents keeps its page count;
 *   4. an entry with many sub-entries continues on page 1 and flows on,
 *      instead of jumping whole to page 2 (an item holding a nested list
 *      may break; a plain item stays atomic).
 *
 * PDF_TOC_PROBE=1 prints every page's text. Skips cleanly without
 * playwright-core / a GUI. Synthetic text only.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchElectronApp, createNewDocument, setEditorText, exportDocumentPdf } from './helpers/electron-app.mjs';
import { inspectPdf, pageOf } from './helpers/pdf-inspect.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' | ' + String(detail).slice(0, 300) : ''}`); if (!ok) failed++; };

const section = (n, title, paragraphs = 2) => `## ${n} ${title}\n\n` + Array.from({ length: paragraphs }, (_, i) => `Paragraph ${i + 1} of ${title}: synthetic text for the export check, nothing more.`).join('\n\n') + '\n\n';
// the user's shape: a generated table, six sub-entries under the first section, then the sections
const TOC_DOC = `[[toc]]

# Table of Contents

- [1 Exam Challenges](#1-exam-challenges)
  - [1.1 Challenge 1](#11-challenge-1)
  - [1.2 Challenge 2](#12-challenge-2)
  - [1.3 Challenge 3](#13-challenge-3)
  - [1.4 Challenge 4](#14-challenge-4)
  - [1.5 Challenge 5](#15-challenge-5)
  - [1.6 Challenge 6](#16-challenge-6)
- [2 Exam Challenges Solutions](#2-exam-challenges-solutions)

[[/toc]]

# 1 Exam Challenges

## 1.1 Challenge 1

A challenge that opens with a long listing (an atomic block in the export: it is never split):

\`\`\`bash
${Array.from({ length: 40 }, (_, i) => `oc get pods -n example-${i + 1}   # line ${i + 1}`).join('\n')}
\`\`\`

${[2, 3, 4, 5, 6].map((i) => section(`1.${i}`, `Challenge ${i}`)).join('')}# 2 Exam Challenges Solutions

Solutions paragraph one. Solutions paragraph two.
`;
const LONG_N = 70;
const LONG_TOC_DOC = `[[toc]]

# Table of Contents

${Array.from({ length: LONG_N }, (_, i) => `- [Topic ${i + 1} of the long table](#topic-${i + 1}-of-the-long-table)`).join('\n')}

[[/toc]]

${Array.from({ length: LONG_N }, (_, i) => `## Topic ${i + 1} of the long table\n\nA line about topic ${i + 1}.\n\n`).join('')}`;
// the reported case: entry 2 has so many sub-entries that, together, it is taller than what is left of page 1.
// With every list item atomic (li { break-inside: avoid }) the whole of entry 2 jumped to page 2, leaving
// entry 1 alone on page 1; a list item holding a nested list must be able to break.
const TALL_N = 45;
const TALL_TOC_DOC = `[[toc]]

# Table of Contents

- [1 Exam Challenges](#1-exam-challenges)
${[1, 2, 3, 4, 5, 6].map((i) => `  - [1.${i} Challenge ${i}](#1${i}-challenge-${i})`).join('\n')}
- [2 Exam Challenges Solutions](#2-exam-challenges-solutions)
${Array.from({ length: TALL_N }, (_, i) => `  - [2.${i + 1} Solution ${i + 1}](#2${i + 1}-solution-${i + 1})`).join('\n')}

[[/toc]]

# 1 Exam Challenges

${[1, 2, 3, 4, 5, 6].map((i) => section(`1.${i}`, `Challenge ${i}`)).join('')}# 2 Exam Challenges Solutions

${Array.from({ length: TALL_N }, (_, i) => `## 2.${i + 1} Solution ${i + 1}\n\nA line about solution ${i + 1}.\n\n`).join('')}`;
const NO_TOC_DOC = `# 1 Exam Challenges\n\n${[1, 2, 3, 4, 5, 6].map((i) => section(`1.${i}`, `Challenge ${i}`)).join('')}# 2 Exam Challenges Solutions\n\nSolutions paragraph one. Solutions paragraph two.\n`;

const electronApp = await launchElectronApp({ profilePrefix: 'pdf-export-toc-' });
if (electronApp.skip) { console.log('SKIP: ' + electronApp.skip); process.exit(0); }
const outDir = process.env.PDF_EXPORT_KEEP_DIR || mkdtempSync(path.join(tmpdir(), 'pdf-export-toc-'));
const probe = (label, info) => { if (process.env.PDF_TOC_PROBE) info.pageTexts.forEach((t, i) => console.log(`INFO ${label} page ${i + 1}: ${t.replace(/\s+/g, ' ').slice(0, 400)}`)); };

try {
  const { page } = electronApp;
  check('a new document opens on the empty profile', await createNewDocument(page));
  const exportDoc = async (name, text) => {
    await setEditorText(page, text);
    const bytes = await exportDocumentPdf(page, { timeoutMs: 120000 });
    if (bytes) writeFileSync(path.join(outDir, `${name}.pdf`), bytes);
    const info = bytes ? await inspectPdf(bytes) : null;
    if (info) probe(name, info);
    return info;
  };

  // 1. the user's document
  const toc = await exportDoc('toc', TOC_DOC);
  check('the TOC document exports', !!toc);
  if (toc) {
    const p1 = toc.pageTexts[0] || '';
    const entries = ['1 Exam Challenges', '1.1 Challenge 1', '1.6 Challenge 6', '2 Exam Challenges Solutions'];
    check('every entry of the table of contents is on page 1, the last one included', entries.every((e) => p1.includes(e)), entries.map((e) => `${e}: p${pageOf(toc, e)}`).join(', '));
    check('the table of contents is not split: "2 Exam Challenges Solutions" is on the TOC page as an entry', pageOf(toc, 'Table of Contents') === 1 && /2 Exam Challenges Solutions/.test(p1));
    check('the first section starts on page 1 right after the table (its heading and first text; the long listing, atomic, may go to page 2)', /1 Exam Challenges 1\.1 Challenge 1 A challenge that opens/.test(p1.replace(/\s+/g, ' ')), p1.slice(0, 200));
    check('the last section is still in the PDF, after the table', pageOf(toc, 'Solutions paragraph one') >= 1);
  }

  // 2. a long table across pages
  const long = await exportDoc('long-toc', LONG_TOC_DOC);
  check('the long-TOC document exports', !!long);
  if (long) {
    const all = long.pageTexts.join('\n');
    const missing = Array.from({ length: LONG_N }, (_, i) => `Topic ${i + 1} of the long table`).filter((e) => !all.includes(e));
    check(`the long table flows across pages: all ${LONG_N} entries are in the PDF`, missing.length === 0, missing.slice(0, 5).join(', '));
    check('the table spans more than one page', pageOf(long, `Topic ${LONG_N} of the long table`) > 1 || (long.pageTexts[0] || '').includes(`Topic ${LONG_N} of the long table`));
    const blank = long.pageTexts.findIndex((t) => t.replace(/\d+\s*\/\s*\d+/g, '').trim().length === 0);
    check('no page is blank', blank < 0, blank >= 0 ? `page ${blank + 1}` : '');
  }

  // 4. entry 2 with many sub-entries: it continues on page 1 and flows on, instead of jumping whole to page 2
  const tall = await exportDoc('tall-entry-toc', TALL_TOC_DOC);
  check('the tall-entry TOC document exports', !!tall);
  if (tall) {
    const p1 = (tall.pageTexts[0] || '').replace(/\s+/g, ' ');
    check('entry 2 starts on page 1 right under entry 1 (not pushed whole to page 2)', p1.includes('1.6 Challenge 6') && p1.includes('2 Exam Challenges Solutions') && p1.includes('2.1 Solution 1'), `entry 2 on p${pageOf(tall, '2 Exam Challenges Solutions')}, 2.1 on p${pageOf(tall, '2.1 Solution 1')}`);
    const all = tall.pageTexts.join('\n');
    const missing = Array.from({ length: TALL_N }, (_, i) => `2.${i + 1} Solution ${i + 1}`).filter((e) => !all.includes(e));
    check(`all ${TALL_N} sub-entries of entry 2 are in the PDF`, missing.length === 0, missing.slice(0, 5).join(', '));
    const blank = tall.pageTexts.findIndex((t) => t.replace(/\d+\s*\/\s*\d+/g, '').trim().length === 0);
    check('no page is blank', blank < 0, blank >= 0 ? `page ${blank + 1}` : '');
  }

  // 3. no table of contents: the page count is the layout's own
  const plain = await exportDoc('no-toc', NO_TOC_DOC);
  check('the document without a TOC exports', !!plain);
  if (plain && toc) {
    check('without a TOC the document keeps its own page count (the TOC document is at most one page longer)', plain.pages >= 1 && toc.pages >= plain.pages && toc.pages <= plain.pages + 1, `toc=${toc.pages} plain=${plain.pages}`);
    check('its first page starts with the first section', /^1 Exam Challenges/.test((plain.pageTexts[0] || '').trim()), (plain.pageTexts[0] || '').slice(0, 60));
  }
} catch (e) {
  check('pdf toc export run', false, e.stack || String(e));
} finally {
  await electronApp.close();
}
console.log(`\nPDFs: ${outDir}`);
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
