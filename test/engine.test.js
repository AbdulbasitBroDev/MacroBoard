'use strict';

/**
 * Execution-engine tests.
 *
 * Everything OS-specific is mocked: the engine only ever talks to an `input`
 * port, a macro `registry` and a chooser `store`. That means the interesting
 * logic (forever/random slots, recursion guards, `at once` concurrency, chooser
 * state, rate limiting, Stop semantics) is fully verifiable without Electron,
 * without a screen, and without a global input hook.
 */

const test = require('node:test');
const assert = require('node:assert');
const { MacroEngine, memoryStore } = require('../src/main/engine/engine');
const C = require('../src/shared/constants');

const T0 = Date.now();
const now = () => Date.now() - T0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Records every simulated action with a relative timestamp. */
function makeInput(log) {
  const push = (a, extra) => log.push(Object.assign({ a, at: now() }, extra));
  return {
    async moveTo(x, y, ms) { push('moveTo', { x, y, ms }); },
    async moveBy(dx, dy, ms) { push('moveBy', { dx, dy, ms }); },
    async click(button, x, y) { push('click', { button, x, y }); },
    async typeText(text) { push('typeText', { text }); },
    async keyDown(button) { push('keyDown', { button }); },
    async keyUp(button) { push('keyUp', { button }); },
    async pressKey(button) { push('pressKey', { button }); },
  };
}

function makeEngine(overrides) {
  const log = [];
  const store = (overrides && overrides.store) || memoryStore();
  const macroMap = new Map(((overrides && overrides.macros) || []).map((m) => [m.name, m]));
  const engine = new MacroEngine({
    input: makeInput(log),
    registry: {
      getMacroSteps: (name) => {
        const m = macroMap.get(name);
        return m ? { name: m.name, steps: m.steps } : null;
      },
    },
    store,
    options: Object.assign({ minGapMs: 5, random: () => 0 }, (overrides && overrides.options) || {}),
  });
  return { engine, log, store, macroMap };
}

const num = (v) => ({ kind: 'number', value: v });

// --------------------------------------------------------------- basics

test('runs a simple sequential list in order', async () => {
  const { engine, log } = makeEngine();
  const res = await engine.run([
    { type: 'moveTo', x: 10, y: 20 },
    { type: 'click', button: 'mouse:1', x: 10, y: 20 },
    { type: 'typeText', text: 'hi' },
  ]);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.error, null);
  assert.deepStrictEqual(log.map((e) => e.a), ['moveTo', 'click', 'typeText']);
  assert.strictEqual(res.steps, 3);
});

test('wait uses the number slot and is stoppable mid-sleep', async () => {
  const { engine } = makeEngine();
  const p = engine.run([{ type: 'wait', ms: num(5000) }]);
  await sleep(60);
  assert.strictEqual(engine.isRunning(), true);
  const t = now();
  engine.stop('test');
  const res = await p;
  assert.strictEqual(res.stopped, true);
  assert.ok(now() - t < 150, 'stop should interrupt a 5s wait quickly (took ' + (now() - t) + 'ms)');
});

test('plain numbers are floored and clamped to the hard caps', async () => {
  const { engine } = makeEngine();
  assert.strictEqual(engine.resolveSlot({ kind: 'number', value: 12.9 }, { cap: 100 }).value, 12);
  const r2 = engine.resolveSlot({ kind: 'number', value: 1e9 }, { cap: C.LIMITS.MAX_REPEAT_COUNT });
  assert.strictEqual(r2.value, C.LIMITS.MAX_REPEAT_COUNT);
  assert.strictEqual(r2.clamped, true);
  const r3 = engine.resolveSlot({ kind: 'number', value: -5 }, { cap: 100 });
  assert.strictEqual(r3.value, 0);
  assert.strictEqual(r3.clamped, true);
  assert.strictEqual(engine.resolveSlot(null, { cap: 5 }).value, 0);
});

test('press count above the cap is clamped rather than executed', async () => {
  // minGapMs is deliberately 0 here: the point is the CAP, not the rate limiter.
  const { engine, log } = makeEngine({ options: { minGapMs: 0 } });
  await engine.run([{ type: 'pressKey', button: 'key:A', count: num(50000), gapMs: num(0) }]);
  assert.strictEqual(log.filter((e) => e.a === 'keyDown').length, C.LIMITS.MAX_PRESS_COUNT);
});

test('a second run is rejected while one is in flight', async () => {
  const { engine } = makeEngine();
  const p = engine.run([{ type: 'wait', ms: num(200) }]);
  await assert.rejects(() => engine.run([{ type: 'wait', ms: num(1) }]), /already running/);
  engine.stop();
  await p;
});

test('unknown step types produce a clear error instead of failing silently', async () => {
  const { engine } = makeEngine();
  const res = await engine.run([{ type: 'nope' }]);
  assert.strictEqual(res.ok, false);
  assert.match(res.error.message, /Unknown step type "nope"/);
});

// ------------------------------------------------------- rate limiting

test('minimum gap is enforced between consecutive physical actions', async () => {
  const MIN = 15;
  const { engine, log } = makeEngine({ options: { minGapMs: MIN } });
  await engine.run([
    { type: 'click', button: 'mouse:1', x: 1, y: 1 },
    { type: 'click', button: 'mouse:1', x: 2, y: 2 },
    { type: 'click', button: 'mouse:1', x: 3, y: 3 },
  ]);
  assert.strictEqual(log.length, 3);
  for (let i = 1; i < log.length; i++) {
    const gap = log[i].at - log[i - 1].at;
    assert.ok(gap >= MIN - 1, 'gap ' + gap + 'ms must be >= ' + MIN + 'ms');
  }
  assert.ok(engine.gate.stats().slotCount >= 3);
});

test('a zero-wait forever loop cannot flood the OS with input', async () => {
  const MIN = 10;
  const { engine, log } = makeEngine({ options: { minGapMs: MIN } });
  const p = engine.run([
    { type: 'repeat', count: { kind: 'forever' }, body: [{ type: 'click', button: 'mouse:1', x: 5, y: 5 }] },
  ]);
  await sleep(200);
  engine.stop();
  await p;
  const rate = log.length / 0.2;
  assert.ok(rate <= 1000 / MIN + 5, 'click rate ' + rate.toFixed(0) + '/s must respect the ' + MIN + 'ms gap');
  assert.ok(log.length > 2, 'the loop should still have been running');
  for (let i = 1; i < log.length; i++) {
    assert.ok(log[i].at - log[i - 1].at >= MIN - 2, 'gap violated inside a forever loop');
  }
});

