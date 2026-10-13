'use strict';

/**
 * Compiler tests: Blockly workspace JSON -> engine step list.
 *
 * The compiler is intentionally fed Blockly's SERIALIZED state (not live
 * blocks), which is exactly what it consumes at runtime, so these fixtures are
 * the real input format. test/blocks.test.js additionally round-trips real
 * Blockly workspaces through it to guarantee the fixture shape stays honest.
 */

const test = require('node:test');
const assert = require('node:assert');
const { makeCompiler, registerBlocks, S, E, L, chain, into, shadow, block, catalog, constants, Blockly, expressions } = require('./helpers/env');

const C = catalog;
const LIMITS = constants.LIMITS;
const OP = expressions.OP;

test('a workspace with no start block is a hard error', () => {
  const { compiler, Blockly } = makeCompiler();
  const ws = new Blockly.Workspace();
  const res = compiler.compileWorkspace(ws);
  assert.strictEqual(res.ok, false);
  assert.match(res.errors[0], /no start block/);
  assert.deepStrictEqual(res.steps, []);
});

test('manual start compiles its body in order', () => {
  const { compiler } = makeCompiler();
  const start = into(
    block(C.START.RUN, {}),
    'DO',
    chain(
      block(C.KEYBOARD.TYPE, { TEXT: 'hello' }),
      block(C.MOUSE.CLICK, { BUTTON: 'mouse:1', X: 10, Y: 20 }),
      block(C.KEYBOARD.TYPE, { TEXT: 'world' })
    )
  );
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.kind, constants.START.MANUAL);
  assert.deepStrictEqual(res.steps.map((s) => s.type), ['typeText', 'click', 'typeText']);
  assert.strictEqual(res.steps[0].text, 'hello');
  assert.deepStrictEqual(res.steps[1], { type: 'click', button: 'mouse:1', x: 10, y: 20 });
  assert.strictEqual(compiler.runButtonLabel(res.start), 'Run');
});

// ------------------------------------------------------------- sleep switch

test('the sleep control is a switch field, not a checkbox', () => {
  // The switch subclasses FieldCheckbox so saved macros (which store
  // SUPPRESS as "TRUE"/"FALSE") keep loading unchanged. If someone swaps it for
  // a plain checkbox the data still works, but the UI regresses to a tick box.
  const { fieldClasses } = registerBlocks();
  const { FieldSwitch } = fieldClasses;
  assert.ok(FieldSwitch, 'FieldSwitch must be registered');
  const ws = new Blockly.Workspace();
  const inst = ws.newBlock(catalog.START.PRESS);
  const field = inst.getField('SUPPRESS');
  assert.strictEqual(field.constructor, FieldSwitch, 'must use FieldSwitch');
  // Still a FieldCheckbox in the prototype chain, so a macro saved with a
  // "TRUE"/"FALSE" SUPPRESS field keeps loading with the same meaning.
  assert.ok(
    FieldSwitch.prototype instanceof Blockly.FieldCheckbox,
    'FieldSwitch must extend FieldCheckbox so existing macros load unchanged'
  );
  // A click toggles the value, exactly as a checkbox would.
  const before = field.getValue();
  field.showEditor_();
  assert.notStrictEqual(field.getValue(), before, 'clicking the switch must toggle it');
  field.showEditor_();
  assert.strictEqual(field.getValue(), before, 'clicking again must toggle back');

  // The visible state must follow the stored value. FieldCheckbox's
  // doValueUpdate_ never calls render_, so a switch that draws itself in
  // render_ would store the new value but never repaint.
  const drawn = [];
  field.render_ = () => drawn.push(field.getValueBoolean());
  field.setValue(false);
  field.setValue(true);
  assert.deepStrictEqual(drawn, [false, true], 'every change must repaint the switch');
});

test('a newly created trigger block ships with sleep already ticked', () => {
  // Regression: FieldCheckbox's 2nd constructor arg is a VALIDATOR, not the
  // initial state, so `new FieldCheckbox('sleep', true)` renders UNCHECKED. That
  // silently inverted the default: a fresh block would have blocked the key.
  registerBlocks();
  for (const type of [catalog.START.PRESS, catalog.START.HOLD]) {
    const ws = new Blockly.Workspace();
    const inst = ws.newBlock(type);
    assert.strictEqual(inst.getFieldValue('SUPPRESS'), 'TRUE', type + ' must default to sleep on');
    const res = makeCompiler().compiler.compileState({ type, fields: { SUPPRESS: inst.getFieldValue('SUPPRESS') } });
    assert.strictEqual(res.start.suppress, false, type + ' must not block the key by default');
  }
});

test('sleep ON in the block compiles to suppress: true', () => {
  const { compiler } = makeCompiler();
  const start = shadow(
    into(block(C.START.PRESS, { BUTTON: 'key:Q', SUPPRESS: false }), 'DO', block(C.KEYBOARD.TYPE, { TEXT: 'x' })),
    'COUNT',
    S.num(1)
  );
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.suppress, true, 'sleep off must block the button');
});

test('sleep OFF in the block compiles to suppress: false', () => {
  const { compiler } = makeCompiler();
  const start = shadow(
    into(block(C.START.PRESS, { BUTTON: 'key:Q', SUPPRESS: true }), 'DO', block(C.KEYBOARD.TYPE, { TEXT: 'x' })),
    'COUNT',
    S.num(1)
  );
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.suppress, false, 'sleep on must let the button through');
});

test('a block with no sleep field defaults to sleep on (every saved macro)', () => {
  const { compiler } = makeCompiler();
  // Macros saved before the switch existed carry no SUPPRESS field at all.
  const start = shadow(
    into(block(C.START.PRESS, { BUTTON: 'key:Q' }), 'DO', block(C.KEYBOARD.TYPE, { TEXT: 'x' })),
    'COUNT',
    S.num(1)
  );
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.suppress, false, 'a missing field must not silently start blocking keys');
});

