'use strict';

/**
 * Orchestrator - the main-process brain.
 *
 * Owns the engine and the three native services, and implements the trigger
 * state machines that sit around the engine:
 *
 *   manual      -> the Run button just runs the body
 *   buttonCount -> accumulate presses of one button, run once at N, re-arm
 *   holdButton  -> loop the body while held, stop the instant it is released
 *   pixel       -> EDGE-triggered: run once when the pixel BECOMES the colour
 *
 * Everything is deliberately serialized: only one run may be in flight at a time,
 * and triggers that fire during a run are dropped rather than queued. That is what
 * stops a hold-trigger from stacking up thousands of pending runs.
 *
 * Arming is INDEPENDENT per macro: any number of macros can be armed at the same
 * time, each with its own hook listeners, pixel watch and press counters. They
 * share the single engine, so a trigger that fires while another macro is still
 * running is dropped (see runSteps) - but being armed is never exclusive.
 */

const { EventEmitter } = require('events');
const C = require('../shared/constants');
const { MacroEngine } = require('./engine/engine');

/** How long N presses may be spread over before the counter resets. */
const PRESS_WINDOW_MS = 1200;

function createOrchestrator(deps) {
  const log = deps.log || (() => {});
  const input = deps.input;
  const hook = deps.hook;
  const pixel = deps.pixel;
  const window = deps.window;
  const store = deps.store;

  const emitter = new EventEmitter();

  const engine = new MacroEngine({
    input,
    // The `if pixel is <colour>` condition reads the screen through the same
    // service the pixel TRIGGER uses, so the two cannot disagree about whether
    // a colour matches.
    pixel,
    // `wait until window titled "…" exists` reads window titles through the same
    // service the window triggers will use.
    window,
    registry: { getMacroSteps: (name) => store.getMacroSteps(name) },
    store: store.store,
    log,
  });

  const state = {
    /**
     * Every armed macro, keyed by macroId. More than one entry can be armed at a
     * time - arming macro B must never touch macro A.
     */
    arms: new Map(),
    /** The most recently armed/disarmed macro, for status text + Run Now. */
    focusId: null,
    recordRelease: null,
    recordForwarder: null,
    recordHotkey: store.getRecordHotkey(),
    recording: false,
    shortcutRelease: null,
    shortcutMacros: new Map(),
  };

  /**
   * Stable key for an arm.
   *
   * Includes the TRIGGER id, not just the macro, because a workspace may hold
   * several start blocks and every one of them is armed independently. Keying on
   * the macro alone made the second trigger silently replace the first - which is
   * exactly the bug this fixes.
   */
  function armKey(macroId, triggerId) {
    const base = String(macroId || '__unsaved__');
    return triggerId === undefined || triggerId === null || triggerId === ''
      ? base
      : base + '#' + String(triggerId);
  }

  /** Every arm key belonging to one macro. */
  function armKeysFor(macroId) {
    const prefix = armKey(macroId) + '#';
    const bare = armKey(macroId);
    const out = [];
    state.arms.forEach((_arm, key) => {
      if (key === bare || key.indexOf(prefix) === 0) out.push(key);
    });
    return out;
  }

  function focusArm() {
    return state.focusId ? state.arms.get(state.focusId) || null : null;
  }

  /** Armed if the macro has ANY trigger armed, which is what the sidebar badge means. */
  function isArmed(macroId) {
    return armKeysFor(macroId).length > 0;
  }

  function status() {
    const focus = focusArm();
    return {
      engineState: engine.state,
      running: engine.isRunning(),
      /** True when ANY macro is armed. Use armedIds to know which ones. */
      armed: state.arms.size > 0,
      armedCount: state.arms.size,
      armedIds: Array.from(state.arms.keys()),
      armedMacros: Array.from(state.arms.values()).map((a) => ({
        id: a.id,
        name: a.macroName,
        start: a.start,
        // The MEASURED interval, not the requested one. A desktop capture costs
        // 40-90ms, so "every 50ms" is really "every 50ms plus a capture" and
        // showing the requested number alone would be a lie.
        pixel: a.pixelWatch ? a.pixelWatch.stats() : null,
        // Timed macros: what was asked for, plus any ticks dropped because the
        // previous run was still going.
        schedule: a.scheduleTimer
          ? {
              everySeconds: a.start.kind === C.START.EVERY ? a.start.seconds : null,
              at: a.start.kind === C.START.AT ? a.scheduleAtLabel : null,
              skippedTicks: a.skippedTicks || 0,
            }
          : null,
      })),
      recording: state.recording,
      start: focus ? focus.start : null,
      macroName: focus ? focus.macroName : null,
      hookRunning: hook.isRunning(),
      // Whether the "sleep" switch can actually block a KEY on this machine.
      // Mouse buttons cannot be blocked by any current build, so the UI says so
      // rather than showing a switch that does nothing.
      canBlockKeys: typeof hook.blockingSupported === 'function' ? hook.blockingSupported() : false,
      degradations: {
        input: input.available ? null : input.reason,
        hook: hook.available ? null : hook.reason,
        pixel: pixel.available ? null : pixel.reason,
      },
      recordHotkey: state.recordHotkey,
      pressWindowMs: PRESS_WINDOW_MS,
    };
  }

  function emitStatus(extra) {
    emitter.emit('status', Object.assign(status(), extra || {}));
  }

  // ------------------------------------------------------------- running

  async function runSteps(steps, label, macroId) {
    if (engine.isRunning()) {
      log('warn', 'ignored a trigger while a run was already in flight (' + label + ')');
      return { skipped: true };
    }
    const result = await engine.run(steps, { label });
    emitStatus({ lastRun: result });
    if (!result.ok && result.error) emitter.emit('error', result.error.message);
    return result;
  }

  function stop(reason) {
    const wasRunning = engine.stop(reason || 'Stopped');
    // Stop halts the RUN, not the arming: an armed hold-trigger must also drop
    // its held-button loop or it would immediately start the body again.
    state.arms.forEach((arm) => {
      if (arm.holdActive) arm.holdActive = false;
    });
    if (wasRunning) {
      // Belt and braces: release anything the interrupted macro still holds.
      input.releaseAll().catch((err) => log('warn', 'releaseAll failed: ' + err.message));
    }
    emitStatus();
    return { ok: true, wasRunning };
  }

  // Global Stop is registered once and stays registered for the life of the app,
  // so it works whether or not the window is focused, and regardless of which
  // trigger is armed.
  let stopKeyRelease = null;
  function ensureGlobalStop() {
    if (stopKeyRelease || !hook.available) return;
    stopKeyRelease = hook.retain((kind, payload) => {
      if (kind !== 'keydown') return;
      if (!payload.button || payload.button.id !== 'key:' + C.GLOBAL_STOP_KEY) return;
      log('info', C.GLOBAL_STOP_KEY + ' pressed - stopping everything');
      stop('global ' + C.GLOBAL_STOP_KEY);
      disarmAll('global stop');
      if (state.recording) stopRecording('global stop');
    });
  }

  /** Release every listener/timer/watch belonging to one armed macro. */
  function teardownArm(arm) {
    // Un-register the "sleep" block FIRST. A trigger that keeps blocking the
    // key after it has been disarmed would silently break every other app on
    // the machine, so this must not be skipped on any path.
    if (arm.releaseSleep) {
      arm.releaseSleep();
      arm.releaseSleep = null;
    }
    if (arm.releaseHook) {
      arm.releaseHook();
      arm.releaseHook = null;
    }
    if (arm.pixelWatch) {
      arm.pixelWatch.stop();
      arm.pixelWatch = null;
    }
    if (arm.scheduleTimer) {
      clearTimeout(arm.scheduleTimer);
      arm.scheduleTimer = null;
    }
    arm.pixelLevelMatching = null;
    arm.pressCounts.clear();
    for (const t of arm.pressTimers.values()) clearTimeout(t);
    arm.pressTimers.clear();
    if (arm.holdActive) {
      arm.holdActive = false;
      if (engine.isRunning()) engine.stop('hold released');
    }
  }

  /**
   * Disarm ONE macro - meaning ALL of its triggers. Other macros are untouched;
   * that per-macro isolation is the whole point of the arms map.
   * @param {string} macroId pass nothing/undefined to disarm everything.
   */
  function disarm(macroId, reason) {
    if (macroId === undefined || macroId === null || macroId === '') return disarmAll(reason);

    const keys = armKeysFor(macroId);
    if (!keys.length) return { ok: true, wasArmed: false };

    let name = '';
    keys.forEach((key) => {
      const arm = state.arms.get(key);
      if (arm && !name) name = arm.macroName;
      teardownArm(arm);
      state.arms.delete(key);
      if (state.focusId === key) state.focusId = null;
    });
    state.focusId = lastArmedId();
    log('info', 'disarmed "' + name + '"' + (reason ? ' (' + reason + ')' : '') +
      (keys.length > 1 ? ' (' + keys.length + ' triggers)' : ''));
    emitStatus();
    return { ok: true, wasArmed: true };
  }

  function disarmAll(reason) {
    const ids = Array.from(state.arms.keys());
    ids.forEach((key) => {
      const arm = state.arms.get(key);
      teardownArm(arm);
      state.arms.delete(key);
      log('info', 'disarmed "' + arm.macroName + '"' + (reason ? ' (' + reason + ')' : ''));
    });
    state.focusId = null;
    emitStatus();
    return { ok: true, wasArmed: ids.length > 0, disarmed: ids };
  }

  function lastArmedId() {
    const ids = Array.from(state.arms.keys());
    return ids.length ? ids[ids.length - 1] : null;
  }

  // ------------------------------------------------------------- arming

  /**
   * Arm a trigger FOR ONE MACRO. Other macros keep whatever they had armed.
   * @param {object} start compiled start descriptor
   * @param {object[]} steps the body
   * @param {string} macroName for logs and status
   * @param {string} macroId identity of the macro being armed
   */
  /**
   * Apply the trigger's "sleep" switch by registering the block UP FRONT.
   *
   * Suppression has to be configured before the press arrives, not when we
   * notice it: a low-level Windows hook swallows an event by returning non-zero
   * from inside the hook proc, and our JS listener only runs after that has
   * already passed the event on. So this is called at arm time and released in
   * teardownArm, and there is deliberately no per-press call.
   *
   * @return {boolean} true when the block is now active
   */
  function applySleepSwitch(arm) {
    const start = arm.start;
    if (!start || !start.suppress) {
      arm.releaseSleep = null;
      return false;
    }
    const buttonId = start.button;
    if (typeof hook.canBlock === 'function' && !hook.canBlock(buttonId)) {
      arm.sleepFailed = true;
      const why =
        typeof hook.cannotBlockReason === 'function'
          ? hook.cannotBlockReason(buttonId)
          : 'This machine cannot block that input.';
      const msg =
        'The "sleep" switch is on, but "' + (buttonId || 'this button') + '" cannot be blocked here. ' +
        'It will still reach the app you are driving, as well as starting the macro.\n\n' +
        (why || '') + '\n\nTurn the switch off if you want the press to pass through anyway.';
      log('warn', msg);
      emitter.emit('error', msg);
      return false;
    }
    arm.releaseSleep = hook.armSuppress(buttonId);
    arm.sleepFailed = !arm.releaseSleep;
    return Boolean(arm.releaseSleep);
  }

  function arm(start, steps, macroName, macroId, triggerId) {
    const key = armKey(macroId, triggerId);
    // Re-arming the SAME TRIGGER replaces it. A sibling trigger in the same macro has
    // a different key, so it is left alone - which is what lets several hats coexist.
    if (state.arms.has(key)) {
      teardownArm(state.arms.get(key));
      state.arms.delete(key);
    }

    if (!start || start.kind === C.START.MANUAL) {
      // Manual start: nothing to listen for, running is a toolbar action.
      state.focusId = key;
      emitStatus();
      return { ok: true, armed: false, note: 'manual start' };
    }

    if (!hook.available) {
      const msg = 'Cannot arm: ' + hook.reason;
      log('error', msg);
      return { ok: false, reason: msg };
    }

    const record = {
      id: key,
      macroId: String(macroId || '__unsaved__'),
      triggerId: triggerId === undefined || triggerId === null ? null : String(triggerId),
      start,
      steps: steps || [],
      macroName: macroName || 'macro',
      releaseHook: null,
      pixelWatch: null,
      pixelLevelMatching: null,
      pressCounts: new Map(),
      pressTimers: new Map(),
      holdActive: false,
      holdLoopRunning: false,
      /** Releases the "sleep" block registered with the hook, if any. */
      releaseSleep: null,
      /** True when the switch is on but this button cannot be blocked. */
      sleepFailed: false,
    };

    state.arms.set(key, record);
    state.focusId = key;

    if (start.kind === C.START.BUTTON_COUNT) armButtonCount(record);
    else if (start.kind === C.START.HOLD_BUTTON) armHold(record);
    else if (start.kind === C.START.SCROLL) armScroll(record);
    else if (start.kind === C.START.EVERY) armEvery(record);
    else if (start.kind === C.START.AT) armAt(record);
    else if (start.kind === C.START.PIXEL) {
      const result = armPixel(record);
      if (!result.ok) {
        // The watch could not start - do not leave a half-armed entry behind.
        teardownArm(record);
        state.arms.delete(key);
        emitStatus();
      }
      return result;
    }

    ensureGlobalStop();
    log('info', 'armed: ' + start.kind + ' for "' + record.macroName + '"');
    emitStatus();
    return { ok: true, armed: true, id: key };
  }

  function shortcutMatches(chord, down) {
    return chord.length > 0 && chord.length === down.size && chord.every((id) => down.has(id));
  }

  function activateShortcutMacro(macro) {
    if (!macro.start || macro.start.kind === C.START.MANUAL) {
      runSteps(macro.steps || [], 'shortcut: ' + macro.name, macro.id)
        .catch((err) => log('error', err.message));
      return;
    }
    const result = arm(macro.start, macro.steps, macro.name, macro.id);
    if (!result.ok) log('error', result.reason);
  }

  /** Only ever disarms THIS macro, so other macros stay armed. */
  function deactivateShortcutMacro(macro) {
    // isArmed, not a bare has(): with several triggers per macro there may be no
    // arm under the bare key, yet the macro is still armed.
    if (!isArmed(macro.id)) return false;
    const key = armKey(macro.id);
    if (state.focusId === key && engine.isRunning()) stop('shortcut disarm');
    disarm(key, 'shortcut');
    return true;
  }

  function ensureShortcutListener() {
    if (state.shortcutRelease || !hook.available || !state.shortcutMacros.size) return;
    const down = new Set();
    let fired = false;
    state.shortcutRelease = hook.retain((kind, payload) => {
      if (!payload.button || !payload.button.id || payload.button.id.indexOf('key:') !== 0) return;
      const id = payload.button.id;
      if (kind === 'keyup') {
        down.delete(id);
        if (!down.size) fired = false;
        return;
      }
      if (kind !== 'keydown' || down.has(id)) return;
      down.add(id);
      if (fired) return;

      for (const macro of state.shortcutMacros.values()) {
        const config = macro.shortcuts;
        const armMatch = shortcutMatches(config.arm || [], down);
        const disarmMatch = config.mode === 'separate' && shortcutMatches(config.disarm || [], down);
        if (!armMatch && !disarmMatch) continue;
        fired = true;
        // "Active" is per macro now: chord A toggles macro A only.
        const active = isArmed(macro.id);
        if (disarmMatch && active) deactivateShortcutMacro(macro);
        else if (armMatch && active) {
          if (config.mode !== 'separate') deactivateShortcutMacro(macro);
        } else if (armMatch) activateShortcutMacro(macro);
        return;
      }
    });
  }

  function configureShortcuts(config, start, steps, macroName, macroId) {
    const id = String(macroId || '__active__');
    if (!config || !Array.isArray(config.arm) || !config.arm.length) {
      state.shortcutMacros.delete(id);
    } else {
      state.shortcutMacros.set(id, {
        id,
        name: macroName || 'macro',
        start: start || null,
        steps: steps || [],
        shortcuts: config,
      });
    }
    if (!state.shortcutMacros.size && state.shortcutRelease) {
      state.shortcutRelease();
      state.shortcutRelease = null;
    } else {
      ensureShortcutListener();
    }
    emitStatus();
    return { ok: true, configured: state.shortcutMacros.has(id) };
  }

  function configureShortcutMacros(macros) {
    state.shortcutMacros.clear();
    (Array.isArray(macros) ? macros : []).forEach((macro) => {
      if (!macro || !macro.id || !macro.shortcuts || !Array.isArray(macro.shortcuts.arm) || !macro.shortcuts.arm.length) return;
      state.shortcutMacros.set(String(macro.id), {
        id: String(macro.id),
        name: macro.name || 'macro',
        start: macro.start || null,
        steps: Array.isArray(macro.steps) ? macro.steps : [],
        shortcuts: macro.shortcuts,
      });
    });
    if (!state.shortcutMacros.size && state.shortcutRelease) {
      state.shortcutRelease();
      state.shortcutRelease = null;
    } else {
      ensureShortcutListener();
    }
    return { ok: true, configured: state.shortcutMacros.size };
  }

  // ---------------------------------------------------- timed start blocks
  //
  // Both use a self-rescheduling setTimeout rather than setInterval, for two
  // reasons: a run longer than the interval cannot queue up behind itself, and
  // the next fire time is measured from when the timer actually fires rather
  // than from a fixed grid that drifts.
  //
  // Overlap policy is SKIP, as specified. A tick that arrives while a run is in
  // flight is dropped and logged; the next free tick starts it again. There is no
  // backlog by construction, because at most one timer exists per armed macro.

  function fireScheduled(arm, label) {
    if (state.arms.get(arm.id) !== arm) return;
    if (engine.isRunning()) {
      arm.skippedTicks = (arm.skippedTicks || 0) + 1;
      log('info', 'skipped ' + label + ' tick for "' + arm.macroName + '" - the previous run is still going');
      return;
    }
    arm.skippedTicks = 0;
    runSteps(arm.steps, label).catch((err) => log('error', err.message));
  }

  /**
   * Shortest interval the `every` block will honour.
   *
   * Overridable only through deps, so the tests can drive real timers in
   * milliseconds instead of waiting out the real five-second floor.
   */
  const MIN_SCHEDULE_SECONDS = deps.minScheduleSeconds || C.SCHEDULE.MIN_INTERVAL_SECONDS;

  function armEvery(arm) {
    const seconds = Math.max(
      MIN_SCHEDULE_SECONDS,
      Math.min(C.SCHEDULE.MAX_INTERVAL_SECONDS, Number(arm.start.seconds) || C.SCHEDULE.DEFAULT_INTERVAL_SECONDS)
    );
    const ms = seconds * 1000;
    arm.scheduleEveryMs = ms;
    arm.scheduleTimer = setTimeout(function tick() {
      arm.scheduleTimer = null;
      fireScheduled(arm, 'every ' + seconds + 's');
      if (state.arms.get(arm.id) !== arm) return;
      arm.scheduleTimer = setTimeout(tick, ms);
    }, ms);
    if (arm.scheduleTimer.unref) arm.scheduleTimer.unref();
  }

  function armAt(arm) {
    const hour = Math.max(C.SCHEDULE.MIN_CLOCK_HOUR, Math.min(C.SCHEDULE.MAX_CLOCK_HOUR, Number(arm.start.hour) || 0));
    const minute = Math.max(C.SCHEDULE.MIN_CLOCK_MINUTE, Math.min(C.SCHEDULE.MAX_CLOCK_MINUTE, Number(arm.start.minute) || 0));

    /** Milliseconds from `now` until the next occurrence of this wall-clock time. */
    function msUntilNext(now) {
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
      return next.getTime() - now.getTime();
    }

    // setTimeout's 32-bit delay limit is ~24.8 days, and the longest wait here is
    // under 24h, so a single timer is safe - but clamp anyway so a bad clock
    // field cannot turn into an immediate-fire loop.
    const wait = Math.max(1000, Math.min(msUntilNext(new Date()), 2147483647));
    arm.scheduleAtLabel = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');

    arm.scheduleTimer = setTimeout(function tick() {
      arm.scheduleTimer = null;
      fireScheduled(arm, 'at ' + arm.scheduleAtLabel);
      if (state.arms.get(arm.id) !== arm) return;
      arm.scheduleTimer = setTimeout(tick, Math.max(1000, Math.min(msUntilNext(new Date()), 2147483647)));
    }, wait);
    if (arm.scheduleTimer.unref) arm.scheduleTimer.unref();
  }

  /**
   * The wheel trigger.
   *
   * EDGE-triggered, deliberately. One flick of a wheel delivers a burst of a
   * dozen or more events, and a level trigger would run the macro a dozen times
   * for a single gesture - or flood the engine until every tick is skipped. So
   * it fires on the FIRST event of a gesture and stays quiet until the wheel has
   * been still for SCROLL_GESTURE_END_MS.
   */
  const SCROLL_GESTURE_END_MS = 400;

  function armScroll(arm) {
    const wantUp = arm.start.direction === C.SCROLL.UP;
    let gestureOpen = false;
    let quietTimer = null;

    arm.releaseHook = hook.retain((kind, payload) => {
      if (kind !== 'wheel') return;
      if (!payload) return;

      // uiohook's `direction` is the AXIS (3 = vertical, 4 = horizontal), not the
      // up/down sense, and `amount` is a magnitude that is not reliably signed.
      // The signed value is `rotation`, so that is what decides the direction.
      if (payload.direction !== undefined && payload.direction !== 3) return;

      const signed = typeof payload.rotation === 'number' && payload.rotation !== 0 ? payload.rotation : payload.amount;
      if (typeof signed !== 'number' || signed === 0) return;

      // uiohook's `rotation` is POSITIVE when the wheel goes DOWN. Confirmed on real
      // hardware: with the sign the other way round, "when scrolled up" fired on
      // a downward scroll.
      const isUp = signed < 0;
      if (arm.sawRawWheel === undefined) {
        arm.sawRawWheel = true;
        log('info', 'wheel trigger: first raw wheel ' + JSON.stringify({ amount: payload.amount, rotation: payload.rotation, direction: payload.direction }));
      }
      if (isUp !== wantUp) return;

      if (gestureOpen) {
        // Still within one gesture: just push the quiet deadline out.
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(close, SCROLL_GESTURE_END_MS);
        if (quietTimer.unref) quietTimer.unref();
        return;
      }

      gestureOpen = true;
      runSteps(arm.steps, 'trigger: scroll ' + arm.start.direction).catch((err) => log('error', err.message));
      quietTimer = setTimeout(close, SCROLL_GESTURE_END_MS);
      if (quietTimer.unref) quietTimer.unref();
    });

    function close() {
      gestureOpen = false;
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
    }

    // The trigger must die with the arm, so teardownArm cannot leave a timer
    // holding a closure over a disarmed macro.
    const release = arm.releaseHook;
    arm.releaseHook = () => {
      close();
      release();
    };
  }

  /**
   * Run every armed timed macro's "will it fire soon?" question for the
   * diagnostics dump, so a schedule that is silently never firing is visible.
   */
  function scheduleDiagnostics() {
    const out = [];
    state.arms.forEach((arm) => {
      if (!arm.scheduleTimer) return;
      out.push({
        macroId: arm.id,
        macroName: arm.macroName,
        kind: arm.start.kind,
        everySeconds: arm.start.kind === C.START.EVERY ? arm.start.seconds : undefined,
        at: arm.start.kind === C.START.AT ? arm.scheduleAtLabel : undefined,
        skippedTicks: arm.skippedTicks || 0,
      });
    });
    return out;
  }

  function armButtonCount(arm) {
    const start = arm.start;
    const targetId = start.button;
    applySleepSwitch(arm);
    const needed = start.count && start.count.kind === 'forever' ? 1 : Math.max(1, start.count.value);
    arm.pressCounts.set(targetId, 0);

    arm.releaseHook = hook.retain((kind, payload) => {
      if (kind !== 'keydown' && kind !== 'mousedown') return;
      if (!payload.button || payload.button.id !== targetId) return;
      // A macro that presses the very button being counted would otherwise tick
      // its own counter - `when RMB pressed 3 times` completing on its own runs.
      if (input.takeEcho && input.takeEcho(payload.button.id, 'down')) return;

      const current = (arm.pressCounts.get(targetId) || 0) + 1;
      arm.pressCounts.set(targetId, current);

      const old = arm.pressTimers.get(targetId);
      if (old) clearTimeout(old);

      if (current >= needed) {
        arm.pressCounts.set(targetId, 0);
        arm.pressTimers.delete(targetId);
        log('info', 'trigger fired (' + targetId + ' x' + needed + ') for "' + arm.macroName + '"');
        runSteps(arm.steps, 'trigger: ' + targetId).catch((err) => log('error', err.message));
      } else {
        // N presses must land reasonably close together to count as ONE gesture;
        // otherwise a stray press an hour later would finish the count.
        arm.pressTimers.set(
          targetId,
          setTimeout(() => {
            arm.pressCounts.set(targetId, 0);
            arm.pressTimers.delete(targetId);
          }, PRESS_WINDOW_MS)
        );
      }
    });
  }

  function armHold(arm) {
    const targetId = arm.start.button;
    applySleepSwitch(arm);
    arm.releaseHook = hook.retain((kind, payload) => {
      if (!payload.button || payload.button.id !== targetId) return;
      // Our own injected press/release comes back through the hook. Acting on it
      // would stop the run the injection was meant to feed - `while holding RMB:
      // press RMB forever` died after one press because of exactly this.
      const echoKind = kind === 'keydown' || kind === 'mousedown' ? 'down' : 'up';
      if (input.takeEcho && input.takeEcho(payload.button.id, echoKind)) return;
      if (kind === 'keydown' || kind === 'mousedown') {
        if (arm.holdActive) return;
        arm.holdActive = true;
        runHoldLoop(arm).catch((err) => log('error', 'hold loop failed: ' + err.message));
      } else if (kind === 'keyup' || kind === 'mouseup') {
        if (!arm.holdActive) return;
        arm.holdActive = false;
        log('info', 'hold released - stopping');
        engine.stop('button released');
        emitStatus();
      }
    });
  }

  /**
   * Re-runs the body back to back for as long as the button is held.
   * The engine runs ONE macro at a time, so if another armed macro is already
   * running this loop waits its turn instead of fighting over the input gate.
   */
  async function runHoldLoop(arm) {
    if (arm.holdLoopRunning) return;
    arm.holdLoopRunning = true;
    try {
      while (arm.holdActive && state.arms.get(arm.id) === arm) {
        if (engine.isRunning()) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        await engine.run(arm.steps, { label: 'hold' });
      }
    } finally {
      arm.holdLoopRunning = false;
      emitStatus();
    }
  }

  /**
   * The pixel trigger.
   *
   * EDGE behaviour: fire when the pixel BECOMES the colour, then re-arm.
   * Level behaviour (fire every poll while it stays that colour) would flood the
   * engine, so it is deliberately not what this does - use an `if pixel is`
   * block for that.
   *
   * WHY THERE IS ONLY ONE POLLER HERE
   * --------------------------------
   * This used to run two: `pixel.watch()`, plus a `setInterval` "level tracker"
   * that read the same pixel to decide whether a rising edge had happened. They
   * raced. When the level tracker happened to finish first it set the level to
   * "matching", and then the watcher's own match for the very same pixel was
   * discarded as a duplicate - so a macro armed on an already-correct pixel
   * would NEVER fire, and no error would be shown to explain why. One read, one
   * decision: the watcher's `onSample` is the single source of both the level
   * and the edge.
   */
  function armPixel(arm) {
    const start = arm.start;
    if (!pixel.available) {
      const msg = 'Cannot arm the pixel trigger: ' + pixel.reason;
      log('error', msg);
      return { ok: false, reason: msg };
    }
    const target = pixel.hexToRgb(start.colour);
    if (!target) {
      // Checked HERE rather than left to pixel.watch, which reports it through
      // an 'error' event. An EventEmitter 'error' with no listener throws, so
      // leaving it there would make arm() throw instead of returning a clean
      // refusal the UI can show.
      const msg = 'The pixel trigger has an invalid colour "' + start.colour + '".';
      log('error', msg);
      return { ok: false, reason: msg };
    }
    /**
     * "A new edge is available."
     *
     * Starts TRUE on purpose. The common case is: sample the colour with the
     * eyedropper, then arm - at which point the pixel is ALREADY correct and no
     * transition is ever going to happen. Waiting for one would mean the macro
     * never runs, which is exactly the bug that was reported.
     *
     * It is set back to TRUE when the pixel stops matching, and consumed by the
     * next match. One flag, one meaning, no counter to get out of step.
     */
    arm.pixelEdgePending = true;

    arm.pixelWatch = pixel.watch({
      x: start.x,
      y: start.y,
      colour: start.colour,
      tolerance: start.tolerance,
      pollMs: start.pollMs,
      onSample: ({ matched, res }) => {
        // Guards against a late callback from a watch that has since been
        // disarmed, which would otherwise re-arm a dead macro.
        if (state.arms.get(armKey(arm.id)) !== arm) return;
        if (!matched) {
          arm.pixelEdgePending = true;
          return;
        }
        if (arm.pixelEdgePending) {
          log('debug', 'pixel (' + start.x + ',' + start.y + ') matched ' + (res && res.colour));
        }
      },
      onMatch: async (info) => {
        if (state.arms.get(armKey(arm.id)) !== arm) return;
        // The edge guard. Everything the old two-poller version tried to do with
        // a separate level tracker is this one flag.
        if (!arm.pixelEdgePending) return;
        arm.pixelEdgePending = false;
        log('info', 'pixel matched ' + info.colour + ' - running "' + arm.macroName + '"');
        try {
          await runSteps(arm.steps, 'pixel ' + start.x + ',' + start.y);
        } catch (err) {
          log('error', 'pixel macro failed: ' + err.message);
        }
      },
      onError: (err) => {
        log('error', 'pixel trigger: ' + err.message);
        emitter.emit('error', 'Pixel trigger: ' + err.message);
        // Only this macro's watch is broken; other armed macros keep running.
        disarm(arm.id, 'pixel error');
      },
    });

    ensureGlobalStop();
    log(
      'info',
      'armed pixel watch at ' + start.x + ',' + start.y + ' for ' + start.colour + ' every ' +
        arm.pixelWatch.pollMs + 'ms (' + arm.macroName + ')'
    );
    emitStatus();
    return { ok: true, armed: true, pollMs: arm.pixelWatch.pollMs, id: arm.id };
  }

  // -------------------------------------------------------- record mode

  /**
   * Start recording. Raw global events are streamed to the renderer, which owns
   * the heuristics (coalescing keystrokes into one "type text" block, snapping
   * noise-level delays to zero, ignoring mouse-move pixel spam) because it is the
   * side that can create blocks.
   *
   * @param {function} forward called with each raw event
   */
  function startRecording(forward) {
    if (!hook.available) {
      return { ok: false, reason: 'Recording needs global input detection, which is unavailable: ' + hook.reason };
    }
    if (state.recording) return { ok: true, alreadyRunning: true };
    state.recordForwarder = forward;
    const release = hook.retain((kind, payload) => {
      if (kind === 'mousemove' || kind === 'wheel') return; // noise, not recorded
      if (forward) forward({ kind, button: payload.button, x: payload.x, y: payload.y, time: payload.time });
    });

    // The configured record hotkey stops recording (it is pressed again to finish).
    let releaseHotkey = null;
    if (state.recordHotkey) {
      releaseHotkey = hook.retain((kind, payload) => {
        if (kind !== 'keydown' && kind !== 'mousedown') return;
        if (!payload.button || payload.button.id !== state.recordHotkey) return;
        stopRecording('record hotkey');
      });
    }

    state.recordRelease = () => {
      release();
      if (releaseHotkey) releaseHotkey();
    };
    state.recording = true;
    log('info', 'recording started' + (state.recordHotkey ? ' (stop with ' + state.recordHotkey + ')' : ''));
    emitStatus();
    return { ok: true };
  }

  function stopRecording(reason) {
    if (!state.recording) return { ok: true, wasRecording: false };
    if (state.recordRelease) state.recordRelease();
    state.recordRelease = null;
    state.recordForwarder = null;
    state.recording = false;
    log('info', 'recording stopped' + (reason ? ' (' + reason + ')' : ''));
    emitStatus();
    return { ok: true, wasRecording: true };
  }

  function setRecordHotkey(buttonId) {
    state.recordHotkey = store.setRecordHotkey(buttonId);
    emitStatus();
    return { ok: true, button: state.recordHotkey };
  }

  // ---------------------------------------------------- one-shot helpers

  /** Wait for the next real key/mouse press; used by the button picker modal. */
  async function capturePress(timeoutMs) {
    if (!hook.available) throw new Error(hook.reason);
    const res = await hook.listenForPress({ timeoutMs: timeoutMs || 15000 });
    return {
      buttonId: res.button.id,
      label: res.button.label,
      raw: res.button.raw,
      sim: res.button.sim,
      note: res.button.note,
      kind: res.kind,
    };
  }

  /** Wait for the next real click and return its coordinates. */
  async function captureCoordinate(timeoutMs) {
    if (!hook.available) throw new Error(hook.reason);
    return hook.pickCoordinate({ timeoutMs: timeoutMs || 15000 });
  }

  /** Wait for the next click after the app has been minimised (caller's job). */
  async function captureCoordinateWithMinimize(timeoutMs, before) {
    if (before) await before();
    const point = await captureCoordinate(timeoutMs);
    return point;
  }

  // ------------------------------------------------------------- public

  return {
    engine,
    status,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),

    runSteps,
    stop,
    arm,
    disarm,
    disarmAll,
    isArmed,
    configureShortcuts,
    configureShortcutMacros,
    ensureGlobalStop,

    /** Run the focused macro's body once, ignoring whatever triggers are armed. */
    runNow() {
      const focus = focusArm();
      if (!focus || !focus.steps.length) {
        return Promise.resolve({
          ok: false,
          error: { message: 'Nothing to run yet - add some blocks below the start block.' },
        });
      }
      return runSteps(focus.steps, 'run');
    },

    startRecording,
    stopRecording,
    setRecordHotkey,
    capturePress,
    async captureChord(timeoutMs) {
      if (!hook.available) throw new Error(hook.reason);
      const down = new Set();
      const chord = new Set();
      return new Promise((resolve, reject) => {
        let timeoutTimer = null;
        let releaseTimer = null;
        let release = null;
        const finish = (err) => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (releaseTimer) clearTimeout(releaseTimer);
          if (release) release();
          if (err) reject(err);
          else resolve(Array.from(chord));
        };
        release = hook.retain((kind, payload) => {
          if (!payload.button || !payload.button.id || payload.button.id.indexOf('key:') !== 0) return;
          const id = payload.button.id;
          if (kind === 'keydown') {
            if (releaseTimer) {
              clearTimeout(releaseTimer);
              releaseTimer = null;
            }
            down.add(id);
            chord.add(id);
          } else if (kind === 'keyup') {
            down.delete(id);
            if (chord.size && down.size === 0) releaseTimer = setTimeout(() => finish(), 180);
          }
        });
        timeoutTimer = setTimeout(() => finish(new Error('No keyboard chord was recorded.')), timeoutMs || 15000);
      });
    },
    captureCoordinate,

    /** Best-effort pixel read for the eyedropper: fast path, then slow fallback. */
    async readPixel(x, y) {
      if (pixel.available) {
        try {
          return await pixel.readPixel(x, y, { maxAgeMs: 0 });
        } catch (err) {
          log('warn', 'fast pixel read failed (' + err.message + '), trying the slow fallback');
        }
      }
      if (input.available) return pixel.readPixelSlow(x, y);
      throw new Error(pixel.reason || 'No pixel source is available.');
    },

    pixelDiagnostics() {
      return pixel.diagnostics();
    },
    pixelMatches(colourA, colourB, tolerance) {
      if (!colourA || !colourB) return false;
      const b = typeof colourB === 'string' ? pixel.hexToRgb(colourB) : colourB;
      return pixel.matches(colourA, b, tolerance);
    },

    /**
     * Every visible window except our own, for the title dropdown and the
     * diagnostics dump. Excludes this app's own window so the dropdown cannot
     * offer a title that would make a macro match itself instantly.
     */
    async listWindows() {
      if (!window || typeof window.listWindowsExcludingSelf !== 'function') {
        throw new Error((window && window.reason) || 'Window reading is unavailable.');
      }
      const list = await window.listWindowsExcludingSelf();
      // Sorted so the dropdown order is stable between reads - window order from
      // the OS is not guaranteed and a list that reshuffles is unusable.
      return list.slice().sort((a, b) => String(a.title).localeCompare(String(b.title)));
    },

    windowStatus() {
      return window && typeof window.status === 'function' ? window.status() : { available: false };
    },

    diagnostics() {
      return {
        input: input.diagnostics(),
        status: status(),
        store: store.info(),
        // A timed macro that has quietly never fired is otherwise invisible.
        schedules: scheduleDiagnostics(),
      };
    },

    shutdown() {
      disarmAll('shutdown');
      stopRecording('shutdown');
      if (stopKeyRelease) {
        stopKeyRelease();
        stopKeyRelease = null;
      }
      hook.shutdown();
      // The PowerShell window helper is a real child process. Without this it
      // would outlive the app, and it idles out on its own but only after
      // IDLE_SHUTDOWN_MS.
      if (window && typeof window.shutdown === 'function') window.shutdown();
    },
  };
}

module.exports = { createOrchestrator, PRESS_WINDOW_MS };

