'use strict';

/**
 * Shared test helpers.
 *
 * Note: `@fainthit/uiohook-napi-suppress` and `@nut-tree-fork/nut-js` are
 * required ONLY to read their Key / Button enums. Neither module starts a hook
 * or touches the screen at import time, so this is safe to do in the test
 * process.
 */

const path = require('path');

const constants = require('../../src/shared/constants');
const catalog = require('../../src/shared/catalog');
const buttonMod = require('../../src/shared/buttons');
const expressions = require('../../src/shared/expressions');
const fieldMod = require('../../src/blockly/fields');
const blocksMod = require('../../src/blockly/blocks');
const { createCompiler } = require('../../src/blockly/compiler');

let Blockly = null;
try {
  Blockly = require('blockly');
} catch (e) {
  Blockly = null;
}

function realCatalog() {
  const { UiohookKey } = require('@fainthit/uiohook-napi-suppress');
  const nut = require('@nut-tree-fork/nut-js');
  return buttonMod.createCatalog({ UiohookKey, nutKey: nut.Key, nutButton: nut.Button });
}

/** A compiler wired to the real enums + a controllable macro-name list. */
function makeCompiler(opts) {
  opts = opts || {};
  let names = opts.macroNames || [];
  const buttons = opts.buttons || realCatalog();
  const compiler = createCompiler({
    Blockly: Blockly,
constants,
    catalog,
    buttons,
    expressions,
    Blockly,
    getMacroNames: () => names,
  });
  return {
    compiler,
    buttons,
    Blockly,
    setMacroNames: (n) => {
      names = n;
    },
  };
}

/** Register the fields + blocks against the shared Blockly instance. */
function registerBlocks(opts) {
  opts = opts || {};
  const buttons = opts.buttons || realCatalog();
  const fieldClasses = fieldMod.register(Blockly);
  const blockReg = blocksMod.register(Blockly, {
    catalog,
    constants,
    fieldClasses,
    getMacroNames: opts.getMacroNames || (() => []),
    describeButton: buttons.describe,
  });
  return { fieldClasses, blockReg, buttons };
}

// ---- tiny JSON-state builders (mirror Blockly's serialization format) ----

const S = {
  /** Plain-number value chip (also the default shadow in a socket). */
  num: (v) => ({ type: 'mb_value_number', fields: { NUM: v } }),
  forever: () => ({ type: 'mb_value_forever' }),
  range: (min, max) => ({ type: 'mb_value_range', fields: { MIN: min, MAX: max } }),
};

/**
 * Expression-state builders, mirroring the Logic block definitions.
 *
 * The operand names must match the block definitions in src/blockly/blocks.js
 * exactly: the compiler reads them out of serialized state by name.
 */
const E = {
  num: (v) => S.num(v),
  forever: () => S.forever(),
  range: (min, max) => S.range(min, max),
  /** `(a) OP (b)` for every two-operand logic block. */
  binary: (type, a, b) => into(into(block(type), 'A', a), 'B', b),
  /** A block with one operand. */
  unary: (type, a) => into(block(type), 'A', a),
  eq: (a, b) => E.binary(catalog.LOGIC.EQUALS, a, b),
  gt: (a, b) => E.binary(catalog.LOGIC.GREATER, a, b),
  lt: (a, b) => E.binary(catalog.LOGIC.LESS, a, b),
  and: (a, b) => E.binary(catalog.LOGIC.AND, a, b),
  or: (a, b) => E.binary(catalog.LOGIC.OR, a, b),
  not: (a) => E.unary(catalog.LOGIC.NOT, a),
  /** `(pixel at x y) is <colour>` with an optional tolerance. */
  pixelIs: (x, y, colour, tol) =>
    block(catalog.LOGIC.PIXEL_IS, {
      X: x,
      Y: y,
      COLOUR: colour,
      TOLERANCE: tol === undefined ? 0 : tol,
    }),
};

/** Loop blocks, which need statement bodies so they do not fit in `E`. */
const L = {
  /** `repeat N times` with a body chain. */
  repeat: (count, body) => shadow(into(block(catalog.CONTROL.REPEAT, {}), 'DO', body), 'COUNT', count),
  /** `repeat until <cond>` with a body chain. */
  repeatUntil: (cond, body) =>
    into(into(block(catalog.CONTROL.REPEAT_UNTIL, {}), 'COND', cond), 'DO', body),
  brk: () => block(catalog.CONTROL.BREAK, {}),
  cont: () => block(catalog.CONTROL.CONTINUE, {}),
};

/** Link blocks into a `next` chain. */
function chain(...blocks) {
  const list = blocks.filter(Boolean);
  for (let i = list.length - 1; i > 0; i--) {
    list[i - 1].next = { block: list[i] };
  }
  return list[0] || null;
}

/** Put a block into a named statement/value input. */
function into(parent, inputName, child) {
  parent.inputs = parent.inputs || {};
  parent.inputs[inputName] = parent.inputs[inputName] || {};
  parent.inputs[inputName].block = child;
  return parent;
}

/** Put a value chip in a socket as its default SHADOW. */
function shadow(parent, inputName, child) {
  parent.inputs = parent.inputs || {};
  parent.inputs[inputName] = parent.inputs[inputName] || {};
  parent.inputs[inputName].shadow = child;
  return parent;
}

function block(type, fields) {
  const b = { type };
  if (fields) b.fields = fields;
  return b;
}

module.exports = {
  constants,
  catalog,
  buttonMod,
  expressions,
  Blockly,
  realCatalog,
  makeCompiler,
  registerBlocks,
  S,
  E,
  L,
  chain,
  into,
  shadow,
  block,
  path,
};