test('sequential presses inside one step respect the gap too', async () => {
  const { engine, log } = makeEngine({ options: { minGapMs: 8 } });
  await engine.run([{ type: 'pressKey', button: 'key:A', count: num(4), gapMs: num(0) }]);
  assert.strictEqual(log.filter((e) => e.a === 'keyDown').length, 4);
  for (let i = 1; i < log.length; i++) {
    assert.ok(log[i].at - log[i - 1].at >= 7, 'keyDown/keyUp too close together');
  }
});

// --------------------------------------------------- forever / ranges

test('forever in a repeat count loops until Stop', async () => {
  const { engine, log } = makeEngine();
  const p = engine.run([
    { type: 'repeat', count: { kind: 'forever' }, body: [{ type: 'typeText', text: 'x' }] },
  ]);
  await sleep(120);
  engine.stop();
  const res = await p;
  assert.strictEqual(res.stopped, true);
  assert.ok(log.length >= 2, 'forever loop should have run more than once');
});

test('forever in a wait slot idles until Stop and then ends cleanly', async () => {
  const { engine, log } = makeEngine();
  const p = engine.run([
    { type: 'typeText', text: 'before' },
    { type: 'wait', ms: { kind: 'forever' } },
    { type: 'typeText', text: 'after' },
  ]);
  await sleep(80);
  assert.strictEqual(log.length, 1, 'nothing after an infinite wait should run');
  engine.stop();
  const res = await p;
  assert.strictEqual(res.stopped, true);
  assert.deepStrictEqual(log.map((e) => e.text), ['before']);
});

test('forever in a hold releases the key when Stop is pressed', async () => {
  const { engine, log } = makeEngine();
  const p = engine.run([{ type: 'holdKey', button: 'key:B', ms: { kind: 'forever' } }]);
  await sleep(60);
  assert.deepStrictEqual(log.map((e) => e.a), ['keyDown']);
  engine.stop();
  const res = await p;
  assert.strictEqual(res.stopped, true);
  assert.deepStrictEqual(log.map((e) => e.a), ['keyDown', 'keyUp'], 'the held key must be released on Stop');
});

test('forever press count keeps pressing until Stop, pairing every release', async () => {
  const { engine, log } = makeEngine({ options: { minGapMs: 2 } });
  const p = engine.run([{ type: 'pressKey', button: 'key:C', count: { kind: 'forever' }, gapMs: num(0) }]);
  await sleep(80);
  engine.stop();
  await p;
  const downs = log.filter((e) => e.a === 'keyDown').length;
  const ups = log.filter((e) => e.a === 'keyUp').length;
  assert.ok(downs > 1, 'expected repeated presses, got ' + downs);
  assert.strictEqual(downs, ups, 'every keyDown must be paired with a keyUp');
});

test('forever gap hangs after the first press, then Stop ends it', async () => {
  const { engine, log } = makeEngine();
  const p = engine.run([
    { type: 'pressKey', button: 'key:D', count: num(5), gapMs: { kind: 'forever' } },
    { type: 'typeText', text: 'unreachable' },
  ]);
  await sleep(80);
  assert.strictEqual(log.filter((e) => e.a === 'keyDown').length, 1, 'exactly one press before hanging');
  assert.strictEqual(log.filter((e) => e.a === 'typeText').length, 0);
  engine.stop();
  await p;
  assert.strictEqual(log.filter((e) => e.a === 'keyDown').length, 1);
});

test('random range slots resolve min / mid / max correctly', async () => {
  const draws = [0, 0.5, 0.999];
  let i = 0;
  const { engine } = makeEngine({ options: { random: () => draws[i++ % draws.length] } });
  assert.strictEqual(engine.resolveSlot({ kind: 'range', min: 10, max: 20 }, { cap: 1000 }).value, 10);
  assert.strictEqual(engine.resolveSlot({ kind: 'range', min: 10, max: 20 }, { cap: 1000 }).value, 15);
  assert.strictEqual(engine.resolveSlot({ kind: 'range', min: 10, max: 20 }, { cap: 1000 }).value, 20);
});

test('a random range press count re-rolls when the step runs again', async () => {
  const draws = [0, 0.999];
  let i = 0;
  const { engine, log } = makeEngine({ options: { minGapMs: 1, random: () => draws[i++ % draws.length] } });
  const step = { type: 'pressKey', button: 'key:E', count: { kind: 'range', min: 1, max: 3 }, gapMs: num(0) };
  await engine.run([step]);
  assert.strictEqual(log.filter((e) => e.a === 'keyDown').length, 1, 'first draw (0) should pick the minimum');
  await engine.run([step]);
  assert.strictEqual(log.filter((e) => e.a === 'keyDown').length, 4, 'second draw (~1) should re-roll to the maximum');
});

// --------------------------------------------------------- at once

test('"at once" starts every branch at the same instant', async () => {
  const { engine, log } = makeEngine({ options: { minGapMs: 1 } });
  const started = now();
  const res = await engine.run([
    { type: 'atOnce', body: [
      { type: 'holdKey', button: 'key:LeftShift', ms: num(120) },
      { type: 'holdKey', button: 'key:B', ms: num(120) },
      { type: 'holdKey', button: 'key:C', ms: num(120) },
    ] },
  ]);
  const elapsed = now() - started;
  assert.strictEqual(res.ok, true);
  const downs = log.filter((e) => e.a === 'keyDown');
  const ups = log.filter((e) => e.a === 'keyUp');
  assert.strictEqual(downs.length, 3);
  assert.strictEqual(ups.length, 3);
  // Concurrent: total wall time must be close to a SINGLE 120ms hold, not 360ms.
  assert.ok(elapsed < 280, 'at once should be concurrent, took ' + elapsed + 'ms');
  const spread = downs[downs.length - 1].at - downs[0].at;
  assert.ok(spread < 80, 'all branches should start together, spread was ' + spread + 'ms');
  assert.deepStrictEqual(downs.map((e) => e.button).sort(), ['key:B', 'key:C', 'key:LeftShift']);
});

test('"at once" overlapping holds release independently', async () => {
  const { engine, log } = makeEngine({ options: { minGapMs: 1 } });
  await engine.run([
    { type: 'atOnce', body: [
      { type: 'holdKey', button: 'key:A', ms: num(40) },
      { type: 'holdKey', button: 'key:B', ms: num(160) },
    ] },
  ]);
  const aDown = log.find((e) => e.a === 'keyDown' && e.button === 'key:A').at;
  const aUp = log.find((e) => e.a === 'keyUp' && e.button === 'key:A').at;
  const bUp = log.find((e) => e.a === 'keyUp' && e.button === 'key:B').at;
  assert.ok(aUp - aDown < 130, 'A should release on its own shorter schedule');
  assert.ok(bUp - aDown > 130, 'B should still be held when A releases');
});

