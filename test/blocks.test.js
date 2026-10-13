'use strict';

/**
 * Block-definition + chooser integration tests.
 *
 * These run REAL Blockly headlessly (no DOM needed - verified) with the real
 * field and block definitions. They are the safety net for the two riskiest
 * areas of the editor:
 *
 *   1. every block in the catalog actually instantiates, and
 *   2. the paged chooser's serialize/unserialize round trip does not duplicate,
 *      lose or reorder page contents.
 *
 * They also prove that the hand-written JSON fixtures used by compiler.test.js
 * match what Blockly really writes.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Blockly, catalog, constants, realCatalog, makeCompiler, registerBlocks, buttonMod } = require('./helpers/env');

const C = catalog;
const DROP_NAMES = [];
const COMPILE_NAMES = [];
const { blockReg, buttons, fieldClasses } = registerBlocks({ getMacroNames: () => DROP_NAMES });
const { compiler } = makeCompiler({ macroNames: COMPILE_NAMES });

const ALL_TYPES = []
  .concat(Object.values(C.START))
  .concat(Object.values(C.MOUSE))
  .concat(Object.values(C.KEYBOARD))
  .concat(Object.values(C.CONTROL))
  .concat(Object.values(C.VALUE))
  .concat(Object.values(C.LOGIC));

function ws() {
  return new Blockly.Workspace();
}

/**
 * Unplug whatever is sitting in a socket, leaving it genuinely empty.
 */
function unplugSocket(block, name) {
  const conn = block.getInput(name).connection;
  const tgt = conn.targetBlock();
  if (!tgt) return null;
  conn.disconnect();
  tgt.dispose(false);
  return tgt;
}

/** A lone "click" block with x/y already set, for socket-focused tests. */
function clickAt(w, x, y) {
  const click = w.newBlock(C.MOUSE.CLICK);
  click.getField('BUTTON').setValue('mouse:1');
  setNumSocket(click, 'X', x);
  setNumSocket(click, 'Y', y);
  return click;
}

/** Set a numeric SOCKET, the way the "pick" button does: edit the number chip. */
function setNumSocket(block, name, value) {
  const conn = block.getInput(name).connection;
  const target = conn.targetBlock();
  assert.ok(target, name + ' should hold a number chip');
  target.getField('NUM').setValue(value);
}

function chainInto(parent, inputName, list) {
  const items = list.filter(Boolean);
  for (let i = items.length - 1; i > 0; i--) {
    items[i - 1].nextConnection.connect(items[i].previousConnection);
  }
  if (items.length) parent.getInput(inputName).connection.connect(items[0].previousConnection);
  return items;
}

// ----------------------------------------------------------- definitions

test('the sleep switch draws a fixed-width track and a knob that slides', () => {
  // A headless Workspace never calls initView (there is no view at all), and
  // installing a jsdom document here would poison Blockly's cached globals for
  // every later test in this file. So the geometry is driven directly against
  // plain attribute stubs - which is the part that can actually be wrong, and is
  // otherwise only visible by opening the real window.
  // Uses the file-level fieldClasses: re-calling registerBlocks() here would
  // register with an EMPTY macro-name list and break every later test that
  // depends on the dropdown having options.
  const field = new fieldClasses.FieldSwitch(true, undefined, { label: 'sleep' });

  const attrs = (initial) => {
    const map = Object.assign({}, initial);
    return {
      el: {
        setAttribute: (k, v) => {
          map[k] = String(v);
        },
        getAttribute: (k) => map[k],
        // Blockly's own field bookkeeping calls this while reacting to a
        // setValue, so the stub has to answer it.
        removeAttribute: (k) => {
          delete map[k];
        },
      },
      map,
    };
  };
  const border = attrs({ class: 'mbSwitchTrack' });
  const text = attrs({});
  const knob = attrs({});
  const group = attrs({});
  // The knob's position is animated with a CSS transform on `style`, not by
  // rewriting cx, so it needs a real property object on the stub.
  knob.el.style = { transform: '' };
  // Blockly 13 keeps the SVG <text> in `textElement_` and a bare DOM Text node
  // in `textContent_` (Blockly.Field.createTextElement_ appends it). Geometry
  // goes on the former, the label string on the latter - so both are stubbed.
  const textContentNode = { nodeValue: '' };
  text.el.style = { display: 'block' };

  field.borderRect_ = border.el;
  field.textElement_ = text.el;
  field.textContent_ = textContentNode;
  field.knob_ = knob.el;
  field.fieldGroup_ = { setAttribute: (k, v) => (group.map[k] = String(v)) };
  field.getConstants = () => ({ FIELD_HEIGHT: 16 });
  field.updateSize_ = () => {};
  // FieldCheckbox.setValue recomputes ARIA attributes on the text element, so
  // the stub has to answer those too or the toggle throws mid-test.
  text.el.setAttribute = text.el.setAttribute || ((k, v) => (text.map[k] = String(v)));
  text.el.removeAttribute = text.el.removeAttribute || ((k) => delete text.map[k]);
  field.recomputeAriaContext = () => {};

  field.applyGeometry_();

  assert.strictEqual(border.map.width, '26', 'track width is fixed regardless of label length');
  assert.strictEqual(border.map.height, '14');
  assert.strictEqual(border.map.rx, '7', 'the track is a full pill');
  assert.strictEqual(textContentNode.nodeValue, 'sleep', 'the label is rendered');
  assert.strictEqual(text.map.x, '31', 'the label sits to the right of the track');

  // ON: knob translated to the right, track marked on.
  assert.match(border.map.class, /mbSwitchTrack/, 'the border rect is the track');
  assert.match(border.map.class, /is-on/, 'track shows the on state');
  // Travel = track width - both insets - the knob diameter, so the knob's outer
  // edge lands exactly on the track's inner edge rather than overhanging it.
  const travel = 26 - 2 * 2 - 2 * 5;
  assert.match(knob.el.style.transform, new RegExp('translateX\\(' + travel + 'px\\)'), 'knob sits right when on');
  assert.strictEqual(group.map['data-state'], 'on');

  // OFF: the knob returns and the label MUST stay visible. The FieldCheckbox
  // base hides its text when unchecked, which is wrong for a switch.
  field.setValue(false);
  assert.doesNotMatch(border.map.class, /is-on/, 'track shows the off state');
  assert.match(knob.el.style.transform, /translateX\(0px\)/, 'knob sits left when off');
  assert.strictEqual(text.el.style.display, 'block', 'label stays visible when off');
  assert.strictEqual(textContentNode.nodeValue, 'sleep', 'label text is unchanged when off');
  assert.strictEqual(group.map['data-state'], 'off');
});

