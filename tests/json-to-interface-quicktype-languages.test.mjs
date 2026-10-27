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
// the exact files: quicktype-core 26's exports map resolves deep paths literally (no directory index, no
// added extension), which is also why the component spells them this way
const { quicktype } = require('quicktype-core/dist/Run.js');
const { InputData, jsonInputForTargetLanguage } = require('quicktype-core/dist/input/Inputs.js');

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

// Every language the tool offers: the generated top-level type declaration,
// and - where quicktype-core 26 changed a language's defaults (its release
// notes: "modernize option defaults") - the marker of the new default, so the
// output the tool shows is pinned: C# System.Text.Json instead of
// Newtonsoft, Kotlin Jackson instead of Klaxon, C++17 std::optional instead
// of Boost, Java List<T> instead of arrays, Python @dataclass with PEP 585
// generics, Scala 3 circe derivation, Swift explicit CodingKeys, Dart final
// fields, Elm 0.19 with List, Haskell lists instead of Vector, Rust
// Debug/Clone derives and pub fields. TypeScript, Flow, Ruby, JavaScript, Go,
// Objective-C, JSON Schema, Pike and PropTypes are byte-identical to 23.
const SAMPLES = [
  ['typescript', /export interface MyInterface/],
  ['flow', /export type MyInterface = \{/],
  ['ruby', /class MyInterface < Dry::Struct/],
  ['javascript', /function toMyInterface\(json\)/],
  ['rust', /pub struct MyInterface/, /#\[derive\(Debug, Clone, Serialize, Deserialize\)\]/, /^\s+pub name: String,/m],
  ['kotlin', /data class MyInterface \(/, /jackson-module-kotlin/],
  ['dart', /class MyInterface \{/, /^\s+final String name;/m],
  ['python', /^class MyInterface:/m, /^@dataclass$/m, /-> list\[T\]:/],
  ['csharp', /public partial class MyInterface/, /using System\.Text\.Json;/, /\[JsonPropertyName\("name"\)\]/],
  ['go', /type MyInterface struct/],
  ['cpp', /class MyInterface \{/, /#include <optional>/],
  ['java', /public class MyInterface/, /private List<String> tags;/],
  ['scala3', /case class MyInterface \(/, /derives Encoder\.AsObject, Decoder/],
  ['swift', /struct MyInterface: Codable/, /enum CodingKeys: String, CodingKey/],
  ['objective-c', /@interface QTMyInterface/], // Objective-C renderer prefixes class names with QT
  ['elm', /type alias MyInterface/, /tags : List String/],
  ['json-schema', /"MyInterface"/, /"definitions"/],
  ['pike', /class MyInterface \{/],
  ['prop-types', /MyInterface/], // was broken pre-fix: 'prop-types' is not a quicktype name string
  ['haskell', /data MyInterface/, /tagsMyInterface :: \[Text\]/],
  ['php', /class MyInterface \{/],
];

// quicktype-core 26 ships an exports map that resolves deep paths literally,
// so the component names the exact files (dist/Run.js, dist/input/Inputs.js,
// dist/language/<Name>/index.js) and vite.config.js stubs the registry by
// its new names ("./language/All.js", "./language/index.js" from dist/index.js).
check(
  loaderEntries.every((e) => /^quicktype-core\/dist\/language\/[\w-]+\/index\.js$/.test(e.importPath)),
  'every loader deep-imports dist/language/<Name>/index.js (the exports-map shape)',
  loaderEntries.filter((e) => !/\/index\.js$/.test(e.importPath)).map((e) => e.importPath).join(', ')
);
check(
  src.includes("from 'quicktype-core/dist/Run.js'") && src.includes("from 'quicktype-core/dist/input/Inputs.js'"),
  'Run.js and input/Inputs.js are imported by their exact files'
);
const viteConfig = readFileSync(path.join(REPO_ROOT, 'vite.config.js'), 'utf8');
const allRe = viteConfig.match(/if \((\/.*?\/)\.test\(source\)\) return stubId/);
const barrelRe = viteConfig.match(/if \((\/.*?\/)\.test\(source\) && (\/.*?\/)\.test\(importer\)\)/);
const re = (m) => new RegExp(m.slice(1, -1));
check(
  allRe && re(allRe[1]).test('./language/All.js') && re(allRe[1]).test('../language/All.js') && !re(allRe[1]).test('./language.js'),
  "vite stub: the registry regex matches './language/All.js' and '../language/All.js' (26) but not a language's own './language.js'"
);
check(
  barrelRe && re(barrelRe[1]).test('./language/index.js') && re(barrelRe[1]).test('./language') && !re(barrelRe[1]).test('./language.js/x')
    && re(barrelRe[2]).test('/x/node_modules/quicktype-core/dist/index.js') && re(barrelRe[2]).test('/x/node_modules/quicktype-core/dist/esm/index.js')
    && !re(barrelRe[2]).test('/x/node_modules/quicktype-core/dist/language/Python/index.js'),
  "vite stub: the barrel regex matches './language/index.js' from dist/index.js (CJS and ESM) and nothing from a language module"
);

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
