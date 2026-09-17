/**
 * The `ssh-mcp host add` wizard (`src/setup/wizard.ts`).
 *
 * The wizard's whole contract is that it produces **argv** — the same tokens a
 * user could have typed — so everything downstream keeps one code path and one
 * set of validation rules. These tests therefore assert the tokens, not the
 * side effects: there are none.
 *
 * Two rules get their own cases because getting them wrong is quiet and costly:
 * a taken alias must be refused rather than silently turned into a `--force`
 * run (re-pinning a host key needs an explicit flag), and a flag already on the
 * command line must suppress its question instead of asking twice.
 *
 * The questions are asked through an injected {@link Asker}, so none of this
 * needs a terminal and the assertions can name the choices and defaults that
 * were offered rather than guess from rendered output.
 */
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { Asker, SelectQuestion, TextQuestion } from '../../src/setup/ask.js';
import { PromptAbortedError, createPrompter } from '../../src/setup/prompt.js';
import type { Prompter } from '../../src/setup/prompt.js';
import type { ReachResult } from '../../src/ssh/reach.js';
import {
  MAX_REACH_ATTEMPTS,
  formatTarget,
  isUsableHostname,
  runSetupWizard,
  suggestAlias,
} from '../../src/setup/wizard.js';
import type { WizardIo } from '../../src/setup/wizard.js';

/** One question the wizard asked, reduced to what a test cares about. */
interface Asked {
  kind: 'select' | 'text';
  message: string;
  default?: string;
  choices?: string[];
}

interface Harness {
  io: WizardIo;
  /** Every `host:port` the wizard checked, in order. */
  probed: string[];
  /** Every question asked, in order. */
  asked: Asked[];
  /** Every rejection sentence a `validate` produced. */
  rejections: string[];
  output(): string;
}

function harness(
  options: {
    /** Answers consumed in order. `''` takes the question's default. */
    answers?: readonly string[];
    taken?: readonly string[];
    given?: WizardIo['given'];
    /** Pre-filled answers, as `--from-ssh-config`/`--alias`/`--port` supply them. */
    defaults?: WizardIo['defaults'];
    /** One result per reachability check, in order. Defaults to always reachable. */
    reach?: readonly ReachResult[];
  } = {}
): Harness {
  const input = new PassThrough();
  let written = '';
  const prompter: Prompter = createPrompter({
    input: input as never,
    output: {
      write(chunk: string) {
        written += chunk;
        return true;
      },
    },
    isTTY: true,
  });

  const answers = [...(options.answers ?? [])];
  const reach = [...(options.reach ?? [])];
  const probed: string[] = [];
  const asked: Asked[] = [];
  const rejections: string[] = [];

  /** An empty scripted answer means "press Enter", which takes the default. */
  const nextAnswer = (fallback: string | undefined): string => {
    if (answers.length === 0) {
      throw new PromptAbortedError('eof', 'the script ran out of answers');
    }
    const raw = answers.shift() ?? '';
    return raw === '' && fallback !== undefined ? fallback : raw;
  };

  const ask: Asker = {
    select<T extends string>(question: SelectQuestion<T>): Promise<T> {
      asked.push({
        kind: 'select',
        message: question.message,
        ...(question.default === undefined ? {} : { default: question.default }),
        choices: question.choices.map((choice) => choice.value),
      });
      const value = nextAnswer(question.default);
      const match = question.choices.find((choice) => choice.value === value);
      if (match === undefined) throw new Error(`not a choice: ${value}`);
      return Promise.resolve(match.value);
    },

    // Mirrors what the prompt library does: re-ask until `validate` accepts.
    text(question: TextQuestion): Promise<string> {
      asked.push({
        kind: 'text',
        message: question.message,
        ...(question.default === undefined ? {} : { default: question.default }),
      });
      // No attempt cap: `nextAnswer` throws once the script is exhausted, so a
      // question that never accepts ends the test instead of spinning.
      for (;;) {
        const value = nextAnswer(question.default);
        const verdict = question.validate?.(value) ?? true;
        if (verdict === true) return Promise.resolve(value);
        rejections.push(verdict);
      }
    },
  };

  return {
    probed,
    asked,
    rejections,
    io: {
      prompter,
      ask,
      takenAliases: new Set(options.taken ?? []),
      given: options.given ?? { approvalMode: false, label: false, force: false },
      ...(options.defaults === undefined ? {} : { defaults: options.defaults }),
      probeTcp: (host: string, port: number): Promise<ReachResult> => {
        probed.push(`${host}:${String(port)}`);
        return Promise.resolve(reach.shift() ?? { ok: true, code: '', reason: '' });
      },
    },
    output: (): string => written,
  };
}

