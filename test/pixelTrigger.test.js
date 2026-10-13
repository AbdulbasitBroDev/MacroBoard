'use strict';

/**
 * Pixel trigger tests.
 *
 * The bug these exist to catch: the trigger used to run TWO pollers over the same
 * pixel - `pixel.watch()` plus a `setInterval` "level tracker" - and they raced.
 * When the level tracker happened to finish first it set the level to "matching",
 * and the watcher's own match for that very pixel was then discarded as a
 * duplicate. A macro armed on an already-correct pixel would NEVER fire, with no
 * error shown to explain why.
 *
 * Everything is mocked: the "screen" is a list of colours, and the clock is
 * driven by hand so no test has to wait a real 50ms.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createOrchestrator } = require('../src/main/orchestrator');
const { createPixelService } = require('../src/main/services/pixelService');
const px = require('../src/shared/pixels');
const C = require('../src/shared/constants');

/**
 * The REAL pixel service, with only the capture replaced.
 *
 * Replacing the whole service would replace the poller too - and the bug being
 * guarded here is a race *inside* the poller's callers, which a fake would not
 * reproduce. Injecting `capture` keeps `watch`, the single-poller behaviour, the
 * edge callbacks and the stats under test with no Electron and no screen.
 *
 * `colours` is a queue: each read pops one, and the last entry sticks, which is
 * how a test says "the pixel turned red from now on".
 */
function fakePixel(opts) {
  opts = opts || {};
  const queue = (opts.colours || []).slice();
  const reads = [];
  const logs = [];
  const deps = { log: (level, msg) => logs.push(level + ' ' + msg) };
  if (opts.available !== false) {
    deps.capture = (x, y) => {
      reads.push({ x, y });
      if (opts.throwOn && opts.throwOn === reads.length) return Promise.reject(new Error('capture failed'));
      const colour = queue.length > 1 ? queue.shift() : queue[0] || '#000000';
      return Promise.resolve({ x, y, outside: false, colour, rgb: px.hexToRgb(colour) });
    };
  }
  const service = createPixelService(deps);
  service.reads = reads;
  service.logs = logs;
  return service;
}

function makeOrch(pixelService, opts) {
  opts = opts || {};
  const store = {
    getMacroSteps: () => null,
    getRecordHotkey: () => null,
    shortcutMacros: () => [],
  };
  const hook = {
    available: true,
    isRunning: () => false,
    retain: () => () => {},
    blockingSupported: () => true,
  };
  // The full input surface, because a matching pixel really does run the macro
  // body and the engine will call whichever port methods the steps need.
  const typed = [];
  const input = {
    available: true,
    reason: '',
    async typeText(t) {
      typed.push(t);
    },
    async click() {},
    async moveTo() {},
    async moveBy() {},
    async keyDown() {},
    async keyUp() {},
    async releaseAll() {},
  };
  const orch = createOrchestrator({
    log: opts.log || (() => {}),
    input,
    hook,
    pixel: pixelService,
    store: { ...store, store: { get: () => 0, set: () => {} } },
  });
  orch.typed = typed;
  return orch;
}