test('the hold trigger carries the same sleep switch', () => {
  const { compiler } = makeCompiler();
  const blocked = compiler.compileState(
    into(block(C.START.HOLD, { BUTTON: 'key:W', SUPPRESS: false }), 'DO', block(C.KEYBOARD.TYPE, { TEXT: 'x' }))
  );
  assert.strictEqual(blocked.start.suppress, true);

  const passing = compiler.compileState(
    into(block(C.START.HOLD, { BUTTON: 'key:W', SUPPRESS: true }), 'DO', block(C.KEYBOARD.TYPE, { TEXT: 'x' }))
  );
  assert.strictEqual(passing.start.suppress, false);
});

test('button-count trigger compiles to a buttonCount start with a count slot', () => {
  const { compiler } = makeCompiler();
  const start = shadow(
    into(block(C.START.PRESS, { BUTTON: 'key:F6' }), 'DO', block(C.KEYBOARD.TYPE, { TEXT: 'x' })),
    'COUNT',
    S.num(3)
  );
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.kind, constants.START.BUTTON_COUNT);
  assert.strictEqual(res.start.button, 'key:F6');
  assert.deepStrictEqual(res.start.count, { kind: 'number', value: 3 });
  assert.strictEqual(res.steps.length, 1);
  assert.strictEqual(compiler.runButtonLabel(res.start), 'Arm');
  assert.match(compiler.describeStart(res.start), /pressed 3x/);
});

test('a trigger may use a side mouse button (detect-only is fine for triggers)', () => {
  const { compiler } = makeCompiler();
  const start = shadow(into(block(C.START.PRESS, { BUTTON: 'mouse:5' }), 'DO', null), 'COUNT', S.num(1));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, 'side buttons are legal as triggers: ' + res.errors.join('; '));
  assert.strictEqual(res.start.button, 'mouse:5');
});

test('an ACTION block may not use a side mouse button, and says why', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', block(C.MOUSE.CLICK, { BUTTON: 'mouse:5', X: 1, Y: 2 }));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, false);
  assert.match(res.errors[0], /cannot perform|cannot simulate/);
  assert.match(res.errors[0], /Side 2|code 5/);
});

test('an ACTION block with no button chosen reports it', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', block(C.KEYBOARD.PRESS, { BUTTON: '' }));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, false);
  assert.match(res.errors[0], /no button chosen/);
});

test('a click block rejects a keyboard key instead of failing at run time', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', block(C.MOUSE.CLICK, { BUTTON: 'key:A', X: 1, Y: 2 }));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, false);
  assert.match(res.errors[0], /needs a MOUSE button/);
});

test('a press block accepts a mouse button (pressing a mouse button is a real action)', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', block(C.KEYBOARD.PRESS, { BUTTON: 'mouse:1' }));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].type, 'pressKey');
  assert.strictEqual(res.steps[0].button, 'mouse:1');
});

test('a hold block accepts a mouse button too', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', shadow(block(C.KEYBOARD.HOLD, { BUTTON: 'mouse:2' }), 'MS', S.num(50)));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].type, 'holdKey');
  assert.strictEqual(res.steps[0].button, 'mouse:2');
});

test('hold trigger compiles, and its body is carried through', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.HOLD, { BUTTON: 'mouse:2' }), 'DO', block(C.KEYBOARD.TYPE, { TEXT: 'a' }));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.kind, constants.START.HOLD_BUTTON);
  assert.strictEqual(res.start.button, 'mouse:2');
  assert.match(compiler.describeStart(res.start), /holding/);
});

test('pixel trigger compiles coordinates, colour, tolerance and poll interval', () => {
  const { compiler } = makeCompiler();
  const start = into(
    block(C.START.PIXEL, { X: 400, Y: 300, COLOUR: '#ff0000', TOLERANCE: 8, POLL: 120 }),
    'DO',
    block(C.KEYBOARD.TYPE, { TEXT: 'hit' })
  );
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.start, {
    kind: constants.START.PIXEL,
    type: C.START.PIXEL,
    x: 400,
    y: 300,
    colour: '#ff0000',
    tolerance: 8,
    pollMs: 120,
  });
  assert.strictEqual(compiler.runButtonLabel(res.start), 'Watch');
});

test('pixel poll interval is clamped into the documented range', () => {
  const { compiler } = makeCompiler();
  const mk = (poll) =>
    compiler.compileState(
      into(block(C.START.PIXEL, { X: 0, Y: 0, COLOUR: '#000000', TOLERANCE: 0, POLL: poll }), 'DO', null)
    );
  assert.strictEqual(mk(1).start.pollMs, constants.PIXEL.MIN_POLL_MS);
  assert.strictEqual(mk(99999).start.pollMs, constants.PIXEL.MAX_POLL_MS);
  assert.strictEqual(mk(100).start.pollMs, 100);
});

test('wait reads SECONDS on the block and compiles to milliseconds', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT, {}), 'MS', S.num(2)));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0], { type: 'wait', ms: { kind: 'number', value: 2000 } });
});

test('the millisecond wait block is NOT scaled by 1000', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT_MS, {}), 'MS', S.num(776)));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0], { type: 'wait', ms: { kind: 'number', value: 776 } });
});

test('both wait blocks compile to the same step type', () => {
  const { compiler } = makeCompiler();
  const secs = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT, {}), 'MS', S.num(1)))
  );
  const ms = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT_MS, {}), 'MS', S.num(1000)))
  );
  assert.strictEqual(secs.steps[0].type, 'wait');
  assert.strictEqual(ms.steps[0].type, 'wait');
  assert.deepStrictEqual(secs.steps[0].ms, ms.steps[0].ms, '1 second and 1000ms must be identical');
});

test('fractional seconds convert exactly (3.432s = 3432ms)', () => {
  const { compiler } = makeCompiler();
  for (const [typed, want] of [[3.432, 3432], [5.4, 5400], [0.5, 500], [0.001, 1], [12.345, 12345]]) {
    const start = into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT, {}), 'MS', S.num(typed)));
    const res = compiler.compileState(start);
    assert.strictEqual(res.steps[0].ms.value, want, typed + ' seconds should be ' + want + 'ms');
  }
});

test('a sub-millisecond wait rounds up to 1ms rather than becoming 0', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT_MS, {}), 'MS', S.num(0.5)));
  assert.strictEqual(compiler.compileState(start).steps[0].ms.value, 1);
});

