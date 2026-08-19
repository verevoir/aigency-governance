// Flat config. Deliberately thin: the rules that matter here are the ones
// tsc already enforces, and a long rule list is a second opinion about the
// same code that drifts from the first.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Node's own globals, named directly here rather than pulled in via a
// `globals` package this repository does not otherwise depend on. `.mjs`
// files here (scripts/, eval/) are plain Node scripts — never bundled,
// never run in a browser — so `no-undef` needs to be told what runtime
// they actually run in. Without this, every Node global (`fetch`,
// `setTimeout`, ...) reads as an undeclared identifier: a config gap, not a
// defect in the code that uses them. Fixed here, once, so every future
// `.mjs` script gets it for free instead of hitting the same wall in turn —
// named directly because eval/sweep.mjs is already known to need both
// `fetch` and `setTimeout`, the same two names scripts/_diag-hypothesis.mjs
// was failing on.
const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  globalThis: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'readonly',
  require: 'readonly',
};

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: nodeGlobals,
    },
  },
);