test('every catalog block type is defined and instantiates headlessly', () => {
  const w = ws();
  const missing = ALL_TYPES.filter((t) => !Blockly.Blocks[t]);
  assert.deepStrictEqual(missing, [], 'undefined block types: ' + missing.join(', '));

  for (const type of ALL_TYPES) {
    const b = w.newBlock(type);
    assert.ok(b, 'failed to create ' + type);
    assert.ok(b.getColour(), type + ' should have a colour');
    b.dispose(false);
  }
});

// ---------------------------------------------------------- logic / math

test('logic blocks output Boolean, not Number', () => {
  // Load-bearing: it is what stops a condition being dropped into a numeric
  // socket, and what lets the if socket reject a stray number.
  const w = ws();
  for (const type of Object.values(C.LOGIC)) {
    const b = w.newBlock(type);
    assert.strictEqual(b.outputConnection.check[0], 'Boolean', type + ' must output Boolean');
    b.dispose(false);
  }
});

test('math blocks output Number', () => {
  // There is no math category. Arithmetic on constants and random rolls was
  // added and then removed: every field that would carry real data
  // (coordinates, tolerance, poll interval) is a plain field rather than a
  // socket, so `(a) * (b)` had nothing to multiply. This test exists so that
  // removing it again is a deliberate act rather than an accident.
  assert.strictEqual(catalog.MATH, undefined, 'no math catalog');
  assert.ok(!Object.values(C).some((v) => v && typeof v === 'object' && Object.values(v).some((t) => /^mb_math_/.test(t))));
  const w = ws();
  const defined = Object.keys(Blockly.Blocks).filter((t) => /^mb_math_/.test(t));
  assert.deepStrictEqual(defined, [], 'no mb_math_* blocks are registered');
  w.dispose();
});

test('the pixel check is a Boolean reporter with the trigger\'s sockets', () => {
  const w = ws();
  const b = w.newBlock(C.LOGIC.PIXEL_IS);
  assert.strictEqual(b.outputConnection.check[0], 'Boolean');
  // Same INPUT names as mb_start_pixel, so a user moving between the two does
  // not relearn anything and the compiler reads them with the same helpers.
  // These are sockets, not fields, so number chips can drive them.
  for (const f of ['X', 'Y', 'TOLERANCE']) {
    assert.ok(b.getInput(f), 'pixel check must have a ' + f + ' socket');
    assert.ok(b.getField(f) === null, 'pixel check ' + f + ' must not be a field any more');
  }
  assert.ok(b.getField('COLOUR'), 'COLOUR stays a field - it is a colour, not a number');
  const trigger = w.newBlock(C.START.PIXEL);
  for (const f of ['X', 'Y', 'TOLERANCE']) {
    assert.ok(trigger.getInput(f), 'trigger must have a ' + f + ' socket');
  }
  assert.ok(trigger.getField('COLOUR'), 'trigger COLOUR stays a field');
  b.dispose(false);
  trigger.dispose(false);
});

test('a pixel check connects into the if condition and into not', () => {
  const w = ws();
  const ifBlock = w.newBlock(C.CONTROL.IF);
  const notBlock = w.newBlock(C.LOGIC.NOT);
  // Two separate blocks: connecting one output to a second input MOVES it, so
  // reusing a single pixel block here would silently disconnect the first.
  const pxForIf = w.newBlock(C.LOGIC.PIXEL_IS);
  const pxForNot = w.newBlock(C.LOGIC.PIXEL_IS);
  ifBlock.getInput('COND').connection.connect(pxForIf.outputConnection);
  // The nesting is the whole point: two pixels combined via `and` is what
  // turns a one-bit check into a real state detector.
  notBlock.getInput('A').connection.connect(pxForNot.outputConnection);
  assert.strictEqual(ifBlock.getInputTargetBlock('COND'), pxForIf);
  assert.strictEqual(notBlock.getInputTargetBlock('A'), pxForNot);
  pxForIf.dispose(false);
  pxForNot.dispose(false);
  notBlock.dispose(false);
  ifBlock.dispose(false);
});

test('a pixel check is a reporter, so it is not stackable', () => {
  const w = ws();
  const px = w.newBlock(C.LOGIC.PIXEL_IS);
  assert.strictEqual(px.previousConnection, null, 'a reporter cannot be stacked');
  assert.strictEqual(px.nextConnection, null);
  px.dispose(false);
});

test('a Boolean reporter cannot connect into a numeric socket', () => {
  // The separation is enforced by Blockly's own type check, and it is correct:
  // `wait (a) > (b)` would mean "wait 1ms" or "wait 0ms" depending on the
  // answer. Conditions belong in an `if`.
  const w = ws();
  const hold = w.newBlock(C.KEYBOARD.HOLD);
  assert.deepStrictEqual(hold.getInput('MS').connection.check, ['Number']);
  const gt = w.newBlock(C.LOGIC.GREATER);
  assert.deepStrictEqual(gt.outputConnection.check, ['Boolean']);
  const before = hold.getInputTargetBlock('MS');
  hold.getInput('MS').connection.connect(gt.outputConnection);
  assert.strictEqual(
    hold.getInputTargetBlock('MS'),
    before,
    'the number shadow must survive a refused connection'
  );
  gt.dispose(false);
  hold.dispose(false);
});

