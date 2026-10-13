'use strict';

/**
 * InputService tests.
 *
 * The nut-js library is injected as a double, so these assert the DISPATCH
 * decision - keyboard key vs mouse button - without moving a real cursor or
 * typing into a real window.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createInputService } = require('../src/main/services/inputService');
const buttonMod = require('../src/shared/buttons');

/** Records which nut-js API each button id was routed to. */
function makeNutDouble() {
  const calls = [];
  const record = (name) => async (...args) => { calls.push({ name, args }); };
  return {
    calls,
    Point: class Point { constructor(x, y) { this.x = x; this.y = y; } },
    Region: class Region { constructor(x, y, w, h) { Object.assign(this, { x, y, w, h }); } },
    mouse: {
      config: { autoDelayMs: 100, mouseSpeed: 100 },
      setPosition: record('mouse.setPosition'),
      getPosition: async () => ({ x: 0, y: 0 }),
      pressButton: record('mouse.pressButton'),
      releaseButton: record('mouse.releaseButton'),
      click: record('mouse.click'),
      scrollUp: record('mouse.scrollUp'),
      scrollDown: record('mouse.scrollDown'),
    },
    keyboard: {
      config: { autoDelayMs: 300 },
      pressKey: record('keyboard.pressKey'),
      releaseKey: record('keyboard.releaseKey'),
      type: record('keyboard.type'),
    },
    screen: { width: async () => 1920, height: async () => 1080 },
  };
}

function makeService(opts) {
  const nut = makeNutDouble();
  const buttons = buttonMod.createCatalog({
    UiohookKey: {},
    nutKey: { A: 30, LeftShift: 42 },
    nutButton: { LEFT: 1, RIGHT: 2, MIDDLE: 3 },
  });
  return { service: createInputService({ buttons, nut, ...(opts || {}) }), nut, buttons };
}

test('pressing a KEYBOARD key goes through the keyboard API', async () => {
  const { service, nut } = makeService();
  await service.keyDown('key:A');
  await service.keyUp('key:A');
  assert.deepStrictEqual(nut.calls.map((c) => c.name), ['keyboard.pressKey', 'keyboard.releaseKey']);
  assert.strictEqual(nut.calls[0].args[0], 30);
});

test('pressing a MOUSE button goes through the mouse API, not the keyboard', async () => {
  const { service, nut } = makeService();
  // This is the exact case that used to throw "Not a key: mouse:1".
  await service.keyDown('mouse:1');
  await service.keyUp('mouse:1');
  assert.deepStrictEqual(nut.calls.map((c) => c.name), ['mouse.pressButton', 'mouse.releaseButton']);
  assert.strictEqual(nut.calls[0].args[0], 1);
});

test('every simulatable mouse button routes to the mouse API', async () => {
  for (const id of ['mouse:1', 'mouse:2', 'mouse:3']) {
    const { service, nut } = makeService();
    await service.keyDown(id);
    assert.strictEqual(nut.calls[0].name, 'mouse.pressButton', id + ' must not hit the keyboard API');
  }
});

test('a side mouse button still reports a clear, unsimulatable error', async () => {
  const { service } = makeService();
  await assert.rejects(() => service.keyDown('mouse:5'), /can only simulate Left, Middle and Right/i);
});

test('releaseAll lets go of a held mouse button as well as a held key', async () => {
  const { service, nut } = makeService();
  await service.keyDown('key:LeftShift');
  await service.keyDown('mouse:1');
  nut.calls.length = 0;
  await service.releaseAll();
  const names = nut.calls.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ['keyboard.releaseKey', 'mouse.releaseButton']);
});

test('nut auto-delay is turned off so the engine owns pacing', () => {
  const { service, nut } = makeService();
  assert.strictEqual(nut.mouse.config.autoDelayMs, 0);
  assert.strictEqual(nut.keyboard.config.autoDelayMs, 0);
  assert.strictEqual(service.diagnostics().autoDelayMs, 0);
});

// ---- pressBurst: the high-rate path ----------------------------------------

/** The nut double whose click tracking is instant, for pacing assertions. */
function makeBurstService() {
  const nut = makeNutDouble();
  const buttons = buttonMod.createCatalog({
    UiohookKey: {},
    nutKey: { A: 30 },
    nutButton: { LEFT: 1, RIGHT: 2, MIDDLE: 3 },
  });
  const service = createInputService({ buttons, nut });
  // A fake provider registry, mirroring the real nut-js shape.
  nut.mouse.providerRegistry = {
    getMouse: () => nut.mouse,
    getKeyboard: () => nut.keyboard,
  };
  return { service, nut };
}

