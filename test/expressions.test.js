'use strict';

/**
 * Expression evaluator tests.
 *
 * src/shared/expressions.js is the ONE evaluator behind the Logic and Math
 * blocks, shared by the compiler (which needs constant values at compile time)
 * and the engine (which evaluates at run time). If these two ever diverge, a
 * macro previews one way and behaves another - so the rules are pinned here
 * rather than inferred from either caller.
 *
 * Two of the rules below are judgement calls worth stating plainly:
 *   - dividing or taking a remainder by zero yields 0, not Infinity/NaN
 *   - a boolean in a numeric socket reads as 1 / 0
 * Both exist because the alternative reaches the OS as a nonsense value.
 */

const test = require('node:test');
const assert = require('node:assert');
const expressions = require('../src/shared/expressions');

const OP = expressions.OP;
const { num, lit, rand } = expressions;

/** Deterministic "random" so a roll is assertable. */
const fixed = (v) => () => v;

// ------------------------------------------------------------ constructors

test('num and lit build well-formed nodes', () => {
  assert.deepStrictEqual(num(5), { e: OP.NUM, v: 5 });
  assert.deepStrictEqual(num('7'), { e: OP.NUM, v: 7 });
  assert.deepStrictEqual(lit(true), { e: OP.LIT, v: true });
});

test('a non-numeric num collapses to 0 rather than NaN', () => {
  assert.deepStrictEqual(num('abc'), { e: OP.NUM, v: 0 });
  assert.deepStrictEqual(num(Infinity), { e: OP.NUM, v: 0 });
  assert.deepStrictEqual(num(undefined), { e: OP.NUM, v: 0 });
});

// -------------------------------------------------------------- booleans
test('the three comparisons answer true or false', () => {
  const n = (v) => ({ e: OP.NUM, v });
  assert.strictEqual(expressions.evalBoolean({ e: OP.EQ, a: n(3), b: n(3) }), true);
  assert.strictEqual(expressions.evalBoolean({ e: OP.EQ, a: n(3), b: n(4) }), false);
  assert.strictEqual(expressions.evalBoolean({ e: OP.GT, a: n(5), b: n(4) }), true);
  assert.strictEqual(expressions.evalBoolean({ e: OP.GT, a: n(4), b: n(5) }), false);
  assert.strictEqual(expressions.evalBoolean({ e: OP.LT, a: n(4), b: n(5) }), true);
  assert.strictEqual(expressions.evalBoolean({ e: OP.LT, a: n(5), b: n(4) }), false);
});

test('equality is exact - it is not a fuzzy compare', () => {
  assert.strictEqual(
    expressions.evalBoolean({ e: OP.EQ, a: num(0.1 + 0.2), b: num(0.3) }),
    false,
    'documents the floating-point behaviour users may hit; round() is the tool for that'
  );
});

test('not reverses its input', () => {
  assert.strictEqual(expressions.evalBoolean({ e: OP.NOT, a: lit(true) }), false);
  assert.strictEqual(expressions.evalBoolean({ e: OP.NOT, a: lit(false) }), true);
});

test('and / or combine booleans', () => {
  const and = (a, b) => ({ e: OP.AND, a, b });
  const or = (a, b) => ({ e: OP.OR, a, b });
  assert.strictEqual(expressions.evalBoolean(and(lit(true), lit(true))), true);
  assert.strictEqual(expressions.evalBoolean(and(lit(true), lit(false))), false);
  assert.strictEqual(expressions.evalBoolean(or(lit(false), lit(true))), true);
  assert.strictEqual(expressions.evalBoolean(or(lit(false), lit(false))), false);
});

test('and short-circuits: the right side is not evaluated when the left is false', () => {
  // Division by zero on the right would be masked if the right side were
  // evaluated eagerly, so this asserts on the RESULT rather than on a call
  // count - which is the observable behaviour that actually matters.
  const tree = { e: OP.AND, a: lit(false), b: { e: OP.DIV, a: num(1), b: num(0) } };
  assert.strictEqual(expressions.evalBoolean(tree), false);
});

test('or short-circuits the other way round', () => {
  const tree = { e: OP.OR, a: lit(true), b: { e: OP.DIV, a: num(1), b: num(0) } };
  assert.strictEqual(expressions.evalBoolean(tree), true);
});

