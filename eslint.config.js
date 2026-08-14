// Flat config. Deliberately thin: the rules that matter here are the ones
// tsc already enforces, and a long rule list is a second opinion about the
// same code that drifts from the first.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
