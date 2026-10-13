'use strict';

/**
 * `repeat until`, `break` and `continue`.
 *
 * The whole design rests on ONE idea: a loop-exit signal is RETURNED, not
 * thrown. A thrown break would unwind every enclosing loop at once, which is
 * precisely what `break` must not do - inside a loop nested in a loop it has to
 * leave only the inner one. So most of these tests are about which loop stops
 * and which keeps going.
 *
 * The conditions are PIXEL checks on purpose. `repeat until <condition>` with a
 * pixel check is the shape this feature exists for ("keep trying until the
 * button turns green"), and driving it through the real pixel port means these
 * tests also cover the condition machinery rather than bypassing it.
 *
 * Nothing here touches the OS or a screen: the pixel port is a function of the
 * read count, and the input port just records what it was told to type.
 */

const test = require('node:test');
const assert = require('node:assert');
const { MacroEngine, memoryStore } = require('../src/main/engine/engine');
const px = require('../src/shared/pixels');
const C = require('../src/shared/constants');
const expressions = require('../src/shared/expressions');

const OP = expressions.OP;
const ebool = (v) => ({ e: OP.LIT, v });
const epixel = (x, y, colour, tol) => ({ e: OP.PIXEL, x, y, colour, tol: tol || 0 });
const num = (v) => ({ kind: 'number', value: v });

/** "The pixel turns GREEN on the Nth read and stays that way." */
const turnsGreenAt = (n) => {
  const gate = { reads: 0, colours: [] };
  gate.pixel = {
    readPixels(points) {
      return Promise.all(
        points.map((p) => {
          gate.reads++;
          gate.colours.push(gate.reads >= n ? '#00ff00' : '#ff0000');
          return { x: p.x, y: p.y, outside: false, colour: gate.colours[gate.colours.length - 1], rgb: px.hexToRgb(gate.colours[gate.colours.length - 1]) };
        })
      );
    },
  };
  return gate;
};

/** A pixel that is never the right colour. */
const neverGreen = () => {
  const gate = { reads: 0, pixel: null };
  gate.pixel = {
    readPixels(points) {
      return Promise.all(
        points.map((p) => {
          gate.reads++;
          return { x: p.x, y: p.y, outside: false, colour: '#ff0000', rgb: { r: 255, g: 0, b: 0 } };
        })
      );
    },
  };
  return gate;
};

function makeInput(log) {
  return {
    async typeText(t) {
      log.push(t);
    },
    async click() {},
    async moveTo() {},
    async moveBy() {},
    async keyDown() {},
    async keyUp() {},
  };
}

function makeEngine(pixelPort, opts) {
  const log = [];
  const engine = new MacroEngine({
    input: makeInput(log),
    pixel: pixelPort,
    store: memoryStore(),
    registry: { getMacroSteps: () => null },
    // The stuck-loop test runs the whole cap, so the per-pass sleep is stubbed
    // out. It only exists to stop an EMPTY body spinning the CPU.
    options: Object.assign({ minGapMs: 0, sleep: async () => {} }, (opts && opts.options) || {}),
  });
  // A pixel read that fails must not take the whole engine down with it.
  engine.on('error', () => {});
  engine.log = log;
  return engine;
}

// ---------------------------------------------------------- repeat until

test('repeat until runs the body until the pixel turns green', async () => {
  const gate = turnsGreenAt(3);
  const engine = makeEngine(gate.pixel);
  const r = await engine.run([
    { type: 'repeatUntil', cond: epixel(10, 20, '#00ff00'), body: [{ type: 'typeText', text: 'tick' }] },
  ]);
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  assert.strictEqual(engine.log.length, 2, 'two red checks, then green - two passes');
});

test('the condition is checked BEFORE the first pass, so an already-green pixel runs nothing', async () => {
  // The whole difference from `repeat N times`, and the reason this is not sugar.
  const gate = turnsGreenAt(1);
  const engine = makeEngine(gate.pixel);
  const r = await engine.run([
    { type: 'repeatUntil', cond: epixel(10, 20, '#00ff00'), body: [{ type: 'typeText', text: 'never' }] },
  ]);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(engine.log, [], 'the body must not run at all');
});