test('a comparison physically connects into the if condition socket', () => {
  const w = ws();
  const ifBlock = w.newBlock(C.CONTROL.IF);
  const cmp = w.newBlock(C.LOGIC.GREATER);
  ifBlock.getInput('COND').connection.connect(cmp.outputConnection);
  assert.strictEqual(ifBlock.getInputTargetBlock('COND'), cmp);
  cmp.dispose(false);
  ifBlock.dispose(false);
});

test('a plain number cannot connect into the if condition socket', () => {
  // The Boolean check is what makes the error impossible to hit by dragging.
  const w = ws();
  const ifBlock = w.newBlock(C.CONTROL.IF);
  const num = w.newBlock(C.VALUE.NUMBER);
  assert.strictEqual(ifBlock.getInput('COND').connection.check[0], 'Boolean');
  num.dispose(false);
  ifBlock.dispose(false);
});

test('a plain number cannot connect into the if condition socket', () => {
  // The Boolean check is what makes the error impossible to hit by dragging.
  const w = ws();
  const ifBlock = w.newBlock(C.CONTROL.IF);
  assert.deepStrictEqual(ifBlock.getInput('COND').connection.check, ['Boolean']);
  const before = ifBlock.getInput('COND').connection.targetConnection;
  const num = w.newBlock(C.VALUE.NUMBER);
  ifBlock.getInput('COND').connection.connect(num.outputConnection);
  assert.strictEqual(
    ifBlock.getInput('COND').connection.targetConnection,
    before,
    'a Number must be refused by a Boolean socket'
  );
  num.dispose(false);
  ifBlock.dispose(false);
});

test('the if block has both branches as statement inputs', () => {
  const w = ws();
  const b = w.newBlock(C.CONTROL.IF);
  assert.ok(b.getInput('THEN'), 'then branch');
  assert.ok(b.getInput('ELSE'), 'else branch');
  assert.ok(b.previousConnection, 'an if can sit under another block');
  b.dispose(false);
});

test('an if block round-trips through save and load with both branches intact', () => {
  const w = ws();
  const ifBlock = w.newBlock(C.CONTROL.IF);
  const cmp = w.newBlock(C.LOGIC.LESS);
  ifBlock.getInput('COND').connection.connect(cmp.outputConnection);
  chainInto(ifBlock, 'THEN', [w.newBlock(C.KEYBOARD.TYPE), w.newBlock(C.KEYBOARD.TYPE)]);
  chainInto(ifBlock, 'ELSE', [w.newBlock(C.MOUSE.CLICK)]);

  const state = Blockly.serialization.blocks.save(ifBlock);
  const json = JSON.parse(JSON.stringify(state));

  // `append` is the public one-block loader; `serialization.blocks.load` does
  // not exist in this Blockly version.
  const w2 = ws();
  const restored = Blockly.serialization.blocks.append(json, w2);
  assert.ok(restored, 'the block must reload');

  // compileState takes SERIALIZED state, not a live block - so save it back out
  // again. That also means this round trip is exercised twice, which is exactly
  // what a real save-then-load-then-save-then-compile cycle does.
  const res = compiler.compileState(Blockly.serialization.blocks.save(restored));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  const step = res.steps[0];
  assert.strictEqual(step.type, constants.STEP.IF);
  assert.strictEqual(step.then.length, 2, 'both then-blocks came back');
  assert.strictEqual(step.else.length, 1, 'the else block came back');
});

test('an if block with no condition reports the error rather than running blind', () => {
  const w = ws();
  const ifBlock = w.newBlock(C.CONTROL.IF);
  chainInto(ifBlock, 'THEN', [w.newBlock(C.KEYBOARD.TYPE)]);

  const json = JSON.parse(JSON.stringify(Blockly.serialization.blocks.save(ifBlock)));
  const w2 = ws();
  const restored = Blockly.serialization.blocks.append(json, w2);
  const res = compiler.compileState(Blockly.serialization.blocks.save(restored));
  assert.strictEqual(res.ok, false, 'a missing condition is an error');
  assert.match(res.errors.join(' '), /has no condition/);
});

test('start blocks are hats with no previous connection', () => {
  const w = ws();
  for (const type of Object.values(C.START)) {
    const b = w.newBlock(type);
    assert.strictEqual(b.previousConnection, null, type + ' must not have a previous connection');
    assert.ok(b.getInput('DO'), type + ' must have a DO statement body');
    b.dispose(false);
  }
});

test('action and value blocks wire up correctly', () => {
  const w = ws();
  const statements = Object.values(C.MOUSE).concat(Object.values(C.KEYBOARD)).concat(Object.values(C.CONTROL));
  for (const type of statements) {
    const b = w.newBlock(type);
    assert.ok(b.previousConnection, type + ' needs a previous connection');
    assert.ok(b.nextConnection, type + ' needs a next connection');
    b.dispose(false);
  }
  for (const type of Object.values(C.VALUE)) {
    const b = w.newBlock(type);
    assert.ok(b.outputConnection, type + ' needs an output connection');
    assert.strictEqual(b.previousConnection, null, type + ' must not connect as a statement');
    b.dispose(false);
  }
});

test('numeric sockets start with a real number shadow', () => {
  const w = ws();
  const checks = [
    [C.CONTROL.WAIT, 'MS'],
    [C.CONTROL.REPEAT, 'COUNT'],
    [C.KEYBOARD.PRESS_TIMES, 'COUNT'],
    [C.KEYBOARD.PRESS_TIMES, 'GAP'],
    [C.KEYBOARD.HOLD, 'MS'],
    [C.START.PRESS, 'COUNT'],
  ];
  for (const [type, inputName] of checks) {
    const b = w.newBlock(type);
    const target = b.getInputTargetBlock(inputName);
    assert.ok(target, type + '.' + inputName + ' should have a default shadow plugged in');
    assert.strictEqual(target.type, C.VALUE.NUMBER);
    assert.strictEqual(target.isShadow(), true, type + '.' + inputName + ' should be a shadow');
    assert.strictEqual(typeof target.getFieldValue('NUM'), 'number');
    b.dispose(false);
  }
});

