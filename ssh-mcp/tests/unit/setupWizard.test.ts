/**
 * The `ssh-mcp setup` wizard (`src/setup/wizard.ts`).
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
 */
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { KeyEvent, KeySource, MenuIo } from '../../src/setup/menu.js';
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

interface Harness {
  io: WizardIo;
  /** Every `host:port` the wizard checked, in order. */
  probed: string[];
  send(text: string): void;
  end(): void;
  output(): string;
}

function scriptedKeys(events: readonly Partial<KeyEvent>[]): KeySource {
  let next = 0;
  return (listener) => {
    let stopped = false;
    void (async (): Promise<void> => {
      while (next < events.length) {
        await Promise.resolve();
        if (stopped) return;
        const event = events[next];
        next += 1;
        if (event === undefined) return;
        listener({ name: '', sequence: '', ctrl: false, ...event });
      }
    })();
    return (): void => {
      stopped = true;
    };
  };
}

function harness(
  options: {
    taken?: readonly string[];
    given?: WizardIo['given'];
    keys?: KeySource | null;
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
  const keys = options.keys ?? null;
  const reach = [...(options.reach ?? [])];
  const probed: string[] = [];
  return {
    probed,
    io: {
      prompter,
      menu: keys === null ? null : { write: (text) => prompter.write(text), keys },
      takenAliases: new Set(options.taken ?? []),
      given: options.given ?? { approvalMode: false, label: false },
      probeTcp: (host: string, port: number): Promise<ReachResult> => {
        probed.push(`${host}:${String(port)}`);
        return Promise.resolve(reach.shift() ?? { ok: true, code: '', reason: '' });
      },
    },
    send: (text: string): void => {
      input.write(text);
    },
    end: (): void => {
      input.end();
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
});

describe('formatTarget', () => {
  it('brackets an IPv6 literal so the port stays unambiguous', () => {
    expect(formatTarget('deploy', 'web01.example.com', 22)).toBe('deploy@web01.example.com:22');
    expect(formatTarget('deploy', '2001:db8::1', 2222)).toBe('deploy@[2001:db8::1]:2222');
  });
});

describe('runSetupWizard', () => {
  it('turns six answers into argv, in the order setup expects', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    // host, user, port (Enter = 22), alias (Enter = web01), mode, label
    io.send('web01.example.com\ndeploy\n\n\nask-all\n운영 웹\n');
    expect(await pending).toEqual([
      '--approval-mode',
      'ask-all',
      '--label',
      '운영 웹',
      'web01',
      'deploy@web01.example.com:22',
    ]);
  });

  it('omits --label when the label question is answered with Enter', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('host\nme\n\nbox\n\n\n');
    const argv = await pending;
    expect(argv).not.toContain('--label');
    expect(argv.slice(-2)).toEqual(['box', 'me@host:22']);
    // An empty approval-mode answer takes the documented default.
    expect(argv.slice(0, 2)).toEqual(['--approval-mode', 'ask-destructive']);
  });

  it('skips the questions whose flags are already on the command line', async () => {
    const io = harness({ given: { approvalMode: true, label: true } });
    const pending = runSetupWizard(io.io);
    io.send('host\nme\n2222\nbox\n');
    expect(await pending).toEqual(['box', 'me@host:2222']);
  });

  it('re-asks an empty host, an empty user and a bad port', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('\nweb01\n\ndeploy\nnope\n70000\n2200\nbox\n\n\n');
    const argv = await pending;
    expect(argv.slice(-2)).toEqual(['box', 'deploy@web01:2200']);
    expect(io.output()).toContain('호스트 주소는 비워 둘 수 없습니다');
    expect(io.output()).toContain('사용자명은 비워 둘 수 없습니다');
    expect(io.output()).toContain('숫자만 입력하세요');
    expect(io.output()).toContain('1에서 65535 사이여야 합니다');
  });

  // Reported from a WSL pty: an arrow key pressed at the host question arrived
  // as `\x1b[B`, was accepted as a hostname, and the escape moved the cursor so
  // the screen showed `연결 확인 중: :22`. The probe caught it; the question
  // should have.
  it('refuses an escape sequence typed at the host question', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('\x1b[B\nweb01.example.com\ndeploy\n\nbox\n\n\n');
    const argv = await pending;
    expect(io.output()).toContain('호스트 주소에 쓸 수 없는 문자가 있습니다');
    expect(argv.slice(-1)[0]).toBe('deploy@web01.example.com:22');
    // The bad answer never reached the network.
    expect(io.probed).toEqual(['web01.example.com:22']);
  });

  it('refuses a host that is not a name or an address', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('http://web01/\n-bad-.example\n10.0.0.7\nops\n\nbox\n\n\n');
    const argv = await pending;
    expect(io.output()).toContain('호스트 이름이나 IP 주소 형식이어야 합니다');
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
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('web01\ndep\x1bloy\ndeploy\n\nbox\n\n\n');
    const argv = await pending;
    expect(io.output()).toContain('사용자명에 쓸 수 없는 문자가 있습니다');
    expect(argv.slice(-1)[0]).toBe('deploy@web01:22');
  });

  // The label is printed back by `host list` and `list_hosts`, so an escape
  // sequence stored in it would rewrite a terminal long after it was typed.
  it('refuses a control character in the label', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('web01\nops\n\nbox\n\n\x1b[31mred\nplain\n');
    const argv = await pending;
    expect(io.output()).toContain('라벨에 쓸 수 없는 문자가 있습니다');
    expect(argv).toContain('plain');
    expect(argv.join(' ')).not.toContain('\x1b');
  });

  it('rejects a user name with a colon, which the schema forbids', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('host\nbad:name\ngood\n\nbox\n\n\n');
    expect((await pending).slice(-1)[0]).toBe('good@host:22');
    expect(io.output()).toContain('공백이나 콜론을 넣을 수 없습니다');
  });

  it('refuses an alias that is already registered instead of implying --force', async () => {
    const io = harness({ taken: ['web01'] });
    const pending = runSetupWizard(io.io);
    io.send('web01.example.com\ndeploy\n\n\nweb01b\n\n\n');
    const argv = await pending;
    expect(argv.slice(-2)).toEqual(['web01b', 'deploy@web01.example.com:22']);
    expect(io.output()).toContain('"web01"는 이미 있습니다');
    expect(io.output()).toContain('--force로 실행하세요');
  });

  it('re-asks an alias the schema rejects', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('192.168.1.10\ndeploy\n\n-bad\nok-box\n\n\n');
    expect((await pending).slice(-2)).toEqual(['ok-box', 'deploy@192.168.1.10:22']);
    expect(io.output()).toContain('영숫자로 시작하고');
  });

  it('uses the arrow-key menu for the approval mode when one is available', async () => {
    const io = harness({ keys: scriptedKeys([{ name: 'down' }, { name: 'return' }]) });
    const pending = runSetupWizard(io.io);
    // host, user, port, alias, then the label question that follows the menu.
    io.send('host\nme\n\nbox\n\n');
    const argv = await pending;
    // Preselected `ask-destructive` is index 1, so one step down is `ask-all`.
    expect(argv.slice(0, 2)).toEqual(['--approval-mode', 'ask-all']);
    expect(io.output()).toContain('승인 모드를 고르세요');
    expect(argv.slice(-2)).toEqual(['box', 'me@host:22']);
  });

  it('accepts a number for the approval mode without a menu', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('host\nme\n\nbox\n1\n\n');
    expect((await pending).slice(0, 2)).toEqual(['--approval-mode', 'auto']);
  });

  // Reported from Windows: a hostname typo took the password, an ACL pass and
  // a generated key pair before failing with getaddrinfo ENOTFOUND.
  it('checks the address before anything expensive and reports why it failed', async () => {
    const io = harness({
      reach: [{ ok: false, code: 'ENOTFOUND', reason: '호스트 이름을 찾을 수 없습니다' }],
    });
    const pending = runSetupWizard(io.io);
    // Bad address, then a good one: only the address is asked again.
    io.send('11-2.213123\ntest\n\nweb01.example.com\n2222\nbox\n\n\n');
    const argv = await pending;
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
    const io = harness({ reach: [refused, refused, refused] });
    const pending = runSetupWizard(io.io);
    io.send('a.example.com\nme\n\nb.example.com\n\nc.example.com\n\n');
    await expect(pending).rejects.toBeInstanceOf(PromptAbortedError);
    expect(io.probed).toHaveLength(MAX_REACH_ATTEMPTS);
    expect(io.output()).toContain('포트가 닫혀 있습니다');
  });

  it('aborts when the input ends before the questions are done', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('host\n');
    io.end();
    await expect(pending).rejects.toBeInstanceOf(PromptAbortedError);
  });

  it('gives up rather than looping forever on invalid answers', async () => {
    const io = harness();
    const pending = runSetupWizard(io.io);
    io.send('\n'.repeat(20));
    await expect(pending).rejects.toMatchObject({ reason: 'no-answer' });
  });
});

describe('wizard menu wiring', () => {
  it('passes no menu through when the terminal cannot draw one', () => {
    const io = harness();
    expect(io.io.menu).toBeNull();
  });

  it('builds a menu that writes through the prompter', () => {
    const io = harness({ keys: scriptedKeys([]) });
    const menu = io.io.menu as MenuIo;
    menu.write('hello');
    expect(io.output()).toContain('hello');
  });
});
