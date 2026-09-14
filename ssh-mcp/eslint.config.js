// ESLint flat config for ssh-mcp (ESLint 10 + typescript-eslint 8).
// Formatting is Prettier's job; this config covers correctness and safety rules only.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '.omc/**', '*.tgz'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Tool handlers legitimately accept unknown payloads; require explicit narrowing instead.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      // stdout is the JSON-RPC channel in server mode; only log.ts may touch console.
      'no-console': ['error', { allow: ['error'] }],
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // The logger, the CLIs (doctor writes its table to stdout by design) and tests may use console.
    files: [
      'src/log.ts',
      'src/doctor/**/*.ts',
      'src/setup/**/*.ts',
      'src/index.ts',
      'tests/**/*.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['*.config.ts', '*.config.js', 'eslint.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // CI helper scripts (not shipped — package.json `files` is dist/README/LICENSE). Plain ESM
    // run by `node`, so they need the Node globals the TS block above only grants to **/*.ts,
    // and they write their progress to stdout by design.
    files: ['scripts/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.node } },
    rules: { 'no-console': 'off' },
  }
);
