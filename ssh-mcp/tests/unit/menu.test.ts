/**
 * The arrow-key menu (`src/setup/menu.ts`).
 *
 * The component owns two things that are easy to get subtly wrong and
 * impossible to notice in a passing build: which item a key sequence lands on,
 * and whether a stray Enter can answer a question that has no default. Both are
 * pinned here.
 *
 * Keys arrive through an injected `KeySource`, so none of this needs a
 * terminal — which is also the reason the source is injectable at all.
 */
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COLUMNS,
  MENU_CONTROLS,
  MENU_CURSOR,
  PromptAbortedError,
  displayWidth,
  menuHeight,
  promptMenu,
  renderMenu,
  shortenHome,
  terminalColumns,
  terminalKeySource,
} from '../../src/setup/menu.js';
import type { KeyEvent, KeySource, MenuIo, MenuOptions } from '../../src/setup/menu.js';
import { createPrompter } from '../../src/setup/prompt.js';

type Choice = 'one' | 'two' | 'three';

const ITEMS: MenuOptions<Choice>['items'] = [
  { value: 'one', label: '첫째', hint: '힌트 1' },
  { value: 'two', label: '둘째' },
  { value: 'three', label: '셋째' },
];

/** Replay a key sequence the way a terminal delivers it: never during subscribe. */
function scriptedKeys(events: readonly Partial<KeyEvent>[]): KeySource {
  return (listener) => {
    let stopped = false;
    void (async (): Promise<void> => {
      for (const event of events) {
        await Promise.resolve();
        if (stopped) return;
        listener({ name: '', sequence: '', ctrl: false, ...event });
      }
    })();
    return (): void => {
      stopped = true;
    };
  };
}

function menuIo(events: readonly Partial<KeyEvent>[]): { io: MenuIo; output: () => string } {
  let written = '';
  return {
    io: {
      write: (text: string): void => {
        written += text;
      },
      keys: scriptedKeys(events),
    },
    output: (): string => written,
  };
}

function run(
  events: readonly Partial<KeyEvent>[],
  preselect: number | null = 0
): { result: Promise<Choice>; output: () => string } {
  const { io, output } = menuIo(events);
  return { result: promptMenu<Choice>(io, { title: '고르세요', items: ITEMS, preselect }), output };
}

const WIDE = 200;

describe('renderMenu', () => {
  it('marks only the selected row and numbers every row', () => {
    const rows = renderMenu({ title: 'T', items: ITEMS, preselect: 1 }, 1, WIDE);
    expect(rows[0]).toBe('T');
    expect(rows[1]).toBe(MENU_CONTROLS);
    expect(rows[2]).toBe('  1) 첫째  (힌트 1)');
    expect(rows[3]).toBe(`${MENU_CURSOR} 2) 둘째`);
    expect(rows[4]).toBe('  3) 셋째');
  });

  it('marks nothing when preselect is null', () => {
    const rows = renderMenu({ title: 'T', items: ITEMS, preselect: null }, null, WIDE);
    expect(rows.every((row) => !row.startsWith(MENU_CURSOR))).toBe(true);
  });

  it('keeps the instructions off the title, so the title can stay short', () => {
    const rows = renderMenu({ title: '고르세요', items: ITEMS, preselect: 0 }, 0, WIDE);
    expect(rows[0]).toBe('고르세요');
    expect(rows[0]).not.toContain('↑↓');
    expect(rows[1]).toContain('↑↓');
  });
});

/**
 * The width rules exist because of a measured defect: a Korean title is about
 * 85 columns wide, an 80-column window wrapped it onto two physical lines, and
 * `cursorUp` moved by the logical row count — so every keypress pushed the menu
 * one line further down and the title appeared to repeat.
 */
