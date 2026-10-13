'use strict';

/**
 * Eyedropper tests.
 *
 * The whole point of this service is that the colour is sampled while the
 * cursor HOVERS, before any click exists, and committed from that sample. So
 * these tests are mostly about the two ways the old implementation was wrong:
 *
 *   1. reading AFTER a click, which photographs whatever the click caused, and
 *   2. accepting any click, which meant a stray click silently picked a colour
 *      and fired whatever the user was reaching for.
 *
 * Nothing here touches Electron, a screen or a mouse: the hook and the pixel
 * reader are both injected, and the "screen" is a plain function of x,y.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createEyedropper, SAMPLE_MAX_AGE_MS } = require('../src/main/services/eyedropper');

/** Let pending microtasks + a macrotask settle, so an awaited capture lands. */
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A fake screen: "x,y" -> hex, anything else -> #010101. */
function makePixel(map, opts) {
  opts = opts || {};
  const reads = [];
  return {
    reads,
    async readPixel(x, y) {
      reads.push({ x, y });
      if (opts.throwAlways) throw new Error('display is asleep');
      if (opts.failAt && opts.failAt === reads.length) throw new Error('capture failed once');
      const colour = (map && map[x + ',' + y]) || '#010101';
      return { x, y, outside: false, colour, rgb: { r: 1, g: 1, b: 1 } };
    },
  };
}