test('a 0ms wait stays 0 rather than being rounded up', () => {
  const { compiler } = makeCompiler();
  const secs = into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT, {}), 'MS', S.num(0)));
  const ms = into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT_MS, {}), 'MS', S.num(0)));
  assert.strictEqual(compiler.compileState(secs).steps[0].ms.value, 0);
  assert.strictEqual(compiler.compileState(ms).steps[0].ms.value, 0);
});

test('wait supports decimals and the forever chip', () => {
  const { compiler } = makeCompiler();
  const half = into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT, {}), 'MS', S.num(0.5)));
  assert.deepStrictEqual(compiler.compileState(half).steps[0].ms, { kind: 'number', value: 500 });

  const forever = into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.WAIT, {}), 'MS', S.forever()));
  assert.deepStrictEqual(compiler.compileState(forever).steps[0].ms, { kind: 'forever' });
});

test('an absurd wait is capped at the engine maximum with a warning', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT, {}), 'MS', S.num(99999)));
  const res = compiler.compileState(start);
  assert.strictEqual(res.steps[0].ms.value, LIMITS.MAX_WAIT_MS);
  assert.match(res.warnings.join(' '), /capped to the 3600-second maximum/);
});

test('a random range chip compiles to min/max bounds, scaled to ms', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.WAIT, {}), 'MS', S.range(3, 8)));
  const res = compiler.compileState(start);
  assert.deepStrictEqual(res.steps[0].ms, { kind: 'range', min: 3000, max: 8000 });
});

test('a reversed range is flagged with a warning', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.WAIT, {}), 'MS', S.range(8, 3)));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.steps[0].ms, { kind: 'range', min: 8000, max: 3000 });
  assert.match(res.warnings.join(' '), /swapped/);
});

test('repeat compiles a nested body', () => {
  const { compiler } = makeCompiler();
  const repeat = shadow(
    into(
      block(C.CONTROL.REPEAT, {}),
      'DO',
      chain(block(C.KEYBOARD.TYPE, { TEXT: 'a' }), block(C.KEYBOARD.TYPE, { TEXT: 'b' }))
    ),
    'COUNT',
    S.num(4)
  );
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', repeat));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].type, 'repeat');
  assert.deepStrictEqual(res.steps[0].count, { kind: 'number', value: 4 });
  assert.deepStrictEqual(res.steps[0].body.map((s) => s.text), ['a', 'b']);
});

test('at once compiles a body of concurrent branches', () => {
  const { compiler } = makeCompiler();
  const start = into(
    block(C.START.RUN, {}),
    'DO',
    into(
      block(C.CONTROL.AT_ONCE, {}),
      'DO',
      chain(
        shadow(block(C.KEYBOARD.HOLD, { BUTTON: 'key:A' }), 'MS', S.num(1000)),
        shadow(block(C.KEYBOARD.HOLD, { BUTTON: 'key:B' }), 'MS', S.num(1000))
      )
    )
  );
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].type, 'atOnce');
  assert.strictEqual(res.steps[0].body.length, 2);
  assert.deepStrictEqual(res.steps[0].body.map((s) => s.button), ['key:A', 'key:B']);
  assert.deepStrictEqual(res.steps[0].body[0].ms, { kind: 'number', value: 1000 });
});

test('press N times with a gap compiles both sockets', () => {
  const { compiler } = makeCompiler();
  const node = shadow(
    shadow(block(C.KEYBOARD.PRESS_TIMES, { BUTTON: 'key:Space' }), 'COUNT', S.num(5)),
    'GAP',
    S.num(120)
  );
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0], {
    type: 'pressKey',
    button: 'key:Space',
    count: { kind: 'number', value: 5 },
    gapMs: { kind: 'number', value: 120 },
  });
});

test('a bare press block hard-codes count 1 and gap 0', () => {
  const { compiler } = makeCompiler();
  const node = block(C.KEYBOARD.PRESS, { BUTTON: 'key:LeftShift' });
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.deepStrictEqual(res.steps[0].count, { kind: 'number', value: 1 });
  assert.deepStrictEqual(res.steps[0].gapMs, { kind: 'number', value: 0 });
});

test('over-limit numbers are capped with a warning, not silently accepted', () => {
  const { compiler } = makeCompiler();
  const node = shadow(
    shadow(block(C.KEYBOARD.PRESS_TIMES, { BUTTON: 'key:A' }), 'COUNT', S.num(999999)),
    'GAP',
    S.num(0)
  );
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.strictEqual(res.ok, true);
  assert.match(res.warnings.join(' '), /capped from 999999 to 10000/);
});

test('relative mouse move clamps its duration and keeps the deltas', () => {
  const { compiler } = makeCompiler();
  const node = block(C.MOUSE.MOVE_BY, { DX: -40, DY: 15, MS: 5000000 });
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.deepStrictEqual(res.steps[0], { type: 'moveBy', dx: -40, dy: 15, ms: LIMITS.MAX_MOVE_MS });
});

test('an empty value socket warns and falls back to 0', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', block(C.CONTROL.WAIT, {})));
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.steps[0].ms, { kind: 'number', value: 0 });
  assert.match(res.warnings.join(' '), /socket on .* is empty/);
});

test('a nonsense block in a numeric socket is a clear error', () => {
  const { compiler } = makeCompiler();
  const node = into(block(C.CONTROL.WAIT, {}), 'MS', block(C.KEYBOARD.TYPE, { TEXT: 'oops' }));
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.strictEqual(res.ok, false);
  assert.match(res.errors[0], /which is not a value chip/);
});

test('run another macro compiles its selected name', () => {
  const { compiler, setMacroNames } = makeCompiler();
  setMacroNames(['Farm', 'Sell']);
  const node = block(C.CONTROL.RUN_MACRO, { MACRO: 'Farm' });
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0], { type: 'runMacro', name: 'Farm' });
  assert.deepStrictEqual(res.warnings, []);
});

