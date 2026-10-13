'use strict';

/**
 * ActionGate - enforces a minimum gap between physical input actions.
 *
 * WHY: a macro like `repeat forever { press A }` with no wait would otherwise
 * fire thousands of OS input events per second. Every "physical" action the
 * engine performs (mouse move/click, key down/up, typing) acquires a slot from
 * this gate first, and slots are handed out no closer together than
 * `minGapMs`.
 *
 * Slots are handed out over a promise chain, so it is safe under concurrency
 * (the `at once` block runs several step lists simultaneously): concurrent
 * tasks are serialised through the same chain and therefore still respect the
 * gap between each other.
 *
 * NOTE ON TIMING: the wait uses `preciseSleep`, not the OS timer. Measured on
 * the development machine, `setTimeout(1)` resolved anywhere between 1.3ms and
 * 17ms, so a 1ms floor was really an unpredictable 1-17ms floor - which is what
 * made a "100 clicks, 1ms gap" macro take seconds instead of milliseconds.
 */
const { preciseSleep } = require('./timing');

class ActionGate {
  /**
   * @param {object} [opts]
   * @param {number} [opts.minGapMs] minimum milliseconds between two slots
   * @param {() => number} [opts.now] injectable clock (tests)
   * @param {(ms: number) => Promise<void>} [opts.sleep] injectable sleep (tests)
   */
  constructor(opts) {
    opts = opts || {};
    this.minGapMs = typeof opts.minGapMs === 'number' ? opts.minGapMs : 1;
    this._now = opts.now || Date.now;
    // preciseSleep by default; tests inject their own so they stay fast + hermetic.
    this._sleep = opts.sleep || ((ms) => preciseSleep(ms));
    this._chain = Promise.resolve();
    this._lastSlotAt = -Infinity;
    /** Total slots handed out, used by the tests + status readout. */
    this.slotCount = 0;
    /** Total time spent waiting purely to satisfy the gap (ms). */
    this.throttledMs = 0;
  }

  /**
   * Wait until it is legal to perform one physical action.
   * @return {Promise<void>}
   */
  acquire() {
    const next = this._chain.then(() => this._waitForSlot());
    // Keep the chain alive even if a caller's action throws.
    this._chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async _waitForSlot() {
    const now = this._now();
    const earliest = this._lastSlotAt + this.minGapMs;
    const wait = earliest - now;
    if (wait > 0) {
      this.throttledMs += wait;
      await this._sleep(wait);
    }
    this._lastSlotAt = this._now();
    this.slotCount++;
  }

  /** Purely informational snapshot for the UI / logs. */
  stats() {
    return { slotCount: this.slotCount, throttledMs: this.throttledMs, minGapMs: this.minGapMs };
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ActionGate, defaultSleep };
