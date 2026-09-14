/**
 * The interactive questions that have a safe default, on top of `@inquirer`.
 *
 * This replaces a hand-rolled arrow-key menu. That menu worked on Linux and in
 * WSL but kept mis-drawing on Windows Terminal — the title accumulated a line
 * per keypress — and we have no way to drive a Windows TTY from a test, so each
 * fix was a guess confirmed by a person. Terminal rendering across consoles is
 * exactly the kind of problem a widely used library has already solved; the
 * dependency buys correctness we cannot verify ourselves.
 *
 * Three rules keep this thin:
 *
 * - **The library is imported only when a question is actually asked.** A
 *   static import would be evaluated at start-up no matter where it sits, which
 *   would undo the dynamic sub-command imports in `src/index.ts` and put the
 *   cost on every server launch. Measured: 35 ms natively, 0.9 s for WSL
 *   reading `/mnt/d`.
 * - **Everything draws on stderr**, like every other prompt in this package, so
 *   stdout carries only what a caller would pipe.
 * - **The caller decides whether to ask at all.** {@link canPrompt} is the one
 *   place that answers "can this terminal show a question?"; everything else
 *   falls back to the documented non-interactive rule.
 *
 * Deliberately **not** used for the password, the host-key fingerprint `yes`,
 * or the approval-fallback choice. `@inquirer/select` always highlights a first
 * item, which is precisely what decision D3 forbids: there a stray Enter must
 * not be able to answer for the user. Those three keep `prompt.ts`.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14.
 */
import util from 'node:util';

import { errorMessage } from '../internal/util.js';
import { PromptAbortedError } from './prompt.js';

/** One row of a {@link askSelect} list. */
export interface SelectChoice<T extends string> {
  value: T;
  /** The line shown in the list. */
  name: string;
  /** Shown under the list while the row is highlighted. */
  description?: string;
}

export interface SelectQuestion<T extends string> {
  message: string;
  choices: readonly SelectChoice<T>[];
  /** Pre-highlighted value. Every question routed here has a documented default. */
  default?: T;
}

export interface TextQuestion {
  message: string;
  default?: string;
  /** Returns true to accept, or the sentence to show before asking again. */
  validate?: (answer: string) => true | string;
}

/** The two questions the CLIs ask, injectable so tests need no terminal. */
export interface Asker {
  select<T extends string>(question: SelectQuestion<T>): Promise<T>;
  text(question: TextQuestion): Promise<string>;
}

/** Streams a prompt reads from and draws on. Defaults to stdin and **stderr**. */
export interface AskStreams {
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
}

/**
 * Terminals that cannot render a list, whatever else they claim.
 *
 * `dumb` is the terminal saying it has no cursor addressing, which is exactly
 * what a redrawn list needs. An **empty** `TERM` counts the same: a shell that
 * sets the variable and leaves it blank is saying it knows of no terminal type,
 * and the menu this replaced refused it for that reason.
 */
const DUMB_TERMS: readonly string[] = ['dumb', ''];

/**
 * Can this terminal show a question?
 *
 * All three conditions matter. Keys come from stdin and the list draws on
 * stderr, so a redirected stderr would put the question in a log file while the
 * user stares at a stalled screen — which is why the answer here is "no" rather
 * than "ask in plainer text". Callers turn a `false` into the documented
 * non-interactive behaviour: a usage error, or the documented default.
 */
export function canPrompt(env: NodeJS.ProcessEnv = process.env, streams: AskStreams = {}): boolean {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stderr;
  if (input.isTTY !== true || output.isTTY !== true) return false;
  // `TERM` is unset on a plain Windows console, which is fine there; an empty
  // value only means "dumb" on a platform that sets the variable at all. The
  // comparison is normalised because `DUMB` and `dumb ` are the same terminal
  // saying the same thing — an exact match let both through.
  const term = env['TERM'];
  return term === undefined || !DUMB_TERMS.includes(term.trim().toLowerCase());
}