test('run another macro warns when the named macro is gone', () => {
  const { compiler, setMacroNames } = makeCompiler();
  setMacroNames(['Farm']);
  const node = block(C.CONTROL.RUN_MACRO, { MACRO: 'Deleted' });
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.strictEqual(res.ok, true, 'still compiles - the engine reports it at run time');
  assert.match(res.warnings.join(' '), /not currently saved/);
});

test('run another macro with no selection is a hard error', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', block(C.CONTROL.RUN_MACRO, { MACRO: '' }))
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.errors[0], /no macro selected/);
});

test('an unknown block type is reported, not skipped', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', block('mb_from_the_future', {})));
  assert.strictEqual(res.ok, false);
  assert.match(res.errors[0], /Unknown block type "mb_from_the_future"/);
});

test('a start block nested inside another block is reported', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', block(C.START.HOLD, { BUTTON: 'mouse:1' }));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, false);
  assert.match(res.errors[0], /is a start block and can only sit at the top level/);
});

test('chooser pages merge the live statement input with the stashed pages', () => {
  const { compiler } = makeCompiler();
  const chooser = {
    type: C.CONTROL.ORGANIZED_CHOOSER,
    id: 'chooser-block-1',
    extraState: { pages: [null, { type: 'mb_key_type', fields: { TEXT: 'page2' } }, null], active: 0 },
  };
  // Page 0 is the LIVE page (two blocks); page 2 stays empty.
  into(chooser, 'DO', chain(block(C.KEYBOARD.TYPE, { TEXT: 'p1a' }), block(C.KEYBOARD.TYPE, { TEXT: 'p1b' })));

  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', chooser));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  const step = res.steps[0];
  assert.strictEqual(step.type, 'chooser');
  assert.strictEqual(step.mode, 'organized');
  assert.strictEqual(step.id, 'chooser-block-1');
  assert.strictEqual(step.pageCount, 3);
  assert.deepStrictEqual(
    step.pages.map((p) => p.map((s) => s.text || s.type)),
    [['p1a', 'p1b'], ['page2'], []]
  );
});

test('a chooser whose active page is at another index still compiles every page', () => {
  const { compiler } = makeCompiler();
  // This is the shape Blockly writes when page 1 is the active one.
  const chooser = {
    type: C.CONTROL.RANDOM_CHOOSER,
    id: 'rc1',
    extraState: { pages: [{ type: 'mb_key_type', fields: { TEXT: 'stashed0' } }, null], active: 1 },
  };
  into(chooser, 'DO', block(C.KEYBOARD.TYPE, { TEXT: 'live1' }));
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', chooser));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].mode, 'random');
  assert.deepStrictEqual(res.steps[0].pages.map((p) => p.map((s) => s.text)), [['stashed0'], ['live1']]);
});

test('an empty chooser warns that it does nothing', () => {
  const { compiler } = makeCompiler();
  const chooser = { type: C.CONTROL.RANDOM_CHOOSER, id: 'rc2', extraState: { pages: [null, null], active: 0 } };
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', chooser));
  assert.strictEqual(res.ok, true);
  assert.match(res.warnings.join(' '), /no blocks on any page/);
});

// --------------------------------------------------- workspace invariants

// The workspace-level invariants (armed start block selection, run-selected
// ancestor filtering) need REAL block definitions registered, so they live in
// test/blocks.test.js alongside the block definitions themselves.

test('run selected with nothing selected reports it', () => {
  const { compiler, Blockly } = makeCompiler();
  const res = compiler.compileSelection(new Blockly.Workspace(), { blocks: [] });
  assert.strictEqual(res.ok, false);
  assert.match(res.errors[0], /Nothing is selected/);
});

test('a compiled macro with a warning but no error is still runnable', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', block(C.CONTROL.WAIT, {}));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true);
  assert.ok(res.warnings.length > 0, 'should have warned about the empty socket');
  assert.match(res.summary, /step\(s\) compiled/);
});

// ============================================== numeric sockets vs conditions

test('a numeric socket takes chips, and only chips', () => {
  const { compiler } = makeCompiler();
  // Numeric sockets are `setCheck('Number')`, so a Boolean reporter cannot even
  // be connected by dragging. The compiler says the same thing in case a
  // hand-edited saved macro gets one in anyway.
  const wait = shadow(into(block(C.CONTROL.WAIT_MS, {}), 'MS', E.gt(E.num(1), E.num(0))), 'MS', S.num(100));
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', wait));
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /which is not a value chip/);
  assert.match(res.errors.join(' '), /A comparison belongs in an "if" condition instead/);
});

test('a between chip in a numeric socket still compiles as a random slot', () => {
  const { compiler } = makeCompiler();
  const wait = shadow(into(block(C.CONTROL.WAIT_MS, {}), 'MS', S.range(20, 60)), 'MS', S.num(100));
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', wait));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0].ms, { kind: constants.SLOT.RANGE, min: 20, max: 60 });
});

test('the seconds block scales a between chip into milliseconds', () => {
  const { compiler } = makeCompiler();
  const wait = shadow(into(block(C.CONTROL.WAIT, {}), 'MS', S.range(1, 2)), 'MS', S.num(1));
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', wait));
  assert.deepStrictEqual(res.steps[0].ms, { kind: constants.SLOT.RANGE, min: 1000, max: 2000 });
});

test('a comparison nested inside and/or still compiles - conditions are trees', () => {
  const { compiler } = makeCompiler();
  const cond = E.and(E.gt(E.range(2, 4), E.num(1)), E.lt(E.num(3), E.num(9)));
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'COND', cond))
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  const node = res.steps[0].cond;
  assert.strictEqual(node.e, OP.AND);
  assert.strictEqual(node.a.e, OP.GT);
  assert.strictEqual(node.a.a.e, OP.RAND, 'a between chip works as a comparison operand');
  assert.strictEqual(expressions.evalBoolean(node), true);
});

test('forever inside a comparison is an error, not a silent 0', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'COND', E.gt(E.forever(), E.num(1))))
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /only makes sense as a whole socket/);
});