describe('row widths', () => {
  const LONG_TITLE = '어느 클라이언트에 등록할까요? 아주 긴 제목을 넣어 확실히 넘기겠습니다';
  const LONG_ITEMS: MenuOptions<Choice>['items'] = [
    { value: 'one', label: 'Claude Code', hint: 'C:\\Users\\someone\\.local\\bin\\claude.exe' },
    { value: 'two', label: 'Claude Desktop', hint: '감지되지 않음(WSL에서는 접근하지 않습니다)' },
    { value: 'three', label: '둘 다', hint: '위 두 가지를 차례로 등록합니다' },
  ];

  it('fits every row inside columns - 1 at a narrow width', () => {
    const rows = renderMenu({ title: LONG_TITLE, items: LONG_ITEMS, preselect: 0 }, 0, 40);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(39);
  });

  it('marks a cut row with an ellipsis', () => {
    const rows = renderMenu({ title: LONG_TITLE, items: LONG_ITEMS, preselect: 0 }, 0, 40);
    expect(rows[0]?.endsWith('…')).toBe(true);
    expect(rows[0]).not.toBe(LONG_TITLE);
  });

  it('gives up the hint before the label', () => {
    const rows = renderMenu({ title: 'T', items: LONG_ITEMS, preselect: 0 }, 0, 30);
    // The label survives even when there is no room left for its hint.
    expect(rows[2]).toContain('Claude Code');
  });

  it('keeps physical rows equal to logical rows at every width', () => {
    for (const columns of [30, 40, 60, 80, 120, 200]) {
      const rows = renderMenu({ title: LONG_TITLE, items: LONG_ITEMS, preselect: 1 }, 1, columns);
      expect(menuHeight(rows, columns)).toBe(rows.length);
    }
  });

  it('assumes 80 columns when the terminal reports none', () => {
    expect(DEFAULT_COLUMNS).toBe(80);
    expect(terminalColumns({})).toBe(80);
    expect(terminalColumns({ columns: 0 })).toBe(80);
    expect(terminalColumns({ columns: 132 })).toBe(132);
    const rows = renderMenu({ title: LONG_TITLE, items: LONG_ITEMS, preselect: 0 }, 0);
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(79);
  });

  it('counts Korean as two columns and combining marks as none', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('한글')).toBe(4);
    expect(displayWidth('e\u0301')).toBe(1);
    expect(displayWidth('')).toBe(0);
  });

  it('shortens a home-directory path for a hint', () => {
    expect(shortenHome('/home/me/.local/bin/claude', '/home/me')).toBe('~/.local/bin/claude');
    expect(shortenHome('/usr/local/bin/claude', '/home/me')).toBe('/usr/local/bin/claude');
    expect(shortenHome('/home/me/x', '')).toBe('/home/me/x');
  });
});