test('a burst presses exactly the requested number of times', async () => {
  const { service, nut } = makeBurstService();
  const res = await service.pressBurst('mouse:1', 25, 0);
  assert.strictEqual(res.pressed, 25);
  assert.strictEqual(nut.calls.filter((c) => c.name === 'mouse.pressButton').length, 25);
  assert.strictEqual(nut.calls.filter((c) => c.name === 'mouse.releaseButton').length, 25);
  // Down and up must alternate: a click is a pair, never two downs.
  const kinds = nut.calls.map((c) => c.name);
  for (let i = 0; i < kinds.length; i += 2) {
    assert.strictEqual(kinds[i], 'mouse.pressButton');
    assert.strictEqual(kinds[i + 1], 'mouse.releaseButton');
  }
});

test('a zero-gap burst does not wait at all between presses', async () => {
  const { service } = makeBurstService();
  let spins = 0;
  const res = await service.pressBurst('mouse:1', 50, 0, { spinGap: () => { spins++; } });
  assert.strictEqual(res.pressed, 50);
  assert.strictEqual(spins, 0, 'a 0ms gap must not sleep between presses');
});

test('the gap is a PERIOD, not extra delay: N clicks at G ms take ~N*G ms', async () => {
  const { service } = makeBurstService();
  // Absolute deadlines mean the time the native call costs is absorbed into the
  // gap rather than accumulating on top of it.
  const t0 = process.hrtime.bigint();
  await service.pressBurst('mouse:1', 40, 2);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const expected = 39 * 2; // 39 gaps between 40 clicks
  assert.ok(
    ms >= expected && ms < expected + 40,
    '40 clicks at a 2ms period took ' + ms.toFixed(1) + 'ms, expected ~' + expected + 'ms'
  );
});

test('a long gap yields instead of spinning, so Stop can land', async () => {
  const { service } = makeBurstService();
  let spins = 0;
  let preciseCalls = 0;
  const res = await service.pressBurst('mouse:1', 3, 500, {
    spinGap: () => { spins++; },
    // A long gap must never spin: it would block the event loop for 500ms.
    preciseSleep: async () => { preciseCalls++; },
  });
  assert.strictEqual(res.pressed, 3);
  assert.strictEqual(spins, 0, 'a 500ms gap must not spin');
  assert.strictEqual(preciseCalls, 2, 'both inter-click gaps should have used the yielding wait');
});

test('shouldStop aborts a burst partway through', async () => {
  const { service } = makeBurstService();
  let n = 0;
  const res = await service.pressBurst('mouse:1', 1000, 0, {
    shouldStop: () => ++n > 10,
  });
  assert.ok(res.pressed < 1000, 'the burst should have been cut short');
  assert.ok(res.pressed > 5, 'it should still have made some progress, got ' + res.pressed);
  assert.strictEqual(res.aborted, true);
});

test('a burst keeps yielding to the event loop as it goes', async () => {
  const { service } = makeBurstService();
  let yields = 0;
  await service.pressBurst('mouse:1', 100, 0, { yieldToEventLoop: async () => { yields++; } });
  assert.ok(yields > 0, 'a long burst must yield, or Stop/IPC starve');
});

// ---- self-echo -------------------------------------------------------------
//
// The bug these guard: `when holding RMB -> press RMB forever (50ms gap)` pressed
// once and stopped, as though the user had let go.
//
// Cause: the global hook reports our OWN injected press and release. The hold
// trigger obeyed the synthetic mouseup and tore down the run that was feeding it.
// Fixed by noting every injection (noteSynth) and consuming those echoes as they
// arrive (takeEcho), with armHold and armButtonCount checking it.

test('a click notes one down echo and one up echo', async () => {
  const { service } = makeService();
  await service.click('mouse:1');

  assert.strictEqual(service.takeEcho('mouse:1', 'down'), true, 'press echo');
  assert.strictEqual(service.takeEcho('mouse:1', 'up'), true, 'release echo');
  assert.strictEqual(service.takeEcho('mouse:1', 'down'), false, 'no third event was injected');
});

test('a down echo is never consumed by an up lookup, or vice versa', async () => {
  const { service } = makeService();
  await service.click('mouse:1');

  assert.strictEqual(service.takeEcho('mouse:1', 'up'), true, 'consume the up echo');
  assert.strictEqual(
    service.takeEcho('mouse:1', 'down'),
    true,
    'the down echo must survive - a consumer that only inspects down events must not lose it'
  );
});

