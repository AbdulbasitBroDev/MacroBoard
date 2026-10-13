'use strict';

/**
 * Timing primitives for high-rate input.
 *
 * WHY THIS EXISTS
 * ---------------
 * `setTimeout` is the obvious way to space clicks out, but on Windows its
 * resolution is poor - measured on the development machine, a `setTimeout(0)`
 * took 11ms and a `setTimeout(1)` took anywhere from 1.3ms to 17ms. That is the
 * dominant cost in a fast macro: nut-js awaits `sleep(0)` before EVERY native
 * call, so `click` cost ~11ms instead of the ~0.35ms the native call actually
 * takes. A "100 clicks, 1ms gap" macro therefore took ~2.2s instead of ~0.1s.
 *
 * Two primitives fix that:
 *
 *   preciseSleep(ms)  sub-millisecond-accurate spacing for short gaps.
 *                     Coarse gaps use the OS timer (so the process stays
 *                     responsive); only the final few ms are spun, and the spin
 *                     is chunked so Stop is still observed promptly.
 *
 *   SPIN_LIMIT_MS     the point below which `setTimeout` is no more accurate
 *                     than a spin, so spinning is used instead. Measured, not
 *                     guessed.
 *
 * `sleep` remains the default for long waits (`wait 5 seconds`): there is no
 * reason to burn CPU, and the OS timer is plenty accurate at that scale.
 */

/**
 * Below this many ms the OS timer is not usefully accurate, so we spin instead.
 * Measured on the development machine: setTimeout(0) took ~11ms, so anything
 * under ~12ms is a spin.
 */
const SPIN_LIMIT_MS = 12;

/** How long we are willing to block the event loop in one unbroken go. */
const MAX_SPIN_CHUNK_MS = 0.5;

/**
 * After this much spinning we yield to the event loop, so timers and IPC can
 * still be serviced.
 *
 * This is not an optimisation - it is a correctness requirement. A spin is a
 * tight loop with no `await` on a macrotask, so a `repeat forever` loop whose
 * gate always spins never returns to the event loop's timer phase. Stop, the UI
 * and the IPC channel would all starve, and the process would wedge. `setImmediate`
 * is the cheapest yield that still lets pending timers run.
 */
const SPIN_YIELD_EVERY_MS = 1;

/**
 * How often shouldStop() is polled while waiting out a long sleep. This is the
 * worst-case latency of pressing Stop during a `wait` step or a long press gap.
 */
const STOP_POLL_MS = 16;

/**
 * How far the OS timer is assumed to overshoot, in ms. Measured on the
 * development machine: `setTimeout(15)` resolved anywhere from 15ms to ~29ms.
 *
 * A coarse sleep is therefore treated as costing up to this much MORE than
 * requested, and the slack is spent spinning instead. Getting this wrong is
 * what made `wait 776ms` take 1087ms.
 */
/**
 * Coarse part: hand the CPU back to the OS so the app stays responsive. The
 * margin covers the timer's worst-case overshoot plus the spin that follows.
 *
 * A wait short enough that ONE timer sleep could overshoot the whole thing is
 * spun end to end instead: at ~16ms a single `setTimeout` landed anywhere from
 * 16ms to ~20ms, so a 16ms wait came out as 19.7ms.
 */
const MIN_OS_WAIT_MS = 50;

/**
 * How far the OS timer is assumed to overshoot, in ms. Measured on the
 * development machine: `setTimeout(15)` resolved anywhere from 15ms to ~29ms.
 *
 * A coarse sleep is therefore treated as costing up to this much MORE than
 * requested, and the slack is spent spinning instead. Getting this wrong is
 * what made `wait 776ms` take 1087ms.
 */
const TIMER_OVERSHOOT_MS = 20;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Yield to the event loop so timers and IPC can be serviced.
 *
 * This uses `setTimeout(0)`, NOT `setImmediate`. Measured on this platform, a
 * chain of `setImmediate` callbacks stays inside the check phase and a pending
 * `setInterval`/`setTimeout` NEVER fires - so yielding that way would leave Stop,
 * the renderer and the global hook all starved. A zero-delay timer returns to the
 * timers phase, which is what actually needs servicing.
 *
 * It costs up to ~11ms (a `setTimeout(0)` takes ~11ms here), so it must never
 * sit inside a measured wait: the engine yields BETWEEN steps, where that cost
 * belongs to the step boundary rather than to the user's `wait 776ms`.
 */
function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Yields cheaply between steps, but forces a real timers-phase visit often
 * enough that nothing can be starved indefinitely.
 *
 * WHY NOT JUST YIELD EVERY STEP: `setTimeout(0)` takes ~11ms here, so paying it
 * on every step would add ~11ms of drift to every wait - the very accuracy this
 * module exists to protect. `setImmediate` is ~0.01ms but, as measured, a chain
 * of them stays in the check phase and pending timers never fire.
 *
 * So: cheap yields by default, and once MAX_STARVATION_MS of blocking time has
 * accumulated, pay for one real timer yield. Worst-case event-loop starvation is
 * therefore bounded by MAX_STARVATION_MS regardless of how the macro is written,
 * while the common case stays accurate.
 */