test('forever nested deeper inside a comparison is also caught', () => {
  const { compiler } = makeCompiler();
  // and( gt(forever, 1), 1 ) - the forever is two levels down, so this only
  // fails if the check happens at every depth rather than just at the top.
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'COND', E.and(E.gt(E.forever(), E.num(1)), E.num(1))))
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /only makes sense as a whole socket/);
});
test('forever still works in the repeat count it was designed for', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.REPEAT, {}), 'COUNT', S.forever()))
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].count.kind, constants.SLOT.FOREVER);
});

test('a reporter stacked in a chain is told it belongs in a socket', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', chain(block(C.LOGIC.GREATER, {}), block(C.KEYBOARD.TYPE, { TEXT: 'x' })))
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /is a value block/);
});

test('forever still works in the repeat count it was designed for', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.REPEAT, {}), 'COUNT', S.forever()))
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].count.kind, constants.SLOT.FOREVER);
});

// ================================================================ if / else

test('if compiles both branches and the condition tree', () => {
  const { compiler } = makeCompiler();
  const ifBlock = into(
    into(into(block(C.CONTROL.IF, {}), 'COND', E.gt(E.num(5), E.num(2))),
    'THEN',
    block(C.KEYBOARD.TYPE, { TEXT: 'yes' })
    ),
    'ELSE',
    block(C.KEYBOARD.TYPE, { TEXT: 'no' })
  );
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', ifBlock));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps.length, 1);
  const step = res.steps[0];
  assert.strictEqual(step.type, constants.STEP.IF);
  assert.strictEqual(step.cond.e, OP.GT);
  assert.strictEqual(expressions.evalBoolean(step.cond), true);
  assert.strictEqual(step.then.length, 1);
  assert.strictEqual(step.then[0].text, 'yes');
  assert.strictEqual(step.else.length, 1);
  assert.strictEqual(step.else[0].text, 'no');
});

test('an if with no else branch compiles the else side to an empty list', () => {
  const { compiler } = makeCompiler();
  const ifBlock = into(
    into(block(C.CONTROL.IF, {}), 'COND', E.not(E.num(0))),
    'THEN',
    block(C.KEYBOARD.TYPE, { TEXT: 'x' })
  );
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', ifBlock));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0].else, []);
});

test('if nests inside repeat and inside itself', () => {
  const { compiler } = makeCompiler();
  const inner = into(
    into(into(block(C.CONTROL.IF, {}), 'COND', E.eq(E.num(1), E.num(1))),
      'THEN',
      block(C.KEYBOARD.TYPE, { TEXT: 'in' })),
    'ELSE',
    block(C.KEYBOARD.TYPE, { TEXT: 'out' })
  );
  const outer = into(into(block(C.CONTROL.IF, {}), 'COND', E.and(E.num(1), E.num(1))), 'THEN', inner);
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', shadow(into(block(C.CONTROL.REPEAT, {}), 'DO', outer), 'COUNT', S.num(2)))
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  const rep = res.steps[0];
  assert.strictEqual(rep.type, constants.STEP.REPEAT);
  assert.strictEqual(rep.body[0].type, constants.STEP.IF);
  assert.strictEqual(rep.body[0].then[0].type, constants.STEP.IF);
  assert.strictEqual(rep.body[0].then[0].then[0].text, 'in');
});

test('an if with an empty condition socket is a clear error', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'THEN', block(C.KEYBOARD.TYPE, { TEXT: 'x' })))
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /has no condition/);
});

test('if continues along the next chain after its branches', () => {
  const { compiler } = makeCompiler();
  const ifBlock = into(
    into(block(C.CONTROL.IF, {}), 'COND', E.num(1)),
    'THEN',
    block(C.KEYBOARD.TYPE, { TEXT: 'inside' })
  );
  const tail = block(C.KEYBOARD.TYPE, { TEXT: 'after' });
  ifBlock.next = { block: tail };
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', ifBlock));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps.length, 2);
  assert.strictEqual(res.steps[0].type, constants.STEP.IF);
  assert.strictEqual(res.steps[1].text, 'after');
});

test('a logic block compiles to a boolean-valued expression node', () => {
  const { compiler } = makeCompiler();
  const cond = E.or(E.gt(E.num(10), E.num(3)), E.eq(E.num(1), E.num(2)));
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'COND', cond))
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  const node = res.steps[0].cond;
  assert.strictEqual(node.e, OP.OR);
  assert.strictEqual(expressions.evalBoolean(node), true);
});

test('every reporter type is accepted by the if condition socket', () => {
  const { compiler } = makeCompiler();
  const builders = {
    [C.LOGIC.AND]: () => E.and(E.num(1), E.num(1)),
    [C.LOGIC.OR]: () => E.or(E.num(1), E.num(0)),
    [C.LOGIC.NOT]: () => E.not(E.num(0)),
    [C.LOGIC.EQUALS]: () => E.eq(E.num(1), E.num(1)),
    [C.LOGIC.GREATER]: () => E.gt(E.num(2), E.num(1)),
    [C.LOGIC.LESS]: () => E.lt(E.num(1), E.num(2)),
    [C.LOGIC.PIXEL_IS]: () => E.pixelIs(10, 20, '#ff0000'),
  };
  for (const type of Object.keys(builders)) {
    assert.ok(C.REPORTERS.includes(type), type + ' must be listed in catalog.REPORTERS');
    const res = compiler.compileState(
      into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'COND', builders[type]()))
    );
    assert.strictEqual(res.ok, true, type + ': ' + res.errors.join('; '));
  }
});

// ========================================================= pixel as a logic

test('a pixel check compiles to a leaf expression node, not a step', () => {
  const { compiler } = makeCompiler();
  // It is a reporter, so it produces NO step of its own - it only ever appears
  // inside an if condition. That is what lets `and` batch its screen read.
  const res = compiler.compileState(
    into(
      block(C.START.RUN, {}),
      'DO',
      into(
        into(block(C.CONTROL.IF, {}), 'COND', E.pixelIs(640, 380, '#ff0000', 12)),
        'THEN',
        block(C.KEYBOARD.TYPE, { TEXT: 'hit' })
      )
    )
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps.length, 1);
  assert.strictEqual(res.steps[0].type, constants.STEP.IF);
  assert.deepStrictEqual(res.steps[0].cond, {
    e: OP.PIXEL,
    x: 640,
    y: 380,
    colour: '#ff0000',
    tol: 12,
  });
});