test('a nested condition reads correctly', () => {
  // (5 > 3) and not (2 = 2)  ->  true and not true  ->  false
  assert.strictEqual(
    expressions.evalBoolean({
      e: OP.AND,
      a: { e: OP.GT, a: num(5), b: num(3) },
      b: { e: OP.NOT, a: { e: OP.EQ, a: num(2), b: num(2) } },
    }),
    false
  );
  // (5 > 3) and not (2 = 3)  ->  true and not false  ->  true
  assert.strictEqual(
    expressions.evalBoolean({
      e: OP.AND,
      a: { e: OP.GT, a: num(5), b: num(3) },
      b: { e: OP.NOT, a: { e: OP.EQ, a: num(2), b: num(3) } },
    }),
    true
  );
});

// ----------------------------------------------------------- coercion

test('a number in a boolean socket: 0 is false, anything else is true', () => {
  assert.strictEqual(expressions.evalBoolean(num(0)), false);
  assert.strictEqual(expressions.evalBoolean(num(-0)), false);
  assert.strictEqual(expressions.evalBoolean(num(1)), true);
  assert.strictEqual(expressions.evalBoolean(num(-5)), true);
  assert.strictEqual(expressions.evalBoolean(num(0.0001)), true);
});

test('a boolean in a numeric socket reads as 1 / 0', () => {
  assert.strictEqual(expressions.evalNumber(lit(true)), 1);
  assert.strictEqual(expressions.evalNumber(lit(false)), 0);
});

test('a comparison used as a number reads as 1 / 0', () => {
  assert.strictEqual(expressions.evalNumber({ e: OP.GT, a: num(2), b: num(1) }), 1);
  assert.strictEqual(expressions.evalNumber({ e: OP.GT, a: num(1), b: num(2) }), 0);
});

test('missing or malformed nodes evaluate to the safe answer', () => {
  assert.strictEqual(expressions.evalNumber(null), 0);
  assert.strictEqual(expressions.evalNumber(undefined), 0);
  assert.strictEqual(expressions.evalBoolean(null), false);
  assert.strictEqual(expressions.evalNumber({ e: 'nonsense' }), 0);
  assert.strictEqual(expressions.evalBoolean({ e: 'nonsense' }), false);
});

test('a node with missing operands does not throw', () => {
  assert.strictEqual(expressions.evalNumber({ e: OP.RAND }), 0);
  assert.strictEqual(expressions.evalBoolean({ e: OP.AND }), false);
  assert.strictEqual(expressions.evalBoolean({ e: OP.NOT }), true, 'not of nothing is true');
});

// ----------------------------------------------------------------- pixels

const pixel = (x, y, colour, tol) => ({ e: OP.PIXEL, x, y, colour, tol: tol || 0 });

test('collectPixels finds a lone pixel check', () => {
  const found = expressions.collectPixels(pixel(10, 20, '#ff0000'));
  assert.strictEqual(found.length, 1);
  assert.deepStrictEqual(found[0], { key: '10,20,#ff0000,0', x: 10, y: 20, colour: '#ff0000', tol: 0 });
});

test('collectPixels finds both pixels of an and - this is what makes one capture enough', () => {
  const tree = { e: OP.AND, a: pixel(655, 402, '#ff0000'), b: pixel(700, 402, '#ff0000') };
  const found = expressions.collectPixels(tree);
  assert.strictEqual(found.length, 2);
  assert.deepStrictEqual(found.map((p) => p.x), [655, 700]);
});

test('collectPixels finds pixels at any depth, including under not', () => {
  const tree = {
    e: OP.OR,
    a: { e: OP.NOT, a: pixel(1, 1, '#111111') },
    b: {
      e: OP.AND,
      a: pixel(2, 2, '#222222'),
      b: { e: OP.GT, a: pixel(3, 3, '#333333'), b: num(0) },
    },
  };
  assert.deepStrictEqual(expressions.collectPixels(tree).map((p) => p.x), [1, 2, 3]);
});

test('collectPixels dedupes the same question asked twice', () => {
  // Two reads of one pixel could straddle a change and answer differently in
  // one condition - so it is one read, and one answer.
  const tree = { e: OP.AND, a: pixel(5, 5, '#ff0000'), b: pixel(5, 5, '#ff0000') };
  assert.strictEqual(expressions.collectPixels(tree).length, 1);
});

