'use strict';

/**
 * WindowService tests.
 *
 * The helper is a real PowerShell child process, and two bugs in this file's
 * history were only findable by actually running it. So the child is INJECTED and
 * the line protocol is driven directly - in milliseconds, deterministically.
 *
 * The bug that motivates this file: an earlier version removed the pending
 * query on the `DONE` line, so the `W` lines that followed attached to nothing
 * and the promise never settled. That is a HANG WITH NO ERROR, which is the
 * worst possible failure for a "wait for a window" block, and it is invisible
 * unless the parse is actually exercised.
 *
 * The measured live numbers (PowerShell startup ~1s, query ~16ms) come from
 * running the real thing, not from here.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { EventEmitter } = require('events');
const { createWindowService } = require('../src/main/services/windowService');

const SRC = fs.readFileSync(require.resolve('../src/main/services/windowService'), 'utf8');

/** A stand-in for `spawn('powershell', ...)`, driven by the test. */
function fakeChild() {
  const state = {
    args: null,
    /** Raw chunks written to the child's stdin, unfiltered. */
    stdinRaw: [],
    killed: false,
    /** Push lines to the service as if PowerShell had written them. */
    say(...lines) {
      setImmediate(() => {
        if (state.onData) state.onData(Buffer.from(lines.join('\n') + '\n', 'utf8'));
      });
    },
    /** A full successful query. */
    reply(list) {
      state.say('DONE 5 ' + list.length, ...list.map((w) => 'W ' + w[0] + '\t' + w[1] + '\t' + w[2]));
    },
  };
  state.spawn = (cmd, args) => {
    state.args = args;
    const proc = new EventEmitter();
    // stdout is called with setEncoding('utf8'), so the stand-in needs it.
    proc.stdout = new EventEmitter();
    proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter();
    proc.stderr.setEncoding = () => {};
    proc.stdin = new EventEmitter();
    proc.stdin.write = (chunk) => {
      // Raw, because the query itself is a bare "\n" - splitting and dropping
      // empties would make "one query was sent" unreadable.
      state.stdinRaw.push(String(chunk));
    };
    proc.kill = () => {
      state.killed = true;
      proc.emit('exit', null, 'SIGTERM');
    };
    state.proc = proc;
    state.onData = (buf) => proc.stdout.emit('data', buf);
    return proc;
  };
  return state;
}

function makeService(extra) {
  const child = fakeChild();
  const svc = createWindowService(
    Object.assign({ ownPid: 999, spawn: child.spawn, idleMs: 999999 }, extra || {})
  );
  return { svc, child };
}

const W = (title, pid) => [100, pid || 1, title];

/** Start the service, complete the READY handshake, and leave it idle. */
async function ready(extra) {
  const h = makeService(extra);
  const probe = h.svc.listWindows();
  await tick();
  h.child.say('READY');
  await tick();
  h.child.reply([]); // settle the handshake probe so the next query is the test's
  await probe;
  return h;
}

/** Start the service and leave ONE query in flight for the test to answer. */
async function started(extra) {
  const h = makeService(extra);
  const p = h.svc.listWindows();
  await tick();
  h.child.say('READY');
  return Object.assign(h, { p });
}
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---------------------------------------------------------------- matching

test('title matching is case-insensitive and substring based', () => {
  const svc = createWindowService({ ownPid: 1 });
  // Substring, not exact: real titles are long and compound, and nobody wants
  // to type "1 Second Cps test - cpstest.org - Google Chrome" in full.
  assert.strictEqual(svc.matchesTitle('Sales.csv - Notepad', 'notepad'), true);
  assert.strictEqual(svc.matchesTitle('Sales.csv - Notepad', 'Notepad'), true);
  assert.strictEqual(svc.matchesTitle('AppSaaS.docx - WPS Office', 'Docx'), true);
  assert.strictEqual(svc.matchesTitle('1 Second Cps test - cpstest.org - Google Chrome', 'Chrome'), true);
  assert.strictEqual(svc.matchesTitle('AppSaaS.docx - WPS Office', 'Notepad'), false);
});