test('two pixel checks inside one and survive as two nodes', () => {
  const { compiler } = makeCompiler();
  const cond = E.and(E.pixelIs(655, 402, '#ff0000'), E.pixelIs(700, 402, '#ff0000'));
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'COND', cond))
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  const node = res.steps[0].cond;
  assert.strictEqual(node.e, OP.AND);
  assert.strictEqual(node.a.x, 655);
  assert.strictEqual(node.b.x, 700);
});

test('a pixel check nests under not', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'COND', E.not(E.pixelIs(1, 2, '#ffffff'))))
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].cond.e, OP.NOT);
  assert.strictEqual(res.steps[0].cond.a.e, OP.PIXEL);
});

test('pixel coordinates are plain fields, so the block reads like the trigger', () => {
  const { compiler } = makeCompiler();
  // Deliberately NOT sockets. Mirroring the pixel trigger's fields means the two
  // blocks look the same and a socket there would imply arithmetic that has
  // nothing to act on.
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'COND', E.pixelIs(10, 20, '#00ff00')))
  );
  assert.strictEqual(res.steps[0].cond.tol, 0, 'tolerance defaults to exact');
  assert.strictEqual(res.steps[0].cond.x, 10);
  assert.strictEqual(res.steps[0].cond.y, 20);
});

test('an out-of-range pixel tolerance is clamped to 255', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'COND', E.pixelIs(1, 1, '#000000', 9999)))
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].cond.tol, 255);
});

test('a negative pixel tolerance is clamped to 0, not passed through', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.IF, {}), 'COND', E.pixelIs(1, 1, '#000000', -5)))
  );
  assert.strictEqual(res.steps[0].cond.tol, 0);
});


// ============================================== repeat until / break / continue

test('repeat until compiles the condition tree and the body', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(
      block(C.START.RUN, {}),
      'DO',
      L.repeatUntil(E.pixelIs(640, 380, '#00ff00'), block(C.KEYBOARD.TYPE, { TEXT: 'retry' }))
    )
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  const step = res.steps[0];
  assert.strictEqual(step.type, constants.STEP.REPEAT_UNTIL);
  assert.deepStrictEqual(step.cond, { e: OP.PIXEL, x: 640, y: 380, colour: '#00ff00', tol: 0 });
  assert.strictEqual(step.body.length, 1);
  assert.strictEqual(step.body[0].text, 'retry');
});

test('repeat until accepts any Logic block, not just a pixel check', () => {
  const { compiler } = makeCompiler();
  for (const cond of [E.gt(E.num(5), E.num(1)), E.and(E.num(1), E.not(E.num(0))), E.eq(E.range(1, 3), E.num(2))]) {
    const res = compiler.compileState(
      into(block(C.START.RUN, {}), 'DO', L.repeatUntil(cond, block(C.KEYBOARD.TYPE, { TEXT: 'x' })))
    );
    assert.strictEqual(res.ok, true, res.errors.join('; '));
    assert.strictEqual(res.steps[0].type, constants.STEP.REPEAT_UNTIL);
  }
});

test('repeat until with no condition is a clear error, not an instant success', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', into(block(C.CONTROL.REPEAT_UNTIL, {}), 'DO', block(C.KEYBOARD.TYPE, { TEXT: 'x' })))
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /repeat until" has no condition/);
});

test('break compiles to a marker step, not to nothing', () => {
  // NOT null. The engine only runs compiled step lists, so a break that compiled
  // away would mean the engine never learns a break was written.
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', L.repeat(S.num(3), block(C.CONTROL.BREAK, {})))
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0], {
    type: constants.STEP.REPEAT,
    count: { kind: 'number', value: 3 },
    body: [{ type: constants.STEP.BREAK }],
  });
});

test('continue compiles to a marker step', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', L.repeat(S.num(2), block(C.CONTROL.CONTINUE, {})))
  );
  assert.deepStrictEqual(res.steps[0].body, [{ type: constants.STEP.CONTINUE }]);
});

test('a break on the top level of a macro is an error, not a silent no-op', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', block(C.CONTROL.BREAK, {})));
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /has no loop to leave/);
});

test('a continue on the top level is an error too', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', block(C.CONTROL.CONTINUE, {})));
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /has no loop to continue/);
});

test('a break inside "at once" counts as being in a loop only when at once is', () => {
  // The loop-scope stack must follow `at once` as a statement body, and must
  // NOT treat a bare `at once` as a loop.
  const { compiler } = makeCompiler();
  const inLoop = into(
    block(C.START.RUN, {}),
    'DO',
    L.repeat(S.num(2), into(block(C.CONTROL.AT_ONCE, {}), 'DO', block(C.CONTROL.BREAK, {})))
  );
  assert.strictEqual(compiler.compileState(inLoop).ok, true, 'inside a loop: fine');

  const notInLoop = into(
    block(C.START.RUN, {}),
    'DO',
    into(block(C.CONTROL.AT_ONCE, {}), 'DO', block(C.CONTROL.BREAK, {}))
  );
  const res = compiler.compileState(notInLoop);
  assert.strictEqual(res.ok, false, 'a bare at once is not a loop');
  assert.match(res.errors.join(' '), /has no loop to leave/);
});

