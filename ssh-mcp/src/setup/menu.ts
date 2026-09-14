/**
 * Arrow-key menu for the interactive CLIs.
 *
 * Built on Node's own `readline.emitKeypressEvents` plus raw mode and a handful
 * of ANSI sequences, because this package ships with three runtime dependencies
 * and a menu is not a good reason for a fourth. `prompt.ts` already puts the
 * terminal in raw mode for the password read, so the machinery is not new here.
 *
 * Three choices are worth explaining:
 *
 * - **Digits confirm immediately.** Arrow keys are the nice path, but they do
 *   not survive every terminal, multiplexer and remote session. A number key
 *   always works, and it lets the documentation say "press 2" instead of
 *   describing a cursor.
 * - **`preselect: null` highlights nothing** and ignores Enter until the user
 *   moves. That is the shape a question with no safe default needs — the
 *   approval-fallback choice in `setup` is exactly that (decision D3) — so the
 *   component supports it even though nothing uses it yet.
 * - **Keys arrive through an injected {@link KeySource}.** A test can then drive
 *   the whole component without a terminal, and only {@link terminalKeySource}
 *   ever touches `process.stdin`.
 *
 * The menu is for choices that already have a defined default. It is
 * deliberately **not** used for the password, the host-key fingerprint `yes`,
 * or the approval-fallback question: those are decisions where a stray Enter
 * must not be able to answer for the user.
 *
 * Not in the plan (`.omc/plans/ssh-mcp-plan.md`); added 2026-09-14.
 */
import readline from 'node:readline';

import { NonInteractiveError, PromptAbortedError } from './prompt.js';

/** Move the cursor up `n` rows. */
const cursorUp = (n: number): string => `\x1b[${String(n)}A`;
/** Return to column 0 and clear the line. */
const CLEAR_LINE = '\r\x1b[2K';
/** Clear from the cursor to the end of the screen. */
const ERASE_BELOW = '\x1b[0J';
/** Marks the highlighted row. */
export const MENU_CURSOR = '❯';
/** Rows past this many lose their number shortcut; there is no `10` key. */
const MAX_NUMBERED = 9;
/** Assumed width when the terminal does not report one. */
export const DEFAULT_COLUMNS = 80;
/** Marks a row the terminal was too narrow to show in full. */
const ELLIPSIS = '…';
/** Below this a hint is noise rather than help, so the row drops it entirely. */
const MIN_HINT_WIDTH = 8;
/** The one line of instructions, kept off the title so the title can stay short. */
export const MENU_CONTROLS = '  (↑↓ 이동 · 숫자 즉시 선택 · Enter 확정)';

/** Ranges whose characters occupy no column of their own. */
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritics
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0x200d // zero-width joiner
  );
}

/**
 * Width of `text` in terminal columns.
 *
 * Deliberately **over**-estimating: every non-ASCII character that is not a
 * known zero-width one counts as two. Guessing too wide only truncates a row
 * earlier than strictly necessary; guessing too narrow lets a row wrap, and a
 * wrapped row breaks the cursor arithmetic the redraw depends on — which is
 * exactly the defect this replaced (a Korean title at 85 columns wrapped in an
 * 80-column window and the menu walked down the screen on every keypress).
 */
export function displayWidth(text: string): number {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // control characters draw nothing
    if (code < 0x7f) {
      total += 1;
      continue;
    }
    if (isZeroWidth(code)) continue;
    total += 2;
  }
  return total;
}

/** Cut `text` to `limit` columns, marking the cut with an ellipsis. */
export function truncateToWidth(text: string, limit: number): string {
  if (limit <= 0) return '';
  if (displayWidth(text) <= limit) return text;
  const budget = limit - displayWidth(ELLIPSIS);
  if (budget <= 0) return '';
  let out = '';
  let width = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (width + charWidth > budget) break;
    out += char;
    width += charWidth;
  }
  return `${out}${ELLIPSIS}`;
}

/**
 * How many physical rows `rows` occupies.
 *
 * With correct truncation this always equals `rows.length`; it is computed
 * anyway so that a row which slips through too wide still moves the cursor by
 * the right amount instead of corrupting every later frame.
 */
