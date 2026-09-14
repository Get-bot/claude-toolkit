import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  ERROR_CODE_LIST,
  isErrorCode,
  toToolError,
  toToolNotice,
  toToolResult,
} from '../../src/errors.js';

const SENTINEL = 'P@ssw0rd-SENTINEL-9f3a';

function bodyOf(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('error code table (§5.3)', () => {
  it('carries every code the acceptance criteria name', () => {
    for (const code of [
      'config_invalid',
      'host_not_found',
      'host_key_mismatch',
      'auth_failed',
      'command_denied',
      'approval_unavailable',
      'confirmation_required',
      'confirmation_token_invalid',
      'confirmation_token_used',
      'confirmation_token_expired',
      'confirmation_token_mismatch',
      'interactive_program_refused',
      'command_timeout',
      'command_too_long',
      'session_not_found',
      'session_expired',
      'session_terminated',
      'session_limit_exceeded',
      'shell_incompatible',
      'unsupported_shell',
      'local_file_exists',
      'sftp_failed',
      'sudo_password_required',
      'alias_exists',
    ]) {
      expect(ERROR_CODE_LIST).toContain(code);
    }
  });

  it('maps every key to itself so the constant and the wire value cannot drift', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });

  it('recognises its own codes and rejects anything else', () => {
    expect(isErrorCode('host_not_found')).toBe(true);
    expect(isErrorCode('approval_required')).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });
});

describe('toToolError (plan row 1.7)', () => {
  it('produces the §5.9 body shape with isError true', () => {
    const result = toToolError('unsupported_shell', 'shell not supported', {
      detected_shell: 'fish',
      alternatives: ['use exec for one-shot commands'],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    const body = bodyOf(result);
    expect(body.error).toBe('unsupported_shell');
    expect(body.message).toBe('shell not supported');
    expect(body.detected_shell).toBe('fish');
    expect(body.alternatives).toEqual(['use exec for one-shot commands']);
  });

  it('works without details', () => {
    expect(bodyOf(toToolError('host_not_found', 'no such alias'))).toEqual({
      error: 'host_not_found',
      message: 'no such alias',
    });
  });

  it('redacts details (AC19)', () => {
    const result = toToolError('auth_failed', 'authentication failed', {
      password: SENTINEL,
      note: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain(SENTINEL);
    expect(text).not.toContain('-----BEGIN');
    expect(bodyOf(result).password).toBe('[redacted]');
  });

  it('never lets details override the code or the message', () => {
    const body = bodyOf(
      toToolError('auth_failed', 'real message', { error: 'spoofed', message: 'spoofed' })
    );
    expect(body.error).toBe('auth_failed');
    expect(body.message).toBe('real message');
  });
});

describe('toToolNotice / toToolResult', () => {
  it('marks confirmation_required as a non-error outcome (AC17.2)', () => {
    const result = toToolNotice('confirmation_required', 'show the command and re-call', {
      grade: 'destructive',
    });
    expect(result.isError).toBe(false);
    expect(bodyOf(result)).toMatchObject({
      error: 'confirmation_required',
      grade: 'destructive',
    });
  });

  it('masks a token-shaped key by default', () => {
    const body = bodyOf(
      toToolNotice('confirmation_required', 'approve first', { confirmation_token: 'tok-abc123' })
    );
    expect(body.confirmation_token).toBe('[redacted]');
  });

  it('lets preserveKeys carry the confirmation token to the client (AC17.2)', () => {
    const body = bodyOf(
      toToolNotice(
        'confirmation_required',
        'approve first',
        { confirmation_token: 'tok-abc123', password: SENTINEL },
        { preserveKeys: ['confirmation_token'] }
      )
    );
    expect(body.confirmation_token).toBe('tok-abc123');
    // Everything else is still masked.
    expect(body.password).toBe('[redacted]');
  });

  it('redacts successful bodies too', () => {
    const result = toToolResult({ stdout: 'ok', privateKey: 'key-material' });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.text ?? '').not.toContain('key-material');
    expect(bodyOf(result).stdout).toBe('ok');
  });
});
