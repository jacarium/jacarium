#!/usr/bin/env node
/**
 * Links between documents - the [[doc:...]] directive (src/utils/docLinks.js,
 * rendered by src/utils/interactiveMarkdown.js, the PDF flattening in
 * src/utils/pdfExportNative.js, the /link slash entry in src/utils/slashCommands.js).
 *
 *   [[doc:<stableId>]]   [[doc:<stableId>|custom text]]   [[doc:Some title]]
 *
 * The real pipeline in jsdom (marked + the renderer + DOMPurify) with a
 * resolver over a documents list:
 *   1. the id form renders a link carrying the document's CURRENT title, with
 *      data-doc-link / data-doc-id for the preview's click handler, href "#"
 *      and nothing else; custom text replaces the title; a rename changes
 *      the text with no change to the markdown; a deleted / unknown id is a
 *      muted "Document not found" span with the raw label, no link;
 *   2. the title form resolves by exact title, case-insensitively and
 *      trimmed; two documents with the title make it ambiguous (a span that
 *      says so, no link); an unknown title is not found;
 *   3. escaping: a hostile title, a hostile custom text and a hostile ref
 *      end up as text (no element, no handler, no javascript: href); the
 *      id and label never leave the data attributes unescaped;
 *   4. the directive inside a ``` fence or inline `code` is printed as
 *      written; several links in a paragraph, a link inside a list item and
 *      a heading render in place; without a resolver every link is "not found";
 *   5. findDocLinks, docLinkContextAt (the picker's context: typing after
 *      "[[doc:", a closed title form to convert, nothing for the id form, a
 *      fence or inline code), searchDocuments (substring, case-insensitive,
 *      the current document excluded), docLinkDirective;
 *   6. flattenDocLinksForPdf turns the links into plain text spans and
 *      leaves the "not found" spans; the exporter calls it after the render
 *      and useImportExport hands the resolver in (static);
 *   7. the /link slash entry exists (action doclink, matched by "link" and
 *      "doc"), the editor maps it and offers Insert > Link to document, the
 *      spell-check skip covers the directive, DocumentsPage hands the list
 *      to both editors (static).
 *
 * Run:  node tests/markdown-doc-links.test.mjs
 * Preconditions: npm install; npm install --no-save jsdom fake-indexeddb
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDocumentsEnv, makeChecker, REPO } from './helpers/jsdom-documents-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { check, summary } = makeChecker();
const { mod, window } = await setupDocumentsEnv('markdown-doc-links', { entry: path.join(here, 'helpers', 'markdown-doc-links-entry.mjs') });
const { processInteractiveMarkdown, createDocLinkResolver, findDocLinks, docLinkContextAt, searchDocuments, docLinkDirective, isStableIdRef, flattenDocLinksForPdf, BLOCK_COMMANDS, BUILTIN_COMMANDS, matchesSlashQuery, isInsideCode } = mod;
const { document } = window;
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const C = '99999999-8888-4777-8666-555555555555';
const docs = [
  { id: 1, stableId: A, title: 'Day 1 - Real World DevSecOps Pipeline', category: 'Training' },
  { id: 2, stableId: B, title: 'Runbook', category: 'Ops' },
  { id: 3, stableId: C, title: 'runbook', category: 'Notes' },   // the same title as 2, another case
  { id: 4, stableId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', title: '<img src=x onerror=alert(1)> & "quotes"', category: 'General' },
];
const resolve = createDocLinkResolver(docs);
const render = (md, r = resolve) => { const div = document.createElement('div'); div.innerHTML = processInteractiveMarkdown(md, { resolveDocLink: r }); return div; };
const links = (root) => Array.from(root.querySelectorAll('a[data-doc-link]'));
const missing = (root) => Array.from(root.querySelectorAll('.doc-link-missing'));
const ambiguous = (root) => Array.from(root.querySelectorAll('.doc-link-ambiguous'));

console.log('\n--- 1. the id form ---');
let root = render(`Refer to [[doc:${A}]] first.`);
let a = links(root)[0];
check('the id form renders one link with the current title as its text', links(root).length === 1 && a.textContent === 'Day 1 - Real World DevSecOps Pipeline', root.innerHTML);
check('...carrying data-doc-link (the stable id) and data-doc-id (this device\'s record), href "#", a title, the doc-link class', a.getAttribute('data-doc-link') === A && a.getAttribute('data-doc-id') === '1' && a.getAttribute('href') === '#' && /Open Day 1/.test(a.getAttribute('title')) && a.classList.contains('doc-link'), a.outerHTML);
check('...and no other attribute (no inline handler, no target)', Array.from(a.attributes).map((x) => x.name).sort().join(',') === 'class,data-doc-id,data-doc-link,href,title', Array.from(a.attributes).map((x) => x.name).join(','));
check('the surrounding prose is kept, in one paragraph', root.querySelector('p') && /^Refer to .* first\.$/.test(root.querySelector('p').textContent), root.textContent);
root = render(`[[doc:${A}|the pipeline day]]`);
check('custom text replaces the title ([[doc:id|text]])', links(root)[0]?.textContent === 'the pipeline day' && links(root)[0].getAttribute('data-doc-link') === A, root.innerHTML);
const renamed = createDocLinkResolver(docs.map((d) => (d.id === 1 ? { ...d, title: 'Day 1 (renamed)' } : d)));
check('renamed: the same markdown shows the new title (no change to the text)', links(render(`[[doc:${A}]]`, renamed))[0].textContent === 'Day 1 (renamed)');
const deleted = createDocLinkResolver(docs.filter((d) => d.id !== 1));
root = render(`See [[doc:${A}]] and [[doc:${A}|my label]].`, deleted);
check('deleted / not on this device: a muted "Document not found" with the raw label, no link', links(root).length === 0 && missing(root).length === 2 && /Document not found:/.test(missing(root)[0].textContent) && missing(root)[0].textContent.includes(A) && missing(root)[1].textContent.includes('my label'), root.innerHTML);
check('...the span is inert: no href, no handler, role note, a title', missing(root).every((s) => s.tagName === 'SPAN' && !s.hasAttribute('href') && s.getAttribute('role') === 'note' && /not found/i.test(s.getAttribute('title'))));
check('the stable id is matched case-insensitively', links(render(`[[doc:${A.toUpperCase()}]]`)).length === 1);

console.log('\n--- 2. the title form ---');
root = render('Refer to [[doc:Day 1 - Real World DevSecOps Pipeline]]');
check('a title typed by hand resolves to the document (exact title)', links(root).length === 1 && links(root)[0].getAttribute('data-doc-link') === A, root.innerHTML);
check('...case-insensitively and trimmed', links(render('[[doc:  day 1 - real world devsecops pipeline ]]')).length === 1);
check('...with custom text too', links(render('[[doc:Day 1 - Real World DevSecOps Pipeline|day one]]'))[0]?.textContent === 'day one');
root = render('[[doc:Runbook]]');
check('two documents with the title: ambiguous - a span that says so, no link', links(root).length === 0 && ambiguous(root).length === 1 && /ambiguous: 2 documents/.test(ambiguous(root)[0].textContent) && ambiguous(root)[0].textContent.startsWith('Runbook'), root.innerHTML);
check('...with a title explaining it and no href', /2 documents are titled Runbook/.test(ambiguous(root)[0].getAttribute('title')) && !ambiguous(root)[0].hasAttribute('href'));
root = render('[[doc:No such document]]');
check('an unknown title: Document not found with the raw title', links(root).length === 0 && missing(root).length === 1 && missing(root)[0].textContent.includes('No such document'));

console.log('\n--- 3. escaping ---');
root = render('[[doc:dddddddd-dddd-4ddd-8ddd-dddddddddddd]]');
check('a hostile TITLE renders as text: no img, the text is the title, the title attribute is the escaped title', !root.querySelector('img') && links(root)[0].textContent === '<img src=x onerror=alert(1)> & "quotes"' && !/onerror/.test(links(root)[0].getAttribute('title') || '') === false && links(root)[0].getAttribute('title').includes('<img src=x onerror=alert(1)>'), root.innerHTML);
check('...and no element in the document fires anything (no onerror attribute anywhere)', !root.innerHTML.includes('onerror=alert') || !root.querySelector('[onerror]'), root.innerHTML);
root = render(`[[doc:${A}|"><img src=x onerror=alert(2)><script>alert(3)</script>]]`);
check('a hostile CUSTOM TEXT renders as text: no img, no script, the link text holds the characters', !root.querySelector('img') && !root.querySelector('script') && links(root).length === 1 && links(root)[0].textContent.includes('<img src=x onerror=alert(2)>'), root.innerHTML);
root = render('[[doc:javascript:alert(4)]]');
check('a hostile REF is a title lookup that fails: "not found" text, no element with a javascript: href', !root.querySelector('a') && !root.innerHTML.includes('href="javascript') && missing(root)[0].textContent.includes('javascript:alert(4)'), root.innerHTML);
root = render(`[[doc:${A}|<b>bold</b> text]]`);
check('markup in the custom text is text, not markup', !root.querySelector('a b') && links(root)[0].textContent === '<b>bold</b> text', root.innerHTML);
root = render(`<a href="javascript:alert(5)" data-doc-link="${A}" data-doc-id="1">x</a>`);
check('a hand-written link with a javascript: href is stripped by the sanitiser (the preview handler only ever sees data attributes)', !root.innerHTML.includes('javascript:'), root.innerHTML);

console.log('\n--- 4. placement ---');
root = render('```\n[[doc:' + A + ']]\n```\n\nand `[[doc:' + A + ']]` inline');
check('inside a fence and inline code the directive is printed as written', links(root).length === 0 && root.querySelector('pre code').textContent.includes(`[[doc:${A}]]`) && root.querySelector('p code').textContent === `[[doc:${A}]]`, root.innerHTML);
root = render(`~~~md\n[[doc:${A}]]\n~~~\nafter [[doc:${A}]]`);
check('a ~~~ fence too, and the text after the fence still renders a link', links(root).length === 1 && root.querySelector('pre code').textContent.includes('[[doc:'), root.innerHTML);
root = render(`- item [[doc:${A}]] and [[doc:${B}]]\n\n## Heading [[doc:${A}|see]]`);
check('several links in a list item and one in a heading render in place', root.querySelectorAll('li a[data-doc-link]').length === 2 && root.querySelector('h2 a[data-doc-link]')?.textContent === 'see', root.innerHTML);
root = render(`[[doc:${A}]]`, null);
check('without a resolver every link is "not found" (nothing is guessed)', links(root).length === 0 && missing(root).length === 1);
check('a directive spanning lines or with "]]" in its text is no directive', links(render(`[[doc:${A}\n]]`)).length === 0 && missing(render(`[[doc:${A}\n]]`)).length === 0);

console.log('\n--- 5. the helpers ---');
const found = findDocLinks(`x [[doc:${A}]] y [[doc:Runbook|r]] z`);
check('findDocLinks: positions, refs, labels, byId', found.length === 2 && found[0].from === 2 && found[0].to === 2 + `[[doc:${A}]]`.length && found[0].byId && found[0].ref === A && !found[1].byId && found[1].ref === 'Runbook' && found[1].label === 'r', JSON.stringify(found));
check('isStableIdRef: a UUID is, a title is not', isStableIdRef(A) && !isStableIdRef('Runbook') && !isStableIdRef(''));
let ctx = docLinkContextAt('Refer to [[doc:Day', 18, { isInsideCode });
check('docLinkContextAt: typing after "[[doc:" - the query so far, start at "[[", end at the caret, not closed', ctx && ctx.start === 9 && ctx.end === 18 && ctx.query === 'Day' && ctx.closed === false, JSON.stringify(ctx));
ctx = docLinkContextAt('Refer to [[doc:]] here', 15, { isInsideCode });
check('...just after "[[doc:" with the closing brackets already there: a closed, empty-title context to fill', ctx && ctx.closed && ctx.query === '' && ctx.end === 17, JSON.stringify(ctx));
ctx = docLinkContextAt('Refer to [[doc:Runbook]] here', 17, { isInsideCode });
check('...inside a closed title form: the title as the query, the whole directive as the range (to convert)', ctx && ctx.closed && ctx.query === 'Runbook' && ctx.start === 9 && ctx.end === 24, JSON.stringify(ctx));
check('...nothing for the id form, for a caret before "[[doc:", on another line, or without "[[doc:"', docLinkContextAt(`[[doc:${A}]]`, 10, { isInsideCode }) === null && docLinkContextAt('[[doc:x]]', 1, { isInsideCode }) === null && docLinkContextAt('[[doc:x\nabc', 9, { isInsideCode }) === null && docLinkContextAt('plain', 3, { isInsideCode }) === null);
check('...nothing inside a code fence or inline code', docLinkContextAt('```\n[[doc:Run', 13, { isInsideCode }) === null && docLinkContextAt('a `[[doc:Run', 12, { isInsideCode }) === null);
check('...nothing once a "|" separates custom text while typing (the picker would overwrite it)', docLinkContextAt('[[doc:Runbook|text', 18, { isInsideCode }) === null);
const hits = searchDocuments(docs, 'RUN', { excludeId: 2 });
check('searchDocuments: substring, case-insensitive, the current document excluded, title and category', hits.length === 1 && hits[0].stableId === C && hits[0].category === 'Notes', JSON.stringify(hits));
check('...an empty query lists everything (up to the limit), newest first as given', searchDocuments(docs, '').length === 4 && searchDocuments(docs, '', { limit: 2 }).length === 2);
check('docLinkDirective: the id form, with and without custom text', docLinkDirective(A) === `[[doc:${A}]]` && docLinkDirective(A, ' see ') === `[[doc:${A}|see]]`);

console.log('\n--- 6. the PDF ---');
root = render(`See [[doc:${A}]] and [[doc:${B}]] and [[doc:nope]].`);
const flattened = flattenDocLinksForPdf(root);
check('flattenDocLinksForPdf: the links become plain spans with the title, the "not found" span stays', flattened === 2 && links(root).length === 0 && root.querySelectorAll('span.doc-link-pdf').length === 2 && root.querySelector('span.doc-link-pdf').textContent === 'Day 1 - Real World DevSecOps Pipeline' && missing(root).length === 1, root.innerHTML);
const pdfNative = read('src/utils/pdfExportNative.js');
check('the native exporter renders with the resolver and flattens the links before layout', /processInteractiveMarkdown\(doc\.content \|\| '', \{ resolveDocLink \}\)/.test(pdfNative) && pdfNative.lastIndexOf('flattenDocLinksForPdf(container)') > pdfNative.indexOf("container.innerHTML = processInteractiveMarkdown") && pdfNative.lastIndexOf('flattenDocLinksForPdf(container)') < pdfNative.indexOf('await resolveAttachmentImages(container)'));
const importExport = read('src/hooks/useImportExport.js');
check('useImportExport builds the resolver from the documents metadata and hands it to the exporter', /createDocLinkResolver\(await getDocumentsMetadata\(\)\)/.test(importExport) && /exportDocumentToPDFNative\(freshDoc, \{[^}]*resolveDocLink/.test(importExport));

console.log('\n--- 7. the editor wiring (static) ---');
const linkCmd = BLOCK_COMMANDS.find((c) => c.id === 'block-doclink');
check('the /link slash entry: action doclink, built in, matched by "link" and "doc"', linkCmd && linkCmd.action === 'doclink' && linkCmd.builtin && matchesSlashQuery(linkCmd, 'link') && matchesSlashQuery(linkCmd, 'doc') && BUILTIN_COMMANDS.includes(linkCmd));
const editor = read('src/components/features/documents/DocumentEditor.jsx');
check('DocumentEditor maps doclink to the prompt, offers Insert > Link to document, renders the picker and opens a clicked link through onOpenDocumentById', /doclink: insertDocLinkPrompt/.test(editor) && /label: 'Link to document', onSelect: insertDocLinkPrompt/.test(editor) && /data-testid="doc-link-menu"/.test(editor) && /closest\('a\[data-doc-link\]'\)/.test(editor) && /onOpenDocumentById\(id\)/.test(editor));
check('the preview renders with the resolver built from linkableDocuments, and the editor surface gets it for the chips', /createDocLinkResolver\(linkableDocuments\)/.test(editor) && /renderPreviewHtml\(text, docLinkResolver\)/.test(editor) && /docLinkResolver=\{docLinkResolver\}/.test(editor));
const page = read('src/components/DocumentsPage.jsx');
check('DocumentsPage hands the documents list and the open-by-id path to both editors', (page.match(/linkableDocuments=\{documents\}/g) || []).length === 2 && (page.match(/onOpenDocumentById=\{openDocumentById\}/g) || []).length === 2);
const skip = read('src/components/features/documents/codemirror/spellcheckSkip.js');
check('the spell-check skip list covers the directive', /\\\[\\\[doc:/.test(skip));
const im = read('src/utils/interactiveMarkdown.js');
check('the renderer documents the directive with the others and renders it before marked', /\[\[doc:<stableId>\]\]/.test(im) && im.indexOf('renderDocLinks(processedText') < im.indexOf("Replace [[input:id:placeholder]]"));

summary();
