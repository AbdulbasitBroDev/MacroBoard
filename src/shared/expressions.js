/**
 * MacroBoard - shared expression evaluator
 *
 * The single evaluator behind every Logic block. It exists because the same
 * expression has to produce the same answer in three places:
 *
 *   - the COMPILER, which needs a number at compile time to fill in a step's
 *     plain fields (a mouse X, a pixel coordinate),
 *   - the ENGINE, which needs a number at run time to replace a `<>` socket,
 *   - the TESTS, which assert on both.
 *
 * Two evaluators drifting apart is how you get a macro that previews one way
 * and runs another, so there is exactly one copy of the truth here.
 *
 * An expression is a small JSON tree. It is deliberately NOT code and contains
 * no function names, strings or property access: a saved macro is untrusted
 * input (it can arrive from a shared file), so `eval` and `new Function` are
 * never involved.
 *
 *   { e: 'num',  v: 5 }
 *   { e: 'lit',  v: true }                     boolean literal
 *   { e: 'rand', min: <node>, max: <node>, dp: 0 }
 *   { e: 'pixel', x: 640, y: 380, colour: '#ff0000', tol: 0 }
 *   { e: 'not',  a: <node> }
 *   { e: 'and' | 'or', a: <node>, b: <node> }
 *   { e: 'eq' | 'gt' | 'lt', a: <node>, b: <node> }
 *
 * There is NO arithmetic. A math category was built and then removed: every
 * field that would carry real data (coordinates, tolerance, poll interval) is a
 * plain field rather than a socket, so `(a) * (b)` had nothing to multiply, and
 * the `between` chip already covered "a number I do not want to type".
 *
 * WHY `pixel` IS NOT EVALUATED HERE
 * ---------------------------------
 * Reading a pixel is I/O. This file is a pure, synchronous evaluator, and
 * keeping it that way is what lets the compiler, the engine and the tests share
 * one copy of the rules. So a `pixel` node is never resolved by evalBoolean;
 * the ENGINE resolves it first (it owns the screen-reading port) by calling
 * `collectPixels` then `substitutePixels`, which swaps every `pixel` node for a
 * plain `lit`. What arrives here is therefore always already a literal.
 *
 * `evalBoolean`/`evalNumber` read an unresolved `pixel` node as false rather
 * than throwing, so a hand-edited saved macro still runs.
 *
 * UMD: the Electron main process (engine) require()s it, the renderer loads it
 * as a <script> if it wants it, and the test suite require()s it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MB = root.MB || {};
    root.MB.expressions = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Operation discriminators. Mirrored by catalog.LOGIC. */
  var OP = {
    NUM: 'num',
    LIT: 'lit',
    RAND: 'rand',
    PIXEL: 'pixel',
    NOT: 'not',
    AND: 'and',
    OR: 'or',
    EQ: 'eq',
    GT: 'gt',
    LT: 'lt',
  };

  /**
   * Ops that already answer "true or false" and must not be coerced.
   * `pixel` is in here: it is a comparison, and it must not be read as a
   * number and then tested for non-zero by a caller.
   */
  var BOOLEAN_OPS = [OP.LIT, OP.PIXEL, OP.NOT, OP.AND, OP.OR, OP.EQ, OP.GT, OP.LT];

  var MAX_DECIMALS = 6;

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /** Anything non-numeric (including Infinity from a divide) reads as 0. */
  function safe(v) {
    return isFiniteNumber(v) ? v : 0;
  }

  /**
   * Boolean truthiness for a raw number: 0 and -0 are false, everything else is
   * true. `NaN` is false (safe() already turned it into 0 upstream).
   */
  function truthy(v) {
    return safe(Number(v)) !== 0;
  }

  function node(op) {
    var n = { e: op };
    for (var i = 1; i < arguments.length; i++) {
      n[arguments[i][0]] = arguments[i][1];
    }
    return n;
  }

  // ------------------------------------------------------------- constructors

  function num(v) {
    return { e: OP.NUM, v: safe(Number(v)) };
  }

  function lit(v) {
    return { e: OP.LIT, v: !!v };
  }

  function rand(min, max, dp) {
    return { e: OP.RAND, min: min || num(0), max: max || num(100), dp: clampDp(dp) };
  }

  function clampDp(dp) {
    var n = Math.floor(Number(dp));
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(MAX_DECIMALS, n);
  }

  /**
   * Tolerance is a PIXEL concept, so its clamping rule lives in
   * src/shared/pixels.js. expressions.js only needs it to render `describe`, so
   * it does the same 0-255 clamp inline rather than depending on a module that
   * would then be loaded just for a log line. The authoritative comparison is
   * pixels.matches - see the engine.
   */
  function clampToleranceFor(t) {
    var n = Math.floor(Number(t));
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(255, n);
  }

  // -------------------------------------------------------------- evaluation

  /**
   * Evaluate to a number.
   * @param {object} n      expression node (null/undefined -> 0)
   * @param {function} [rng] Math.random-compatible; only `rand` uses it
   */
  function evalNumber(n, rng) {
    if (n === null || n === undefined) return 0;
    if (typeof n === 'number') return safe(n);

    switch (n.e) {
      case OP.NUM:
        return safe(Number(n.v));

      case OP.RAND:
        return evalRand(n, rng);

      case OP.LIT:
        // A boolean reached a numeric socket. 1 / 0 keeps `wait <is ready>`
        // meaningful instead of producing NaN.
        return n.v ? 1 : 0;

      case OP.PIXEL:
        // Unresolved pixel node: see evalBoolean. Reads as 0 so a numeric
        // consumer gets a falsy number rather than NaN.
        return 0;

      default:
        if (isBooleanOp(n.e)) return evalBoolean(n, rng) ? 1 : 0;
        // An op from a NEWER version of this file, or a corrupt saved macro.
        // Returning 0 terminates the walk: delegating to evalBoolean here
        // instead would ping-pong with evalBoolean's own default branch and
        // blow the stack on exactly the input this case exists to survive.
        return 0;
    }
  }

  /**
   * Evaluate to true / false.
   *
   * A number in a boolean socket is true when it is non-zero, which is what
   * makes `<count> > 0` readable when written as "and <is ready> <count>".
   */
  function evalBoolean(n, rng) {
    if (n === null || n === undefined) return false;
    if (typeof n === 'boolean') return n;
    if (typeof n === 'number') return truthy(n);

    switch (n.e) {
      case OP.LIT:
        return !!n.v;
      case OP.PIXEL:
        // Should already have been substituted by the engine. Reading it as
        // false keeps a hand-edited macro running instead of throwing mid-step.
        return false;
      case OP.NOT:
        return !evalBoolean(n.a, rng);
      case OP.AND:
        // Short-circuits like `&&`, so an `and` guarding an expensive or
        // side-effecting right-hand side behaves the way the block reads.
        return evalBoolean(n.a, rng) ? evalBoolean(n.b, rng) : false;
      case OP.OR:
        return evalBoolean(n.a, rng) ? true : evalBoolean(n.b, rng);
      case OP.EQ:
        return evalNumber(n.a, rng) === evalNumber(n.b, rng);
      case OP.GT:
        return evalNumber(n.a, rng) > evalNumber(n.b, rng);
      case OP.LT:
        return evalNumber(n.a, rng) < evalNumber(n.b, rng);
      default:
        // A numeric reporter in a boolean socket: 0 is false, else true.
        if (isBooleanOp(n.e)) return false;
        return truthy(evalNumber(n, rng));
    }
  }

  function evalRand(n, rng) {    var lo = evalNumber(n.min, rng);
    var hi = evalNumber(n.max, rng);
    if (lo > hi) {
      var t = lo;
      lo = hi;
      hi = t;
    }
    var dp = clampDp(n.dp);
    var r = typeof rng === 'function' ? Number(rng()) : Math.random();
    if (!isFinite(r)) r = 0;
    // rng() is documented as [0,1); clamp anyway so a bad mock cannot roll out
    // of the range the user asked for.
    if (r < 0) r = 0;
    if (r > 1) r = 1;

    if (dp === 0) {
      // Whole numbers, inclusive of both ends - the same rule the "between"
      // value chip uses, so the two do not feel different.
      return Math.min(hi, Math.max(lo, lo + Math.floor(r * (hi - lo + 1))));
    }
    var factor = Math.pow(10, dp);
    return Math.round((lo + r * (hi - lo)) * factor) / factor;
  }

  // ------------------------------------------------------------- inspection

  /** True when the node answers true/false rather than a number. */
  function isBooleanOp(e) {
    return BOOLEAN_OPS.indexOf(e) !== -1;
  }

  /**
   * Best-effort compile-time value, used only for constant folding.
   *
   * Returns null for anything that can differ per evaluation, so a caller can
   * tell "this is 5" from "this is a random roll". Never guess.
   */
  function constantValue(n) {
    if (!n || typeof n !== 'object') return null;
    switch (n.e) {
      case OP.NUM:
        return safe(Number(n.v));
      case OP.LIT:
        return !!n.v;
      default:
        return null;
    }
  }

  /**
   * Every distinct pixel an expression needs to look at.
   *
   * The engine calls this BEFORE evaluating a condition, so all the reads can
   * be satisfied from a single screen capture. That is the whole reason pixel
   * checks are expression nodes rather than a separate statement block: an `and`
   * of two pixel checks becomes one batch read instead of two.
   *
   * Deduplicated by "x,y,colour,tolerance" - asking the same question twice in
   * one condition is one read, and two reads of the same pixel could in
   * principle straddle a change and contradict each other.
   *
   * @return {Array<{key:string,x:number,y:number,colour:string,tol:number}>}
   */
  function collectPixels(n, out, seen) {
    if (!n || typeof n !== 'object') return out || [];
    out = out || [];
    seen = seen || {};
    if (n.e === OP.PIXEL) {
      var key = n.x + ',' + n.y + ',' + n.colour + ',' + n.tol;
      if (!seen[key]) {
        seen[key] = true;
        out.push({ key: key, x: Number(n.x) || 0, y: Number(n.y) || 0, colour: n.colour, tol: n.tol });
      }
      return out;
    }
    // Not a switch on purpose: an op added to a future version must still have
    // its children walked, or its pixels would be silently ignored.
    ['a', 'b', 'min', 'max'].forEach(function (k) {
      if (n[k] && typeof n[k] === 'object') collectPixels(n[k], out, seen);
    });
    return out;
  }

  /**
   * Replace every `pixel` node with the boolean it was answered with.
   *
   * @param {object} n    the expression tree
   * @param {object} map  key -> boolean, keyed as collectPixels does
   * @return {object} a NEW tree; the input is not mutated, because the engine
   *   holds the same tree for the whole run and re-evaluates it every pass.
   */
  function substitutePixels(n, map) {
    if (!n || typeof n !== 'object') return n;
    if (n.e === OP.PIXEL) {
      var key = n.x + ',' + n.y + ',' + n.colour + ',' + n.tol;
      return Object.prototype.hasOwnProperty.call(map, key) ? lit(!!map[key]) : lit(false);
    }
    var out = {};
    Object.keys(n).forEach(function (k) {
      var v = n[k];
      out[k] = v && typeof v === 'object' ? substitutePixels(v, map) : v;
    });
    return out;
  }

  /**
   * Render an expression as a single line, for the compile badge and logs.
   * Never throws: an unexpected shape falls back to a placeholder rather than
   * taking the whole compile report down with it.
   */
  function describe(n, depth) {
    if (n === null || n === undefined) return '?';
    if (typeof n === 'number') return String(n);
    if (typeof n === 'boolean') return String(n);
    // A corrupt saved macro could hold a self-referential tree. Cap the depth
    // so the compile report degrades to "..." instead of overflowing the stack
    // and taking the whole report down with it.
    depth = depth || 0;
    if (depth > 20) return '...';
    try {
      switch (n.e) {
        case OP.NUM:
          return String(Number(n.v));
        case OP.LIT:
          return n.v ? 'true' : 'false';
        case OP.RAND:
          return 'random ' + describe(n.min, depth+1) + ' to ' + describe(n.max, depth+1) +
            (clampDp(n.dp) ? ' (' + clampDp(n.dp) + 'dp)' : '');
        case OP.PIXEL:
          return 'pixel(' + n.x + ',' + n.y + ') is ' + n.colour +
            (clampToleranceFor(n.tol) ? ' ±' + clampToleranceFor(n.tol) : '');
        case OP.NOT:
          return 'not ' + describe(n.a, depth+1);
        case OP.AND:
          return '(' + describe(n.a, depth+1) + ' and ' + describe(n.b, depth+1) + ')';
        case OP.OR:
          return '(' + describe(n.a, depth+1) + ' or ' + describe(n.b, depth+1) + ')';
        case OP.EQ:
          return describe(n.a, depth+1) + ' = ' + describe(n.b, depth+1);
        case OP.GT:
          return describe(n.a, depth+1) + ' > ' + describe(n.b, depth+1);
        case OP.LT:
          return describe(n.a, depth+1) + ' < ' + describe(n.b, depth+1);
        default:
          return '?';
      }
    } catch (e) {
      return '?';
    }
  }

  return {
    OP: OP,
    BOOLEAN_OPS: BOOLEAN_OPS,
    MAX_DECIMALS: MAX_DECIMALS,
    num: num,
    lit: lit,
    rand: rand,
    evalNumber: evalNumber,
    evalBoolean: evalBoolean,
    isBooleanOp: isBooleanOp,
    collectPixels: collectPixels,
    substitutePixels: substitutePixels,
    constantValue: constantValue,
    describe: describe,
    truthy: truthy,
  };
});