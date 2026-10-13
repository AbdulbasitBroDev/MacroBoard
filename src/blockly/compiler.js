/**
 * MacroBlock - block compiler (Blockly workspace -> plain JSON step list)
 *
 * DESIGN NOTE (important)
 * -----------------------
 * The compiler works on Blockly's SERIALIZED JSON, not on live block objects.
 *
 * Why:
 *   1. The random/organized chooser keeps inactive pages as serialized JSON
 *      inside the block's extraState (see blocks.js). Compiling from JSON means
 *      live blocks and stashed pages go through exactly the same code path - no
 *      block instantiation, no temporary workspaces, no side effects.
 *   2. It makes the compiler pure and unit-testable: a test can feed plain JSON
 *      workspace state in and assert on the step list out.
 *
 * The engine never sees Blockly, and the editor never simulates input.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MB = root.MB || {};
    root.MB.compiler = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Raised for problems that make a macro unrunnable. */
  function CompileError(message) {
    var e = new Error(message);
    e.name = 'CompileError';
    e.isCompileError = true;
    return e;
  }

  /**
   * Build a compiler bound to a Blockly instance.
   *
   * @param {object} deps
   * @param {object} deps.Blockly
   * @param {object} deps.constants  shared/constants.js
   * @param {object} deps.catalog    shared/catalog.js
   * @param {object} deps.buttons    buttons catalog (createCatalog result)
   * @param {function} [deps.getMacroNames] () => string[] (live saved macro names)
   */
  function createCompiler(deps) {
    var env = {
      Blockly: deps.Blockly,
      C: deps.constants,
      catalog: deps.catalog,
      buttons: deps.buttons,
      expr: deps.expressions || null,
      getMacroNames: deps.getMacroNames || function () { return []; },
    };

    return {
      CompileError: CompileError,
      compileWorkspace: function (workspace, opts) {
        return compileWorkspace(env, workspace, opts);
      },
      compileSelection: function (workspace, opts) {
        return compileSelection(env, workspace, opts);
      },
      compileState: function (state, opts) {
        return wrap(compileStateBundle(env, state, opts));
      },
      findStartBlocks: function (workspace) {
        return findStartBlocks(env, workspace);
      },
      pickStartBlock: function (workspace) {
        return pickStartBlock(env, workspace);
      },
      describeStart: function (start) {
        return describeStart(env, start);
      },
      runButtonLabel: function (start) {
        return runButtonLabel(env, start);
      },
      /** True when this block type is a start block (a hat). */
      isStartType: function (type) {
        return isStartType(env.catalog, type);
      },
    };
  }

  // ------------------------------------------------------------- helpers

  function isStartType(catalog, t) {
    return catalog.START_TYPES.indexOf(t) !== -1;
  }

  /** Blockly stores an input as { block }, { shadow } or both. */
  function inputBlock(state, name) {
    var inputs = (state && state.inputs) || {};
    var inp = inputs[name];
    if (!inp) return null;
    return inp.block || inp.shadow || null;
  }

  function fieldValue(state, name, fallback) {
    var fields = (state && state.fields) || {};
    if (!Object.prototype.hasOwnProperty.call(fields, name)) return fallback;
    var v = fields[name];
    if (v && typeof v === 'object' && 'value' in v) return v.value;
    return v;
  }

  function numberField(state, name, fallback) {
    var n = Number(fieldValue(state, name, fallback));
    return isFinite(n) ? n : fallback;
  }

  /**
   * Read a number that may come from EITHER a plain field OR a socket holding
   * a value chip.
   *
   * Every input that takes a number is a socket now, so the user can drop a
   * number chip in. But macros saved before that change still carry plain
   * fields, and both shapes have to compile - hence the field fallback.
   *
   * Coordinates and durations compile to LITERAL constants (see the PIXEL/MOVE
   * cases below), so only chips that already have a value at compile time can
   * be inlined. A chip with no value until the macro runs ("random", "pixel")
   * cannot, and silently reading its shadow would click the wrong place - so
   * that gets a warning and an honest fallback.
   */
  function numInput(env, state, name, ctx, fallback) {
    var blk = inputBlock(state, name);
    if (!blk) return numberField(state, name, fallback); // legacy field
    if (blk.type === env.catalog.VALUE.NUMBER) return numberField(blk, 'NUM', fallback);
    ctx.warnings.push(
      'The "' + name + '" input on "' + label(state) + '" is fed by a chip whose value ' +
      'is not known until the macro runs, and this position must be a fixed number. ' +
      'Using ' + fallback + ' instead.'
    );
    return fallback;
  }

  /**
   * Read a checkbox field.
   *
   * Defaults to TRUE when the field is absent. Every macro saved before the
   * "pass this button through" switch existed must keep its old behaviour, and
   * the old behaviour was to let the press through untouched.
   */
  function checkboxField(state, name, fallback) {
    var fields = (state && state.fields) || {};
    if (!Object.prototype.hasOwnProperty.call(fields, name)) return fallback;
    var v = fieldValue(state, name, fallback);
    // Blockly serialises a FieldCheckbox as "TRUE"/"FALSE", but a hand-edited
    // or hand-written state may use a real boolean.
    if (typeof v === 'boolean') return v;
    return !(v === false || v === 'FALSE' || v === 'false' || v === 0);
  }

  function textField(state, name, fallback) {
    var raw = fieldValue(state, name, fallback);
    return raw === undefined || raw === null ? fallback : String(raw);
  }

  function label(state) {
    return state && state.type ? state.type.replace(/^mb_/, '').replace(/_/g, ' ') : 'block';
  }

  /**
   * Multiply a numeric slot by a factor (used by "wait N seconds").
   *
   * All three slot kinds are plain numbers or a random range, so the scaling
   * and the cap can both happen here at compile time.
   */
  function scaleSlot(env, slot, factor, cap, ctx, state, what) {
    var SLOT = env.C.SLOT;
    if (!slot || slot.kind === SLOT.FOREVER) return slot || { kind: SLOT.NUMBER, value: 0 };
    if (slot.kind === SLOT.RANGE) {
      return {
        kind: SLOT.RANGE,
        min: Math.min(cap, Math.round(slot.min * factor)),
        max: Math.min(cap, Math.round(slot.max * factor)),
      };
    }
    var ms = Math.round(slot.value * factor);
    if (ms > cap) {
      ctx.warnings.push(
        'The ' + what + ' on "' + label(state) + '" was capped to the ' + cap / 1000 +
          '-second maximum (engine safety limit).'
      );
      ms = cap;
    }
    return { kind: SLOT.NUMBER, value: ms };
  }

  /** Value chips: plain number / forever / between. */
  function isChip(env, type) {
    var V = env.catalog.VALUE;
    return type === V.NUMBER || type === V.FOREVER || type === V.RANGE;
  }

  /** Pixel tolerance is 0-255 per channel; the shared rule lives in pixels.js. */
  function pxClamp(t) {
    var n = Math.floor(Number(t));
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(255, n);
  }

  /**
   * Compile one Logic reporter (or a value chip) into an expression node.
   *
   * Chips are handled here too, so a chip dropped inside `(a) > (b)` behaves
   * exactly like a typed number.
   *
   * @param {string} what  what the value is FOR, used only in error text.
   */
  function compileExpr(env, state, ctx, what) {
    var OP = env.expr.OP;
    var catalog = env.catalog;
    var C = env.C;

    var COMP_OP = {};
    COMP_OP[catalog.LOGIC.EQUALS] = OP.EQ;
    COMP_OP[catalog.LOGIC.GREATER] = OP.GT;
    COMP_OP[catalog.LOGIC.LESS] = OP.LT;

    if (!state) {
      ctx.warnings.push('The "' + what + '" socket is empty; using 0.');
      return env.expr.num(0);
    }

    if (state.type === catalog.VALUE.FOREVER) {
      // `forever` is a socket modifier, not a value, so it can never be an
      // operand - even nested inside a comparison rather than sitting in the
      // outer socket where readSlot checks for it.
      ctx.errors.push(
        'The "' + what + '" holds "forever", which only makes sense as a whole socket ' +
          '(a repeat count, a duration or a press count). Drop a number or a "between" chip in instead.'
      );
      return env.expr.num(0);
    }

    if (state.type === catalog.LOGIC.PIXEL_IS) {
      // A leaf, not a branch: the coordinates are plain FIELDS rather than
      // sockets (they mirror the pixel trigger, and every field that would
      // carry real data is a field - see catalog.js). So there is nothing to
      // recurse into, and the engine resolves it from one batched capture.
      return {
        e: OP.PIXEL,
        x: numInput(env, state, 'X', ctx, 0),
        y: numInput(env, state, 'Y', ctx, 0),
        colour: textField(state, 'COLOUR', '#ffffff'),
        tol: pxClamp(numInput(env, state, 'TOLERANCE', ctx, C.PIXEL.DEFAULT_TOLERANCE)),
      };
    }

    if (state.type in COMP_OP) {
      return {
        e: COMP_OP[state.type],
        a: compileExpr(env, inputBlock(state, 'A'), ctx, 'first value'),
        b: compileExpr(env, inputBlock(state, 'B'), ctx, 'second value'),
      };
    }

    switch (state.type) {
      case catalog.VALUE.NUMBER:
        return env.expr.num(numberField(state, 'NUM', 0));
      case catalog.VALUE.RANGE:
        return env.expr.rand(
          env.expr.num(numberField(state, 'MIN', 0)),
          env.expr.num(numberField(state, 'MAX', 100)),
          0
        );
      case catalog.LOGIC.AND:
      case catalog.LOGIC.OR:
        return {
          e: state.type === catalog.LOGIC.AND ? OP.AND : OP.OR,
          a: compileExpr(env, inputBlock(state, 'A'), ctx, 'first value'),
          b: compileExpr(env, inputBlock(state, 'B'), ctx, 'second value'),
        };
      case catalog.LOGIC.NOT:
        return { e: OP.NOT, a: compileExpr(env, inputBlock(state, 'A'), ctx, 'value') };
      default:
        ctx.errors.push(
          'The "' + what + '" socket holds "' + state.type +
            '", which is not a number or a Logic block. Drop a plain number, a "between" chip, or ' +
            'a comparison in instead.'
        );
        return env.expr.num(0);
    }
  }

  /**
   * Read a numeric socket.
   *
   * CHIPS ONLY. A Logic block cannot go here - it outputs `Boolean` and Blockly
   * refuses the connection, which is correct: `wait (a) > (b)` would mean
   * "wait 1ms" or "wait 0ms" depending on the answer, which is never what
   * anyone means. Conditions belong in an `if` condition socket.
   */
  function readSlot(env, state, inputName, ctx, opts) {
    var SLOT = env.C.SLOT;
    var numeric = inputBlock(state, inputName);
    if (numeric && !isChip(env, numeric.type)) {
      ctx.errors.push(
        'The ' + opts.what + ' socket on "' + label(state) + '" holds "' + numeric.type +
          '", which is not a value chip. Numeric sockets take a plain number, "forever" or "between". ' +
          'A comparison belongs in an "if" condition instead.'
      );
      return { kind: SLOT.NUMBER, value: 0 };
    }
    if (!numeric) {
      ctx.warnings.push(
        'The "' + opts.what + '" socket on "' + label(state) + '" is empty; using 0.'
      );
      return { kind: SLOT.NUMBER, value: 0 };
    }
    if (numeric.type === env.catalog.VALUE.NUMBER) {
      var n = numberField(numeric, 'NUM', 0);
      if (n > opts.cap) {
        ctx.warnings.push(
          'The ' + opts.what + ' on "' + label(state) + '" was capped from ' + n + ' to ' + opts.cap +
            ' by the engine safety limit.'
        );
      }
      return { kind: SLOT.NUMBER, value: n };
    }
    if (numeric.type === env.catalog.VALUE.FOREVER) {
      return { kind: SLOT.FOREVER };
    }
    if (numeric.type === env.catalog.VALUE.RANGE) {
      var min = numberField(numeric, 'MIN', 0);
      var max = numberField(numeric, 'MAX', 100);
      if (min > max) {
        ctx.warnings.push(
          'The ' + opts.what + ' range on "' + label(state) + '" was entered as ' + min + '..' + max +
            '; the two ends were swapped for you.'
        );
      }
      return { kind: SLOT.RANGE, min: min, max: max };
    }
    ctx.errors.push(
      'The ' + opts.what + ' socket on "' + label(state) + '" holds "' + numeric.type +
        '", which is not a number / "forever" / "between" chip. Remove it and drop a value chip in.'
    );
    return { kind: SLOT.NUMBER, value: 0 };
  }

  /**
   * Read + validate a button field.
   * @param {string} mode 'action' buttons must be simulatable; 'trigger' accepts
   *                      anything the machine can detect.
   * @param {'key'|'mouse'|null} [kind] the block's required input kind, if any.
   *   Catching the mismatch HERE means a macro saved with the wrong input reports
   *   a clear compile error, rather than dying at run time inside the input
   *   library with an opaque message.
   */
  function readButton(env, state, fieldName, mode, ctx, kind) {
    var id = fieldValue(state, fieldName, '');
    var v = env.buttons.validate(id);
    if (!v.ok) {
      ctx.errors.push('"' + label(state) + '" has no button chosen (' + v.reason + ')');
      return '';
    }
    if (mode === 'action' && !v.button.sim) {
      ctx.errors.push(
        '"' + label(state) + '" tries to press "' + v.button.label + '", which this machine can detect ' +
          'but the input simulation library cannot perform. Pick a supported button for an action, or use ' +
          'that input as a trigger instead.'
      );
      return '';
    }
    var isMouse = env.buttons.isMouseId(id);
    if (kind === 'mouse' && !isMouse) {
      ctx.errors.push(
        '"' + label(state) + '" is a click, so it needs a MOUSE button, but "' + v.button.label +
          '" is a key. Pick a mouse button for this block.'
      );
      return '';
    }
    if (kind === 'key' && isMouse) {
      ctx.errors.push(
        '"' + label(state) + '" needs a KEYBOARD key, but "' + v.button.label + '" is a mouse button.'
      );
      return '';
    }
    return id;
  }

  function wrap(bundle) {
    var triggers = bundle.triggers || [];
    return {
      ok: bundle.errors.length === 0,
      // `start` and `steps` remain the FIRST trigger, so every existing consumer
      // (and all the tests) keep working unchanged. `triggers` is the full list.
      start: bundle.start || null,
      steps: bundle.steps || [],
      triggers: triggers,
      warnings: bundle.warnings,
      errors: bundle.errors,
      /** Human-readable one-liner for the UI / logs. */
      summary: bundle.errors.length
        ? bundle.errors[0]
        : (bundle.steps ? bundle.steps.length : 0) + ' step(s) compiled',
    };
  }

  function newCtx() {
    return {
      warnings: [],
      errors: [],
      /**
       * Stack of the loops currently being compiled, innermost last.
       *
       * This is how `break` and `continue` know which loop they belong to - the
       * only place block structure is knowable. The engine works it out at run
       * time by consuming the signal at the nearest loop instead, so this stack
       * is a COMPILE-time check only: it turns "a break with no loop above it"
       * into a clear error rather than a block that quietly does nothing.
       *
       * Deliberately survives across a chooser's pages: a break inside a chooser
       * body is inside the loop that contains the chooser, and should break it.
       */
      loopStack: [],
    };
  }

  /** Compile a loop body with the given loop pushed onto the scope stack. */
  function withLoopScope(env, ctx, state, what) {
    ctx.loopStack.push({ type: state.type, what: what });
    try {
      return compileBody(env, state, ctx);
    } finally {
      ctx.loopStack.pop();
    }
  }

  /**
   * `break` / `continue` compile to a payload-free marker step.
   *
   * Not `null`: the engine only ever runs compiled step lists, so emitting
   * nothing here would mean the engine never learns a break was written and
   * every loop runs to completion. The step carries no data because it cannot -
   * only the enclosing loop knows what it should stop, and the loop is what
   * consumes the resulting FLOW signal.
   */
  function compileFlowControl(env, state, ctx, name) {
    if (ctx.loopStack.length === 0) {
      ctx.errors.push(
        '"' + name + '" has no loop to ' + (name === 'break' ? 'leave' : 'continue') + '. ' +
          'It only works inside "repeat N times", "repeat until <condition>", or an "at once" that is ' +
          'itself inside a loop.'
      );
    }
    return { type: name === 'break' ? env.C.STEP.BREAK : env.C.STEP.CONTINUE };
  }

  // ------------------------------------------------------ start blocks

  /** Turn a start-block state into a trigger descriptor. */
  function buildStart(env, state, ctx) {
    var START = env.catalog.START;
    var C = env.C;
    switch (state.type) {
      case START.RUN:
        return { kind: C.START.MANUAL, type: state.type };
      case START.PRESS:
        return {
          kind: C.START.BUTTON_COUNT,
          type: state.type,
          button: readButton(env, state, 'BUTTON', 'trigger', ctx),
          // false = the button is a pure trigger and must not be entered anywhere.
          suppress: !checkboxField(state, 'SUPPRESS', true),
          count: readSlot(env, state, 'COUNT', ctx, {
            what: 'trigger count',
            cap: C.LIMITS.MAX_PRESS_COUNT,
          }),
        };
      case START.HOLD:
        return {
          kind: C.START.HOLD_BUTTON,
          type: state.type,
          button: readButton(env, state, 'BUTTON', 'trigger', ctx),
          suppress: !checkboxField(state, 'SUPPRESS', true),
        };
      case START.PIXEL:
        return {
          kind: C.START.PIXEL,
          type: state.type,
          x: numInput(env, state, 'X', ctx, 0),
          y: numInput(env, state, 'Y', ctx, 0),
          colour: textField(state, 'COLOUR', '#ffffff'),
          tolerance: Math.max(0, Math.min(255, numInput(env, state, 'TOLERANCE', ctx, 0))),
          pollMs: Math.max(
            C.PIXEL.MIN_POLL_MS,
            Math.min(C.PIXEL.MAX_POLL_MS, numInput(env, state, 'POLL', ctx, C.PIXEL.DEFAULT_POLL_MS))
          ),
        };
      case START.EVERY:
        return {
          kind: C.START.EVERY,
          type: state.type,
          // Clamped rather than rejected: a too-small interval is a typo, and
          // quietly honouring 0 would mean spinning the event loop forever.
          seconds: Math.max(
            C.SCHEDULE.MIN_INTERVAL_SECONDS,
            Math.min(C.SCHEDULE.MAX_INTERVAL_SECONDS, numInput(env, state, 'EVERY', ctx, C.SCHEDULE.DEFAULT_INTERVAL_SECONDS))
          ),
        };
      case START.AT:
        return {
          kind: C.START.AT,
          type: state.type,
          hour: Math.max(C.SCHEDULE.MIN_CLOCK_HOUR, Math.min(C.SCHEDULE.MAX_CLOCK_HOUR, Math.round(numInput(env, state, 'HOUR', ctx, 9)))),
          minute: Math.max(C.SCHEDULE.MIN_CLOCK_MINUTE, Math.min(C.SCHEDULE.MAX_CLOCK_MINUTE, Math.round(numInput(env, state, 'MINUTE', ctx, 0)))),
        };
      case START.SCROLL:
        return {
          kind: C.START.SCROLL,
          type: state.type,
          // Anything that is not explicitly "up" means "down", so a hand-edited
          // or older file can never produce a trigger that never fires.
          direction: textField(state, 'DIR', C.SCROLL.DOWN) === C.SCROLL.UP ? C.SCROLL.UP : C.SCROLL.DOWN,
        };
      default:
        ctx.errors.push('Unsupported start block "' + state.type + '".');
        return null;
    }
  }

  function describeStart(env, start) {
    var C = env.C;
    if (!start) return 'no start block';
    switch (start.kind) {
      case C.START.MANUAL:
        return 'when Run is pressed';
      case C.START.BUTTON_COUNT: {
        var n = start.count && start.count.kind === 'forever'
          ? 'forever'
          : (start.count ? start.count.value : 0);
        return 'when ' + env.buttons.describe(start.button) + ' is pressed ' + n + 'x';
      }
      case C.START.HOLD_BUTTON:
        return 'while holding ' + env.buttons.describe(start.button);
      case C.START.PIXEL:
        return 'when pixel (' + start.x + ',' + start.y + ') becomes ' + start.colour;
      case C.START.EVERY:
        return 'every ' + start.seconds + 's';
      case C.START.SCROLL:
        return 'when scrolled ' + start.direction;
      case C.START.AT: {
        var hh = String(start.hour);
        var mm = String(start.minute);
        if (hh.length < 2) hh = '0' + hh;
        if (mm.length < 2) mm = '0' + mm;
        return 'at ' + hh + ':' + mm;
      }
      default:
        return String(start.kind);
    }
  }

  /** Label for the primary toolbar button, which follows the start block. */
  function runButtonLabel(env, start) {
    var C = env.C;
    if (!start) return 'Run';
    if (start.kind === C.START.MANUAL) return 'Run';
    if (start.kind === C.START.PIXEL) return 'Watch';
    // A timer is armed, not run: pressing the button should not fire it early.
    if (start.kind === C.START.EVERY || start.kind === C.START.AT) return 'Arm';
    return 'Arm';
  }

  // ------------------------------------------------------- step compile

  function compileBody(env, state, ctx) {
    return compileChain(env, inputBlock(state, 'DO'), ctx);
  }

  function compileChain(env, firstState, ctx) {
    var steps = [];
    var cur = firstState;
    var guard = 0;
    while (cur && guard++ < 5000) {
      var s = compileOne(env, cur, ctx);
      if (s) {
        if (Array.isArray(s)) steps.push.apply(steps, s);
        else steps.push(s);
      }
      cur = cur.next && cur.next.block ? cur.next.block : null;
    }
    return steps;
  }

  /**
   * Bundle a single top-level block state (or start block state) into steps.
   * This is the single entry point shared by live compilation and by the
   * compiler tests.
   */
  function compileStateBundle(env, state, opts) {
    opts = opts || {};
    var ctx = newCtx();
    if (!state) {
      ctx.errors.push('Nothing to compile.');
      return { start: null, steps: [], warnings: ctx.warnings, errors: ctx.errors };
    }

    if (isStartType(env.catalog, state.type)) {
      var start = buildStart(env, state, ctx);
      var bodySteps = compileBody(env, state, ctx);
      return { start: start, steps: bodySteps, warnings: ctx.warnings, errors: ctx.errors };
    }

    var steps = compileOne(env, state, ctx);
    var list = steps ? (Array.isArray(steps) ? steps : [steps]) : [];
    // Continue along the `next` chain so a selected stack compiles as a whole.
    if (state.next && state.next.block) {
      list = list.concat(compileChain(env, state.next.block, ctx));
    }
    return { start: null, steps: list, warnings: ctx.warnings, errors: ctx.errors };
  }

  // ------------------------------------------------------- per-block compile

  function compileOne(env, state, ctx) {
    var C = env.C;
    var STEP = C.STEP;
    var SLOT = C.SLOT;
    var catalog = env.catalog;

    switch (state.type) {
      case catalog.MOUSE.CLICK:
        return {
          type: STEP.CLICK,
          button: readButton(env, state, 'BUTTON', 'action', ctx, 'mouse'),
          x: numInput(env, state, 'X', ctx, 0),
          y: numInput(env, state, 'Y', ctx, 0),
        };
      case catalog.MOUSE.MOVE_TO:
        return {
          type: STEP.MOVE_TO,
          x: numInput(env, state, 'X', ctx, 0),
          y: numInput(env, state, 'Y', ctx, 0),
          // Absent from macros saved before this field existed; 0 means the old
          // teleport behaviour, which is what those macros already did.
          ms: Math.max(0, Math.min(C.LIMITS.MAX_MOVE_MS, numInput(env, state, 'MS', ctx, 0))),
        };
case catalog.MOUSE.MOVE_BY:
  return {
  type: STEP.MOVE_BY,
  dx: numInput(env, state, 'DX', ctx, 0),
  dy: numInput(env, state, 'DY', ctx, 0),
  ms: Math.max(0, Math.min(C.LIMITS.MAX_MOVE_MS, numInput(env, state, 'MS', ctx, 200))),
  };
  case catalog.MOUSE.MOVE_WITHIN:
  return {
  type: STEP.MOVE_WITHIN,
  x1: numInput(env, state, 'X1', ctx, 0),
  x2: numInput(env, state, 'X2', ctx, 200),
  y1: numInput(env, state, 'Y1', ctx, 0),
  y2: numInput(env, state, 'Y2', ctx, 200),
  ms: Math.max(0, Math.min(C.LIMITS.MAX_MOVE_MS, numInput(env, state, 'MS', ctx, 200))),
  };
      case catalog.MOUSE.SCROLL: {
        var dir = textField(state, 'DIR', C.SCROLL.DOWN) === C.SCROLL.UP ? C.SCROLL.UP : C.SCROLL.DOWN;
        return {
          type: STEP.SCROLL,
          direction: dir,
          px: Math.max(C.SCROLL.MIN_PX, Math.min(C.SCROLL.MAX_PX, numInput(env, state, 'PX', ctx, C.SCROLL.DEFAULT_PX))),
          ms: Math.max(0, Math.min(C.SCROLL.MAX_MS, numInput(env, state, 'MS', ctx, C.SCROLL.DEFAULT_MS))),
        };
      }
      case catalog.KEYBOARD.TYPE:
        return { type: STEP.TYPE_TEXT, text: textField(state, 'TEXT', '') };
      case catalog.KEYBOARD.PRESS:
        // Single press, no count field at all - count is fixed at 1.
        return {
          type: STEP.PRESS_KEY,
          button: readButton(env, state, 'BUTTON', 'action', ctx),
          count: { kind: SLOT.NUMBER, value: 1 },
          gapMs: { kind: SLOT.NUMBER, value: 0 },
        };
      case catalog.KEYBOARD.PRESS_TIMES:
        return {
          type: STEP.PRESS_KEY,
          button: readButton(env, state, 'BUTTON', 'action', ctx),
          count: readSlot(env, state, 'COUNT', ctx, {
            what: 'press count',
            cap: C.LIMITS.MAX_PRESS_COUNT,
          }),
          gapMs: readSlot(env, state, 'GAP', ctx, { what: 'ms gap', cap: C.LIMITS.MAX_GAP_MS }),
        };
      case catalog.KEYBOARD.HOLD:
        return {
          type: STEP.HOLD_KEY,
          button: readButton(env, state, 'BUTTON', 'action', ctx),
          ms: readSlot(env, state, 'MS', ctx, {
            what: 'hold duration',
            cap: C.LIMITS.MAX_DURATION_MS,
          }),
        };
      case catalog.CONTROL.WAIT:
        return {
          type: STEP.WAIT,
          // The block reads in SECONDS ("wait 2" = two seconds); the step list is
          // always milliseconds, so the conversion happens here.
          ms: scaleSlot(
            env,
            readSlot(env, state, 'MS', ctx, {
              what: 'wait duration (seconds)',
              cap: C.LIMITS.MAX_WAIT_MS / 1000,
            }),
            1000,
            C.LIMITS.MAX_WAIT_MS,
            ctx,
            state,
            'wait duration'
          ),
        };
      case catalog.CONTROL.WAIT_MS:
        return {
          type: STEP.WAIT,
          // The block already reads in MILLISECONDS, so it is NOT scaled. Both
          // wait blocks produce this same step; only the units on screen differ.
          // Rounding happens here (not in the field) so "wait 0.5 ms" is 1ms
          // rather than a fractional duration the engine cannot represent.
          ms: scaleSlot(
            env,
            readSlot(env, state, 'MS', ctx, {
              what: 'wait duration (ms)',
              cap: C.LIMITS.MAX_WAIT_MS,
            }),
            1,
            C.LIMITS.MAX_WAIT_MS,
            ctx,
            state,
            'wait duration'
          ),
        };
      case catalog.CONTROL.REPEAT:
        return {
          type: STEP.REPEAT,
          count: readSlot(env, state, 'COUNT', ctx, {
            what: 'repeat count',
            cap: C.LIMITS.MAX_REPEAT_COUNT,
          }),
          body: withLoopScope(env, ctx, state, 'repeat N times'),
        };
      case catalog.CONTROL.REPEAT_UNTIL:
        return compileRepeatUntil(env, state, ctx);
      case catalog.CONTROL.BREAK:
        return compileFlowControl(env, state, ctx, 'break');
      case catalog.CONTROL.CONTINUE:
        return compileFlowControl(env, state, ctx, 'continue');
      case catalog.CONTROL.AT_ONCE:
        return { type: STEP.AT_ONCE, body: compileBody(env, state, ctx) };
      case catalog.CONTROL.RUN_MACRO:
        return compileRunMacro(env, state, ctx);
      case catalog.CONTROL.RANDOM_CHOOSER:
        return compileChooser(env, state, ctx, 'random');
      case catalog.CONTROL.ORGANIZED_CHOOSER:
        return compileChooser(env, state, ctx, 'organized');
      case catalog.CONTROL.IF:
        return compileIf(env, state, ctx);
      case catalog.CONTROL.WAIT_FOR_WINDOW:
        return compileWaitForWindow(env, state, ctx);
      default:
        if (isReporter(env.catalog, state.type)) {
          ctx.errors.push(
            '"' + label(state) + '" is a value block - it produces a number or a true/false. ' +
              'Drop it into a socket instead of stacking it under another block.'
          );
          return null;
        }
        if (isStartType(catalog, state.type)) {
          ctx.errors.push(
            '"' + label(state) + '" is a start block and can only sit at the top level of the ' +
              'workspace - it cannot be nested inside another block.'
          );
          return null;
        }
        ctx.errors.push('Unknown block type "' + state.type + '" - it cannot be compiled.');
        return null;
    }
  }

  function isReporter(catalog, type) {
    return catalog.REPORTERS.indexOf(type) !== -1 || Object.values(catalog.VALUE).indexOf(type) !== -1;
  }

  /**
   * `if / else`.
   *
   * Both branches compile to step lists. An absent or empty ELSE branch
   * compiles to [], which the engine treats as "do nothing" - that is cheaper
   * than emitting a distinct step type and keeps a plain `if` readable in the
   * compiled output.
   */
  function compileIf(env, state, ctx) {
    var condState = inputBlock(state, 'COND');
    var cond;
    if (!condState) {
      // Blockly's Boolean-checked socket makes this nearly impossible to reach
      // by dragging (an empty socket refuses a drop), but a hand-edited or
      // hand-written macro state can still arrive with nothing in it.
      ctx.errors.push(
        '"if" has no condition. Drop a comparison or a logic block into its <> socket.'
      );
      cond = env.expr.lit(false);
    } else {
      cond = compileExpr(env, condState, ctx, 'condition on "' + label(state) + '"');
    }

    return {
      type: env.C.STEP.IF,
      cond: cond,
      then: compileChain(env, inputBlock(state, 'THEN'), ctx),
      else: compileChain(env, inputBlock(state, 'ELSE'), ctx),
    };
  }

  /**
   * `repeat until <condition>`.
   *
   * The condition is a Logic reporter, so a pixel check or a comparison drops
   * straight in. The engine re-evaluates it before every pass, which is what
   * makes a loop like "do this until the pixel turns green" possible.
   */
  function compileRepeatUntil(env, state, ctx) {
    var condState = inputBlock(state, 'COND');
    var cond;
    if (!condState) {
      // The Boolean-checked socket refuses a drop, so this only happens for a
      // hand-edited saved macro - but it must still be an error, because a
      // condition-less loop is a hang.
      ctx.errors.push(
        '"repeat until" has no condition. Drop a comparison, a logic block, or a pixel check into ' +
          'its <> socket.'
      );
      cond = env.expr.lit(false);
    } else {
      cond = compileExpr(env, condState, ctx, 'condition on "' + label(state) + '"');
    }
    return {
      type: env.C.STEP.REPEAT_UNTIL,
      cond: cond,
      body: withLoopScope(env, ctx, state, 'repeat until'),
    };
  }

  /**
   * `wait until window titled "…" exists`.
   *
   * The timeout is validated rather than defaulted. A wait with no timeout is a
   * permanent hang, and the `forever` chip in the timeout socket would be read
   * as "wait forever for the app" - which is the wrong thing to mean when the
   * app was never going to open.
   */
  function compileWaitForWindow(env, state, ctx) {
    var C = env.C;
    var SLOT = env.C.SLOT;
    var title = textField(state, 'TITLE', '').trim();
    if (!title) {
      ctx.errors.push(
        '"wait until window" has no title to look for. Type part of the window title, e.g. "Notepad".'
      );
    }
    var timeout = readSlot(env, state, 'TIMEOUT', ctx, {
      what: 'timeout',
      cap: C.LIMITS.MAX_DURATION_MS,
    });
    if (timeout.kind === SLOT.FOREVER) {
      ctx.errors.push(
        '"wait until window" cannot use "forever" as its timeout - that would wait forever for an app ' +
          'that may never open. Use a number of seconds, and pick one you would be willing to wait.'
      );
      return { type: env.C.STEP.WAIT_FOR_WINDOW, title: title, timeoutMs: { kind: SLOT.NUMBER, value: 0 }, pollMs: C.LIMITS.WINDOW_POLL.DEFAULT_MS };
    }

    // The block now shows SECONDS ("in the next 8 s"), but macros saved before
    // that change carry a TIMEOUT socket in MILLISECONDS, possibly holding a
    // random "between" chip. The socket is still read so an old macro keeps the
    // wait the user actually chose instead of silently snapping to the default.
    //
    // A legacy RANGE is passed through untouched - it means "somewhere between
    // these two millisecond values", which has no meaningful second-unit form
    // and must keep working exactly as before.
    var timeoutSlot;
    if (state && state.fields && Object.prototype.hasOwnProperty.call(state.fields, 'TIMEOUT_S')) {
      var secs = Math.max(1, Math.min(C.WINDOW.MAX_WAIT_SECONDS, numInput(env, state, 'TIMEOUT_S', ctx, C.WINDOW.DEFAULT_WAIT_SECONDS)));
      timeoutSlot = { kind: SLOT.NUMBER, value: Math.max(1, Math.min(C.LIMITS.MAX_DURATION_MS, Math.ceil(secs * 1000))) };
    } else if (timeout.kind === SLOT.RANGE) {
      timeoutSlot = timeout;
    } else if (timeout.kind === SLOT.NUMBER && timeout.value) {
      // Fractional seconds round-trip exactly, so a saved 8500ms stays 8500ms.
      timeoutSlot = { kind: SLOT.NUMBER, value: timeout.value };
    } else {
      timeoutSlot = {
        kind: SLOT.NUMBER,
        value: Math.max(1, Math.min(C.LIMITS.MAX_DURATION_MS, C.WINDOW.DEFAULT_WAIT_SECONDS * 1000)),
      };
    }
    var poll = Math.max(
      C.LIMITS.WINDOW_POLL.MIN_MS,
      Math.min(C.LIMITS.WINDOW_POLL.MAX_MS, numInput(env, state, 'POLL', ctx, C.LIMITS.WINDOW_POLL.DEFAULT_MS))
    );
    return {
      type: env.C.STEP.WAIT_FOR_WINDOW,
      title: title,
      timeoutMs: timeoutSlot,
      pollMs: poll,
    };
  }

  function compileRunMacro(env, state, ctx) {
    var name = textField(state, 'MACRO', '');
    if (!name) {
      ctx.errors.push(
        '"run another macro" has no macro selected. Open its dropdown and pick a saved macro.'
      );
      return { type: env.C.STEP.RUN_MACRO, name: '' };
    }
    // Soft warning only - the macro may legitimately be created later, and the
    // engine reports a hard, clear error if it is genuinely missing at run time.
    var names = env.getMacroNames() || [];
    if (names.length && names.indexOf(name) === -1) {
      ctx.warnings.push(
        '"run another macro" refers to "' + name + '", which is not currently saved. ' +
          'It may have been renamed or deleted.'
      );
    }
    return { type: env.C.STEP.RUN_MACRO, name: name };
  }

  /**
   * Chooser pages.
   *
   * The active page lives in the block's statement input while the other pages
   * are stashed as serialized JSON inside extraState (see blocks.js). We merge
   * the two here so the caller sees a uniform array of page step-lists.
   */
  function compileChooser(env, state, ctx, mode) {
    var extra = state.extraState || {};
    var rawPages = Array.isArray(extra.pages) ? extra.pages.slice() : [];
    var active = typeof extra.active === 'number' ? extra.active : 0;
    var live = inputBlock(state, 'DO');
    if (rawPages.length === 0) rawPages = [null, null];

    // Merge: the live page always wins over whatever is stashed for that slot.
    if (active >= 0 && active < rawPages.length) rawPages[active] = live || null;

    var pages = rawPages.map(function (pageState) {
      return pageState ? compileChain(env, pageState, ctx) : [];
    });

    var nonEmpty = pages.filter(function (p) { return p.length > 0; }).length;
    if (nonEmpty === 0) {
      ctx.warnings.push('The "' + mode + ' chooser" has no blocks on any page, so it does nothing.');
    }

    return {
      type: env.C.STEP.CHOOSER,
      mode: mode,
      // The block's own id is what makes the organized chooser's "next page"
      // cursor persistent across runs and app restarts.
      id: state.id || 'chooser',
      pages: pages,
      pageCount: pages.length,
    };
  }

  // ------------------------------------------------------- workspace level

  /** Every start block in the workspace, in a deterministic order. */
  function findStartBlocks(env, workspace) {
    var found = [];
    env.catalog.START_TYPES.forEach(function (type) {
      var blocks = workspace.getBlocksByType(type, false) || [];
      blocks.forEach(function (b) {
        found.push(b);
      });
    });
    // Top-most (then left-most) wins, so the choice is predictable and visible.
    found.sort(function (a, b) {
      var pa = posOf(a);
      var pb = posOf(b);
      if (pa.y !== pb.y) return pa.y - pb.y;
      if (pa.x !== pb.x) return pa.x - pb.x;
      return String(a.id) < String(b.id) ? -1 : 1;
    });
    return found;
  }

  function posOf(block) {
    try {
      if (typeof block.getRelativeToSurfaceXY === 'function') {
        var p = block.getRelativeToSurfaceXY();
        if (p && isFinite(p.x) && isFinite(p.y)) return { x: p.x, y: p.y };
      }
    } catch (e) {
      /* headless workspaces have no surface position */
    }
    return { x: 0, y: 0 };
  }

  /**
   * The single start block that is actually armed.
   *
   * The spec says "pick ONE per workspace". Rather than destroying the user's
   * work when a second hat is dropped in, the top-most start block wins and the
   * UI surfaces a warning that the others are ignored.
   */
  function pickStartBlock(env, workspace) {
    var all = findStartBlocks(env, workspace);
    return all.length ? all[0] : null;
  }

  function saveStateOf(env, block) {
    return env.Blockly.serialization.blocks.save(block, { addCoordinates: false });
  }

  /**
   * Compile the whole workspace: the armed start block plus its body.
   * @return {{ok:boolean,start:object|null,steps:object[],warnings:string[],errors:string[]}}
   */
  function compileWorkspace(env, workspace, opts) {
    opts = opts || {};
    var ctx = newCtx();
    var starts = findStartBlocks(env, workspace);

    if (starts.length === 0) {
      ctx.errors.push(
        'This macro has no start block, so there is nothing to run. Drag one in from the Start category.'
      );
      return wrap({ start: null, steps: [], triggers: [], warnings: ctx.warnings, errors: ctx.errors });
    }

    // EVERY start block is compiled and armed, not just the top-most one. Each hat
    // has its own DO body, so each becomes its own independent trigger. An error in
    // one trigger is collected rather than aborting the others, so a single broken
    // hat cannot make the whole macro uncompilable.
    var triggers = [];
    starts.forEach(function (block) {
      var one = compileStateBundle(env, saveStateOf(env, block), opts);
      triggers.push({
        id: String(block.id),
        type: block.type,
        start: one.start,
        steps: one.steps,
        warnings: one.warnings,
        errors: one.errors,
      });
      one.warnings.forEach(function (w) { ctx.warnings.push(w); });
      one.errors.forEach(function (e) { ctx.errors.push(e); });
    });

    var first = triggers[0];
    return wrap({
      start: first.start,
      steps: first.steps,
      triggers: triggers.map(function (t) {
        return { id: t.id, type: t.type, start: t.start, steps: t.steps };
      }),
      warnings: ctx.warnings,
      errors: ctx.errors,
    });
  }

  /**
   * Compile an ad-hoc selection of blocks - this powers "Run selected", which
   * doubles as "test one block without running the whole macro".
   *
   * Blocks whose ancestor is also selected are skipped so a nested stack is not
   * executed twice.
   */
  function compileSelection(env, workspace, opts) {
    opts = opts || {};
    var ctx = newCtx();
    var blocks = opts.blocks || [];

    var selectedIds = {};
    blocks.forEach(function (b) {
      if (b) selectedIds[b.id] = true;
    });

    var roots = blocks.filter(function (b) {
      if (!b) return false;
      // Walk up: if any ancestor is also selected, this block is covered by it.
      var parent = b.getSurroundParent && b.getSurroundParent();
      while (parent) {
        if (selectedIds[parent.id]) return false;
        parent = parent.getSurroundParent && parent.getSurroundParent();
      }
      // A start block in a selection only contributes its body.
      return true;
    });

    var steps = [];
    var start = null;
    roots.forEach(function (b) {
      var bundle = compileStateBundle(env, saveStateOf(env, b), opts);
      if (bundle.start && !start) start = bundle.start;
      steps = steps.concat(bundle.steps);
      bundle.warnings.forEach(function (w) { ctx.warnings.push(w); });
      bundle.errors.forEach(function (e) { ctx.errors.push(e); });
    });

    if (!roots.length && !ctx.errors.length) {
      ctx.errors.push('Nothing is selected.');
    }

    return wrap({ start: start, steps: steps, warnings: ctx.warnings, errors: ctx.errors });
  }

  return { createCompiler: createCompiler, CompileError: CompileError };
});



