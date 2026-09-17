/**
 * `df`/`ps` fixed-column parsers against a corpus of real output shapes
 * (plan rows E4·E5, AC-J4).
 *
 * The parsers are the only part of `format: "json"` that reads a table instead
 * of JSON, so the thing worth testing is not "does it split on whitespace" but
 * "does it survive the three implementations people actually run". Hence the
 * corpus: GNU coreutils (ubuntu), busybox (alpine) and BSD (macos), each one
 * chosen for the trait it breaks a naive parser on.
 *
 * ## Provenance of `tests/fixtures/output/*.txt`
 *
 * These are raw captures with no comment syntax, so their origin is recorded
 * here instead of in the files.
 *
 * - **ubuntu** — column geometry taken from real output on WSL2 Ubuntu 24.04
 *   (`df (GNU coreutils) 9.4`, `ps from procps-ng 4.0.4`) and reproduced
 *   byte-for-byte by the generator that wrote these files: source column width
 *   `max(14, widest)` left-aligned, numeric columns `max(5, header, widest)`
 *   right-aligned, single-space separators; for `ps`, PID/PPID width 7 (the
 *   digits of `pid_max`), USER 8, STAT 4, VSZ 6, RSS 5, command unpadded. The
 *   mount and process tables themselves are composed to look like a server,
 *   because the WSL host's own table (`drivers`, `C:\`, `/usr/lib/wsl/lib`) is
 *   not what this parser will meet.
 * - **alpine** — reconstructed from busybox `coreutils/df.c` (header
 *   `"Filesystem           %-15sUsed Available %s Mounted on"`, row
 *   `"%-20s" " %9s " "%9s " "%9s %3u%% %s"`) and `procps/ps.c` (`out_spec`
 *   widths pid 5, ppid 5, user 8, stat 4, vsz 4, rss 4; headers left-aligned,
 *   pid/ppid values right-aligned; lines cut to `terminal_width`, which the
 *   `-o` code path narrows only `if (isatty(1))` and otherwise leaves at
 *   `MAX_WIDTH = 2*1024`).
 * - **macos** — reconstructed from apple-oss-distributions `file_cmds`
 *   `df/df.c` (row `%-*s %*s %*s %*s %5.0f%%  %s`, header `… Capacity  Mounted
 *   on`, `-P` meaning 512-byte blocks) and `adv_cmds` `ps/keyword.c` +
 *   `ps/print.c` (fixed widths pid 5, ppid 5, stat 4, vsz 8, rss 6, USER sized
 *   from the data, last left-justified column unpadded, and `args` carrying the
 *   header `ARGS`).
 *
 * ## What each file is here to prove
 *
 * | file            | trait |
 * |-----------------|-------|
 * | `df-ubuntu.txt` | a 66-character device path, spaces in **both** the source and the mount point, and a pseudo filesystem whose capacity is `-` |
 * | `df-alpine.txt` | a device name past busybox's 20-column field, which under `-P` stays on one line instead of wrapping, plus a mount point with a space |
 * | `df-macos.txt`  | 512-byte blocks (the unit must come from the header, not a constant), `map auto_home` as a source containing a space, and two `/Volumes/…` mount points with spaces |
 * | `ps-ubuntu.txt` | command lines with internal spaces and semicolons, a 180-character JVM argument list, a kernel thread, and a process title padded with a trailing space |
 * | `ps-alpine.txt` | human-readable VSZ/RSS (`1.5g`, `9.9m`) where procps prints kibibytes, and a long command line arriving whole |
 * | `ps-macos.txt`  | the `ARGS` header, and an executable path that itself contains spaces |
 *
 * Expectations here are literals read off the corpus, never values recomputed
 * from the module under test, and the header assertions check tokens rather
 * than padding so that cosmetic column widths are not frozen by accident.
 */
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DF_NORMALIZED_COMMAND,
  PS_COLUMNS,
  PS_NORMALIZED_COMMAND,
  parseDf,
  parsePs,
} from '../../src/output/tables.js';
import type { DfTable, PsTable, TableParseResult } from '../../src/output/tables.js';

