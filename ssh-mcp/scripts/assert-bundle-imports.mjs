// Asserts that the bundle's top-level imports cannot break on the oldest Node we support, and
// cannot load CLI-only code before an MCP server has even started.
//
// Why the first half exists. `dist/index.js` is one ESM file, and every `import` in it is
// resolved and linked before a single statement runs. A *named* import from a builtin is checked
// at that moment: if the running Node's builtin does not export that name, the process dies with
// `SyntaxError: The requested module 'util' does not provide an export named 'styleText'`.
// Not a caught error — the entry file never executes, so `--version`, `doctor`, the
// `MIN_NODE_MAJOR` guard and its "requires Node.js 20 or newer" message are all unreachable.
//
// It already happened: `import { styleText } from 'node:util'` in `src/setup/ask.ts` (added
// 2026-09-14 to colour a prompt's help line) broke `node dist/index.js --version` on Node
// 18.19.1 and would have broken every Node from 20.0 to 20.11, because `util.styleText`
// landed in 20.12. Dynamically importing the sub-commands does not help: the bundler hoists
// every static import of bundled code into the entry file regardless of where it was written.
//
// The rule this enforces: reach a version-gated builtin through the namespace at call time
// (`import util from 'node:util'`, then `util.styleText`), never through a named import.
// Default and namespace imports are always safe — they bind the module object itself and
// assert nothing about its contents — so only named imports are inspected.
//
// Why the second half exists. `@inquirer/select` and `@inquirer/input` are CLI-only and are kept
// out of the bundle via tsup.config.ts's `external` — they are not inlined, so `ask.ts` reaches
// them with `await import('@inquirer/select')` inside a function instead of a top-level import.
// The point is the same one as above: a top-level ESM import is always evaluated, no matter
// where in the file it is written or whether the branch that "uses" it ever runs. If `ask.ts`
// used a top-level `import select from '@inquirer/select'` instead, esbuild would hoist that
// import to the top of dist/index.js, and starting the MCP server — which never touches a
// prompt — would still require and evaluate the inquirer package on every launch. (`ssh2`,
// `@modelcontextprotocol/sdk` and `zod` are external too, but they are not CLI-only — the server
// needs them unconditionally, so a static top-level import of those is fine and expected.)
//
// This review also found the original version of this script did not actually check the second
// invariant: `if (builtin === null) continue` skipped every non-builtin specifier, so a top-level
// `import select from '@inquirer/select'` spliced into a bundle copy passed with exit 0. Run
// `node scripts/assert-bundle-imports.mjs --self-test` to see both regressions this script
// exists to catch actually get caught, not just documented.
//
// Runs as part of `npm run build`, because the thing it inspects is a build artifact.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
// scripts/assert-bundle-imports.mjs -> package root is one directory up. Resolving from the
// script's own location (not cwd) matters because `npm run build` sets cwd to this package, but
// nothing stops this file from being run directly from the monorepo root, where a cwd-relative
// 'dist/index.js' does not exist and used to die with a bare, unexplained ENOENT.
const PACKAGE_ROOT = dirname(dirname(SCRIPT_PATH));
const DEFAULT_BUNDLE = join(PACKAGE_ROOT, 'dist', 'index.js');

/**
 * Named imports from builtins that the bundle is allowed to make.
 *
 * Every name here must exist in the **oldest** Node the package claims to run on — that is
 * `MIN_NODE_MAJOR` in `src/index.ts`, currently 20, so read it as "present in Node 20.0.0".
 * Before adding a name, look up its "Added in:" line in the Node docs. If it arrived after
 * 20.0.0, it does not belong here: read it off the namespace at call time instead.
 */
const ALLOWED = {
  console: ['Console'],
  stream: ['Writable'],
  url: ['fileURLToPath'],
  child_process: ['spawnSync'],
  crypto: ['createHash', 'createHmac', 'randomBytes', 'timingSafeEqual'],
};

/**
 * Package name prefixes that must never appear as a top-level static import specifier in the
 * bundle, because they are CLI-only and kept out of it via tsup.config.ts's `external` — see the
 * file header. Keep this in sync with the `@inquirer/*` entries of `external` there; the other
 * externals (`ssh2`, `@modelcontextprotocol/sdk`, `zod`) are needed unconditionally by the server
 * and belong statically, so they are deliberately not listed here.
 */
