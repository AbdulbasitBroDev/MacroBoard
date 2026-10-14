/**
 * MacroBoard - block catalog
 *
 * The single source of truth for every block type id used by
 *   - the block definitions     (src/blockly/blocks.js)
 *   - the toolbox               (src/renderer/js/toolbox.js)
 *   - the compiler              (src/blockly/compiler.js)
 *   - the "start block must exist" invariant (src/renderer/js/workspace.js)
 *
 * UMD so main, renderer and the test suite can all read it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MB = root.MB || {};
    root.MB.catalog = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var START = {
    RUN: 'mb_start_run',
    PRESS: 'mb_start_press',
    HOLD: 'mb_start_hold',
    PIXEL: 'mb_start_pixel',
    EVERY: 'mb_start_every',
    AT: 'mb_start_at',
    SCROLL: 'mb_start_scroll',
  };

  var MOUSE = {
    CLICK: 'mb_mouse_click',
    MOVE_TO: 'mb_mouse_move_to',
    MOVE_BY: 'mb_mouse_move_by',
  MOVE_WITHIN: 'mb_mouse_move_within',
    SCROLL: 'mb_mouse_scroll',
  };

  var KEYBOARD = {
    TYPE: 'mb_key_type',
    PRESS: 'mb_key_press',
    PRESS_TIMES: 'mb_key_press_times',
    HOLD: 'mb_key_hold',
  };

  var CONTROL = {
    WAIT: 'mb_control_wait',
    WAIT_MS: 'mb_control_wait_ms',
    REPEAT: 'mb_control_repeat',
    AT_ONCE: 'mb_control_at_once',
    RUN_MACRO: 'mb_control_run_macro',
    RANDOM_CHOOSER: 'mb_control_random_chooser',
    ORGANIZED_CHOOSER: 'mb_control_organized_chooser',
    IF: 'mb_control_if',
    REPEAT_UNTIL: 'mb_control_repeat_until',
    BREAK: 'mb_control_break',
    CONTINUE: 'mb_control_continue',
    WAIT_FOR_WINDOW: 'mb_control_wait_for_window',
  };

  var VALUE = {
    NUMBER: 'mb_value_number',
    FOREVER: 'mb_value_forever',
    RANGE: 'mb_value_range',
  };

/**
 * Logic blocks: reporters that answer true or false.
 *
 * `OPERATORS` are the six that take two numeric operands; `UNARY` take one.
 * They output Blockly's `Boolean` type, which is what stops a boolean block
 * being dropped into a number socket where it would silently read as 0/1.
 *
 * There is deliberately NO math category. Arithmetic on constants and random
 * rolls is something the `between` chip and plain numbers already cover, and
 * every field that would carry real data (coordinates, tolerance, poll
 * interval) is a plain field rather than a socket - so `(a) * (b)` had nothing
 * to multiply. It was added and removed in the same session for that reason.
 */
  var LOGIC = {
    AND: 'mb_logic_and',
    OR: 'mb_logic_or',
    NOT: 'mb_logic_not',
    EQUALS: 'mb_logic_equals',
    GREATER: 'mb_logic_greater',
    LESS: 'mb_logic_less',
    PIXEL_IS: 'mb_logic_pixel_is',
  };

  /** Every logic reporter, for tests and for the toolbox. */
  var REPORTERS = Object.keys(LOGIC).map(function (k) {
    return LOGIC[k];
  });

  /** Every start block type, in the order the UI should prefer them. */
  var START_TYPES = [START.RUN, START.PRESS, START.HOLD, START.PIXEL, START.EVERY, START.AT, START.SCROLL];

  /**
   * Block types that declare a `button` field, and whether that field is used as
   * an ACTION (must be simulatable) or a TRIGGER (anything detectable is fine).
   *
   * This is what lets the button-picker modal grey out a user's side mouse
   * buttons on action blocks with an explanation, instead of accepting them and
   * blowing up at runtime.
   */
  var BUTTON_FIELDS = {
    'mb_start_press.button': 'trigger',
    'mb_start_hold.button': 'trigger',
    'mb_mouse_click.button': 'action',
    'mb_key_press.button': 'action',
    'mb_key_press_times.button': 'action',
    'mb_key_hold.button': 'action',
    'mb_record_hotkey.button': 'trigger',
  };

  /** Start blocks and their human labels, used for the Run/Arm button. */
  var START_META = {
    mb_start_run: { label: 'Run', armLabel: 'Run', describe: 'when Run is pressed' },
    mb_start_press: { label: 'Arm', armLabel: 'Arm', describe: 'button-press trigger' },
    mb_start_hold: { label: 'Arm', armLabel: 'Arm', describe: 'hold trigger' },
    mb_start_pixel: { label: 'Arm', armLabel: 'Watch', describe: 'pixel-colour trigger' },
    // Both timers are armed, never run by hand: pressing the button should not
    // fire a schedule early.
    mb_start_every: { label: 'Arm', armLabel: 'Arm', describe: 'interval trigger' },
    mb_start_at: { label: 'Arm', armLabel: 'Arm', describe: 'daily clock trigger' },
    mb_start_scroll: { label: 'Arm', armLabel: 'Arm', describe: 'wheel-direction trigger' },
  };

  /**
   * The default workspace: a single "when Run is pressed" hat with an empty body.
   * Used on first launch and whenever the user deletes every start block.
   */
  function defaultWorkspaceState() {
    return {
      blocks: {
        languageVersion: 0,
        blocks: [
          {
            type: START.RUN,
            id: 'mb_default_start',
            x: 60,
            y: 60,
          },
        ],
      },
    };
  }

  return {
    START: START,
    MOUSE: MOUSE,
    KEYBOARD: KEYBOARD,
    CONTROL: CONTROL,
    VALUE: VALUE,
    LOGIC: LOGIC,
    REPORTERS: REPORTERS,
    START_TYPES: START_TYPES,
    BUTTON_FIELDS: BUTTON_FIELDS,
    START_META: START_META,
    defaultWorkspaceState: defaultWorkspaceState,
  };
});