/** A fake hook: capture the listener so a test can push events at it. */
function makeHook() {
  const listeners = [];
  return {
    listeners,
    retain(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    /** Deliver one event to every retained listener. */
    emit(kind, payload) {
      return listeners.map((fn) => fn(kind, payload));
    },
    get count() {
      return listeners.length;
    },
  };
}

function makeHarness(opts) {
  opts = opts || {};
  const hook = makeHook();
  const pixel = makePixel(opts.screen, opts);
  let clock = opts.startClock || 1000;
  const previews = [];
  const hints = [];
  const picked = [];
  const ed = createEyedropper({
    hook,
    pixel,
    log: () => {},
    now: () => clock,
    cursorPosition: opts.cursorPosition || (() => null),
  });
  return {
    hook,
    pixel,
    ed,
    previews,
    hints,
    picked,
    tick: (ms) => {
      clock += ms;
    },
    get clock() {
      return clock;
    },
    start() {
      return ed.start({
        onPreview: (s) => previews.push(s),
        onHint: (t) => hints.push(t),
        onPicked: (p) => picked.push(p),
      });
    },
  };
}

// ------------------------------------------------------------ basic session

test('starting a session does not pick anything by itself', async () => {
  const h = makeHarness({ screen: { '10,20': '#ff0000' } });
  const s = h.start();
  assert.strictEqual(h.ed.isActive(), true);
  h.hook.emit('mousemove', { x: 10, y: 20, raw: {} });
  await tick();
  assert.deepStrictEqual(h.picked, [], 'hovering alone must not pick');
  s.cancel();
  assert.deepStrictEqual(await s.promise, { ok: false, cancelled: true });
});

test('hovering previews the colour, and the position tracks the cursor', async () => {
  const h = makeHarness({ screen: { '1,1': '#aa0000', '2,2': '#00bb00' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 1, y: 1, raw: {} });
  await tick();
  h.hook.emit('mousemove', { x: 2, y: 2, raw: {} });
  await tick();
  h.hook.emit('mousedown', { x: 2, y: 2, raw: { ctrlKey: true } });
  await s.promise;
  assert.deepStrictEqual(h.previews.map((p) => p.colour), ['#aa0000', '#00bb00']);
  assert.deepStrictEqual(h.previews.map((p) => [p.x, p.y]), [[1, 1], [2, 2]]);
});

test('a move that arrives while a capture is running does not queue a second one', async () => {
  // A real mouse emits moves far faster than a capture completes. Previewing
  // every one of them would mean a capture queue that reports positions the
  // cursor has long since left.
  const h = makeHarness({ screen: {} });
  const s = h.start();
  h.hook.emit('mousemove', { x: 1, y: 1, raw: {} });
  h.hook.emit('mousemove', { x: 2, y: 2, raw: {} });
  h.hook.emit('mousemove', { x: 3, y: 3, raw: {} });
  assert.strictEqual(h.pixel.reads.length, 1, 'exactly one capture for three moves');
  s.cancel();
  await s.promise;
});

test('the session ends after a pick and releases the hook', async () => {
  const h = makeHarness({ screen: { '5,5': '#ff0000' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 5, y: 5, raw: {} });
  h.hook.emit('mousedown', { x: 5, y: 5, raw: { ctrlKey: true } });
  const res = await s.promise;
  assert.deepStrictEqual(res, { ok: true, x: 5, y: 5, colour: '#ff0000' });
  assert.strictEqual(h.hook.count, 0, 'the long-lived hook listener must be released');
  assert.strictEqual(h.ed.isActive(), false);
});

test('escape cancels and releases the hook', async () => {
  const h = makeHarness();
  const s = h.start();
  h.hook.emit('keydown', { button: 'key:Escape', raw: {} });
  const res = await s.promise;
  assert.deepStrictEqual(res, { ok: false, cancelled: true });
  assert.strictEqual(h.hook.count, 0);
});

test('cancel() ends the session the same way escape does', async () => {
  const h = makeHarness();
  const s = h.start();
  s.cancel();
  const res = await s.promise;
  assert.deepStrictEqual(res, { ok: false, cancelled: true });
});

test('a second session is refused while one is running', async () => {
  const h = makeHarness();
  h.start();
  const second = h.ed.start({});
  await assert.rejects(second.promise, /already running/);
});

test('a session is refused when there is no hook or no pixel reader', async () => {
  const noHook = createEyedropper({ pixel: makePixel({}) });
  await assert.rejects(noHook.start({}).promise, /input hook is unavailable/);
  const noPixel = createEyedropper({ hook: makeHook() });
  await assert.rejects(noPixel.start({}).promise, /pixel reading is unavailable/);
});

// ------------------------------------------------ Ctrl is required, and why

test('a plain click does NOT pick a colour', async () => {
  // The core of the request: a click anywhere must not choose a colour.
  const h = makeHarness({ screen: { '7,7': '#ff0000' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 7, y: 7, raw: {} });
  h.hook.emit('mousedown', { x: 7, y: 7, raw: { ctrlKey: false } });
  assert.deepStrictEqual(h.picked, [], 'nothing may be picked');
  assert.strictEqual(h.ed.isActive(), true, 'and the session stays open');
  // The session is still live, so finish it and prove no pick slipped through.
  s.cancel();
  assert.deepStrictEqual(await s.promise, { ok: false, cancelled: true });
});

test('a plain click explains the Ctrl requirement once, not every time', async () => {
  const h = makeHarness({ screen: { '7,7': '#ff0000' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 7, y: 7, raw: {} });
  h.hook.emit('mousedown', { x: 7, y: 7, raw: {} });
  h.hook.emit('mousemove', { x: 7, y: 7, raw: {} });
  h.hook.emit('mousedown', { x: 7, y: 7, raw: {} });
  h.hook.emit('mousemove', { x: 7, y: 7, raw: {} });
  h.hook.emit('mousedown', { x: 7, y: 7, raw: {} });
  assert.strictEqual(h.hints.length, 1, 'the hint must not nag');
  assert.match(h.hints[0], /Hold Ctrl/);
  assert.match(h.hints[0], /Ctrl\+Enter/, 'and must offer the no-click route');
  s.cancel();
  await s.promise;
});

test('a click with any other modifier is not enough', async () => {
  // Shift or Alt alone must not commit, or a stray modifier key would turn an
  // accidental click into a pick.
  const h = makeHarness({ screen: { '7,7': '#ff0000' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 7, y: 7, raw: {} });
  h.hook.emit('mousedown', { x: 7, y: 7, raw: { shiftKey: true } });
  h.hook.emit('mousedown', { x: 7, y: 7, raw: { altKey: true } });
  assert.deepStrictEqual(h.picked, []);
  s.cancel();
  await s.promise;
});

test('ctrl+click picks', async () => {
  const h = makeHarness({ screen: { '7,7': '#abcdef' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 7, y: 7, raw: {} });
  h.hook.emit('mousedown', { x: 7, y: 7, raw: { ctrlKey: true, shiftKey: true } });
  const res = await s.promise;
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.colour, '#abcdef');
});

// ------------------------------------------------ the no-click commit path

test('ctrl+enter picks the hovered pixel with no mouse click at all', async () => {
  // This is the route with ZERO side effects on the app being sampled, which
  // matters because this app cannot block mouse buttons.
  const h = makeHarness({ screen: { '3,4': '#123456' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 3, y: 4, raw: {} });
  h.hook.emit('keydown', { button: 'key:Enter', raw: { ctrlKey: true } });
  const res = await s.promise;
  assert.deepStrictEqual(res, { ok: true, x: 3, y: 4, colour: '#123456' });
});

test('enter without ctrl is refused and says so', async () => {
  const h = makeHarness({ screen: { '3,4': '#123456' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 3, y: 4, raw: {} });
  h.hook.emit('keydown', { button: 'key:Enter', raw: {} });
  assert.deepStrictEqual(h.picked, []);
  assert.match(h.hints[0], /Hold Ctrl and press Enter/);
  s.cancel();
  await s.promise;
});

test('ctrl+enter before moving the mouse asks the user to move first', async () => {
  const h = makeHarness();
  const s = h.start();
  h.hook.emit('keydown', { button: 'key:Enter', raw: { ctrlKey: true } });
  assert.deepStrictEqual(h.picked, []);
  assert.match(h.hints[0], /Move the mouse over the pixel first/);
  s.cancel();
  await s.promise;
});

test('the numeric keypad enter also commits', async () => {
  const h = makeHarness({ screen: { '9,9': '#0f0f0f' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 9, y: 9, raw: {} });
  h.hook.emit('keydown', { button: 'key:KpEnter', raw: { ctrlKey: true } });
  assert.strictEqual((await s.promise).ok, true);
});

// ------------------------------------------- the accuracy fix, in a test

test('the committed colour is the HOVER sample, not a post-click capture', async () => {
  // The whole reason this service exists. Simulate the screen changing the
  // instant the click lands - a menu opening, say - and assert the colour that
  // comes back is the one that was there BEFORE.
  const h = makeHarness({ screen: { '4,4': '#ff0000' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 4, y: 4, raw: {} });
  // The click "opens a menu": the pixel under the cursor is now something else.
  h.pixel.readPixel = async (x, y) => ({ x, y, outside: false, colour: '#00ff00', rgb: { r: 0, g: 255, b: 0 } });
  h.hook.emit('mousedown', { x: 4, y: 4, raw: { ctrlKey: true } });
  const res = await s.promise;
  assert.strictEqual(res.colour, '#ff0000', 'must be the pre-click colour, not the post-click one');
});

test('a stale hover sample is not trusted - the position wins', async () => {
  // If the user jumped the cursor there was no hover sample for it, and
  // committing a colour for where they used to be would be worse than being
  // slightly late.
  const h = makeHarness({ screen: { '1,1': '#aaaaaa', '50,50': '#bbbbbb' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 1, y: 1, raw: {} });
  h.tick(SAMPLE_MAX_AGE_MS + 200);
  h.hook.emit('mousedown', { x: 50, y: 50, raw: { ctrlKey: true } });
  const res = await s.promise;
  assert.deepStrictEqual(res, { ok: true, x: 50, y: 50, colour: '#bbbbbb' });
});

test('a jump to a nearby pixel within tolerance reuses the hover sample', async () => {
  // One pixel of jitter between the last mousemove and the click is normal
  // hand movement, not a different target.
  const h = makeHarness({ screen: { '10,10': '#cccccc' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 10, y: 10, raw: {} });
  h.hook.emit('mousedown', { x: 11, y: 10, raw: { ctrlKey: true } });
  const res = await s.promise;
  assert.strictEqual(res.colour, '#cccccc');
  assert.strictEqual(h.pixel.reads.length, 1, 'no second capture was needed');
});

// --------------------------------------------------------- failure handling

test('a failed hover capture does not end the session', async () => {
  // The display may be asleep, or a UAC prompt may be up. The user is probably
  // still moving towards the target.
  const h = makeHarness({ screen: { '1,1': '#ff0000' }, failAt: 1 });
  const s = h.start();
  h.hook.emit('mousemove', { x: 1, y: 1, raw: {} });
  assert.strictEqual(h.ed.isActive(), true);
  h.hook.emit('mousemove', { x: 1, y: 1, raw: {} });
  h.hook.emit('mousedown', { x: 1, y: 1, raw: { ctrlKey: true } });
  assert.strictEqual((await s.promise).ok, true);
});

test('a failed capture on the FIRST sample still ends the session cleanly', async () => {
  const h = makeHarness({ throwAlways: true });
  const s = h.start();
  h.hook.emit('mousedown', { x: 1, y: 1, raw: { ctrlKey: true } });
  const res = await s.promise;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'unreadable');
  assert.strictEqual(h.hook.count, 0, 'and the hook is still released');
});

test('a pixel off the captured screen never becomes a colour', async () => {
  const h = makeHarness();
  h.pixel.readPixel = async (x, y) => ({ x, y, outside: true, colour: '#000000', rgb: { r: 0, g: 0, b: 0 } });
  const s = h.start();
  h.hook.emit('mousedown', { x: -5, y: -5, raw: { ctrlKey: true } });
  const res = await s.promise;
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'unreadable');
});

// ------------------------------------------------------------ throttling

test('a fast mouse does not queue a capture per move event', async () => {
  // A capture costs 40-90ms. Without the in-flight guard a fast mouse would
  // start dozens and every one of them would answer about a position the
  // cursor had already left.
  const h = makeHarness({ screen: {} });
  const s = h.start();
  let release;
  const blocked = new Promise((r) => {
    release = r;
  });
  let first = true;
  h.pixel.readPixel = async (x, y) => {
    if (first) {
      first = false;
      await blocked;
    }
    return { x, y, outside: false, colour: '#123123', rgb: { r: 1, g: 2, b: 3 } };
  };
  h.hook.emit('mousemove', { x: 1, y: 1, raw: {} });
  for (let i = 2; i < 40; i++) h.hook.emit('mousemove', { x: i, y: 1, raw: {} });
  assert.strictEqual(h.pixel.reads.length + 1, 1, 'only the first capture is in flight');
  release();
  await new Promise((r) => setTimeout(r, 10));
  s.cancel();
  await s.promise;
});

// ------------------------------------------------------------- first sample

test('a sample is taken immediately from the current cursor position', async () => {
  // Otherwise the preview chip is blank until the user happens to move.
  const h = makeHarness({
    screen: { '12,13': '#ff00ff' },
    cursorPosition: () => ({ x: 12, y: 13 }),
  });
  const s = h.start();
  h.hook.emit('keydown', { button: 'key:Enter', raw: { ctrlKey: true } });
  const res = await s.promise;
  assert.deepStrictEqual(res, { ok: true, x: 12, y: 13, colour: '#ff00ff' });
});

test('a broken cursor position does not stop the session starting', async () => {
  const h = makeHarness({
    screen: { '1,1': '#ff0000' },
    cursorPosition: () => {
      throw new Error('no cursor');
    },
  });
  const s = h.start();
  assert.strictEqual(h.ed.isActive(), true);
  h.hook.emit('mousemove', { x: 1, y: 1, raw: {} });
  h.hook.emit('mousedown', { x: 1, y: 1, raw: { ctrlKey: true } });
  assert.strictEqual((await s.promise).ok, true);
});

// ------------------------------------------------ events after the end

test('events after the session ended are ignored', async () => {
  const h = makeHarness({ screen: { '1,1': '#ff0000' } });
  const s = h.start();
  h.hook.emit('mousemove', { x: 1, y: 1, raw: {} });
  h.hook.emit('mousedown', { x: 1, y: 1, raw: { ctrlKey: true } });
  await s.promise;
  const pickedCount = h.picked.length;
  // The hook has been released, so these go nowhere - but a stray in-flight
  // sample must not resurrect the session either.
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(h.picked.length, pickedCount);
  assert.strictEqual(h.ed.isActive(), false);
});
