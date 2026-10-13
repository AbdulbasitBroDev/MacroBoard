'use strict';

/**
 * Shared pixel colour-matching tests.
 *
 * src/shared/pixels.js is the ONE colour comparison used by both the pixel
 * trigger and the `if pixel is` condition. Two copies of that rule is how you
 * get the maddening bug where a macro's trigger fires on a colour its own inline
 * `if` insists does not match - same pixel, same tolerance, different answer.
 * So the rule is pinned here, and pixelService's own suite checks that it
 * actually delegates rather than keeping a private copy.
 */

const test = require('node:test');
const assert = require('node:assert');
const px = require('../src/shared/pixels');

const RED = { r: 255, g: 0, b: 0 };
const WHITE = { r: 255, g: 255, b: 255 };

// ------------------------------------------------------------- hex parsing

test('hexToRgb parses both #rrggbb and rrggbb', () => {
  assert.deepStrictEqual(px.hexToRgb('#ff0000'), RED);
  assert.deepStrictEqual(px.hexToRgb('ff0000'), RED);
  assert.deepStrictEqual(px.hexToRgb('#FFFFFF'), WHITE, 'case insensitive');
});

test('hexToRgb refuses anything that is not a full 6-digit colour', () => {
  // A 3-digit shorthand is what a hand-edited saved macro is most likely to
  // contain, and it must be null (does-not-match) rather than half-parsed.
  for (const bad of ['#f00', 'red', '#ff00', '#ff00000', '', null, undefined, 123]) {
    assert.strictEqual(px.hexToRgb(bad), null, JSON.stringify(bad) + ' should not parse');
  }
});

test('toHex round-trips through hexToRgb', () => {
  assert.strictEqual(px.toHex(RED), '#ff0000');
  assert.deepStrictEqual(px.hexToRgb(px.toHex({ r: 18, g: 52, b: 86 })), { r: 18, g: 52, b: 86 });
});

test('toHex clamps out-of-range channels rather than emitting junk', () => {
  assert.strictEqual(px.toHex({ r: -5, g: 300, b: 12.6 }), '#00ff0d');
  assert.strictEqual(px.toHex(null), '#000000');
});

// ------------------------------------------------------------- comparison

test('tolerance 0 means exact match only', () => {
  assert.strictEqual(px.matches(RED, RED, 0), true);
  assert.strictEqual(px.matches({ r: 254, g: 0, b: 0 }, RED, 0), false, 'off by one is off');
});

test('tolerance is PER CHANNEL, not a distance in RGB space', () => {
  // Off by 15 on red only. This is the rule the pixel trigger has always used:
  // a per-channel bound is what "within N of this grey" means to someone
  // reading a colour picker. A euclidean distance would be neither predictable
  // nor explainable in a tooltip.
  assert.strictEqual(px.matches({ r: 240, g: 0, b: 0 }, RED, 15), true);
  assert.strictEqual(px.matches({ r: 240, g: 0, b: 0 }, RED, 14), false);
});

test('all three channels must be within tolerance', () => {
  assert.strictEqual(px.matches({ r: 240, g: 15, b: 15 }, RED, 15), true);
  assert.strictEqual(px.matches({ r: 240, g: 16, b: 0 }, RED, 15), false);
});

test('a hex string target works as well as channel values', () => {
  assert.strictEqual(px.matches(RED, '#ff0000', 0), true);
  assert.strictEqual(px.matches(RED, 'nonsense', 0), false);
});

test('a missing pixel or an unparseable target is does-not-match, not a throw', () => {
  // "Condition not met" is always a better outcome than killing a macro.
  assert.strictEqual(px.matches(null, RED, 0), false);
  assert.strictEqual(px.matches(RED, null, 0), false);
  assert.strictEqual(px.matches(RED, 'not-a-colour', 0), false);
  assert.doesNotThrow(() => px.matches(undefined, undefined, undefined));
});

test('tolerance is clamped to 0-255 rather than trusted', () => {
  assert.strictEqual(px.clampTolerance(-10), 0);
  assert.strictEqual(px.clampTolerance(9999), 255);
  assert.strictEqual(px.clampTolerance(12.9), 12, 'floored, so the log shows the real value');
  assert.strictEqual(px.clampTolerance('nonsense'), 0);
  assert.strictEqual(px.matches(WHITE, '#000000', 9999), true, '255 covers any channel difference');
});

test('maxChannelDelta explains WHY a colour did not match', () => {
  // "It did not match" is the hardest kind of macro bug to debug; being able to
  // say "off by 60 on blue" is the difference between a one-minute fix and an
  // afternoon of guessing at tolerance values.
  assert.strictEqual(px.maxChannelDelta({ r: 255, g: 0, b: 0 }, '#f000ff'), 255);
  assert.strictEqual(px.maxChannelDelta({ r: 240, g: 0, b: 0 }, '#ff0000'), 15);
  assert.strictEqual(px.maxChannelDelta({ r: 1, g: 2, b: 3 }, '#ff0000'), 254);
  assert.strictEqual(px.maxChannelDelta(RED, 'nonsense'), null);
});

// ------------------------------------------- the trigger delegates here

test('pixelService uses this exact rule, not a private copy', () => {
  const { createPixelService } = require('../src/main/services/pixelService');
  // Built with no electron, so `available` is false - but `matches` is a pure
  // function and is still wired up, which is the point being asserted.
  const svc = createPixelService({});
  assert.strictEqual(svc.available, false);
  for (const [actual, target, tol, want] of [
    [RED, RED, 0, true],
    [{ r: 254, g: 0, b: 0 }, RED, 0, false],
    [{ r: 240, g: 0, b: 0 }, RED, 15, true],
    [RED, '#ff0000', 0, true],
    [RED, 'nonsense', 0, false],
    [null, RED, 0, false],
  ]) {
    assert.strictEqual(
      svc.matches(actual, target, tol),
      want,
      'trigger and inline if must agree on ' + JSON.stringify({ actual, target, tol })
    );
  }
  // And the helpers the trigger itself uses come from the same module.
  assert.deepStrictEqual(svc.hexToRgb('#00ff00'), { r: 0, g: 255, b: 0 });
  assert.strictEqual(svc.toHex(RED), '#ff0000');
});