test('forever and range chips drop into the same sockets', () => {
  const w = ws();
  const wait = w.newBlock(C.CONTROL.WAIT);
  const forever = w.newBlock(C.VALUE.FOREVER);
  wait.getInput('MS').connection.connect(forever.outputConnection);
  assert.strictEqual(wait.getInputTargetBlock('MS').type, C.VALUE.FOREVER);
  assert.deepStrictEqual(
    compiler.compileState(Blockly.serialization.blocks.save(wait)).steps[0].ms,
    { kind: 'forever' }
  );

  const range = w.newBlock(C.VALUE.RANGE);
  wait.getInput('MS').connection.connect(range.outputConnection);
  range.getField('MIN').setValue(2);
  range.getField('MAX').setValue(4);
  assert.deepStrictEqual(
    compiler.compileState(Blockly.serialization.blocks.save(wait)).steps[0].ms,
    { kind: 'range', min: 2000, max: 4000 }
  );
});

// -------------------------------------------------------------- chooser

test('chooser starts with two pages', () => {
  const w = ws();
  const ch = w.newBlock(C.CONTROL.RANDOM_CHOOSER);
  assert.deepStrictEqual(ch.mbChooser.describe(), { mode: 'random', page: 1, pages: 2, empty: 2 });
});

test('chooser pages keep their own blocks when navigating', () => {
  const w = ws();
  const ch = w.newBlock(C.CONTROL.ORGANIZED_CHOOSER);
  const a = w.newBlock(C.KEYBOARD.TYPE);
  a.getField('TEXT').setValue('page0');
  ch.getInput('DO').connection.connect(a.previousConnection);

  ch.mbChooser.next();
  const b = w.newBlock(C.KEYBOARD.TYPE);
  b.getField('TEXT').setValue('page1');
  ch.getInput('DO').connection.connect(b.previousConnection);

  ch.mbChooser.prev();
  assert.strictEqual(ch.getInputTargetBlock('DO').getFieldValue('TEXT'), 'page0');
  ch.mbChooser.next();
  assert.strictEqual(ch.getInputTargetBlock('DO').getFieldValue('TEXT'), 'page1');

  const live = w.getAllBlocks(false).filter((x) => x.type === C.KEYBOARD.TYPE);
  assert.strictEqual(live.length, 1, 'only the live page should be materialised');
});

test('chooser pages survive a JSON round trip without duplication', () => {
  const w = ws();
  const ch = w.newBlock(C.CONTROL.ORGANIZED_CHOOSER);
  const mk = (txt) => {
    const b = w.newBlock(C.KEYBOARD.TYPE);
    b.getField('TEXT').setValue(txt);
    return b;
  };

  // Grow to three pages first, then fill each one in turn.
  ch.mbChooser.addPage(); // 3 pages, still showing page 0
  ch.getInput('DO').connection.connect(mk('alpha').previousConnection);
  ch.mbChooser.next();
  ch.getInput('DO').connection.connect(mk('beta').previousConnection);
  ch.mbChooser.next();
  ch.getInput('DO').connection.connect(mk('gamma').previousConnection);
  assert.deepStrictEqual(ch.mbChooser.describe(), { mode: 'organized', page: 3, pages: 3, empty: 0 });

  const saved = Blockly.serialization.blocks.save(ch, { addCoordinates: false });
  const text = JSON.stringify(saved);
  assert.strictEqual(text.split('"alpha"').length - 1, 1, 'alpha must appear exactly once');
  assert.strictEqual(text.split('"beta"').length - 1, 1, 'beta must appear exactly once');
  assert.strictEqual(text.split('"gamma"').length - 1, 1, 'gamma must appear exactly once');

  const w2 = ws();
  const ch2 = Blockly.serialization.blocks.append(saved, w2);
  assert.strictEqual(ch2.mbChooser.stash.length, 3);
  assert.strictEqual(ch2.getInputTargetBlock('DO').getFieldValue('TEXT'), 'gamma', 'active page restored');

  ch2.mbChooser.setPage(0);
  assert.strictEqual(ch2.getInputTargetBlock('DO').getFieldValue('TEXT'), 'alpha');
  ch2.mbChooser.setPage(1);
  assert.strictEqual(ch2.getInputTargetBlock('DO').getFieldValue('TEXT'), 'beta');
  ch2.mbChooser.setPage(2);
  assert.strictEqual(ch2.getInputTargetBlock('DO').getFieldValue('TEXT'), 'gamma');

  const again = Blockly.serialization.blocks.save(ch2, { addCoordinates: false });
  assert.strictEqual(JSON.stringify(again), JSON.stringify(saved), 'round trip must be stable');
});

test('a chooser compiled from a REAL workspace yields one step per page', () => {
  const w = ws();
  const start = w.newBlock(C.START.RUN);
  const ch = w.newBlock(C.CONTROL.RANDOM_CHOOSER);
  chainInto(start, 'DO', [ch]);

  const a = w.newBlock(C.KEYBOARD.TYPE);
  a.getField('TEXT').setValue('one');
  ch.getInput('DO').connection.connect(a.previousConnection);
  ch.mbChooser.next();
  const b = w.newBlock(C.KEYBOARD.TYPE);
  b.getField('TEXT').setValue('two');
  ch.getInput('DO').connection.connect(b.previousConnection);
  ch.mbChooser.prev();

  const res = compiler.compileWorkspace(w);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  const step = res.steps[0];
  assert.strictEqual(step.type, 'chooser');
  assert.strictEqual(step.mode, 'random');
  assert.deepStrictEqual(step.pages.map((p) => p.map((s) => s.text)), [['one'], ['two']]);
  assert.strictEqual(step.id, ch.id, 'the chooser id is what makes the organized cursor persistent');
});