describe('promptMenu', () => {
  it('moves down and confirms with Enter', async () => {
    const { result, output } = run([{ name: 'down' }, { name: 'return' }]);
    expect(await result).toBe('two');
    expect(output()).toContain('선택: 둘째');
  });

  it('accepts j and k as well as the arrows', async () => {
    const down = run([{ name: 'j' }, { name: 'j' }, { name: 'return' }]);
    expect(await down.result).toBe('three');

    const up = run([{ name: 'k' }, { name: 'return' }]);
    expect(await up.result).toBe('three');
  });

  it('confirms immediately on a number key, without Enter', async () => {
    const { result, output } = run([{ name: '2', sequence: '2' }]);
    expect(await result).toBe('two');
    expect(output()).toContain('선택: 둘째');
  });

  it('ignores a number key past the end of the list', async () => {
    const { result } = run([{ name: '9', sequence: '9' }, { name: 'return' }]);
    expect(await result).toBe('one');
  });

  it('ignores Enter until something is selected when preselect is null', async () => {
    const { result, output } = run(
      [{ name: 'return' }, { name: 'down' }, { name: 'return' }],
      null
    );
    expect(await result).toBe('one');
    // The ignored Enter redraws rather than answering, so the frame count grows.
    expect(output().split('고르세요').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('wraps around at both ends', async () => {
    const up = run([{ name: 'up' }, { name: 'return' }]);
    expect(await up.result).toBe('three');

    const down = run([{ name: 'down' }, { name: 'down' }, { name: 'down' }, { name: 'return' }]);
    expect(await down.result).toBe('one');
  });

  it('aborts on end of input', async () => {
    const { result } = run([{ name: 'eof' }]);
    await expect(result).rejects.toBeInstanceOf(PromptAbortedError);
    await expect(result).rejects.toMatchObject({ reason: 'eof' });
  });

  it('aborts on Ctrl-C and on Ctrl-D', async () => {
    const interrupted = run([{ name: 'c', ctrl: true }]);
    await expect(interrupted.result).rejects.toMatchObject({ reason: 'interrupted' });

    const eof = run([{ name: 'd', ctrl: true }]);
    await expect(eof.result).rejects.toMatchObject({ reason: 'eof' });
  });

  it('redraws in place and clears itself when done', async () => {
    const { result, output } = run([{ name: 'down' }, { name: 'return' }]);
    await result;
    const text = output();
    // Title, instructions and three items, so a redraw rewinds five lines.
    expect(text).toContain('\x1b[5A');
    expect(text).toContain('\x1b[2K');
    // And the menu is erased before the one-line answer replaces it.
    expect(text).toContain('\x1b[0J');
    expect(text.endsWith('선택: 둘째\n')).toBe(true);
  });

  // An out-of-range index used to leave Enter silently doing nothing, which
  // reads as a frozen menu.
  it('treats an out-of-range preselect as nothing selected', async () => {
    const high = run([{ name: 'return' }, { name: 'down' }, { name: 'return' }], 9);
    expect(await high.result).toBe('one');

    const negative = run([{ name: 'return' }, { name: 'up' }, { name: 'return' }], -1);
    expect(await negative.result).toBe('three');
  });

  it('rejects an empty item list', async () => {
    const { io } = menuIo([]);
    await expect(promptMenu(io, { title: 'T', items: [], preselect: 0 })).rejects.toThrow(
      /at least one item/u
    );
  });
});

/**
 * The real key source, driven through a fake TTY.
 *
 * These reproduce a defect measured under a WSL pty: two menus in a row, and
 * the second one never saw a key. One `data` chunk becomes several `keypress`
 * events in a single synchronous burst, the first menu unsubscribes in the
 * middle of that burst, and everything after its own key reached no listener.
 */
describe('terminalKeySource over a fake terminal', () => {
  interface FakeTty {
    stream: NodeJS.ReadStream;
    write(text: string): void;
    rawModeCalls: boolean[];
  }

  function fakeTty(): FakeTty {
    const stream = new PassThrough() as unknown as NodeJS.ReadStream & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(flag: boolean): NodeJS.ReadStream;
    };
    const rawModeCalls: boolean[] = [];
    stream.isTTY = true;
    stream.isRaw = false;
    stream.setRawMode = (flag: boolean): NodeJS.ReadStream => {
      rawModeCalls.push(flag);
      stream.isRaw = flag;
      return stream;
    };
    return {
      stream,
      write: (text: string): void => {
        (stream as unknown as PassThrough).write(text);
      },
      rawModeCalls,
    };
  }

  function menuOver(keys: KeySource, preselect = 0): Promise<Choice> {
    return promptMenu<Choice>(
      { write: () => undefined, keys },
      {
        title: 'T',
        items: ITEMS,
        preselect,
      }
    );
  }

  it('hands the keys of one chunk to two menus in a row', async () => {
    const tty = fakeTty();
    const keys = terminalKeySource(tty.stream, { isTTY: true }, {});
    expect(keys).not.toBeNull();

    const first = menuOver(keys as KeySource);
    const second = first.then(() => menuOver(keys as KeySource));

    // Enter, then down + Enter — all in one write, as a pty delivers them.
    tty.write('\r\x1b[B\r');

    expect(await first).toBe('one');
    expect(await second).toBe('two');
  });

  it('keeps the terminal in raw mode for the second menu', async () => {
    const tty = fakeTty();
    const keys = terminalKeySource(tty.stream, { isTTY: true }, {}) as KeySource;
    const first = menuOver(keys);
    const second = first.then(() => menuOver(keys));
    tty.write('\r\x1b[B\r');
    await second;
    // On at the start of each menu, restored in between and at the end.
    expect(tty.rawModeCalls).toEqual([true, false, true, false]);
    expect(tty.stream.isRaw).toBe(false);
  });

  // Reported: menu → text answer → menu confirmed itself with no key pressed.
  // The newline ending the text answer had been queued while no prompt was
  // listening, and nothing expired it because only an unsubscribe scheduled the
  // expiry — and no menu had unsubscribed since.
  it('does not replay a text answer typed between two menus', async () => {
    const tty = fakeTty();
    const keys = terminalKeySource(tty.stream, { isTTY: true }, {}) as KeySource;

    // A text question over the same stream, exactly as the wizard has between
    // its menu and the next one. `readLine` resumes the stream, so readline
    // turns the typed answer into keypress events with no menu listening.
    const prompter = createPrompter({
      input: tty.stream as never,
      output: { write: () => true },
      isTTY: true,
    });

    const first = menuOver(keys);
    tty.write('\r');
    expect(await first).toBe('one');

    // Let the menu's own expiry fire before anything is typed. A person answers
    // the next question later than this, which is exactly the case where only
    // an unsubscribe-scheduled expiry leaves the queue running forever.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const line = prompter.readLine({ muted: false });
    tty.write('myalias\r');
    expect((await line).toString('utf8')).toBe('myalias');
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The second menu must wait for a real key, not confirm on the leftover.
    let settledEarly = false;
    const second = menuOver(keys).then((value) => {
      settledEarly = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settledEarly).toBe(false);

    tty.write('\x1b[B\r');
    expect(await second).toBe('two');
  });

  it('drops the rest of a chunk when no prompt follows it', async () => {
    const tty = fakeTty();
    const keys = terminalKeySource(tty.stream, { isTTY: true }, {}) as KeySource;

    // One chunk carrying a stray key after the answer, then nothing listens.
    expect(
      await (async (): Promise<Choice> => {
        const pending = menuOver(keys);
        tty.write('\r\x1b[B');
        return pending;
      })()
    ).toBe('one');

    // Let the loop turn over, which is what expires the stray key.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const later = menuOver(keys);
    tty.write('\r');
    // The stray `down` did not move this menu's cursor.
    expect(await later).toBe('one');
  });
});

describe('terminalKeySource', () => {
  const tty = { isTTY: true } as unknown as NodeJS.ReadStream;
  const notTty = { isTTY: false } as unknown as NodeJS.ReadStream;

  it('is null unless both stdin and stderr are terminals', () => {
    expect(terminalKeySource(notTty, { isTTY: true }, {})).toBeNull();
    expect(terminalKeySource(tty, { isTTY: false }, {})).toBeNull();
    expect(terminalKeySource(notTty, { isTTY: false }, {})).toBeNull();
  });

  // The redraw needs cursor addressing. A terminal that says it has none is
  // taken at its word, and the caller asks the same question as plain text.
  it('is null for TERM=dumb and for an empty TERM', () => {
    expect(terminalKeySource(tty, { isTTY: true }, { TERM: 'dumb' })).toBeNull();
    expect(terminalKeySource(tty, { isTTY: true }, { TERM: 'DUMB' })).toBeNull();
    expect(terminalKeySource(tty, { isTTY: true }, { TERM: '  ' })).toBeNull();
  });

  it('is usable for a normal TERM and when TERM is unset', () => {
    // Unset is the plain Windows console, which handles the sequences fine.
    expect(terminalKeySource(tty, { isTTY: true }, {})).not.toBeNull();
    expect(terminalKeySource(tty, { isTTY: true }, { TERM: 'xterm-256color' })).not.toBeNull();
  });
});
