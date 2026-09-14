/**
 * Choosing the Claude Code scope for `ssh-mcp install claude-code`.
 *
 * **Why this asks instead of just defaulting.** `claude mcp add` defaults to
 * `local`, which means "visible only from the directory you happened to be
 * standing in". A one-line setup command is naturally run from wherever the
 * terminal already is — a home directory, a downloads folder — so the default
 * quietly registers the server for a directory the user will never open Claude
 * Code in, and the tools are then missing in every real project. The command
 * looked like it worked and the failure appears somewhere else entirely, which
 * is the worst shape a default can have.
 *
 * So the scope is asked once, in the terminal, when `--scope` is absent. Two
 * rules keep that from becoming its own problem:
 *
 * - **An explicit `--scope` is never second-guessed.** The documented one-line
 *   commands and any script built on them must stay non-interactive.
 * - **A non-TTY run never blocks.** It keeps the `local` default and says, in
 *   one line, what that means and how to change it. Hanging on a prompt nobody
 *   can answer would be worse than the wrong default.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14 with the
 * rest of `install/`.
 */
import { errorMessage } from '../internal/util.js';
import { DEFAULT_CHOICE_ATTEMPTS, PromptAbortedError, promptChoice } from '../setup/prompt.js';
import type { Prompter } from '../setup/prompt.js';

/** Scopes accepted by `claude mcp add -s`. */
export const CLAUDE_CODE_SCOPES = ['local', 'user', 'project'] as const;
export type ClaudeCodeScope = (typeof CLAUDE_CODE_SCOPES)[number];

/** What `claude mcp add` itself defaults to, and therefore what we default to. */
export const DEFAULT_CLAUDE_CODE_SCOPE: ClaudeCodeScope = 'local';

/** Only `local` and `user` are offered; `project` writes a shared file and must be deliberate. */
const OFFERED_SCOPES: readonly ClaudeCodeScope[] = ['local', 'user'];

const SCOPE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  local: ['1'],
  user: ['2'],
};

/** The question, with the directory `local` would actually bind to spelled out. */
export function buildScopePrompt(cwd: string): string {
  return [
    'Claude Code 어디에 등록할까요?',
    `  1) 이 프로젝트만 (local)  — ${cwd} 에서 연 Claude Code에만 보입니다. Claude Code의 기본값입니다.`,
    '  2) 모든 프로젝트 (user)   — 어느 디렉터리에서 열어도 보입니다.',
    '팀과 저장소로 공유하려면 --scope project 를 직접 지정하세요.',
    '선택 [1/2, Enter=1]: ',
  ].join('\n');
}

/** What a non-interactive run is told instead of being asked. */
export function nonInteractiveScopeNotice(cwd: string): string {
  return (
    `--scope를 지정하지 않아 Claude Code 기본값 local(${cwd}에서만 보임)로 등록합니다. ` +
    '모든 프로젝트에서 쓰려면 --scope user 를 지정하세요.'
  );
}

/**
 * One sentence on what the registration the user just made actually covers.
 * Printed on success, because "installed" is not the same as "visible here".
 */
export function scopeMeaning(scope: ClaudeCodeScope, cwd: string): string {
  switch (scope) {
    case 'local':
      return (
        `이 등록은 ${cwd}에서 연 Claude Code에서만 보입니다. ` +
        '모든 프로젝트에서 쓰려면 --scope user 로 다시 등록하세요.'
      );
    case 'user':
      return '모든 프로젝트에서 보입니다.';
    case 'project':
      return '.mcp.json에 기록되어 이 저장소를 공유하는 사람에게도 보입니다(첫 사용 시 승인 필요).';
  }
}

export interface ResolveScopeOptions {
  /** The `--scope` value, or null when the flag was absent. */
  requested: ClaudeCodeScope | null;
  prompter: Prompter;
  /** Absolute working directory — what `local` would bind to. */
  cwd: string;
  write: (text: string) => void;
}

/**
 * Settle on a scope. Returns null when the user was asked and gave no usable
 * answer, in which case the caller must register nothing.
 */
export async function resolveScope(options: ResolveScopeOptions): Promise<ClaudeCodeScope | null> {
  if (options.requested !== null) return options.requested;

  if (!options.prompter.interactive) {
    options.write(nonInteractiveScopeNotice(options.cwd));
    return DEFAULT_CLAUDE_CODE_SCOPE;
  }

  try {
    const answer = await promptChoice(
      buildScopePrompt(options.cwd),
      OFFERED_SCOPES,
      options.prompter,
      DEFAULT_CHOICE_ATTEMPTS,
      {
        defaultValue: DEFAULT_CLAUDE_CODE_SCOPE,
        caseInsensitive: true,
        aliases: SCOPE_ALIASES,
        invalidMessage: '1 또는 2를 입력하세요.',
      }
    );
    return answer === 'user' ? 'user' : DEFAULT_CLAUDE_CODE_SCOPE;
  } catch (error) {
    if (error instanceof PromptAbortedError) {
      options.write('');
      options.write(
        'ssh-mcp install: 등록할 scope를 선택하지 않았습니다. 아무것도 등록하지 않고 종료합니다.'
      );
      options.write('--scope local | user | project 를 직접 지정해 다시 실행할 수 있습니다.');
    } else {
      options.write(`ssh-mcp install: scope 선택이 중단되었습니다 (${errorMessage(error)}).`);
    }
    return null;
  }
}