describe('suggestAlias', () => {
  it('offers the first label of a hostname', () => {
    expect(suggestAlias('web01.example.com')).toBe('web01');
    expect(suggestAlias('bastion')).toBe('bastion');
  });

  it('offers nothing for an address, which is not a name', () => {
    expect(suggestAlias('192.168.1.10')).toBeNull();
    expect(suggestAlias('2001:db8::1')).toBeNull();
  });

  it('does not offer a name the alias question would reject', () => {
    // Pre-filling a taken alias makes Enter the obvious move and then refuses
    // it, so the default has to agree with the validation beside it.
    expect(suggestAlias('web01.example.com', new Set(['web01']))).toBeNull();
    expect(suggestAlias('web01.example.com', new Set(['other']))).toBe('web01');
  });

  it('offers it again under --force, which is what --force is for', () => {
    expect(suggestAlias('web01.example.com', new Set(['web01']), true)).toBe('web01');
  });
});

describe('formatTarget', () => {
  it('brackets an IPv6 literal so the port stays unambiguous', () => {
    expect(formatTarget('deploy', 'web01.example.com', 22)).toBe('deploy@web01.example.com:22');
    expect(formatTarget('deploy', '2001:db8::1', 2222)).toBe('deploy@[2001:db8::1]:2222');
  });
});

