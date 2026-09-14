/**
 * Interactive prompts (plan rows 5.2 and 5.6b, OPT-6, AC17.12a, AC19.1).
 *
 * Every case here is a rule the setup flow depends on: a muted read must not
 * echo, a non-TTY stdin must be refused rather than read, `yes` must be exact,
 * and a forced choice must give up after three unanswered attempts instead of
 * quietly picking something.
 */
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CHOICE_ATTEMPTS,
  NonInteractiveError,
  PromptAbortedError,
  createPrompter,
  promptChoice,
  promptPassword,
  promptYes,
} from '../../src/setup/prompt.js';
import type { Prompter } from '../../src/setup/prompt.js';

interface Harness {
  prompter: Prompter;
  /** Everything written to the prompt's output stream. */
  output(): string;
  /** Feed keystrokes. */
  send(text: string): void;
  rawModeCalls: boolean[];
}

function harness(options: { isTTY?: boolean } = {}): Harness {
  const input = new PassThrough();
  const rawModeCalls: boolean[] = [];
  const fake = input as unknown as {
    setRawMode?: (mode: boolean) => void;
    isTTY?: boolean;
  };
  const isTTY = options.isTTY ?? true;
  if (isTTY) {
    fake.setRawMode = (mode: boolean): void => {
      rawModeCalls.push(mode);
    };
    fake.isTTY = true;
  }

  let written = '';
  const prompter = createPrompter({
    input: input as never,
    output: {
      write(chunk: string) {
        written += chunk;
        return true;
      },
    },
    isTTY,
  });

  return {
    prompter,
    output: () => written,
    send: (text: string) => {
      input.write(text);
    },
    rawModeCalls,
  };
}

describe('promptPassword', () => {
  it('returns the typed bytes without echoing them (AC19.1)', async () => {
    const io = harness();
    const pending = promptPassword('비밀번호: ', io.prompter);
    io.send('P@ssw0rd-SENTINEL-9f3a\n');
    const password = await pending;

    expect(password.toString('utf8')).toBe('P@ssw0rd-SENTINEL-9f3a');
    expect(io.output()).toContain('비밀번호: ');
    expect(io.output()).not.toContain('P@ssw0rd-SENTINEL-9f3a');
    expect(io.output()).not.toContain('SENTINEL');
    // Muting is only real if the terminal was put into raw mode.
    expect(io.rawModeCalls).toEqual([true, false]);
    password.fill(0);
    expect(password.toString('utf8')).toBe('\0'.repeat(22));
  });

  it('accepts a password that arrives byte by byte', async () => {
    const io = harness();
    const pending = promptPassword('pw: ', io.prompter);
    for (const char of 'hunter2') io.send(char);
    io.send('\r');
    const password = await pending;
    expect(password.toString('utf8')).toBe('hunter2');
    expect(io.output()).not.toContain('hunter2');
  });

  it('applies backspace before the answer is returned', async () => {
    const io = harness();
    const pending = promptPassword('pw: ', io.prompter);
    io.send('abX\n');
    expect((await pending).toString('utf8')).toBe('ab');
  });

  it('refuses to read when stdin is not a TTY (AC17.12c)', async () => {
    const io = harness({ isTTY: false });
    await expect(promptPassword('pw: ', io.prompter)).rejects.toBeInstanceOf(NonInteractiveError);
    // Nothing was even asked: a piped password must not be consumed.
    expect(io.output()).toBe('');
  });

  it('rejects when the user interrupts with Ctrl-C', async () => {
    const io = harness();
    const pending = promptPassword('pw: ', io.prompter);
    io.send('half');
    await expect(pending).rejects.toMatchObject({ reason: 'interrupted' });
  });
});

describe('promptYes', () => {
  it.each([
    ['yes\n', true],
    ['yes\r\n', true],
    ['  yes  \n', true],
    ['YES\n', false],
    ['Yes\n', false],
    ['y\n', false],
    ['no\n', false],
    ['\n', false],
    ['yess\n', false],
  ])('treats %j as %s', async (typed, expected) => {
    const io = harness();
    const pending = promptYes('신뢰 [yes]: ', io.prompter);
    io.send(typed);
    expect(await pending).toBe(expected);
  });
});

describe('promptChoice', () => {
  it('returns a valid option', async () => {
    const io = harness();
    const pending = promptChoice('선택: ', ['token', 'fail-closed'], io.prompter);
    io.send('fail-closed\n');
    expect(await pending).toBe('fail-closed');
  });

  it('re-asks on an empty line and accepts a later answer', async () => {
    const io = harness();
    const pending = promptChoice('선택: ', ['token', 'fail-closed'], io.prompter);
    io.send('\n');
    io.send('token\n');
    expect(await pending).toBe('token');
    expect(io.output()).toContain('값을 입력해야 합니다');
  });

  it('gives up after three empty lines and never picks a default (AC17.12a)', async () => {
    const io = harness();
    const pending = promptChoice('선택: ', ['token', 'fail-closed'], io.prompter);
    io.send('\n\n\n');
    await expect(pending).rejects.toBeInstanceOf(PromptAbortedError);
    await expect(pending).rejects.toMatchObject({ reason: 'no-answer' });
    const asked = io.output().split('선택: ').length - 1;
    expect(asked).toBe(DEFAULT_CHOICE_ATTEMPTS);
  });

  it('rejects an unknown value and names the options', async () => {
    const io = harness();
    const pending = promptChoice('선택: ', ['token', 'fail-closed'], io.prompter, 2);
    io.send('maybe\n');
    io.send('token\n');
    expect(await pending).toBe('token');
    expect(io.output()).toContain('"maybe"는 선택할 수 없습니다');
    expect(io.output()).toContain('token 또는 fail-closed');
  });

  it('matches case-sensitively, with no aliases and no relaxations', async () => {
    const io = harness();
    const pending = promptChoice('선택: ', ['token', 'fail-closed'], io.prompter, 2);
    io.send('TOKEN\n');
    io.send('token\n');
    expect(await pending).toBe('token');
    expect(io.output()).toContain('"TOKEN"는 선택할 수 없습니다');
  });
});

describe('answer buffering across prompts', () => {
  it('keeps bytes typed ahead of the next question', async () => {
    const io = harness();
    // One chunk carrying three answers, as a scripted test stream would send.
    const password = promptPassword('pw: ', io.prompter);
    io.send('secret\nyes\ntoken\n');
    expect((await password).toString('utf8')).toBe('secret');
    expect(await promptYes('신뢰: ', io.prompter)).toBe(true);
    expect(await promptChoice('선택: ', ['token', 'fail-closed'], io.prompter)).toBe('token');
    expect(io.output()).not.toContain('secret');
  });
});

describe('createPrompter', () => {
  it('derives interactivity from the stream when not told', () => {
    const notATty = createPrompter({
      input: new PassThrough() as never,
      output: { write: vi.fn() },
    });
    expect(notATty.interactive).toBe(false);
  });
});
