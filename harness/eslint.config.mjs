import js from '@eslint/js'
import { defineConfig, globalIgnores } from 'eslint/config'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import { builtinModules } from 'node:module'
import tseslint from 'typescript-eslint'

// The renderer runs in a sandboxed Chromium page with contextIsolation on and
// nodeIntegration off. It must talk to the main process only through the
// preload bridge, so importing Electron or Node built-ins there is an error.
const nodeBuiltins = builtinModules.filter((name) => !name.startsWith('_'))
const rendererForbiddenImports = {
  paths: [
    {
      name: 'electron',
      message: 'The renderer must not import Electron. Use the preload bridge on window instead.',
    },
    ...nodeBuiltins.map((name) => ({
      name,
      message: `The renderer must not import the Node built-in "${name}".`,
    })),
  ],
  patterns: [
    {
      group: ['node:*'],
      message: 'The renderer must not import Node built-ins.',
    },
    {
      group: ['../main/*', '../../main/*', '**/src/main/**', '**/src/preload/**'],
      message: 'The renderer may only share code through src/shared.',
    },
  ],
}

export default defineConfig([
  globalIgnores(['node_modules/', 'out/', 'dist/', 'release/']),
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    // Main process, preload, shared code, and project configs run under Node.
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts', '*.{ts,mts,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // Renderer code runs in the browser only.
    files: ['src/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    plugins: {
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-restricted-imports': ['error', rendererForbiddenImports],
    },
  },
])
