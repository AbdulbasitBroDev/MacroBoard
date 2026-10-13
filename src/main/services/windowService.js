'use strict';

/**
 * WindowService - find out which windows are open, by title.
 *
 * WHY A PERSISTENT POWERSHELL PROCESS
 * ----------------------------------
 * Measured on the development machine:
 *
 *   spawn powershell -File query.ps1, per poll ...... ~1030 ms
 *   persistent process, first READY ................. ~975 ms   (one-off)
 *   persistent process, each query ................. ~15 ms
 *
 * So the cost is almost entirely PROCESS STARTUP, not the query. Spawning per
 * poll would make "wait for a window" cost a second of CPU per second of
 * waiting, and would be unusable at any sane poll interval. One long-lived
 * process pays the startup once and then answers in ~15ms.
 *
 * It is therefore started LAZILY (only when a macro actually needs it) and
 * killed after an idle period, so a session that never waits for a window never
 * spawns PowerShell at all.
 *
 * WHY POWERSHELL AT ALL
 * ---------------------
 * There is no FFI layer in this project and adding a native module is a bigger
 * decision than this feature is worth. PowerShell is the platform's own
 * scripting host, so this stays dependency-free.
 *
 * WHAT IS LISTED
 * -------------
 * Visible top-level windows only (EnumWindows + IsWindowVisible), which is what
 * a user means by "the app is open". Minimised windows still count: they are
 * visible in the sense that mattering here.
 *
 * The service's own process is EXCLUDED, so a macro waiting for a window cannot
 * match MacroBlock's own window and declare victory immediately.
 */

const { spawn: nodeSpawn } = require('child_process');
const os = require('os');

/** Kill the helper after this long with no query, so nothing lingers. */
const IDLE_SHUTDOWN_MS = 30000;

/** How long to wait for the helper to print READY before giving up on it. */
const READY_TIMEOUT_MS = 10000;

/** How long one query may take before it is treated as a failure. */
const QUERY_TIMEOUT_MS = 5000;

/**
 * The helper script, sent over stdin rather than written to a temp file.
 *
 * It stays resident and answers one query per input line, which is the whole
 * point. The protocol is line based:
 *
 *   READY                     - startup finished, queries accepted
 *   DONE <ms> <count>         - a query finished, this many windows follow
 *   W <hwnd> <pid> <title>    - one window
 *   E <message>                - this query failed
 *   q                          - (input) shut down
 */
const HELPER = `
$ErrorActionPreference = 'Stop'
# Titles are arbitrary user text, so the stream has to be pinned to UTF-8 or any
# non-ASCII character in a window title arrives as mojibake - which would make
# a correct title silently fail to match.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

Add-Type -Namespace MB -Name W -MemberDefinition '
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);'

function Get-MbWindows {
  $list = New-Object System.Collections.ArrayList
  $cb = [MB.W+EnumWindowsProc]{
    param($h, $p)
    try {
      if ([MB.W]::IsWindowVisible($h)) {
        $n = [MB.W]::GetWindowTextLength($h)
        if ($n -gt 0) {
          $sb = New-Object System.Text.StringBuilder ($n + 1)
          [void][MB.W]::GetWindowText($h, $sb, $n + 1)
          $owner = 0
          [void][MB.W]::GetWindowThreadProcessId($h, [ref]$owner)
          $title = $sb.ToString()
          # The protocol is line based and tab separated, so a title containing
          # either character would corrupt every record after it. Window titles
          # are display text, never functional, so flattening is safe - and far
          # better than a truncated or shifted parse.
          $title = ($title -replace "[\\r\\n\\t]", " ")
          [void]$list.Add(("$h" + [char]9 + $owner + [char]9 + $title))
        }
      }
    } catch { }
    return $true
  }
  [void][MB.W]::EnumWindows($cb, [IntPtr]::Zero)
  $list
}

'READY'
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ($line.Trim() -eq 'q') { break }
  try {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $rows = Get-MbWindows
    $out = New-Object System.Collections.ArrayList
    [void]$out.Add(('DONE ' + $sw.ElapsedMilliseconds + ' ' + $rows.Count))
    foreach ($r in $rows) { [void]$out.Add(('W ' + $r)) }
    [Console]::Out.Write(($out -join [char]10) + [char]10)
  } catch {
    [Console]::Out.Write(('E ' + $_.Exception.Message) + [char]10)
  }
}
`;