export function menuHeight(rows: readonly string[], columns: number): number {
  const width = Math.max(1, columns);
  return rows.reduce((total, row) => total + Math.max(1, Math.ceil(displayWidth(row) / width)), 0);
}

/** One keystroke, in the shape `readline`'s `keypress` event provides. */
export interface KeyEvent {
  /** `up`, `down`, `return`, `c`, `2`, … Empty when readline names nothing. */
  name: string;
  /** The raw characters the key produced. */
  sequence: string;
  ctrl: boolean;
}

export type KeyListener = (event: KeyEvent) => void;

/**
 * Subscribe to keystrokes. The returned function unsubscribes and restores
 * whatever terminal state the source changed.
 */
export type KeySource = (listener: KeyListener) => () => void;

/** Synthesised by a {@link KeySource} when the input stream ends. */
export const KEY_EOF = 'eof';

export interface MenuItem<T extends string> {
  value: T;
  label: string;
  /** Shown dimly after the label; the place for "detected at <path>". */
  hint?: string;
}

export interface MenuOptions<T extends string> {
  title: string;
  items: readonly MenuItem<T>[];
  /** Row highlighted at the start. `null` highlights nothing and ignores Enter. */
  preselect: number | null;
}

export interface MenuIo {
  /** Where the menu draws. Always stderr in this package. */
  write(text: string): void;
  /** Terminal width, read fresh on every frame. Defaults to {@link DEFAULT_COLUMNS}. */
  columns?: () => number;
  keys: KeySource;
}

/**
 * Terminals that cannot render the menu, whatever else they claim.
 *
 * `TERM=dumb` is the terminal saying it has no cursor addressing, which is
 * exactly what the redraw needs. Emacs' shell mode and some CI shells set it
 * while still being interactive, so the caller falls back to a typed question
 * rather than refusing to ask.
 */
const DUMB_TERMS: readonly string[] = ['dumb', ''];

/**
 * A key source over the real terminal, or **null** when this is not one.
 *
 * Three conditions, all necessary. The keys come from stdin and the drawing
 * goes to stderr, so both have to be a TTY — a redirected stderr would collect
 * escape sequences nobody can see instead of a menu. And `TERM` has to describe
 * a terminal that can move a cursor.
 *
 * Everything here is platform-neutral on purpose: the caller works the same on
 * a Windows console and inside WSL, and `readline` normalises the key names on
 * both.
 */
