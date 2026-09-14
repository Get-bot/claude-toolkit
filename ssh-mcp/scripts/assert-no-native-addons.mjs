// Asserts that `npm install --omit=optional` really skipped every native addon, run from a
// freshly installed consumer directory by the `no-build-tools` CI job (PM-3, 7.3).
//
// Two checks, because they fail in different ways and neither subsumes the other:
//
//   1. No compiled addon anywhere under node_modules. This is the invariant that actually
//      matters — "a user without build tools installs this and nothing native gets built" — and
//      it is package-name independent, so it still holds when a transitive dependency (say
//      cpu-features' own `buildcheck`) is the one carrying the addon.
//   2. None of ssh2's optionalDependencies is present at all. A native package whose build
//      failed leaves no .node behind, so check 1 alone would call that a pass. The list is read
//      from the installed ssh2 rather than hardcoded so it follows ssh2's own declaration; an
//      empty list would make the check vacuous, so that fails too.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function findNativeAddons(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findNativeAddons(full, found);
    else if (entry.name.endsWith('.node')) found.push(full);
  }
  return found;
}

const addons = findNativeAddons('node_modules');
if (addons.length > 0) {
  console.error(`native addons were built despite --omit=optional:\n  ${addons.join('\n  ')}`);
  process.exit(1);
}

const ssh2 = JSON.parse(readFileSync('node_modules/ssh2/package.json', 'utf8'));
const optional = Object.keys(ssh2.optionalDependencies ?? {});
if (optional.length === 0) {
  console.error(
    `ssh2@${ssh2.version} declares no optionalDependencies — this check no longer proves anything. ` +
      'Point it at whatever carries the native addons now, or drop it.'
  );
  process.exit(1);
}

const installed = optional.filter((dep) => existsSync(`node_modules/${dep}`));
if (installed.length > 0) {
  console.error(
    `optional native dependencies were installed despite --omit=optional: ${installed.join(', ')}`
  );
  process.exit(1);
}

console.log(
  `no .node addons under node_modules; ssh2@${ssh2.version} optional deps skipped as expected: ${optional.join(', ')}`
);
