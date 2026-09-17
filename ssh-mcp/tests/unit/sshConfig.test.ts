/**
 * Reading a `Host` block out of `ssh_config` (`src/setup/sshConfig.ts`).
 *
 * What is being proven here is mostly **refusal**. The parser feeds a flow that
 * installs our public key on whatever machine the values name, so every case
 * where OpenSSH's answer and ours could differ has to end in
 * `config_unsupported` rather than in three-quarters of an import (AC-S3, risk
 * R35). The cases that succeed are the narrow ones: an exact literal `Host`
 * match, `Include` one level deep, and nothing else in the file that could
 * redirect the connection.
 *
 * The file system is real, not stubbed, for one specific reason: the `Include`
 * glob must work on Node 20, where `fs.globSync` does not exist. A test with an
 * injected `readDir` would pass against either implementation, so the glob
 * cases go through `fs.readdirSync` on actual directories — and the last test
 * in the file refuses to let `globSync` back into the source at all.
 *
 * `createTmpHome()` points `HOME`/`USERPROFILE` at a sandbox, so
 * `~/.ssh/config` resolves inside it and the default path resolution is
 * exercised rather than bypassed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SSH_CONFIG_ENV,
  expandIncludeGlob,
  readSshConfigHost,
  sshConfigPath,
  tokenizeValue,
} from '../../src/setup/sshConfig.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

let home: TmpHome;

beforeEach(() => {
  home = createTmpHome('ssh-mcp-sshconfig-');
  delete process.env[SSH_CONFIG_ENV];
});

afterEach(() => {
  delete process.env[SSH_CONFIG_ENV];
  assertNoWritesOutside(home);
  home.cleanup();
});

/** Write `~/.ssh/config` inside the sandbox and return its path. */
function writeConfig(text: string): string {
  const dir = path.join(home.dir, '.ssh');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config');
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

/** Write another file under `~/.ssh/`, for the `Include` cases. */
function writeSshFile(relative: string, text: string): string {
  const file = path.join(home.dir, '.ssh', relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

describe('sshConfigPath', () => {
  it('defaults to ~/.ssh/config', () => {
    expect(sshConfigPath()).toBe(path.join(home.dir, '.ssh', 'config'));
  });

  it('is redirected by SSH_MCP_SSH_CONFIG', () => {
    const elsewhere = path.join(home.dir, 'other-config');
    process.env[SSH_CONFIG_ENV] = elsewhere;
    expect(sshConfigPath()).toBe(elsewhere);
  });
});

describe('tokenizeValue', () => {
  it('keeps a quoted value in one piece', () => {
    expect(tokenizeValue('web01 web02')).toEqual(['web01', 'web02']);
    expect(tokenizeValue('"my server" web01')).toEqual(['my server', 'web01']);
    // An empty quoted string is a token: `User ""` is not the same as no User.
    expect(tokenizeValue('""')).toEqual(['']);
  });
});

describe('exact-name matching (AC-S1)', () => {
  it('reads HostName, Port and User out of the named block', () => {
    writeConfig(
      [
        'Host other',
        '  HostName other.example.com',
        '',
        'Host web01',
        '  HostName web01.internal',
        '  Port 2222',
        '  User deploy',
      ].join('\n')
    );
    const found = readSshConfigHost('web01');
    expect(found.ok).toBe(true);
    expect(found.ok && found.host).toEqual({
      alias: 'web01',
      hostname: 'web01.internal',
      port: 2222,
      user: 'deploy',
      identityIgnored: false,
    });
  });

  it('falls back to the Host name when the block sets no HostName', () => {
    writeConfig(['Host bastion', '  User root'].join('\n'));
    const found = readSshConfigHost('bastion');
    expect(found.ok && found.host.hostname).toBe('bastion');
    expect(found.ok && found.host.port).toBeNull();
    expect(found.ok && found.host.user).toBe('root');
  });

  it('accepts key=value, ignores case and strips comments', () => {
    writeConfig(
      [
        '# a comment line',
        'HOST web01   # trailing comment',
        '  hostname=web01.internal',
        '  PORT = 2022',
        '  user   deploy',
      ].join('\n')
    );
    const found = readSshConfigHost('web01');
    expect(found.ok && found.host).toMatchObject({
      hostname: 'web01.internal',
      port: 2022,
      user: 'deploy',
    });
  });

  it('keeps the first value for a keyword, as OpenSSH does', () => {
    writeConfig(['Host web01', '  User first', '  User second'].join('\n'));
    expect(readSshConfigHost('web01').ok && readSshConfigHost('web01').ok).toBe(true);
    const found = readSshConfigHost('web01');
    expect(found.ok && found.host.user).toBe('first');
  });

  it('does not match a name a wildcard block would have covered', () => {
    // AC-S1 is exact-literal only. `web*` is not a match, and because that
    // block sets nothing we import, it is not a refusal either — it is simply
    // not our block.
    writeConfig(['Host web*', '  ServerAliveInterval 60'].join('\n'));
    const found = readSshConfigHost('web01');
    expect(found.ok).toBe(false);
    expect(!found.ok && found.reason).toBe('config_host_not_found');
  });

  it('reports a missing file as such, not as a missing host', () => {
    const found = readSshConfigHost('web01');
    expect(!found.ok && found.reason).toBe('config_missing');
  });

  it('refuses a Port that is not a usable number', () => {
    writeConfig(['Host web01', '  Port 0'].join('\n'));
    expect(readSshConfigHost('web01').ok).toBe(false);
    const found = readSshConfigHost('web01');
    expect(!found.ok && found.reason).toBe('config_invalid');
  });
});

describe('Include, one level deep (AC-S2)', () => {
  it('follows a plain relative Include against ~/.ssh', () => {
    writeSshFile('extra', ['Host web01', '  HostName web01.internal', '  User deploy'].join('\n'));
    writeConfig('Include extra');
    const found = readSshConfigHost('web01');
    expect(found.ok && found.host).toMatchObject({
      hostname: 'web01.internal',
      user: 'deploy',
    });
  });

  it('expands a glob with readdirSync, which is all Node 20 has', () => {
    // `fs.globSync` landed in Node 22 and `engines` still allows ^20.17.0, so
    // this case runs against real directories to prove the hand-rolled matcher
    // is what does the work.
    writeSshFile(path.join('conf.d', '10-web.conf'), 'Host web01\n  HostName from-glob\n');
    writeSshFile(path.join('conf.d', '20-db.conf'), 'Host db01\n  HostName db.internal\n');
    writeSshFile(path.join('conf.d', 'notes.txt'), 'Host web01\n  HostName wrong\n');
    writeConfig('Include conf.d/*.conf');

    const found = readSshConfigHost('web01');
    expect(found.ok && found.host.hostname).toBe('from-glob');
    expect(readSshConfigHost('db01').ok).toBe(true);
  });

  it('expands ~ in an Include path', () => {
    writeSshFile('tilde.conf', 'Host web01\n  HostName from-tilde\n');
    writeConfig('Include ~/.ssh/tilde.conf');
    const found = readSshConfigHost('web01');
    expect(found.ok && found.host.hostname).toBe('from-tilde');
  });

  it('takes several paths from one Include line', () => {
    writeSshFile('a.conf', 'Host a\n  HostName a.internal\n');
    writeSshFile('b.conf', 'Host b\n  HostName b.internal\n');
    writeConfig('Include a.conf b.conf');
    expect(readSshConfigHost('a').ok && readSshConfigHost('a').ok).toBe(true);
    const b = readSshConfigHost('b');
    expect(b.ok && b.host.hostname).toBe('b.internal');
  });

  it('keeps an Include inside a Host block inside that block', () => {
    // Appending the included directives at the end instead of expanding them in
    // place would move `User deploy` into whichever block came last.
    writeSshFile('user.conf', 'User deploy\n');
    writeConfig(
      ['Host web01', '  HostName web01.internal', '  Include user.conf', '', 'Host other'].join(
        '\n'
      )
    );
    const found = readSshConfigHost('web01');
    expect(found.ok && found.host.user).toBe('deploy');
  });

  it('ignores a second-level Include and says so on one line', () => {
    writeSshFile('level1', ['Include level2', 'Host web01', '  User one'].join('\n'));
    writeSshFile('level2', ['Host web01', '  HostName should-not-be-read'].join('\n'));
    writeConfig('Include level1');

    const found = readSshConfigHost('web01');
    expect(found.ok).toBe(true);
    // The nesting was skipped, so the depth-2 HostName is absent and the Host
    // name stands in for it.
    expect(found.ok && found.host.hostname).toBe('web01');
    expect(found.warnings).toHaveLength(1);
    expect(found.warnings[0]).toContain('Include');
    expect(found.warnings[0]).toContain('1단계');
  });

  it('warns rather than failing when an included file is unreadable', () => {
    writeConfig(['Include missing.conf', 'Host web01', '  User deploy'].join('\n'));
    const found = readSshConfigHost('web01');
    expect(found.ok && found.host.user).toBe('deploy');
    expect(found.warnings.join('\n')).toContain('missing.conf');
  });
});

describe('constructs we refuse outright (AC-S3)', () => {
  it('refuses a target block whose Host list also carries a pattern', () => {
    writeConfig(['Host web01 web*', '  HostName web01.internal'].join('\n'));
    const found = readSshConfigHost('web01');
    expect(!found.ok && found.reason).toBe('config_unsupported');
    expect(!found.ok && found.message).toContain('config_unsupported');
  });

  it('refuses a negated pattern in the target block', () => {
    writeConfig(['Host web01 !web01', '  HostName web01.internal'].join('\n'));
    expect(readSshConfigHost('web01').ok).toBe(false);
  });

  it.each(['ProxyJump bastion', 'ProxyCommand ssh -W %h:%p bastion'])(
    'refuses %j in the target block',
    (line) => {
      writeConfig(['Host web01', '  HostName web01.internal', `  ${line}`].join('\n'));
      const found = readSshConfigHost('web01');
      expect(!found.ok && found.reason).toBe('config_unsupported');
    }
  );

  it('refuses a wildcard block that also sets one of the values we import', () => {
    // OpenSSH takes the *first* value it obtains, so this `User` would win over
    // the exact block's. We do not implement that ordering, so we refuse.
    writeConfig(['Host *', '  User git', '', 'Host web01', '  HostName web01.internal'].join('\n'));
    const found = readSshConfigHost('web01');
    expect(!found.ok && found.reason).toBe('config_unsupported');
    expect(!found.ok && found.message).toContain('Host *');
  });

  it('ignores a wildcard block that cannot change any of them', () => {
    // `Host *` with keepalive settings is in a large share of real configs, and
    // refusing those would make the flag useless for no safety gain.
    writeConfig(
      [
        'Host *',
        '  ServerAliveInterval 60',
        '  AddKeysToAgent yes',
        '',
        'Host web01',
        '  HostName web01.internal',
        '  User deploy',
      ].join('\n')
    );
    const found = readSshConfigHost('web01');
    expect(found.ok && found.host).toMatchObject({ hostname: 'web01.internal', user: 'deploy' });
  });

  it('ignores a wildcard block that does not cover the requested name', () => {
    writeConfig(
      ['Host db*', '  User postgres', '', 'Host web01', '  HostName web01.internal'].join('\n')
    );
    expect(readSshConfigHost('web01').ok).toBe(true);
  });

  it('refuses a Match block that sets one of those values, whatever its condition', () => {
    writeConfig(
      ['Host web01', '  HostName web01.internal', '', 'Match host db*', '  User postgres'].join(
        '\n'
      )
    );
    const found = readSshConfigHost('web01');
    expect(!found.ok && found.reason).toBe('config_unsupported');
    expect(!found.ok && found.message).toContain('Match');
  });

  it('ignores a Match block that sets nothing we read', () => {
    writeConfig(
      ['Host web01', '  HostName web01.internal', '', 'Match all', '  ForwardAgent yes'].join('\n')
    );
    expect(readSshConfigHost('web01').ok).toBe(true);
  });

  it('refuses a global preamble that sets one of those values', () => {
    writeConfig(['User git', '', 'Host web01', '  HostName web01.internal'].join('\n'));
    const found = readSshConfigHost('web01');
    expect(!found.ok && found.reason).toBe('config_unsupported');
  });

  it('returns no values at all when it refuses', () => {
    writeConfig(
      ['Host web01', '  HostName web01.internal', '  Port 2222', '  ProxyJump bastion'].join('\n')
    );
    const found = readSshConfigHost('web01');
    // No `host` field exists on a failure, which is how "no partial import" is
    // enforced by the type rather than by a convention.
    expect('host' in found).toBe(false);
  });
});

describe('IdentityFile and IdentityAgent are read and dropped (AC-S4)', () => {
  it.each(['IdentityFile ~/.ssh/id_ed25519', 'IdentityAgent ~/.ssh/agent.sock'])(
    'flags %j without importing it',
    (line) => {
      writeConfig(['Host web01', '  HostName web01.internal', `  ${line}`].join('\n'));
      const found = readSshConfigHost('web01');
      expect(found.ok && found.host.identityIgnored).toBe(true);
      // Nothing in the result carries the path: there is nowhere for it to go.
      expect(JSON.stringify(found)).not.toContain('id_ed25519');
      expect(JSON.stringify(found)).not.toContain('agent.sock');
    }
  );

  it('leaves the flag off when neither keyword is present', () => {
    writeConfig(['Host web01', '  HostName web01.internal'].join('\n'));
    expect(readSshConfigHost('web01').ok && readSshConfigHost('web01').ok).toBe(true);
    const found = readSshConfigHost('web01');
    expect(found.ok && found.host.identityIgnored).toBe(false);
  });
});

describe('expandIncludeGlob', () => {
  it('returns the path unchanged when there is nothing to expand', () => {
    const plain = path.join(home.dir, 'a', 'b.conf');
    expect(
      expandIncludeGlob(plain, () => {
        throw new Error('must not scan a directory for a pattern-free path');
      })
    ).toEqual([plain]);
  });

  it('sorts matches, so two runs agree', () => {
    const dir = path.join(home.dir, 'conf.d');
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['30.conf', '10.conf', '20.conf']) {
      fs.writeFileSync(path.join(dir, name), '', 'utf8');
    }
    expect(expandIncludeGlob(path.join(dir, '*.conf'), (d) => fs.readdirSync(d))).toEqual([
      path.join(dir, '10.conf'),
      path.join(dir, '20.conf'),
      path.join(dir, '30.conf'),
    ]);
  });

  it('does not let a leading * match a dotfile', () => {
    const dir = path.join(home.dir, 'conf.d');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.hidden.conf'), '', 'utf8');
    fs.writeFileSync(path.join(dir, 'shown.conf'), '', 'utf8');
    expect(expandIncludeGlob(path.join(dir, '*.conf'), (d) => fs.readdirSync(d))).toEqual([
      path.join(dir, 'shown.conf'),
    ]);
  });

  it('yields nothing for a directory that is not there', () => {
    expect(
      expandIncludeGlob(path.join(home.dir, 'nope', '*.conf'), (d) => fs.readdirSync(d))
    ).toEqual([]);
  });
});

describe('the Node 20 rule this module exists under', () => {
  /**
   * `fs.globSync` arrived in Node 22. `engines` allows `^20.17.0`, and
   * `scripts/assert-bundle-imports.mjs` only inspects *named* builtin imports,
   * so `fs.globSync(...)` off the namespace would build cleanly and throw
   * `TypeError` at call time on a supported Node. Nothing else would catch it.
   */
  it('never reaches for fs.globSync', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../../src/setup/sshConfig.ts', import.meta.url)),
      'utf8'
    );
    // Comments name it on purpose — they are the record of why it is absent.
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
    expect(code).not.toContain('globSync');
  });
});