test('the condition is re-evaluated every pass, not decided once', async () => {
  const gate = turnsGreenAt(5);
  const engine = makeEngine(gate.pixel);
  await engine.run([
    { type: 'repeatUntil', cond: epixel(10, 20, '#00ff00'), body: [{ type: 'typeText', text: 'x' }] },
  ]);
  assert.strictEqual(gate.reads, 5, 'five checks for four passes - it really re-tests');
  assert.strictEqual(engine.log.length, 4);
});

test('a loop body that changes the screen can be driven purely by a condition', async () => {
  // The real macro shape: type something, check a pixel, loop until it changes.
  const gate = turnsGreenAt(3);
  const engine = makeEngine(gate.pixel);
  await engine.run([
    {
      type: 'repeatUntil',
      cond: epixel(1, 1, '#00ff00'),
      body: [{ type: 'typeText', text: 'retry' }],
    },
  ]);
  assert.deepStrictEqual(engine.log, ['retry', 'retry']);
});

test('a stuck loop stops itself and names the condition that never came true', async () => {
  const gate = neverGreen();
  const engine = makeEngine(gate.pixel);
  const r = await engine.run([
    { type: 'repeatUntil', cond: epixel(640, 380, '#00ff00'), body: [] },
  ]);
  assert.strictEqual(r.ok, false, 'a condition that cannot come true must fail, not hang');
  assert.match(r.error.message, /repeat until/);
  // The useful half of the message: WHICH check is never going to come true.
  assert.match(r.error.message, /pixel\(640,380\) is #00ff00/);
  assert.match(r.error.message, /without its condition becoming true/);
});

test('the stuck-loop cap is the documented one and is stated in the message', async () => {
  const gate = neverGreen();
  const engine = makeEngine(gate.pixel);
  const r = await engine.run([{ type: 'repeatUntil', cond: epixel(1, 1, '#00ff00'), body: [] }]);
  assert.match(
    r.error.message,
    new RegExp(C.LIMITS.MAX_CONDITION_LOOP_ITERATIONS.toLocaleString('en-US'))
  );
});

test('a large COUNTED repeat is not failed - you asked for it explicitly', async () => {
  const engine = makeEngine(null);
  const r = await engine.run([{ type: 'repeat', count: num(C.LIMITS.MAX_REPEAT_COUNT + 10), body: [] }]);
  assert.strictEqual(r.ok, true, 'a counted repeat is clamped, not rejected');
});

test('a missing condition is a failure, not an instant success', async () => {
  const engine = makeEngine(null);
  const r = await engine.run([
    { type: 'repeatUntil', cond: null, body: [{ type: 'typeText', text: 'x' }] },
  ]);
  assert.strictEqual(r.ok, false, 'a null condition must not read as "already done"');
  assert.match(r.error.message, /without its condition becoming true/);
});

test('a body that fails still fails the loop, and stops it', async () => {
  const gate = turnsGreenAt(99);
  const engine = makeEngine(gate.pixel);
  const r = await engine.run([
    {
      type: 'repeatUntil',
      cond: epixel(1, 1, '#00ff00'),
      body: [{ type: 'typeText', text: 'once' }, { type: 'nonsenseStep' }],
    },
  ]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error.message, /Unknown step type "nonsenseStep"/);
  assert.deepStrictEqual(engine.log, ['once'], 'and the loop did not keep retrying');
});

// ------------------------------------------------------------------ break

test('break leaves the loop early', async () => {
  const engine = makeEngine(null);
  const r = await engine.run([
    {
      type: 'repeat',
      count: num(10),
      body: [{ type: 'typeText', text: 'a' }, { type: 'break' }, { type: 'typeText', text: 'unreachable' }],
    },
  ]);
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  assert.deepStrictEqual(engine.log, ['a'], 'the step after the break must not run');
});

test('a break in a NESTED loop leaves only the inner loop', async () => {
  // The single most important property of the whole feature. A thrown break
  // would stop the outer loop too.
  const engine = makeEngine(null);
  await engine.run([
    {
      type: 'repeat',
      count: num(3),
      body: [
        { type: 'typeText', text: 'outer-start' },
        {
          type: 'repeat',
          count: num(5),
          body: [{ type: 'typeText', text: 'inner' }, { type: 'break' }, { type: 'typeText', text: 'never' }],
        },
        { type: 'typeText', text: 'outer-end' },
      ],
    },
  ]);
  assert.deepStrictEqual(engine.log, [
    'outer-start', 'inner', 'outer-end',
    'outer-start', 'inner', 'outer-end',
    'outer-start', 'inner', 'outer-end',
  ]);
});

test('three levels deep: a break stops exactly one level', async () => {
  const engine = makeEngine(null);
  await engine.run([
    {
      type: 'repeat',
      count: num(2),
      body: [
        { type: 'typeText', text: 'L1' },
        {
          type: 'repeat',
          count: num(2),
          body: [
            { type: 'typeText', text: 'L2' },
            { type: 'repeat', count: num(2), body: [{ type: 'typeText', text: 'L3' }, { type: 'break' }] },
            { type: 'typeText', text: 'L2-after' },
          ],
        },
        { type: 'typeText', text: 'L1-after' },
      ],
    },
  ]);
  // The innermost loop breaks after one L3. The MIDDLE loop is untouched, so it
  // runs both of its passes; the outer one runs both of its passes too.
  assert.deepStrictEqual(engine.log, [
    'L1', 'L2', 'L3', 'L2-after', 'L2', 'L3', 'L2-after', 'L1-after',
    'L1', 'L2', 'L3', 'L2-after', 'L2', 'L3', 'L2-after', 'L1-after',
  ]);
});

test('break works out of a repeat until, and execution continues after it', async () => {
  const gate = neverGreen();
  const engine = makeEngine(gate.pixel);
  const r = await engine.run([
    {
      type: 'repeatUntil',
      cond: epixel(1, 1, '#00ff00'),
      body: [{ type: 'typeText', text: 'once' }, { type: 'break' }],
    },
    { type: 'typeText', text: 'after' },
  ]);
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  assert.deepStrictEqual(engine.log, ['once', 'after']);
});

test('a break inside an if inside a loop still leaves the loop', async () => {
  const engine = makeEngine(null);
  await engine.run([
    {
      type: 'repeat',
      count: num(4),
      body: [
        { type: 'if', cond: ebool(true), then: [{ type: 'typeText', text: 'hit' }, { type: 'break' }], else: [] },
        { type: 'typeText', text: 'never' },
      ],
    },
  ]);
  assert.deepStrictEqual(engine.log, ['hit']);
});

test('a break inside a chooser page inside a loop leaves that loop', async () => {
  const engine = makeEngine(null);
  await engine.run([
    {
      type: 'repeat',
      count: num(3),
      body: [
        {
          type: 'chooser',
          id: 'c1',
          mode: 'random',
          pageCount: 1,
          pages: [[{ type: 'typeText', text: 'picked' }, { type: 'break' }]],
        },
        { type: 'typeText', text: 'never' },
      ],
    },
  ]);
  assert.deepStrictEqual(engine.log, ['picked']);
});

test('a break with no loop above it skips the rest and says so in the log', async () => {
  // The compiler rejects this shape, so it can only arrive in a hand-edited step
  // list. Stopping the rest is the honest reading of a break, and the warning is
  // what stops it being a silent mystery.
  const warns = [];
  const engine = makeEngine(null);
  engine._log = (level, msg) => {
    if (level === 'warn') warns.push(msg);
  };
  const r = await engine.run([{ type: 'typeText', text: 'a' }, { type: 'break' }, { type: 'typeText', text: 'b' }]);
  assert.strictEqual(r.ok, true, 'and it does not fail the whole macro');
  assert.deepStrictEqual(engine.log, ['a']);
  assert.ok(
    warns.some((w) => /no loop around it/.test(w)),
    'the user is told why the rest did not run: ' + JSON.stringify(warns)
  );
});

// --------------------------------------------------------------- continue

test('continue ends the pass early and the loop keeps going', async () => {
  const engine = makeEngine(null);
  await engine.run([
    {
      type: 'repeat',
      count: num(3),
      body: [{ type: 'typeText', text: 'a' }, { type: 'continue' }, { type: 'typeText', text: 'never' }],
    },
  ]);
  assert.deepStrictEqual(engine.log, ['a', 'a', 'a']);
});

test('a continue in a repeat until still re-checks the condition next pass', async () => {
  const gate = turnsGreenAt(3);
  const engine = makeEngine(gate.pixel);
  await engine.run([
    {
      type: 'repeatUntil',
      cond: epixel(1, 1, '#00ff00'),
      body: [{ type: 'typeText', text: 'x' }, { type: 'continue' }, { type: 'typeText', text: 'never' }],
    },
  ]);
  assert.strictEqual(engine.log.length, 2, 'two passes before the pixel turned green');
  assert.strictEqual(gate.reads, 3);
});

test('a continue in a nested loop only ends the inner pass', async () => {
  const engine = makeEngine(null);
  await engine.run([
    {
      type: 'repeat',
      count: num(2),
      body: [
        { type: 'typeText', text: 'outer' },
        {
          type: 'repeat',
          count: num(2),
          body: [{ type: 'typeText', text: 'inner' }, { type: 'continue' }, { type: 'typeText', text: 'no' }],
        },
        { type: 'typeText', text: 'after' },
      ],
    },
  ]);
  // The inner loop does BOTH its passes (continue does not stop a loop) and
  // 'no' never runs (continue does stop the rest of the pass). The outer loop is
  // completely unaffected.
  assert.deepStrictEqual(engine.log, [
    'outer', 'inner', 'inner', 'after',
    'outer', 'inner', 'inner', 'after',
  ]);
});

// -------------------------------------------------------------- at once

test('a break inside "at once" leaves the surrounding loop but never cancels its siblings', async () => {
  // THE RULE, chosen deliberately and documented. Two things are true at once
  // here and both are worth stating, because `at once` is genuinely parallel:
  //
  //   1. the break reaches OUT and stops the surrounding loop, and
  //   2. every other stacked block is its own task, so it runs to completion.
  //
  // (2) is not leniency, it is what `at once` means - a `break` is a SIBLING of
  // the block below it, not a statement in front of it. Cancelling them would
  // also mean abandoning a half-finished click.
  const engine = makeEngine(null);
  const r = await engine.run([
    {
      type: 'repeat',
      count: num(3),
      body: [
        {
          type: 'atOnce',
          body: [{ type: 'typeText', text: 'sibling' }, { type: 'break' }, { type: 'typeText', text: 'also-sibling' }],
        },
        { type: 'typeText', text: 'never' },
      ],
    },
  ]);
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  assert.strictEqual(engine.log.includes('never'), false, 'the loop really did stop');
  assert.strictEqual(engine.log.filter((t) => t === 'sibling').length, 1, 'and it ran once, not three times');
  assert.strictEqual(engine.log.includes('also-sibling'), true, 'the third task still completed');
});

test('a break inside "at once" does not stop the loop when at once is NOT in one', async () => {
  const engine = makeEngine(null);
  const r = await engine.run([
    { type: 'atOnce', body: [{ type: 'typeText', text: 'a' }, { type: 'break' }] },
    { type: 'typeText', text: 'after' },
  ]);
  assert.strictEqual(r.ok, true, r.error && r.error.message);
  assert.ok(engine.log.includes('after'), 'with no loop to leave, the macro simply carries on');
});

test('an at once with no break propagates nothing', async () => {
  const engine = makeEngine(null);
  await engine.run([
    {
      type: 'repeat',
      count: num(2),
      body: [{ type: 'atOnce', body: [{ type: 'typeText', text: 'both' }] }, { type: 'typeText', text: 'next' }],
    },
  ]);
  assert.deepStrictEqual(engine.log, ['both', 'next', 'both', 'next']);
});

test('a continue inside "at once" ends one task and the loop carries on', async () => {
  const engine = makeEngine(null);
  await engine.run([
    {
      type: 'repeat',
      count: num(2),
      body: [
        {
          type: 'atOnce',
          body: [{ type: 'continue' }, { type: 'typeText', text: 'sibling' }],
        },
        { type: 'typeText', text: 'after' },
      ],
    },
  ]);
  assert.deepStrictEqual(engine.log, ['sibling', 'after', 'sibling', 'after']);
});

test('an empty at once does not break the loop it is in', async () => {
  const engine = makeEngine(null);
  await engine.run([
    { type: 'repeat', count: num(2), body: [{ type: 'atOnce', body: [] }, { type: 'typeText', text: 'kept' }] },
  ]);
  assert.deepStrictEqual(engine.log, ['kept', 'kept']);
});

// ------------------------------------------------------------- boundaries

test('a break cannot escape a sub-macro into its caller loop', async () => {
  // The macro boundary is real. A sub-macro's steps are their own list, and a
  // break inside it belongs to a loop inside it - otherwise a sub-macro could
  // cancel its caller's control flow, which would be a nasty surprise.
  const log = [];
  const engine = new MacroEngine({
    input: makeInput(log),
    store: memoryStore(),
    registry: { getMacroSteps: () => ({ name: 'child', steps: [{ type: 'break' }] }) },
    options: { minGapMs: 0, sleep: async () => {} },
  });
  engine.on('error', () => {});
  const r = await engine.run([
    { type: 'repeat', count: num(3), body: [{ type: 'typeText', text: 'iter' }, { type: 'runMacro', name: 'child' }] },
  ]);
  assert.strictEqual(r.ok, true, 'the caller loop is unaffected by the child break');
  assert.deepStrictEqual(log, ['iter', 'iter', 'iter']);
});

test('a break inside a sub-macro DOES leave a loop inside that sub-macro', async () => {
  const log = [];
  const engine = new MacroEngine({
    input: makeInput(log),
    store: memoryStore(),
    registry: {
      getMacroSteps: () => ({
        name: 'child',
        steps: [
          {
            type: 'repeat',
            count: num(9),
            body: [{ type: 'typeText', text: 'child-tick' }, { type: 'break' }, { type: 'typeText', text: 'no' }],
          },
        ],
      }),
    },
    options: { minGapMs: 0, sleep: async () => {} },
  });
  engine.on('error', () => {});
  await engine.run([{ type: 'runMacro', name: 'child' }]);
  assert.deepStrictEqual(log, ['child-tick'], 'the sub-macro loop broke exactly once');
});

// ---------------------------------------------------------------- counting

test('countSteps walks a repeat until body', () => {
  const { countSteps } = require('../src/main/engine/engine');
  const n = countSteps([
    { type: 'repeatUntil', cond: ebool(false), body: [{ type: 'wait', ms: num(1) }, { type: 'wait', ms: num(1) }] },
  ]);
  assert.strictEqual(n, 3, 'the loop plus its two body steps');
});

test('the run summary counts the loop and the passes that actually ran', async () => {
  const gate = turnsGreenAt(3);
  const engine = makeEngine(gate.pixel);
  const r = await engine.run([
    { type: 'repeatUntil', cond: epixel(1, 1, '#00ff00'), body: [{ type: 'typeText', text: 'x' }] },
  ]);
  // 1 for the loop + 2 for the body steps that ran. Evaluating the condition is
  // NOT a step - it is the loop's own work - so it is not counted here.
  assert.strictEqual(r.steps, 3, 'got ' + r.steps);
});