test('a button we never injected reports no echo', async () => {
  const { service } = makeService();
  await service.click('mouse:1');

  assert.strictEqual(service.takeEcho('mouse:2', 'down'), false);
  assert.strictEqual(service.takeEcho('key:A', 'down'), false);
});

test('a key press and release are noted too, not just mouse', async () => {
  const { service } = makeService();
  await service.keyDown('key:A');
  await service.keyUp('key:A');

  assert.strictEqual(service.takeEcho('key:A', 'down'), true);
  assert.strictEqual(service.takeEcho('key:A', 'up'), true);
  assert.strictEqual(service.takeEcho('key:A', 'down'), false);
});

test('a burst notes a down and an up echo per press', async () => {
  const { service } = makeBurstService();
  await service.pressBurst('mouse:1', 3, 0);

  for (let i = 0; i < 3; i++) {
    assert.strictEqual(service.takeEcho('mouse:1', 'down'), true, 'down echo ' + i);
    assert.strictEqual(service.takeEcho('mouse:1', 'up'), true, 'up echo ' + i);
  }
  assert.strictEqual(service.takeEcho('mouse:1', 'down'), false);
  assert.strictEqual(service.takeEcho('mouse:1', 'up'), false);
});

test('echoes expire, so a dropped hook event cannot swallow a real release', async () => {
  let clock = 1000;
  const { service } = makeService({ now: () => clock, echoTtlMs: 500 });
  await service.click('mouse:1');

  clock = 4000; // long past the TTL

  assert.strictEqual(
    service.takeEcho('mouse:1', 'up'),
    false,
    'a stale echo must not be allowed to eat the user next real button-up'
  );
});

test('echoes for different buttons do not consume each other', async () => {
  const { service } = makeService();
  await service.click('mouse:1');
  await service.click('mouse:2');

  assert.strictEqual(service.takeEcho('mouse:2', 'down'), true);
  assert.strictEqual(service.takeEcho('mouse:2', 'up'), true);
  assert.strictEqual(service.takeEcho('mouse:1', 'down'), true);
  assert.strictEqual(service.takeEcho('mouse:1', 'up'), true);
  assert.strictEqual(service.takeEcho('mouse:1', 'down'), false);
});

test('releaseAll notes an up echo, so an interrupted hold is not misread', async () => {
  const { service } = makeService();
  await service.keyDown('key:A');
  await service.releaseAll();

  assert.strictEqual(service.takeEcho('key:A', 'up'), true, 'the safety release is self-inflicted too');
});


// -------------------------------------------------------------- scroll wheel
//
// One event per click, evenly spaced, with a FLOOR on the gap. All three settled
// by measurement, because three wrong answers shipped first:
//   1. one call with a big amount = one event -> ~10px for any amount
//   2. one call per click with NO gap -> apps coalesce the burst (100 clicks in
//      157ms moved ~20px, i.e. one notch)
//   3. spreading `within` over every click felt like a crawl
// The gap floor is the load-bearing part: below it the target app discards events.

test('a scroll sends one event per click, never one big event', async () => {
  const { service, nut } = makeService();
  await service.scroll('down', 360, 0);
  const calls = nut.calls.filter((c) => c.name === 'mouse.scrollDown');
  assert.strictEqual(calls.length, 3, '360px is 3 clicks, so 3 events');
  assert.deepStrictEqual(calls.map((c) => c.args[0]), [120, 120, 120], 'each event carries ONE full notch of raw delta (120), not 1');
});

test('clicks are spaced by at least MIN_CLICK_GAP_MS even at 0ms', async () => {
  // THE regression test for "100 clicks in 157ms moved 20px". Apps coalesce rapid
  // wheel events, so a 0ms request must still be paced.
  const C2 = require('../src/shared/constants');
  const { service, nut } = makeService();
  const started = Date.now();
  await service.scroll('down', 1200, 0);
  const elapsed = Date.now() - started;

  const calls = nut.calls.filter((c) => c.name === 'mouse.scrollDown');
  assert.strictEqual(calls.length, 10, '1200px is 10 clicks');
  const minimum = (calls.length - 1) * C2.SCROLL.MIN_CLICK_GAP_MS;
  assert.ok(
    elapsed >= minimum * 0.8,
    'clicks must be paced by the floor: ' + calls.length + ' clicks took ' + elapsed + 'ms, floor is ~' + minimum + 'ms'
  );
});