describe('runSetupWizard', () => {
  it('turns six answers into argv, in the order setup expects', async () => {
    const io = harness({
      // host, user, port (Enter = 22), alias (Enter = web01), mode, label
      answers: ['web01.example.com', 'deploy', '', '', 'ask-all', '운영 웹'],
    });
    expect(await runSetupWizard(io.io)).toEqual([
      '--approval-mode',
      'ask-all',
      '--label',
      '운영 웹',
      'web01',
      'deploy@web01.example.com:22',
    ]);
  });

  it('asks the six questions in the documented order', async () => {
    const io = harness({ answers: ['web01.example.com', 'deploy', '', '', 'ask-all', ''] });
    await runSetupWizard(io.io);
    expect(io.asked.map((entry) => entry.kind)).toEqual([
      'text',
      'text',
      'text',
      'text',
      'select',
      'text',
    ]);
    expect(io.asked[0]?.message).toContain('호스트 주소');
    expect(io.asked[1]?.message).toContain('사용자명');
    expect(io.asked[2]?.message).toContain('SSH 포트');
    expect(io.asked[3]?.message).toContain('alias');
    expect(io.asked[4]?.message).toContain('승인 모드');
    expect(io.asked[5]?.message).toContain('라벨');
  });

  it('offers the documented defaults', async () => {
    const io = harness({ answers: ['web01.example.com', 'deploy', '', '', '', ''] });
    await runSetupWizard(io.io);
    expect(io.asked[2]?.default).toBe('22');
    expect(io.asked[3]?.default).toBe('web01');
    expect(io.asked[4]?.default).toBe('ask-destructive');
    expect(io.asked[4]?.choices).toEqual(['auto', 'ask-destructive', 'ask-all', 'deny']);
    // The label question has no default; an empty answer simply omits the flag.
    expect(io.asked[5]?.default).toBeUndefined();
  });

  it('omits --label when the label question is answered with Enter', async () => {
    const io = harness({ answers: ['host', 'me', '', 'box', '', ''] });
    const argv = await runSetupWizard(io.io);
    expect(argv).not.toContain('--label');
    expect(argv.slice(-2)).toEqual(['box', 'me@host:22']);
    // An empty approval-mode answer takes the documented default.
    expect(argv.slice(0, 2)).toEqual(['--approval-mode', 'ask-destructive']);
  });

  it('skips the questions whose flags are already on the command line', async () => {
    const io = harness({
      answers: ['host', 'me', '2222', 'box'],
      given: { approvalMode: true, label: true, force: false },
    });
    expect(await runSetupWizard(io.io)).toEqual(['box', 'me@host:2222']);
    expect(io.asked).toHaveLength(4);
  });

  it('re-asks an empty host, an empty user and a bad port', async () => {
    const io = harness({
      answers: ['   ', 'web01', '  ', 'deploy', 'nope', '70000', '2200', 'box', '', ''],
    });
    const argv = await runSetupWizard(io.io);
    expect(argv.slice(-2)).toEqual(['box', 'deploy@web01:2200']);
    expect(io.rejections).toContain('호스트 주소는 비워 둘 수 없습니다.');
    expect(io.rejections).toContain('사용자명은 비워 둘 수 없습니다.');
    expect(io.rejections).toContain('숫자만 입력하세요.');
    expect(io.rejections).toContain('1에서 65535 사이여야 합니다.');
  });

  // Reported from a WSL pty: an arrow key pressed at the host question arrived
  // as `\x1b[B`, was accepted as a hostname, and the escape moved the cursor so
  // the screen showed `연결 확인 중: :22`.
  it('refuses an escape sequence typed at the host question', async () => {
    const io = harness({ answers: ['\x1b[B', 'web01.example.com', 'deploy', '', 'box', '', ''] });
    const argv = await runSetupWizard(io.io);
    expect(io.rejections).toContain('호스트 주소에 쓸 수 없는 문자가 있습니다.');
    expect(argv.slice(-1)[0]).toBe('deploy@web01.example.com:22');
    // The bad answer never reached the network.
    expect(io.probed).toEqual(['web01.example.com:22']);
  });

  it('refuses a host that is not a name or an address', async () => {
    const io = harness({
      answers: ['http://web01/', '-bad-.example', '10.0.0.7', 'ops', '', 'box', '', ''],
    });
    const argv = await runSetupWizard(io.io);
    expect(io.rejections).toContain(
      '호스트 이름이나 IP 주소 형식이어야 합니다 (예: web01.example.com, 10.0.0.7).'
    );
    expect(argv.slice(-1)[0]).toBe('ops@10.0.0.7:22');
  });

  it('accepts the address shapes it should', () => {
    for (const good of ['web01', 'web01.example.com', '10.0.0.7', '2001:db8::1', '::1']) {
      expect(isUsableHostname(good)).toBe(true);
    }
    for (const bad of ['', 'web 01', 'http://x', '-lead.example', 'x'.repeat(254), 'a..b']) {
      expect(isUsableHostname(bad)).toBe(false);
    }
  });

  it('refuses a control character in the user name too', async () => {
    const io = harness({ answers: ['web01', 'dep\x1bloy', 'deploy', '', 'box', '', ''] });
    const argv = await runSetupWizard(io.io);
    expect(io.rejections).toContain('사용자명에 쓸 수 없는 문자가 있습니다.');
    expect(argv.slice(-1)[0]).toBe('deploy@web01:22');
  });

  // The label is printed back by `host list` and `list_hosts`, so an escape
  // sequence stored in it would rewrite a terminal long after it was typed.
  it('refuses a control character in the label', async () => {
    const io = harness({ answers: ['web01', 'ops', '', 'box', '', '\x1b[31mred', 'plain'] });
    const argv = await runSetupWizard(io.io);
    expect(io.rejections).toContain('라벨에 쓸 수 없는 문자가 있습니다.');
    expect(argv).toContain('plain');
    expect(argv.join(' ')).not.toContain('\x1b');
  });

  it('rejects a user name with a colon, which the schema forbids', async () => {
    const io = harness({ answers: ['host', 'bad:name', 'good', '', 'box', '', ''] });
    expect((await runSetupWizard(io.io)).slice(-1)[0]).toBe('good@host:22');
    expect(io.rejections).toContain('사용자명에 공백이나 콜론을 넣을 수 없습니다.');
  });

  it('refuses an alias that is already registered instead of implying --force', async () => {
    const io = harness({
      taken: ['web01'],
      answers: ['web01.example.com', 'deploy', '', 'web01', 'web01b', '', ''],
    });
    const argv = await runSetupWizard(io.io);
    expect(argv.slice(-2)).toEqual(['web01b', 'deploy@web01.example.com:22']);
    expect(io.rejections).toContain(
      '"web01"는 이미 있습니다. 다시 설정하려면 --force로 실행하세요.'
    );
  });

  /**
   * `host add --force` carries no positionals, so it opens the wizard — and the
   * wizard then refused every existing alias with "run it with --force", which
   * is the flag already on the command line. There was no way through.
   */
  it('accepts an existing alias when --force was given, and says what it will do', async () => {
    const io = harness({
      taken: ['web01'],
      given: { approvalMode: false, label: false, force: true },
      answers: ['web01.example.com', 'deploy', '', 'web01', '', ''],
    });
    const argv = await runSetupWizard(io.io);
    expect(argv.slice(-2)).toEqual(['web01', 'deploy@web01.example.com:22']);
    expect(io.rejections).toHaveLength(0);
    expect(io.output()).toContain('"web01"를 다시 설정합니다');
  });

  /**
   * Both ceilings are in `HostEntrySchema`, which only runs at `store.save()` —
   * after the password, the key pair and the remote `authorized_keys` install.
   * A user name caught only there leaves our public key on the remote host with
   * no local entry for it.
   */
  it('refuses a user name longer than the schema allows, before anything happens', async () => {
    const io = harness({
      answers: ['host', 'u'.repeat(65), 'deploy', '', 'box', '', ''],
    });
    expect((await runSetupWizard(io.io)).slice(-1)[0]).toBe('deploy@host:22');
    expect(io.rejections).toContain('사용자명은 64자를 넘을 수 없습니다.');
  });

  it('refuses a label longer than the parser allows, rather than discarding the interview', async () => {
    const io = harness({
      answers: ['host', 'deploy', '', 'box', '', 'x'.repeat(129), '설명'],
    });
    const argv = await runSetupWizard(io.io);
    expect(argv).toContain('설명');
    expect(io.rejections).toContain('라벨은 128자를 넘을 수 없습니다.');
  });

  it('re-asks an alias the schema rejects', async () => {
    const io = harness({ answers: ['192.168.1.10', 'deploy', '', '-bad', 'ok-box', '', ''] });
    expect((await runSetupWizard(io.io)).slice(-2)).toEqual(['ok-box', 'deploy@192.168.1.10:22']);
    expect(io.rejections).toContain(
      '영숫자로 시작하고 영숫자·점·밑줄·하이픈만 쓸 수 있습니다 (최대 64자).'
    );
  });

  // Reported from Windows: a hostname typo took the password, an ACL pass and
  // a generated key pair before failing with getaddrinfo ENOTFOUND.
  it('checks the address before anything expensive and reports why it failed', async () => {
    const io = harness({
      answers: ['11-2.213123', 'test', '', 'web01.example.com', '2222', 'box', '', ''],
      reach: [{ ok: false, code: 'ENOTFOUND', reason: '호스트 이름을 찾을 수 없습니다' }],
    });
    const argv = await runSetupWizard(io.io);
    expect(io.probed).toEqual(['11-2.213123:22', 'web01.example.com:2222']);
    expect(io.output()).toContain('연결 확인 중: 11-2.213123:22');
    expect(io.output()).toContain('연결 실패: 호스트 이름을 찾을 수 없습니다');
    expect(io.output()).toContain('연결 확인: OK');
    // The user name answered before the failure is kept.
    expect(argv.slice(-2)).toEqual(['box', 'test@web01.example.com:2222']);
  });

  it('gives up after three unreachable addresses', async () => {
    const refused: ReachResult = {
      ok: false,
      code: 'ECONNREFUSED',
      reason: '포트가 닫혀 있습니다',
    };
    const io = harness({
      answers: ['a.example.com', 'me', '', 'b.example.com', '', 'c.example.com', ''],
      reach: [refused, refused, refused],
    });
    await expect(runSetupWizard(io.io)).rejects.toBeInstanceOf(PromptAbortedError);
    expect(io.probed).toHaveLength(MAX_REACH_ATTEMPTS);
    expect(io.output()).toContain('포트가 닫혀 있습니다');
  });

  it('aborts when the questions run out of answers', async () => {
    const io = harness({ answers: ['host'] });
    await expect(runSetupWizard(io.io)).rejects.toBeInstanceOf(PromptAbortedError);
  });
});