test('adding pages works up to the documented maximum, then refuses', () => {
  const w = ws();
  const ch = w.newBlock(C.CONTROL.RANDOM_CHOOSER);
  let guard = 0;
  while (ch.mbChooser.addPage().ok && guard++ < 100) {
    /* keep adding */
  }
  assert.strictEqual(ch.mbChooser.stash.length, constants.LIMITS.MAX_CHOOSER_PAGES);
  assert.match(ch.mbChooser.addPage().reason, /at most/);
});

test('deleting the active page shows a surviving neighbour', () => {
  const w = ws();
  const ch = w.newBlock(C.CONTROL.RANDOM_CHOOSER);
  const mk = (txt) => {
    const b = w.newBlock(C.KEYBOARD.TYPE);
    b.getField('TEXT').setValue(txt);
    return b;
  };
  ch.mbChooser.addPage(); // 3 pages so a delete is allowed
  ch.getInput('DO').connection.connect(mk('p0').previousConnection);
  ch.mbChooser.next();
  ch.getInput('DO').connection.connect(mk('p1').previousConnection);
  ch.mbChooser.next();
  ch.getInput('DO').connection.connect(mk('p2').previousConnection);

  ch.mbChooser.setPage(1);
  const res = ch.mbChooser.deletePage(1);
  assert.strictEqual(res.ok, true, res.reason || '');
  assert.strictEqual(ch.mbChooser.stash.length, 2);
  assert.strictEqual(ch.getInputTargetBlock('DO').getFieldValue('TEXT'), 'p2', 'the next page slid in');
  ch.mbChooser.setPage(0);
  assert.strictEqual(ch.getInputTargetBlock('DO').getFieldValue('TEXT'), 'p0');
});

test('a chooser refuses to drop below two pages', () => {
  const w = ws();
  const ch = w.newBlock(C.CONTROL.RANDOM_CHOOSER);
  const res = ch.mbChooser.deletePage(0);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /at least 2 pages/);
});

test('page navigation wraps around in both directions', () => {
  const w = ws();
  const ch = w.newBlock(C.CONTROL.RANDOM_CHOOSER); // 2 pages
  ch.mbChooser.prev();
  assert.strictEqual(ch.mbChooser.page, 1, 'prev from page 0 should wrap to the last page');
  ch.mbChooser.next();
  assert.strictEqual(ch.mbChooser.page, 0, 'next from the last page should wrap to page 0');
});

test('the chooser exposes its API for the UI action handlers', () => {
  const w = ws();
  const ch = w.newBlock(C.CONTROL.RANDOM_CHOOSER);
  ['next', 'prev', 'addPage', 'deletePage'].forEach((m) => {
    assert.strictEqual(typeof ch.mbChooser[m], 'function', 'missing chooser API: ' + m);
  });
  assert.deepStrictEqual(blockReg.chooserTypes, [C.CONTROL.RANDOM_CHOOSER, C.CONTROL.ORGANIZED_CHOOSER]);
});

// ------------------------------------------- real workspace -> step list

test('a realistic macro compiles end to end from a real workspace', () => {
  const w = ws();
  const start = w.newBlock(C.START.PRESS);
  start.getField('BUTTON').setValue('key:F6');

  const click = w.newBlock(C.MOUSE.CLICK);
  click.getField('BUTTON').setValue('mouse:1');
  setNumSocket(click, 'X', 500);
  setNumSocket(click, 'Y', 400);

  const type = w.newBlock(C.KEYBOARD.TYPE);
  type.getField('TEXT').setValue('hi');

  const repeat = w.newBlock(C.CONTROL.REPEAT);
  const hold = w.newBlock(C.KEYBOARD.HOLD);
  hold.getField('BUTTON').setValue('key:LeftShift');
  chainInto(repeat, 'DO', [hold]);

  const runOther = w.newBlock(C.CONTROL.RUN_MACRO);
  // The dropdown is dynamic, so the name must exist before it is selected.
  DROP_NAMES.length = 0;
  DROP_NAMES.push('Other');
  runOther.getField('MACRO').setValue('Other');

  chainInto(start, 'DO', [click, type, repeat, runOther]);

  COMPILE_NAMES.length = 0;
  COMPILE_NAMES.push('Other');

  const res = compiler.compileWorkspace(w);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.kind, constants.START.BUTTON_COUNT);
  assert.strictEqual(res.start.button, 'key:F6');
  assert.deepStrictEqual(res.steps.map((s) => s.type), ['click', 'typeText', 'repeat', 'runMacro']);
  assert.deepStrictEqual(res.steps[0], { type: 'click', button: 'mouse:1', x: 500, y: 400 });
  assert.strictEqual(res.steps[2].count.value, 10, 'repeat default is 10');
  assert.strictEqual(res.steps[2].body[0].button, 'key:LeftShift');
  assert.strictEqual(res.steps[2].body[0].ms.value, 1000, 'hold default is 1000ms');
  assert.strictEqual(res.steps[3].name, 'Other');
});

// ------------------------------------------------- numbers as value chips
//
// Every numeric input is a socket now, so a number chip can drive it. Two
// rules follow, and both are load-bearing:
//
//   1. A chip with a compile-time value (a plain number) is read normally.
//   2. A chip whose value only exists WHILE THE MACRO RUNS cannot be inlined
//      into a literal coordinate, so it warns and falls back - rather than
//      silently clicking somewhere the user never chose.
//
// Macros saved before the socket change still carry plain fields, and those
// must keep compiling. That is the whole reason numInput exists.