export function terminalKeySource(
  input: NodeJS.ReadStream = process.stdin,
  output: { isTTY?: boolean } = process.stderr,
  env: NodeJS.ProcessEnv = process.env
): KeySource | null {
  if (input.isTTY !== true || output.isTTY !== true) return null;
  // `TERM` is unset on a plain Windows console, which is fine there; treat an
  // empty value as dumb only when the platform is one that sets it.
  const term = env['TERM'];
  if (term !== undefined && DUMB_TERMS.includes(term.trim().toLowerCase())) return null;

  let listener: KeyListener | null = null;
  let attached = false;
  let wasRaw = false;
  /**
   * Keys `readline` emitted while no prompt was listening.
   *
   * **This buffer is why two menus in a row work.** One `data` chunk can carry
   * several keystrokes, and `readline` turns the whole chunk into `keypress`
   * events in one synchronous burst. The first menu confirms on its key and
   * unsubscribes *during* that burst, so every remaining event in the same
   * chunk would reach no listener at all and vanish — the second menu then
   * waits for a key the terminal already delivered. Measured under a WSL pty:
   * `\r\x1b[B\r` in one chunk left the second menu hanging.
   *
   * `Prompter` solves the same problem with its own `#pending` bytes.
   */
  let pending: KeyEvent[] = [];
  /** Drops {@link pending} once a whole loop turn passes with nobody listening. */
  let expiry: NodeJS.Immediate | null = null;

  /**
   * Start the clock on {@link pending}.
   *
   * Called from both the unsubscribe **and** `deliver`. Scheduling it only on
   * unsubscribe left a hole: keys that arrive later, while a text prompt owns
   * the terminal, queue with no expiry running and are replayed into whatever
   * menu opens next. Measured: a menu, an alias typed at a text question, then
   * a second menu that confirmed itself on the leftover newline.
   */
  const scheduleExpiry = (): void => {
    if (expiry !== null) return;
    expiry = setImmediate(() => {
      expiry = null;
      pending = [];
    });
    expiry.unref();
  };

  const deliver = (event: KeyEvent): void => {
    if (listener === null) {
      pending.push(event);
      scheduleExpiry();
      return;
    }
    listener(event);
  };

  const onKeypress = (
    str: string | undefined,
    key: { name?: string; ctrl?: boolean; sequence?: string } | undefined
  ): void => {
    deliver({
      name: key?.name ?? '',
      sequence: key?.sequence ?? str ?? '',
      ctrl: key?.ctrl === true,
    });
  };
  const onEnd = (): void => {
    deliver({ name: KEY_EOF, sequence: '', ctrl: false });
  };

  /**
   * Subscribe to `readline` once and **never unsubscribe**.
   *
   * This is what makes {@link pending} reachable at all. `readline` turns one
   * chunk into a burst of `keypress` emissions; if the listener were removed
   * when a menu confirms, the rest of that burst would be emitted to an empty
   * listener list and never reach this module to be queued. Measured: removing
   * it loses every key after the confirming one.
   */
  const listen = (): void => {
    if (attached) return;
    attached = true;
    readline.emitKeypressEvents(input);
    wasRaw = input.isRaw === true;
    input.on('keypress', onKeypress);
    input.on('end', onEnd);
  };

  /** Raw mode and flow are per prompt; the listener above is not. */
  const takeTerminal = (): void => {
    listen();
    if (typeof input.setRawMode === 'function') input.setRawMode(true);
    input.resume();
  };

  const releaseTerminal = (): void => {
    // Restore rather than force off, and do it synchronously: a text prompt may
    // start reading in the very next microtask and needs cooked mode back.
    if (typeof input.setRawMode === 'function') input.setRawMode(wasRaw);
    input.pause();
  };

  return (next: KeyListener): (() => void) => {
    if (expiry !== null) {
      clearImmediate(expiry);
      expiry = null;
    }
    listener = next;
    takeTerminal();

    if (pending.length > 0) {
      const queued = pending;
      pending = [];
      // Asynchronously, so the caller has its unsubscribe handle before any of
      // these can make it confirm.
      queueMicrotask(() => {
        while (queued.length > 0) {
          if (listener !== next) {
            // This prompt is done; the rest belongs to whatever comes next.
            pending.unshift(...queued);
            return;
          }
          const event = queued.shift();
          if (event === undefined) return;
          next(event);
        }
      });
    }

    return (): void => {
      if (listener !== next) return;
      listener = null;
      releaseTerminal();
      // A prompt that follows immediately runs in a microtask and claims these
      // keys first. Anything still here after the loop turns over belongs to no
      // prompt and would surprise a later one.
      scheduleExpiry();
    };
  };
}

/**
 * Build the rows for one frame, each guaranteed to fit on one physical line.
 *
 * Every row is cut to `columns - 1`: leaving the last column empty keeps
 * terminals that wrap on the final character from inserting a line of their
 * own. Item rows give up their hint before their label, because the label is
 * the answer and the hint is only context.
 */
export function renderMenu<T extends string>(
  options: MenuOptions<T>,
  selected: number | null,
  columns: number = DEFAULT_COLUMNS
): string[] {
  const limit = Math.max(1, columns - 1);

  const item = (entry: MenuItem<T>, index: number): string => {
    const marker = index === selected ? MENU_CURSOR : ' ';
    const number = index < MAX_NUMBERED ? `${String(index + 1)}) ` : '   ';
    const head = `${marker} ${number}${entry.label}`;
    if (entry.hint === undefined) return truncateToWidth(head, limit);
    const room = limit - displayWidth(head) - displayWidth('  ()');
    if (room < MIN_HINT_WIDTH) return truncateToWidth(head, limit);
    return `${head}  (${truncateToWidth(entry.hint, room)})`;
  };

  return [
    truncateToWidth(options.title, limit),
    truncateToWidth(MENU_CONTROLS, limit),
    ...options.items.map(item),
  ];
}

