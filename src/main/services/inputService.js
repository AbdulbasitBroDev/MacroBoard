'use strict';

/**
 * InputService - the physical input port used by the execution engine.
 *
 * Wraps @nut-tree-fork/nut-js (the only thing that actually moves the mouse and
 * presses keys). Everything is defensive:
 *
 *   - the native module is required lazily and inside try/catch, so a broken
 *     native install degrades to "actions throw a clear error" instead of the
 *     whole app refusing to start;
 *   - nut's built-in auto-delay (100ms for mouse, 300ms for keyboard!) is
 *     switched off, because the engine owns pacing through ActionGate. Leaving
 *     those defaults on would silently make every macro far slower than the
 *     user's "ms gap" numbers claim.
 */

const { spinGap, preciseSleep, yieldToEventLoop, SPIN_LIMIT_MS } = require('../engine/timing');
const C = require('../../shared/constants');

const DEFAULT_MOUSE_SPEED = 2500;

/** How many presses happen between event-loop yields during a burst. */
const BURST_YIELD_EVERY = 32;

function createInputService(deps) {
  deps = deps || {};
  const log = deps.log || (() => {});
  const buttons = deps.buttons;

  let nut = null;
  let loadError = null;
  // `deps.nut` is a test seam: the real module is loaded lazily so a broken native
  // install degrades gracefully, and tests can inject a double.
  try {
    if (deps.nut) {
      nut = deps.nut;
    } else {
      // eslint-disable-next-line global-require
      nut = require('@nut-tree-fork/nut-js');
    }
    if (!nut.mouse || !nut.keyboard) throw new Error('module loaded but mouse/keyboard exports are missing');
  } catch (err) {
    loadError = err;
    nut = null;
  }

  const available = Boolean(nut);
  const reason = available
    ? ''
    : 'Input simulation is unavailable: ' + (loadError ? loadError.message : 'unknown error') +
      '. MacroBlock can still compile and validate macros, but cannot press keys or move the mouse.';

  if (available) {
    try {
      // The engine enforces the real minimum gap; nut's own delays would double up.
      nut.mouse.config.autoDelayMs = 0;
      nut.mouse.config.mouseSpeed = DEFAULT_MOUSE_SPEED;
      nut.keyboard.config.autoDelayMs = 0;
      log('info', 'input service ready (autoDelay disabled, engine owns pacing)');
    } catch (err) {
      log('warn', 'could not tune nut-js config: ' + err.message);
    }
  } else {
    log('warn', reason);
  }

  function requireNut() {
    if (!available) throw new Error(reason);
    return nut;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Track what we have left pressed so shutdown can always release it.
  const held = { keys: new Set(), mouse: new Set() };

  /**
   * nut-js routes EVERY call through `await sleep(autoDelayMs)`, and that sleep
   * is a `setTimeout`. On Windows the timer granularity is poor (measured: a
   * `setTimeout(0)` takes ~11ms), so the sleep - not the native call - became
   * the bottleneck: `mouse.click()` measured 11.5ms/op when the underlying
   * native call is 0.35ms.
   *
   * The provider objects are reachable and their methods are the same functions
   * nut-js calls, minus the sleep. So the high-rate path uses them directly.
   * Everything else keeps using the public API (with the sleep harmless).
   *
   * If a future version of nut-js moves these, `fast` is null and every caller
   * falls back to the public API - slower, but correct.
   */
  const fast = (() => {
    if (!available) return null;
    try {
      const registry = nut.mouse && nut.mouse.providerRegistry;
      if (!registry || typeof registry.getMouse !== 'function') return null;
      const mouse = registry.getMouse();
      const keyboard = typeof registry.getKeyboard === 'function' ? registry.getKeyboard() : null;
      if (!mouse || !mouse.pressButton || !mouse.releaseButton) return null;
      if (!keyboard || !keyboard.pressKey || !keyboard.releaseKey) return null;
      return { mouse, keyboard };
    } catch (err) {
      log('warn', 'fast input path unavailable, falling back to the slower API: ' + err.message);
      return null;
    }
  })();

  /** Resolve a button id to everything needed to press/release it directly. */
  function resolveTarget(buttonId) {
    const isMouse = buttons.isMouseId(buttonId);
    if (isMouse) {
      const value = buttons.toNutButton(buttonId);
      if (!fast) return { id: buttonId, isMouse, mouse: nut.mouse, button: value };
      return { id: buttonId, isMouse, mouse: fast.mouse, button: value };
    }
    const value = buttons.toNutKey(buttonId);
    if (!fast) return { id: buttonId, isMouse, mouse: null, keyboard: nut.keyboard, key: value };
    return { id: buttonId, isMouse, mouse: null, keyboard: fast.keyboard, key: value };
  }

  // ------------------------------------------------------------- self-echo
  //
  // The global hook reports our OWN injected presses and releases. So a macro
  // like `while holding RMB: press RMB forever` sees its own synthetic mouseup
  // and tears itself down after a single press - the run stops fighting itself.
  //
  // Each injection produces exactly one hook event, in order, so the fix is to
  // remember what we injected and consume those echoes as they arrive:
  //
  //   physicalDown -> real, starts the hold
  //   synthDown    -> echo, ignored
  //   synthUp      -> echo, ignored
  //   physicalUp   -> real, stops the hold
  //
  // Echoes are matched on KIND as well as button. Matching on button alone
  // desynchronises the moment a consumer looks only at down events: the press-count
  // trigger never consumes the pending "up" echo, and then a later genuine down
  // event eats it and is wrongly ignored.
  //
  // Entries EXPIRE. If a hook event were ever dropped, an un-expiring queue would
  // swallow the user's next real release and leave a macro running forever, which
  // is far worse than the bug being fixed.
  const ECHO_TTL_MS = deps.echoTtlMs === undefined ? 1000 : deps.echoTtlMs;
  const now = deps.now || (() => Date.now());
  const pendingEcho = new Map();

  function noteSynth(buttonId, kind) {
    if (!buttonId) return;
    const list = pendingEcho.get(buttonId) || [];
    list.push({ at: now(), kind });
    pendingEcho.set(buttonId, list);
  }

  /**
   * True when a hook event of this kind is one of our own injections. Consumes
   * it. `kind` is 'down' or 'up'.
   */
  function takeEcho(buttonId, kind) {
    const list = pendingEcho.get(buttonId);
    if (!list || !list.length) return false;
    const t = now();
    while (list.length && t - list[0].at > ECHO_TTL_MS) list.shift();
    if (!list.length) { pendingEcho.delete(buttonId); return false; }
    const i = list.findIndex((e) => e.kind === kind);
    if (i === -1) return false;
    list.splice(i, 1);
    if (!list.length) pendingEcho.delete(buttonId);
    return true;
  }

  async function downTarget(t) {
    noteSynth(t.id, 'down');
    return t.isMouse ? t.mouse.pressButton(t.button) : t.keyboard.pressKey(t.key);
  }

  async function upTarget(t) {
    noteSynth(t.id, 'up');
    return t.isMouse ? t.mouse.releaseButton(t.button) : t.keyboard.releaseKey(t.key);
  }

  return {
    available,
    reason,

    /**
     * True when a hook event for this button is an echo of our own injection.
     * Trigger code calls this BEFORE acting on the event.
     */
    takeEcho,

    async moveTo(x, y, ms) {
      const n = requireNut();
      const targetX = Math.round(x);
      const targetY = Math.round(y);
      const duration = Math.max(0, Math.round(ms));

      if (duration === 0) {
        await n.mouse.setPosition(new n.Point(targetX, targetY));
        return;
      }

      // Same interpolation as moveBy, but from wherever the cursor happens to be
      // to the absolute target - a "within" move to a picked coordinate still has
      // to be a glide, not a jump.
      const start = await n.mouse.getPosition();
      const steps = Math.max(1, Math.min(120, Math.round(duration / 16)));
      const stepMs = duration / steps;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await n.mouse.setPosition(
          new n.Point(
            Math.round(start.x + (targetX - start.x) * t),
            Math.round(start.y + (targetY - start.y) * t)
          )
        );
        if (i < steps) await sleep(stepMs);
      }
    },

    /**
     * Smooth relative move.
     *
     * nut's `mouse.move` is paced by mouseSpeed/autoDelay, which does not map
     * onto "within N ms". Interpolating manually honours the requested duration
     * exactly, and the engine's ActionGate still guards the whole move.
     */
/**
   * Scroll the wheel by a pixel amount.
   *
   * The unit is the trap. `scrollUp(amount)` takes a RAW WHEEL DELTA, not a
   * number of notches - Windows counts one notch as WHEEL_DELTA (120). So:
   *
   *   scrollUp(1)   x100  ->  total delta 100  ->  0.8 of a notch  ->  ~20px
   *   scrollUp(83)        ->  total delta  83  ->  0.7 of a notch  ->  ~14px
   *   scrollUp(3)         ->  total delta   3  ->  nothing visible
   *
   * All three were shipped and all three were reported as "it only scrolls a
   * little". Every click must therefore carry PX_PER_NOTCH.
   *
   * One event per click, evenly spaced, with a FLOOR on the gap: apps COALESCE
   * rapid wheel events rather than queueing them, so firing with no gap makes the
   * target app swallow the burst.
   */
  async scroll(direction, px, ms) {
    const n = requireNut();
    const totalPx = Math.max(0, Math.round(px));
    const notches = Math.max(1, Math.round(totalPx / C.SCROLL.PX_PER_NOTCH));
    const duration = Math.max(0, Math.round(ms));
    const up = direction === C.SCROLL.UP;

    // Both the low-level provider and the public MouseClass expose scrolling; take
    // whichever is available, preferring the fast path.
    const mouse = (fast && typeof (fast.mouse || {}).scrollUp === 'function') ? fast.mouse : n.mouse;
    const send = up ? mouse.scrollUp : mouse.scrollDown;
    if (typeof send !== 'function') {
      throw new Error('This build of the input library cannot scroll the wheel.');
    }

    // RAW DELTA per click, not 1.
    const oneClick = () => send.call(mouse, C.SCROLL.PX_PER_NOTCH);

    if (notches === 1) {
      log('info', 'scroll ' + direction + ' 1 click (delta ' + C.SCROLL.PX_PER_NOTCH + ')');
      await oneClick();
      return;
    }

    // The floor. Firing faster than this and apps coalesce the events.
    const gapMs = Math.max(C.SCROLL.MIN_CLICK_GAP_MS, duration / notches);
    const totalMs = Math.round(gapMs * (notches - 1));
    if (duration > 0 && totalMs > duration * 1.5) {
      log('warn', 'scroll ' + direction + ' ' + notches + ' clicks cannot fit in ' + duration + 'ms - taking ' + totalMs + 'ms instead');
    }
    log('info', 'scroll ' + direction + ' ' + totalPx + 'px -> ' + notches + ' click(s) of delta ' + C.SCROLL.PX_PER_NOTCH + ', ~' + gapMs.toFixed(1) + 'ms apart');

    for (let i = 0; i < notches; i++) {
      await oneClick();
      if (i < notches - 1) await sleep(gapMs);
    }
  },

    async moveBy(dx, dy, ms) {
      const n = requireNut();
      const start = await n.mouse.getPosition();
      const targetX = start.x + Math.round(dx);
      const targetY = start.y + Math.round(dy);
      const duration = Math.max(0, Math.round(ms));

      if (duration === 0) {
        await n.mouse.setPosition(new n.Point(targetX, targetY));
        return;
      }

      // ~60fps steps, capped so a long move cannot enqueue thousands of moves.
      const steps = Math.max(1, Math.min(120, Math.round(duration / 16)));
      const stepMs = duration / steps;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await n.mouse.setPosition(
          new n.Point(
            Math.round(start.x + (targetX - start.x) * t),
            Math.round(start.y + (targetY - start.y) * t)
          )
        );
        if (i < steps) await sleep(stepMs);
      }
    },

    async click(buttonId, x, y) {
      const n = requireNut();
      const button = buttons.toNutButton(buttonId);
      if (typeof x === 'number' && typeof y === 'number') {
        await n.mouse.setPosition(new n.Point(Math.round(x), Math.round(y)));
      }
      // Same down/up pair as pressBurst, so a single click is no slower than one
      // press of a burst.
      if (fast) {
        noteSynth(buttonId, 'down');
        await fast.mouse.pressButton(button);
        noteSynth(buttonId, 'up');
        await fast.mouse.releaseButton(button);
        return;
      }
      // `n.mouse.click` is a single down+up behind one call, but the hook still
      // reports two separate events, so both echoes must still be noted.
      noteSynth(buttonId, 'down');
      await n.mouse.click(button);
      noteSynth(buttonId, 'up');
    },

    async typeText(text) {
      const n = requireNut();
      if (!text) return;
      await n.keyboard.type(String(text));
    },

    /**
     * Press and HOLD any button, keyboard key OR mouse button.
     *
     * The two vocabularies are distinct (see shared/buttons.js), so a "press N
     * times" block that happens to hold a mouse button must still perform a real
     * press. Dispatching here - rather than assuming everything is a key - is
     * what stops "Not a key: mouse:1" at run time.
     */
    async keyDown(buttonId) {
      requireNut();
      const target = resolveTarget(buttonId);
      if (target.isMouse) held.mouse.add(buttonId);
      else held.keys.add(buttonId);
      await downTarget(target);
    },

    async keyUp(buttonId) {
      requireNut();
      const target = resolveTarget(buttonId);
      if (target.isMouse) held.mouse.delete(buttonId);
      else held.keys.delete(buttonId);
      await upTarget(target);
    },

    /**
     * Press a button N times as fast as the OS will physically allow, WITHOUT
     * the per-call `setTimeout` that caps nut-js at ~90 events/second.
     *
     * `gapMs` is the PERIOD between clicks, which is what a "clicks per second"
     * tool has to mean: "100 clicks, 1ms gap" finishes in ~100ms, not in
     * 100 x 1ms of extra delay on top of the click cost.
     *
     * Pacing uses absolute deadlines rather than sleeping a fixed amount each
     * time, so the time the native call itself takes is absorbed into the gap
     * instead of accumulating on top of it. That is what makes the requested rate
     * the rate you actually get.
     *
     *   gapMs === 0 -> every press is dispatched back to back, so a 0ms gap
     *                   really does mean "as fast as possible" rather than the
     *                   ~11ms the OS timer would have imposed. It is bounded by
     *                   the native call cost (~0.35ms), not by any timer.
     *
     * The press/release PAIR is never split by the gap: a click is down then up
     * back to back. The gap sits between clicks, which is what "N times with X
     * ms gap" means.
     *
     * No ActionGate slot is taken per press: the native call itself already costs
     * ~0.35ms, so the OS rate-limits the burst, and charging the gate's 1ms floor
     * on top would make a 0ms gap SLOWER than a 1ms one (the floor and the gap
     * would stack). `LIMITS.MIN_ACTION_GAP_MS` remains the floor for every other
     * kind of action.
     *
     * @param {string} buttonId
     * @param {number} count
     * @param {number} gapMs
     * @param {object} [opts]
     * @param {() => boolean} [opts.shouldStop] abort the burst partway through
     * @param {(ms:number)=>void} [opts.spinGap] injectable spin (tests)
     * @param {(ms:number, o?:object)=>Promise<void>} [opts.preciseSleep] long-gap wait (tests)
     * @param {() => Promise<void>} [opts.yieldToEventLoop] injectable yield (tests)
     * @return {Promise<{ pressed: number, aborted: boolean, elapsedMs: number }>}
     */
    async pressBurst(buttonId, count, gapMs, opts) {
      requireNut();
      opts = opts || {};
      const target = resolveTarget(buttonId);
      const spin = opts.spinGap || spinGap;
      const precise = opts.preciseSleep || preciseSleep;
      const yieldToLoop = opts.yieldToEventLoop || yieldToEventLoop;
      const n = Math.max(0, Math.floor(Number(count) || 0));
      const period = Math.max(0, Number(gapMs) || 0);
      let pressed = 0;

      // Absolute deadlines: click i is due at start + i*period. Whatever the
      // native call costs is absorbed, so the AVERAGE rate matches the request
      // instead of drifting slower with every press.
      const startedAt = process.hrtime.bigint();
      const nsPerMs = 1000000n;

      for (let i = 0; i < n; i++) {
        if (opts.shouldStop && opts.shouldStop()) break;

        if (i > 0 && period > 0) {
          const dueAt = startedAt + BigInt(Math.round(i * period)) * nsPerMs;
          let remainingMs = Number(dueAt - process.hrtime.bigint()) / 1e6;
          if (remainingMs > 0) {
            // Short waits spin (sub-ms accurate). Long waits must NOT spin: a
            // 500ms spin would block the event loop, so Stop would not land and
            // the UI would appear frozen.
            if (remainingMs <= SPIN_LIMIT_MS) spin(remainingMs);
            else await precise(remainingMs, { shouldStop: opts.shouldStop });
          }
        }

        await downTarget(target);
        await upTarget(target);
        pressed++;

        // The native calls resolve as microtasks, so a long burst would never
        // reach the event loop's timer phase and Stop / IPC would starve. A
        // setImmediate every BURST_YIELD_EVERY presses costs ~0.01ms and keeps
        // the app responsive without measurably slowing the burst.
        if (pressed % BURST_YIELD_EVERY === 0) await yieldToLoop();
      }

      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      return { pressed, aborted: pressed < n, elapsedMs };
    },

    /** Cursor position in the SAME coordinate space macros use. */
    async getCursorPosition() {
      const n = requireNut();
      const p = await n.mouse.getPosition();
      return { x: p.x, y: p.y };
    },

    async screenSize() {
      const n = requireNut();
      return { width: await n.screen.width(), height: await n.screen.height() };
    },

    /**
     * Release anything still held. Called on Stop / shutdown so a macro that was
     * interrupted mid-hold can never leave a key stuck down.
     */
    async releaseAll() {
      if (!available) return;
      for (const id of Array.from(held.keys)) {
        try {
          noteSynth(id, 'up');
          if (fast) await fast.keyboard.releaseKey(buttons.toNutKey(id));
          else await nut.keyboard.releaseKey(buttons.toNutKey(id));
        } catch (err) {
          log('warn', 'failed to release ' + id + ': ' + err.message);
        }
        held.keys.delete(id);
      }
      for (const id of Array.from(held.mouse)) {
        try {
          noteSynth(id, 'up');
          if (fast) await fast.mouse.releaseButton(buttons.toNutButton(id));
          else await nut.mouse.releaseButton(buttons.toNutButton(id));
        } catch (err) {
          log('warn', 'failed to release mouse button ' + id + ': ' + err.message);
        }
        held.mouse.delete(id);
      }
    },

    /** One-shot pixel read via nut-js. Slow (~250ms) - PixelService is preferred. */
    async slowPixelRead(x, y) {
      const n = requireNut();
      const img = await n.screen.grabRegion(new n.Region(Math.round(x), Math.round(y), 1, 1));
      // nut returns BGRA when colorMode is BGR (its default).
      const d = img.data;
      return { r: d[2], g: d[1], b: d[0], a: d.length > 3 ? d[3] : 255 };
    },

    diagnostics() {
      return {
        available,
        reason,
        autoDelayMs: available ? nut.mouse.config.autoDelayMs : null,
        mouseSpeed: available ? nut.mouse.config.mouseSpeed : null,
        heldKeys: Array.from(held.keys),
        heldMouse: Array.from(held.mouse),
        // Whether the high-rate path bypasses nut-js's setTimeout-based sleep.
        fastPath: Boolean(fast),
      };
    },
  };
}

module.exports = { createInputService };