/**
 * The prompt library could not be loaded.
 *
 * Its own message would surface as "… was interrupted (Cannot find package …)",
 * which sends the reader looking for the wrong thing. The real cause is almost
 * always a Node older than `@inquirer` supports, so the message says which
 * version is required and which one is running.
 */
export class PromptUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      '대화형 질문을 불러오지 못했습니다. 이 명령은 Node 20.17 이상(또는 22.13+, 23.5+)이 ' +
        `필요합니다. 현재 ${process.version}. 인자를 모두 지정하면 질문 없이 실행됩니다. ` +
        `(${errorMessage(cause)})`
    );
    this.name = 'PromptUnavailableError';
  }
}

/**
 * Ctrl-C reaches us as inquirer's `ExitPromptError`.
 *
 * Translating it keeps one abort type across the package, so callers that
 * already handle `PromptAbortedError` from `prompt.ts` need no second branch
 * and the exit codes do not change. Matched by `name`, not by class, because
 * the class lives behind a dynamic import.
 */
function toPromptAborted(error: unknown): never {
  if (error instanceof Error && error.name === 'ExitPromptError') {
    throw new PromptAbortedError('interrupted', 'prompt interrupted (Ctrl-C)');
  }
  throw error;
}

/**
 * The list's footer, in the language the rest of the prompt is written in.
 *
 * The library hands the line over as `[key, action]` pairs and applies no
 * wording of its own beyond these two verbs, so translating them is the whole
 * job. An unknown pair is passed through rather than dropped: a future version
 * adding a key should still show it, in English, instead of hiding it.
 */
const HELP_ACTIONS: Readonly<Record<string, string>> = {
  navigate: '이동',
  select: '선택',
};

/**
 * Colour, when this Node has it.
 *
 * `util.styleText` landed in Node 20.12, and a named `import { styleText }`
 * would be a top-level binding the bundler hoists to the entry file — so an
 * older Node throws `SyntaxError` at instantiation and the whole CLI, server
 * mode included, dies before {@link MIN_NODE_MAJOR}'s guard can print anything.
 * Measured on Node 18.19.1. Reading it off the namespace at call time keeps the
 * words and drops only the colour.
 */
function paint(style: string, text: string): string {
  const styleText = (util as { styleText?: (s: string, t: string) => string }).styleText;
  return typeof styleText === 'function' ? styleText(style, text) : text;
}

function keysHelpTip(keys: readonly [key: string, action: string][]): string {
  return keys
    .map(([key, action]) => `${paint('bold', key)} ${paint('dim', HELP_ACTIONS[action] ?? action)}`)
    .join(paint('dim', ' • '));
}

/** Build an asker over the given streams. Only this touches `@inquirer`. */
export function createAsker(streams: AskStreams = {}): Asker {
  const context = {
    input: (streams.input ?? process.stdin) as NodeJS.ReadableStream,
    output: (streams.output ?? process.stderr) as NodeJS.WritableStream,
  };

  return {
    async select<T extends string>(question: SelectQuestion<T>): Promise<T> {
      const { default: select } = await import('@inquirer/select').catch((error: unknown) => {
        throw new PromptUnavailableError(error);
      });
      try {
        return await select<T>(
          {
            message: question.message,
            choices: question.choices.map((choice) => ({
              value: choice.value,
              name: choice.name,
              ...(choice.description === undefined ? {} : { description: choice.description }),
            })),
            ...(question.default === undefined ? {} : { default: question.default }),
            theme: { style: { keysHelpTip } },
          },
          context
        );
      } catch (error) {
        return toPromptAborted(error);
      }
    },

    async text(question: TextQuestion): Promise<string> {
      const { default: input } = await import('@inquirer/input').catch((error: unknown) => {
        throw new PromptUnavailableError(error);
      });
      try {
        return await input(
          {
            message: question.message,
            ...(question.default === undefined ? {} : { default: question.default }),
            ...(question.validate === undefined ? {} : { validate: question.validate }),
          },
          context
        );
      } catch (error) {
        return toPromptAborted(error);
      }
    },
  };
}

/** The asker the CLIs use: stdin in, stderr out. */
export const inquirerAsker: Asker = createAsker();