function createWindowService(deps) {
  deps = deps || {};
  const log = deps.log || (() => {});
  const isWindows = process.platform === 'win32';
  /** This process's own id, so its own windows can be excluded from matches. */
  const ownPid = deps.ownPid === undefined ? process.pid : deps.ownPid;
  const idleMs = deps.idleMs || IDLE_SHUTDOWN_MS;
  /**
   * Test seam. The child process is injected so the line protocol can be driven
   * deterministically in milliseconds.
   *
   * The framing is exactly the kind of thing that looks right and is wrong: an
   * earlier version removed the pending query on the `DONE` line, so the `W`
   * lines that followed attached to nothing and the promise never settled - a
   * hang with no error. That cannot be found without exercising the parse.
   */
  const spawnFn = deps.spawn || nodeSpawn;

  let child = null;
  let ready = false;
  let starting = null;
  let resolveReady = null;
  let rejectReady = null;
  let buffer = '';
  let idleTimer = null;
  let readyTimer = null;
  let seq = 0;
  const pending = new Map();
  let lastError = '';

  const available = isWindows;
  const reason = available
    ? ''
    : 'Window titles can only be read on Windows, so "wait for window" and the window triggers are off.';

  function stopChild() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (child) {
      try {
        child.kill();
      } catch (err) {
        /* already gone */
      }
    }
    child = null;
    ready = false;
    buffer = '';
    if (rejectReady) {
      const r = rejectReady;
      rejectReady = null;
      resolveReady = null;
      r(new Error('The window helper was shut down before it was ready.'));
    }
    // Any query still in flight will never be answered now.
    pending.forEach((p) => p.reject(new Error('The window helper was shut down.')));
    pending.clear();
  }

  function noteActivity() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // Only tear down while genuinely idle, so a burst of queries keeps the
      // process warm instead of paying the 1s startup for each one.
      if (pending.size === 0) {
        log('debug', 'window helper idle for ' + idleMs + 'ms; shutting it down');
        stopChild();
      }
    }, idleMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  /**
   * The oldest query still waiting for an answer, or undefined.
   *
   * Queries are strictly serialised - one line out, one DONE plus N W lines
   * back, in order - so "the first one" is the right one every time.
   */
  function oldestPending() {
    const it = pending.values().next();
    return it.done ? undefined : it.value;
  }

  function handleLine(line) {
    if (line === 'READY') {
      ready = true;
      if (resolveReady) {
        const r = resolveReady;
        resolveReady = null;
        rejectReady = null;
        r();
      }
      return;
    }
    if (line.startsWith('E ')) {
      lastError = line.slice(2).trim();
      const first = oldestPending();
      if (first) {
        pending.delete(first.id);
        first.reject(new Error(lastError || 'the window helper reported an error'));
      }
      return;
    }
    if (line.startsWith('DONE ')) {
      const parts = line.split(' ');
      const first = oldestPending();
      if (!first) return;
      // Deliberately NOT removed here: the N window lines that follow still
      // belong to this query. Removing it on DONE loses them, and the promise
      // then waits forever with no error - which is exactly the failure this
      // protocol must not have.
      first.expecting = Number(parts[2]) || 0;
      first.remaining = first.expecting;
      first.windows = [];
      first.elapsedMs = Number(parts[1]) || 0;
      if (first.expecting === 0) {
        pending.delete(first.id);
        first.resolve({ windows: [], elapsedMs: 0 });
      }
      return;
    }
    if (line.startsWith('W ')) {
      const first = oldestPending();
      if (!first || first.remaining === undefined) return;
      // handle<TAB>pid<TAB>title, with the title LAST so it may contain spaces.
      const rest = line.slice(2);
      const tab1 = rest.indexOf('\t');
      const tab2 = rest.indexOf('\t', tab1 + 1);
      if (tab1 === -1 || tab2 === -1) return;
      const handle = rest.slice(0, tab1);
      const pid = Number(rest.slice(tab1 + 1, tab2));
      const title = rest.slice(tab2 + 1);
      first.windows.push({ handle, pid, title });
      first.remaining--;
      if (first.remaining <= 0) {
        pending.delete(first.id);
        first.resolve({ windows: first.windows, elapsedMs: first.elapsedMs });
      }
    }
  }

  function pump(chunk) {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      if (line) handleLine(line);
    }
  }

  /**
   * Start the helper if needed and resolve once it says READY.
   *
   * The handshake is not optional. Writing the first query before PowerShell is
   * reading stdin loses the line - the child has not attached its reader yet -
   * and the query then waits forever with no answer and no error, which is the
   * worst possible failure for a "wait for a window" block.
   */
  function ensureStarted() {
    if (ready) return Promise.resolve();
    if (starting) return starting;
    if (!available) return Promise.reject(new Error(reason));

    starting = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
      const timer = setTimeout(() => {
        starting = null;
        resolveReady = null;
        rejectReady = null;
        stopChild();
        reject(new Error('The window helper did not become ready within ' + READY_TIMEOUT_MS + 'ms.'));
      }, READY_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      // Latched so the exit/error paths can clear the same timer.
      readyTimer = timer;

      let proc;
      try {
        proc = spawnFn(
          'powershell',
          // The script goes in as an ARGUMENT, not on stdin.
          //
          // `-Command -` and `-File -` both read the script FROM stdin, and both
          // then fight the query protocol for the same stream: PowerShell's own
          // reader and `[Console]::In` compete for each line, and the helper
          // re-executes itself in a loop. Passing the script as an argument
          // leaves stdin free for queries, which is all it is used for.
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HELPER],
          { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
        );
      } catch (err) {
        clearTimeout(timer);
        readyTimer = null;
        starting = null;
        resolveReady = null;
        rejectReady = null;
        reject(new Error('Could not start PowerShell: ' + err.message));
        return;
      }
      child = proc;
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', pump);
      proc.stderr.on('data', (d) => log('debug', 'window helper stderr: ' + String(d).trim()));
      proc.on('error', (err) => {
        clearTimeout(readyTimer || timer);
        readyTimer = null;
        starting = null;
        stopChild();
        reject(new Error('The window helper could not run: ' + err.message));
      });
      proc.on('exit', (code) => {
        const wasReady = ready;
        clearTimeout(readyTimer || timer);
        readyTimer = null;
        starting = null;
        ready = false;
        child = null;
        // A non-zero exit while a query is in flight is a real failure, not a
        // normal shutdown - surface it instead of hanging the macro.
        pending.forEach((p) => p.reject(new Error('The window helper exited (code ' + code + ').')));
        pending.clear();
        if (code !== 0 && code !== null) {
          lastError = 'The window helper exited with code ' + code + '.';
          if (!wasReady && rejectReady) {
            const r = rejectReady;
            rejectReady = null;
            resolveReady = null;
            r(new Error(lastError));
          }
        }
      });
      proc.stdin.on('error', () => {
        /* the exit handler reports it */
      });
      // Nothing is written to stdin at startup: the script arrived as an
      // argument, so stdin is reserved purely for the query protocol.
    });
    return starting;
  }

  /** One query. Resolves with the window list. */
  async function listWindows() {
    await ensureStarted();
    noteActivity();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('The window helper did not answer within ' + QUERY_TIMEOUT_MS + 'ms.'));
      }, QUERY_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, {
        id,
        windows: [],
        remaining: undefined,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v.windows || []);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        child.stdin.write('\n');
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error('Could not ask the window helper: ' + err.message));
      }
    });
  }

  /**
   * Case-insensitive SUBSTRING match on the title.
   *
   * Substring rather than exact because real titles are long and compound - "1
   * Second Cps test - cpstest.org - Google Chrome" - and nobody wants to type
   * that in full. Documented on the block.
   */
  function matchesTitle(title, needle) {
    if (!needle) return false;
    return String(title).toLowerCase().indexOf(String(needle).toLowerCase()) !== -1;
  }

  /** Every visible window, minus our own. */
  async function listWindowsExcludingSelf() {
    const all = await listWindows();
    return all.filter((w) => w.pid !== ownPid);
  }

  /** Is a window with this title open right now? */
  async function titleExists(title) {
    const windows = await listWindowsExcludingSelf();
    return windows.some((w) => matchesTitle(w.title, title));
  }

  /**
   * Poll until a window with this title exists, or time out.
   *
   * @param {string} title
   * @param {object} opts { timeoutMs, pollMs, shouldStop, onTimeout }
   * @return {Promise<{ok:boolean, timedOut?:boolean, waitedMs:number, windows?:object[]}>}
   *
   * `shouldStop` is checked BEFORE every query and the caller can kill the
   * helper mid-query via `abort()`, which is what makes Stop feel instant rather
   * than "one poll late".
   */
  async function waitFor(title, opts) {
    opts = opts || {};
    const pollMs = Math.max(50, Math.min(5000, Number(opts.pollMs) || 250));
    const timeoutMs = Math.max(0, Number(opts.timeoutMs) || 0);
    const started = Date.now();

    // Check immediately: waiting a whole interval before the FIRST look is the
    // difference between "reacts in 250ms" and "reacts in 500ms".
    for (;;) {
      if (opts.shouldStop && opts.shouldStop()) return { ok: false, stopped: true, waitedMs: Date.now() - started };
      const windows = await listWindowsExcludingSelf();
      const hit = windows.filter((w) => matchesTitle(w.title, title));
      if (hit.length) {
        return { ok: true, waitedMs: Date.now() - started, windows: hit };
      }
      const elapsed = Date.now() - started;
      if (timeoutMs > 0 && elapsed >= timeoutMs) {
        // The windows from the LAST poll, not an empty list. This is the whole
        // point of the timeout: "no window matching Notepad" tells the user
        // nothing, while the list of what WAS open tells them what to match on.
        return { ok: false, timedOut: true, waitedMs: elapsed, windows: windows };
      }
      await new Promise((r) => setTimeout(r, Math.min(pollMs, timeoutMs > 0 ? timeoutMs - elapsed : pollMs)));
    }
  }

  return {
    available,
    reason,
    listWindows,
    listWindowsExcludingSelf,
    titleExists,
    waitFor,
    matchesTitle,
    /** Kill the helper. Also how the engine makes Stop land during a query. */
    abort() {
      if (pending.size === 0 && !child) return;
      stopChild();
    },
    shutdown() {
      stopChild();
    },
    /** For diagnostics: is the helper up, and did it ever fail. */
    status() {
      return {
        platform: process.platform,
        available,
        helperRunning: Boolean(child),
        helperReady: ready,
        lastError,
        excludedPid: ownPid,
        host: os.hostname(),
      };
    },
    HELPER,
  };
}

module.exports = { createWindowService, IDLE_SHUTDOWN_MS, QUERY_TIMEOUT_MS };
