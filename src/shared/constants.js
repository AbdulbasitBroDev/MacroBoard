/**
 * MacroBlock - shared constants
 *
 * UMD wrapper: the same file is consumed by
 *   - the Electron main process  -> require('.../shared/constants.js')
 *   - the Electron renderer      -> <script src="../shared/constants.js"> (window.MB.constants)
 *   - the Node test suite        -> require
 *
 * There is deliberately no build step in this project.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MB = root.MB || {};
    root.MB.constants = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Hard safety limits enforced by the execution engine.
   *
   * These exist so a mistyped value (or a "no-wait" loop) cannot flood the OS
   * with input events or wedge the app. `forever` slots bypass the count cap by
   * design, but they still respect the minimum inter-action gap below.
   */
  var LIMITS = {
    /** Minimum delay enforced between ANY two physical input actions (ms). */
    MIN_ACTION_GAP_MS: 1,
    /** Hard cap for `repeat N times` when N is a plain number. */
    MAX_REPEAT_COUNT: 100000,
    /**
     * Hard cap for a `repeat until` loop.
     *
     * Separate from MAX_REPEAT_COUNT on purpose, and much lower. A counted
     * `repeat 100000` is a deliberate thing the user typed and can see. A
     * `repeat until <condition>` is expected to stop on its own, so if it has
     * run this many times the condition is never going to become true and the
     * macro is wedged - better to fail loudly and name the condition than to
     * occupy a slot forever. `repeat forever` is deliberately NOT capped: asking
     * for it forever is unambiguous.
     */
    MAX_CONDITION_LOOP_ITERATIONS: 100000,
    /** Hard cap for press count when the slot holds a plain number. */
    MAX_PRESS_COUNT: 10000,
    /** Hard cap for hold/press duration and wait duration (1 hour). */
    MAX_DURATION_MS: 3600000,
    /** Hard cap for the inter-press gap between repeats of a single key. */
    MAX_GAP_MS: 60000,
    /** Hard cap for a smooth relative mouse move duration. */
    MAX_MOVE_MS: 60000,
    /** Maximum nesting depth for `run another macro` subroutine calls. */
    MAX_MACRO_DEPTH: 10,
    /** Longest `wait` the engine will accept (identical to MAX_DURATION_MS). */
    MAX_WAIT_MS: 3600000,
    /** Chooser pages: upper bound (keeps the block UI sane). */
    MAX_CHOOSER_PAGES: 24,
    /** Chooser pages: starting count when the block is dropped in. */
    MIN_CHOOSER_PAGES: 2,
    /** Marquee-select threshold in px before a canvas drag counts as a selection. */
    MARQUEE_THRESHOLD_PX: 4,
    /**
     * "Wait until window exists" - how often to re-check, and the bounds on it.
     *
     * The floor is not arbitrary: a live query against a resident PowerShell
     * measured ~10-16ms, so checking more often than every 50ms mostly burns
     * CPU. The helper process is started lazily and torn down when idle, so the
     * FIRST check of a session also pays ~1s of PowerShell startup - which is
     * why the very first check happens immediately rather than after an interval.
     */
    WINDOW_POLL: {
      DEFAULT_MS: 250,
      MIN_MS: 50,
      MAX_MS: 5000,
    },
  };

  /** WindowService, for the tooltip and the diagnostics dump. */
  var WINDOW = {
    /** How long the PowerShell helper may take to start before we give up. */
    READY_TIMEOUT_MS: 10000,
    /** How long one window query may take before it counts as failed. */
    QUERY_TIMEOUT_MS: 5000,
    /** The helper is killed after this long with no query. */
    IDLE_SHUTDOWN_MS: 30000,
    /** Measured cost of a query against a resident helper, for honest text. */
    MEASURED_QUERY_MS: 16,
    /** Measured one-off cost of starting the helper. */
    MEASURED_STARTUP_MS: 1000,
    /** Default "give up waiting for this window" time, in SECONDS (block units). */
    DEFAULT_WAIT_SECONDS: 8,
    MAX_WAIT_SECONDS: 86400,
  };

  /**
   * Scroll wheel geometry.
   *
   * Windows reports one wheel notch as WHEEL_DELTA (120), and that is the only
   * conversion available: the input library scrolls in NOTCHES, not pixels. So a
   * "px" amount is really "px / 120 notches", and the true distance the content
   * moves is decided by the app being scrolled - a browser and a game disagree.
   * Kept here so the conversion is in one place and the tooltip can be honest.
   */
  var SCROLL = {
    PX_PER_NOTCH: 120,
    DEFAULT_PX: 360,
    MIN_PX: 1,
    MAX_PX: 12000,
    /**
     * Minimum gap between wheel clicks, in ms.
     *
     * NOT a politeness setting. Apps COALESCE rapid wheel events rather than
     * queueing them: 100 clicks fired back to back moved a real page ~20px, i.e.
     * one notch. Below roughly this rate the target app stops seeing the events at
     * all, and the macro silently does the wrong thing.
     */
    MIN_CLICK_GAP_MS: 12,
    DEFAULT_MS: 0,
    MAX_MS: 10000,
    UP: 'up',
    DOWN: 'down',
  };

  /**
   * Pixel-trigger polling.
   *
   * HONEST NOTE, and the number here matters: reading a screen pixel requires
   * capturing the screen into a buffer first. Electron's desktopCapturer does a
   * full-desktop grab, MEASURED AT ROUGHLY 117ms on the development machine -
   * not the 40-90ms an earlier version of this file claimed, which turned out to
   * be a guess that nobody had checked.
   *
   * That measured cost is the real limit, not MIN_POLL_MS. A poll interval
   * below it does not mean a faster poll: it means the same poll, started again
   * the moment the previous capture finished, plus wasted CPU. The engine
   * therefore polls capture-then-wait rather than on a fixed timer, and the UI
   * shows the MEASURED interval while armed so the block's number is not a lie.
   */
  var PIXEL = {
    DEFAULT_POLL_MS: 100,
    MIN_POLL_MS: 50,
    MAX_POLL_MS: 2000,
    /** Colour match tolerance in 0-255 per channel. 0 = exact match. */
    DEFAULT_TOLERANCE: 0,
    /**
     * What one capture measured, in ms. Used only for advisory messages - the
     * real number always comes from the running watch's own stats, because this
     * machine is not necessarily yours.
     */
    MEASURED_CAPTURE_MS: 117,
  };

  /** Colours used for the dark "premium" theme + block categories. */
  var COLOURS = {
    background: '#0d0f16',
    surface: '#151824',
    surfaceAlt: '#1c2030',
    border: '#262b3d',
    text: '#e6e9f2',
    textDim: '#8f97ad',
    accent: '#7c5cff',
    accentSoft: '#9d86ff',
    success: '#2fd07f',
    warning: '#ffb340',
    danger: '#ff5d6c',
    idle: '#5b6379',
  };

  /** Toolbox category -> block colour + css class suffix. */
  var CATEGORIES = {
    START: { name: 'Start', colour: '#ff6b9d' },
    MOUSE: { name: 'Mouse', colour: '#4dabf7' },
    KEYBOARD: { name: 'Keyboard', colour: '#38d9a9' },
    CONTROL: { name: 'Control', colour: '#ffa94d' },
    LOGIC: { name: 'Logic', colour: '#ff922b' },
    VALUES: { name: 'Values', colour: '#b197fc' },
  };

  /**
   * Sentinel discriminators for numeric "function chips".
   *
   * A numeric slot compiles to exactly one of these shapes:
   *   { kind: 'number',  value: 250 }
   *   { kind: 'forever' }
   *   { kind: 'range',   min: 100, max: 500 }
   *
   * There is deliberately no `expr` kind. A slot that held a computed value
   * only existed to serve the math blocks, which were removed: every field that
   * would carry real data is a plain field, so there was nothing to compute
   * from. Logic blocks output `Boolean` and belong in an `if` condition, not in
   * a numeric socket - so the two families are cleanly separate.
   */
  var SLOT = {
    NUMBER: 'number',
    FOREVER: 'forever',
    RANGE: 'range',
    /** How a slot behaves when it resolves: a step count or a millisecond span. */
    COUNT: 'count',
    DURATION: 'duration',
  };

  /** Possible states of the engine / app, shown in the status pill. */
  var RUN_STATE = {
    IDLE: 'idle',
    RUNNING: 'running',
    ARMED: 'armed',
    RECORDING: 'recording',
    ERROR: 'error',
  };

  /**
   * Step `type` discriminators for the compiled step list.
   *
   * Order and meaning are append-only: an engine that meets a type it does not
   * recognise raises a clear error (see engine.js) rather than mis-reading it,
   * so adding one here cannot silently change how an older macro behaves.
   */
  var STEP = {
    WAIT: 'wait',
    MOVE_TO: 'moveTo',
    MOVE_BY: 'moveBy',
  MOVE_WITHIN: 'moveWithin',
    SCROLL: 'scroll',
    CLICK: 'click',
    TYPE_TEXT: 'typeText',
    PRESS_KEY: 'pressKey',
    HOLD_KEY: 'holdKey',
    REPEAT: 'repeat',
    AT_ONCE: 'atOnce',
    RUN_MACRO: 'runMacro',
    CHOOSER: 'chooser',
    IF: 'if',
    REPEAT_UNTIL: 'repeatUntil',
    /**
     * `break` / `continue` ARE step types, despite carrying no data.
     *
     * The obvious design - compile them to nothing, because "a step cannot know
     * which loop it is escaping" - does not work: if they emit nothing, the
     * engine has no idea a break was ever written, and every loop runs to
     * completion. The engine runs compiled step lists and nothing else, so the
     * marker has to survive compilation.
     *
     * The ambiguity is real, and it is resolved by the LOOP, not the step: each
     * loop consumes the signal for itself, so a break in a nested loop leaves
     * only that loop. That is what FLOW.BREAK is for.
     */
    BREAK: 'break',
    CONTINUE: 'continue',
    WAIT_FOR_WINDOW: 'waitForWindow',
  };

  /**
   * Control-flow signals returned by a step list, instead of exceptions.
   *
   * A `break` is a normal outcome of running a loop body, not an exceptional
   * one, and modelling it as a returned value is what makes nested loops come
   * out right: the innermost loop consumes the signal and the outer ones never
   * see it. Throwing would unwind every enclosing loop at once, which is the
   * one behaviour `break` must NOT have.
   *
   * THREE outcomes, not two, because "end this pass but keep looping" and "carry
   * on with the rest of this list" are different instructions:
   *
   *   NEXT   - run the rest of the list. The default.
   *   PASS   - stop this list, but the loop keeps going. The `continue` block.
   *   BREAK  - stop the loop. The `break` block.
   *
   * Note the names are deliberately NOT `continue`/`break` for the defaults: a
   * constant called CONTINUE that means "carry on" is exactly the confusion that
   * makes a `continue` block misread as a no-op.
   */
  var FLOW = {
    NEXT: 'next',
    PASS: 'pass',
    BREAK: 'break',
  };

  /** Start-block discriminators. */
  var START = {
    MANUAL: 'manual',
    BUTTON_COUNT: 'buttonCount',
    HOLD_BUTTON: 'holdButton',
    PIXEL: 'pixel',
    /** Re-run on a fixed interval. Overlapping runs are SKIPPED, never queued. */
    EVERY: 'every',
    /** Run once a day at a wall-clock time. */
    AT: 'at',
    /** Run when the wheel is scrolled in a direction. */
    SCROLL: 'scroll',
  };

  /**
   * Bounds for the timed start blocks.
   *
   * The floor is the important one: a sub-second timer would spin the event loop
   * for nothing and would look identical to a stuck app. Five seconds is the
   * shortest interval that is ever useful for "run this macro every so often".
   */
  var SCHEDULE = {
    MIN_INTERVAL_SECONDS: 5,
    MAX_INTERVAL_SECONDS: 86400,
    DEFAULT_INTERVAL_SECONDS: 60,
    MIN_CLOCK_HOUR: 0,
    MAX_CLOCK_HOUR: 23,
    MIN_CLOCK_MINUTE: 0,
    MAX_CLOCK_MINUTE: 59,
  };

  /** The global panic hotkey. Handled through uiohook, not globalShortcut. */
  var GLOBAL_STOP_KEY = 'F8';

  /** Version stamped into saved macro files so migrations are possible. */
  var MACRO_FORMAT_VERSION = 1;

  return {
    LIMITS: LIMITS,
    WINDOW: WINDOW,
    SCROLL: SCROLL,
    PIXEL: PIXEL,
    COLOURS: COLOURS,
    CATEGORIES: CATEGORIES,
    SLOT: SLOT,
    RUN_STATE: RUN_STATE,
    STEP: STEP,
    FLOW: FLOW,
    START: START,
    SCHEDULE: SCHEDULE,
    GLOBAL_STOP_KEY: GLOBAL_STOP_KEY,
    MACRO_FORMAT_VERSION: MACRO_FORMAT_VERSION,
  };
});