test('an empty needle never matches', () => {
  // An empty match would succeed instantly on any window, which is never what an
  // empty field means.
  const svc = createWindowService({ ownPid: 1 });
  for (const empty of ['', null, undefined]) {
    assert.strictEqual(svc.matchesTitle('Anything', empty), false, JSON.stringify(empty));
  }
});

test('our own windows are excluded, so a macro cannot match this app', async () => {
  // Otherwise `wait until window titled "MacroBoard"` would succeed instantly
  // against this very app, and the macro would run before it had done anything.
  // Started by hand rather than via `started()`, because that helper already
  // has a query in flight and a reply would answer the wrong one.
  const h = makeService();
  const p = h.svc.listWindowsExcludingSelf();
  await tick();
  h.child.say('READY');
  await tick();
  h.child.reply([W('MacroBoard', 999), W('Notepad', 5), W('MacroBoard', 7)]);
  const list = await p;
  assert.deepStrictEqual(list.map((w) => w.title), ['Notepad', 'MacroBoard'], 'only OUR window is dropped');
  assert.strictEqual(list.some((w) => w.pid === 999), false);
  h.svc.shutdown();
});

// ---------------------------------------------------------------- protocol

test('a query resolves with the parsed window list', async () => {
  const h = await started();
  setImmediate(() => h.child.reply([W('Notepad'), W('Chrome - Google Chrome', 42)]));
  const list = await h.p;
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list[0], { handle: '100', pid: 1, title: 'Notepad' });
  assert.deepStrictEqual(list[1], { handle: '100', pid: 42, title: 'Chrome - Google Chrome' });
  h.svc.shutdown();
});

test('a title containing spaces survives the tab framing', async () => {
  // The title is the LAST field precisely so it may contain spaces - which every
  // real title does.
  const h = await started();
  setImmediate(() => h.child.reply([W('AppSaaS.docx - WPS Office')]));
  const list = await h.p;
  assert.strictEqual(list[0].title, 'AppSaaS.docx - WPS Office');
  h.svc.shutdown();
});

test('a non-ASCII title survives the framing', async () => {
  const h = await started();
  setImmediate(() => h.child.reply([W('Documento — ¹²³ — Editor')]));
  const list = await h.p;
  assert.strictEqual(list[0].title, 'Documento — ¹²³ — Editor');
  h.svc.shutdown();
});

test('a query with zero windows resolves on DONE alone', async () => {
  // No W lines will ever arrive, so DONE with count 0 must settle by itself.
  const h = await started();
  setImmediate(() => h.child.say('DONE 3 0'));
  const list = await h.p;
  assert.deepStrictEqual(list, []);
  h.svc.shutdown();
});

test('a query split across chunk boundaries still parses', async () => {
  // stdout arrives in arbitrary chunks; a real terminal window title will be
  // split across two reads.
  const h = await started();
  setImmediate(() => {
    const all = 'DONE 4 1\nW 100\t7\tSplit Title\n';
    const cut = 9;
    h.child.onData(Buffer.from(all.slice(0, cut), 'utf8'));
    setImmediate(() => h.child.onData(Buffer.from(all.slice(cut), 'utf8')));
  });
  const list = await h.p;
  assert.deepStrictEqual(list, [{ handle: '100', pid: 7, title: 'Split Title' }]);
  h.svc.shutdown();
});

test('the DONE line must NOT settle the query early', async () => {
  // The regression: removing the pending entry on DONE loses the W lines, so the
  // promise hangs with no error. Assert the entry is still tracked after DONE.
  const h = await started();
  let settled = false;
  h.p.then(() => {
    settled = true;
  });
  setImmediate(() => h.child.say('DONE 5 2'));
  await tick();
  assert.strictEqual(settled, false, 'DONE alone must not resolve - two windows are coming');
  setImmediate(() => h.child.say('W 100\t1\tFirst'));
  await tick();
  assert.strictEqual(settled, false, 'nor after the first of two');
  setImmediate(() => h.child.say('W 100\t1\tSecond'));
  const list = await h.p;
  assert.strictEqual(list.length, 2);
  h.svc.shutdown();
});

