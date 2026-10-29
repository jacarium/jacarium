import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
// 0.5: ESM only, the named `reactRefresh` export with its config presets as
// functions (the default export's objects remain for compatibility); the
// vite preset is only-export-components as an error with allowConstantExport
// and, new in 0.5.7, allowCompoundComponents (an object gathering components)
import { reactRefresh } from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // backend/venv is a Python virtualenv (vendored werkzeug debugger JS);
  // backend/dist and dist-electron are PyInstaller/electron-builder build
  // output, including a full packaged app bundle; backend/static/vendor is
  // third-party browser code copied from node_modules by
  // scripts/vendor-assets.mjs - none of it is our code.
  globalIgnores(['dist', '.claude', 'backend/venv', 'backend/dist', 'dist-electron', 'backend/static/vendor']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite(),
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    // jacarium-central is a plain Node/CommonJS backend, vite.config.js
    // runs under Node at build time, and scripts/ holds Node CLI utilities -
    // none is browser code, so they use require/module/process/__dirname
    // etc. that globals.browser doesn't declare (previously flagged as
    // hundreds of spurious no-undef errors).
    files: ['jacarium-central/**/*.js', 'vite.config.js', 'scripts/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // jacarium-central/public/*.js are static assets served directly to
    // game-client browsers (quiz/grid/tiles), loaded alongside a
    // <script src=".../socket.io.js"> tag - `io` is that script's global,
    // not something these files import.
    files: ['jacarium-central/public/**/*.js'],
    languageOptions: {
      globals: { io: 'readonly' },
    },
  },
  {
    // __BUILD_MODE__ is injected at build time via vite.config.js's `define`
    // (see DocumentEditor.jsx's usage) - a real global in the built app,
    // not an undeclared variable.
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      globals: { __BUILD_MODE__: 'readonly', __APP_TAGLINE__: 'readonly', __APP_HOMEPAGE__: 'readonly', __APP_REPOSITORY__: 'readonly', __APP_AUTHOR__: 'readonly', __APP_FUNDING__: 'readonly' },
    },
  },
])
