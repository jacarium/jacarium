/**
 * Guards the page-level code-splitting of the renderer bundle
 * (src/App.jsx + src/components/JQLBuilder.jsx).
 *
 * Background: every page component (DocumentsPage, ToolsPage, AIChatPage,
 * WorkflowBuilder, ...) used to be statically imported by JQLBuilder.jsx /
 * App.jsx, so the whole app shipped as ONE ~4.6 MB index-*.js that V8 had
 * to parse/compile at startup even for tabs never opened in a session.
 * The fix converts all ten page components to React.lazy(() => import(...))
 * behind Suspense boundaries, dropping the eager entry chunk to ~0.65 MB.
 * This is an Electron app - chunks load from local disk, so the win is
 * deferred parse/compile and lower memory for unopened tabs, not network
 * latency.
 *
 * What this test does:
 *  1. Runs a REAL `vite build` into a throwaway out-dir (the user's dist/
 *     is left untouched).
 *  2. Asserts each of the ten page components got its OWN distinct chunk
 *     (PageName-<hash>.js) - i.e. the lazy() calls were not defeated by
 *     some new static import of the same module elsewhere (Rollup silently
 *     folds the module back into the entry in that case).
 *  3. Asserts the entry chunk (index-*.js) stays under ENTRY_BUDGET bytes,
 *     catching a regression back toward the monolith.
 *  4. Asserts the cloud-sync WebSocket still connects at app start: the
 *     entry (src/main.jsx, a bootstrap that first asks who is signed in)
 *     imports the App chunk at startup, and that chunk must STATICALLY
 *     import the cloudWebSocket chunk (via the eagerly-loaded ChatContext /
 *     JQLBuilder startCloudSync() path), not lazily when the Kanban tab
 *     first opens.
 *  5. Asserts quicktype-core's per-language renderers stay split out of the
 *     JsonToInterfaceTool chunk: the tool passes quicktype() a TargetLanguage
 *     INSTANCE from a dynamic deep import and vite.config.js stubs the
 *     language/All registry, so each language is its own lazy chunk. The
 *     tool chunk was 1,397 KB with all 27 renderers bundled, ~266 KB after.
 *  6. Asserts mermaid (```mermaid diagrams in the Documents preview / PDF
 *     export) stays a lazy chunk: mermaid.core-*.js exists, nothing imports
 *     it statically, and neither the entry nor DocumentsPage contains its
 *     code. src/utils/mermaidDiagrams.js is the only import('mermaid').
 *
 * Run: node tests/bundle-code-splitting.test.mjs   (needs node_modules)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Entry was 4,614,579 bytes pre-split and 668,161 bytes post-split
// (2026-07). Generous headroom for normal growth; a re-monolith blows
// straight through it.
const ENTRY_BUDGET = 1_500_000;

// ToolsPage was 2,775 KB when src/utils/tools.js statically imported all 41
// tool components (quicktype-core alone is ~927 KB, prettier ~402 KB,
// node-forge ~281 KB). After converting them to React.lazy, the ToolsPage
// chunk is ~21 KB and each tool gets its own chunk. Generous headroom; a
// reintroduced static tool import blows straight through it.
const TOOLSPAGE_BUDGET = 400_000;

// The three heaviest single-tool dependencies must stay in their own
// lazy chunks, not fold back into ToolsPage/entry.
const EXPECTED_TOOL_CHUNKS = [
  'JsonToInterfaceTool', // quicktype-core
  'CsrGeneratorTool', // node-forge
  'HtmlFormatterTool', // prettier standalone + parsers
];

// JsonToInterfaceTool was 1,397,270 bytes when quicktype-core's language/All
// registry dragged every target-language renderer into the chunk; 265,813
// bytes once languages became per-language lazy chunks (2026-07). Generous
// headroom; re-bundling all renderers blows straight through it.
const JSONTOOL_BUDGET = 700_000;

// A sample of the per-language quicktype chunks that must exist as separate
// lazy chunks, reachable from JsonToInterfaceTool only via dynamic import().
const EXPECTED_QUICKTYPE_LANGUAGE_CHUNKS = ['TypeScriptFlow', 'Python', 'Golang', 'Rust'];

const EXPECTED_PAGE_CHUNKS = [
  'DocumentsPage',
  'CalendarsPage',
  'DiagnosticsPage',
  'SearchPage',
  'WorkflowBuilder',
  'ToolsPage',
  'KanbanPage',
  'TasksPage',
  'TaskReportsPage',
  'AIChatPage',
];

let failures = 0;
function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

if (!existsSync(path.join(REPO_ROOT, 'node_modules'))) {
  console.error('node_modules missing - run `npm install` first.');
  process.exit(1);
}

const outDir = mkdtempSync(path.join(tmpdir(), 'sc-split-build-'));
try {
  console.log('Building (vite build, throwaway out-dir)...');
  execFileSync('npx', ['vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  const assetsDir = path.join(outDir, 'assets');
  const jsFiles = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));

  // 1. one distinct chunk per lazy page
  for (const page of EXPECTED_PAGE_CHUNKS) {
    const chunk = jsFiles.find((f) => new RegExp(`^${page}-[\\w-]+\\.js$`).test(f));
    check(
      Boolean(chunk),
      `page chunk exists: ${page}`,
      'no separate chunk emitted - was a static import of this page reintroduced?'
    );
  }

  // 1b. heavy tools each get their own lazy chunk (utils/tools.js)
  for (const tool of EXPECTED_TOOL_CHUNKS) {
    const chunk = jsFiles.find((f) => new RegExp(`^${tool}-[\\w-]+\\.js$`).test(f));
    check(
      Boolean(chunk),
      `tool chunk exists: ${tool}`,
      'no separate chunk emitted - was a static import of this tool reintroduced in utils/tools.js?'
    );
  }

  // 1c. ToolsPage chunk stays small (tools are lazy, not bundled into it)
  const toolsPage = jsFiles.find((f) => /^ToolsPage-[\w-]+\.js$/.test(f));
  if (toolsPage) {
    const size = statSync(path.join(assetsDir, toolsPage)).size;
    check(
      size < TOOLSPAGE_BUDGET,
      `ToolsPage chunk under budget (${size.toLocaleString()} < ${TOOLSPAGE_BUDGET.toLocaleString()} bytes)`,
      'ToolsPage bundle grew back toward the all-tools monolith'
    );
  }

  // 1d. quicktype-core languages stay split out of JsonToInterfaceTool
  const jsonTool = jsFiles.find((f) => /^JsonToInterfaceTool-[\w-]+\.js$/.test(f));
  if (jsonTool) {
    const size = statSync(path.join(assetsDir, jsonTool)).size;
    check(
      size < JSONTOOL_BUDGET,
      `JsonToInterfaceTool chunk under budget (${size.toLocaleString()} < ${JSONTOOL_BUDGET.toLocaleString()} bytes)`,
      'quicktype language renderers folded back into the tool chunk - was the language/All stub in vite.config.js removed, or a string lang passed to quicktype()?'
    );

    const toolSrc = readFileSync(path.join(assetsDir, jsonTool), 'utf8');
    for (const lang of EXPECTED_QUICKTYPE_LANGUAGE_CHUNKS) {
      const chunk = jsFiles.find((f) => new RegExp(`^${lang}-[\\w-]+\\.js$`).test(f));
      check(
        Boolean(chunk),
        `quicktype language chunk exists: ${lang}`,
        'no separate chunk emitted - language got statically bundled'
      );
      if (chunk) {
        const escaped = chunk.replace('.', '\\.');
        check(
          new RegExp(`import\\("\\./${escaped}"\\)`).test(toolSrc) &&
            !new RegExp(`from\\s*["']\\./${escaped}["']`).test(toolSrc),
          `JsonToInterfaceTool loads ${lang} only via dynamic import()`,
          `${chunk} is statically imported by (or missing from) ${jsonTool}`
        );
      }
    }
  }

  // 1e. mermaid (```mermaid diagrams in the Documents preview / PDF export,
  // src/utils/mermaidDiagrams.js) is ~5 MB of lazy chunks that must be
  // reachable ONLY through a dynamic import(): no chunk anywhere in the
  // build may statically import mermaid's entry chunk, and neither the
  // entry nor DocumentsPage may contain mermaid's code. A document without
  // a diagram must never pay for it.
  const mermaidChunk = jsFiles.find((f) => /^mermaid\.core-[\w-]+\.js$/.test(f));
  check(
    Boolean(mermaidChunk),
    'mermaid chunk exists (mermaid.core-*.js)',
    'no separate mermaid chunk emitted - was mermaid statically imported somewhere?'
  );
  if (mermaidChunk) {
    const escaped = mermaidChunk.replace('.', '\\.');
    const staticRe = new RegExp(`from\\s*["']\\./${escaped}["']`);
    const dynamicRe = new RegExp(`import\\(["']\\./${escaped}["']\\)`);
    const staticImporters = [];
    const dynamicImporters = [];
    for (const f of jsFiles) {
      if (f === mermaidChunk) continue;
      const src = readFileSync(path.join(assetsDir, f), 'utf8');
      if (staticRe.test(src)) staticImporters.push(f);
      if (dynamicRe.test(src)) dynamicImporters.push(f);
    }
    check(
      staticImporters.length === 0,
      'no chunk statically imports the mermaid chunk',
      `statically imported by: ${staticImporters.join(', ')}`
    );
    check(
      dynamicImporters.length >= 1,
      `mermaid chunk is loaded via dynamic import() (${dynamicImporters.join(', ')})`,
      'nothing dynamically imports the mermaid chunk - is the diagram renderer still wired?'
    );
    const docsPage = jsFiles.find((f) => /^DocumentsPage-[\w-]+\.js$/.test(f));
    const entryChunk = jsFiles.find((f) => /^index-[\w-]+\.js$/.test(f));
    for (const f of [entryChunk, docsPage].filter(Boolean)) {
      const src = readFileSync(path.join(assetsDir, f), 'utf8');
      // "securityLevel" is mermaid's config key; our renderer only passes it
      // inside the lazily-loaded mermaidDiagrams chunk, never in these two.
      check(
        !/securityLevel/.test(src) && !/mermaidAPI/.test(src),
        `${f.replace(/-[\w-]+\.js$/, '')} chunk contains no mermaid code`,
        'mermaid got folded into an eager chunk'
      );
    }
  }

  // 2. entry chunk stays small
  const entry = jsFiles.find((f) => /^index-[\w-]+\.js$/.test(f));
  check(Boolean(entry), 'entry chunk (index-*.js) exists');
  if (entry) {
    const size = statSync(path.join(assetsDir, entry)).size;
    check(
      size < ENTRY_BUDGET,
      `entry chunk under budget (${size.toLocaleString()} < ${ENTRY_BUDGET.toLocaleString()} bytes)`,
      'entry bundle grew back toward the pre-split monolith'
    );

    // 3. cloudWebSocket still loads eagerly at startup. The entry
    // (src/main.jsx) is a small bootstrap that imports the App chunk
    // (App-*.js) the moment it knows who is signed in - at startup, not
    // when a tab opens - so the eager path is entry -> App chunk ->
    // cloudWebSocket; the App chunk must import it STATICALLY.
    const entrySrc = readFileSync(path.join(assetsDir, entry), 'utf8');
    const wsChunk = jsFiles.find((f) => /^cloudWebSocket-[\w-]+\.js$/.test(f));
    const appChunk = (entrySrc.match(/import\(["']\.\/(App-[\w-]+\.js)["']\)/) || [])[1] || null;
    const appSrc = appChunk ? readFileSync(path.join(assetsDir, appChunk), 'utf8') : '';
    check(Boolean(appChunk), 'the entry bootstrap imports the App chunk at startup', `no import("./App-*.js") in ${entry}`);
    if (wsChunk) {
      const staticImport = new RegExp(`from\\s*["']\\./${wsChunk.replace('.', '\\.')}["']`);
      check(
        staticImport.test(entrySrc) || staticImport.test(appSrc),
        'the App chunk statically imports the cloudWebSocket chunk (WebSocket still connects at app start)',
        `no static import of ${wsChunk} found in ${entry} or ${appChunk}`
      );
    } else {
      // No separate chunk means the module is inlined in the entry - also eager.
      check(
        /cloudWebSocket|connectWebSocket/.test(entrySrc + appSrc),
        'cloudWebSocket code present in the eager entry / App chunk (inlined)',
        'cloudWebSocket neither a statically-imported chunk nor inlined in the entry'
      );
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll bundle code-splitting checks passed');
