/**
 * Shell detection table and session preamble (§5.9, AC14.3-AC14.6).
 *
 * The preamble assertion is a regression guard, not a formality: `set +o
 * pipefail` is an argument error in dash and busybox ash, and an argument
 * error in a POSIX special builtin kills a non-interactive shell outright. One
 * stray addition to this string would take every dash session down (AC14.4).
 */
import { describe, expect, it } from 'vitest';

import {
  SHELL_ALTERNATIVES,
  SHELL_PREAMBLE,
  SHELL_PROBE_COMMAND,
  buildCapabilityProbe,
  classifyShellProbe,
  parseCapabilityProbe,
  shellBasename,
  unsupportedShellVerdict,
} from '../../src/ssh/shellDetect.js';

function probe(stdout: string, stderr = ''): ReturnType<typeof classifyShellProbe> {
  return classifyShellProbe({ stdout, stderr });
}

describe('preamble', () => {
  it('is exactly "set +e; set +u"', () => {
    expect(SHELL_PREAMBLE).toBe('set +e; set +u');
  });

  it('never mentions pipefail (AC14.4)', () => {
    expect(SHELL_PREAMBLE).not.toContain('pipefail');
    expect(buildCapabilityProbe('__SM_TEST__')).not.toContain('pipefail');
    expect(SHELL_PROBE_COMMAND).not.toContain('pipefail');
  });

  it('asks the shell to name itself', () => {
    expect(SHELL_PROBE_COMMAND).toBe('echo __SM_SH__$0__');
  });
});

describe('basename normalisation', () => {
  it.each([
    ['bash', 'bash'],
    ['-bash', 'bash'],
    ['/bin/bash', 'bash'],
    ['/usr/bin/bash.exe', 'bash'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'bash'],
    ['-sh', 'sh'],
    ['/bin/sh', 'sh'],
  ])('%s becomes %s', (input, expected) => {
    expect(shellBasename(input)).toBe(expected);
  });
});

describe('supported shells', () => {
  it.each([
    ['__SM_SH__bash__\n', 'bash'],
    ['__SM_SH__-bash__\n', 'bash'],
    ['__SM_SH__/bin/bash__\n', 'bash'],
    ['__SM_SH__zsh__\n', 'zsh'],
    ['__SM_SH__-zsh__\n', 'zsh'],
    ['__SM_SH__/bin/sh__\n', 'dash'],
    ['__SM_SH__sh__\n', 'dash'],
    ['__SM_SH__-sh__\n', 'dash'],
    ['__SM_SH__dash__\n', 'dash'],
    ['__SM_SH__ash__\n', 'ash'],
    ['__SM_SH__busybox__\n', 'ash'],
  ])('classifies %j as %s', (stdout, shell) => {
    const verdict = probe(stdout);
    expect(verdict.supported).toBe(true);
    expect(verdict.shell).toBe(shell);
  });
});

describe('unsupported shells', () => {
  it('detects fish from its own name (AC14.5)', () => {
    const verdict = probe('__SM_SH__fish__\n');
    expect(verdict.supported).toBe(false);
    expect(verdict.shell).toBe('fish');
    if (!verdict.supported) {
      expect(verdict.alternatives).toEqual([...SHELL_ALTERNATIVES]);
      expect(verdict.message).toContain('fish');
      expect(verdict.classification_coverage).toBe('none');
    }
  });

  it.each([
    'fish: $0: Invalid variable name\n',
    'fish: Variables cannot be bracketed. In fish, please use {$0}.\n',
  ])('detects fish from a syntax error: %j', (stderr) => {
    const verdict = probe('', stderr);
    expect(verdict.shell).toBe('fish');
    expect(verdict.supported).toBe(false);
  });

  it('detects cmd.exe from the unexpanded literal (AC14.6)', () => {
    const verdict = probe('__SM_SH__$0__\r\n');
    expect(verdict.supported).toBe(false);
    expect(verdict.shell).toBe('cmd');
    if (!verdict.supported) expect(verdict.classification_coverage).toBe('reduced');
  });

  it.each(['__SM_SH____\n', '__SM_SH__\n'])(
    'detects powershell from the empty expansion: %j',
    (stdout) => {
      const verdict = probe(stdout);
      expect(verdict.supported).toBe(false);
      expect(verdict.shell).toBe('powershell');
      if (!verdict.supported) expect(verdict.classification_coverage).toBe('reduced');
    }
  );

  it('reports silence as unknown', () => {
    const verdict = probe('');
    expect(verdict.supported).toBe(false);
    expect(verdict.shell).toBe('unknown');
  });

  it('reports an unrecognised shell name as unknown', () => {
    const verdict = probe('__SM_SH__xonsh__\n');
    expect(verdict.supported).toBe(false);
    expect(verdict.shell).toBe('unknown');
  });

  it('offers exec as the alternative in every refusal', () => {
    for (const shell of ['fish', 'cmd', 'powershell', 'unknown'] as const) {
      const verdict = unsupportedShellVerdict(shell);
      expect(verdict.alternatives[0]).toContain('exec');
      expect(verdict.alternatives).toHaveLength(3);
    }
  });
});

describe('capability probe', () => {
  const marker = '__SM_probe__';

  it('asks for flags, pid, version, /dev/null and base64', () => {
    const command = buildCapabilityProbe(marker);
    expect(command).toContain('echo __SM_FLAGS__$-__');
    expect(command).toContain('echo __SM_PID__$$__');
    expect(command).toContain('${BASH_VERSION}${ZSH_VERSION}');
    expect(command).toContain('[ -r /dev/null ]');
    expect(command).toContain('base64 -d');
    expect(command).toContain('base64 -D');
    expect(command).toContain(marker);
    expect(command).not.toContain('\n');
  });

  it('parses a bash answer', () => {
    const result = parseCapabilityProbe(
      [
        '__SM_FLAGS__huBc__',
        '__SM_PID__4242__',
        '__SM_VER__5.2.21(1)-release__',
        '__SM_DEVNULL__ok__',
        '__SM_B64__d__',
      ].join('\n')
    );
    expect(result.flags).toBe('huBc');
    expect(result.pid).toBe(4242);
    expect(result.version).toBe('5.2.21(1)-release');
    expect(result.devNull).toBe(true);
    expect(result.base64Flag).toBe('-d');
  });

  it('parses a dash answer with no version and the BSD flag', () => {
    const result = parseCapabilityProbe(
      [
        '__SM_FLAGS__s__',
        '__SM_PID__7__',
        '__SM_VER____',
        '__SM_DEVNULL__no__',
        '__SM_B64__D__',
      ].join('\n')
    );
    expect(result.version).toBeNull();
    expect(result.devNull).toBe(false);
    expect(result.base64Flag).toBe('-D');
  });

  it('reports an unusable base64 as null', () => {
    const result = parseCapabilityProbe('__SM_B64__none__\n');
    expect(result.base64Flag).toBeNull();
    expect(result.pid).toBeNull();
    expect(result.flags).toBeNull();
  });
});
