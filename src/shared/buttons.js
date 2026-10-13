/**
 * MacroBlock - input button catalog
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Two different native libraries are involved:
 *
 *   detection : uiohook      -> reports raw keycodes / raw mouse button numbers
 *   simulation: nut-js        -> needs ITS OWN Key / Button enum values
 *
 * The two vocabularies do not line up by default, and (per the product spec)
 * raw mouse-button numbering is NOT something we are willing to hard-code
 * confidence about. So:
 *
 *   - A "button" is identified by a canonical string id:
 *       key:LeftShift        (canonical ids ARE nut-js Key names)
 *       key:uiohook:Fn       (detectable but NOT simulatable)
 *       mouse:1              (the RAW number the hook reported)
 *
 *   - For mouse buttons the raw number IS the id, so "Listen for a press" is
 *     literally the source of truth on the user's machine. A best-guess label is
 *     attached for display only, and it is shown as a guess.
 *
 *   - Anything that cannot be simulated (side buttons 4/5, hook-only keys) is
 *     flagged `sim: false`. Raising that error is the caller's job, and it is a
 *     *clear* error rather than a silent no-op.
 *
 * Everything is derived at runtime from the installed enums, so it stays correct
 * if the libraries are upgraded.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MB = root.MB || {};
    root.MB.buttons = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** uiohook key name -> nut-js Key name, for the names that differ. */
  var KEY_ALIASES = {
    Ctrl: 'LeftControl',
    CtrlRight: 'RightControl',
    Alt: 'LeftAlt',
    AltRight: 'RightAlt',
    Shift: 'LeftShift',
    ShiftRight: 'RightShift',
    Meta: 'LeftMeta',
    MetaRight: 'RightMeta',
    Backquote: 'Grave',
    BracketLeft: 'LeftBracket',
    BracketRight: 'RightBracket',
    ArrowLeft: 'Left',
    ArrowUp: 'Up',
    ArrowRight: 'Right',
    ArrowDown: 'Down',
    PrintScreen: 'Print',
    Enter: 'Return',
    NumpadEnter: 'Enter',
    Numpad0: 'NumPad0',
    Numpad1: 'NumPad1',
    Numpad2: 'NumPad2',
    Numpad3: 'NumPad3',
    Numpad4: 'NumPad4',
    Numpad5: 'NumPad5',
    Numpad6: 'NumPad6',
    Numpad7: 'NumPad7',
    Numpad8: 'NumPad8',
    Numpad9: 'NumPad9',
    NumpadMultiply: 'Multiply',
    NumpadAdd: 'Add',
    NumpadSubtract: 'Subtract',
    NumpadDecimal: 'Decimal',
    NumpadDivide: 'Divide',
    NumpadEnd: 'NumPad1',
    NumpadArrowDown: 'NumPad2',
    NumpadPageDown: 'NumPad3',
    NumpadArrowLeft: 'NumPad4',
    NumpadArrowRight: 'NumPad6',
    NumpadHome: 'NumPad7',
    NumpadArrowUp: 'NumPad8',
    NumpadPageUp: 'NumPad9',
    NumpadInsert: 'NumPad0',
    NumpadDelete: 'Decimal',
  };

  /**
   * BEST GUESS ONLY for how libuiohook numbers mouse buttons.
   * The app never relies on this for correctness: the raw number is what gets
   * stored, and the picker reports exactly what the hook saw.
   */
  var MOUSE_BUTTON_GUESS = {
    1: 'Left',
    2: 'Right',
    3: 'Middle',
    4: 'Side 1 (back)',
    5: 'Side 2 (forward)',
  };

  /**
   * Raw mouse button number -> nut-js Button enum key.
   * Only LEFT / MIDDLE / RIGHT exist in nut-js; there is no supported way to
   * *simulate* side buttons (4/5) on Windows. They stay usable as triggers.
   */
  var MOUSE_BUTTON_TO_NUT = { 1: 'LEFT', 2: 'RIGHT', 3: 'MIDDLE' };

  /** Rows of the US keyboard grid shown in the button picker modal. */
  var KEYBOARD_GRID = [
    [
      { id: 'Escape', label: 'Esc' }, { id: 'F1', label: 'F1' }, { id: 'F2', label: 'F2' },
      { id: 'F3', label: 'F3' }, { id: 'F4', label: 'F4' }, { id: 'F5', label: 'F5' },
      { id: 'F6', label: 'F6' }, { id: 'F7', label: 'F7' }, { id: 'F8', label: 'F8' },
      { id: 'F9', label: 'F9' }, { id: 'F10', label: 'F10' }, { id: 'F11', label: 'F11' },
      { id: 'F12', label: 'F12' },
    ],
    [
      { id: 'Grave', label: '`' }, { id: 'Num1', label: '1' }, { id: 'Num2', label: '2' },
      { id: 'Num3', label: '3' }, { id: 'Num4', label: '4' }, { id: 'Num5', label: '5' },
      { id: 'Num6', label: '6' }, { id: 'Num7', label: '7' }, { id: 'Num8', label: '8' },
      { id: 'Num9', label: '9' }, { id: 'Num0', label: '0' }, { id: 'Minus', label: '-' },
      { id: 'Equal', label: '=' }, { id: 'Backspace', label: 'Backspace', wide: true },
    ],
    [
      { id: 'Tab', label: 'Tab', wide: true }, { id: 'Q', label: 'Q' }, { id: 'W', label: 'W' },
      { id: 'E', label: 'E' }, { id: 'R', label: 'R' }, { id: 'T', label: 'T' },
      { id: 'Y', label: 'Y' }, { id: 'U', label: 'U' }, { id: 'I', label: 'I' },
      { id: 'O', label: 'O' }, { id: 'P', label: 'P' }, { id: 'LeftBracket', label: '[' },
      { id: 'RightBracket', label: ']' }, { id: 'Backslash', label: '\\' },
    ],
    [
      { id: 'CapsLock', label: 'Caps', wide: true }, { id: 'A', label: 'A' }, { id: 'S', label: 'S' },
      { id: 'D', label: 'D' }, { id: 'F', label: 'F' }, { id: 'G', label: 'G' },
      { id: 'H', label: 'H' }, { id: 'J', label: 'J' }, { id: 'K', label: 'K' },
      { id: 'L', label: 'L' }, { id: 'Semicolon', label: ';' }, { id: 'Quote', label: "'" },
      { id: 'Return', label: 'Enter', wide: true },
    ],
    [
      { id: 'LeftShift', label: 'Shift', wide: true }, { id: 'Z', label: 'Z' }, { id: 'X', label: 'X' },
      { id: 'C', label: 'C' }, { id: 'V', label: 'V' }, { id: 'B', label: 'B' },
      { id: 'N', label: 'N' }, { id: 'M', label: 'M' }, { id: 'Comma', label: ',' },
      { id: 'Period', label: '.' }, { id: 'Slash', label: '/' }, { id: 'RightShift', label: 'Shift', wide: true },
    ],
    [
      { id: 'LeftControl', label: 'Ctrl', wide: true }, { id: 'LeftSuper', label: 'Win', wide: true },
      { id: 'LeftAlt', label: 'Alt', wide: true }, { id: 'Space', label: 'Space', xwide: true },
      { id: 'RightAlt', label: 'Alt', wide: true }, { id: 'RightControl', label: 'Ctrl', wide: true },
      { id: 'Menu', label: 'Menu', wide: true },
    ],
  ];

  /** Numpad + navigation cluster, rendered as a second grid. */
  var NUMPAD_GRID = [
    [
      { id: 'ScrollLock', label: 'ScrLk' }, { id: 'Print', label: 'PrtSc' }, { id: 'Pause', label: 'Pause' },
    ],
    [
      { id: 'NumLock', label: 'NumLk' }, { id: 'Divide', label: '/' }, { id: 'Multiply', label: '*' },
      { id: 'Subtract', label: '-' },
    ],
    [
      { id: 'NumPad7', label: '7' }, { id: 'NumPad8', label: '8' }, { id: 'NumPad9', label: '9' },
      { id: 'Add', label: '+' },
    ],
    [
      { id: 'NumPad4', label: '4' }, { id: 'NumPad5', label: '5' }, { id: 'NumPad6', label: '6' },
    ],
    [
      { id: 'NumPad1', label: '1' }, { id: 'NumPad2', label: '2' }, { id: 'NumPad3', label: '3' },
      { id: 'Enter', label: 'Enter' },
    ],
    [
      { id: 'NumPad0', label: '0' }, { id: 'Decimal', label: '.' }, { id: 'Insert', label: 'Ins' },
      { id: 'Delete', label: 'Del' },
    ],
    [
      { id: 'Home', label: 'Home' }, { id: 'End', label: 'End' }, { id: 'PageUp', label: 'PgUp' },
      { id: 'PageDown', label: 'PgDn' },
    ],
    [
      { id: 'Up', label: '\u2191' }, { id: 'Down', label: '\u2193' }, { id: 'Left', label: '\u2190' },
      { id: 'Right', label: '\u2192' },
    ],
  ];

  /** Pretty names for canonical nut Key ids. */
  function prettify(id) {
    var m = /^Num([0-9])$/.exec(id);
    if (m) return m[1];
    var np = /^NumPad([0-9])$/.exec(id);
    if (np) return 'Numpad ' + np[1];
    return id.replace(/^Left/, 'Left ').replace(/^Right/, 'Right ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  }

  /**
   * @param {object} deps
    * @param {object} deps.UiohookKey  runtime enum from the uiohook module
   * @param {object} deps.nutKey      runtime `Key` enum from nut-js
   * @param {object} [deps.nutButton] runtime `Button` enum from nut-js
   */
  function createCatalog(deps) {
    var UiohookKey = deps.UiohookKey || {};
    var nutKey = deps.nutKey || {};
    var nutButton = deps.nutButton || {};

    var codeToId = Object.create(null);
    var idToCode = Object.create(null);

    function register(code, id) {
      if (typeof code !== 'number') return;
      if (codeToId[code] === undefined) codeToId[code] = id;
      if (idToCode[id] === undefined) idToCode[id] = code;
    }

    Object.keys(UiohookKey).forEach(function (name) {
      if (/^[0-9]+$/.test(name)) return; // numeric reverse-map entries
      var nutName = KEY_ALIASES[name] || (nutKey[name] !== undefined ? name : null);
      register(UiohookKey[name], nutName ? 'key:' + nutName : 'key:uiohook:' + name);
    });
    // uiohook names the digit row "0".."9" (filtered out above).
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].forEach(function (d) {
      register(UiohookKey[d], 'key:Num' + d);
    });

    function isMouseId(id) {
      return typeof id === 'string' && id.indexOf('mouse:') === 0;
    }

    function isSimulatableKeyId(id) {
      if (id.indexOf('key:uiohook:') === 0 || id.indexOf('key:raw:') === 0) return false;
      if (id.indexOf('key:') !== 0) return false;
      return nutKey[id.slice(4)] !== undefined;
    }

    function describeKeyId(id) {
      if (id.indexOf('key:uiohook:') === 0) return prettify(id.slice(12)) + ' (hook-only)';
      if (id.indexOf('key:raw:') === 0) return 'Raw hook code ' + id.slice(8);
      if (id.indexOf('key:') === 0) return prettify(id.slice(4));
      if (isMouseId(id)) {
        var n = Number(id.slice(6));
        return (MOUSE_BUTTON_GUESS[n] || 'Mouse button') + ' (code ' + n + ')';
      }
      return String(id);
    }

    /** Turn a raw hook keycode into a button descriptor. */
    function fromHookKeycode(code) {
      var id = codeToId[code];
      if (!id) {
        return {
          kind: 'key',
          id: 'key:raw:' + code,
          raw: code,
          label: 'Unknown key (hook code ' + code + ')',
          sim: false,
          note: 'Not in the known catalog: usable as a trigger, not as an action.',
        };
      }
      var sim = isSimulatableKeyId(id);
      return {
        kind: 'key',
        id: id,
        raw: code,
        label: describeKeyId(id),
        sim: sim,
        note: sim ? '' : 'Detectable on this machine but not simulatable by the input library.',
      };
    }

    /** Turn a raw hook mouse-button number into a button descriptor. */
    function fromHookMouseButton(num) {
      var sim = MOUSE_BUTTON_TO_NUT[num] !== undefined;
      var guess = MOUSE_BUTTON_GUESS[num];
      return {
        kind: 'mouse',
        id: 'mouse:' + num,
        raw: num,
        label: (guess ? guess + ' ' : 'Button ') + '(reported as code ' + num + ')',
        sim: sim,
        note: sim
          ? 'Best-guess label; the stored value is the raw code your machine reported.'
          : 'Mouse buttons other than left/middle/right cannot be simulated on Windows. Trigger use only.',
      };
    }

    function describe(buttonId) {
      if (!buttonId) return '(none)';
      if (isMouseId(buttonId)) {
        var n = buttonId.slice(6);
        return (MOUSE_BUTTON_GUESS[n] || 'Mouse button') + ' \u2013 code ' + n;
      }
      return describeKeyId(buttonId);
    }

    /**
     * Resolve a button id to a nut-js value for SIMULATION.
     * Throws a descriptive error for anything that physically cannot be
     * simulated, which is required, explicit product behaviour.
     */
    function toNutKey(id) {
      if (isMouseId(id)) {
        throw new Error(
          'Cannot press "' + describe(id) + '" as a keyboard key: it is a mouse button. Use a click ' +
            'block for mouse buttons (or a press/hold block, which accepts either).'
        );
      }
      var name = id.indexOf('key:') === 0 ? id.slice(4) : String(id);
      if (name.indexOf('uiohook:') === 0 || name.indexOf('raw:') === 0) {
        throw new Error(
          'Cannot press "' + describe(id) + '": this machine reports that input, but the input ' +
            'simulation library has no equivalent key, so a macro cannot perform it.'
        );
      }
      var v = nutKey[name];
      if (typeof v !== 'number') throw new Error('Unknown key id "' + id + '" for this build.');
      return v;
    }

    /** Resolve a mouse button id to a nut-js Button value for SIMULATION. */
    function toNutButton(id) {
      var n = isMouseId(id) ? Number(id.slice(6)) : null;
      var nutName = MOUSE_BUTTON_TO_NUT[n];
      if (!nutName) {
        throw new Error(
          'Cannot perform "' + describe(id) + '": the input simulation library can only simulate Left, ' +
            'Middle and Right mouse buttons on Windows. Extra side buttons can be used as triggers, but ' +
            'never as an action.'
        );
      }
      var v = nutButton[nutName];
      if (typeof v !== 'number') throw new Error('Mouse button ' + nutName + ' is unavailable in this build.');
      return v;
    }

    /** Mouse button descriptors offered in the picker. */
    function mouseButtons() {
      return [1, 2, 3, 4, 5].map(fromHookMouseButton);
    }

    /** Every key descriptor in the grids, for validation + lookups. */
    function gridKeys() {
      var out = [];
      KEYBOARD_GRID.concat(NUMPAD_GRID).forEach(function (row) {
        row.forEach(function (cell) {
          var sim = nutKey[cell.id] !== undefined;
          out.push({
            kind: 'key',
            id: 'key:' + cell.id,
            label: cell.label,
            sim: sim,
            note: sim ? '' : 'Not available in this build of the input library.',
          });
        });
      });
      return out;
    }

    /** Validate a stored button id; returns { ok, reason, button }. */
    function validate(buttonId) {
      if (!buttonId) return { ok: false, reason: 'No button selected.', button: null };
      if (isMouseId(buttonId)) {
        var raw = Number(buttonId.slice(6));
        if (!isFinite(raw)) return { ok: false, reason: 'Unrecognised mouse id "' + buttonId + '".', button: null };
        return { ok: true, reason: '', button: fromHookMouseButton(raw) };
      }
      if (buttonId.indexOf('key:') !== 0) {
        return { ok: false, reason: 'Unrecognised button id "' + buttonId + '".', button: null };
      }
      return {
        ok: true,
        reason: '',
        button: {
          kind: 'key',
          id: buttonId,
          label: describe(buttonId),
          sim: isSimulatableKeyId(buttonId),
          note: '',
        },
      };
    }

    /**
     * The raw hook keycode behind a canonical key id, or null if unknown.
     *
     * `idToCode` is keyed by the FULL canonical id ("key:Q"), not by the bare
     * nut-js name, so the whole id is looked up here. `key:uiohook:Foo` and
     * `key:raw:N` have no entry and correctly return null: they were never
     * registered, so there is no code to hand the native side.
     */
    function codeOf(buttonId) {
      if (!buttonId) return null;
      var id = String(buttonId);
      if (id.indexOf('key:') !== 0) return null;
      var code = idToCode[id];
      return code === undefined ? null : code;
    }

    return {
      KEYBOARD_GRID: KEYBOARD_GRID,
      NUMPAD_GRID: NUMPAD_GRID,
      fromHookKeycode: fromHookKeycode,
      fromHookMouseButton: fromHookMouseButton,
      describe: describe,
      describeKeyId: describeKeyId,
      isMouseId: isMouseId,
      toNutKey: toNutKey,
      toNutButton: toNutButton,
      mouseButtons: mouseButtons,
      gridKeys: gridKeys,
      validate: validate,
      codeToId: codeToId,
      idToCode: idToCode,
      codeOf: codeOf,
    };
  }

  /**
   * A renderer-side catalog built from a table the main process sends at
   * bootstrap.
   *
   * The renderer must validate/describe buttons SYNCHRONOUSLY while the user is
   * typing (the compiler runs on every workspace change for live error counts),
   * and `ipcRenderer.invoke` is async. So the main process exports a small
   * snapshot: button id -> { label, sim }. That is all the compiler needs.
   *
   * Simulation (`toNutKey` / `toNutButton`) deliberately does not exist here:
   * only the main process may touch the input library.
   */
  function createRemoteCatalog(table) {
    table = table || {};

    function lookup(id) {
      if (Object.prototype.hasOwnProperty.call(table, id)) return table[id];
      if (typeof id === 'string' && id.indexOf('mouse:') === 0) {
        var n = id.slice(6);
        return { label: 'Mouse button (code ' + n + ')', sim: false };
      }
      if (typeof id === 'string' && id.indexOf('key:') === 0) {
        return { label: prettify(id.slice(4)), sim: false };
      }
      return null;
    }

    function describe(id) {
      if (!id) return '(none)';
      var entry = lookup(id);
      return entry ? entry.label : String(id);
    }

    function validate(id) {
      if (!id) return { ok: false, reason: 'No button selected.', button: null };
      var entry = lookup(id);
      if (!entry) return { ok: false, reason: 'Unrecognised button id "' + id + '".', button: null };
      return {
        ok: true,
        reason: '',
        button: {
          kind: id.indexOf('mouse:') === 0 ? 'mouse' : 'key',
          id: id,
          label: entry.label,
          sim: Boolean(entry.sim),
          note: entry.sim ? '' : (entry.note || 'This input cannot be simulated by the input library.'),
        },
      };
    }

    return {
      describe: describe,
      validate: validate,
      describeKeyId: describe,
      isMouseId: function (id) {
        return typeof id === 'string' && id.indexOf('mouse:') === 0;
      },
      /** Snapshot entries, for the picker modal. */
      table: table,
      toNutKey: function () {
        throw new Error('Simulation is only available in the main process.');
      },
      toNutButton: function () {
        throw new Error('Simulation is only available in the main process.');
      },
    };
  }

  return {
    KEY_ALIASES: KEY_ALIASES,
    MOUSE_BUTTON_GUESS: MOUSE_BUTTON_GUESS,
    MOUSE_BUTTON_TO_NUT: MOUSE_BUTTON_TO_NUT,
    KEYBOARD_GRID: KEYBOARD_GRID,
    NUMPAD_GRID: NUMPAD_GRID,
    prettify: prettify,
    createCatalog: createCatalog,
    createRemoteCatalog: createRemoteCatalog,
  };
});
