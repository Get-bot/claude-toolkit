import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APPROVAL_MODE,
  DEFAULT_AUDIT_MODE,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_SEC,
  HostEntrySchema,
  HostsFileSchema,
  emptyHostsFile,
} from '../../src/config/schema.js';
import type { HostEntryInput } from '../../src/config/schema.js';

/** SHA-256 of the empty string, base64 without padding: exactly 43 chars. */
const FINGERPRINT = 'SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU';

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostname: 'web01.example.com',
    user: 'deploy',
    privateKeyPath: 'C:\\Users\\me\\.ssh-mcp\\keys\\prod-web',
    hostKey: { algo: 'ssh-ed25519', sha256: FINGERPRINT },
    createdAt: '2026-09-11T12:00:00.000Z',
    ...overrides,
  };
}

describe('HostEntrySchema defaults', () => {
  it('fills in every optional field except approvalFallback and label', () => {
    const parsed = HostEntrySchema.parse(entry());
    expect(parsed.port).toBe(DEFAULT_PORT);
    expect(parsed.approvalMode).toBe(DEFAULT_APPROVAL_MODE);
    expect(parsed.auditMode).toBe(DEFAULT_AUDIT_MODE);
    expect(parsed.defaultTimeoutSec).toBe(DEFAULT_TIMEOUT_SEC);
    expect(parsed.maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(parsed.patternOverrides).toEqual({
      destructive: { add: [], remove: [] },
      privileged: { add: [], remove: [] },
    });
    expect(parsed.approvalFallback).toBeUndefined();
    expect(parsed.label).toBeUndefined();
  });
});

describe('approvalFallback (decision D1/D2, AC7.6, AC17.11)', () => {
  it('is optional and carries no schema default, so a hand-edited file still loads', () => {
    const parsed = HostEntrySchema.parse(entry());
    expect(parsed.approvalFallback).toBeUndefined();
    expect('approvalFallback' in parsed).toBe(false);
  });

  it.each(['token', 'fail-closed'] as const)('accepts %s', (value) => {
    expect(HostEntrySchema.parse(entry({ approvalFallback: value })).approvalFallback).toBe(value);
  });

  it('rejects any other value', () => {
    expect(HostEntrySchema.safeParse(entry({ approvalFallback: 'ask' })).success).toBe(false);
    expect(HostEntrySchema.safeParse(entry({ approvalFallback: null })).success).toBe(false);
  });
});

describe('strict objects reject unknown keys', () => {
  it('rejects patternOverrides.allow, so a v1-draft allow-list is never ignored', () => {
    const result = HostEntrySchema.safeParse(
      entry({
        patternOverrides: {
          destructive: { add: [], remove: [] },
          privileged: { add: [], remove: [] },
          allow: ['^rm -rf /tmp/'],
        },
      })
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(JSON.stringify(result.error.issues)).toContain('allow');
  });

  it('rejects an unknown key on the host entry', () => {
    expect(HostEntrySchema.safeParse(entry({ approvalModes: 'auto' })).success).toBe(false);
  });

  it('rejects an unknown key inside a pattern group', () => {
    const result = HostEntrySchema.safeParse(
      entry({
        patternOverrides: {
          destructive: { add: [], remove: [], replace: [] },
          privileged: { add: [], remove: [] },
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key on the hosts file', () => {
    expect(HostsFileSchema.safeParse({ schemaVersion: 1, hosts: {}, extra: true }).success).toBe(
      false
    );
  });

  it('rejects an unknown key on hostKey', () => {
    expect(
      HostEntrySchema.safeParse(
        entry({ hostKey: { algo: 'ssh-ed25519', sha256: FINGERPRINT, md5: 'x' } })
      ).success
    ).toBe(false);
  });
});

describe('bounds', () => {
  it.each([
    [1, true],
    [22, true],
    [65535, true],
    [0, false],
    [65536, false],
    [22.5, false],
  ])('port %s -> valid=%s', (port, valid) => {
    expect(HostEntrySchema.safeParse(entry({ port })).success).toBe(valid);
  });

  it.each([
    [1, true],
    [3600, true],
    [0, false],
    [3601, false],
  ])('defaultTimeoutSec %s -> valid=%s', (defaultTimeoutSec, valid) => {
    expect(HostEntrySchema.safeParse(entry({ defaultTimeoutSec })).success).toBe(valid);
  });

  it.each([
    [1024, true],
    [1048576, true],
    [4194304, true],
    [1023, false],
    [4194305, false],
  ])('maxOutputBytes %s -> valid=%s', (maxOutputBytes, valid) => {
    expect(HostEntrySchema.safeParse(entry({ maxOutputBytes })).success).toBe(valid);
  });

  it('rejects an empty or over-long hostname', () => {
    expect(HostEntrySchema.safeParse(entry({ hostname: '' })).success).toBe(false);
    expect(HostEntrySchema.safeParse(entry({ hostname: 'a'.repeat(254) })).success).toBe(false);
    expect(HostEntrySchema.safeParse(entry({ hostname: 'a'.repeat(253) })).success).toBe(true);
  });

  it('rejects a user containing whitespace or a colon', () => {
    expect(HostEntrySchema.safeParse(entry({ user: 'de ploy' })).success).toBe(false);
    expect(HostEntrySchema.safeParse(entry({ user: 'deploy:1' })).success).toBe(false);
    expect(HostEntrySchema.safeParse(entry({ user: '' })).success).toBe(false);
    expect(HostEntrySchema.safeParse(entry({ user: 'a'.repeat(65) })).success).toBe(false);
  });

  it('rejects an over-long label', () => {
    expect(HostEntrySchema.safeParse(entry({ label: 'x'.repeat(128) })).success).toBe(true);
    expect(HostEntrySchema.safeParse(entry({ label: 'x'.repeat(129) })).success).toBe(false);
  });

  it('rejects an override pattern longer than 512 characters (ReDoS guard)', () => {
    const long = `^${'a'.repeat(512)}`;
    const result = HostEntrySchema.safeParse(
      entry({
        patternOverrides: {
          destructive: { add: [long], remove: [] },
          privileged: { add: [], remove: [] },
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it('rejects an override pattern that does not compile, pointing at the index', () => {
    const result = HostEntrySchema.safeParse(
      entry({
        patternOverrides: {
          destructive: { add: ['^ok', '^(unclosed'], remove: [] },
          privileged: { add: [], remove: [] },
        },
      })
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.map((p) => String(p)).join('.'));
    expect(paths).toContain('patternOverrides.destructive.add.1');
  });

  it('accepts override patterns that compile', () => {
    const parsed = HostEntrySchema.parse(
      entry({
        patternOverrides: {
          destructive: { add: ['^helm\\s+uninstall\\b'], remove: ['^git\\s+push\\b'] },
          privileged: { add: [], remove: [] },
        },
      })
    );
    expect(parsed.patternOverrides.destructive.add).toEqual(['^helm\\s+uninstall\\b']);
  });
});

describe('hostKey.sha256 format (AC7.4)', () => {
  it('accepts SHA256: plus 43 base64 characters', () => {
    expect(HostEntrySchema.safeParse(entry()).success).toBe(true);
  });

  it.each([
    'SHA256:tooshort',
    `SHA256:${'A'.repeat(42)}`,
    `SHA256:${'A'.repeat(44)}`,
    `${FINGERPRINT}=`,
    FINGERPRINT.slice('SHA256:'.length),
    'MD5:aa:bb:cc',
    'sha256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU',
  ])('rejects %s', (sha256) => {
    expect(
      HostEntrySchema.safeParse(entry({ hostKey: { algo: 'ssh-ed25519', sha256 } })).success
    ).toBe(false);
  });
});

describe('createdAt', () => {
  it('accepts an ISO timestamp with Z or an offset', () => {
    expect(
      HostEntrySchema.safeParse(entry({ createdAt: '2026-09-11T12:00:00.000Z' })).success
    ).toBe(true);
    expect(
      HostEntrySchema.safeParse(entry({ createdAt: '2026-09-11T21:00:00+09:00' })).success
    ).toBe(true);
  });

  it('rejects a non-timestamp', () => {
    expect(HostEntrySchema.safeParse(entry({ createdAt: '2026-09-11' })).success).toBe(false);
    expect(HostEntrySchema.safeParse(entry({ createdAt: 'yesterday' })).success).toBe(false);
  });

  it('is required', () => {
    const bare = entry();
    delete bare.createdAt;
    expect(HostEntrySchema.safeParse(bare).success).toBe(false);
  });
});

describe('HostsFileSchema', () => {
  it('requires schemaVersion === 1', () => {
    expect(HostsFileSchema.safeParse({ schemaVersion: 1 }).success).toBe(true);
    expect(HostsFileSchema.safeParse({ schemaVersion: 2, hosts: {} }).success).toBe(false);
    expect(HostsFileSchema.safeParse({ hosts: {} }).success).toBe(false);
  });

  it('defaults hosts to an empty map', () => {
    expect(HostsFileSchema.parse({ schemaVersion: 1 })).toEqual(emptyHostsFile());
  });

  it.each(['prod-web', 'a', 'Prod.Web_1', 'a0.-_', `a${'b'.repeat(63)}`])(
    'accepts alias %s',
    (alias) => {
      expect(
        HostsFileSchema.safeParse({ schemaVersion: 1, hosts: { [alias]: entry() } }).success
      ).toBe(true);
    }
  );

  it.each(['-bad', '.bad', '_bad', 'has space', 'has/slash', '', `a${'b'.repeat(64)}`])(
    'rejects alias %s',
    (alias) => {
      expect(
        HostsFileSchema.safeParse({ schemaVersion: 1, hosts: { [alias]: entry() } }).success
      ).toBe(false);
    }
  );

  it('validates nested host entries', () => {
    const result = HostsFileSchema.safeParse({
      schemaVersion: 1,
      hosts: { web: entry({ port: 0 }) },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.map((p) => String(p)).join('.'));
    expect(paths).toContain('hosts.web.port');
  });
});

describe('type surface', () => {
  it('accepts a minimal input object as HostEntryInput', () => {
    const input: HostEntryInput = {
      hostname: 'h',
      user: 'u',
      privateKeyPath: 'k',
      hostKey: { algo: 'ssh-ed25519', sha256: FINGERPRINT },
      createdAt: '2026-09-11T12:00:00.000Z',
    };
    expect(HostEntrySchema.safeParse(input).success).toBe(true);
  });
});
