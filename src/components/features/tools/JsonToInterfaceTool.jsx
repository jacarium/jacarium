import { useState } from 'react';
import { Code, Copy, Check } from 'lucide-react';
// Deep-import only what we use instead of the 'quicktype-core' barrel: the
// barrel statically re-exports schema/postman input machinery and every
// target-language renderer, none of which this tool needs up front.
import { quicktype } from 'quicktype-core/dist/Run.js';
import { InputData, jsonInputForTargetLanguage } from 'quicktype-core/dist/input/Inputs.js';

// quicktype's convenience API resolves a language NAME string through its
// language/All registry, which eagerly bundles all 27 target-language
// renderers (~1MB minified). Instead we dynamically import only the one
// language module the user picked and pass quicktype a TargetLanguage
// INSTANCE, so each language becomes its own lazily-loaded chunk. The
// registry itself is stubbed out of the bundle in vite.config.js.
const targetLanguageLoaders = {
  typescript: () => import('quicktype-core/dist/language/TypeScriptFlow/index.js').then((m) => new m.TypeScriptTargetLanguage()),
  flow: () => import('quicktype-core/dist/language/TypeScriptFlow/index.js').then((m) => new m.FlowTargetLanguage()),
  ruby: () => import('quicktype-core/dist/language/Ruby/index.js').then((m) => new m.RubyTargetLanguage()),
  javascript: () => import('quicktype-core/dist/language/JavaScript/index.js').then((m) => new m.JavaScriptTargetLanguage()),
  rust: () => import('quicktype-core/dist/language/Rust/index.js').then((m) => new m.RustTargetLanguage()),
  kotlin: () => import('quicktype-core/dist/language/Kotlin/index.js').then((m) => new m.KotlinTargetLanguage()),
  dart: () => import('quicktype-core/dist/language/Dart/index.js').then((m) => new m.DartTargetLanguage()),
  python: () => import('quicktype-core/dist/language/Python/index.js').then((m) => new m.PythonTargetLanguage()),
  csharp: () => import('quicktype-core/dist/language/CSharp/index.js').then((m) => new m.CSharpTargetLanguage()),
  go: () => import('quicktype-core/dist/language/Golang/index.js').then((m) => new m.GoTargetLanguage()),
  cpp: () => import('quicktype-core/dist/language/CPlusPlus/index.js').then((m) => new m.CPlusPlusTargetLanguage()),
  java: () => import('quicktype-core/dist/language/Java/index.js').then((m) => new m.JavaTargetLanguage()),
  scala3: () => import('quicktype-core/dist/language/Scala3/index.js').then((m) => new m.Scala3TargetLanguage()),
  swift: () => import('quicktype-core/dist/language/Swift/index.js').then((m) => new m.SwiftTargetLanguage()),
  'objective-c': () => import('quicktype-core/dist/language/Objective-C/index.js').then((m) => new m.ObjectiveCTargetLanguage()),
  elm: () => import('quicktype-core/dist/language/Elm/index.js').then((m) => new m.ElmTargetLanguage()),
  'json-schema': () => import('quicktype-core/dist/language/JSONSchema/index.js').then((m) => new m.JSONSchemaTargetLanguage()),
  pike: () => import('quicktype-core/dist/language/Pike/index.js').then((m) => new m.PikeTargetLanguage()),
  'prop-types': () => import('quicktype-core/dist/language/JavaScriptPropTypes/index.js').then((m) => new m.JavaScriptPropTypesTargetLanguage()),
  haskell: () => import('quicktype-core/dist/language/Haskell/index.js').then((m) => new m.HaskellTargetLanguage()),
  php: () => import('quicktype-core/dist/language/Php/index.js').then((m) => new m.PhpTargetLanguage()),
};

