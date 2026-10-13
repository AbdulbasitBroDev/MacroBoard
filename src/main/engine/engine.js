'use strict';

/**
 * MacroEngine - executes a compiled step list.
 *
 * The engine is deliberately decoupled from Blockly: it only ever sees plain
 * JSON steps, which means the interesting logic (forever / random slots,
 * recursion guards, `at once` concurrency, chooser state, rate limiting, Stop
 * semantics) can be unit-tested with a mocked input library and no Electron.
 *
 * Physical actions go through the injected `input` port and are all gated by
 * ActionGate, so no two OS input events land closer than `minGapMs` apart.
 */

const { EventEmitter } = require('events');
const { ActionGate, defaultSleep } = require('./gate');
const { preciseSleep, createStepYielder, MIN_OS_WAIT_MS } = require('./timing');
const C = require('../../shared/constants');
const expressions = require('../../shared/expressions');
const px = require('../../shared/pixels');

const LIMITS = C.LIMITS;
const SLOT = C.SLOT;
const STEP = C.STEP;
const FLOW = C.FLOW;

/** Thrown internally to unwind a run when Stop is pressed. */
class StopError extends Error {
  constructor(message) {
    super(message || 'Stopped');
    this.name = 'StopError';
    this.isStop = true;
  }
}

/**
 * One run's cancellation token + cleanup registry.
 * The registry is what lets us release a held key cleanly when the user hits
 * Stop in the middle of a `hold`.
 */
class RunToken {
  constructor(runId) {
    this.runId = runId;
    this.stopped = false;
    this.reason = '';
    this._releasers = [];
    this._idleWaiters = [];
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.reason = reason || 'Stopped';
    const waiters = this._idleWaiters.splice(0, this._idleWaiters.length);
    waiters.forEach((w) => w());
  }

  /** Throw if Stop has been pressed. Called between every step + loop tick. */
  check() {
    if (this.stopped) throw new StopError(this.reason);
  }

  /** Register a teardown (e.g. keyUp) that must run even if we are stopped. */
  onStopRelease(fn) {
    this._releasers.push(fn);
    return () => {
      const i = this._releasers.indexOf(fn);
      if (i >= 0) this._releasers.splice(i, 1);
    };
  }

  /** @return {Promise<void>} resolves when the token is stopped. */
  idle() {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => this._idleWaiters.push(resolve));
  }

  /** Run every registered teardown. Never throws. */
  async releaseAll() {
    const fns = this._releasers.splice(0, this._releasers.length);
    for (const fn of fns) {
      try {
        await fn();
      } catch (err) {
        /* a teardown failure must not mask the original error */
      }
    }
  }
}

function clampInt(v, lo, hi) {
  let n = Math.floor(Number(v));
  if (!isFinite(n)) n = lo;
  return Math.max(lo, Math.min(hi, n));
}

function countSteps(steps) {
  let n = 0;
  const walk = (list) => {
    (list || []).forEach((s) => {
      n++;
      if (s && s.body) walk(s.body);
      if (s && s.pages) s.pages.forEach(walk);
      // `if` holds two named branches rather than one `body`.
      if (s && s.then) walk(s.then);
      if (s && s.else) walk(s.else);
    });
  };
  walk(steps);
  return n;
}

function memoryStore() {
  const map = new Map();
  return {
    get: (k, d) => (map.has(k) ? map.get(k) : d),
    set: (k, v) => map.set(k, v),
    all: () => Object.fromEntries(map),
  };
}

