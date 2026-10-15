/**
 * Guards JsonToInterfaceTool's per-language quicktype-core deep imports
 * (src/components/features/tools/JsonToInterfaceTool.jsx).
 *
 * Background: the tool used to call quicktype({ lang: 'typescript' }) with a
 * name STRING, which routes through quicktype-core's language/All registry -
 * a module that eagerly instantiates all 27 target-language renderers and
 * bundled ~1.1 MB of dead renderer code into the tool's chunk. The fix passes
 * quicktype() a TargetLanguage INSTANCE built from a dynamic deep import of
 * exactly one language module (e.g. quicktype-core/dist/language/Golang),
 * with the registry stubbed out at build time in vite.config.js.
 *
 * That makes the tool depend on quicktype-core INTERNALS: dist file paths and
 * per-language class names that aren't covered by the package's public API
 * surface and can silently move in a version bump (the paths/classes are not
 * uniform - Go lives in language/Golang as GoTargetLanguage, 'typescript' and
 * 'flow' both live in language/TypeScriptFlow, etc.).
 *
 * What this test does:
 *  1. Extracts every dropdown language value and every targetLanguageLoaders
 *     entry (import path + class name) from the component source, so the test
 *     can never drift out of sync with the component.
 *  2. Asserts the two sets of language values match exactly.
 *  3. For every language: resolves the deep import against the installed
 *     quicktype-core, instantiates the class, and checks it is a working
 *     TargetLanguage (has a name and a renderer).
 *  4. For a sample of languages: runs the tool's exact generation code path
 *     (instance-based lang, deep Run/Inputs imports) end to end and checks
 *     the output contains the expected type declaration.
 *
 * Run: node tests/json-to-interface-quicktype-languages.test.mjs   (needs node_modules)
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(REPO_ROOT, 'package.json'));

const COMPONENT = path.join(
  REPO_ROOT,
  'src/components/features/tools/JsonToInterfaceTool.jsx'
);

let failures = 0;
function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

const src = readFileSync(COMPONENT, 'utf8');

// 1. dropdown values: { value: 'typescript', label: 'TypeScript' }
const dropdownValues = [...src.matchAll(/\{ value: '([^']+)', label: '[^']+' \}/g)].map(
  (m) => m[1]
);
check(
  dropdownValues.length >= 20,
  `extracted dropdown language values (${dropdownValues.length})`,
  'languages array not found in component - test regex needs updating'
);

// loader entries: value: () => import('quicktype-core/...').then((m) => new m.Class())
const loaderEntries = [
  ...src.matchAll(
    /^\s*'?([\w-]+)'?: \(\) => import\('(quicktype-core\/[^']+)'\)\.then\(\(m\) => new m\.(\w+)\(\)\),$/gm
  ),
].map((m) => ({ value: m[1], importPath: m[2], className: m[3] }));
check(
  loaderEntries.length >= 20,
  `extracted targetLanguageLoaders entries (${loaderEntries.length})`,
  'targetLanguageLoaders map not found in component - test regex needs updating'
);

// 2. every dropdown value has a loader and vice versa
const dropdownSet = new Set(dropdownValues);
const loaderSet = new Set(loaderEntries.map((e) => e.value));
check(
  dropdownValues.every((v) => loaderSet.has(v)),
  'every dropdown language has a loader',
  `missing loaders: ${dropdownValues.filter((v) => !loaderSet.has(v)).join(', ')}`
);
check(
  loaderEntries.every((e) => dropdownSet.has(e.value)),
  'every loader corresponds to a dropdown language',
  `orphan loaders: ${loaderEntries.filter((e) => !dropdownSet.has(e.value)).map((e) => e.value).join(', ')}`
);

// 3. each deep import resolves and instantiates a working TargetLanguage
for (const { value, importPath, className } of loaderEntries) {
  let ok = false;
  let detail = '';
  try {
    const mod = require(importPath);
    const Cls = mod[className];
    if (typeof Cls !== 'function') {
      detail = `${importPath} has no export ${className}`;
    } else {
      const instance = new Cls();
      ok = typeof instance.name === 'string' && typeof instance.renderGraphAndSerialize === 'function';
      if (!ok) detail = `new ${className}() is not a usable TargetLanguage`;
    }
  } catch (err) {
    detail = err.message;
  }
  check(ok, `loader resolves and instantiates: ${value} (${className})`, detail);
}

// 4. end-to-end generation through the component's exact code path
const { quicktype } = require('quicktype-core/dist/Run');
const { InputData, jsonInputForTargetLanguage } = require('quicktype-core/dist/input/Inputs');

async function generate(targetLanguage) {
  const jsonInput = jsonInputForTargetLanguage(targetLanguage);
  await jsonInput.addSource({
    name: 'MyInterface',
    samples: [JSON.stringify({ name: 'John', age: 30, tags: ['a'], nested: { x: 1.5 } })],
  });
  const inputData = new InputData();
  inputData.addInput(jsonInput);
  const result = await quicktype({ inputData, lang: targetLanguage });
  return result.lines.join('\n');
}

// Languages whose file path / class name mapping is least obvious, plus the
// default. Each expectation is the generated top-level type declaration.
const SAMPLES = [
  ['typescript', /export interface MyInterface/],
  ['python', /class MyInterface:/],
  ['go', /type MyInterface struct/],
  ['rust', /pub struct MyInterface/],
  ['objective-c', /@interface QTMyInterface/], // Objective-C renderer prefixes class names with QT
  ['prop-types', /MyInterface/], // was broken pre-fix: 'prop-types' is not a quicktype name string
];

for (const [value, expected] of SAMPLES) {
  const entry = loaderEntries.find((e) => e.value === value);
  if (!entry) {
    check(false, `generation sample: ${value}`, 'no loader entry extracted');
    continue;
  }
  try {
    const instance = new (require(entry.importPath)[entry.className])();
    const output = await generate(instance);
    check(
      expected.test(output),
      `generates ${value} output (${output.split('\n').length} lines)`,
      `output did not match ${expected}`
    );
  } catch (err) {
    check(false, `generates ${value} output`, err.message);
  }
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll JsonToInterfaceTool quicktype language checks passed');