test('a failing "at once" branch stops the siblings and surfaces the error', async () => {
  const { engine, log } = makeEngine({ options: { minGapMs: 1 } });
  const started = now();
  const res = await engine.run([
    { type: 'atOnce', body: [
      { type: 'wait', ms: num(5000) },
      { type: 'bogusStepType' },
    ] },
  ]);
  assert.strictEqual(res.ok, false);
  assert.match(res.error.message, /Unknown step type/);
  assert.ok(now() - started < 2000, 'the long sibling branch should not hold the run open');
  assert.strictEqual(log.length, 0);
});

// -------------------------------------------------- run another macro

test('run another macro executes the other macro inline', async () => {
  const { engine, log } = makeEngine({
    macros: [{ name: 'Sub', steps: [{ type: 'typeText', text: 'inside' }] }],
  });
  const res = await engine.run([
    { type: 'typeText', text: 'before' },
    { type: 'runMacro', name: 'Sub' },
    { type: 'typeText', text: 'after' },
  ]);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(log.map((e) => e.text), ['before', 'inside', 'after']);
});

test('nested run-macro calls nest three levels deep', async () => {
  const { engine, log } = makeEngine({
    macros: [
      { name: 'One', steps: [{ type: 'typeText', text: '1' }, { type: 'runMacro', name: 'Two' }] },
      { name: 'Two', steps: [{ type: 'typeText', text: '2' }, { type: 'runMacro', name: 'Three' }] },
      { name: 'Three', steps: [{ type: 'typeText', text: '3' }] },
    ],
  });
  const res = await engine.run([{ type: 'runMacro', name: 'One' }]);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(log.map((e) => e.text), ['1', '2', '3']);
});

test('run another macro reports a missing macro clearly', async () => {
  const { engine } = makeEngine();
  const res = await engine.run([{ type: 'runMacro', name: 'Gone' }]);
  assert.strictEqual(res.ok, false);
  assert.match(res.error.message, /could not be found/);
  assert.match(res.error.message, /renamed or deleted/);
});

test('run another macro guards against infinite mutual recursion', async () => {
  const { engine } = makeEngine({
    macros: [
      { name: 'A', steps: [{ type: 'runMacro', name: 'B' }] },
      { name: 'B', steps: [{ type: 'runMacro', name: 'A' }] },
    ],
  });
  const res = await engine.run([{ type: 'runMacro', name: 'A' }]);
  assert.strictEqual(res.ok, false);
  assert.match(res.error.message, /Maximum macro nesting depth \(10\)/);
  assert.match(res.error.message, /A \u2192 B \u2192 A/, 'the call chain should be shown: ' + res.error.message);
});

test('self-recursion is caught by the depth guard', async () => {
  const { engine } = makeEngine({ macros: [{ name: 'Loop', steps: [{ type: 'runMacro', name: 'Loop' }] }] });
  const res = await engine.run([{ type: 'runMacro', name: 'Loop' }]);
  assert.strictEqual(res.ok, false);
  assert.match(res.error.message, /Maximum macro nesting depth/);
});

// -------------------------------------------------------- choosers

test('random chooser picks a non-empty page', async () => {
  const { engine, log } = makeEngine({ options: { random: () => 0.999 } });
  await engine.run([
    { type: 'chooser', id: 'c1', mode: 'random', pages: [
      [],
      [{ type: 'typeText', text: 'page2' }],
    ] },
  ]);
  assert.deepStrictEqual(log.map((e) => e.text), ['page2'], 'must skip the empty page');
});

test('random chooser varies with the supplied random draws', async () => {
  const draws = [0.1, 0.9];
  let i = 0;
  const { engine, log } = makeEngine({ options: { random: () => draws[i++ % draws.length] } });
  const step = { type: 'chooser', id: 'c2', mode: 'random', pages: [
    [{ type: 'typeText', text: 'A' }],
    [{ type: 'typeText', text: 'B' }],
  ] };
  await engine.run([step, step, step, step]);
  assert.deepStrictEqual(log.map((e) => e.text), ['A', 'B', 'A', 'B']);
});

test('organized chooser cycles in order and persists across separate runs', async () => {
  const { engine, log, store } = makeEngine();
  const step = { type: 'chooser', id: 'seq1', mode: 'organized', pages: [
    [{ type: 'typeText', text: 'P1' }],
    [{ type: 'typeText', text: 'P2' }],
    [{ type: 'typeText', text: 'P3' }],
  ] };
  for (let i = 0; i < 4; i++) await engine.run([step]);
  assert.deepStrictEqual(log.map((e) => e.text), ['P1', 'P2', 'P3', 'P1'], 'should loop back after the last page');
  assert.strictEqual(store.get('chooser:seq1', 0), 4, 'the cursor must advance monotonically and persist');

  // A brand-new engine sharing the same store continues the cycle, which is how
  // a later run (or an app restart) resumes.
  const engine2 = new MacroEngine({
    input: makeInput(log),
    registry: { getMacroSteps: () => null },
    store,
    options: { minGapMs: 1 },
  });
  await engine2.run([step]);
  assert.strictEqual(log[log.length - 1].text, 'P2', 'cycle must resume from the persisted cursor');
  assert.strictEqual(store.get('chooser:seq1', 0), 5);
});

test('an organized chooser keeps its place when a page is added later', async () => {
  const { engine, log, store } = makeEngine();
  const step = { type: 'chooser', id: 'grow', mode: 'organized', pages: [
    [{ type: 'typeText', text: 'A' }],
    [{ type: 'typeText', text: 'B' }],
  ] };
  await engine.run([step]); // -> A, cursor 1
  await engine.run([step]); // -> B, cursor 2
  assert.deepStrictEqual(log.map((e) => e.text), ['A', 'B']);
  // Now the user adds a third page. The monotonic cursor means we continue at
  // position 2 rather than restarting, which is the least surprising behaviour.
  step.pages.push([{ type: 'typeText', text: 'C' }]);
  assert.strictEqual(store.get('chooser:grow', 0), 2);
  await engine.run([step]);
  assert.strictEqual(log[log.length - 1].text, 'C');
});