/**
 * Ask the user to pick one item.
 *
 * Resolves with the chosen `value`. Throws {@link PromptAbortedError} on Ctrl-C
 * or end of input, and {@link NonInteractiveError} when called with no item.
 */
export async function promptMenu<T extends string>(
  io: MenuIo,
  options: MenuOptions<T>
): Promise<T> {
  if (options.items.length === 0) {
    throw new Error('promptMenu needs at least one item');
  }

  // An index outside the list is treated as "nothing selected" rather than
  // silently swallowing Enter, which is what an out-of-range value used to do.
  const start = options.preselect;
  let selected = start === null || start < 0 || start >= options.items.length ? null : start;
  let drawn = 0;

  const draw = (): void => {
    // Read the width every frame: a window resized between keystrokes then
    // takes effect on the next redraw, with no resize listener to unhook.
    const columns = io.columns?.() ?? DEFAULT_COLUMNS;
    const rows = renderMenu(options, selected, columns);
    const body = rows.map((row) => `${CLEAR_LINE}${row}\n`).join('');
    io.write(drawn > 0 ? `${cursorUp(drawn)}${body}` : body);
    drawn = menuHeight(rows, columns);
  };

  const erase = (): void => {
    if (drawn === 0) return;
    io.write(`${cursorUp(drawn)}\r${ERASE_BELOW}`);
    drawn = 0;
  };

  return new Promise<T>((resolve, reject) => {
    let stop: (() => void) | null = null;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      stop?.();
      fn();
    };

    const confirm = (index: number): void => {
      const item = options.items[index];
      if (item === undefined) return;
      finish(() => {
        // Replace the menu with a single line, so a transcript of the session
        // reads as a list of answers rather than a screenful of redraws.
        erase();
        io.write(`선택: ${item.label}\n`);
        resolve(item.value);
      });
    };

    const move = (delta: number): void => {
      const count = options.items.length;
      selected =
        selected === null ? (delta > 0 ? 0 : count - 1) : (selected + delta + count) % count;
      draw();
    };

    const onKey = (event: KeyEvent): void => {
      if (settled) return;

      if (event.name === KEY_EOF || (event.ctrl && event.name === 'd')) {
        finish(() => {
          erase();
          reject(new PromptAbortedError('eof', 'menu closed before an answer arrived'));
        });
        return;
      }
      if (event.ctrl && event.name === 'c') {
        finish(() => {
          erase();
          reject(new PromptAbortedError('interrupted', 'menu interrupted (Ctrl-C)'));
        });
        return;
      }

      if (event.name === 'up' || event.name === 'k') return move(-1);
      if (event.name === 'down' || event.name === 'j') return move(1);

      if (/^[1-9]$/.test(event.sequence)) {
        const index = Number.parseInt(event.sequence, 10) - 1;
        if (index < options.items.length) confirm(index);
        return;
      }

      if (event.name === 'return' || event.name === 'enter') {
        // Nothing is highlighted yet: redraw instead of answering for the user.
        if (selected === null) {
          draw();
          return;
        }
        confirm(selected);
      }
    };

    draw();
    stop = (io.keys as KeySource)(onKey);
    if (settled) stop();
  });
}

/** Width the terminal reports, or {@link DEFAULT_COLUMNS} when it reports none. */
export function terminalColumns(output: { columns?: number } = process.stderr): number {
  const value = output.columns;
  return typeof value === 'number' && value > 0 ? value : DEFAULT_COLUMNS;
}

/** Replace a leading home directory with `~`, so a path fits a menu hint. */
export function shortenHome(target: string, home: string): string {
  if (home === '' || !target.startsWith(home)) return target;
  return `~${target.slice(home.length)}`;
}

/** Re-exported so callers can catch both prompt failures from one import. */
export { NonInteractiveError, PromptAbortedError };