class MacroEngine extends EventEmitter {
  /**
   * @param {object} deps
   * @param {object} deps.input     physical input port (see services/inputService.js)
   * @param {object} deps.registry  { getMacroSteps(name) => {name, steps} | null }
   * @param {object} deps.store     persistent key/value store for chooser state
   * @param {function} [deps.log]   (level, message, meta) => void
   * @param {object} [deps.options]
   */
  constructor(deps) {
    super();
    deps = deps || {};
    this.input = deps.input || null;
    /**
     * Screen-reading port, used only by the `if pixel is <colour>` condition.
     * Optional: with no port, a pixel check reads false rather than throwing, so
     * the engine still runs a macro on a machine where pixel reading is
     * unavailable rather than failing every step.
     */
    this.pixel = deps.pixel || null;
    /**
     * Window-title port, used only by `wait until window titled "…" exists`.
     * Optional for the same reason as `pixel`: with no port the step reports a
     * clear error instead of failing every macro.
     */
    this.window = deps.window || null;
    this.registry = deps.registry || { getMacroSteps: () => null };
    this.store = deps.store || memoryStore();
    this._log = deps.log || (() => {});

    const o = deps.options || {};
    this._sleep = o.sleep || defaultSleep;
    this._now = o.now || Date.now;
    this._random = o.random || Math.random;
    this.gate = new ActionGate({
      minGapMs: o.minGapMs == null ? LIMITS.MIN_ACTION_GAP_MS : o.minGapMs,
      now: this._now,
      // NOTE: deliberately NOT `this._sleep`. The gate must use preciseSleep, not
      // the engine's OS-timer sleep: passing it through made every gate slot cost
      // up to ~11ms of jitter on this machine, which was the real reason a burst
      // took longer with a 0ms gap than with a 1ms one. `o.sleep` is only for
      // long `wait` steps, where 11ms of jitter is irrelevant.
    });

    this._current = null;
    this._runSeq = 0;
    this.state = 'idle';
    // Per-RUN so the starvation clock cannot be reset by unrelated activity.
    this._yieldStep = createStepYielder();
  }

  isRunning() {
    return this._current !== null;
  }

  currentRunId() {
    return this._current ? this._current.token.runId : null;
  }

  /**
   * Execute a compiled step list.
   * @param {object[]} steps
   * @param {object} [opts] { label, macroName }
   * @return {Promise<object>} result summary (never rejects; inspect `.error`)
   */
  async run(steps, opts) {
    opts = opts || {};
    if (this._current) {
      throw new Error('A macro is already running. Press Stop (or F8) before starting another.');
    }
    const startedAt = this._now();
    const ctx = {
      token: new RunToken(++this._runSeq),
      macroStack: [],
      stepCount: 0,
      label: opts.label || 'macro',
      gate: this.gate,
      yieldStep: this._yieldStep,
      /**
       * How many loops enclose the step being run.
       *
       * Needed because `at once` has to know whether there is a loop for a
       * `break` to escape. Propagating one unconditionally would mean a `break`
       * inside an `at once` that is not itself in a loop silently truncated the
       * rest of the macro - which is a nasty way to lose the last few blocks of
       * a macro. Loops increment it around their body.
       */
      loopDepth: 0,
    };

    this._current = ctx;
    this._setState('running');
    this._log('info', 'Run started', { label: ctx.label, runId: ctx.token.runId, steps: countSteps(steps) });

    let error = null;
    try {
      const flow = await this._executeList(steps || [], ctx);
      // The compiler refuses a break or continue at the top level, so reaching
      // this with a signal means a hand-edited step list. Warn rather than fail:
      // the alternative is a macro that dies for something the user cannot see
      // in the editor.
      if (flow !== FLOW.NEXT) {
        this._log(
          'warn',
          'a "' + (flow === FLOW.BREAK ? 'break' : 'continue') + '" was found with no loop around it, ' +
            'so the rest of the macro was skipped. Put it inside a repeat block.'
        );
      }
    } catch (err) {
      error = err;
      if (!(err instanceof StopError)) {
        this._log('error', 'Run failed: ' + err.message, { label: ctx.label });
      }
    } finally {
      await ctx.token.releaseAll();
      this._current = null;
      this._setState('idle');
    }

    const result = {
      ok: error === null,
      stopped: error instanceof StopError,
      error: error && !(error instanceof StopError) ? { message: error.message, name: error.name } : null,
      steps: ctx.stepCount,
      durationMs: this._now() - startedAt,
      gate: this.gate.stats(),
      label: ctx.label,
    };
    this._log('info', 'Run finished', result);
    this.emit('finished', result);
    return result;
  }