const DISALLOWED_STATIC_PREFIXES = ['@inquirer/'];

/** `node:fs` and `fs` are the same module; the bundler may emit either spelling. */
function builtinName(specifier) {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return builtinModules.includes(bare) ? bare : null;
}

/**
 * The named bindings of one import statement, or `[]` for a default/namespace-only or bare
 * side-effect import (an empty string, since a bare import has no clause to pass in).
 *
 * `import fs, { readFileSync as read } from 'fs'` yields `['readFileSync']` — the local
 * alias is irrelevant, what the linker checks is the exported name.
 */
function namedImports(clause) {
  const braces = /\{([^}]*)\}/u.exec(clause);
  if (braces === null) return [];
  return braces[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.split(/\s+as\s+/u)[0].trim());
}

/**
 * Runs both invariants against bundle source text and reports the outcome. Spawned as a
 * subprocess by `--self-test` (see below) so the check runs exactly the way `npm run build`
 * runs it — that is what caught the `if (builtin === null) continue` bug: a check on the
 * exported pure logic would have missed it too, since the bug was in dispatch, not detection.
 */
async function checkBundle(bundlePath) {
  if (!existsSync(bundlePath)) {
    console.error(
      `${bundlePath}: not found. Run \`npm run build\` first — tsup has to produce the bundle ` +
        'before this check can inspect it.'
    );
    return false;
  }

  const source = readFileSync(bundlePath, 'utf8');
  // Top-level only: esbuild emits these at column 0, and an indented `import(` inside a
  // function is a dynamic import, which is evaluated when called and so cannot do this damage.
  //
  // The `from` clause is optional in the pattern so a bare side-effect-only `import 'specifier';`
  // (no bound name) is captured too — it cannot carry a named binding (JS grammar requires `from`
  // for that), so invariant 1 (named builtin imports) is unaffected either way, but invariant 2
  // (no static CLI-only import) cares about the specifier alone and must see this form: it is
  // exactly as evaluated on load as `import x from 'specifier'` would be. `clause` is `undefined`
  // when this branch matches; `namedImports` treats that the same as "no bindings".
  const statements = [...source.matchAll(/^import\s+(?:([^'"]*?)\s*from\s*)?["']([^"']+)["']/gmu)];

  if (statements.length === 0) {
    console.error(
      `${bundlePath}: no top-level imports found at all. Either the bundle is not built or its ` +
        'shape changed enough that this check is no longer reading it — fix the check.'
    );
    return false;
  }

  const offenders = [];
  const disallowedStatic = [];
  for (const [, clause, specifier] of statements) {
    if (DISALLOWED_STATIC_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
      disallowedStatic.push(specifier);
      continue; // not a builtin, and already reported — nothing more to check on this statement
    }
    const builtin = builtinName(specifier);
    if (builtin === null) continue;
    const allowed = ALLOWED[builtin] ?? [];
    for (const name of namedImports(clause ?? '')) {
      if (!allowed.includes(name)) offenders.push({ builtin, name, specifier });
    }
  }

  let ok = true;

  if (disallowedStatic.length > 0) {
    ok = false;
    console.error(`${bundlePath}: top-level static import of CLI-only package(s):`);
    for (const specifier of disallowedStatic) console.error(`  import ... from '${specifier}'`);
    console.error(
      '\nA top-level import is evaluated on every launch, including as an MCP server that never ' +
        'touches a prompt. Reach it with a dynamic import() inside the function that needs it ' +
        'instead (see src/setup/ask.ts).'
    );
  }

  if (offenders.length > 0) {
    ok = false;
    console.error(
      `${bundlePath}: top-level named imports from builtins that are not on the allow list:`
    );
    for (const { builtin, name, specifier } of offenders) {
      console.error(`  import { ${name} } from '${specifier}'   (${builtin}.${name})`);
    }
    console.error(
      '\nA named import is linked before any code runs, so a Node that lacks the name kills the ' +
        'whole CLI — server mode and the minimum-version message included — with a SyntaxError.\n' +
        "Reach it through the namespace instead (import util from 'node:util'; util.styleText), " +
        'guarding on `typeof`. If the name really has existed since Node 20.0.0, add it to ' +
        `ALLOWED in ${basename(SCRIPT_PATH)} with the version you checked.`
    );
  }

  if (!ok) return false;

  // Catches a typo or a removal in the list itself: an allowed name that does not exist here
  // would be waved through while failing for a user.
  //
  // Note the asymmetry with ALLOWED's own contract above ("exists in Node 20.0.0"): this loop
  // can only ask the Node that is running *right now*, not Node 20.0.0 itself. It proves a name
  // exists somewhere, not that it existed from the start — a name added between 20.0.0 and
  // whatever Node runs this would sail through here and still break on an older 20.x. That gap
  // is exactly how `util.styleText` (added in 20.12) got past a CI matrix pinned to "20" — see
  // scripts/AGENTS.md. Reading the Node docs' "Added in:" line stays the only real check.
  const stale = [];
  for (const [builtin, names] of Object.entries(ALLOWED)) {
    // Sequential await is fine here: ALLOWED has a handful of entries, not enough for the
    // round-trip cost of Promise.all to matter, and each iteration's errors read in order.
    const module = await import(`node:${builtin}`);
    for (const name of names) {
      if (!(name in module)) stale.push(`${builtin}.${name}`);
    }
  }
  if (stale.length > 0) {
    console.error(
      `ALLOWED lists names this Node (${process.version}) does not export: ${stale.join(', ')}. ` +
        'The list is wrong, or the name was removed — either way it must not stay.'
    );
    return false;
  }

  const checked = Object.entries(ALLOWED)
    .map(([builtin, names]) => `${builtin}: ${names.join(', ')}`)
    .join('; ');
  console.log(
    `${bundlePath}: ${String(statements.length)} top-level imports, no named builtin import ` +
      `outside the allow list (${checked}), no static CLI-only import`
  );
  return true;
}

/**
 * Proves the two regressions this script exists to catch are actually caught, not just
 * documented — including the one the check itself had: injecting a static `@inquirer/select`
 * import into a bundle copy used to pass with exit 0 (see the file header). Runs this same
 * script as a real subprocess against synthetic bundles in an OS temp directory, the same way
 * `npm run build` runs it against the real one, and checks the real exit code.
 */
function runSelfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'assert-bundle-imports-selftest-'));
  try {
    const cases = [
      {
        name: 'named import from a builtin not on the allow list (the util.styleText regression)',
        source:
          "import { Console } from 'node:console';\n" +
          "import { styleText } from 'node:util';\n" +
          'console.log(String(Console));\n',
        expectExit: 1,
      },
      {
        name: 'static top-level import of a CLI-only @inquirer package (the unchecked-continue regression)',
        source: "import select from '@inquirer/select';\nconsole.log(select);\n",
        expectExit: 1,
      },
      {
        name: 'bare side-effect-only import of a CLI-only @inquirer package (no `from` clause)',
        source: "import '@inquirer/select';\nconsole.log('probe');\n",
        expectExit: 1,
      },
      {
        name: 'clean bundle (sanity control — must still pass)',
        source: "import { Console } from 'node:console';\nconsole.log(String(Console));\n",
        expectExit: 0,
      },
    ];

    let failures = 0;
    for (const [index, testCase] of cases.entries()) {
      const bundlePath = join(dir, `case-${String(index)}.mjs`);
      writeFileSync(bundlePath, testCase.source);
      const result = spawnSync(process.execPath, [SCRIPT_PATH, bundlePath], { encoding: 'utf8' });
      const pass = result.status === testCase.expectExit;
      console.log(
        `${pass ? 'PASS' : 'FAIL'}  ${testCase.name} ` +
          `(expected exit ${String(testCase.expectExit)}, got ${String(result.status)})`
      );
      if (!pass) {
        failures += 1;
        if (result.stdout) console.log(result.stdout.trimEnd());
        if (result.stderr) console.log(result.stderr.trimEnd());
      }
    }

    if (failures > 0) {
      console.error(
        `assert-bundle-imports self-test: ${String(failures)}/${String(cases.length)} case(s) failed`
      );
      return false;
    }
    console.log(
      `assert-bundle-imports self-test: ${String(cases.length)}/${String(cases.length)} cases passed`
    );
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);

if (args[0] === '--self-test') {
  process.exit(runSelfTest() ? 0 : 1);
}

// A path argument is only ever passed by --self-test's own subprocess probes above; `npm run
// build` always calls this with no args and gets the real bundle next to this script.
const bundlePath = args[0] ?? DEFAULT_BUNDLE;
process.exit((await checkBundle(bundlePath)) ? 0 : 1);