describe('pre-filled answers (AC-S5, ADR-013)', () => {
  it('offers every default and still puts every question', async () => {
    // A default is not an answer. `given` is what makes the wizard skip a
    // question, and the ssh_config seed deliberately never reaches it — press
    // Enter six times and the six questions were all there to press it on.
    const io = harness({
      answers: ['', '', '', '', '', ''],
      defaults: {
        source: 'web01',
        hostname: 'web01.internal',
        user: 'deploy',
        port: 2022,
        alias: 'web01',
      },
    });
    const extra = await runSetupWizard(io.io);

    expect(io.asked).toHaveLength(6);
    expect(io.asked[0]?.default).toBe('web01.internal');
    expect(io.asked[1]?.default).toBe('deploy');
    expect(io.asked[2]?.default).toBe('2022');
    expect(io.asked[3]?.default).toBe('web01');
    expect(extra).toEqual([
      '--approval-mode',
      'ask-destructive',
      'web01',
      'deploy@web01.internal:2022',
    ]);
  });

  it('lets a different answer replace every one of them', async () => {
    const io = harness({
      answers: ['other.example.com', 'root', '2200', 'confirmed', 'ask-all', ''],
      defaults: { source: 'web01', hostname: 'web01.internal', user: 'deploy', port: 2022 },
    });
    expect(await runSetupWizard(io.io)).toEqual([
      '--approval-mode',
      'ask-all',
      'confirmed',
      'root@other.example.com:2200',
    ]);
  });

  it('names the source and says the existing key is not reused (AC-S4)', async () => {
    const io = harness({
      answers: ['', 'deploy', '', '', '', ''],
      defaults: { source: 'web01', hostname: 'web01.internal', identityIgnored: true },
    });
    await runSetupWizard(io.io);
    const text = io.output();
    expect(text).toContain('ssh_config의 "web01" 항목에서 읽은 값을 미리 채웠습니다');
    expect(text).toContain('IdentityFile·IdentityAgent는 무시합니다');
    expect(text).toContain('이 호스트 전용 키를 새로 만듭니다');
  });

  it('says nothing about ssh_config when nothing came from it', async () => {
    const io = harness({ answers: ['web01.example.com', 'deploy', '', '', '', ''] });
    await runSetupWizard(io.io);
    expect(io.output()).not.toContain('ssh_config');
  });

  it('leaves the identity line out when the block had neither keyword', async () => {
    const io = harness({
      answers: ['', 'deploy', '', '', '', ''],
      defaults: { source: 'web01', hostname: 'web01.internal' },
    });
    await runSetupWizard(io.io);
    expect(io.output()).not.toContain('IdentityFile');
  });

  it('spends the address default on the first ask only', async () => {
    // The second ask follows a failed reachability check, so re-offering the
    // address that just failed would make Enter the obvious move and fail the
    // same way.
    const io = harness({
      answers: ['', 'deploy', '', 'web02.example.com', '', '', '', ''],
      defaults: { source: 'web01', hostname: 'web01.internal' },
      reach: [{ ok: false, code: 'ECONNREFUSED', reason: 'refused' }],
    });
    await runSetupWizard(io.io);
    const addresses = io.asked.filter((entry) => entry.message.includes('호스트 주소'));
    expect(addresses).toHaveLength(2);
    expect(addresses[0]?.default).toBe('web01.internal');
    expect(addresses[1]?.default).toBeUndefined();
  });

  it('keeps the port default across a re-ask, which the failure does not implicate', async () => {
    const io = harness({
      answers: ['web01.example.com', 'deploy', '', 'web02.example.com', '', '', '', ''],
      defaults: { port: 2022 },
      reach: [{ ok: false, code: 'ECONNREFUSED', reason: 'refused' }],
    });
    await runSetupWizard(io.io);
    const ports = io.asked.filter((entry) => entry.message.includes('SSH 포트'));
    expect(ports.map((entry) => entry.default)).toEqual(['2022', '2022']);
  });
});