test('an E line rejects the query with the helper message', async () => {
  const h = await started();
  setImmediate(() => h.child.say('E something went wrong in the helper'));
  await assert.rejects(h.p, /something went wrong in the helper/);
  h.svc.shutdown();
});

test('a helper that dies mid-query rejects rather than hanging', async () => {
  const h = await started();
  setImmediate(() => h.child.proc.emit('exit', 1, null));
  await assert.rejects(h.p, /exited/);
});

test('a query that never answers is settled by the caller, never left hanging', async () => {
  const h = await ready();
  const p = h.svc.listWindows();
  // No reply, ever. The point is that something SETTLES it - a hang with no
  // error is the failure mode this whole file exists to prevent.
  const raced = await Promise.race([p.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('pending'), 200))]);
  assert.strictEqual(raced, 'pending', 'no reply means no premature resolution');
  h.svc.abort();
  await assert.rejects(p, /exited|shut down|did not answer/);
});

test('nothing is written to stdin before the helper says READY', async () => {
  // The handshake is not optional: a query written before PowerShell is reading
  // stdin is lost, and then the wait hangs with no error at all.
  const h = makeService();
  const p = h.svc.listWindows();
  await tick();
  assert.deepStrictEqual(h.child.stdinRaw, [], 'no query may be sent before READY');
  h.child.say('READY');
  await tick();
  assert.strictEqual(h.child.stdinRaw.length, 1, 'and exactly one once it is ready');
  assert.strictEqual(h.child.stdinRaw[0], '\n', 'a query is a single newline');
  h.child.reply([W('x')]);
  await p;
  h.svc.shutdown();
});

test('the script is passed as an argument so stdin stays free for queries', async () => {
  // `-Command -` and `-File -` read the script FROM stdin, which then fights the
  // query protocol for the same stream - the helper re-executes itself in a loop.
  const h = await ready();
  const args = h.child.args;
  assert.ok(args.includes('-Command'), args.join(' '));
  assert.strictEqual(args[args.length - 2], '-Command', 'HELPER must be the argument after -Command');
  assert.ok(args[args.length - 1].includes('READY'), 'and that argument is the script');
  h.svc.shutdown();
});

test('shutdown kills the child process', async () => {
  const h = await ready();
  h.svc.shutdown();
  assert.strictEqual(h.child.killed, true, 'a PowerShell child must not outlive the app');
});

test('shutdown rejects a query that was in flight', async () => {
  const h = await started();
  h.svc.shutdown();
  // Awaited, because the rejection is the whole point of the test and an
  // unawaited one surfaces as an unhandled rejection instead.
  await assert.rejects(h.p, /shut down|exited/);
});

// ---------------------------------------------------------------- waiting

test('waitFor returns immediately when the title is already open', async () => {
  const h = await ready();
  const waiting = h.svc.waitFor('Notepad', { timeoutMs: 5000, pollMs: 50 });
  setImmediate(() => h.child.reply([W('Notepad'), W('Chrome')]));
  const r = await waiting;
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.windows.length, 1, 'and only the windows that matched');
  assert.strictEqual(r.windows[0].title, 'Notepad');
  h.svc.shutdown();
});

test('waitFor polls until the title appears', async () => {
  const h = await ready();
  const waiting = h.svc.waitFor('Notepad', { timeoutMs: 5000, pollMs: 20 });
  // One answer per poll, and the answers must land AFTER each query goes out -
  // a reply with nothing pending is dropped, which is how this test could
  // accidentally pass by accident.
  let polls = 0;
  const driver = setInterval(() => {
    polls++;
    h.child.reply(polls < 3 ? [W('Chrome')] : [W('Notepad')]);
  }, 40);
  const r = await waiting;
  clearInterval(driver);
  assert.strictEqual(r.ok, true);
  assert.ok(polls >= 3, 'it must actually have polled more than once, saw ' + polls);
  h.svc.shutdown();
});