const CORPUS = new URL('../fixtures/output/', import.meta.url);

/**
 * `\r` is stripped on read because the repository has no `.gitattributes` and a
 * checkout with `core.autocrlf=true` hands these files back with CRLF endings.
 * The parser tolerates that by design; the tests below must not depend on which
 * way the file was checked out.
 */
function corpus(name: string): string {
  return fs.readFileSync(fileURLToPath(new URL(name, CORPUS)), 'utf8').replace(/\r\n/g, '\n');
}

function headerTokens(name: string): string[] {
  return (corpus(name).split('\n')[0] ?? '').trim().split(/\s+/);
}

/** Narrow a result to its success case, failing with the reason if it is not. */
function ok<T>(result: TableParseResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected a parsed table, got ${result.reason} at line ${String(result.line)}`);
  }
  return result.value;
}

describe('normalized commands', () => {
  it('are the exact strings the rewrite table has to emit', () => {
    expect(DF_NORMALIZED_COMMAND).toBe('df -P');
    expect(PS_COLUMNS).toBe('pid,ppid,user,stat,vsz,rss,args');
    // The rewrite table appends the column list to `ps -eo`, so the two have to
    // stay one string: this is the assertion that fails if a caller rebuilds it.
    expect(PS_NORMALIZED_COMMAND).toBe('ps -eo pid,ppid,user,stat,vsz,rss,args');
  });

  it('list ps fields in the same order as the parsed row, with args last', () => {
    // The command and the parser have to agree; this is the gate that fails if
    // someone adds a column to one and not the other.
    const fields = PS_COLUMNS.split(',');
    expect(fields).toEqual(['pid', 'ppid', 'user', 'stat', 'vsz', 'rss', 'args']);

    const row = ok(parsePs(corpus('ps-ubuntu.txt'))).processes[0];
    expect(Object.keys(row ?? {})).toEqual([
      'pid',
      'ppid',
      'user',
      'stat',
      'vsz',
      'rss',
      // `args` is the only field whose name changes on the way out.
      'command',
    ]);
  });

  it('avoids the ps keywords busybox does not have', () => {
    // `pcpu` is commented out of busybox's out_spec and `etime`/`time` are
    // behind ENABLE_FEATURE_PS_TIME, so asking for them is `bad -o argument`
    // and a failed command rather than a missing column.
    expect(PS_NORMALIZED_COMMAND).not.toContain('pcpu');
    expect(PS_NORMALIZED_COMMAND).not.toContain('%cpu');
    expect(PS_NORMALIZED_COMMAND).not.toContain('etime');
    expect(PS_NORMALIZED_COMMAND).not.toContain('time');
  });
});

describe('df corpus', () => {
  it('reads every corpus file as POSIX -P output', () => {
    for (const name of ['df-ubuntu.txt', 'df-alpine.txt', 'df-macos.txt']) {
      const tokens = headerTokens(name);
      expect(tokens.slice(2)).toEqual(['Used', 'Available', 'Capacity', 'Mounted', 'on']);
      expect(tokens[0]).toBe('Filesystem');
      expect(tokens[1]).toMatch(/^\d+-blocks$/);
      expect(parseDf(corpus(name)).ok).toBe(true);
    }
  });

  it('parses GNU coreutils output, including spaces at both ends of a row', () => {
    const table: DfTable = ok(parseDf(corpus('df-ubuntu.txt')));
    expect(table.block_size_bytes).toBe(1024);
    expect(table.filesystems).toHaveLength(10);

    expect(table.filesystems[0]).toEqual({
      filesystem: 'tmpfs',
      blocks: '1608724',
      used: '1868',
      available: '1606856',
      capacity: '1%',
      mounted_on: '/run',
    });

    // A 66-character device path: the column is wide, the row is still one row.
    expect(table.filesystems[6]).toEqual({
      filesystem: '/dev/disk/by-id/nvme-Samsung_SSD_990_PRO_2TB_S7DPNU0X123456B-part3',
      blocks: '1921724416',
      used: '812993024',
      available: '1011092992',
      capacity: '45%',
      mounted_on: '/srv/data',
    });

    // The row that defeats splitting from either end: the CIFS source and the
    // mount point both contain a space.
    expect(table.filesystems[7]).toEqual({
      filesystem: '//fileserver.example.internal/team share',
      blocks: '524288000',
      used: '191234560',
      available: '333053440',
      capacity: '37%',
      mounted_on: '/mnt/team share',
    });

    // GNU prints `-` when it cannot compute a percentage; it is not an error.
    expect(table.filesystems[8]).toEqual({
      filesystem: 'portal',
      blocks: '0',
      used: '0',
      available: '0',
      capacity: '-',
      mounted_on: '/run/user/1000/doc',
    });
  });

  it('parses busybox output whose device name overflows its column', () => {
    const table = ok(parseDf(corpus('df-alpine.txt')));
    expect(table.block_size_bytes).toBe(1024);
    expect(table.filesystems).toHaveLength(7);

    expect(table.filesystems[0]).toEqual({
      filesystem: 'overlay',
      blocks: '61202244',
      used: '14230520',
      available: '43828604',
      capacity: '25%',
      mounted_on: '/',
    });

    // busybox wraps a device name longer than 20 columns onto its own line —
    // but only when -P is absent. This row is the proof that -P keeps it whole.
    expect(table.filesystems[4]).toEqual({
      filesystem: '/dev/mapper/vg--data-really--long--logical--volume--name',
      blocks: '1056758832',
      used: '372194048',
      available: '630746416',
      capacity: '37%',
      mounted_on: '/var/lib/docker/volumes',
    });

    expect(table.filesystems[5]?.mounted_on).toBe('/mnt/backup snapshots');
  });

  it('parses BSD output and takes the block size from the header', () => {
    const table = ok(parseDf(corpus('df-macos.txt')));
    // 512, not 1024: BSD `df -P` uses 512-byte blocks unless -k is given, so a
    // parser that assumed kibibytes would report every size at double.
    expect(table.block_size_bytes).toBe(512);
    expect(table.filesystems).toHaveLength(7);

    expect(table.filesystems[0]).toEqual({
      filesystem: '/dev/disk3s1s1',
      blocks: '1942700360',
      used: '39112384',
      available: '169372752',
      capacity: '19%',
      mounted_on: '/',
    });

    // The automounter source contains a space; the mount point does not.
    expect(table.filesystems[4]).toEqual({
      filesystem: 'map auto_home',
      blocks: '0',
      used: '0',
      available: '0',
      capacity: '100%',
      mounted_on: '/System/Volumes/Data/home',
    });

    expect(table.filesystems[5]?.mounted_on).toBe('/Volumes/Time Machine Backups');
    expect(table.filesystems[6]?.mounted_on).toBe('/Volumes/Samsung PSSD T7 Shield');
  });

  it('never leaves padding inside a value', () => {
    for (const name of ['df-ubuntu.txt', 'df-alpine.txt', 'df-macos.txt']) {
      for (const entry of ok(parseDf(corpus(name))).filesystems) {
        for (const value of Object.values(entry)) {
          expect(value).toBe(value.trim());
          expect(value.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('ps corpus', () => {
  it('accepts both spellings of the command header', () => {
    expect(headerTokens('ps-ubuntu.txt')).toEqual([
      'PID',
      'PPID',
      'USER',
      'STAT',
      'VSZ',
      'RSS',
      'COMMAND',
    ]);
    expect(headerTokens('ps-alpine.txt').at(-1)).toBe('COMMAND');
    // macOS is the odd one: `-o args` prints ARGS where `-o command` prints
    // COMMAND, and busybox has no `command` keyword to switch to.
    expect(headerTokens('ps-macos.txt').at(-1)).toBe('ARGS');
    expect(parsePs(corpus('ps-macos.txt')).ok).toBe(true);
  });

  it('parses procps output and keeps command lines intact', () => {
    const table: PsTable = ok(parsePs(corpus('ps-ubuntu.txt')));
    expect(table.processes).toHaveLength(14);

    expect(table.processes[0]).toEqual({
      pid: '1',
      ppid: '0',
      user: 'root',
      stat: 'Ss',
      vsz: '21792',
      rss: '13136',
      command: '/sbin/init',
    });

    // A kernel thread: zero memory, bracketed name, still a normal row.
    expect(table.processes[1]?.command).toBe('[kthreadd]');
    expect(table.processes[1]?.vsz).toBe('0');

    // Spaces, a colon and two semicolons inside the command column.
    expect(table.processes[7]?.command).toBe(
      'nginx: master process /usr/sbin/nginx -g daemon on; master_process on;'
    );

    expect(table.processes[9]?.command).toBe(
      '/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main ' +
        '-c config_file=/etc/postgresql/16/main/postgresql.conf ' +
        '-c listen_addresses=* -c max_connections=200'
    );

    // postgres pads its process title, so the captured line ends in a space.
    // Trailing padding is not part of the command line.
    expect(corpus('ps-ubuntu.txt')).toContain('postgres: 16/main: checkpointer \n');
    expect(table.processes[10]?.command).toBe('postgres: 16/main: checkpointer');

    expect(table.processes[11]).toEqual({
      pid: '2044',
      ppid: '1',
      user: 'deploy',
      stat: 'Ssl',
      vsz: '4271680',
      rss: '1264832',
      command:
        '/usr/lib/jvm/java-21-openjdk-amd64/bin/java -Xms512m -Xmx2g -XX:+UseZGC ' +
        '-Dspring.profiles.active=prod -jar /opt/app/service.jar --server.port=8080 ' +
        '--logging.file.name=/var/log/app/service.log',
    });
  });

  it('parses busybox output, scaled memory values and all', () => {
    const table = ok(parsePs(corpus('ps-alpine.txt')));
    expect(table.processes).toHaveLength(8);

    // busybox prints VSZ/RSS through put_lu, which scales to four characters.
    // This is why every field stays a string: `1.5g` is not a number, and the
    // same column on ubuntu holds `4271680`.
    expect(table.processes[2]).toEqual({
      pid: '14',
      ppid: '1',
      user: 'appsvcru',
      stat: 'S',
      vsz: '1.5g',
      rss: '980m',
      command:
        '/usr/local/bin/app-server --listen 0.0.0.0:8080 --metrics 0.0.0.0:9090 ' +
        '--log-format json --data-dir /var/lib/app',
    });
    expect(table.processes[1]?.rss).toBe('6.8m');

    // busybox cuts each line to terminal_width, but the `-o` path narrows that
    // from MAX_WIDTH (2048) only `if (isatty(1))` — and ssh-mcp asks for no pty
    // on either tool path (`src/ssh/exec.ts` passes `{ pty: false }`,
    // `src/ssh/session.ts` suppresses the pty request), so nothing here is cut.
    // The row above is 148 characters and arrives whole; so does this one.
    expect(table.processes[0]?.command).toBe(
      '/bin/sh /usr/local/bin/entrypoint.sh --config /etc/app/config.yaml --verbose'
    );

    expect(table.processes[6]).toEqual({
      pid: '203',
      ppid: '1',
      user: 'root',
      stat: 'Z',
      vsz: '0',
      rss: '0',
      command: '[sh]',
    });
  });

  it('parses BSD output whose executable path contains spaces', () => {
    const table = ok(parsePs(corpus('ps-macos.txt')));
    expect(table.processes).toHaveLength(7);

    expect(table.processes[0]).toEqual({
      pid: '1',
      ppid: '0',
      user: 'root',
      stat: 'Ss',
      vsz: '4374568',
      rss: '24608',
      command: '/sbin/launchd',
    });

    expect(table.processes[2]?.user).toBe('_windowserver');

    // Spaces in the binary path *and* in an argument value. Nothing but the
    // sixth whitespace run can be treated as a column boundary.
    expect(table.processes[4]?.command).toBe(
      '/Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=renderer ' +
        '--enable-crashpad --user-data-dir=/Users/alice/Library/Application Support/Code ' +
        '--standard-schemes=vscode-webview,vscode-file'
    );
    expect(table.processes[4]?.stat).toBe('S');
  });

  it('takes a width-cut command line as an ordinary row', () => {
    // Every implementation cuts its lines to the terminal width when stdout is
    // a tty (busybox `procps/ps.c`, macOS `ps/ps.c` radar 3862041, procps the
    // same), which would leave a command line ending mid-argument. ssh-mcp asks
    // for no pty, so this cannot reach the parser today — but the parser must
    // not treat a short command as a broken row either way, because the columns
    // it splits on all sit left of the cut.
    const cut = [
      'PID   PPID  USER     STAT VSZ  RSS  COMMAND',
      '   14     1 appsvcru S    1.5g 980m /usr/local/bin/app-server --listen 0.0.0.0:',
    ].join('\n');
    const table = ok(parsePs(cut));
    expect(table.processes).toHaveLength(1);
    expect(table.processes[0]?.rss).toBe('980m');
    expect(table.processes[0]?.command).toBe('/usr/local/bin/app-server --listen 0.0.0.0:');
  });

  it('never leaves padding inside a value', () => {
    for (const name of ['ps-ubuntu.txt', 'ps-alpine.txt', 'ps-macos.txt']) {
      for (const entry of ok(parsePs(corpus(name))).processes) {
        for (const value of Object.values(entry)) {
          expect(value).toBe(value.trim());
          expect(value.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('empty and degenerate input', () => {
  it('reports empty_output when there is not even a header', () => {
    for (const input of ['', '\n', '   \n\t\n']) {
      expect(parseDf(input)).toEqual({ ok: false, reason: 'empty_output', line: null });
      expect(parsePs(input)).toEqual({ ok: false, reason: 'empty_output', line: null });
    }
  });

  it('accepts a header with no rows as an empty table', () => {
    expect(ok(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n'))).toEqual({
      block_size_bytes: 1024,
      filesystems: [],
    });
    expect(ok(parsePs('PID PPID USER STAT VSZ RSS COMMAND\n'))).toEqual({ processes: [] });
  });

  it('ignores CRLF endings and trailing blank lines', () => {
    const lf = corpus('df-ubuntu.txt');
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(parseDf(crlf)).toEqual(parseDf(lf));

    const psLf = corpus('ps-macos.txt');
    expect(parsePs(`${psLf}\n\n`)).toEqual(parsePs(psLf));
  });
});

describe('df failures', () => {
  it('rejects the header of a plain df', () => {
    // GNU without -P: `1K-blocks` carries no unit we can read and `Use%` is one
    // token where -P has two, so both halves of the guard fire.
    const plain = [
      'Filesystem     1K-blocks      Used Available Use% Mounted on',
      '/dev/sda1       98559220  41205312  52307032  45% /',
    ].join('\n');
    expect(parseDf(plain)).toEqual({ ok: false, reason: 'header_unrecognized', line: 1 });
  });

  it('rejects the wider BSD header that -P replaces', () => {
    const bsd = [
      'Filesystem   512-blocks       Used  Available Capacity iused      ifree %iused  Mounted on',
      '/dev/disk3s1s1 1942700360   39112384  169372752    19%  500000 4294467295    0%   /',
    ].join('\n');
    expect(parseDf(bsd)).toEqual({ ok: false, reason: 'header_unrecognized', line: 1 });
  });

  it('rejects a header whose block word carries no unit', () => {
    const human = 'Filesystem      Size  Used Available Capacity Mounted on\n';
    expect(parseDf(human)).toEqual({ ok: false, reason: 'header_unrecognized', line: 1 });
  });

  it('accepts the Avail spelling macOS uses outside UNIX 03 mode', () => {
    const legacy = [
      'Filesystem 512-blocks Used Avail Capacity Mounted on',
      '/dev/disk3s1s1 1942700360 39112384 169372752 19% /',
    ].join('\n');
    expect(ok(parseDf(legacy)).filesystems).toHaveLength(1);
  });

  it('reports the line of a row with too few columns', () => {
    const broken = [
      'Filesystem     1024-blocks      Used Available Capacity Mounted on',
      'tmpfs              1608724      1868   1606856       1% /run',
      'tmpfs              1608724      1868',
      'tmpfs              1608720       124   1608596       1% /run/user/1000',
    ].join('\n');
    expect(parseDf(broken)).toEqual({ ok: false, reason: 'row_unparsable', line: 3 });
  });

  it('rejects the continuation line a non-P df produces', () => {
    // busybox prints a long device name alone on a line and indents the rest.
    // Splitting that into two filesystems would be worse than failing.
    const wrapped = [
      'Filesystem           1024-blocks    Used Available Capacity Mounted on',
      '/dev/mapper/vg--data-really--long--logical--volume--name',
      '                      1056758832 372194048 630746416  37% /var/lib/docker/volumes',
    ].join('\n');
    expect(parseDf(wrapped)).toEqual({ ok: false, reason: 'row_unparsable', line: 2 });
  });

  it('rejects a row whose capacity column is not a percentage', () => {
    const noAnchor = [
      'Filesystem     1024-blocks      Used Available Capacity Mounted on',
      'tmpfs              1608724      1868   1606856   plenty /run',
    ].join('\n');
    expect(parseDf(noAnchor)).toEqual({ ok: false, reason: 'row_unparsable', line: 2 });
  });

  it('counts blank lines when it reports a line number', () => {
    const padded = [
      'Filesystem     1024-blocks      Used Available Capacity Mounted on',
      '',
      'tmpfs              1608724      1868   1606856       1% /run',
      '',
      'tmpfs 1608724 1868',
    ].join('\n');
    expect(parseDf(padded)).toEqual({ ok: false, reason: 'row_unparsable', line: 5 });
  });
});

describe('ps failures', () => {
  it('rejects the default ps header', () => {
    const plain = ['  PID TTY          TIME CMD', ' 4188 pts/0    00:00:00 bash'].join('\n');
    expect(parsePs(plain)).toEqual({ ok: false, reason: 'header_unrecognized', line: 1 });
  });

  it('rejects a header from a different -o list of the same width', () => {
    // Same column count, different meaning: reading ELAPSED as STAT would put a
    // duration in the state field and shift everything after it.
    const other = [
      '  PID  PPID USER     ELAPSED  VSZ   RSS COMMAND',
      '    1     0 root       00:15 21792 13136 /sbin/init',
    ].join('\n');
    expect(parsePs(other)).toEqual({ ok: false, reason: 'header_unrecognized', line: 1 });
  });

  it('rejects a header with the columns in a different order', () => {
    const swapped = 'PPID PID USER STAT VSZ RSS COMMAND\n';
    expect(parsePs(swapped)).toEqual({ ok: false, reason: 'header_unrecognized', line: 1 });
  });

  it('reports the line of a row with no command column', () => {
    const broken = [
      '  PID  PPID USER     STAT   VSZ   RSS COMMAND',
      '    1     0 root     Ss   21792 13136 /sbin/init',
      '    2     0 root     S        0     0',
    ].join('\n');
    expect(parsePs(broken)).toEqual({ ok: false, reason: 'row_unparsable', line: 3 });
  });

  it('reports output that was cut off mid-row', () => {
    const cut = [
      '  PID  PPID USER     STAT   VSZ   RSS COMMAND',
      '    1     0 root     Ss   21792 13136 /sbin/init',
      '    2     0 root',
    ].join('\n');
    expect(parsePs(cut)).toEqual({ ok: false, reason: 'row_unparsable', line: 3 });
  });

  it('fails the whole table rather than returning the rows before the bad one', () => {
    const broken = [
      '  PID  PPID USER     STAT   VSZ   RSS COMMAND',
      '    1     0 root     Ss   21792 13136 /sbin/init',
      '    2     0 root     S',
      '    3     0 root     S        0     0 [kworker/0:0]',
    ].join('\n');
    const result = parsePs(broken);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('value');
  });
});
