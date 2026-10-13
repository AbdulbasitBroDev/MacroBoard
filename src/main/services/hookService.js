'use strict';

/**
 * HookService - global input DETECTION (and optional suppression).
 *
 * Electron's globalShortcut cannot see arbitrary keys, cannot see mouse buttons
 * at all, and cannot distinguish key-down from key-up. Every trigger feature
 * (press-N-times, hold-to-run, "listen for a press", coordinate picking, record
 * mode and the global Stop hotkey) therefore goes through libuiohook instead.
 *
 * The hook is REF-COUNTED: it only runs while something actually needs it, so
 * MacroBlock is not silently watching every keystroke while sitting idle.
 *
 * Failure policy: if the native module will not load, `available` is false, every
 * consumer checks it, and the UI explains which features are off. The app still
 * starts.
 */

function createHookService(deps) {
  deps = deps || {};
  const log = deps.log || (() => {});
  const buttons = deps.buttons;

  /**
   * Every live registration id we handed out.
   *
   * The addon has no "clear all" call - unregisterSuppress only takes one id -
   * so shutdown walks this set. Without it, a rule registered and never
   * explicitly released (an exception mid-arm, say) would keep eating that key
   * for the rest of the OS session with nothing left to undo it.
   */
  const liveSuppressions = new Set();

  /**
   * MOUSE BUTTONS THAT ARE NEVER BLOCKED.
   *
   * This is ALL of them, and it is a capability limit rather than a policy
   * choice: the hook module in use consumes keyboard events only, and no
   * published build consumes mouse ones. Making it work would mean shipping a
   * locally compiled native addon, which is not worth a C++ toolchain for a
   * macro builder - so the switch reports the limit instead of pretending.
   *
   * Left click is doubly out of scope: even with a capable build, blocking it
   * while a trigger is armed would stop the macro's own clicks from landing.
   */
  const NEVER_BLOCK_MOUSE_BUTTONS = new Set([1, 2, 3, 4, 5]);

  let uio = null;
  let UiohookKey = null;
  let loadError = null;
  try {
    // A maintained fork of uiohook-napi that ALSO exposes real event suppression
    // for KEYS. Upstream's addon exports only start/stop/keyTap, so upstream
    // cannot swallow a press no matter what we call from JS.
    //
    // The fork's worker consumes keyboard events only, so the "sleep" switch
    // works for keys and deliberately does not apply to mouse buttons - see
    // NEVER_BLOCK_MOUSE_BUTTONS.
    // eslint-disable-next-line global-require
    const mod = require('@fainthit/uiohook-napi-suppress');
    uio = mod.uIOhook;
    UiohookKey = mod.UiohookKey;
    if (!uio) throw new Error('module loaded but uIOhook export is missing');
    if (typeof uio.registerSuppress !== 'function') {
      throw new Error('module loaded but registerSuppress is missing (no suppression support)');
    }
  } catch (err) {
    loadError = err;
    uio = null;
  }

  const available = Boolean(uio);
  const reason = available
    ? ''
    : 'Global input detection is unavailable: ' + (loadError ? loadError.message : 'unknown error') +
      '. Triggers (hold-to-run, press-N-times, listen-for-a-press, record mode) and the global ' +
      'Stop hotkey are disabled. Mouse and keyboard ACTIONS still work.';

  if (!available) log('warn', reason);

  let refCount = 0;
  let started = false;
  let bound = false;
  const listeners = new Map();
  const onceWaiters = new Set();

  function emit(kind, payload) {
    for (const fn of Array.from(listeners.values())) {
      try {
        fn(kind, payload);
      } catch (err) {
        log('error', 'hook listener threw: ' + err.message);
      }
    }
    for (const waiter of Array.from(onceWaiters)) {
      let consumed = false;
      try {
        consumed = waiter(kind, payload) === true;
      } catch (err) {
        consumed = true;
        log('error', 'hook waiter threw: ' + err.message);
      }
      if (consumed) onceWaiters.delete(waiter);
    }
  }

  function bind() {
    if (bound || !available) return;
    bound = true;
    uio.on('keydown', (e) => emit('keydown', { button: buttons.fromHookKeycode(e.keycode), x: null, y: null, raw: e, time: e.time }));
    uio.on('keyup', (e) => emit('keyup', { button: buttons.fromHookKeycode(e.keycode), x: null, y: null, raw: e, time: e.time }));
    uio.on('mousedown', (e) => emit('mousedown', { button: buttons.fromHookMouseButton(e.button), x: e.x, y: e.y, raw: e, time: e.time }));
    uio.on('mouseup', (e) => emit('mouseup', { button: buttons.fromHookMouseButton(e.button), x: e.x, y: e.y, raw: e, time: e.time }));
    uio.on('mousemove', (e) => emit('mousemove', { x: e.x, y: e.y, raw: e, time: e.time }));
    uio.on('wheel', (e) =>
    // `direction` (VERTICAL/HORIZONTAL) and `rotation` (the signed value) are BOTH
    // dropped by the old shape, which is why the wheel trigger could never tell
    // up from down. Forward them.
    emit('wheel', {
      x: e.x,
      y: e.y,
      amount: e.amount,
      direction: e.direction,
      rotation: e.rotation,
      clicks: e.clicks,
      raw: e,
      time: e.time,
    })
  );
  }

  /**
   * True when the loaded addon can genuinely swallow keyboard events.
   *
   * Checked once against the module itself rather than the enum: the fork
   * exposes registerSuppress/unregisterSuppress only when it was built with the
   * suppression patch, so a plain upstream build reports false here.
   */
  function canBlockKeyboard() {
    return Boolean(uio) && typeof uio.registerSuppress === 'function';
  }

  /**
   * Can this build swallow the given `mouse:N` button?
   *
   * Always false today - the hook module consumes keys only. Kept as a single
   * predicate so the rule lives in one place if a capable build ever appears.
   */
  function mouseBlockable() {
    return false;
  }

  /** Why mouseBlockable() said no, or null if it can. */
  function mouseBlockReason() {
    return 'Blocking mouse buttons is not supported: the input library in use can swallow ' +
      'keystrokes but not mouse clicks. The "sleep" switch works for keys.';
  }

  function ensureStarted() {    if (!available) return;
    bind();
    if (!started) {
      uio.start();
      started = true;
      log('info', 'global input hook started');
    }
  }

  function stopIfIdle() {
    if (!available) return;
    if (started && refCount <= 0 && onceWaiters.size === 0) {
      try {
        uio.stop();
      } catch (err) {
        log('warn', 'hook stop failed: ' + err.message);
      }
      started = false;
      log('info', 'global input hook stopped (nothing needs it)');
    }
  }

  return {
    available,
    reason,
    keyCodes: UiohookKey,

    isRunning() {
      return started;
    },

    /** Add a long-lived listener. Returns a release function. */
    retain(fn) {
      const id = Symbol('hook-listener');
      listeners.set(id, fn);
      refCount++;
      ensureStarted();
      return () => {
        if (!listeners.has(id)) return;
        listeners.delete(id);
        refCount--;
        stopIfIdle();
      };
    },

    /** Wait for the next event matching `kinds`. Resolves with the payload. */
    waitForEvent(kinds, opts) {
      opts = opts || {};
      if (!available) return Promise.reject(new Error(reason));
      const wanted = new Set(kinds);
      const timeoutMs = opts.timeoutMs === undefined ? 0 : opts.timeoutMs;

      return new Promise((resolve, reject) => {
        let timer = null;
        const waiter = (kind, payload) => {
          if (!wanted.has(kind)) return false;
          if (opts.filter && !opts.filter(payload)) return false;
          if (timer) clearTimeout(timer);
          resolve({ kind, payload });
          return true;
        };
        onceWaiters.add(waiter);
        ensureStarted();
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            onceWaiters.delete(waiter);
            stopIfIdle();
            reject(new Error('Timed out waiting for a ' + Array.from(wanted).join('/') + ' event.'));
          }, timeoutMs);
        }
      });
    },

    /** Convenience: wait for the next key OR mouse button press. */
    listenForPress(opts) {
      return this.waitForEvent(['keydown', 'mousedown'], opts).then((res) => ({
        kind: res.kind,
        button: res.payload.button,
        x: res.payload.x,
        y: res.payload.y,
        at: res.payload.time,
      }));
    },

    /** Convenience: wait for the next real mouse press position. */
    pickCoordinate(opts) {
      return this.waitForEvent(['mousedown'], opts).then((res) => ({
        x: res.payload.x,
        y: res.payload.y,
      }));
    },

    /**
     * Register a button as SUPPRESSED, so the focused application never sees it.
     *
     * This backs the "sleep" switch on the two button triggers.
     *
     * WHY THIS IS REGISTERED UP FRONT INSTEAD OF PER PRESS
     * -----------------------------------------------------
     * A low-level Windows hook swallows an event by returning non-zero from
     * WH_KEYBOARD_LL / WH_MOUSE_LL. That return value can ONLY be set from
     * inside the hook procedure, which runs on the hook thread BEFORE the event
     * is passed on to the target application. By the time our JS listener runs,
     * libuiohook has already called CallNextHookEx and the press has been
     * delivered - the app being driven has already seen the key.
     *
     * So the decision has to be made BEFORE the press arrives. The addon takes a
     * static list of shortcut rules, consults it on the hook thread, and marks
     * the event consumed there. We therefore register when the trigger is armed
     * and unregister when it is disarmed, and there is deliberately no
     * "suppress the press I just saw" call: that could not work.
     *
     * Matching is on keycode PLUS the exact modifier mask. Triggers here match
     * on the keycode alone, so Ctrl+Q also fires a Q trigger; to keep blocking
     * consistent with that, all 16 modifier combinations are registered.
     *
     * @param {string} buttonId canonical button id
     * @return {function(): void} release function; null when unsupported
     */
    armSuppress(buttonId) {
      if (!available) return null;

      if (buttons.isMouseId(buttonId)) {
        // Checked here as well as in canBlock(): this is the function that would
        // actually swallow the event, so the rule has to be enforced by it.
        log('warn', 'refusing to block ' + buttonId + ': ' + (mouseBlockReason() || 'not blockable'));
        return null;
      }

      const keycode = buttons.codeOf(buttonId);
      if (keycode === null || keycode === undefined) {
        log('warn', 'cannot block "' + buttonId + '": this machine reported it as a code the block list does not know.');
        return null;
      }

      // Every modifier combination, so "blocked" means the same as "triggered".
      const rules = [];
      for (let bits = 0; bits < 16; bits++) {
        rules.push({
          keycode: keycode,
          shiftKey: !!(bits & 1),
          ctrlKey: !!(bits & 2),
          altKey: !!(bits & 4),
          metaKey: !!(bits & 8),
        });
      }

      let registrationId;
      try {
        registrationId = uio.registerSuppress(rules);
      } catch (err) {
        log('warn', 'could not block ' + buttonId + ': ' + err.message);
        return null;
      }
      liveSuppressions.add(registrationId);
      log('info', 'blocking ' + buttonId + ' from the focused application while this trigger is armed');
      return () => {
        if (!liveSuppressions.delete(registrationId)) return;
        try {
          uio.unregisterSuppress(registrationId);
        } catch (err) {
          log('warn', 'could not unblock ' + buttonId + ': ' + err.message);
        }
      };
    },

    /**
     * Whether this build can genuinely swallow the given button.
     *
     * Honest per-button answer, because a switch that quietly does nothing is
     * worse than one that admits it cannot take effect.
     */
    canBlock(buttonId) {
      if (!available) return false;
      if (buttons.isMouseId(buttonId)) return mouseBlockable(buttonId);
      const keycode = buttons.codeOf(buttonId);
      return keycode !== null && keycode !== undefined;
    },

    /** Why canBlock() said no, so the message can name the actual reason. */
    cannotBlockReason(buttonId) {
      if (!available) return 'The input detection module did not load.';
      if (buttons.isMouseId(buttonId)) return mouseBlockReason(buttonId);
      return buttons.codeOf(buttonId) === null
        ? 'This machine reported that input as a code MacroBlock does not recognise.'
        : null;
    },

    /** Does this build suppress keyboard events at all? */
    blockingSupported() {
      return canBlockKeyboard();
    },

    /** Does this build also suppress mouse buttons? Always false today. */
    mouseBlockingSupported() {
      return false;
    },

    shutdown() {
      if (!available) return;
      // Drop every block first. A suppression rule that outlives the app would
      // keep eating that key system-wide, with nothing left to unregister it.
      for (const id of Array.from(liveSuppressions)) {
        try {
          uio.unregisterSuppress(id);
        } catch (err) {
          log('warn', 'could not clear a suppression rule on shutdown: ' + err.message);
        }
      }
      liveSuppressions.clear();
      try {
        if (started) uio.stop();
      } catch (err) {
        /* nothing useful to do while shutting down */
      }
      started = false;
      listeners.clear();
      onceWaiters.clear();
      refCount = 0;
    },
  };
}

module.exports = { createHookService };