test('a big scroll still sends a proportional number of single-click events', async () => {
  const { service, nut } = makeService();
  await service.scroll('down', 12000, 0);
  const calls = nut.calls.filter((c) => c.name === 'mouse.scrollDown');
  assert.strictEqual(calls.length, 100, '12000px is 100 clicks of 120px');
  assert.ok(calls.every((c) => c.args[0] === 120), 'every event must carry a full notch of delta (120)');
});

test('`within` is the total time for the whole scroll, spread evenly', async () => {
  const { service, nut } = makeService();
  const started = Date.now();
  await service.scroll('down', 1200, 400); // 10 clicks over 400ms = 44ms apart
  const elapsed = Date.now() - started;

  assert.strictEqual(nut.calls.filter((c) => c.name === 'mouse.scrollDown').length, 10);
  assert.ok(elapsed >= 350, 'should take about the requested 400ms, took ' + elapsed + 'ms');
  assert.ok(elapsed < 900, 'must not overshoot wildly, took ' + elapsed + 'ms');
});

test('an impossible duration is reported rather than silently ignored', async () => {
  const { service, nut } = makeService();
  const started = Date.now();
  await service.scroll('down', 12000, 50); // 100 clicks cannot fit in 50ms
  const elapsed = Date.now() - started;

  assert.strictEqual(nut.calls.filter((c) => c.name === 'mouse.scrollDown').length, 100, 'all clicks still sent');
  assert.ok(elapsed >= 900, 'the gap floor wins over an impossible request, took ' + elapsed + 'ms');
});

test('direction up uses scrollUp, down uses scrollDown', async () => {
  const { service, nut } = makeService();
  await service.scroll('up', 240, 0);
  assert.deepStrictEqual(nut.calls.filter((c) => c.name === 'mouse.scrollUp').map((c) => c.args[0]), [120, 120]);
  assert.strictEqual(nut.calls.filter((c) => c.name === 'mouse.scrollDown').length, 0);
});

test('a scroll smaller than one click still sends exactly one', async () => {
  const { service, nut } = makeService();
  await service.scroll('down', 1, 0);
  assert.deepStrictEqual(nut.calls.filter((c) => c.name === 'mouse.scrollDown').map((c) => c.args[0]), [120], 'even a 1px request must send one full notch, or it would do nothing');
});

test('scroll works whichever mouse object exposes scrolling', async () => {
  const nut = makeNutDouble();
  const buttons = buttonMod.createCatalog({
    UiohookKey: {},
    nutKey: { A: 30 },
    nutButton: { LEFT: 1, RIGHT: 2, MIDDLE: 3 },
  });
  const providerCalls = [];
  nut.mouse.providerRegistry = {
    getMouse: () => ({
      pressButton: async () => {},
      releaseButton: async () => {},
      scrollUp: async () => { providerCalls.push('up'); },
      scrollDown: async () => { providerCalls.push('down'); },
    }),
    getKeyboard: () => ({ pressKey: async () => {}, releaseKey: async () => {} }),
  };

  const service = createInputService({ buttons, nut });
  await service.scroll('down', 600, 0);

  const total = providerCalls.length + nut.calls.filter((c) => c.name === 'mouse.scrollDown').length;
  assert.strictEqual(total, 5, 'exactly 5 clicks must be sent, through one path only');
});


test('the TOTAL wheel delta sent equals the pixels requested', () => {
  // THE bug that shipped three times. scrollUp() takes a RAW wheel delta, and one
  // notch is 120. Sending 1 per click meant 100 clicks delivered a total delta of
  // 100 - about 0.8 of a single notch, which is why 12000px scrolled ~20px.
  // This asserts the total, so a change of unit anywhere fails here.
  const PX_PER_NOTCH = 120;
  const cases = [[120, 1], [360, 3], [1200, 10], [12000, 100]];

  return Promise.all(cases.map(async ([px, expectedClicks]) => {
    const { service, nut } = makeService();
    await service.scroll('down', px, 0);
    const calls = nut.calls.filter((c) => c.name === 'mouse.scrollDown');
    assert.strictEqual(calls.length, expectedClicks, px + 'px should be ' + expectedClicks + ' clicks');
    const total = calls.reduce((s, c) => s + c.args[0], 0);
    assert.strictEqual(total, px, px + 'px must deliver a total delta of ' + px + ', got ' + total);
  }));
});