test('waitFor reports a timeout and hands back what it did see', async () => {
  // The engine turns `windows` into the error text, and the list of what WAS
  // open is the whole point - "no window matching Notepad" is useless on its own.
  const h = await ready();
  const waiting = h.svc.waitFor('Notepad', { timeoutMs: 80, pollMs: 20 });
  const driver = setInterval(() => h.child.reply([W('Chrome'), W('Spotify')]), 30);
  const r = await waiting;
  clearInterval(driver);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.deepStrictEqual(r.windows.map((w) => w.title), ['Chrome', 'Spotify']);
  h.svc.shutdown();
});

test('waitFor checks immediately rather than sleeping first', async () => {
  const h = await ready();
  const waiting = h.svc.waitFor('Notepad', { timeoutMs: 5000, pollMs: 400 });
  await tick();
  h.child.reply([W('Notepad')]);
  const r = await waiting;
  assert.strictEqual(r.ok, true, 'a matching window must not cost a whole poll interval');
  h.svc.shutdown();
});

test('waitFor stops when asked to', async () => {
  const h = await ready();
  let stop = false;
  const waiting = h.svc.waitFor('Never', { timeoutMs: 30000, pollMs: 20, shouldStop: () => stop });
  await tick();
  h.child.reply([W('Chrome')]);
  await tick();
  stop = true;
  await tick();
  h.child.reply([W('Chrome')]);
  const r = await waiting;
  assert.strictEqual(r.stopped, true);
  h.svc.shutdown();
});

test('waitFor clamps a hostile poll interval', async () => {
  const h = await ready();
  // pollMs 0 would mean a busy loop against a PowerShell child, so the service
  // must raise it to the floor rather than honouring it.
  const waiting = h.svc.waitFor('Never', { timeoutMs: 60, pollMs: 0 });
  const driver = setInterval(() => h.child.reply([W('Chrome')]), 30);
  const r = await waiting;
  clearInterval(driver);
  assert.strictEqual(r.timedOut, true);
  h.svc.shutdown();
});

// ---------------------------------------------------------------- platform

test('the service reports itself unavailable off Windows, with a reason', async () => {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    const svc = createWindowService({ ownPid: 1, spawn: fakeChild().spawn });
    assert.strictEqual(svc.available, false);
    assert.match(svc.reason, /only be read on Windows/);
    await assert.rejects(svc.listWindows(), /only be read on Windows/);
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
});

// ----------------------------------------------------------------- script

test('the helper pins its output encoding to UTF-8', () => {
  // Without it a non-ASCII title arrives as mojibake and silently fails to
  // match - the worst kind of failure, because the title looks right in the UI.
  const { HELPER } = createWindowService({ ownPid: 1 });
  assert.ok(HELPER.includes('OutputEncoding'));
  assert.ok(HELPER.includes('UTF8'));
});

test('the helper strips tabs and newlines out of titles', () => {
  // The protocol is line based and tab separated, so a title containing either
  // would corrupt every record after it. Window titles are display text, never
  // functional, so flattening is safe - and far better than a shifted parse.
  const { HELPER } = createWindowService({ ownPid: 1 });
  assert.ok(HELPER.includes('-replace'), 'titles must be sanitised');
  assert.ok(/\[\s*\\r\\n\\t\s*\]/.test(HELPER), 'specifically CR, LF and TAB');
});

test('the helper only lists visible windows', () => {
  // "The app is open" means on screen. A hidden window matching a title would
  // make the wait succeed against something the user cannot see.
  const { HELPER } = createWindowService({ ownPid: 1 });
  assert.ok(HELPER.includes('IsWindowVisible'));
  assert.ok(HELPER.includes('EnumWindows'));
});

test('the service does not spawn from a -Command stdin read', () => {
  // Guards the exact bug: reading the script from stdin makes PowerShell's
  // reader and [Console]::In compete for the same lines.
  assert.ok(SRC.includes("'-Command', HELPER"), "spawn must use ['-Command', HELPER]");
  assert.ok(!SRC.includes("'-Command', '-'"), "spawn must not use '-Command -'");
  assert.ok(!SRC.includes("'-File', '-'"), "spawn must not use '-File -'");
});