export default function JsonToInterfaceTool() {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [interfaceName, setInterfaceName] = useState('MyInterface');
  const [language, setLanguage] = useState('typescript');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);

  const languages = [
    { value: 'typescript', label: 'TypeScript' },
    { value: 'ruby', label: 'Ruby' },
    { value: 'javascript', label: 'JavaScript' },
    { value: 'flow', label: 'Flow' },
    { value: 'rust', label: 'Rust' },
    { value: 'kotlin', label: 'Kotlin' },
    { value: 'dart', label: 'Dart' },
    { value: 'python', label: 'Python' },
    { value: 'csharp', label: 'C#' },
    { value: 'go', label: 'Go' },
    { value: 'cpp', label: 'C++' },
    { value: 'java', label: 'Java' },
    { value: 'scala3', label: 'Scala3' },
    { value: 'swift', label: 'Swift' },
    { value: 'objective-c', label: 'Objective-C' },
    { value: 'elm', label: 'Elm' },
    { value: 'json-schema', label: 'JSON Schema' },
    { value: 'pike', label: 'Pike' },
    { value: 'prop-types', label: 'JavaScript PropTypes' },
    { value: 'haskell', label: 'Haskell' },
    { value: 'php', label: 'PHP' }
  ];

  const handleGenerate = async (jsonInput, selectedLanguage, typeName) => {
    if (!jsonInput || !jsonInput.trim()) {
      setOutput('');
      setError('');
      return;
    }

    try {
      const parsed = JSON.parse(jsonInput);

      const targetLanguage = await targetLanguageLoaders[selectedLanguage]();

      const jsonInput2 = jsonInputForTargetLanguage(targetLanguage);
      await jsonInput2.addSource({
        name: typeName,
        samples: [JSON.stringify(parsed)],
      });

      const inputData = new InputData();
      inputData.addInput(jsonInput2);

      const result = await quicktype({
        inputData,
        lang: targetLanguage,
      });

      setOutput(result.lines.join('\n'));
      setError('');
    } catch (err) {
      setError('Invalid JSON or conversion error: ' + err.message);
      setOutput('');
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied('output');
      setTimeout(() => setCopied(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="h-full flex flex-col bg-os-background p-6">
      <div className="max-w-4xl mx-auto w-full space-y-4">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Code size={20} className="text-os-text-primary" />
          <h3 className="text-lg font-semibold text-os-text-primary">
            JSON to Interface
          </h3>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Target Language</label>
            <select
              value={language}
              onChange={(e) => { setLanguage(e.target.value); handleGenerate(input, e.target.value, interfaceName); }}
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            >
              {languages.map(lang => (
                <option key={lang.value} value={lang.value}>{lang.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm text-os-text-primary mb-2">Type/Class Name</label>
            <input
              type="text"
              value={interfaceName}
              onChange={(e) => { setInterfaceName(e.target.value); handleGenerate(input, language, e.target.value); }}
              placeholder="MyInterface"
              className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted text-sm focus:outline-hidden focus:ring-2 focus:ring-os-blue"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm text-os-text-primary mb-2">JSON Input</label>
          <textarea
            value={input}
            onChange={(e) => { setInput(e.target.value); handleGenerate(e.target.value, language, interfaceName); }}
            placeholder='{"name": "John", "age": 30}'
            className="w-full h-48 px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary placeholder:text-os-text-muted font-mono text-sm resize-none focus:outline-hidden focus:ring-2 focus:ring-os-blue"
          />
        </div>
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-sm text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-os-text-primary">
              {languages.find(l => l.value === language)?.label || 'Output'}
            </label>
            {output && (
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-2 py-1 text-xs text-os-text-secondary hover:text-os-text-primary transition-colors"
              >
                {copied === 'output' ? (
                  <>
                    <Check size={12} />
                    Copied!
                  </>
                ) : (
                  <>
                    Copy
                  </>
                )}
              </button>
            )}
          </div>
          {output ? (
            <pre className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm text-os-text-primary font-mono text-sm overflow-auto max-h-96 min-h-[200px]">
              {output}
            </pre>
          ) : (
            <div className="w-full px-3 py-2 bg-os-card border border-os-border rounded-sm flex items-center justify-center text-sm text-os-text-secondary min-h-[200px]">
              {languages.find(l => l.value === language)?.label || 'Output'} will appear here after entering JSON
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
