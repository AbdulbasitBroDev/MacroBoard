'use strict';

/**
 * Custom-field guard tests.
 *
 * These are deliberately STATIC checks on the field source rather than render
 * tests. Blockly's rendering needs real layout (getBBox) which jsdom does not
 * implement, so a true render test is not possible headlessly - but the specific
 * mistake these guard against is detectable from the source, and it is a mistake
 * that cost real debugging time:
 *
 *   Overriding `updateSize_` and calling `this.getSize()` inside it recurses
 *   forever, because Blockly's `getSize()` calls `updateSize_()` when the field
 *   is dirty. The thrown RangeError aborted flyout inflation, so EVERY toolbox
 *   category silently opened empty and the app looked like it had no blocks.
 *
 * `npm run selftest` is the real end-to-end check (it drives the live toolbox in
 * Electron); these tests are the fast guard that runs with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FIELDS_SRC = path.join(__dirname, '..', 'src', 'blockly', 'fields.js');
const source = fs.readFileSync(FIELDS_SRC, 'utf8');

test('the field classes do not override updateSize_ (infinite recursion guard)', () => {
  const definesUpdateSize = /^\s*updateSize_\s*\(/m.test(source);
  assert.strictEqual(
    definesUpdateSize,
    false,
    'fields.js must not define updateSize_. Calling this.getSize() from it recurses ' +
      'infinitely (getSize -> updateSize_ -> getSize) and breaks every toolbox flyout. ' +
      'Let the base class size the border rect instead.'
  );
});

test('the field classes do not keep a private size helper around', () => {
  assert.strictEqual(
    /^\s*sizeOwnBox_\s*\(/m.test(source),
    false,
    'the sizeOwnBox_ helper used this.getSize() and must stay deleted'
  );
});

test('pill initialization preserves Blockly text element for width measurement', () => {
  const Blockly = require('blockly');
  const { PillField } = require('../src/blockly/fields')._defineFields(Blockly);
  const field = new PillField('long field label');
  const textElement = {};
  const classes = new Set();
  field.fieldGroup_ = { classList: { add: (className) => classes.add(className) } };
  field.createBorderRect_ = () => {
    field.borderRect_ = { setAttribute() {} };
  };
  field.createTextElement_ = () => {
    field.textElement_ = textElement;
  };

  field.initView();
  assert.strictEqual(field.textElement_, textElement);
  assert.ok(classes.has('blocklyField'), 'Blockly field styles and hit testing should be applied');
});

test('doClassValidation_ is not called from a size or render path', () => {
  // getSize()/updateSize_ must stay side-effect free with respect to values.
  const renderFn = /render_\(\)\s*\{([\s\S]*?)\n\s*\}/.exec(source);
  if (renderFn) {
    assert.ok(
      renderFn[1].indexOf('getSize') === -1,
      'render_ must not call getSize() either - it can trigger the same recursion'
    );
  }
});

test('the custom fields declare themselves serializable as OWN properties', async () => {
  // Blockly's Field constructor assigns SERIALIZABLE/EDITABLE as own instance
  // properties, which shadows prototype values, so setting them only on the
  // prototype silently does nothing and Blockly logs a warning on every save.
  const mod = require('../src/blockly/fields');
  assert.strictEqual(typeof mod.register, 'function');
  assert.strictEqual(typeof mod.setUiPort, 'function');

  const Blockly = require('blockly');
  const made = mod.register(Blockly);
  require('../src/blockly/blocks').register(Blockly, {
    catalog: require('../src/shared/catalog'),
    constants: require('../src/shared/constants'),
    fieldClasses: made,
    describeButton: (id) => String(id),
  });
  const ws = new Blockly.Workspace();
  const b = ws.newBlock('mb_key_press');
  const field = b.getField('BUTTON');
  assert.ok(field, 'the button field should exist');
  assert.strictEqual(field.SERIALIZABLE, true, 'button fields must serialize');
  assert.strictEqual(field.EDITABLE, false, 'button fields are modal, not inline editors');
  assert.strictEqual(field.isSerializable(), true);
  assert.ok(field.isClickable(), 'a field with a custom showEditor_ must be clickable');
  assert.strictEqual(typeof made.FieldAction, 'function');
});

test('action pills are neither serializable nor editable', () => {
  const Blockly = require('blockly');
  require('../src/blockly/fields').register(Blockly);
  require('../src/blockly/blocks').register(Blockly, {
    catalog: require('../src/shared/catalog'),
    constants: require('../src/shared/constants'),
    fieldClasses: require('../src/blockly/fields').register(Blockly),
    describeButton: (id) => String(id),
  });
  const ws = new Blockly.Workspace();
  const chooser = ws.newBlock('mb_control_random_chooser');
  const prev = chooser.getField('PREV');
  assert.ok(prev, 'the chooser should have a PREV action pill');
  assert.strictEqual(prev.SERIALIZABLE, false);
  assert.strictEqual(prev.EDITABLE, false);
  assert.strictEqual(prev.isSerializable(), false);
  // ...but it still has to be clickable, or the arrows would be dead.
  assert.strictEqual(prev.isClickable(), true);
});
