// The YAML highlighter the Diagnostics detail pages inline into their frame
// (src/components/DiagnosticsPage.jsx) and the standalone Flask dashboard
// loads from /static/vendor/ (scripts/vendor-assets.mjs): highlight.js's core
// with its json and yaml languages, as one classic script that defines window.hljs.
//
// highlight.js ships CommonJS modules (lib/core.js, lib/languages/*.js)
// and no browser build in the npm package, so the two sources are wrapped in
// a small module shim here instead of bundled: the same text serves both
// places, nothing is fetched from a CDN, and the frame (an isolated srcdoc
// context that inherits no globals) gets the highlighter as a render-blocking
// <script> like Chart.js. tests/no-remote-assets.test.mjs checks the sources
// carry no "</script" that would end the inline tag early.
export function wrapHighlightCommonJs(coreSource, languages) {
  const parts = [
    '(function () {',
    '  var hljs = (function () { var module = { exports: {} }; var exports = module.exports;',
    coreSource,
    '  ; return module.exports; })();',
  ];
  for (const [name, source] of Object.entries(languages)) {
    parts.push(
      '  hljs.registerLanguage(' + JSON.stringify(name) + ', (function () { var module = { exports: {} }; var exports = module.exports;',
      source,
      '  ; return module.exports; })());',
    );
  }
  parts.push('  window.hljs = hljs;', '})();');
  return parts.join('\n');
}
