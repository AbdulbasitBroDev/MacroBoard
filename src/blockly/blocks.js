/**
 * MacroBoard - block definitions
 *
 * Everything is defined with manual `Blockly.Blocks[type] = {...}` assignment
 * rather than defineBlocksWithJsonArray, because:
 *   - the choosers need saveExtraState / loadExtraState, and
 *     defineBlocksWithJsonArray silently drops unknown keys, and
 *   - defining init() by hand lets us call our extensions directly, which is
 *     more reliable than relying on the `extensions` key being honoured.
 *
 * Loads headlessly (no DOM touched at definition time), which is what lets the
 * test suite build real workspaces and compile them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MB = root.MB || {};
    root.MB.blocks = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Give a value input a default SHADOW block, so the socket always holds a real
   * number under the hood but looks like plain text on the block.
   *
   * Two APIs exist across Blockly versions; we try the modern one and fall back.
   */
  function attachShadow(Blockly, input, state) {
    var conn = input && input.connection;
    if (!conn) return false;
    try {
      if (typeof conn.setShadowState === 'function') {
        conn.setShadowState(state);
        return true;
      }
    } catch (e) {
      /* fall through */
    }
    try {
      if (typeof conn.setShadowDom === 'function' && Blockly.utils.xml && Blockly.utils.xml.textToDom) {
        var fields = state.fields || {};
        var inner = Object.keys(fields)
          .map(function (k) {
            return '<field name="' + k + '">' + fields[k] + '</field>';
          })
          .join('');
        conn.setShadowDom(Blockly.utils.xml.textToDom('<shadow type="' + state.type + '">' + inner + '</shadow>'));
        return true;
      }
    } catch (e) {
      /* give up: the socket just starts empty */
    }
    return false;
  }

  /**
   * Default rounding step for a number field.
   *
   * Blockly's `precision` is NOT "decimal places" - it is the step the value is
   * rounded to. `precision: 1` therefore rounds 5.4 to 5 and 0.001 to 0, and
   * `precision: 3` rounds to multiples of 3 (5.4 becomes 6!). `0` means "do not
   * round", which is what time slots need: "wait 3.432 seconds" has to survive
   * the field round trip as exactly 3432ms.
   *
   * Min/max still clamp with precision 0, so the safety limits are unaffected.
   */
  var NO_ROUNDING = 0;

  function numberField(Blockly, value, opts) {
    opts = opts || {};
    var f = new Blockly.FieldNumber(
      value,
      opts.min === undefined ? -Infinity : opts.min,
      opts.max === undefined ? Infinity : opts.max,
      opts.precision === undefined ? NO_ROUNDING : opts.precision
    );
    if (opts.tooltip) f.setTooltip(opts.tooltip);
    return f;
  }

  /**
   * Append a numeric value socket with a default number shadow.
   * @return the created Input.
   */
  function numericSocket(Blockly, block, name, defaultValue, opts) {
    opts = opts || {};
    var input = block.appendValueInput(name).setCheck('Number');
    if (opts.label) input.appendField(opts.label);
    attachShadow(Blockly, input, { type: 'mb_value_number', fields: { NUM: defaultValue } });
    return input;
  }

  /**
   * Define every MacroBoard block type against a Blockly instance.
   * @param {object} Blockly
   * @param {object} deps { catalog, constants, fieldClasses }
   */
  function register(Blockly, deps) {
    var catalog = deps.catalog;
    var C = deps.constants;
    var F = deps.fieldClasses;
    var LIMITS = C.LIMITS;
    var COL = C.CATEGORIES;

    /**
     * @param {'action'|'trigger'} mode action = must be simulatable
     * @param {string} value default button id
     * @param {string} tooltip
     * @param {'key'|'mouse'|null} kind restrict the picker to one kind of input.
     *   'click' blocks must be given a mouse button; 'press'/'hold' blocks accept
     *   either, because pressing and holding a mouse button is a real operation.
     */
    function btn(mode, value, tooltip, kind) {
      return new F.FieldButtonPicker(value, undefined, {
        mode: mode,
        kind: kind || null,
        tooltip: tooltip,
        // Supplying the describer here (rather than only via the UI port) means
        // the pill shows a friendly label even in a headless test process.
        describe: deps.describeButton,
      });
    }

    function act(label, action, tooltip) {
      return new F.FieldAction(label, undefined, { action: action, tooltip: tooltip });
    }

    function num(value, opts) {
      return numberField(Blockly, value, opts);
    }

    function socket(block, name, defaultValue, opts) {
      return numericSocket(Blockly, block, name, defaultValue, opts);
    }

    /** Common shape for a start (hat) block. */
    function asStart(block, colour) {
      block.setColour(colour);
      block.setDeletable(true);
      block.setMovable(true);
      block.setInputsInline(true);
      // The theme's startHats option draws the cap; this records the intent too.
      block.hat = 'cap';
      return block;
    }

    function asAction(block, colour) {
      block.setPreviousStatement(true, null);
      block.setNextStatement(true, null);
      block.setColour(colour);
      return block;
    }

    function asValue(block, colour) {
      block.setOutput(true, 'Number');
      block.setColour(colour);
      return block;
    }

    /**
     * A reporter that answers true or false.
     *
     * The `Boolean` output type is load-bearing, not decoration: it is what
     * stops a logic block being dropped into a numeric socket (where it would
     * quietly read as 0 or 1) and what lets the `if` block's condition socket
     * accept a condition while rejecting a stray number.
     */
    function asBoolean(block, colour) {
      block.setOutput(true, 'Boolean');
      block.setColour(colour);
      return block;
    }

    // ============================================================= START

    Blockly.Blocks[catalog.START.RUN] = {
      init: function () {
        asStart(this, COL.START.colour);
        this.appendDummyInput().appendField('\u25b6  when Run is pressed');
        this.appendStatementInput('DO').appendField('do');
        this.setTooltip('The default start. Pressing Run executes the blocks below immediately.');
      },
    };

    /**
     * The "sleep" switch that both button triggers carry.
     *
     * ON (the default, and every macro saved before this existed) = the physical
     * press is passed to the rest of the system as usual, so the app you are
     * driving also sees the key. The macro runs AND the button works.
     *
     * OFF = the trigger button is treated as a pure signal: it starts the macro
     * but is never entered into the focused application, so "when X is pressed"
     * followed by "type hello" types hello and nothing else. Only the macro
     * works; the pressed button does nothing.
     *
     * Two things are deliberate here:
     *
     *   - The field NAME is still SUPPRESS (suppress == true == "sleep"), and it
     *     still serialises as the "TRUE"/"FALSE" a checkbox would. The switch
     *     subclasses FieldCheckbox precisely so saved macros load unchanged.
     *   - The default is set explicitly rather than via the constructor. The
     *     FieldCheckbox constructor's 2nd argument is a VALIDATOR, not the
     *     initial state, so passing `true` there is silently ignored and the
     *     field would ship OFF - the opposite of both the documented default and
     *     what every saved macro already does.
     */
    function triggerSleepSwitch(block) {
      const sleep = new F.FieldSwitch(true, undefined, {
        label: 'sleep',
        onTooltip:
          'sleep is OFF. The button will start the macro AND still work in the app you are ' +
          'driving. Click to turn it on and stop the button from reaching that app.',
        offTooltip:
          'sleep is ON. The button starts the macro only and is never entered into the app you ' +
          'are driving. Click to turn it off and let the button through as normal.',
      });
      block.appendDummyInput()
        .appendField(sleep, 'SUPPRESS')
        .setAlign(Blockly.RIGHT_ALIGN);
      return block;
    }

    Blockly.Blocks[catalog.START.PRESS] = {
      init: function () {
        asStart(this, COL.START.colour);
        this.appendDummyInput()
          .appendField('\u25b6  when')
          .appendField(btn('trigger', 'mouse:1', 'The key or mouse button to watch for.'), 'BUTTON')
          .appendField('is pressed');
        socket(this, 'COUNT', 1, { min: 1, max: LIMITS.MAX_PRESS_COUNT });
        this.appendDummyInput().appendField('time(s)');
        triggerSleepSwitch(this);
        this.appendDummyInput().appendField('then');
        this.appendStatementInput('DO').appendField('do');
        this.setTooltip(
          'Arms a global listener. Once the button has been pressed N times the blocks below run ' +
            'once, then it re-arms automatically until you press Stop.\n\nAny button this machine ' +
            'can detect works here, including mouse side buttons.\n\n"sleep" (on by default) leaves the ' +
            'press alone, so the button still works in the app you are driving AND the macro runs. ' +
            'Turn it off to make the button a pure trigger: only the macro runs and the press itself ' +
            'goes nowhere. Blocking works for keys only, not for mouse buttons.'
        );
      },
    };

    Blockly.Blocks[catalog.START.HOLD] = {
      init: function () {
        asStart(this, COL.START.colour);
        this.appendDummyInput()
          .appendField('\u25b6  when holding')
          .appendField(btn('trigger', 'mouse:2', 'The key or mouse button to hold down.'), 'BUTTON')
          .appendField('run');
        triggerSleepSwitch(this);
        this.appendStatementInput('DO').appendField('do');
        this.setTooltip(
          'Runs the blocks below in a continuous loop while the button is held, and stops the instant ' +
            'it is released. Re-arms automatically.\n\n"sleep" (on by default) leaves the hold alone, so ' +
            'the button still works in the app you are driving. Turn it off to make the button a pure ' +
            'trigger: only the macro runs and the press itself goes nowhere. Blocking works for keys ' +
            'only, not for mouse buttons.'
        );
      },
    };

    Blockly.Blocks[catalog.START.PIXEL] = {
      init: function () {
        asStart(this, COL.START.colour);
this.appendDummyInput()
          .appendField('▶  when pixel');
        socket(this, 'X', 0, { label: 'x' });
        socket(this, 'Y', 0, { label: 'y' });
        this.appendDummyInput().appendField(act(' ⌖ pick ', 'pickPixel', 'Pick the pixel on screen'), 'PICK');
        this.appendDummyInput()
          .appendField('becomes')
          .appendField(new F.FieldColourPicker('#ffffff'), 'COLOUR')
          .appendField(act(' ⌖ eyedrop ', 'eyedropColour', 'Read the colour under the cursor'), 'DROP');
        this.appendDummyInput().appendField('tolerance');
        socket(this, 'TOLERANCE', 0, {});
        this.appendDummyInput().appendField('poll every');
        socket(this, 'POLL', C.PIXEL.DEFAULT_POLL_MS, {});
        this.appendDummyInput().appendField('ms');
        this.appendStatementInput('DO').appendField('do');
        this.setTooltip(
          'Watches one screen pixel. When it matches the target colour the blocks below run once, then ' +
            'it re-arms.\n\n' +
            'It is an EDGE trigger: it fires when the pixel BECOMES the colour, not on every poll while ' +
            'it stays that colour. Arming it on a pixel that is already the right colour fires straight ' +
            'away. If the pixel goes red, stays red, then turns green and back to red, that second red ' +
            'fires too.\n\n' +
            'The eyedropper hides this app and samples the colour live as you move the mouse, then ' +
            'picks on Ctrl+click - or on Ctrl+Enter, which does not click at all and so cannot disturb ' +
            'the app you are sampling. Escape cancels.\n\n' +
            'PERFORMANCE - read this before going below 100ms. Checking a pixel means capturing the ' +
            'whole screen. That was measured at roughly 117ms on the machine this was built on, so the ' +
            'real interval is your number PLUS a capture: asking for 50ms gives about 170ms, and ' +
            'asking for faster cannot make it faster - it just burns CPU. While armed, the status pill ' +
            'shows the MEASURED interval. ' + C.PIXEL.MIN_POLL_MS + 'ms is the floor; ' +
            C.PIXEL.DEFAULT_POLL_MS + 'ms is the default.'
        );
      },
    };

    // ============================================================= MOUSE

    Blockly.Blocks[catalog.START.EVERY] = {
      init: function () {
        asStart(this, COL.START.colour);
this.appendDummyInput()
          .appendField('  every');
        socket(this, 'EVERY', C.SCHEDULE.DEFAULT_INTERVAL_SECONDS, {});
        this.appendDummyInput().appendField('seconds  run');
        this.appendStatementInput('DO').appendField('do');
        this.setTooltip(
          'Runs the blocks below on a timer, again and again, while MacroBoard stays open.\n\n' +
            'If a run is still going when the next tick arrives, that tick is SKIPPED rather than ' +
            'queued, so a slow macro simply runs less often instead of piling up behind itself. ' +
            'The first free tick starts it again.\n\n' +
            'Minimum ' + C.SCHEDULE.MIN_INTERVAL_SECONDS + ' seconds.'
        );
      },
    };

    Blockly.Blocks[catalog.START.AT] = {
      init: function () {
        asStart(this, COL.START.colour);
this.appendDummyInput()
          .appendField('  at');
        socket(this, 'HOUR', 9, { label: '' });
        this.appendDummyInput().appendField(':');
        socket(this, 'MINUTE', 0, { label: '' });
        this.appendDummyInput().appendField('  run');
        this.appendStatementInput('DO').appendField('do');
        this.setTooltip(
          'Runs the blocks below once a day, at that time on your local clock.\n\n' +
            'This needs MacroBoard to be OPEN at that moment - it is not a Windows scheduled task, ' +
            'so it will not wake the computer or start the app for you. If MacroBoard is closed, or ' +
            'busy with another run, that day is simply skipped.'
        );
      },
    };

    Blockly.Blocks[catalog.MOUSE.CLICK] = {
      init: function () {
        asAction(this, COL.MOUSE.colour);
        this.setInputsInline(true);
        this.appendDummyInput()
          .appendField('click')
          .appendField(btn('action', 'mouse:1', 'Only Left, Middle and Right can be simulated.', 'mouse'), 'BUTTON')
          .appendField('at');
        // x/y are sockets so a number chip can drive them. The single "pick"
        // button fills BOTH from one screen click - a second pair would be
        // redundant, not more capable.
        socket(this, 'X', 0, { label: 'x' });
        socket(this, 'Y', 0, { label: 'y' });
        this.appendDummyInput().appendField(act(' \u2316 pick ', 'pickXY', 'Pick a point on screen'), 'PICK');
        this.setTooltip('Clicks the chosen mouse button at absolute screen coordinates.');
      },
    };

    Blockly.Blocks[catalog.MOUSE.MOVE_TO] = {
      init: function () {
        asAction(this, COL.MOUSE.colour);
        this.setInputsInline(true);
        this.appendDummyInput()
          .appendField('move mouse to');
        socket(this, 'X', 0, { label: 'x' });
        socket(this, 'Y', 0, { label: 'y' });
        this.appendDummyInput().appendField(act(' \u2316 pick ', 'pickXY', 'Pick a point on screen'), 'PICK');
        this.appendDummyInput().appendField('within');
        socket(this, 'MS', 200, {});
        this.appendDummyInput().appendField('ms');
        this.setTooltip(
          'Moves the cursor to absolute screen coordinates.' +
            String.fromCharCode(10) + String.fromCharCode(10) +
            String.fromCharCode(34) + 'within' + String.fromCharCode(34) +
            ' interpolates the move over that time instead of teleporting, which matters for ' +
            'anything that reacts to the cursor passing over it. 0ms jumps straight there.'
        );
      },
    };

    Blockly.Blocks[catalog.MOUSE.MOVE_BY] = {
      init: function () {
        asAction(this, COL.MOUSE.colour);
        this.setInputsInline(true);
        this.appendDummyInput()
          .appendField('move mouse by');
        socket(this, 'DX', 0, { label: 'dx' });
        socket(this, 'DY', 0, { label: 'dy' });
        this.appendDummyInput().appendField('within');
        socket(this, 'MS', 200, {});
        this.appendDummyInput().appendField('ms');
        this.setTooltip(
          'A smooth relative move, interpolated over the given time. No coordinate picker is needed ' +
            'because the movement is relative.'
        );
      },
    };

    // ========================================================== KEYBOARD

    Blockly.Blocks[catalog.START.SCROLL] = {
      init: function () {
        asStart(this, COL.START.colour);
        this.appendDummyInput()
          .appendField('?  when scrolled')
          .appendField(
            new Blockly.FieldDropdown([
              ['up', C.SCROLL.UP],
              ['down', C.SCROLL.DOWN],
            ]),
            'DIR'
          )
          .appendField('run');
        this.appendStatementInput('DO').appendField('do');
        this.setTooltip(
          'Runs the blocks below when the mouse wheel is scrolled that way, anywhere, while armed.' +
            String.fromCharCode(10) + String.fromCharCode(10) +
            'It fires ONCE per scroll gesture, not once per wheel click - a single flick of the wheel ' +
            'delivers a burst of events, and running the macro for each of them would flood it. It ' +
            're-arms once you stop scrolling.' +
            String.fromCharCode(10) + String.fromCharCode(10) +
            'The wheel is global: scrolling in any window counts, including outside MacroBoard.'
        );
      },
    };

    Blockly.Blocks[catalog.MOUSE.MOVE_WITHIN] = {
      init: function () {
        asAction(this, COL.MOUSE.colour);
        this.setInputsInline(true);
        this.appendDummyInput().appendField('move mouse within   x from');
        socket(this, 'X1', 0, {});
        this.appendDummyInput().appendField('to');
        socket(this, 'X2', 200, {});
        this.appendDummyInput().appendField('y from');
        socket(this, 'Y1', 0, {});
        this.appendDummyInput().appendField('to');
        socket(this, 'Y2', 200, {});
        // ONE button, TWO picks: the first click sets the top-left corner and
        // the second sets the bottom-right one. Two separate buttons would let
        // you draw a rectangle "inside out", which the block normalises anyway.
        this.appendDummyInput().appendField(act(' \u2316 pick 2 ', 'pickRect', 'Pick two corners of an area'));
        this.appendDummyInput().appendField('within');
        socket(this, 'MS', 200, {});
        this.appendDummyInput().appendField('ms');
        this.setTooltip(
          'Moves the cursor to a RANDOM point inside the rectangle you draw with "pick 2".' +
            String.fromCharCode(10) + String.fromCharCode(10) +
            'Press "pick 2", click the first corner, then click the second corner. A new point is ' +
            'chosen every single time the block runs, so a macro that repeats moves all over the area ' +
            'instead of drilling the same hole in one spot.' +
            String.fromCharCode(10) + String.fromCharCode(10) +
            'The corners can be given in any order - dragging bottom-right to top-left works the same. ' +
            'A degenerate rectangle (both corners on one axis) is allowed and just picks that line.'
        );
      },
    };

    Blockly.Blocks[catalog.MOUSE.SCROLL] = {
      init: function () {
        asAction(this, COL.MOUSE.colour);
        this.setInputsInline(true);
        this.appendDummyInput()
          .appendField('scroll');
        socket(this, 'PX', C.SCROLL.DEFAULT_PX, { label: '' });
        this.appendDummyInput()
          .appendField('px')
          .appendField(
            new Blockly.FieldDropdown([
              ['up', C.SCROLL.UP],
              ['down', C.SCROLL.DOWN],
            ]),
            'DIR'
          );
        this.appendDummyInput().appendField('within');
        socket(this, 'MS', C.SCROLL.DEFAULT_MS, {});
        this.appendDummyInput().appendField('ms');
        this.setTooltip(
          'Scrolls the wheel at the cursor.' +
            String.fromCharCode(10) + String.fromCharCode(10) +
            'Windows counts a wheel click as ' + C.SCROLL.PX_PER_NOTCH + ', so a pixel amount is ' +
            'rounded to whole clicks and the distance the page actually moves is decided by the ' +
            'app you are scrolling - a browser and a game will not agree. One click is the unit ' +
            'that behaves the same everywhere; 360px is 3 clicks.' +
            String.fromCharCode(10) + String.fromCharCode(10) +
            '"within" spreads the scroll over that time instead of firing it all at once, which ' +
            'some apps need in order to register it. 0ms sends it in a single burst.'
        );
      },
    };

    Blockly.Blocks[catalog.KEYBOARD.TYPE] = {
      init: function () {
        asAction(this, COL.KEYBOARD.colour);
        this.setInputsInline(true);
        this.appendDummyInput()
          .appendField('type text')
          .appendField(
            new Blockly.FieldTextInput('', function (v) {
              return v === null || v === undefined ? '' : String(v);
            }),
            'TEXT'
          );
        this.setTooltip('Types the given text into whatever window has focus.');
      },
    };

    Blockly.Blocks[catalog.KEYBOARD.PRESS] = {
      init: function () {
        asAction(this, COL.KEYBOARD.colour);
        this.setInputsInline(true);
        this.appendDummyInput()
          .appendField('press key')
          .appendField(btn('action', 'key:A', 'Any key - or a mouse button, if that is what you want to press.', null), 'BUTTON');
        this.setTooltip('Presses the key once. Use "press ... times" for repeats.');
      },
    };

    Blockly.Blocks[catalog.KEYBOARD.PRESS_TIMES] = {
      init: function () {
        asAction(this, COL.KEYBOARD.colour);
        this.setInputsInline(true);
        this.appendDummyInput()
          .appendField('press')
          .appendField(btn('action', 'key:A'), 'BUTTON');
        // Default is 1 time, not 3 - the shadow should show what the block
    // actually does, and "press key 3 times" was a surprising default.
    socket(this, 'COUNT', 1, { min: 1, max: LIMITS.MAX_PRESS_COUNT });
        this.appendDummyInput().appendField('time(s) with');
        socket(this, 'GAP', 100, { min: 0, max: LIMITS.MAX_GAP_MS });
        this.appendDummyInput().appendField('ms gap');
        this.setTooltip(
          'Presses the key N times, waiting the given gap between presses.\n\nThe gap is the time BETWEEN ' +
            'presses, so "100 times with a 1 ms gap" finishes in about 100ms. Use a 0ms gap to press as ' +
            'fast as the machine physically allows (roughly 2000+ per second).\n\nDrop the "forever" chip ' +
            'in the gap socket to hang after the first press until you press Stop - rarely what you ' +
            'want, but it is allowed.'
        );
      },
    };

    Blockly.Blocks[catalog.KEYBOARD.HOLD] = {
      init: function () {
        asAction(this, COL.KEYBOARD.colour);
        this.setInputsInline(true);
        this.appendDummyInput()
          .appendField('hold')
          .appendField(btn('action', 'key:LeftShift'), 'BUTTON')
          .appendField('for');
        socket(this, 'MS', 1000, { min: 0, max: LIMITS.MAX_DURATION_MS });
        this.appendDummyInput().appendField('ms');
        this.setTooltip(
          'Holds the key down for the given time, then releases it. If you press Stop during the ' +
            'hold, the key is still released cleanly.'
        );
      },
    };

    // =========================================================== CONTROL

    Blockly.Blocks[catalog.CONTROL.WAIT] = {
      init: function () {
        asAction(this, COL.CONTROL.colour);
        this.setInputsInline(true);
        this.appendDummyInput().appendField('wait');
        socket(this, 'MS', 1, { min: 0, max: LIMITS.MAX_WAIT_MS / 1000 });
        this.appendDummyInput().appendField('seconds');
        this.setTooltip(
          'Pauses for the given number of SECONDS. Decimals are allowed (0.5 = half a second, ' +
            '3.432 = exactly 3432ms).\n\n' +
            'This is accurate to well under a millisecond. The "forever" chip makes it idle until you ' +
            'press Stop.'
        );
      },
    };

    // Same step, expressed in milliseconds. Both blocks compile to the identical
    // step, so the choice is purely about how the user wants to read it.
    Blockly.Blocks[catalog.CONTROL.WAIT_MS] = {
      init: function () {
        asAction(this, COL.CONTROL.colour);
        this.setInputsInline(true);
        this.appendDummyInput().appendField('wait');
        socket(this, 'MS', 100, { min: 0, max: LIMITS.MAX_WAIT_MS });
        this.appendDummyInput().appendField('milliseconds');
        this.setTooltip(
          'Pauses for the given number of MILLISECONDS. Use this when you care about exact ' +
            'milliseconds (wait 776 ms really is 776 ms, not 778).\n\n' +
            'For longer pauses prefer the seconds block, which takes decimals too.\n\n' +
            'The "forever" chip makes it idle until you press Stop.'
        );
      },
    };

    Blockly.Blocks[catalog.CONTROL.REPEAT] = {
      init: function () {
        asAction(this, COL.CONTROL.colour);
        this.setInputsInline(true);
        this.appendDummyInput().appendField('repeat');
        socket(this, 'COUNT', 10, { min: 0, max: LIMITS.MAX_REPEAT_COUNT });
        this.appendDummyInput().appendField('time(s)');
        this.appendStatementInput('DO').appendField('do');
        this.setTooltip(
          'Runs the blocks below N times, one after another.\n\nThe "forever" chip loops until Stop.'
        );
      },
    };

    Blockly.Blocks[catalog.CONTROL.AT_ONCE] = {
      init: function () {
        asAction(this, COL.CONTROL.colour);
        this.appendDummyInput().appendField('at once');
        this.appendStatementInput('DO').appendField('do');
        this.setTooltip(
          'Every block stacked here starts at the same instant, as separate parallel tasks, and the ' +
            'macro waits for all of them together.\n\nExample: "hold A for 1s" and "hold B for 1s" ' +
            'inside "at once" overlap; outside it they run one after the other.'
        );
      },
    };

    /**
     * A dropdown whose options are re-evaluated on EVERY read.
     *
     * Blockly caches generated options after the first read, which would freeze
     * the macro list at whatever it was when the block was created. Bypassing the
     * cache is what makes "run another macro" reflect renames/deletions live -
     * both in the menu and in setValue's validation.
     */
    class MbFieldDropdown extends Blockly.FieldDropdown {
      getOptions() {
        return super.getOptions(false);
      }
    }

    Blockly.Blocks[catalog.CONTROL.RUN_MACRO] = {
      init: function () {
        asAction(this, COL.CONTROL.colour);
        this.setInputsInline(true);
        this.appendDummyInput()
          .appendField('run another macro')
          .appendField(
            // The options function is re-run on every read, so the list is live.
            new MbFieldDropdown(function () {
              var names = (deps.getMacroNames && deps.getMacroNames()) || [];
              if (!names.length) return [['(no saved macros)', '']];
              return names.map(function (n) {
                return [n, n];
              });
            }),
            'MACRO'
          );
        this.setTooltip(
          'Loads and runs another saved macro inline, like a subroutine.\n\nThe dropdown is rebuilt ' +
            'every time you open it, so it always shows your current macros.'
        );
      },
    };

    // ==================================================== CHOOSERS (paged)

    /**
     * The paged-chooser implementation.
     *
     * DESIGN: the block always has exactly ONE statement input ('DO') holding
     * the ACTIVE page's stack. Every other page is kept as serialized block JSON
     * in `stash`. Switching pages serializes the live stack into the stash and
     * loads the target page's state into the input.
     *
     * Why not one statement input per page? Hiding/showing Blockly statement
     * inputs leaves their child blocks rendered in the wrong place, and
     * dynamically adding/removing inputs loses the blocks inside them. This
     * approach only uses public serialization APIs, round-trips cleanly through
     * save / load / copy-paste, and keeps the block's shape static.
     *
     * `saveExtraState` deliberately stores `null` for the active page: that page
     * already lives in `inputs.DO`. Storing it in both places makes Blockly
     * reload a duplicate copy of it.
     */
    function makeChooserApi(Blockly, C, block, mode) {
      var MIN = C.LIMITS.MIN_CHOOSER_PAGES;
      var MAX = C.LIMITS.MAX_CHOOSER_PAGES;

      var api = { mode: mode, page: 0, stash: [null, null], label: null, block: block };

      function withEventsPaused(fn) {
        var wasEnabled = Blockly.Events.isEnabled();
        if (wasEnabled) Blockly.Events.disable();
        try {
          return fn();
        } finally {
          if (wasEnabled) Blockly.Events.enable();
        }
      }

      api.liveHead = function () {
        return block.getInputTargetBlock('DO');
      };

      api.serializeLive = function () {
        var head = api.liveHead();
        if (!head) return null;
        return Blockly.serialization.blocks.save(head, { addCoordinates: false });
      };

      api.clearLive = function () {
        var b = api.liveHead();
        var guard = 0;
        while (b && guard++ < 2000) {
          var next = b.getNextBlock();
          b.dispose(true);
          b = next;
        }
      };

      api.loadPageInto = function (idx) {
        var state = api.stash[idx];
        if (!state) return;
        var nb = Blockly.serialization.blocks.append(state, block.workspace);
        block.getInput('DO').connection.connect(nb.previousConnection);
      };

      api.refreshLabel = function () {
        if (!api.label) return;
        try {
          api.label.setValue('page ' + (api.page + 1) + '/' + api.stash.length);
        } catch (e) {
          /* the label may not be rendered yet during workspace load */
        }
      };

      /** Switch to another page, preserving both pages' contents. */
      api.setPage = function (idx) {
        var n = api.stash.length;
        if (!n) return false;
        idx = ((idx % n) + n) % n; // wrap around in both directions
        if (idx === api.page) return true;
        api.stash[api.page] = api.serializeLive();
        withEventsPaused(function () {
          api.clearLive();
          api.page = idx;
          api.loadPageInto(idx);
        });
        api.refreshLabel();
        // A harmless BlockChange so the workspace is marked dirty and undo sees
        // the switch as a single step.
        try {
          Blockly.Events.fire(new Blockly.Events.BlockChange(block, 'mbChooserPage', null, idx));
        } catch (e) {
          /* events may be unavailable headlessly */
        }
        return true;
      };

      api.next = function () {
        return api.setPage(api.page + 1);
      };

      api.prev = function () {
        return api.setPage(api.page - 1);
      };

      api.addPage = function () {
        if (api.stash.length >= MAX) {
          return { ok: false, reason: 'A chooser can hold at most ' + MAX + ' pages.' };
        }
        api.stash[api.page] = api.serializeLive();
        api.stash.push(null);
        api.refreshLabel();
        return { ok: true, pageCount: api.stash.length };
      };

      /** Delete a page. Returns { ok, reason? } so the UI can explain refusals. */
      api.deletePage = function (idx) {
        var n = api.stash.length;
        if (n <= MIN) return { ok: false, reason: 'A chooser needs at least ' + MIN + ' pages.' };
        if (idx < 0 || idx >= n) return { ok: false, reason: 'No such page.' };

        api.stash[api.page] = api.serializeLive();
        var wasActive = idx === api.page;

        withEventsPaused(function () {
          if (wasActive) api.clearLive();
          api.stash.splice(idx, 1);
          if (wasActive) {
            // Show whichever page slid into this slot (or the new last page).
            api.page = Math.min(idx, api.stash.length - 1);
            api.loadPageInto(api.page);
          } else if (idx < api.page) {
            api.page--;
          }
        });
        api.refreshLabel();
        return { ok: true, pageCount: api.stash.length };
      };

      /** Snapshot used by tests + the status readout. */
      api.describe = function () {
        var empty = 0;
        api.stash.forEach(function (p, i) {
          // The active page is live, so its content comes from the input, not
          // from the stash (where it is deliberately stored as null).
          if (i === api.page) {
            if (!api.liveHead()) empty++;
          } else if (!p) {
            empty++;
          }
        });
        return { mode: api.mode, page: api.page + 1, pages: api.stash.length, empty: empty };
      };

      return api;
    }

    function chooserStateHandlers(C) {
      return {
        saveExtraState: function () {
          var api = this.mbChooser;
          if (!api) return null;
          var pages = api.stash.slice();
          // The active page lives in inputs.DO; storing it here as well would
          // make Blockly reload a duplicate copy of it.
          pages[api.page] = null;
          return { pages: pages, active: api.page };
        },
        loadExtraState: function (state) {
          var api = this.mbChooser;
          var MIN = C.LIMITS.MIN_CHOOSER_PAGES;
          if (!api) return;
          var pages = state && Array.isArray(state.pages) ? state.pages.slice() : [null, null];
          while (pages.length < MIN) pages.push(null);
          api.stash = pages;
          var active = state && typeof state.active === 'number' ? state.active : 0;
          api.page = Math.max(0, Math.min(pages.length - 1, active));
          api.refreshLabel();
        },
      };
    }

    function defineChooser(typeName, title, mode, colour, tooltip, extraNote) {
      Blockly.Blocks[typeName] = Object.assign(
        {
          init: function () {
            asAction(this, colour);
            var api = makeChooserApi(Blockly, C, this, mode);
            this.mbChooser = api;
            api.label = new Blockly.FieldLabel('page 1/2');
            this.appendDummyInput('HDR')
              .appendField(title)
              .appendField(act(' \u2039 ', 'chooserPrev', 'Previous page'), 'PREV')
              .appendField(api.label, 'PAGELABEL')
              .appendField(act(' \u203a ', 'chooserNext', 'Next page'), 'NEXT')
              .appendField(act(' + ', 'chooserAdd', 'Add a page'), 'ADD')
              .appendField(act(' \u2715 ', 'chooserDelete', 'Delete the page being shown'), 'DEL');
            this.appendStatementInput('DO');
            this.setTooltip(tooltip + (extraNote ? '\n\n' + extraNote : ''));
            api.refreshLabel();
          },
        },
        chooserStateHandlers(C)
      );
    }

    defineChooser(
      catalog.CONTROL.RANDOM_CHOOSER,
      'random chooser',
      'random',
      COL.CONTROL.colour,
      'Holds several pages of blocks. Each time it runs, ONE page is picked at random (empty pages are ' +
        'skipped) and its blocks run.',
      'Use the arrows to move between pages, "+" to add a page and the cross to delete the page you are ' +
        'looking at (with confirmation).'
    );

    defineChooser(
      catalog.CONTROL.ORGANIZED_CHOOSER,
      'organized chooser',
      'organized',
      COL.CONTROL.colour,
      'Identical to the random chooser, but the pages are used in order: the 1st run uses page 1, the ' +
        '2nd run page 2, looping back to page 1 after the last page.',
      'The "next page" position is remembered between runs and survives closing the app.'
    );

    /**
     * `wait until window titled "…" exists`
     *
     * The single most useful block in this app for reliability. Every macro
     * starts with "wait for the thing to load" and then guesses a duration with
     * `wait N seconds`; this replaces the guess with a fact.
     *
     * The timeout is MANDATORY, not optional. A wait with no timeout is a
     * permanent hang, and "wait forever" is exactly the wrong reading of "wait
     * for the app" when the app was never going to open.
     */
    Blockly.Blocks[catalog.CONTROL.WAIT_FOR_WINDOW] = {
      init: function () {
        asAction(this, COL.CONTROL.colour);
        this.setInputsInline(true);
        this.appendDummyInput()
          .appendField('wait until window titled')
          .appendField(
            new Blockly.FieldTextInput('', function (v) {
              return v === null || v === undefined ? '' : String(v);
            }),
            'TITLE'
          )
          .appendField('exists')
          .appendField(act(' \u2316 list ', 'pickWindowTitle', 'Pick from the windows open right now'), 'LIST');
        this.appendDummyInput()
          .appendField('in the next');
        socket(this, 'TIMEOUT_S', C.WINDOW.DEFAULT_WAIT_SECONDS, {});
        this.appendDummyInput().appendField('s   check every');
        socket(this, 'POLL', C.LIMITS.WINDOW_POLL.DEFAULT_MS, {});
        this.appendDummyInput().appendField('ms');
        this.setTooltip(
          'Pauses until a window whose title CONTAINS the text is open, or until the timeout.\n\n' +
            'The match is case-insensitive and only needs to be part of the title, because real ' +
            'titles are long: "Notepad" matches "Sales.csv - Notepad", and "Chrome" matches every ' +
            'tab you have open. A visible window is enough - a minimised one still counts.\n\n' +
            'THE TIMEOUT IS REQUIRED. Without one this block would hang forever, and "wait forever ' +
            'for the app" is the wrong reading of this when the app was never going to open. If it ' +
            'times out, the error lists the window titles that WERE open, so you can see what to ' +
            'match on instead of guessing.\n\n' +
            'PERFORMANCE, measured: reading window titles needs a PowerShell helper. The first ' +
            'check of a session starts that helper and costs about ' +
            C.WINDOW.MEASURED_STARTUP_MS +
            'ms; after that each check is about ' + C.WINDOW.MEASURED_QUERY_MS +
            'ms, so the interval you choose is the interval you get. The helper shuts itself down ' +
            'when unused.\n\n' +
            'Only visible top-level windows are listed, and MacroBoard\'s own window is ignored so a ' +
            'macro cannot match this app and declare victory.'
        );
      },
    };

    // ======================================================== LOOP EXITING

    /**
     * `repeat until <condition>`
     *
     * A condition-checked loop, which is the piece that makes "keep doing this
     * until the screen looks right" expressible. The condition is re-evaluated
     * BEFORE every pass, so it is checked first even on the first iteration -
     * that is the whole difference from `repeat N times`.
     */
    Blockly.Blocks[catalog.CONTROL.REPEAT_UNTIL] = {
      init: function () {
        asAction(this, COL.CONTROL.colour);
        this.setInputsInline(true);
        this.appendValueInput('COND').setCheck('Boolean').appendField('repeat until');
        this.appendStatementInput('DO').appendField('do');
        this.setTooltip(
          'Runs the blocks below over and over, checking the condition each time, until it becomes ' +
            'TRUE.\n\n' +
            'The condition is checked BEFORE the first pass, so if it is already true the blocks below ' +
            'never run at all.\n\n' +
            'Put a "break" inside if you want to leave early for some other reason.\n\n' +
            'SAFETY: this loop stops itself after ' +
            C.LIMITS.MAX_CONDITION_LOOP_ITERATIONS.toLocaleString('en-US') +
            ' passes and says so, naming the condition that never came true. A condition that can never ' +
            'be satisfied would otherwise sit there forever. "repeat N times" and the "forever" chip ' +
            'are not capped, because you asked for those explicitly.'
        );
      },
    };

    /**
     * `break` - leave the nearest enclosing loop.
     *
     * NOT a step type. It compiles to nothing: it is a signal the engine reads
     * while running the loop body. That is what makes it work correctly when
     * nested - the innermost loop consumes it and the outer ones never notice.
     *
     * Whether it is legal is decided at COMPILE time from a loop-scope stack the
     * compiler keeps, because that is the only place the block structure is
     * actually knowable. Dragging one onto empty canvas is a compile error
     * rather than a block that is silently ignored.
     */
    Blockly.Blocks[catalog.CONTROL.BREAK] = {
      init: function () {
        asAction(this, COL.CONTROL.colour);
        this.setInputsInline(true);
        this.appendDummyInput().appendField('\u21a9  break out of this loop');
        this.setTooltip(
          'Stops the nearest loop around it and carries on with whatever comes after that loop.\n\n' +
            'Inside "at once" it breaks the surrounding loop AND ends that parallel task, so the ' +
            'other tasks finish first and the loop does not keep going.\n\n' +
            'Only the NEAREST loop is affected: put this inside a "repeat" nested in a "repeat" and it ' +
            'leaves the inner one only.\n\n' +
            'This has to be inside a loop. On its own it is a compile error, because a "break" with no ' +
            'loop to leave has nothing it could sensibly mean.'
        );
      },
    };

    /** `continue` - skip the rest of this pass, keep looping. */
    Blockly.Blocks[catalog.CONTROL.CONTINUE] = {
      init: function () {
        asAction(this, COL.CONTROL.colour);
        this.setInputsInline(true);
        this.appendDummyInput().appendField('\u21bb  skip the rest of this pass');
        this.setTooltip(
          'Ends this pass here and goes to the next one, skipping whatever is stacked below.\n\n' +
            'Honest note about what it does today: in a plain loop body this behaves exactly like ' +
            'ending the body early, because nothing else happens per pass. It is still worth using, ' +
            'because the block below it becomes obviously dead instead of a trap, and it is the only ' +
            'way to end ONE task of an "at once" without disturbing the others.\n\n' +
            'The condition of a "repeat until" is still checked, so this is how you act and then try again.\n\n' +
            'This has to be inside a loop. On its own it is a compile error.'
        );
      },
    };

    // ============================================================== IF
    /**
     * `if / else`.
     *
     * The ELSE branch's statement input is always present rather than hidden
     * until asked for. Hiding and showing statement inputs (Blockly's
     * controls_if uses a mutation for exactly this) round-trips through the
     * JSON save format only via the mutation field, and every macro in this app
     * is saved as JSON. Keeping the shape static means an `if` block serialises,
     * copies and pastes with no special cases, which is the same reasoning that
     * drove the chooser's single-statement-input design (see makeChooserApi).
     *
     * An empty ELSE body compiles to an empty step list, so it costs nothing at
     * run time.
     */
    Blockly.Blocks[catalog.CONTROL.IF] = {
      init: function () {
        asAction(this, COL.CONTROL.colour);
        this.appendValueInput('COND').setCheck('Boolean').appendField('if');
        this.appendStatementInput('THEN').appendField('do');
        this.appendStatementInput('ELSE').appendField('else');
        this.setTooltip(
          'Runs the "do" blocks when the condition is true, and the "else" blocks when it is false.\n\n' +
            'The condition is a Logic block from the Logic category: something like\n' +
            '(x) > (y)   or   (a) = (b)   or   not <condition>\n\n' +
            'A number is allowed as the condition too - 0 is false, anything else is true - but a ' +
            'Logic block reads better.\n\n' +
            'Empty "else" means: do nothing when the condition is false.'
        );
      },
    };

    // ============================================================= LOGIC

    /**
     * A logic reporter.
     *
     * The operand sockets are deliberately UNCHECKED (no setCheck). That means
     * any reporter fits - a comparison, another `and`, a `between` chip, a
     * plain number - which is what makes logic nestable and lets a single
     * `and` mix conditions and values. The evaluator applies the same truthiness
     * rule everywhere, so a number means "0 is false, anything else is true".
     *
     * A checked `Boolean` socket would be tidier in principle and worse in
     * practice: you could not drop "between 1 and 5" into an `and`.
     */
    function logicReporter(colour, build) {
      return {
        init: function () {
          asBoolean(this, colour);
          build(this);
        },
      };
    }

    Blockly.Blocks[catalog.LOGIC.AND] = logicReporter(COL.LOGIC.colour, function (block) {
      block.setInputsInline(true);
      block.appendValueInput('A');
      block.appendDummyInput().appendField('and');
      block.appendValueInput('B');
      block.setTooltip(
        'True when both sides are true.\n\nEither side can be a comparison, another logic block, or ' +
          'a number (0 is false, anything else is true).\n\nThe right-hand side is only checked if ' +
          'the left one is true.'
      );
    });

    Blockly.Blocks[catalog.LOGIC.OR] = logicReporter(COL.LOGIC.colour, function (block) {
      block.setInputsInline(true);
      block.appendValueInput('A');
      block.appendDummyInput().appendField('or');
      block.appendValueInput('B');
      block.setTooltip(
        'True when at least one side is true.\n\nThe right-hand side is only checked if the left one ' +
          'is false.'
      );
    });

    Blockly.Blocks[catalog.LOGIC.NOT] = logicReporter(COL.LOGIC.colour, function (block) {
      block.setInputsInline(true);
      block.appendValueInput('A').appendField('not');
      block.setTooltip('Reverses its input: true becomes false, false becomes true.');
    });

    function comparison(symbol, tooltip) {
      return {
        init: function () {
          asBoolean(this, COL.LOGIC.colour);
          this.setInputsInline(true);
          socket(this, 'A', 0, {});
          this.appendDummyInput().appendField(symbol);
          socket(this, 'B', 0, {});
          this.setTooltip(tooltip);
        },
      };
    }

    Blockly.Blocks[catalog.LOGIC.EQUALS] = comparison(
      '=',
      'True when the two numbers are exactly equal.\n\nFloating point is not fuzzy: 0.1 + 0.2 is not ' +
        'equal to 0.3. Drop a "round" block in when you need whole numbers to match.'
    );

    Blockly.Blocks[catalog.LOGIC.GREATER] = comparison(
      '>',
      'True when the first number is greater than the second.'
    );

    Blockly.Blocks[catalog.LOGIC.LESS] = comparison(
      '<',
      'True when the first number is smaller than the second.'
    );

    /**
     * `(pixel at x y) is <colour>` - a colour check you can use ANYWHERE a
     * condition goes, not just as a macro trigger.
     *
     * This is the whole point of the block being a LOGIC reporter rather than a
     * statement block. It drops into `if`, and it drops into `and` / `or` /
     * `not`, which is what makes multi-pixel state detection possible:
     *
     *     (pixel 655,402 is red) and (pixel 700,402 is red)   -> bar is empty
     *     (pixel 300,250 is red) or  (pixel 520,250 is red)   -> error on either field
     *     not (pixel 655,415 is grey)                         -> not mid-fade
     *
     * One pixel on its own is a single bit and tells you almost nothing; three
     * pixels combined distinguish real states. That is the difference between a
     * macro that works on the screen you happened to test and one that survives
     * a frame of animation.
     *
     * The fields deliberately mirror the `when pixel ... becomes` trigger
     * exactly, including the same coordinate picker and eyedropper actions, so
     * the two read identically and a user moving from one to the other is not
     * relearning anything.
     */
    Blockly.Blocks[catalog.LOGIC.PIXEL_IS] = {
      init: function () {
        asBoolean(this, COL.LOGIC.colour);
        this.setInputsInline(true);
this.appendDummyInput()
          .appendField('pixel at');
        socket(this, 'X', 0, { label: 'x' });
        socket(this, 'Y', 0, { label: 'y' });
        this.appendDummyInput().appendField(act(' ⌖ pick ', 'pickPixel', 'Pick the pixel on screen'), 'PICK');
        this.appendDummyInput()
          .appendField('is')
          .appendField(new F.FieldColourPicker('#ffffff'), 'COLOUR')
          .appendField(act(' ⌖ eyedrop ', 'eyedropColour', 'Read the colour under the cursor'), 'DROP');
        this.appendDummyInput().appendField('tolerance');
        socket(this, 'TOLERANCE', 0, {});
        this.setTooltip(
          'True when that one screen pixel matches the colour. Drop it into an "if" condition.\n\n' +
            'The strength of this block is COMBINING it. One pixel is a single bit, which is usually ' +
            'ambiguous - a health bar\'s left edge is green at full health AND for one frame while damage ' +
            'is landing. Two or three pixels plus "and" tell those states apart.\n\n' +
            'Examples:\n' +
            '(pixel A is red) and (pixel B is red)  -> the bar is completely drained\n' +
            '(pixel A is red) or (pixel B is red)   -> the error is on either field\n' +
            'not (pixel A is grey)                   -> ignore the first frame of a highlight\n\n' +
            'All the pixels in ONE condition are read from a SINGLE screen capture, so combining them ' +
            'costs one capture rather than one each.\n\n' +
            'The eyedropper hides this app and samples the colour live as you move the mouse, then ' +
            'picks on Ctrl+click - or on Ctrl+Enter, which does not click at all and so cannot disturb ' +
            'the app you are sampling. Escape cancels.\n\n' +
            'PERFORMANCE: reading a pixel means capturing the screen, which is real work. This is a ' +
            'decision point, not a wait - use it to branch, and put a "wait" in the branch that needs ' +
            'one.'
        );
      },
    };

    // ============================================================= VALUES

    Blockly.Blocks[catalog.VALUE.NUMBER] = {
      init: function () {
        asValue(this, COL.VALUES.colour);
        this.appendDummyInput().appendField(num(0), 'NUM');
        this.setTooltip(
          'A plain number. This is the chip already sitting in every numeric socket.\n\n' +
            'Up to 3 decimal places, so fractional seconds (3.432 = 3432ms) work exactly.'
        );
      },
    };

    Blockly.Blocks[catalog.VALUE.FOREVER] = {
      init: function () {
        asValue(this, COL.VALUES.colour);
        this.appendDummyInput().appendField('\u267e forever');
        this.setTooltip(
          'Makes the socket mean "until I press Stop" instead of a fixed amount.\n\n' +
            '- repeat: loops until stopped\n' +
            '- hold: holds until stopped, then releases\n' +
            '- wait: idles until stopped\n' +
            '- press gap: hangs after the first press until stopped (unusual, use with care)\n' +
            '- trigger count: fires on every press'
        );
      },
    };

    Blockly.Blocks[catalog.VALUE.RANGE] = {
      init: function () {
        asValue(this, COL.VALUES.colour);
        this.appendDummyInput()
          .appendField('between')
          .appendField(num(100, { min: 0, max: LIMITS.MAX_DURATION_MS }), 'MIN')
          .appendField('and')
          .appendField(num(500, { min: 0, max: LIMITS.MAX_DURATION_MS }), 'MAX');
        this.setTooltip(
          'Picks a random whole number between the two values, re-rolled fresh every time the step runs.'
        );
      },
    };

    return {
      chooserTypes: [catalog.CONTROL.RANDOM_CHOOSER, catalog.CONTROL.ORGANIZED_CHOOSER],
      makeChooserApi: makeChooserApi,
    };
  }

    return {
      register: register,
      attachShadow: attachShadow,
      numberField: numberField,
      numericSocket: numericSocket,
    };
});