test('a number chip drives a coordinate socket', () => {
  // Built by editing the serialized state, the way every other test in this
  // file does. A headless Workspace cannot run Blockly's connection safety
  // checks (they need a view), so wiring blocks live is not available here.
  const click = clickAt(ws(), 0, 0);
  const state = Blockly.serialization.blocks.save(click, { addCoordinates: false });
  // Replace the X shadow with a connected number chip, as dropping one in does.
  state.inputs.X = { block: { type: C.VALUE.NUMBER, fields: { NUM: { value: 742 } } } };

  const res = compiler.compileState(state);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].x, 742, 'the chip value should drive x');
  assert.strictEqual(res.steps[0].y, 0);
});

test('a runtime-only chip in a coordinate warns instead of silently reading 0', () => {
  const click = clickAt(ws(), 0, 0);
  const state = Blockly.serialization.blocks.save(click, { addCoordinates: false });
  // "random" has no value until the macro runs.
  state.inputs.X = { block: { type: C.VALUE.RANGE, fields: { MIN: { value: 1 }, MAX: { value: 9 } } } };

  const res = compiler.compileState(state);
  assert.strictEqual(res.ok, true, 'a warning is not an error');
  assert.strictEqual(res.steps[0].x, 0, 'falls back to the documented default');
  assert.ok(
    res.warnings.some((m) => /not known until the macro runs/.test(m)),
    'the user must be told why the chip was ignored: ' + JSON.stringify(res.warnings)
  );
});

test('an empty coordinate socket uses the same default a field would have', () => {
  const click = clickAt(ws(), 0, 0);
  const state = Blockly.serialization.blocks.save(click, { addCoordinates: false });
  delete state.inputs.X; // nothing at all in the socket
  delete state.inputs.Y;
  const res = compiler.compileState(state);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].x, 0);
  assert.strictEqual(res.steps[0].y, 0);
});

test('press-times defaults to ONE press, not three', () => {
  const w = ws();
  const b = w.newBlock(C.KEYBOARD.PRESS_TIMES);
  b.getField('BUTTON').setValue('key:F6');
  const state = Blockly.serialization.blocks.save(b, { addCoordinates: false });
  const count = state.inputs.COUNT.shadow;
  assert.strictEqual(
    count.fields.NUM,
    1,
    'the shadow should say 1, because that is what an untouched block does'
  );
  b.dispose(false);
});

test('a workspace with no hat block compiled directly reports the problem', () => {
  const w = ws();
  const type = w.newBlock(C.KEYBOARD.TYPE);
  type.getField('TEXT').setValue('lonely');
  const res = compiler.compileSelection(w, { blocks: [type] });
  assert.strictEqual(res.ok, true, 'run-selected does not need a hat');
  assert.deepStrictEqual(res.steps.map((s) => s.text), ['lonely']);
  assert.match(compiler.compileWorkspace(w).errors[0], /no start block/);
});

test('the button picker field labels buttons via the injected describer', () => {
  const w = ws();
  const press = w.newBlock(C.KEYBOARD.PRESS);
  const f = press.getField('BUTTON');
  assert.strictEqual(f.getText_(), 'A', 'the default key:A should render as "A"');
  f.setValue('mouse:2');
  assert.match(f.getText_(), /Right/);
  assert.strictEqual(press.getFieldValue('BUTTON'), 'mouse:2');
  // An explicitly cleared button shows the call-to-action rather than a blank.
  f.setValue('');
  assert.strictEqual(f.getText_(), '\u25cc  pick a key');
});

test('the renderer-side button catalog factory is exported for the UI', () => {
  // createRemoteCatalog lives on the MODULE, not on a createCatalog() instance:
  // the renderer needs it to build a synchronous catalog from the table the main
  // process sends at bootstrap (IPC is async, but the compiler is not).
  assert.strictEqual(typeof buttonMod.createRemoteCatalog, 'function');

  const remote = buttonMod.createRemoteCatalog({
    'key:A': { label: 'A', sim: true },
    'mouse:4': { label: 'Side 1', sim: false },
  });
  assert.strictEqual(remote.describe('key:A'), 'A');
  assert.strictEqual(remote.validate('key:A').button.sim, true);
  assert.strictEqual(remote.validate('mouse:4').button.sim, false);
  assert.strictEqual(remote.validate('mouse:4').ok, true, 'detectable inputs are still valid ids');
  assert.strictEqual(remote.validate('nonsense').ok, false);
  assert.throws(() => remote.toNutButton('mouse:1'), /main process/);
});

test('the colour field validates and normalises hex input', () => {
  const w = ws();
  const start = w.newBlock(C.START.PIXEL);
  const f = start.getField('COLOUR');
  f.setValue('ff00aa');
  assert.strictEqual(f.getValue(), '#ff00aa');
  assert.strictEqual(f.doClassValidation_('nope'), null);
  assert.strictEqual(f.doClassValidation_('#12AB34'), '#12ab34');
});

test('the run-another-macro dropdown recomputes its options each time it is read', () => {
  const w = ws();
  const b = w.newBlock(C.CONTROL.RUN_MACRO);
  const dd = b.getField('MACRO');
  DROP_NAMES.length = 0;
  assert.deepStrictEqual(dd.getOptions(false), [['(no saved macros)', '']]);
  DROP_NAMES.push('Farm', 'Sell');
  assert.deepStrictEqual(dd.getOptions(false), [['Farm', 'Farm'], ['Sell', 'Sell']]);
});

test('a macro saved after the block was created can still be selected', () => {
  const w = ws();
  DROP_NAMES.length = 0;
  const b = w.newBlock(C.CONTROL.RUN_MACRO);
  // The block already exists with an empty macro list...
  DROP_NAMES.push('Later');
  // ...and the option becomes selectable without recreating the block.
  b.getField('MACRO').setValue('Later');
  assert.strictEqual(b.getFieldValue('MACRO'), 'Later');
});

