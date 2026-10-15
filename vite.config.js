import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The Jira site the dev server proxies to: VITE_JIRA_URL (or JIRA_URL) from
// .env / the environment, an https:// origin without a path. There is no
// built-in default: unset, the proxy targets a name that does not resolve
// and src/services/jiraApi.js refuses the call with a message that names
// the setting. The packaged app and the browser deployment never use this
// proxy (Electron main process / backend/jira_proxy.py read JIRA_URL from
// Settings).
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const devEnv = loadEnv(process.env.NODE_ENV || 'development', process.cwd(), '')
const JIRA_URL = String(devEnv.VITE_JIRA_URL || devEnv.JIRA_URL || process.env.VITE_JIRA_URL || process.env.JIRA_URL || '').trim().replace(/\/+$/, '') || 'https://jira-url-not-configured.invalid'

// quicktype-core's Run.js and input/Inputs.js statically require the
// language/All registry (which eagerly instantiates all 27 target-language
// renderers, ~1MB minified, even when only one is used), and the package's
// top-level barrel re-exports the whole language/ directory the same way.
// JsonToInterfaceTool always passes quicktype a TargetLanguage INSTANCE
// (never a name string) and deep-imports the one language it needs, so the
// registry and the language barrel are dead code at runtime - but the
// bundler can't prove that because the requires are static. Replace both
// with a stub at build time so each language module can be code-split and
// loaded on demand by the tool's dynamic imports.
function stubQuicktypeLanguageRegistry() {
  const stubId = '\0quicktype-language-all-stub'
  return {
    name: 'stub-quicktype-language-registry',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !importer.includes('quicktype-core')) return
      // "./language/All" from dist/Run.js, "../language/All" from
      // dist/input/Inputs.js: the registry itself.
      if (/\/language\/All(\.js)?$/.test(source)) return stubId
      // "./language" from dist/index.js ONLY: the barrel of all language
      // modules. Must not match the per-language "./language" requires
      // (e.g. dist/language/Python/index.js -> ./language is that
      // language's own language.js, which the tool genuinely needs).
      if (/^\.\/language(\.js)?$/.test(source) && /quicktype-core[\\/]dist[\\/]index\.js$/.test(importer)) {
        return stubId
      }
    },
    load(id) {
      if (id === stubId) {
        return `
          export const all = [];
          export function languageNamed(name) {
            throw new Error('quicktype language registry is stubbed out of this bundle; pass a TargetLanguage instance instead of the name "' + name + '"');
          }
          export function isLanguageName() { return false; }
          export function isLanguageDisplayName() { return false; }
        `
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), stubQuicktypeLanguageRegistry()],
  base: './', // Use relative paths for Electron
  define: {
    // Inject build mode into the app (for testing vs production)
    '__BUILD_MODE__': JSON.stringify(process.env.BUILD_MODE || 'production'),
    // The brand's words, from package.json (src/brand/brand.js reads them):
    // one sentence everywhere the app describes itself.
    '__APP_TAGLINE__': JSON.stringify(pkg.description || ''),
    '__APP_HOMEPAGE__': JSON.stringify(pkg.homepage || ''),
    '__APP_REPOSITORY__': JSON.stringify(pkg.repository?.url || ''),
    '__APP_FUNDING__': JSON.stringify([].concat(pkg.funding || []).map((f) => (typeof f === 'string' ? f : f.url)).filter(Boolean)),
    '__APP_AUTHOR__': JSON.stringify({ name: pkg.author?.name || '', url: pkg.author?.url || '' }),
  },
  build: {
    // Disable minification for testing builds to get readable error messages
    minify: process.env.BUILD_MODE === 'testing' ? false : 'esbuild',
    sourcemap: process.env.BUILD_MODE === 'testing' ? true : false,
  },
  esbuild: {
    // Only remove console.* and debugger in production builds
    drop: process.env.BUILD_MODE === 'production' ? ['console', 'debugger'] : [],
  },
  server: {
    proxy: {
      '/rest/api/3': {
        target: JIRA_URL,
        changeOrigin: true,
        secure: false,
        headers: {
          'Connection': 'keep-alive',
        },
      },
      '/rest/api/2': {
        target: JIRA_URL,
        changeOrigin: true,
        secure: false,
        headers: {
          'Connection': 'keep-alive',
        },
      },
      '/rest/api/latest': {
        target: JIRA_URL,
        changeOrigin: true,
        secure: false,
        headers: {
          'Connection': 'keep-alive',
        },
      },
      '/api': {
        target: `${JIRA_URL}/rest/api/3`,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        secure: false,
        headers: {
          'Connection': 'keep-alive',
        },
      },
      '/parse-api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/parse-api/, ''),
      },
    },
  },
})