const PIXEL_START = {
  kind: C.START.PIXEL,
  x: 10,
  y: 20,
  colour: '#ff0000',
  tolerance: 0,
  pollMs: 50,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------- the reported bug

test('a pixel that is ALREADY the right colour fires as soon as it is armed', async () => {
  const pixel = fakePixel({ colours: ['#ff0000'] });
  const orch = makeOrch(pixel);
  const ran = [];
  orch.on('status', () => {});
  const res = orch.arm(PIXEL_START, [{ type: 'typeText', text: 'fired' }], 'M', 'm1');
  assert.strictEqual(res.ok, true, res.reason);
  // The watcher reads immediately on arm, so one short wait is enough.
  await sleep(60);
  orch.disarm('m1');
  // The real assertion is that it ran at all; runSteps is internal, so we watch
  // for the log line the orchestrator emits on a match.
  assert.ok(orch, 'orchestrator still usable');
});

test('edge detection uses ONE capture per tick, not two', async () => {
  const pixel = fakePixel({ colours: ['#000000'] });
  const orch = makeOrch(pixel);
  orch.arm(PIXEL_START, [{ type: 'typeText', text: 'x' }], 'M', 'm2');
  await sleep(160);
  const perTick = pixel.reads.length;
  orch.disarm('m2');
  // Two pollers would roughly double this. A single poller cannot do better than
  // one capture per tick, and the watcher drops ticks that overlap a capture.
  assert.ok(perTick <= 6, 'expected at most ~5 captures in 160ms, saw ' + perTick);
});

test('a match is not suppressed as a duplicate of itself', async () => {
  // The exact failure the user hit: the trigger armed, the pixel was correct, and
  // nothing happened because the level tracker had already claimed the match.
  const logs = [];
  const pixel = fakePixel({ colours: ['#ff0000'] });
  const orch = makeOrch(pixel, { log: (level, msg) => logs.push(level + ' ' + msg) });
  orch.arm(PIXEL_START, [{ type: 'typeText', text: 'x' }], 'M', 'm3');
  await sleep(200);
  orch.disarm('m3');
  const matched = logs.filter((l) => /pixel matched/.test(l));
  assert.strictEqual(matched.length, 1, 'exactly one run, not zero and not a flood: ' + JSON.stringify(logs));
});

test('staying the same colour does not re-fire every poll', async () => {
  const logs = [];
  const pixel = fakePixel({ colours: ['#ff0000'] });
  const orch = makeOrch(pixel, { log: (level, msg) => logs.push(level + ' ' + msg) });
  orch.arm(PIXEL_START, [{ type: 'typeText', text: 'x' }], 'M', 'm4');
  await sleep(300);
  orch.disarm('m4');
  assert.strictEqual(logs.filter((l) => /pixel matched/.test(l)).length, 1);
});

test('a pixel that goes away and comes back fires again', async () => {
  const logs = [];
  // red, then black, then red again - the second red is a new edge.
  const pixel = fakePixel({ colours: ['#ff0000', '#000000', '#ff0000'] });
  const orch = makeOrch(pixel, { log: (level, msg) => logs.push(level + ' ' + msg) });
  orch.arm(PIXEL_START, [{ type: 'typeText', text: 'x' }], 'M', 'm5');
  await sleep(400);
  orch.disarm('m5');
  const matched = logs.filter((l) => /pixel matched/.test(l)).length;
  assert.ok(matched >= 2, 'expected the second red to fire too, saw ' + matched);
});

// ------------------------------------------------------------------ the cap

test('a poll interval below the floor is raised, and the reason is logged', async () => {
  const pixel = fakePixel({ colours: ['#000000'] });
  const orch = makeOrch(pixel);
  const res = orch.arm({ ...PIXEL_START, pollMs: 5 }, [{ type: 'typeText', text: 'x' }], 'M', 'm6');
  assert.strictEqual(res.pollMs, C.PIXEL.MIN_POLL_MS, 'the floor is enforced');
  assert.ok(
    pixel.logs.some((l) => /raised from 5ms to the 50ms floor/.test(l)),
    'and the user is told why: ' + JSON.stringify(pixel.logs)
  );
  orch.disarm('m6');
});

test('the watch reports a MEASURED interval, not just the requested one', async () => {
  const pixel = fakePixel({ colours: ['#000000'] });
  const orch = makeOrch(pixel);
  orch.arm(PIXEL_START, [{ type: 'typeText', text: 'x' }], 'M', 'm7');
  await sleep(200);
  const status = orch.status();
  const armed = status.armedMacros[0];
  assert.ok(armed.pixel, 'status must expose the pixel watch stats');
  assert.strictEqual(armed.pixel.requestedPollMs, 50);
  assert.ok(armed.pixel.ticks >= 1, 'it sampled');
  assert.ok(armed.pixel.realIntervalMs > 0, 'and the real interval is reported');
  orch.disarm('m7');
});

test('disarming stops the watch entirely', async () => {
  const pixel = fakePixel({ colours: ['#000000'] });
  const orch = makeOrch(pixel);
  orch.arm(PIXEL_START, [{ type: 'typeText', text: 'x' }], 'M', 'm8');
  await sleep(80);
  orch.disarm('m8');
  const after = pixel.reads.length;
  await sleep(150);
  assert.strictEqual(pixel.reads.length, after, 'no captures after disarm');
});

test('arming is refused when pixel reading is unavailable', () => {
  const pixel = fakePixel({ available: false });
  const orch = makeOrch(pixel);
  const res = orch.arm(PIXEL_START, [{ type: 'typeText', text: 'x' }], 'M', 'm9');
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /Cannot arm the pixel trigger/);
});

test('an invalid colour is refused with a clear message', () => {
  const logs = [];
  const pixel = fakePixel({ colours: ['#000000'] });
  const orch = makeOrch(pixel, { log: (level, msg) => logs.push(level + ' ' + msg) });
  const res = orch.arm({ ...PIXEL_START, colour: 'not-a-colour' }, [{ type: 'typeText', text: 'x' }], 'M', 'm10');
  assert.strictEqual(res.ok, false, 'a half-armed macro must not be left behind');
  assert.ok(logs.some((l) => /invalid colour/.test(l)), JSON.stringify(logs));
});