// ------------------------------ workspace invariants (needs real blocks)

test('BOTH start blocks compile - neither is discarded', () => {
  const w = ws();
  const hold = w.newBlock(C.START.HOLD);
  hold.getField('BUTTON').setValue('mouse:2');
  chainInto(hold, 'DO', [w.newBlock(C.KEYBOARD.TYPE)]);
  const run = w.newBlock(C.START.RUN);
  chainInto(run, 'DO', [w.newBlock(C.MOUSE.MOVE_TO)]);

  assert.strictEqual(compiler.findStartBlocks(w).length, 2);
  const res = compiler.compileWorkspace(w);
  assert.strictEqual(res.ok, true, res.errors.join('; '));

  // Both triggers are usable, each with its OWN body - that was the bug.
  assert.strictEqual(res.triggers.length, 2, 'both hats must compile to triggers');
  const kinds = res.triggers.map((t) => t.start.kind).sort();
  assert.deepStrictEqual(kinds, [constants.START.HOLD_BUTTON, constants.START.MANUAL].sort());
  assert.strictEqual(new Set(res.triggers.map((t) => t.id)).size, 2, 'trigger ids must be distinct');

  // Each trigger carries its own steps, not a copy of the other's.
  const types = res.triggers.map((t) => t.steps.map((s) => s.type).join(','));
  assert.notStrictEqual(types[0], types[1], 'the two bodies must differ');

  // The old "only the top-most is used" warning is gone, because it is no longer true.
  assert.doesNotMatch(res.warnings.join(' '), /top-most/);
  assert.doesNotMatch(res.warnings.join(' '), /start blocks found/);
});

test('a single start block produces exactly one trigger, and start/steps mirror it', () => {
  const w = ws();
  const run = w.newBlock(C.START.RUN);
  chainInto(run, 'DO', [w.newBlock(C.KEYBOARD.TYPE)]);

  const res = compiler.compileWorkspace(w);
  assert.strictEqual(res.triggers.length, 1);
  assert.deepStrictEqual(res.steps, res.triggers[0].steps, 'back-compat: steps === first trigger');
  assert.deepStrictEqual(res.start, res.triggers[0].start);
});

test('one broken hat does not stop the others compiling', () => {
  const w = ws();
  const good = w.newBlock(C.START.RUN);
  chainInto(good, 'DO', [w.newBlock(C.KEYBOARD.TYPE)]);
  // A window wait with no title is a compile error on its own.
  const bad = w.newBlock(C.START.PRESS);
  bad.getField('BUTTON').setValue('key:A');
  const badWait = w.newBlock(C.CONTROL.WAIT_FOR_WINDOW);
  badWait.getField('TITLE').setValue('   ');
  chainInto(bad, 'DO', [badWait]);

  const res = compiler.compileWorkspace(w);
  assert.strictEqual(res.triggers.length, 2, 'both triggers are still reported');
  assert.strictEqual(res.ok, false, 'the broken one is still reported as an error');
});

test('a press trigger with its own count socket compiles from a real workspace', () => {
  const w = ws();
  const s = w.newBlock(C.START.PRESS);
  s.getField('BUTTON').setValue('key:F6');
  const count = w.newBlock(C.VALUE.NUMBER);
  count.getField('NUM').setValue(4);
  s.getInput('COUNT').connection.connect(count.outputConnection);
  // The default shadow must be displaced by the real block.
  assert.strictEqual(s.getInputTargetBlock('COUNT').isShadow(), false);

  const res = compiler.compileWorkspace(w);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.kind, constants.START.BUTTON_COUNT);
  assert.strictEqual(res.start.button, 'key:F6');
  assert.deepStrictEqual(res.start.count, { kind: 'number', value: 4 });
});

test('run selected skips blocks whose ancestor is also selected', () => {
  const w = ws();
  const repeat = w.newBlock(C.CONTROL.REPEAT);
  const child = w.newBlock(C.KEYBOARD.TYPE);
  child.getField('TEXT').setValue('child');
  repeat.getInput('DO').connection.connect(child.previousConnection);

  const sibling = w.newBlock(C.KEYBOARD.TYPE);
  sibling.getField('TEXT').setValue('sibling');

  // Selecting BOTH the repeat and its child must only run the child once.
  const res = compiler.compileSelection(w, { blocks: [repeat, child, sibling] });
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps.length, 2, 'repeat + sibling, not repeat + child + sibling');
  assert.strictEqual(res.steps[0].type, constants.STEP.REPEAT);
  assert.strictEqual(res.steps[0].body.length, 1);
  assert.strictEqual(res.steps[1].text, 'sibling');
});

test('run selected on a start block compiles only its body (no trigger)', () => {
  const w = ws();
  const start = w.newBlock(C.START.RUN);
  const child = w.newBlock(C.KEYBOARD.TYPE);
  child.getField('TEXT').setValue('only');
  start.getInput('DO').connection.connect(child.previousConnection);

  const res = compiler.compileSelection(w, { blocks: [start] });
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.kind, constants.START.MANUAL);
  assert.deepStrictEqual(res.steps.map((s) => s.text), ['only']);
});

test('a full workspace save and reload still compiles identically', () => {
  const w = ws();
  const start = w.newBlock(C.START.RUN);
  const type = w.newBlock(C.KEYBOARD.TYPE);
  type.getField('TEXT').setValue('hello');
  const ch = w.newBlock(C.CONTROL.ORGANIZED_CHOOSER);
  chainInto(start, 'DO', [type, ch]);
  ch.getInput('DO').connection.connect(w.newBlock(C.KEYBOARD.TYPE).previousConnection);
  ch.mbChooser.next();
  const b = w.newBlock(C.KEYBOARD.TYPE);
  b.getField('TEXT').setValue('page two');
  ch.getInput('DO').connection.connect(b.previousConnection);

  const before = compiler.compileWorkspace(w);
  assert.strictEqual(before.ok, true, before.errors.join('; '));

  const w2 = ws();
  Blockly.serialization.workspaces.load(Blockly.serialization.workspaces.save(w), w2);
  const after = compiler.compileWorkspace(w2);

  assert.strictEqual(after.ok, true, after.errors.join('; '));
  // Chooser block ids differ per instance by design, so compare everything else.
  const strip = (steps) =>
    JSON.parse(
      JSON.stringify(steps, (k, v) => (k === 'id' && typeof v === 'string' ? 'ID' : v))
    );
  assert.deepStrictEqual(strip(after.steps), strip(before.steps));
});

