'use strict';

/**
 * Timing tests.
 *
 * These assert the two properties the high-rate click path depends on:
 *   - a requested gap is honoured ACCURATELY (it is a period, not a delay added
 *     on top of the work), and
 *   - spinning yields to the event loop often enough that Stop, timers and IPC
 *     are never starved. A spin that did not yield would wedge the process.
 */

const test = require('node:test');
const assert = require('node:assert');
const { preciseSleep, spinGap, yieldToEventLoop, SPIN_LIMIT_MS, SPIN_YIELD_EVERY_MS } = require('../src/main/engine/timing');

const elapsed = async (fn) => {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
};

test('a 1ms sleep takes about 1ms, not the ~11ms an OS timer costs', async () => {
  // First call pays one-off JIT warmup, so measure the second.
  await preciseSleep(1);
  const ms = await elapsed(() => preciseSleep(1));
  assert.ok(ms < 3, 'preciseSleep(1) took ' + ms.toFixed(2) + 'ms - too slow');
});

test('a 0ms sleep returns immediately', async () => {
  const ms = await elapsed(() => preciseSleep(0));
  assert.ok(ms < 2, 'preciseSleep(0) took ' + ms.toFixed(2) + 'ms');
});

test('short sleeps are accurate', async () => {
  for (const target of [1, 2, 5]) await preciseSleep(target); // warm up
  for (const target of [1, 2, 5]) {
    const ms = await elapsed(() => preciseSleep(target));
    assert.ok(
      ms >= target - 0.5 && ms <= target + 3,
      'preciseSleep(' + target + ') took ' + ms.toFixed(2) + 'ms'
    );
  }
});

test('a long sleep still actually sleeps for the requested time', async () => {
  const ms = await elapsed(() => preciseSleep(120));
  assert.ok(ms >= 120, 'preciseSleep(120) returned after only ' + ms.toFixed(1) + 'ms');
  assert.ok(ms < 200, 'preciseSleep(120) overran badly: ' + ms.toFixed(1) + 'ms');
});

test('a tight loop of short waits does not starve the event loop', async () => {
  // REGRESSION: the spin used to run with no yield at all, so a `forever` press
  // loop (which gates at ~2ms per press) kept the process out of the timers
  // phase entirely - Stop could not be delivered and the app wedged.
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, 5);
  for (let i = 0; i < 50; i++) await preciseSleep(1);
  clearTimeout(timer);
  assert.ok(fired, 'timers were starved across 50 short spins');
});

test('a long spin does not starve timers (Stop would never land otherwise)', async () => {
  // The coarse (OS-timer) path must hand control back, so a pending timer runs.
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, 5);
  const ms = await elapsed(() => preciseSleep(60));
  clearTimeout(timer);
  assert.ok(fired, 'the timer never fired while preciseSleep was running');
  assert.ok(ms >= 60);
});

test('shouldStop cuts a long sleep short', async () => {
  let stopped = false;
  const ms = await elapsed(() =>
    preciseSleep(400, {
      shouldStop: () => {
        stopped = true;
        return true;
      },
    })
  );
  assert.ok(ms < 100, 'shouldStop did not interrupt: ' + ms.toFixed(1) + 'ms');
});

test('spinGap is precise', () => {
  const t = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) spinGap(1);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const each = ms / 20;
  assert.ok(each > 0.9 && each < 2.5, 'spinGap(1) averaged ' + each.toFixed(3) + 'ms');
});

test('the documented constants match the implementation', () => {
  assert.ok(SPIN_LIMIT_MS > 0 && SPIN_LIMIT_MS <= 20, 'SPIN_LIMIT_MS out of range');
  assert.ok(SPIN_YIELD_EVERY_MS > 0, 'the spin must yield at least once per wait');
});

// ---- wait accuracy ---------------------------------------------------------

/**
 * The engine used to implement `wait` as a loop of `setTimeout(20)` slices that
 * subtracted the REQUESTED slice from the remaining time. Because the OS timer
 * overshoots its request, the error accumulated once per slice and `wait 776ms`
 * actually took 1087ms. These assert the deadline is now hit.
 */
test('a wait lands on its deadline, it does not accumulate timer overshoot', async () => {
  for (const ms of [776, 250, 100]) {
    await preciseSleep(ms); // warm up
    // Best of THREE, not a single sample.
    //
    // Windows setTimeout granularity and scheduler jitter are ~1-15ms, and go well
    // past that when the machine is busy. A single sample therefore failed roughly
    // one run in three for reasons that had nothing to do with this code - it is a
    // test of the OS scheduler, not of the deadline arithmetic. The minimum is the
    // implementation's own accuracy, and drift from an accumulating implementation
    // still shows up in it.
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const actual = await elapsed(() => preciseSleep(ms));
      best = Math.min(best, Math.abs(actual - ms));
    }
    assert.ok(best < 3, 'preciseSleep(' + ms + ') best error was ' + best.toFixed(2) + 'ms');
  }
});

test('a long wait is still accurate - the deadline is absolute, not chunked', async () => {
  await preciseSleep(1000); // warm up the JIT so we measure the wait, not first-call cost
  const actual = await elapsed(() => preciseSleep(1000));
  assert.ok(
    Math.abs(actual - 1000) < 3,
    'preciseSleep(1000) took ' + actual.toFixed(1) + 'ms - overshoot is accumulating again'
  );
});

test('a wait never returns early', async () => {
  await preciseSleep(50);
  for (const ms of [100, 776]) {
    const actual = await elapsed(() => preciseSleep(ms));
    assert.ok(actual >= ms, 'preciseSleep(' + ms + ') returned EARLY at ' + actual.toFixed(2) + 'ms');
  }
});

test('yieldToEventLoop lets a pending timer through', async () => {
  // The engine's step loop relies on this: a short `wait` is a pure spin, and
  // only the yield between steps keeps Stop/IPC alive.
  let fired = false;
  const timer = setTimeout(() => { fired = true; }, 1);
  await yieldToEventLoop();
  clearTimeout(timer);
  assert.ok(fired, 'yieldToEventLoop did not let the timer run');
});