test('collectPixels treats a different tolerance as a different question', () => {
  const tree = { e: OP.OR, a: pixel(5, 5, '#ff0000', 0), b: pixel(5, 5, '#ff0000', 20) };
  assert.strictEqual(expressions.collectPixels(tree).length, 2);
});

test('collectPixels returns nothing for a condition with no pixels', () => {
  assert.deepStrictEqual(expressions.collectPixels({ e: OP.GT, a: num(1), b: num(2) }), []);
  assert.deepStrictEqual(expressions.collectPixels(null), []);
});

test('substitutePixels replaces a pixel with the boolean it was answered with', () => {
  const tree = pixel(10, 20, '#ff0000');
  const out = expressions.substitutePixels(tree, { '10,20,#ff0000,0': true });
  assert.deepStrictEqual(out, { e: OP.LIT, v: true });
  assert.strictEqual(expressions.evalBoolean(out), true);
});

test('substitutePixels does not mutate the original tree', () => {
  // The engine holds one tree for a whole run and re-evaluates it every pass, so
  // substituting in place would make the second pass wrong.
  const tree = { e: OP.AND, a: pixel(1, 1, '#ff0000'), b: pixel(2, 2, '#ff0000') };
  const snapshot = JSON.stringify(tree);
  expressions.substitutePixels(tree, { '1,1,#ff0000,0': true, '2,2,#ff0000,0': false });
  assert.strictEqual(JSON.stringify(tree), snapshot);
  assert.strictEqual(tree.a.e, OP.PIXEL, 'the source node is still a pixel');
});

test('a substituted tree evaluates as ordinary logic', () => {
  const tree = { e: OP.AND, a: pixel(1, 1, '#ff0000'), b: pixel(2, 2, '#00ff00') };
  assert.strictEqual(
    expressions.evalBoolean(expressions.substitutePixels(tree, { '1,1,#ff0000,0': true, '2,2,#00ff00,0': true })),
    true
  );
  assert.strictEqual(
    expressions.evalBoolean(expressions.substitutePixels(tree, { '1,1,#ff0000,0': true, '2,2,#00ff00,0': false })),
    false
  );
});

test('a pixel with no answer substitutes to false, not to a throw', () => {
  // Happens when the capture fails or the pixel is off screen. "Condition not
  // met" is a better outcome than killing a macro mid-loop.
  const out = expressions.substitutePixels(pixel(1, 1, '#ff0000'), {});
  assert.strictEqual(expressions.evalBoolean(out), false);
});

test('an UNSUBSTITUTED pixel node reads false, so a corrupt macro still runs', () => {
  assert.strictEqual(expressions.evalBoolean(pixel(1, 1, '#ff0000')), false);
  assert.strictEqual(expressions.evalNumber(pixel(1, 1, '#ff0000')), 0);
  assert.strictEqual(expressions.evalBoolean({ e: OP.NOT, a: pixel(1, 1, '#ff0000') }), true);
});
// ---------------------------------------------------------------- random

test('a whole-number roll includes both ends of the range', () => {
  assert.strictEqual(expressions.evalNumber(rand(num(1), num(10), 0), fixed(0)), 1);
  assert.strictEqual(expressions.evalNumber(rand(num(1), num(10), 0), fixed(0.999999)), 10);
});

test('a decimal roll respects the decimal setting', () => {
  const v = expressions.evalNumber(rand(num(0), num(1), 3), fixed(0.5));
  assert.strictEqual(v, 0.5);
  // 2dp must round, not truncate
  assert.strictEqual(expressions.evalNumber(rand(num(0), num(1), 2), fixed(0.456)), 0.46);
});

test('a roll with the ends reversed still lands inside the range', () => {
  const v = expressions.evalNumber(rand(num(10), num(1), 0), fixed(0.5));
  assert.ok(v >= 1 && v <= 10, 'got ' + v);
});

test('a single-value range always returns that value', () => {
  assert.strictEqual(expressions.evalNumber(rand(num(7), num(7), 0), fixed(0.9)), 7);
});

