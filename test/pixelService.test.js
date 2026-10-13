'use strict';

/**
 * PixelService tests.
 *
 * Electron's desktopCapturer is faked with a 2x2 BGRA bitmap, so the polling
 * path can be exercised for real (timer, capture, colour compare, edge
 * detection) without a screen.
 *
 * This file exists mainly as a REGRESSION test: `watch()` used to call a bare
 * `readPixel(...)`, which was only ever a property of the returned object and
 * never in scope. The poller therefore threw `readPixel is not defined` on its
 * very first tick, disarmed the macro, and the pixel trigger never worked.
 */

const test = require('node:test');
const assert = require('node:assert');
const { createPixelService } = require('../src/main/services/pixelService');

/** A fake nativeImage whose bitmap is BGRA. */
function makeImage(bitmap, width, height) {
  return {
    getSize: () => ({ width, height }),
    getBitmap: () => bitmap,
  };
}

/** 2x2 image: (0,0) black, (1,0) white, (0,1) red, (1,1) green. */
function fakeElectron() {
  const bitmap = Buffer.alloc(2 * 2 * 4);
  const put = (x, y, r, g, b) => {
    const o = (y * 2 + x) * 4;
    bitmap[o] = b; bitmap[o + 1] = g; bitmap[o + 2] = r; bitmap[o + 3] = 255;
  };
  put(0, 0, 0, 0, 0);       // #000000
  put(1, 0, 255, 255, 255); // #ffffff
  put(0, 1, 255, 0, 0);     // #ff0000
  put(1, 1, 0, 255, 0);     // #00ff00

  const display = { id: 1, bounds: { x: 0, y: 0, width: 2, height: 2 }, scaleFactor: 1 };
  return {
    desktopCapturer: {
      async getSources() {
        return [{ id: 'screen:1', display_id: '1', thumbnail: makeImage(bitmap, 2, 2) }];
      },
    },
    nativeImage: {},
    screen: {
      getAllDisplays: () => [display],
      getPrimaryDisplay: () => display,
    },
  };
}

function makeService() {
  return createPixelService({ electron: fakeElectron(), log: () => {} });
}

test('readPixel returns the colour under the point', async () => {
  const pixel = makeService();
  assert.strictEqual(pixel.available, true);
  assert.strictEqual((await pixel.readPixel(0, 0)).colour, '#000000');
  assert.strictEqual((await pixel.readPixel(1, 0)).colour, '#ffffff');
  assert.strictEqual((await pixel.readPixel(0, 1)).colour, '#ff0000');
});

test('a point outside the capture is reported as outside, not as black', async () => {
  const pixel = makeService();
  const res = await pixel.readPixel(500, 500);
  assert.strictEqual(res.outside, true);
});

test('hexToRgb, toHex and matches round-trip', () => {
  const pixel = makeService();
  assert.deepStrictEqual(pixel.hexToRgb('#ff0000'), { r: 255, g: 0, b: 0 });
  assert.strictEqual(pixel.toHex({ r: 255, g: 0, b: 0 }), '#ff0000');
  assert.strictEqual(pixel.hexToRgb('nonsense'), null);
  assert.strictEqual(pixel.matches({ r: 255, g: 0, b: 0 }, { r: 255, g: 0, b: 0 }, 0), true);
  assert.strictEqual(pixel.matches({ r: 250, g: 0, b: 0 }, { r: 255, g: 0, b: 0 }, 0), false);
  assert.strictEqual(pixel.matches({ r: 250, g: 0, b: 0 }, { r: 255, g: 0, b: 0 }, 8), true);
});

test('REGRESSION: watch() polls without a "readPixel is not defined" error', async () => {
  const pixel = makeService();
  const errors = [];
  const matches = [];
  const w = pixel.watch({
    x: 1, y: 0, colour: '#ffffff', tolerance: 0, pollMs: 50,
    onMatch: (info) => { matches.push(info.colour); },
    onError: (err) => { errors.push(err); },
  });

  // The first tick runs immediately and must not throw.
  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepStrictEqual(errors.map((e) => e.message), [], 'the poller must not error');
  assert.deepStrictEqual(matches, ['#ffffff'], 'a matching pixel should have fired onMatch');
});

test('watch() reports an unavailable pixel source instead of throwing', () => {
  const pixel = createPixelService({ electron: null, log: () => {} });
  assert.strictEqual(pixel.available, false);
  const errors = [];
  const w = pixel.watch({
    x: 0, y: 0, colour: '#ffffff', pollMs: 50,
    onMatch: () => {},
    onError: (e) => errors.push(e.message),
  });
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /unavailable/i);
  w.stop();
});

test('watch() reports an invalid colour instead of throwing', () => {
  const pixel = makeService();
  const errors = [];
  const w = pixel.watch({
    x: 0, y: 0, colour: 'not-a-colour', pollMs: 50,
    onMatch: () => {},
    onError: (e) => errors.push(e.message),
  });
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /invalid colour/i);
  w.stop();
});

test('a non-matching pixel never fires onMatch', async () => {
  const pixel = makeService();
  const errors = [];
  const matches = [];
  const w = pixel.watch({
    x: 0, y: 0, colour: '#ffffff', tolerance: 0, pollMs: 50,
    onMatch: (i) => matches.push(i.colour),
    onError: (e) => errors.push(e),
  });
  await new Promise((r) => setTimeout(r, 40));
  w.stop();
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(matches, [], 'black must not match white');
});

test('stop() halts the poller', async () => {
  const pixel = makeService();
  let ticks = 0;
  const w = pixel.watch({
    x: 1, y: 0, colour: '#ffffff', tolerance: 0, pollMs: 20,
    onMatch: () => { ticks++; },
    onError: () => {},
  });
  await new Promise((r) => setTimeout(r, 30));
  w.stop();
  const seen = ticks;
  assert.strictEqual(w.isPolling(), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(ticks, seen, 'no further matches should fire after stop()');
});