test('a break inside a chooser page inside a loop is legal', () => {
  // A chooser page runs inside the loop that contains the chooser, so the
  // compile-time scope must survive the page stash/serialisation.
  //
  // Page 0 is the LIVE page (it is the block in the DO input) and carries the
  // typeText; page 1 is the break, stashed in extraState.
  const { compiler } = makeCompiler();
  const chooser = {
    type: C.CONTROL.RANDOM_CHOOSER,
    id: 'c1',
    extraState: { pages: [null, { type: C.CONTROL.BREAK, id: 'b1' }], active: 0 },
  };
  const res = compiler.compileState(
    into(
      block(C.START.RUN, {}),
      'DO',
      L.repeat(S.num(2), into(chooser, 'DO', block(C.KEYBOARD.TYPE, { TEXT: 'a' })))
    )
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  const pages = res.steps[0].body[0].pages;
  assert.deepStrictEqual(pages[0], [{ type: constants.STEP.TYPE_TEXT, text: 'a' }]);
  assert.deepStrictEqual(pages[1], [{ type: constants.STEP.BREAK }]);
});

test('a break inside an if branch inside a loop is legal', () => {
  const { compiler } = makeCompiler();
  const branch = into(into(block(C.CONTROL.IF, {}), 'COND', E.num(1)), 'THEN', block(C.CONTROL.BREAK, {}));
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', L.repeat(S.num(2), branch)));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
});

test('the loop-scope stack unwinds, so a break after a loop is still an error', () => {
  // Guards the try/finally in withLoopScope: a stack that only grows would make
  // every later break look legal.
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(
      block(C.START.RUN, {}),
      'DO',
      chain(L.repeat(S.num(2), block(C.KEYBOARD.TYPE, { TEXT: 'inner' })), block(C.CONTROL.BREAK, {}))
    )
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /has no loop to leave/);
});

test('nested loops compile each body with its own scope', () => {
  const { compiler } = makeCompiler();
  // repeat until { repeat { repeat { break } } }
  const inner = L.repeat(S.num(2), block(C.CONTROL.BREAK, {}));
  const mid = L.repeat(S.num(3), inner);
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', L.repeatUntil(E.num(1), mid)));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  const outerStep = res.steps[0];
  assert.strictEqual(outerStep.type, constants.STEP.REPEAT_UNTIL);
  const midStep = outerStep.body[0];
  assert.strictEqual(midStep.type, constants.STEP.REPEAT);
  const innerStep = midStep.body[0];
  assert.strictEqual(innerStep.type, constants.STEP.REPEAT);
  assert.deepStrictEqual(innerStep.body, [{ type: constants.STEP.BREAK }]);
});


// ==================================================== wait until window

test('wait until window compiles the title, timeout and poll interval', () => {
  const { compiler } = makeCompiler();
  const node = shadow(
    block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: 'Notepad', POLL: 300 }),
    'TIMEOUT',
    S.num(15000)
  );
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0], {
    type: constants.STEP.WAIT_FOR_WINDOW,
    title: 'Notepad',
    timeoutMs: { kind: 'number', value: 15000 },
    pollMs: 300,
  });
});

test('an empty title is an error, not a match-everything wait', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: '   ' }), 'TIMEOUT', S.num(1000)))
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /no title to look for/);
});

test('a title is trimmed, so a stray space does not break the match', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(
      block(C.START.RUN, {}),
      'DO',
      shadow(block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: '  Notepad  ' }), 'TIMEOUT', S.num(1000))
    )
  );
  assert.strictEqual(res.steps[0].title, 'Notepad');
});

test('forever is refused as a timeout', () => {
  // "Wait forever for the app" is the wrong reading of this block when the app
  // was never going to open. A hang is worse than a failure.
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(
      block(C.START.RUN, {}),
      'DO',
      shadow(block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: 'Notepad' }), 'TIMEOUT', S.forever())
    )
  );
  assert.strictEqual(res.ok, false);
  assert.match(res.errors.join(' '), /cannot use "forever" as its timeout/);
});

test('a between chip is a valid timeout', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(
      block(C.START.RUN, {}),
      'DO',
      shadow(block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: 'App' }), 'TIMEOUT', S.range(500, 2000))
    )
  );
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0].timeoutMs, { kind: 'range', min: 500, max: 2000 });
});

test('an out-of-range poll interval is clamped to the floor', () => {
  const { compiler } = makeCompiler();
  const res = compiler.compileState(
    into(block(C.START.RUN, {}), 'DO', shadow(block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: 'A', POLL: 0 }), 'TIMEOUT', S.num(1000)))
  );
  assert.strictEqual(res.steps[0].pollMs, constants.LIMITS.WINDOW_POLL.MIN_MS);
});

// ---------------------------------------------------------- timed start blocks

test('an `every` start block compiles to an interval schedule', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.EVERY, { EVERY: '30' }), 'DO', chain(block(C.KEYBOARD.TYPE, { TEXT: 'tick' })));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.kind, constants.START.EVERY);
  assert.strictEqual(res.start.seconds, 30);
  assert.deepStrictEqual(res.steps.map((s) => s.type), ['typeText']);
  assert.strictEqual(compiler.runButtonLabel(res.start), 'Arm', 'a timer is armed, not run');
  assert.match(compiler.describeStart(res.start), /every 30s/);
});

test('an interval below the floor is clamped rather than honoured', () => {
  const { compiler } = makeCompiler();
  // 0 would mean a timer that spins the event loop forever; clamping keeps a typo
  // from wedging the app.
  const start = into(block(C.START.EVERY, { EVERY: '0' }), 'DO', chain());
  const res = compiler.compileState(start);
  assert.strictEqual(res.start.seconds, constants.SCHEDULE.MIN_INTERVAL_SECONDS);
});

test('an absurd interval is clamped to the maximum', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.EVERY, { EVERY: '999999' }), 'DO', chain());
  const res = compiler.compileState(start);
  assert.strictEqual(res.start.seconds, constants.SCHEDULE.MAX_INTERVAL_SECONDS);
});

test('a non-numeric interval falls back to the default instead of becoming NaN', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.EVERY, { EVERY: 'abc' }), 'DO', chain());
  const res = compiler.compileState(start);
  assert.strictEqual(res.start.seconds, constants.SCHEDULE.DEFAULT_INTERVAL_SECONDS);
});

test('an `at` start block compiles to a clock schedule', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.AT, { HOUR: '7', MINUTE: '5' }), 'DO', chain(block(C.KEYBOARD.TYPE, { TEXT: 'daily' })));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.start.kind, constants.START.AT);
  assert.strictEqual(res.start.hour, 7);
  assert.strictEqual(res.start.minute, 5);
  assert.strictEqual(compiler.describeStart(res.start), 'at 07:05', 'must be zero-padded 24-hour');
});

