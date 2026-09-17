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
  // --------------------------------------------------------------------------
  // Layer guards. One block per guard, each naming the guard id from the plan so
  // a reader can find the reasoning; append new ones here rather than merging
  // them, because a merged block hides which rule is protecting what.
  // --------------------------------------------------------------------------
  {
    // G-1 (plan §2.3 OP-5, 부록 B-1). `src/connect/` is the only place that
    // looks for or spawns the system `ssh`, and it is a CLI-only exception to
    // this package's "pure JS, no OpenSSH needed" promise. The promise holds
    // only while the server path cannot reach that code, so the import is
    // refused here instead of being left to a convention a future edit would
    // not see. `src/doctor/` is deliberately absent from this list: it reports
    // `ssh` presence as INFO (G-4) and is not on the server path.
    files: ['src/server.ts', 'src/tools/**/*.ts', 'src/ssh/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/connect/*', '**/connect/**', './connect/*', '../connect/*'],
              message:
                'src/connect/ spawns the system ssh and is CLI-only (guard G-1). The server, its ' +
                'tools and the ssh2 transport must keep working on a machine with no OpenSSH, so ' +
                'they may not import it. Entry is the dynamic-import thunk in src/commands.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    // G-2 (plan §2.3 OP-3 row E1b, ADR-012, AC-J5a). `internalCommand()` is a
    // plain `string → ResolvedCommand` cast, so one call in a tool handler
    // would launder model input past the classifier, the approval gate and the
    // audit line — the precise hole the brand type exists to close. Its only
    // legitimate caller is the session reaper's `pkill` pair, so the import is
    // refused everywhere else. Tests are exempt because they mint commands by
    // the dozen; they use `tests/fixtures/resolved.ts`.
    //
    // Two deviations from the plan's sketch, both forced:
    //
    // 1. **`no-restricted-syntax`, not `no-restricted-imports`.** This block's
    //    scope ("everything except two paths") necessarily overlaps G-1's, and
    //    flat config *replaces* a rule's options rather than merging them — a
    //    second `no-restricted-imports` here would have silently switched G-1
    //    off for `src/tools/` and `src/ssh/`. The plan allows this rule as the
    //    alternative for exactly this kind of reason.
    // 2. **The name, not the module path.** Restricting the path would also
    //    block `resolveCommand`, which `src/tools/exec.ts` and
    //    `src/tools/runInSession.ts` must import. Matching the imported name is
    //    what keeps one export refused and the other allowed, and it survives
    //    the specifier changing with directory depth.
    files: ['**/*.ts'],
    ignores: ['src/ssh/session.ts', 'tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportSpecifier[imported.name='internalCommand']",
          message:
            'internalCommand() casts a raw string into ResolvedCommand and is for commands the ' +
            'server itself built (guard G-2). Using it on model input would skip classification, ' +
            'approval and the audit line. Tool handlers call resolveCommand() instead; tests use ' +
            'tests/fixtures/resolved.ts.',
        },
        {
          selector: 'ImportDeclaration[source.value=/resolve\\.js$/] > ImportNamespaceSpecifier',
          message:
            'A namespace import of src/output/resolve.js reaches internalCommand() and so goes ' +
            'around guard G-2. Import resolveCommand by name.',
        },
        {
          // `export { internalCommand as mint }` would otherwise hand the name
          // on under a spelling the import selector above never sees. The
          // plan's `importNames` form misses this too, so closing it here is
          // strictly more than was asked for — it costs one selector.
          selector: "ExportSpecifier[local.name='internalCommand']",
          message:
            'Re-exporting internalCommand() moves the escape hatch somewhere guard G-2 is not ' +
            'looking, whatever the new name is. It has one legitimate caller (the session ' +
            'reaper) and needs no second route.',
        },
      ],
    },
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