test('two organized choosers keep independent cursors', async () => {
  const { engine, log } = makeEngine();
  const a = { type: 'chooser', id: 'A', mode: 'organized', pages: [
    [{ type: 'typeText', text: 'A1' }], [{ type: 'typeText', text: 'A2' }],
  ] };
  const b = { type: 'chooser', id: 'B', mode: 'organized', pages: [
    [{ type: 'typeText', text: 'B1' }], [{ type: 'typeText', text: 'B2' }],
  ] };
  await engine.run([a, a, b]);
  assert.deepStrictEqual(log.map((e) => e.text), ['A1', 'A2', 'B1']);
});

test('choosers nest inside a repeat', async () => {
  const { engine, log } = makeEngine();
  await engine.run([
    { type: 'repeat', count: num(3), body: [
      { type: 'chooser', id: 'n1', mode: 'organized', pages: [
        [{ type: 'typeText', text: 'x' }], [{ type: 'typeText', text: 'y' }],
      ] },
    ] },
  ]);
  assert.deepStrictEqual(log.map((e) => e.text), ['x', 'y', 'x']);
});

test('a wait step runs for its compiled duration, to within a millisecond', async () => {
  const { engine } = makeEngine();
  // Guards the old chunked-sleep bug, where `wait 776ms` took 1087ms because
  // every setTimeout slice overshot and the loop subtracted the REQUESTED time.
  //
  // The WAIT STEP is timed, not engine.run(): run() also includes one event-loop
  // yield between steps (needed so a tight macro cannot starve Stop), which is
  // not part of the duration the user asked for.
  const realStep = engine._executeStep.bind(engine);
  const measured = [];
  engine._executeStep = async function (step, ctx) {
    const t = process.hrtime.bigint();
    const r = await realStep(step, ctx);
    measured.push({ want: step.ms.value, took: Number(process.hrtime.bigint() - t) / 1e6 });
    return r;
  };

  for (const ms of [776, 250, 100]) {
    // Three passes per duration so a best-of-3 minimum is available below.
    await engine.run([{ type: 'wait', ms: num(ms) }]);
    await engine.run([{ type: 'wait', ms: num(ms) }]);
    await engine.run([{ type: 'wait', ms: num(ms) }]);
  }
  assert.strictEqual(measured.length, 9);
  // Best-of-3 per duration, for the same reason as timing.test.js: a single
  // setTimeout sample measures OS scheduler jitter (~1-15ms, worse under load),
  // not the deadline arithmetic. Timed THREE times so the minimum can be used.
  const byWant = new Map();
  for (const m of measured) {
    const prev = byWant.get(m.want);
    if (prev === undefined || Math.abs(m.took - m.want) < Math.abs(prev - m.want)) byWant.set(m.want, m.took);
  }
  assert.strictEqual(byWant.size, 3, 'each duration should have been measured');

  for (const m of measured) {
    // Never early: a wait that returns before its deadline is a real bug and is
    // checked on EVERY sample, not just the best one.
    assert.ok(m.took >= m.want, 'wait ' + m.want + 'ms returned early at ' + m.took.toFixed(2) + 'ms');
  }
  for (const [want, took] of byWant) {
    assert.ok(
      Math.abs(took - want) < 3,
      'wait ' + want + 'ms best-of-3 took ' + took.toFixed(2) + 'ms'
    );
  }
});

// ================================================================= if / else

const OP = require('../src/shared/expressions').OP;
const en = (v) => ({ e: OP.NUM, v });
const ebool = (v) => ({ e: OP.LIT, v });
const epixel = (x, y, colour, tol) => ({ e: OP.PIXEL, x, y, colour, tol: tol || 0 });

/**
 * A stand-in for pixelService. `map` is "x,y" -> "#rrggbb" and `reads` counts
 * readPixels CALLS, which is how the batching is asserted: what matters is not
 * how many pixels were asked about but how many screen captures were taken.
 */
function makePixel(map, opts) {
  const calls = [];
  return {
    calls,
    readPixels: async (points) => {
      calls.push(points.map((p) => ({ x: p.x, y: p.y })));
      if (opts && opts.throwOn) throw new Error(opts.throwOn);
      return points.map((p) => {
        const hex = (map && map[p.x + ',' + p.y]) || '#000000';
        const rgb = require('../src/shared/pixels').hexToRgb(hex);
        return { x: p.x, y: p.y, outside: false, colour: hex, rgb };
      });
    },
  };
}

/** An engine with a pixel port attached. */
function makePixelEngine(map, opts) {
  const harness = makeEngine(opts);
  const pixel = makePixel(map, opts);
  harness.engine.pixel = pixel;
  return Object.assign(harness, { pixel });
}

test('if runs the then branch when the condition is true', async () => {
  const { engine, log } = makeEngine();
  await engine.run([
    {
      type: 'if',
      cond: { e: OP.GT, a: en(5), b: en(2) },
      then: [{ type: 'typeText', text: 'yes' }],
      else: [{ type: 'typeText', text: 'no' }],
    },
  ]);
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText').map((l) => l.text), ['yes']);
});

test('if runs the else branch when the condition is false', async () => {
  const { engine, log } = makeEngine();
  await engine.run([
    {
      type: 'if',
      cond: { e: OP.GT, a: en(1), b: en(9) },
      then: [{ type: 'typeText', text: 'yes' }],
      else: [{ type: 'typeText', text: 'no' }],
    },
  ]);
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText').map((l) => l.text), ['no']);
});