describe('an alias default has to be one the question accepts', () => {
  it('falls back to the hostname label when the seeded alias is taken', async () => {
    const io = harness({
      answers: ['', 'deploy', '', '', '', ''],
      defaults: { hostname: 'box.example.com', alias: 'web01' },
      taken: ['web01'],
    });
    await runSetupWizard(io.io);
    expect(io.asked[3]?.default).toBe('box');
  });

  it('offers the taken alias again under --force, which is what --force is for', async () => {
    const io = harness({
      answers: ['', 'deploy', '', '', '', ''],
      defaults: { hostname: 'box.example.com', alias: 'web01' },
      taken: ['web01'],
      given: { approvalMode: false, label: false, force: true },
    });
    await runSetupWizard(io.io);
    expect(io.asked[3]?.default).toBe('web01');
  });

  it('never offers a command name, from the seed or from the hostname (AC-C6)', async () => {
    const seeded = harness({
      answers: ['', 'deploy', '', 'chosen', '', ''],
      defaults: { hostname: 'box.example.com', alias: 'doctor' },
    });
    await runSetupWizard(seeded.io);
    expect(seeded.asked[3]?.default).toBe('box');

    const derived = harness({ answers: ['doctor.example.com', 'deploy', '', 'chosen', '', ''] });
    await runSetupWizard(derived.io);
    expect(derived.asked[3]?.default).toBeUndefined();
  });

  it('refuses a command name typed into the alias question', async () => {
    // `parseSetupArgs` refuses it too, but it runs after the wizard — without
    // this the whole finished interview would die as a usage error.
    const io = harness({
      answers: ['web01.example.com', 'deploy', '', 'connect', 'web01', '', ''],
    });
    await runSetupWizard(io.io);
    expect(io.rejections.join('\n')).toContain('ssh-mcp 명령 이름이라 alias로 쓸 수 없습니다');
  });
});

describe('suggestAlias and reserved names', () => {
  it('offers nothing when the first label is a command name', () => {
    expect(suggestAlias('help.example.com')).toBeNull();
    expect(suggestAlias('version')).toBeNull();
    expect(suggestAlias('helper.example.com')).toBe('helper');
  });
});