  /** Press Stop. Interrupts between steps; in-flight actions finish cleanly. */
  stop(reason) {
    if (!this._current) return false;
    this._log('info', 'Stop requested', { reason: reason || 'user' });
    this._current.token.stop(reason || 'Stopped by user');
    return true;
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  // ------------------------------------------------------------ slot logic

  /**
   * Resolve a numeric slot (plain number / forever / random range) to a value.
   * Called again to re-roll a random range.
   *
   * @param {object|null} slot  { kind, value?, min?, max? }
   * @param {object} opts
   * @param {string} opts.kind  SLOT.COUNT or SLOT.DURATION (informational)
   * @param {number} opts.cap   hard cap applied to plain numbers
   * @return {{value:number, forever:boolean, clamped:boolean, rolled:boolean}}
   */
  resolveSlot(slot, opts) {
    const cap = opts && typeof opts.cap === 'number' ? opts.cap : LIMITS.MAX_REPEAT_COUNT;
    if (!slot || typeof slot !== 'object') {
      return { value: 0, forever: false, clamped: false, rolled: false };
    }
    if (slot.kind === SLOT.FOREVER) {
      return { value: Infinity, forever: true, clamped: false, rolled: false };
    }
    if (slot.kind === SLOT.RANGE) {
      const a = clampInt(slot.min, 0, cap);
      const b = clampInt(slot.max, 0, cap);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const v = lo + Math.floor(this._random() * (hi - lo + 1));
      return {
        value: Math.max(lo, Math.min(hi, v)),
        forever: false,
        clamped: a !== Math.floor(Number(slot.min)) || b !== Math.floor(Number(slot.max)),
        rolled: true,
      };
    }
    const raw = Number(slot.value);
    let v = isFinite(raw) ? Math.floor(raw) : 0;
    let clamped = false;
    if (v < 0) {
      v = 0;
      clamped = true;
    }
    if (v > cap) {
      v = cap;
      clamped = true;
    }
    return { value: v, forever: false, clamped, rolled: false };
  }

  // -------------------------------------------------------------- execution

  /**
   * Run a step list.
   *
   * @return {Promise<string>} a FLOW signal. `continue` unless a `break`
   *   somewhere in the list asked the enclosing loop to stop.
   *
   * RETURNING rather than throwing is the whole design here. A `break` is a
   * normal outcome of running a loop body, and if it unwound by exception it
   * would take every enclosing loop with it - the one thing `break` must never
   * do. Each loop consumes the signal for itself, so a `break` in a nested loop
   * leaves only that loop.
   */
  async _executeList(steps, ctx) {
    ctx.token.check();
    for (let i = 0; i < steps.length; i++) {
      ctx.token.check();
      // Yield to the event loop between steps so a tight macro cannot keep the
      // process out of it - Stop, the renderer and the input hook all depend on
      // that. The yield costs up to ~11ms here (setTimeout(0) resolution), which
      // is why a step that ALREADY yielded does not pay for a second one: 20
      // consecutive `wait 100ms` blocks drifted by 154ms when every step paid.
      if (!ctx.stepYielded) await ctx.yieldStep();
      ctx.stepYielded = false;
      ctx.token.check();
      const flow = await this._executeStep(steps[i], ctx);
      if (flow === FLOW.BREAK) return FLOW.BREAK;
      if (flow === FLOW.PASS) return FLOW.PASS;
    }
    ctx.token.check();
    return FLOW.NEXT;
  }

  /**
   * Run one step.
   * @return {Promise<string>} a FLOW signal; only control-flow steps produce
   *   anything other than `continue`.
   */
  async _executeStep(step, ctx) {
    if (!step || typeof step.type !== 'string') return FLOW.NEXT;
    ctx.stepCount++;
    this.emit('step', { type: step.type, runId: ctx.token.runId, index: ctx.stepCount, step });
    this._log('debug', 'step ' + step.type, { step });

    switch (step.type) {
      case STEP.WAIT:
        await this._doWait(step, ctx);
        return FLOW.NEXT;
      case STEP.MOVE_TO:
        await this._gateThen(ctx, () => this.input.moveTo(step.x, step.y, step.ms));
        return FLOW.NEXT;
case STEP.MOVE_BY:
  await this._gateThen(ctx, () => this.input.moveBy(step.dx, step.dy, step.ms));
        return FLOW.NEXT;
      case STEP.MOVE_WITHIN:
        await this._doMoveWithin(step, ctx);
        return FLOW.NEXT;
      case STEP.SCROLL:
        await this._gateThen(ctx, () => this.input.scroll(step.direction, step.px, step.ms));
        return FLOW.NEXT;
      case STEP.CLICK:
        await this._gateThen(ctx, () => this.input.click(step.button, step.x, step.y));
        return FLOW.NEXT;
      case STEP.TYPE_TEXT:
        await this._gateThen(ctx, () => this.input.typeText(step.text));
        return FLOW.NEXT;
      case STEP.PRESS_KEY:
        await this._doPressKey(step, ctx);
        return FLOW.NEXT;
      case STEP.HOLD_KEY:
        await this._doHoldKey(step, ctx);
        return FLOW.NEXT;
      case STEP.REPEAT:
        return this._doRepeat(step, ctx);
      case STEP.REPEAT_UNTIL:
        return this._doRepeatUntil(step, ctx);
      case STEP.AT_ONCE:
        return this._doAtOnce(step, ctx);
      case STEP.RUN_MACRO:
        await this._doRunMacro(step, ctx);
        return FLOW.NEXT;
      case STEP.CHOOSER:
        return this._doChooser(step, ctx);
      case STEP.IF:
        return this._doIf(step, ctx);
      case STEP.WAIT_FOR_WINDOW:
        await this._doWaitForWindow(step, ctx);
        return FLOW.NEXT;
      case STEP.BREAK:
        return FLOW.BREAK;
      case STEP.CONTINUE:
        // Ends the PASS, not the loop. Deliberately a different signal from
        // falling off the end of the body, so a loop can tell the two apart and
        // so `continue` is not accidentally a no-op.
        return FLOW.PASS;
      default:
        throw new Error(
          'Unknown step type "' + step.type + '". This macro may have been saved by a newer version, ' +
            'or the saved step list was edited by hand.'
        );
    }
  }

  async _gateThen(ctx, fn) {
    ctx.token.check();
    await this.gate.acquire();
    await fn();
  }

  /**
   * Move the cursor to a random point inside a rectangle.
   *
   * The corners may be given in any order - someone picking the second corner
   * first is natural, so each axis is normalised independently rather than
   * warning about it.
   *
   * A rectangle with zero width or height is a legitimate line or point, so it
   * is allowed rather than rejected.
   */
  async _doMoveWithin(step, ctx) {
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const xa = num(step.x1, 0);
  const xb = num(step.x2, 0);
  const ya = num(step.y1, 0);
  const yb = num(step.y2, 0);
  const xLo = Math.min(xa, xb);
  const xHi = Math.max(xa, xb);
  const yLo = Math.min(ya, yb);
  const yHi = Math.max(ya, yb);
  // Clamped deliberately. Math.random() never returns 1, but _random is
  // injectable, and floor(1 * (hi - lo + 1)) is hi + 1 - one pixel outside the
  // rectangle. resolveSlot clamps for the same reason.
  const pick = (lo, hi) => Math.max(lo, Math.min(hi, lo + Math.floor(this._random() * (hi - lo + 1))));
  // step.ms is a plain number here, NOT a slot object - the compiler emits it
  // as a literal, exactly like moveTo/moveBy. Going through resolveSlot would
  // silently yield 0 for a non-slot, making every move instantaneous.
  const ms = Math.max(0, Math.min(LIMITS.MAX_MOVE_MS, Number(step.ms) || 0));
  await this._gateThen(ctx, () => this.input.moveTo(pick(xLo, xHi), pick(yLo, yHi), ms));
  }

  async _doWait(step, ctx) {
    const ms = this.resolveSlot(step.ms, { cap: LIMITS.MAX_WAIT_MS });
    if (ms.clamped) this._log('warn', 'wait clamped to the ' + LIMITS.MAX_WAIT_MS + 'ms maximum');
    if (ms.forever) {
      this._log('info', 'waiting forever (until Stop)');
      await this._idleUntilStopped(ctx);
      return;
    }
    await this._sleepInterruptible(ms.value, ctx);
  }

  /**
   * Sleep, but wake immediately when Stop is pressed.
   *
   * Delegates to preciseSleep, which measures against a single absolute deadline
   * and polls `shouldStop` throughout. The old chunked loop subtracted the
   * REQUESTED slice from the remaining time while the OS timer overshot its
   * request, so the error accumulated once per chunk: `wait 776ms` measured
   * 1087ms. See src/main/engine/timing.js.
   */
  async _sleepInterruptible(ms, ctx) {
    // A wait of MIN_OS_WAIT_MS or more hands control to the OS timer, so it has
    // already yielded to the event loop - the step loop must not pay again.
    ctx.stepYielded = ms >= MIN_OS_WAIT_MS;
    await preciseSleep(ms, { shouldStop: () => ctx.token.stopped });
    // preciseSleep returns early when stopped; throw so the run unwinds.
    ctx.token.check();
  }

  async _idleUntilStopped(ctx) {
    await ctx.token.idle();
    ctx.token.check();
  }

  async _doPressKey(step, ctx) {
    const count = this.resolveSlot(step.count, { cap: LIMITS.MAX_PRESS_COUNT });
    const button = step.button;
    if (count.clamped) this._log('warn', 'press count clamped to ' + LIMITS.MAX_PRESS_COUNT);

    // A `forever` count, a random count, or an input port with no burst support
    // (a test double, or a future nut-js without the provider registry) all fall
    // back to the plain loop below.
    const simple = count.forever || count.kind === SLOT.RANGE || typeof this.input.pressBurst !== 'function';
    if (!simple) {
      // FIXED COUNT: hand the whole run to the input layer, which dispatches the
      // events back to back and spins the gap precisely. Two separate awaited
      // OS-timer sleeps per press cannot hit the requested rate; this can.
      const gap = this.resolveSlot(step.gapMs, { cap: LIMITS.MAX_GAP_MS });
      if (gap.forever) {
        // Deliberately degenerate case: hang after the first press until Stop.
        await this._gateThen(ctx, () => this.input.keyDown(button));
        await ctx.gate.acquire();
        await this.input.keyUp(button);
        this._log('warn', 'press gap is "forever": hanging after the first press until Stop');
        await this._idleUntilStopped(ctx);
        return;
      }
      if (gap.clamped) this._log('warn', 'press gap clamped to ' + LIMITS.MAX_GAP_MS + 'ms');

      const result = await this.input.pressBurst(button, count.value, gap.value, {
        // Stop must still land mid-burst. The burst paces itself (the native call
        // is the rate limit), so it deliberately does not take a gate slot.
        shouldStop: () => ctx.token.stopped,
      });
      ctx.stepCount += result.pressed;
      return;
    }

    let i = 0;
    for (;;) {
      ctx.token.check();
      if (!count.forever && i >= count.value) break;

      // A press is down+up back to back: it is ONE action and must never be split
      // by the gap, which belongs BETWEEN presses.
      await ctx.gate.acquire();
      await this.input.keyDown(button);
      await ctx.gate.acquire();
      await this.input.keyUp(button);
      i++;

      // Re-rolled every iteration so a random range varies press to press.
      const gap = this.resolveSlot(step.gapMs, { cap: LIMITS.MAX_GAP_MS });
      if (gap.forever) {
        // Deliberately degenerate case: the sequence hangs after the first press
        // until Stop. Surfaced as a tooltip warning in the editor.
        this._log('warn', 'press gap is "forever": hanging after press #' + i + ' until Stop');
        await this._idleUntilStopped(ctx);
        break;
      }
      if (gap.clamped) this._log('warn', 'press gap clamped to ' + LIMITS.MAX_GAP_MS + 'ms');
      const more = count.forever || i < count.value;
      if (more && gap.value > 0) {
        // preciseSleep, not the OS timer: a `setTimeout` of 1ms measured anywhere
        // from 1.3ms to 17ms on this machine, which is why a "1ms gap" macro ran
        // several times slower than it claimed.
        await preciseSleep(gap.value, { shouldStop: () => ctx.token.stopped });
      }
    }
  }

  async _doHoldKey(step, ctx) {
    const hold = this.resolveSlot(step.ms, { cap: LIMITS.MAX_DURATION_MS });
    const button = step.button;
    if (hold.clamped) this._log('warn', 'hold duration clamped to ' + LIMITS.MAX_DURATION_MS + 'ms');

    await this._gateThen(ctx, () => this.input.keyDown(button));
    // Guarantee release even if Stop lands mid-hold.
    const off = ctx.token.onStopRelease(() => this.input.keyUp(button));
    try {
      if (hold.forever) {
        await this._idleUntilStopped(ctx);
      } else {
        await this._sleepInterruptible(hold.value, ctx);
      }
    } finally {
      off();
      await this.gate.acquire();
      try {
        await this.input.keyUp(button);
      } catch (err) {
        this._log('warn', 'failed to release key: ' + err.message);
      }
    }
  }

  /**
   * Run a loop body with the loop-depth counter raised.
   *
   * Centralised here so `repeat` and `repeat until` cannot drift apart on it.
   */
  async _runLoopBody(body, ctx) {
    ctx.loopDepth++;
    try {
      return await this._executeList(body || [], ctx);
    } finally {
      // `finally`, so a failing or stopped body still leaves the count correct
      // for whatever runs next.
      ctx.loopDepth--;
    }
  }

  /**
   * `repeat N times`.
   *
   * The loop CONSUMES a `break` coming out of its body and returns `next`: that
   * is what makes a break in a nested loop leave only the inner one.
   */
  async _doRepeat(step, ctx) {
    const count = this.resolveSlot(step.count, { cap: LIMITS.MAX_REPEAT_COUNT });
    if (count.clamped) this._log('warn', 'repeat count clamped to ' + LIMITS.MAX_REPEAT_COUNT);
    const body = step.body || [];
    let i = 0;
    for (;;) {
      ctx.token.check();
      if (!count.forever && i >= count.value) break;
      const flow = await this._runLoopBody(body, ctx);
      if (flow === FLOW.BREAK) {
        this._log('debug', 'repeat left early by a break after ' + i + ' pass(es)');
        break;
      }
      i++;
      if (body.length === 0) await this._sleep(1); // never spin the CPU on an empty body
    }
    return FLOW.NEXT;
  }

  /**
   * `repeat until <condition>`.
   *
   * The condition is evaluated BEFORE every pass, including the first, so a
   * condition that is already true runs the body zero times. That is the whole
   * difference from `repeat N times` and the reason it is not just sugar.
   *
   * STUCK-LOOP GUARD: a condition that can never become true would otherwise
   * hold a macro slot forever with no way out but Stop. The cap turns that into
   * a clear failure that NAMES the condition, because "this loop ran 100,000
   * times" is useless on its own while "waiting for (pixel 640,380 is #00ff00)"
   * tells you immediately which check is never coming true.
   */
  async _doRepeatUntil(step, ctx) {
    const body = step.body || [];
    const cap = LIMITS.MAX_CONDITION_LOOP_ITERATIONS;
    let passes = 0;
    for (;;) {
      ctx.token.check();
      const done = await this._evalCondition(step.cond, ctx);
      if (done) return FLOW.NEXT;
      if (passes >= cap) {
        throw new Error(
          '"repeat until" ran ' + passes.toLocaleString('en-US') + ' times without its condition ' +
            'becoming true, so it stopped rather than loop forever. The condition was: ' +
            expressions.describe(step.cond) + '. If the pixel coordinates or the colour are wrong, the ' +
            'condition may be impossible to satisfy.'
        );
      }
      const flow = await this._runLoopBody(body, ctx);
      if (flow === FLOW.BREAK) {
        this._log('debug', 'repeat until left early by a break after ' + passes + ' pass(es)');
        return FLOW.NEXT;
      }
      passes++;
      if (body.length === 0) await this._sleep(1); // never spin the CPU on an empty body
    }
  }

  /**
   * `at once` - every block stacked inside becomes its own concurrent task.
   *
   * THE BREAK RULE, chosen and documented: if any task returns `break`, the
   * `at once` itself returns `break` to the surrounding loop - so a `break`
   * inside `at once` inside a loop leaves that loop, AND ends the task it was
   * in. The other tasks are NOT cancelled: they are already in flight, and
   * cancelling them would mean abandoning a half-finished key press or click.
   * They run to completion and the loop stops afterwards.
   *
   * A `continue` inside `at once` ends ONLY the task it is in. It does not reach
   * the surrounding loop - which is the whole point of it there, and the reason
   * it is worth having despite doing nothing special in a plain body.
   *
   * A `break` propagates only when there IS a loop to leave (ctx.loopDepth). If
   * this `at once` is not inside one, the break is dropped and the macro carries
   * on, rather than silently losing everything after it.
   *
   * The alternative - treating `break` inside `at once` as a no-op - was
   * rejected because it would silently do nothing in a situation where the user
   * plainly asked for an exit.
   */
  async _doAtOnce(step, ctx) {
    const body = step.body || [];
    if (body.length === 0) return FLOW.NEXT;
    let sawBreak = false;
    const tasks = body.map((child) =>
      Promise.resolve()
        .then(() => this._executeStep(child, ctx))
        .then((flow) => {
          if (flow === FLOW.BREAK) sawBreak = true;
        })
        .catch((err) => {
          if (!ctx.token.stopped) ctx.token.stop('A parallel branch failed: ' + err.message);
          throw err;
        })
    );
    await Promise.all(tasks);
    if (sawBreak && ctx.loopDepth > 0) return FLOW.BREAK;
    if (sawBreak) this._log('warn', '"break" inside an "at once" had no loop to leave, so it was ignored');
    return FLOW.NEXT;
  }

  async _doRunMacro(step, ctx) {
    const name = step.name;
    if (!name) throw new Error('"run another macro" has no macro selected.');

    if (ctx.macroStack.length >= LIMITS.MAX_MACRO_DEPTH) {
      const chain = ctx.macroStack.concat(name).join(' \u2192 ');
      throw new Error(
        'Maximum macro nesting depth (' + LIMITS.MAX_MACRO_DEPTH + ') exceeded: ' + chain +
          '. Two macros are probably calling each other in a loop.'
      );
    }

    const macro = this.registry.getMacroSteps(name);
    if (!macro || !Array.isArray(macro.steps)) {
      throw new Error(
        'Macro "' + name + '" could not be found - it may have been renamed or deleted since this ' +
          'block was placed. Re-pick it from the dropdown.'
      );
    }

    ctx.macroStack.push(name);
    try {
      await this._executeList(macro.steps, ctx);
    } finally {
      ctx.macroStack.pop();
    }
  }

  /**
   * A chooser page runs as a step list, so it INHERITS a `break` from the loop
   * that contains it. A break inside a chooser page therefore leaves the
   * surrounding loop, which is what the user meant by putting it there.
   */
  async _doChooser(step, ctx) {
    const pages = Array.isArray(step.pages) ? step.pages : [];
    if (pages.length === 0) return FLOW.NEXT;

    let index;
    if (step.mode === 'organized') {
      // A persistent "next page" cursor that survives separate runs of the macro
      // (and app restarts, because `store` is backed by a JSON file on disk).
      const key = 'chooser:' + step.id;
      const raw = Number(this.store.get(key, 0));
      const cursor = isFinite(raw) ? raw : 0;
      index = ((cursor % pages.length) + pages.length) % pages.length;
      // Advance a MONOTONIC counter (not the wrapped index) before running, so a
      // stopped run still cycles predictably and the position survives pages
      // being added or removed later.
      this.store.set(key, cursor + 1);
      this._log('info', 'chooser "' + step.id + '" -> page ' + (index + 1) + '/' + pages.length);
    } else {
      const usable = [];
      pages.forEach((p, i) => {
        if (Array.isArray(p) && p.length > 0) usable.push(i);
      });
      // Only ever land on a page that actually has blocks in it (an empty page
      // would look like the block did nothing).
      const pool = usable.length ? usable : pages.map((_p, i) => i);
      index = pool[Math.floor(this._random() * pool.length)];
      this._log('info', 'chooser "' + step.id + '" -> random page ' + (index + 1) + '/' + pages.length);
    }

    return this._executeList(pages[index] || [], ctx);
  }

    /**
   * `wait until window titled "…" exists`
   *
   * STOP IS RACED, not polled for. A window check can be waiting on a child
   * process, and simply checking the token between polls would mean Stop landed
   * up to one interval late. Racing `token.idle()` and killing the helper means
   * Stop is immediate - and killing the helper is what unwinds the in-flight
   * query, since a PowerShell call cannot be interrupted from Node.
   */
  async _doWaitForWindow(step, ctx) {
    if (!this.window || typeof this.window.waitFor !== 'function') {
      throw new Error(
        'This macro waits for a window, but window reading is unavailable here. ' +
          ((this.window && this.window.reason) || 'No window service is available.')
      );
    }
    const title = String(step.title || '').trim();
    if (!title) throw new Error('"wait until window" has no title to look for.');

    const timeout = this.resolveSlot(step.timeoutMs, { cap: LIMITS.MAX_DURATION_MS });
    if (timeout.forever) {
      throw new Error(
        '"wait until window" cannot wait forever - that would hang the macro on an app that may never ' +
          'open. Give it a timeout.'
      );
    }
    const timeoutMs = Math.max(0, Math.min(LIMITS.MAX_DURATION_MS, timeout.value));

    const work = this.window.waitFor(title, {
      timeoutMs,
      pollMs: step.pollMs,
      shouldStop: () => ctx.token.stopped,
    });
    // Killing the helper is what actually unwinds a query already in flight.
    // Registered as a stop-release so it runs on the Stop path, not just at the
    // end of the run.
    const offRelease = ctx.token.onStopRelease(() => {
      if (typeof this.window.abort === 'function') this.window.abort();
    });

    let res;
    try {
      res = await Promise.race([work, ctx.token.idle().then(() => ({ ok: false, stopped: true }))]);
    } catch (err) {
      offRelease();
      throw err;
    }
    // Deliberately NOT unregistering on the stop path: killing the helper is
    // what unwinds the in-flight query, and it only runs from the run's own
    // cleanup (RunToken.releaseAll). Unregistering here would cancel the very
    // teardown that makes Stop land immediately.
    if (!res.stopped) offRelease();

    if (res.stopped) {
      // Unwind as a Stop, not a failure, so the run result says "stopped".
      ctx.token.check();
      return;
    }
    if (res.ok) {
      this._log('debug', 'window "' + title + '" appeared after ' + res.waitedMs + 'ms');
      return;
    }
    if (res.timedOut) {
      // The list of what WAS open is the whole point: "no window matching
      // Notepad" is useless, "these were open" tells you what to match on.
      const seen = (res.windows || []).slice(0, 6).map((w) => '"' + w.title + '"');
      throw new Error(
        'Waited ' + (res.waitedMs || timeoutMs) + 'ms but no window title containing "' + title + '" ' +
          'appeared. ' +
          (seen.length
            ? 'The windows that WERE open were: ' + seen.join(', ') + '. Match part of one of those.'
            : 'No visible windows were open at all - the app may have failed to start.')
      );
    }
    throw new Error(res.reason || 'Waiting for window "' + title + '" failed.');
  }

  /**
   * `if / else`.
 *
 * The condition is evaluated immediately before the branch runs, so an `if`
 * inside a loop re-tests every pass rather than deciding once when the macro
 * started. Only the taken branch is executed; the other is skipped entirely.
 *
 * A `break` inside a branch is returned straight up: an `if` is not a loop, so
 * it has no business consuming the signal.
 */
async _doIf(step, ctx) {
    const truthy = await this._evalCondition(step.cond, ctx);
    const branch = truthy ? step.then : step.else;
    this._log('debug', 'if -> ' + (truthy ? 'then' : 'else'), {
      cond: expressions.describe(step.cond),
      branch: Array.isArray(branch) ? branch.length : 0,
    });
    return this._executeList(Array.isArray(branch) ? branch : [], ctx);
  }

  /**
   * Evaluate a condition tree to true/false, resolving any pixel checks first.
   *
   * ORDER MATTERS. The shared evaluator (src/shared/expressions.js) is pure and
   * synchronous on purpose - it is the same file the compiler and the tests use,
   * and giving it I/O would be how the three drift apart. So the engine does the
   * screen reading in two steps:
   *
   *   1. collect every pixel the condition mentions,
   *   2. read them ALL from one capture, then substitute each answer in as a
   *      plain literal, then let the shared evaluator do the logic.
   *
   * Step 2 is what makes `(pixel A is red) and (pixel B is red)` cost one
   * capture rather than two - and, more importantly, make the two answers come
   * from the same frame. Reading them separately could straddle a change and
   * report a state that never existed.
   */
  async _evalCondition(cond, ctx) {
    if (!cond) return false;
    const wanted = expressions.collectPixels(cond);
    if (wanted.length === 0) {
      return expressions.evalBoolean(cond, this._random);
    }

    const answers = await this._readPixelsForCondition(wanted, ctx);
    const resolved = expressions.substitutePixels(cond, answers);
    return expressions.evalBoolean(resolved, this._random);
  }

  async _readPixelsForCondition(wanted, ctx) {
    const answers = {};
    if (!this.pixel || typeof this.pixel.readPixels !== 'function') {
      this._log(
        'warn',
        'a condition checks a screen pixel but pixel reading is unavailable; treating it as false'
      );
      return answers;
    }
    ctx.token.check();
    let samples;
    try {
      samples = await this.pixel.readPixels(wanted);
    } catch (err) {
      // A capture can fail legitimately - the display asleep, a UAC prompt, the
      // screen locked. That is a "condition not met" situation, not a reason to
      // kill a macro that may be mid-loop.
      this._log('warn', 'screen capture failed: ' + err.message);
      return answers;
    }
    wanted.forEach((p, i) => {
      const s = samples && samples[i];
      if (!s) {
        answers[p.key] = false;
        return;
      }
      if (s.outside) {
        this._log('warn', 'pixel (' + p.x + ',' + p.y + ') is off the captured screen');
        answers[p.key] = false;
        return;
      }
      const hit = px.matches(s.rgb, p.colour, p.tol);
      if (!hit) {
        // The actual colour is logged because "it did not match" is the hardest
        // kind of macro bug to debug, and the answer is usually one field away.
        this._log('debug', 'pixel (' + p.x + ',' + p.y + ') read ' + s.colour + ', wanted ' + p.colour);
      }
      answers[p.key] = hit;
    });
    return answers;
  }

  /** Convenience for the "run selected blocks" feature. */
  async runInline(steps, label) {
    return this.run(steps, { label: label || 'selection' });
  }
}

module.exports = { MacroEngine, StopError, RunToken, clampInt, countSteps, memoryStore };