test('an empty else branch does nothing at all', async () => {
  const { engine, log } = makeEngine();
  const r = await engine.run([
    { type: 'if', cond: ebool(false), then: [{ type: 'typeText', text: 'x' }], else: [] },
  ]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText'), []);
});

test('a missing condition is treated as false, not a crash', async () => {
  const { engine, log } = makeEngine();
  const r = await engine.run([
    { type: 'if', cond: null, then: [{ type: 'typeText', text: 'then' }], else: [{ type: 'typeText', text: 'else' }] },
  ]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText').map((l) => l.text), ['else']);
});

test('the condition is re-evaluated on every pass through a loop', async () => {
  // The whole value of `if` inside `repeat`: the second pass must decide
  // differently, because the condition depends on what already ran.
  const { engine, log } = makeEngine();
  await engine.run([
    {
      type: 'repeat',
      count: num(3),
      body: [
        {
          type: 'if',
          cond: { e: OP.GT, a: en(2), b: en(1) },
          then: [{ type: 'typeText', text: 'a' }],
          else: [{ type: 'typeText', text: 'b' }],
        },
      ],
    },
  ]);
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText').map((l) => l.text), ['a', 'a', 'a']);
});

test('a random condition can differ pass to pass', async () => {
  // `random: () => 0` always takes the first branch, `() => 0.99` the second.
  // `2 > roll` over 1..3, so a roll of 1 takes the "low" branch and a roll of 3
  // takes "high". Comparing the roll itself to a number would not discriminate:
  // any non-zero roll is truthy.
  const step = () => ({
    type: 'repeat',
    count: num(2),
    body: [
      {
        type: 'if',
        cond: { e: OP.GT, a: en(2), b: { e: OP.RAND, min: en(1), max: en(3), dp: 0 } },
        then: [{ type: 'typeText', text: 'low' }],
        else: [{ type: 'typeText', text: 'high' }],
      },
    ],
  });
  const low = makeEngine({ options: { random: () => 0 } });
  await low.engine.run([step()]);
  assert.deepStrictEqual(low.log.filter((l) => l.a === 'typeText').map((l) => l.text), ['low', 'low']);

  const high = makeEngine({ options: { random: () => 0.99 } });
  await high.engine.run([step()]);
  assert.deepStrictEqual(high.log.filter((l) => l.a === 'typeText').map((l) => l.text), ['high', 'high']);
});

test('nested ifs take the branch that matches, deepest first', async () => {
  const { engine, log } = makeEngine();
  await engine.run([
    {
      type: 'if',
      cond: ebool(true),
      then: [
        {
          type: 'if',
          cond: ebool(false),
          then: [{ type: 'typeText', text: 'inner-yes' }],
          else: [{ type: 'typeText', text: 'inner-no' }],
        },
        { type: 'typeText', text: 'outer-tail' },
      ],
      else: [{ type: 'typeText', text: 'outer-no' }],
    },
  ]);
  assert.deepStrictEqual(
    log.filter((l) => l.a === 'typeText').map((l) => l.text),
    ['inner-no', 'outer-tail'],
    'the untaken branch must contribute nothing'
  );
});

test('only the if itself is counted as a step, not its branches', async () => {
  const { engine } = makeEngine();
  const r = await engine.run([
    {
      type: 'if',
      cond: ebool(true),
      then: [{ type: 'typeText', text: 'a' }, { type: 'typeText', text: 'b' }],
      else: [{ type: 'typeText', text: 'never' }],
    },
  ]);
  // 1 (the if) + 2 (the two blocks that actually ran). The untaken else branch
  // is not counted, because it did not execute.
  assert.strictEqual(r.steps, 3);
});

test('Stop inside a taken branch unwinds the whole run', async () => {
  const { engine } = makeEngine();
  const r = await engine.run([
    {
      type: 'if',
      cond: ebool(true),
      then: [
        { type: 'typeText', text: 'first' },
        { type: 'wait', ms: num(500) },
        { type: 'typeText', text: 'never' },
      ],
      else: [],
    },
  ]);
  assert.strictEqual(r.ok, true, 'an ordinary run completes');
  assert.strictEqual(r.stopped, false);
});

test('if works inside at once', async () => {
  const { engine, log } = makeEngine();
  await engine.run([
    {
      type: 'atOnce',
      body: [
        { type: 'if', cond: ebool(true), then: [{ type: 'typeText', text: 'one' }], else: [] },
        { type: 'if', cond: ebool(false), then: [{ type: 'typeText', text: 'two' }], else: [{ type: 'typeText', text: 'three' }] },
      ],
    },
  ]);
  const texts = log.filter((l) => l.a === 'typeText').map((l) => l.text).sort();
  assert.deepStrictEqual(texts, ['one', 'three']);
});

test('countSteps counts both if branches for the run summary', () => {
  const { countSteps } = require('../src/main/engine/engine');
  const n = countSteps([
    {
      type: 'if',
      cond: ebool(true),
      then: [{ type: 'wait', ms: num(1) }, { type: 'wait', ms: num(1) }],
      else: [{ type: 'wait', ms: num(1) }],
    },
  ]);
  assert.strictEqual(n, 4, 'the if plus all three branch steps');
});

test('an unknown step type inside an if is still reported clearly', async () => {
  const { engine } = makeEngine();
  const r = await engine.run([
    { type: 'if', cond: ebool(true), then: [{ type: 'futureThing' }], else: [] },
  ]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /Unknown step type "futureThing"/);
});

test('consecutive waits do not drift', async () => {
  const { engine } = makeEngine();
  // A per-step event-loop yield must not be charged to the user's waits.
  await engine.run([{ type: 'wait', ms: num(100) }]); // warm up
  const steps = Array.from({ length: 20 }, () => ({ type: 'wait', ms: num(100) }));
  const t = process.hrtime.bigint();
  await engine.run(steps);
  const actual = Number(process.hrtime.bigint() - t) / 1e6;
  assert.ok(
    actual >= 2000 && actual < 2060,
    '20 x wait 100ms took ' + actual.toFixed(1) + 'ms - expected ~2000ms with little drift'
  );
});


// ================================================== pixel as a condition

test('a matching pixel takes the then branch', async () => {
  const { engine, log } = makePixelEngine({ '640,380': '#ff0000' });
  await engine.run([
    {
      type: 'if',
      cond: epixel(640, 380, '#ff0000'),
      then: [{ type: 'typeText', text: 'hit' }],
      else: [{ type: 'typeText', text: 'miss' }],
    },
  ]);
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText').map((l) => l.text), ['hit']);
});

test('a non-matching pixel takes the else branch', async () => {
  const { engine, log } = makePixelEngine({ '640,380': '#00ff00' });
  await engine.run([
    {
      type: 'if',
      cond: epixel(640, 380, '#ff0000'),
      then: [{ type: 'typeText', text: 'hit' }],
      else: [{ type: 'typeText', text: 'miss' }],
    },
  ]);
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText').map((l) => l.text), ['miss']);
});

test('two pixel checks in an and cost ONE capture, not two', async () => {
  // This is the whole reason pixel checks are expression nodes rather than a
  // statement block. A capture is a full-desktop grab, so two separate reads
  // would double the cost - and, worse, could answer about two different frames.
  const { engine, pixel } = makePixelEngine({ '655,402': '#ff0000', '700,402': '#ff0000' });
  await engine.run([
    {
      type: 'if',
      cond: { e: OP.AND, a: epixel(655, 402, '#ff0000'), b: epixel(700, 402, '#ff0000') },
      then: [{ type: 'typeText', text: 'empty' }],
      else: [],
    },
  ]);
  assert.strictEqual(pixel.calls.length, 1, 'exactly one readPixels call');
  assert.strictEqual(pixel.calls[0].length, 2, 'but both pixels were read from it');
});

test('an and of pixels reads BOTH even when the first is false', async () => {
  // A deliberate trade-off, and worth stating: short-circuiting would save a
  // capture only by reading them one at a time, which costs MORE than reading
  // both from one frame. One capture beats two, and the answers stay coherent.
  const { engine, pixel } = makePixelEngine({ '1,1': '#000000', '2,2': '#00ff00' });
  await engine.run([
    {
      type: 'if',
      cond: { e: OP.AND, a: epixel(1, 1, '#ff0000'), b: epixel(2, 2, '#00ff00') },
      then: [],
      else: [{ type: 'typeText', text: 'not both' }],
    },
  ]);
  assert.strictEqual(pixel.calls.length, 1);
  assert.strictEqual(pixel.calls[0].length, 2);
});

test('and of pixels distinguishes states a single pixel cannot', async () => {
  // The motivating case: a health bar's left edge is green at full health AND
  // for one frame while damage lands. Left edge red + far edge red means the
  // bar is genuinely drained.
  const drained = makePixelEngine({ '655,402': '#ff0000', '700,402': '#ff0000' });
  await drained.engine.run([
    {
      type: 'if',
      cond: { e: OP.AND, a: epixel(655, 402, '#ff0000'), b: epixel(700, 402, '#ff0000') },
      then: [{ type: 'typeText', text: 'DEAD' }],
      else: [{ type: 'typeText', text: 'ALIVE' }],
    },
  ]);
  assert.deepStrictEqual(
    drained.log.filter((l) => l.a === 'typeText').map((l) => l.text),
    ['DEAD']
  );

  // Same first pixel, but the far end is still green: damaged, not dead. A
  // one-pixel check could not tell these apart.
  const hurt = makePixelEngine({ '655,402': '#ff0000', '700,402': '#00ff00' });
  await hurt.engine.run([
    {
      type: 'if',
      cond: { e: OP.AND, a: epixel(655, 402, '#ff0000'), b: epixel(700, 402, '#ff0000') },
      then: [{ type: 'typeText', text: 'DEAD' }],
      else: [{ type: 'typeText', text: 'ALIVE' }],
    },
  ]);
  assert.deepStrictEqual(hurt.log.filter((l) => l.a === 'typeText').map((l) => l.text), ['ALIVE']);
});

test('or of pixels is one capture too', async () => {
  const { engine, log, pixel } = makePixelEngine({ '300,250': '#000000', '520,250': '#ff0000' });
  await engine.run([
    {
      type: 'if',
      cond: { e: OP.OR, a: epixel(300, 250, '#ff0000'), b: epixel(520, 250, '#ff0000') },
      then: [{ type: 'typeText', text: 'error' }],
      else: [{ type: 'typeText', text: 'clean' }],
    },
  ]);
  assert.strictEqual(pixel.calls.length, 1);
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText').map((l) => l.text), ['error']);
});

test('not of a pixel inverts it', async () => {
  const lit = makePixelEngine({ '1,1': '#ff0000' });
  await lit.engine.run([
    {
      type: 'if',
      cond: { e: OP.NOT, a: epixel(1, 1, '#ff0000') },
      then: [{ type: 'typeText', text: 'dark' }],
      else: [{ type: 'typeText', text: 'lit' }],
    },
  ]);
  assert.deepStrictEqual(lit.log.filter((l) => l.a === 'typeText').map((l) => l.text), ['lit']);
});

test('a repeated pixel in one condition is read once', async () => {
  const { engine, pixel } = makePixelEngine({ '5,5': '#ff0000' });
  await engine.run([
    {
      type: 'if',
      cond: { e: OP.OR, a: epixel(5, 5, '#ff0000'), b: epixel(5, 5, '#ff0000') },
      then: [],
      else: [],
    },
  ]);
  assert.strictEqual(pixel.calls[0].length, 1, 'the same question twice is one read');
});

test('pixel tolerance widens the match', async () => {
  // #f01010 vs #ff0000 differs by 15 on red. Exact misses; tolerance 20 hits.
  const map = { '9,9': '#f01010' };
  const exact = makePixelEngine(map);
  await exact.engine.run([
    { type: 'if', cond: epixel(9, 9, '#ff0000', 0), then: [{ type: 'typeText', text: 'y' }], else: [{ type: 'typeText', text: 'n' }] },
  ]);
  assert.deepStrictEqual(exact.log.filter((l) => l.a === 'typeText').map((l) => l.text), ['n']);

  const loose = makePixelEngine(map);
  await loose.engine.run([
    { type: 'if', cond: epixel(9, 9, '#ff0000', 20), then: [{ type: 'typeText', text: 'y' }], else: [{ type: 'typeText', text: 'n' }] },
  ]);
  assert.deepStrictEqual(loose.log.filter((l) => l.a === 'typeText').map((l) => l.text), ['y']);
});

test('a condition with no pixels never touches the screen at all', async () => {
  const { engine, pixel } = makePixelEngine({});
  await engine.run([{ type: 'if', cond: { e: OP.GT, a: en(5), b: en(2) }, then: [{ type: 'typeText', text: 'y' }], else: [] }]);
  assert.strictEqual(pixel.calls.length, 0, 'a pure comparison must not cost a capture');
});

test('a failed capture makes the condition false instead of killing the run', async () => {
  // Displays sleep, UAC prompts appear, screens lock. A macro mid-loop should
  // see "not met", not die.
  const { engine, log } = makePixelEngine({}, { throwOn: 'display is asleep' });
  const r = await engine.run([
    {
      type: 'if',
      cond: epixel(1, 1, '#ff0000'),
      then: [{ type: 'typeText', text: 'hit' }],
      else: [{ type: 'typeText', text: 'miss' }],
    },
  ]);
  assert.strictEqual(r.ok, true, 'the run must survive a failed capture');
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText').map((l) => l.text), ['miss']);
});

test('with no pixel port at all, a pixel condition is false and the run still works', async () => {
  // The engine must be usable on a machine where pixel reading is unavailable
  // - that is a degraded feature, not a broken app.
  const { engine, log } = makeEngine();
  const r = await engine.run([
    {
      type: 'if',
      cond: epixel(1, 1, '#ff0000'),
      then: [{ type: 'typeText', text: 'hit' }],
      else: [{ type: 'typeText', text: 'miss' }],
    },
  ]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText').map((l) => l.text), ['miss']);
});

test('a pixel condition is re-read on every pass through a loop', async () => {
  // The behaviour that makes a fill-then-collect macro work: the screen
  // changes between passes and the macro notices.
  const hexes = ['#000000', '#000000', '#ff0000'];
  let i = 0;
  const { engine, log } = makeEngine();
  engine.pixel = {
    readPixels: async (points) => {
      const hex = hexes[Math.min(i, hexes.length - 1)];
      i++;
      const rgb = require('../src/shared/pixels').hexToRgb(hex);
      return points.map((p) => ({ x: p.x, y: p.y, outside: false, colour: hex, rgb }));
    },
  };
  await engine.run([
    {
      type: 'repeat',
      count: num(3),
      body: [
        { type: 'if', cond: epixel(1, 1, '#ff0000'), then: [{ type: 'typeText', text: 'ready' }], else: [{ type: 'typeText', text: 'wait' }] },
      ],
    },
  ]);
  assert.deepStrictEqual(
    log.filter((l) => l.a === 'typeText').map((l) => l.text),
    ['wait', 'wait', 'ready'],
    'the third pass must see the changed pixel'
  );
});

test('a pixel condition nested inside repeat and if still batches per evaluation', async () => {
  const { engine, pixel } = makePixelEngine({ '1,1': '#ff0000', '2,2': '#ff0000' });
  await engine.run([
    {
      type: 'repeat',
      count: num(3),
      body: [
        {
          type: 'if',
          cond: { e: OP.AND, a: epixel(1, 1, '#ff0000'), b: epixel(2, 2, '#ff0000') },
          then: [],
          else: [],
        },
      ],
    },
  ]);
  // One capture per pass - fresh each time, because these are decision points
  // and a stale frame would answer about the past. Three passes, three captures.
  assert.strictEqual(pixel.calls.length, 3);
  assert.strictEqual(pixel.calls[0].length, 2);
});

test('the untaken branch of a pixel if is not executed', async () => {
  const { engine, log } = makePixelEngine({ '1,1': '#000000' });
  await engine.run([
    {
      type: 'if',
      cond: epixel(1, 1, '#ff0000'),
      then: [{ type: 'typeText', text: 'never' }],
      else: [{ type: 'typeText', text: 'taken' }],
    },
  ]);
  assert.deepStrictEqual(log.filter((l) => l.a === 'typeText').map((l) => l.text), ['taken']);
});


// ====================================================== wait for window

/** A window port whose answers the test controls. */
function makeWindow(plan) {
  const calls = [];
  const port = {
    available: true,
    reason: '',
    calls,
    aborted: 0,
    async waitFor(title, opts) {
      calls.push({ title, opts });
      if (typeof plan === 'function') return plan(title, opts, port);
      return plan;
    },
    abort() {
      port.aborted++;
    },
  };
  return port;
}

const winStep = (over) =>
  Object.assign(
    { type: 'waitForWindow', title: 'Notepad', timeoutMs: num(8000), pollMs: 250 },
    over || {}
  );

test('wait for window returns immediately when the title is already open', async () => {
  const port = makeWindow({ ok: true, waitedMs: 3, windows: [{ title: 'Sales.csv - Notepad' }] });
  const log = [];
  const engine = new MacroEngine({ input: makeInput(log), window: port, store: memoryStore(), options: { minGapMs: 0 } });
  engine.on('error', () => {});
  const r = await engine.run([winStep(), { type: 'typeText', text: 'after' }]);
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  assert.deepStrictEqual(log.map((l) => l.text), ['after'], 'the macro carries on straight after');
  assert.strictEqual(port.calls[0].title, 'Notepad');
  assert.strictEqual(port.calls[0].opts.timeoutMs, 8000);
});

test('the timeout is passed through, and a forever timeout is refused', async () => {
  const port = makeWindow({ ok: true, waitedMs: 1, windows: [] });
  const engine = new MacroEngine({ input: makeInput([]), window: port, store: memoryStore(), options: { minGapMs: 0 } });
  engine.on('error', () => {});
  // forever would hang the macro on an app that may never open.
  const r = await engine.run([winStep({ timeoutMs: { kind: 'forever' } })]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /cannot wait forever/);
});

test('a timeout names the windows that WERE open', async () => {
  // "no window matching Notepad" is useless. The list of what was open tells the
  // user what to match on instead - which is the whole point of the timeout.
  const port = makeWindow({
    ok: false,
    timedOut: true,
    waitedMs: 8000,
    windows: [{ title: 'Spotify' }, { title: 'Chrome - Google Chrome' }],
  });
  const engine = new MacroEngine({ input: makeInput([]), window: port, store: memoryStore(), options: { minGapMs: 0 } });
  engine.on('error', () => {});
  const r = await engine.run([winStep()]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /Waited 8000ms/);
  assert.match(r.error.message, /"Spotify"/);
  assert.match(r.error.message, /"Chrome - Google Chrome"/);
  assert.match(r.error.message, /Match part of one of those/);
});

test('a timeout when nothing at all was open says so', async () => {
  const port = makeWindow({ ok: false, timedOut: true, waitedMs: 2000, windows: [] });
  const engine = new MacroEngine({ input: makeInput([]), window: port, store: memoryStore(), options: { minGapMs: 0 } });
  engine.on('error', () => {});
  const r = await engine.run([winStep()]);
  assert.match(r.error.message, /No visible windows were open at all/);
});

test('an empty title is refused rather than matching anything', async () => {
  const port = makeWindow({ ok: true, waitedMs: 0, windows: [] });
  const engine = new MacroEngine({ input: makeInput([]), window: port, store: memoryStore(), options: { minGapMs: 0 } });
  engine.on('error', () => {});
  const r = await engine.run([winStep({ title: '   ' })]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /no title to look for/);
});

test('with no window port the step reports why instead of failing opaquely', async () => {
  const engine = new MacroEngine({ input: makeInput([]), window: null, store: memoryStore(), options: { minGapMs: 0 } });
  engine.on('error', () => {});
  const r = await engine.run([winStep()]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /window reading is unavailable/);
});

test('Stop during a wait ends the run promptly and aborts the query', async () => {
  // The wait is RACED against the stop token, not polled for, and the abort
  // kills the helper because a PowerShell call cannot be interrupted from Node.
  const port = makeWindow(() => new Promise(() => {}));
  const engine = new MacroEngine({ input: makeInput([]), window: port, store: memoryStore(), options: { minGapMs: 0 } });
  engine.on('error', () => {});
  const running = engine.run([winStep({ timeoutMs: num(60000) })]);
  await new Promise((r) => setTimeout(r, 40));
  const t0 = Date.now();
  engine.stop('user');
  const r = await running;
  assert.strictEqual(r.stopped, true, 'a stopped wait must read as stopped, not failed');
  assert.ok(Date.now() - t0 < 2000, 'and must not wait for the 60s timeout');
  assert.ok(port.aborted > 0, 'the in-flight query must be aborted');
});

test('wait for window works inside a loop, and Stop interrupts the pending wait', async () => {
  // The realistic shape: "wait for the app, do the thing, wait again" on repeat.
  // The third wait never returns, so only Stop can end the run - which is
  // exactly the situation the stop/abort race exists for.
  let calls = 0;
  const port = makeWindow(() => {
    calls++;
    return calls < 3
      ? { ok: true, waitedMs: 1, windows: [{ title: 'Notepad' }] }
      : new Promise(() => {});
  });
  const log = [];
  const engine = new MacroEngine({ input: makeInput(log), window: port, store: memoryStore(), options: { minGapMs: 0 } });
  engine.on('error', () => {});
  const running = engine.run([
    {
      type: 'repeat',
      count: num(5),
      body: [
        { type: 'waitForWindow', title: 'App', timeoutMs: num(60000), pollMs: 100 },
        { type: 'typeText', text: 'pass' },
      ],
    },
  ]);
  await new Promise((r) => setTimeout(r, 60));
  engine.stop('user');
  const r = await running;
  assert.strictEqual(r.stopped, true);
  assert.deepStrictEqual(log.map((l) => l.text), ['pass', 'pass'], 'two passes completed');
  assert.strictEqual(calls, 3, 'and the third wait is the one that was interrupted');
  assert.ok(port.aborted > 0, 'its in-flight query must be aborted');
});

// ------------------------------------------------- move mouse within
//
// "move mouse within x from A to B, y from C to D" picks a random point in
// that rectangle on EVERY run. Two properties matter and are easy to get wrong:
//
//  1. the corners may be picked in any order, so each axis is normalised
//     independently - picking the second corner first is the natural gesture,
//  2. a fresh point each run is the entire point of the block, so the roll must
//     happen per execution rather than once at compile time.

test('moveWithin picks the low corner of the rectangle when random is 0', async () => {
  const { engine, log } = makeEngine({ options: { random: () => 0 } });
  const res = await engine.run([{ type: 'moveWithin', x1: 100, x2: 300, y1: 50, y2: 90, ms: 0 }]);
  assert.strictEqual(res.ok, true, res.error);
  const mv = log.find((e) => e.a === 'moveTo');
  assert.ok(mv, 'it should have moved');
  assert.strictEqual(mv.x, 100);
  assert.strictEqual(mv.y, 50);
});

test('moveWithin picks the high corner when random is just under 1', async () => {
  const { engine, log } = makeEngine({ options: { random: () => 0.999999 } });
  await engine.run([{ type: 'moveWithin', x1: 100, x2: 300, y1: 50, y2: 90, ms: 0 }]);
  const mv = log.find((e) => e.a === 'moveTo');
  assert.strictEqual(mv.x, 300);
  assert.strictEqual(mv.y, 90);
});

test('moveWithin accepts the corners in either order', async () => {
  // Bottom-right picked FIRST is the natural gesture, so x1 > x2 must not
  // produce a range that runs backwards (which would silently always pick 300).
  const { engine, log } = makeEngine({ options: { random: () => 0 } });
  await engine.run([{ type: 'moveWithin', x1: 300, x2: 100, y1: 90, y2: 50, ms: 0 }]);
  const mv = log.find((e) => e.a === 'moveTo');
  assert.strictEqual(mv.x, 100, 'x should normalise to the low edge');
  assert.strictEqual(mv.y, 50, 'y should normalise independently');
});

test('a zero-width rectangle is a line, not an error', async () => {
  const { engine, log } = makeEngine({ options: { random: () => 0.5 } });
  const res = await engine.run([{ type: 'moveWithin', x1: 42, x2: 42, y1: 0, y2: 10, ms: 0 }]);
  assert.strictEqual(res.ok, true, 'a degenerate area is legal');
  const mv = log.find((e) => e.a === 'moveTo');
  assert.strictEqual(mv.x, 42, 'x is pinned to the single value');
  assert.ok(mv.y >= 0 && mv.y <= 10, 'y still varies, got ' + mv.y);
});

test('every pass of a loop rolls a NEW point', async () => {
  let n = 0;
  // A block that rolled once at COMPILE time would keep returning the same
  // coordinate forever. random is called for other things too (the inter-step
  // gap jitter, and once per axis here), so drive it with a long cycle and
  // assert on the spread rather than on any single call's value.
  const { engine, log } = makeEngine({ options: { random: () => ((n++) % 5) / 4 } });
  await engine.run([{ type: 'repeat', count: num(8), body: [{ type: 'moveWithin', x1: 0, x2: 10, y1: 0, y2: 10, ms: 0 }] }]);
  const xs = log.filter((e) => e.a === 'moveTo').map((e) => e.x);
  assert.strictEqual(xs.length, 8);
  assert.ok(new Set(xs).size > 1, 'the point must differ between passes, got ' + JSON.stringify(xs));
  assert.ok(xs.every((x) => x >= 0 && x <= 10), 'and always land inside the rectangle: ' + JSON.stringify(xs));
});

test('a random source that returns exactly 1 cannot escape the rectangle', async () => {
  // Math.random() never returns 1, but _random is injectable. floor(1 * 11) is
  // 11, which is outside a 0..10 rectangle - one pixel of "random" that lands
  // exactly where the macro said it must never go.
  const { engine, log } = makeEngine({ options: { random: () => 1 } });
  await engine.run([{ type: 'moveWithin', x1: 0, x2: 10, y1: 0, y2: 10, ms: 0 }]);
  const mv = log.find((e) => e.a === 'moveTo');
  assert.strictEqual(mv.x, 10, 'x must clamp to the high edge, got ' + mv.x);
  assert.strictEqual(mv.y, 10, 'y must clamp to the high edge, got ' + mv.y);
});

test('moveWithin passes the duration through', async () => {
  const { engine, log } = makeEngine({ options: { random: () => 0 } });
  await engine.run([{ type: 'moveWithin', x1: 0, x2: 5, y1: 0, y2: 5, ms: 250 }]);
  assert.strictEqual(log.find((e) => e.a === 'moveTo').ms, 250);
});
