/**
 * How `ssh-mcp host add` reports a question it could not ask.
 *
 * Three different reasons land in the same place and must read differently,
 * because the reader's next action differs for each: the terminal cannot draw a
 * list, the prompt library will not load on this Node, or the user pressed
 * Ctrl-C. Collapsing any two of them into one sentence sends somebody looking
 * for the wrong problem — which is exactly what happened when the library's
 * load failure surfaced nested inside "입력 중 오류가 발생했습니다 (…)".
 *
 * Everything here stops before the password, so no test needs a terminal or a
 * network. The tmp home is the usual guard: nothing may touch the real
 * `~/.ssh-mcp`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PromptUnavailableError } from '../../src/setup/ask.js';
import type { Asker } from '../../src/setup/ask.js';
import { runSetup } from '../../src/setup/cli.js';
import { PromptAbortedError } from '../../src/setup/prompt.js';
import type { Prompter } from '../../src/setup/prompt.js';
import { assertNoWritesOutside, createTmpHome } from '../fixtures/tmpHome.js';
import type { TmpHome } from '../fixtures/tmpHome.js';

let home: TmpHome;

beforeEach(() => {
  home = createTmpHome('ssh-mcp-setupcli-');
});

afterEach(() => {
  assertNoWritesOutside(home);
  home.cleanup();
});

/** A terminal for the steps that need one; the password must never be reached. */
function interactivePrompter(lines: string[]): Prompter {
  return {
    interactive: true,
    write: (text: string) => lines.push(text),
    writeLine: (text = '') => lines.push(`${text}\n`),
    readLine: () => Promise.reject(new Error('the password must never be asked for')),
    close: () => undefined,
  } as unknown as Prompter;
}

/** An asker whose every question fails the same way. */
function failingAsker(error: () => Error): Asker {
  return {
    select: () => Promise.reject(error()),
    text: () => Promise.reject(error()),
  };
}

describe('host add reports an unaskable question for what it is', () => {
  it('gives the library failure on its own, not nested in a generic sentence', async () => {
    const lines: string[] = [];
    const code = await runSetup([], {
      prompter: interactivePrompter(lines),
      canAsk: () => true,
      ask: failingAsker(() => new PromptUnavailableError(new Error('Cannot find package'))),
    });

    const text = lines.join('');
    expect(code).toBe(1);
    expect(text).toContain('대화형 질문을 불러오지 못했습니다');
    // The Node version is the actionable part; it must not be buried inside a
    // parenthesis appended to a sentence about "an error while reading input".
    expect(text).toContain('Node 20.17 이상');
    expect(text).not.toContain('입력 중 오류가 발생했습니다');
  });

  it('still reports Ctrl-C as an abort, which is not a failure to load anything', async () => {
    const lines: string[] = [];
    const code = await runSetup([], {
      prompter: interactivePrompter(lines),
      canAsk: () => true,
      ask: failingAsker(() => new PromptAbortedError('interrupted', 'prompt interrupted (Ctrl-C)')),
    });

    const text = lines.join('');
    expect(code).toBe(1);
    expect(text).toContain('입력이 중단되었습니다');
    expect(text).not.toContain('대화형 질문을 불러오지 못했습니다');
  });

  it('keeps the generic sentence for anything it does not recognise', async () => {
    const lines: string[] = [];
    const code = await runSetup([], {
      prompter: interactivePrompter(lines),
      canAsk: () => true,
      ask: failingAsker(() => new Error('something else entirely')),
    });

    const text = lines.join('');
    expect(code).toBe(1);
    expect(text).toContain('입력 중 오류가 발생했습니다');
    expect(text).toContain('something else entirely');
  });
});