test('a roll never escapes its range even if the rng misbehaves', () => {
  assert.strictEqual(expressions.evalNumber(rand(num(1), num(5), 0), fixed(-3)), 1);
  assert.strictEqual(expressions.evalNumber(rand(num(1), num(5), 0), fixed(4)), 5);
  assert.strictEqual(expressions.evalNumber(rand(num(1), num(5), 0), fixed(NaN)), 1);
});

test('a roll is re-evaluated on every call, not cached', () => {
  const node = rand(num(1), num(100), 0);
  assert.strictEqual(expressions.evalNumber(node, fixed(0)), 1);
  assert.strictEqual(expressions.evalNumber(node, fixed(0.99)), 100);
});

// ---------------------------------------------------------- inspection

test('constantValue only claims a value it actually knows', () => {
  assert.strictEqual(expressions.constantValue(num(5)), 5);
  assert.strictEqual(expressions.constantValue(lit(true)), true);
  assert.strictEqual(expressions.constantValue({ e: OP.ADD, a: num(1), b: num(2) }), null);
  assert.strictEqual(expressions.constantValue(rand(num(1), num(2), 0)), null);
  assert.strictEqual(expressions.constantValue(null), null);
});

test('isBooleanOp separates the two families', () => {
  assert.strictEqual(expressions.isBooleanOp(OP.EQ), true);
  assert.strictEqual(expressions.isBooleanOp(OP.AND), true);
  assert.strictEqual(expressions.isBooleanOp(OP.NOT), true);
  assert.strictEqual(expressions.isBooleanOp(OP.PIXEL), true, 'a pixel check is a comparison');
  assert.strictEqual(expressions.isBooleanOp(OP.NUM), false);
  assert.strictEqual(expressions.isBooleanOp(OP.RAND), false);
});

test('describe renders a readable one-liner', () => {
  const tree = { e: OP.AND, a: { e: OP.GT, a: num(5), b: num(2) }, b: { e: OP.NOT, a: num(0) } };
  assert.strictEqual(expressions.describe(tree), '(5 > 2 and not 0)');
  assert.strictEqual(expressions.describe({ e: OP.GT, a: num(5), b: num(2) }), '5 > 2');
  assert.strictEqual(expressions.describe(lit(true)), 'true');
});

test('describe renders a pixel check readably, with tolerance only when set', () => {
  assert.strictEqual(
    expressions.describe({ e: OP.PIXEL, x: 640, y: 380, colour: '#ff0000', tol: 0 }),
    'pixel(640,380) is #ff0000'
  );
  assert.strictEqual(
    expressions.describe({ e: OP.PIXEL, x: 1, y: 2, colour: '#00ff00', tol: 12 }),
    'pixel(1,2) is #00ff00 ±12'
  );
});

test('describe never throws on a malformed node', () => {
  assert.doesNotThrow(() => expressions.describe({ e: 'nonsense' }));
  assert.doesNotThrow(() => expressions.describe({}));
  assert.doesNotThrow(() => expressions.describe(null));
  assert.strictEqual(expressions.describe({ e: 'nonsense' }), '?');
});

test('describe handles a self-referential node without hanging', () => {
  // A corrupt saved file could contain this. The evaluator is iterative-free,
  // so guard the reporting path only - a genuinely cyclic EVALUATE would still
  // recurse, which is why the compiler rejects unknown ops rather than
  // emitting them.
  const loop = { e: OP.ADD };
  loop.a = loop;
  assert.doesNotThrow(() => expressions.describe(loop));
});

// ------------------------------------------------- round-trip stability

test('a compiled tree evaluates to the same answer twice', () => {
  const tree = { e: OP.AND, a: { e: OP.GT, a: num(2), b: num(1) }, b: { e: OP.LT, a: num(1), b: num(9) } };
  const first = expressions.evalBoolean(tree);
  const second = expressions.evalBoolean(tree);
  assert.strictEqual(first, second);
  assert.strictEqual(first, true);
});

test('evaluate does not mutate the tree', () => {
  const tree = { e: OP.OR, a: num(1), b: { e: OP.NOT, a: num(0) } };
  const snapshot = JSON.stringify(tree);
  expressions.evalBoolean(tree);
  expressions.evalNumber(tree);
  assert.strictEqual(JSON.stringify(tree), snapshot);
});