test('an out-of-range clock time is clamped, not wrapped', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.AT, { HOUR: '99', MINUTE: '77' }), 'DO', chain());
  const res = compiler.compileState(start);
  assert.strictEqual(res.start.hour, constants.SCHEDULE.MAX_CLOCK_HOUR);
  assert.strictEqual(res.start.minute, constants.SCHEDULE.MAX_CLOCK_MINUTE);
});

test('a fractional clock time is rounded to whole minutes', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.AT, { HOUR: '8.6', MINUTE: '4.2' }), 'DO', chain());
  const res = compiler.compileState(start);
  assert.strictEqual(res.start.hour, 9);
  assert.strictEqual(res.start.minute, 4);
});

test('midnight and one-past-midnight are both expressible', () => {
  const { compiler } = makeCompiler();
  const zero = compiler.compileState(into(block(C.START.AT, { HOUR: '0', MINUTE: '0' }), 'DO', chain()));
  assert.strictEqual(compiler.describeStart(zero.start), 'at 00:00');
  const end = compiler.compileState(into(block(C.START.AT, { HOUR: '23', MINUTE: '59' }), 'DO', chain()));
  assert.strictEqual(compiler.describeStart(end.start), 'at 23:59');
});

// ------------------------------------------------- durations and unit migration

test('`move mouse to x y` carries a `within` duration', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', chain(block(C.MOUSE.MOVE_TO, { X: '100', Y: '200', MS: '450' })));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.strictEqual(res.steps[0].x, 100);
  assert.strictEqual(res.steps[0].y, 200);
  assert.strictEqual(res.steps[0].ms, 450);
});

test('a saved `move mouse to` with no duration keeps teleporting (ms 0)', () => {
  const { compiler } = makeCompiler();
  // Macros saved before this field existed have no MS at all. Defaulting to a
  // glide would silently slow down every macro the user already had.
  const start = into(block(C.START.RUN, {}), 'DO', chain(block(C.MOUSE.MOVE_TO, { X: '10', Y: '20' })));
  const res = compiler.compileState(start);
  assert.strictEqual(res.steps[0].ms, 0, 'must stay a teleport, not become a 200ms glide');
});

test('a move duration beyond the cap is clamped', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', chain(block(C.MOUSE.MOVE_TO, { X: '1', Y: '2', MS: '99999999' })));
  const res = compiler.compileState(start);
  assert.strictEqual(res.steps[0].ms, LIMITS.MAX_MOVE_MS);
});

test('`wait until window` reads its timeout in SECONDS from the new field', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', chain(block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: 'App', TIMEOUT_S: '45', POLL: '300' })));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0].timeoutMs, { kind: 'number', value: 45000 });
});

test('a window timeout below one second is raised to one, not zero', () => {
  const { compiler } = makeCompiler();
  // 0 would mean "give up immediately", which reads as "never wait at all" - a
  // silent bug rather than an obvious one.
  const start = into(block(C.START.RUN, {}), 'DO', chain(block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: 'App', TIMEOUT_S: '0' })));
  const res = compiler.compileState(start);
  assert.deepStrictEqual(res.steps[0].timeoutMs, { kind: 'number', value: 1000 });
});

test('an OLD window wait, stored in milliseconds, keeps its exact value', () => {
  const { compiler } = makeCompiler();
  // Migration matters: if 15000ms were re-read as 15000 SECONDS this macro would
  // hang for over four hours instead of fifteen seconds.
  const node = shadow(block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: 'App', POLL: '300' }), 'TIMEOUT', S.num(15000));
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.deepStrictEqual(res.steps[0].timeoutMs, { kind: 'number', value: 15000 });
});

test('an old window wait with an odd millisecond value is not rounded to a second', () => {
  const { compiler } = makeCompiler();
  const node = shadow(block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: 'App' }), 'TIMEOUT', S.num(8500));
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.deepStrictEqual(res.steps[0].timeoutMs, { kind: 'number', value: 8500 });
});

test('the seconds field wins over a stale socket left in an old macro', () => {
  const { compiler } = makeCompiler();
  // Hand-edited or partially-migrated files can carry both. The visible field is
  // what the user is looking at, so it is the one that wins.
  const node = into(block(C.CONTROL.WAIT_FOR_WINDOW, { TITLE: 'App', TIMEOUT_S: '3' }), 'TIMEOUT', S.num(99000));
  const res = compiler.compileState(into(block(C.START.RUN, {}), 'DO', node));
  assert.deepStrictEqual(res.steps[0].timeoutMs, { kind: 'number', value: 3000 });
});

// --------------------------------------------------------------- scroll wheel

test('`scroll` compiles direction, pixels and duration', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', chain(block(C.MOUSE.SCROLL, { PX: '360', DIR: 'up', MS: '200' })));
  const res = compiler.compileState(start);
  assert.strictEqual(res.ok, true, res.errors.join('; '));
  assert.deepStrictEqual(res.steps[0], {
    type: constants.STEP.SCROLL,
    direction: constants.SCROLL.UP,
    px: 360,
    ms: 200,
  });
});

test('scroll defaults to DOWN when the dropdown says something unexpected', () => {
  const { compiler } = makeCompiler();
  const start = into(block(C.START.RUN, {}), 'DO', chain(block(C.MOUSE.SCROLL, { PX: '120', DIR: 'sideways' })));
  const res = compiler.compileState(start);
  assert.strictEqual(res.steps[0].direction, constants.SCROLL.DOWN);
});

test('scroll pixels and duration are clamped, and 0 ms is allowed', () => {
  const { compiler } = makeCompiler();
  const big = compiler.compileState(into(block(C.START.RUN, {}), 'DO', chain(block(C.MOUSE.SCROLL, { PX: '999999', MS: '999999' }))));
  assert.strictEqual(big.steps[0].px, constants.SCROLL.MAX_PX);
  assert.strictEqual(big.steps[0].ms, constants.SCROLL.MAX_MS);

  const instant = compiler.compileState(into(block(C.START.RUN, {}), 'DO', chain(block(C.MOUSE.SCROLL, { PX: '120', MS: '0' }))));
  assert.strictEqual(instant.steps[0].ms, 0, 'a 0ms scroll is a single burst, which is legal');
});