// ------------------------------------------------------- wait blocks

test('the number chip keeps decimals - Blockly precision is a STEP, not decimals', () => {
  // REGRESSION: the fields were built with `precision: 1`, which rounds to whole
  // numbers. So typing 3.432 into a wait socket silently became 3, and 5.4
  // became 5. `precision: 0` means "do not round", which is what time slots need.
  const w = ws();
  const chip = w.newBlock(C.VALUE.NUMBER);
  const field = chip.getField('NUM');
  for (const [typed, want] of [['3.432', 3.432], ['5.4', 5.4], ['0.001', 0.001], ['776', 776]]) {
    field.setValue(typed);
    assert.strictEqual(Number(field.getValue()), want, 'typed ' + typed + ' but the field holds ' + field.getValue());
  }
});

test('the number chip still enforces min/max without rounding', () => {
  // `precision: 0` disables Blockly's rounding but must NOT disable clamping.
  const field = new Blockly.FieldNumber(0, 0, constants.LIMITS.MAX_WAIT_MS, 0);
  field.setValue('999999999');
  assert.ok(Number(field.getValue()) <= constants.LIMITS.MAX_WAIT_MS, 'max is still enforced');
  field.setValue('-50');
  assert.ok(Number(field.getValue()) >= 0, 'min is still enforced');
  field.setValue('3.5');
  assert.strictEqual(Number(field.getValue()), 3.5, 'and it still does not round');
});

test('the wait and wait-ms blocks both exist and default to sensible units', () => {
  const w = ws();
  const secs = w.newBlock(C.CONTROL.WAIT);
  const ms = w.newBlock(C.CONTROL.WAIT_MS);
  assert.ok(secs.getInput('MS'), 'seconds block has its socket');
  assert.ok(ms.getInput('MS'), 'ms block has its socket');
  assert.strictEqual(socketDefault(secs), 1, 'the seconds block should default to 1');
  assert.strictEqual(socketDefault(ms), 100, 'the ms block should default to 100');
});

/** Read the numeric default declared by a block's shadow state. */
function socketDefault(block) {
  const state = block.getInput('MS').connection.getShadowState();
  return state && state.fields ? state.fields.NUM : undefined;
}

// ------------------------------------------------- move mouse within
//
// The four bounds are SOCKETS, so number chips can drive them, and they must
// still read a macro saved back when they were plain fields.

test('move mouse within emits a plain duration, not a slot', () => {
  // The compiler emits ms as a literal, like moveTo/moveBy do. If the engine
  // ever routes it through resolveSlot, a non-slot reads as 0 and every move
  // becomes instantaneous - so assert the SHAPE here, not just the value.
  const w = ws();
  const b = w.newBlock(C.MOUSE.MOVE_WITHIN);
  setNumSocket(b, 'X1', 10);
  setNumSocket(b, 'X2', 400);
  setNumSocket(b, 'Y1', 20);
  setNumSocket(b, 'Y2', 300);
  setNumSocket(b, 'MS', 150);
  const res = compiler.compileState(Blockly.serialization.blocks.save(b, { addCoordinates: false }));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(typeof res.steps[0].ms, 'number', 'ms must be a literal number');
  assert.deepStrictEqual(res.steps[0], {
    type: 'moveWithin',
    x1: 10,
    x2: 400,
    y1: 20,
    y2: 300,
    ms: 150,
  });
});

test('move mouse within defaults to a 200x200 area at the origin', () => {
  const w = ws();
  const b = w.newBlock(C.MOUSE.MOVE_WITHIN);
  const res = compiler.compileState(Blockly.serialization.blocks.save(b, { addCoordinates: false }));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].x1, 0);
  assert.strictEqual(res.steps[0].y1, 0);
  assert.strictEqual(res.steps[0].x2, 200);
  assert.strictEqual(res.steps[0].y2, 200);
});

test('a number chip can drive each bound of move mouse within', () => {
  const w = ws();
  const b = w.newBlock(C.MOUSE.MOVE_WITHIN);
  const json = Blockly.serialization.blocks.save(b, { addCoordinates: false });
  json.inputs.X1 = { block: { type: C.VALUE.NUMBER, fields: { NUM: { value: 777 } } } };
  json.inputs.Y2 = { block: { type: C.VALUE.NUMBER, fields: { NUM: { value: 888 } } } };
  const res = compiler.compileState(json);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].x1, 777);
  assert.strictEqual(res.steps[0].y2, 888);
});

// No back-compat test here on purpose: this block did not exist before today,
// so there is no older saved shape of it to stay compatible with.

test('the four bounds really are sockets, so chips fit', () => {
  const w = ws();
  const b = w.newBlock(C.MOUSE.MOVE_WITHIN);
  for (const n of ['X1', 'X2', 'Y1', 'Y2', 'MS']) {
    assert.ok(b.getInput(n), n + ' should be a socket');
  }
// Exactly ONE pick button for the two corners - two would let you build a
  // rectangle inside-out and would contradict "click twice".
  let pickFields = 0;
  (b.inputList || []).forEach((input) => {
    (input.fieldRow || []).forEach((f) => {
      if (f && f.action_ === 'pickRect') pickFields++;
    });
  });
  assert.strictEqual(pickFields, 1, 'exactly one pick button, got ' + pickFields);
});