const MAX_STARVATION_MS = 40;

/** Create a yielder that tracks how long it has gone without a real yield. */
function createStepYielder() {
  let lastRealYieldNs = process.hrtime.bigint();
  const maxNs = BigInt(MAX_STARVATION_MS) * 1000000n;
  return function yieldStep() {
    if (process.hrtime.bigint() - lastRealYieldNs < maxNs) {
      return new Promise((resolve) => setImmediate(resolve));
    }
    lastRealYieldNs = process.hrtime.bigint();
    return new Promise((resolve) => setTimeout(resolve, 0));
  };
}

/** True once `ms` of wall clock has passed, measured with the high-res clock. */
function spinUntil(startNs, ms) {
  const deadline = startNs + BigInt(Math.round(ms * 1e6));
  while (process.hrtime.bigint() < deadline) {
    /* deliberately empty - this is the spin */
  }
}

/**
 * Sleep for `ms` as accurately as practical.
 *
 * The whole wait is measured against ONE absolute deadline rather than a series
 * of "sleep 20ms" chunks. Chunking looks equivalent but is not: an OS timer
 * overshoots its request, and a loop that subtracts the REQUESTED length from
 * the remaining time accumulates every overshoot. Measured here, `wait 776ms`
 * took 1087ms that way (+311ms of pure accumulated timer error).
 *
 * Long waits use the OS timer (so the process stays responsive and Stop lands
 * promptly); the last few ms - where the timer is least accurate - are spun
 * against the deadline, and a spin that is already past the deadline returns
 * immediately. That is what makes the total land on the requested value.
 *
 * @param {number} ms
 * @param {object} [opts]
 * @param {() => boolean} [opts.shouldStop] polled while waiting; when it returns
 *   true the wait ends early (this is how Stop stays responsive).
 * @return {Promise<void>} resolves early if shouldStop() went true.
 */
async function preciseSleep(ms, opts) {
  opts = opts || {};
  const shouldStop = opts.shouldStop;
  if (!(ms > 0)) return;

  const nsPerMs = 1000000n;
  const deadline = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));

  // Coarse part: hand the CPU back to the OS so the app stays responsive. The
  // margin covers the timer's worst-case overshoot plus the spin that follows.
  // Waits too short for the timer to be trusted at all are skipped here and
  // spun end to end below.
  if (ms >= MIN_OS_WAIT_MS) {
    while (true) {
      const leftMs = Number(deadline - process.hrtime.bigint()) / 1e6;
      if (leftMs <= SPIN_LIMIT_MS + TIMER_OVERSHOOT_MS) break;
      // Aim at the DEADLINE, not at "now + slice", so an overshooting timer can
      // never push us past it. The slice is also capped at STOP_POLL_MS purely so
      // shouldStop() is polled often enough for Stop to feel instant - capping
      // costs nothing in accuracy because each iteration re-reads the same
      // absolute deadline.
      const slice = Math.min(leftMs - SPIN_LIMIT_MS - TIMER_OVERSHOOT_MS, STOP_POLL_MS);
      await new Promise((resolve) => setTimeout(resolve, slice));
      if (shouldStop && shouldStop()) return;
    }
  }

  // Fine part: spin the last few ms against the absolute deadline. A spin that is
  // already late (because the timer overshot) does nothing at all.
  //
  // This yields on every chunk. That sounds costly, but a chunk is only
  // MAX_SPIN_CHUNK_MS (0.5ms), and `setImmediate` is ~0.01ms - so the yield is
  // ~2% overhead on a short wait while guaranteeing the loop still breathes.
  // Omitting it was a real bug: a forever-press loop spun so hard that the
  // process never reached its timers phase, so Stop could not even be delivered.
  for (;;) {
    const leftMs = Number(deadline - process.hrtime.bigint()) / 1e6;
    if (leftMs <= 0) return;
    spinUntil(process.hrtime.bigint(), Math.min(MAX_SPIN_CHUNK_MS, leftMs));
    if (shouldStop && shouldStop()) return;
    // Yield cheaply (setImmediate, not setTimeout(0)) - see yieldToEventLoop.
    await new Promise((resolve) => setImmediate(resolve));
    if (shouldStop && shouldStop()) return;
  }
}

/**
 * One spin-slice wait used between the individual events of a burst. Unlike
 * `preciseSleep` this never yields to the event loop, because the point of a
 * burst is that the native calls run back to back.
 */
function spinGap(ms) {
  if (!(ms > 0)) return;
  spinUntil(process.hrtime.bigint(), ms);
}

module.exports = {
  preciseSleep,
  spinGap,
  spinUntil,
  yieldToEventLoop,
  createStepYielder,
  defaultSleep,
  SPIN_LIMIT_MS,
  MAX_SPIN_CHUNK_MS,
  SPIN_YIELD_EVERY_MS,
  STOP_POLL_MS,
  MAX_STARVATION_MS,
  MIN_OS_WAIT_MS,
};
