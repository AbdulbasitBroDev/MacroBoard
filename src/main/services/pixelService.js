'use strict';

/**
 * PixelService - read the colour of a screen pixel.
 *
 * PERFORMANCE IS THE WHOLE STORY HERE.
 *
 * Reading a pixel means grabbing the screen into a buffer first. Measured on the
 * development machine, nut-js's `screen.grabRegion` takes ~250ms per call, which
 * makes it useless for polling. Electron's desktopCapturer does one full-desktop
 * grab into a nativeImage, after which the actual pixel read is a buffer index -
 * fast enough to poll.
 *
 * So: desktopCapturer is the primary path; nut-js is a documented slow fallback
 * for one-shot reads (the eyedropper). The poll-interval floor is enforced here
 * as well as in the UI.
 *
 * COORDINATE SPACES: macros use nut-js's coordinate space (physical pixels)
 * because that is what performs clicks. Captured images have their own scaling,
 * so `mapToImage` converts between them, and `diagnostics()` exposes the numbers
 * so the in-app "test this pixel" control can PROVE the mapping on the user's
 * machine instead of assuming it.
 */

const C = require('../../shared/constants');
const px = require('../../shared/pixels');

function createPixelService(deps) {
  deps = deps || {};
  const log = deps.log || (() => {});
  const electron = deps.electron || null;
  const input = deps.input || null;

  const available = Boolean(electron && electron.desktopCapturer && electron.nativeImage && electron.screen);
  const reason = available
    ? ''
    : 'Screen pixel reading is unavailable here. The pixel-colour trigger and the eyedropper are off.';

  /**
   * Test seam: a replacement for the whole capture path.
   *
   * `deps.capture(x, y)` -> {x, y, outside, colour, rgb}. When supplied, pixel
   * reading counts as available even without Electron, so the REAL polling,
   * edge-detection and stats code is exercisable in the test suite instead of
   * being replaced by a fake that could drift from it. The trigger's bug was a
   * race between two pollers, and a fake would not have reproduced a race.
   */
  const capture = deps.capture || null;
  const canRead = available || typeof capture === 'function';

  /** Cache the last capture so a burst of reads only grabs once. */
  let cache = null;

  function virtualBounds() {
    const displays = electron.screen.getAllDisplays();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    displays.forEach((d) => {
      const phys = {
        x: Math.round(d.bounds.x * d.scaleFactor),
        y: Math.round(d.bounds.y * d.scaleFactor),
        width: Math.round(d.bounds.width * d.scaleFactor),
        height: Math.round(d.bounds.height * d.scaleFactor),
      };
      minX = Math.min(minX, phys.x);
      minY = Math.min(minY, phys.y);
      maxX = Math.max(maxX, phys.x + phys.width);
      maxY = Math.max(maxY, phys.y + phys.height);
    });
    if (!isFinite(minX)) return { x: 0, y: 0, width: 1920, height: 1080 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * Grab the whole virtual desktop at 1:1 physical resolution.
   * Reuses a capture younger than `maxAgeMs` so polling one pixel does not pay
   * the full capture cost more than once per interval.
   */
  async function grab(maxAgeMs) {
    if (!canRead) throw new Error(reason);
    const now = Date.now();
    if (cache && now - cache.at <= (maxAgeMs || 0) && cache.width > 1) return cache;

    const bounds = virtualBounds();
    let sources = [];
    try {
      sources = await electron.desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: bounds.width, height: bounds.height },
      });
    } catch (err) {
      throw new Error('Screen capture failed: ' + err.message);
    }
    if (!sources || !sources.length) throw new Error('Screen capture returned no screens.');

    const primary = electron.screen.getPrimaryDisplay();
    const source = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
    const image = source.thumbnail;
    const size = image.getSize();
    if (!size || !size.width || size.width <= 1) {
      throw new Error(
        'Screen capture returned an empty image. Pixel reading cannot work while the display is ' +
          'asleep or showing a secure desktop (UAC prompt / lock screen).'
      );
    }
    const bitmap = image.getBitmap(); // BGRA
    if (!bitmap || bitmap.length < size.width * size.height * 4) {
      throw new Error('Screen capture returned an incomplete image.');
    }
    cache = { at: now, width: size.width, height: size.height, bitmap, bounds, sourceId: source.id };
    return cache;
  }

  /** Map a nut-space (physical) point into the cached capture. */
  function mapToImage(x, y, cap) {
    const bounds = cap.bounds || virtualBounds();
    const sx = cap.width / Math.max(1, bounds.width);
    const sy = cap.height / Math.max(1, bounds.height);
    const px = Math.round((x - bounds.x) * sx);
    const py = Math.round((y - bounds.y) * sy);
    return { px, py, sx, sy, inside: px >= 0 && py >= 0 && px < cap.width && py < cap.height };
  }

  function pixelAt(cap, px, py) {
    const offset = (py * cap.width + px) * 4;
    return {
      r: cap.bitmap[offset + 2],
      g: cap.bitmap[offset + 1],
      b: cap.bitmap[offset],
      a: cap.bitmap[offset + 3],
    };
  }

  const toHex = (c) => px.toHex(c);

  const hexToRgb = (hex) => px.hexToRgb(hex);

  /**
   * Colour comparison comes from src/shared/pixels.js so this trigger and the
   * `if pixel is <colour>` step can never disagree about whether a colour
   * matches. Two copies of this rule is how you get a trigger that fires on a
   * colour an inline `if` insists is wrong.
   */
  function matches(a, target, tolerance) {
    return px.matches(a, target, tolerance);
  }

  /**
   * Read one pixel (nut-space coordinates).
   *
   * Defined as a named function rather than inline in the returned object so the
   * poller below can call it directly - an inline method is not in scope here.
   */
  async function readPixel(x, y, opts) {
    if (capture) return capture(x, y);
    const cap = await grab((opts && opts.maxAgeMs) || 0);
    const m = mapToImage(x, y, cap);
    if (!m.inside) {
      return { x, y, outside: true, colour: '#000000', rgb: { r: 0, g: 0, b: 0 } };
    }
    const rgb = pixelAt(cap, m.px, m.py);
    return { x, y, outside: false, colour: toHex(rgb), rgb, imagePoint: { x: m.px, y: m.py } };
  }

  /**
   * Read SEVERAL pixels from a SINGLE screen capture.
   *
   * This exists for the `if pixel is` block, whose condition is often
   * `(pixel A is red) and (pixel B is red)`. One capture costs a full-desktop
   * grab (~40-90ms measured), so reading the two pixels independently doubles
   * that for no benefit - they are being asked about at the same instant, so
   * they should be answered from the same frame. Answering them from different
   * frames would be worse than slow: the two answers would be describing two
   * different moments, which is exactly the race the user is trying to avoid.
   *
   * @param {Array<{x:number,y:number}>} points nut-space coordinates
   * @return {Promise<Array<{x,y,outside,colour,rgb}>>} same order as `points`
   */
  async function readPixels(points, opts) {
    if (!canRead) throw new Error(reason);
    const list = Array.isArray(points) ? points : [points];
    if (list.length === 0) return [];
    // One capture for the whole batch, deliberately fresh: these reads are a
    // decision point, so a stale frame would answer about the past.
    const cap = await grab((opts && opts.maxAgeMs) || 0);
    return list.map((p) => {
      const x = Number(p.x) || 0;
      const y = Number(p.y) || 0;
      const m = mapToImage(x, y, cap);
      if (!m.inside) return { x, y, outside: true, colour: '#000000', rgb: { r: 0, g: 0, b: 0 } };
      const rgb = pixelAt(cap, m.px, m.py);
      return { x, y, outside: false, colour: toHex(rgb), rgb, imagePoint: { x: m.px, y: m.py } };
    });
  }

  return {
    // `canRead`, not the raw Electron check: a test capture seam makes pixel
    // reading genuinely work, so reporting "unavailable" would be a lie.
    available: canRead,
    reason: canRead ? '' : reason,
    mapToImage,
    pixelAt,
    toHex,
    hexToRgb,
    matches,

    /** Read one pixel (nut-space coordinates). */
    readPixel,

    /** Read several pixels from one capture. See readPixels. */
    readPixels,

    /**
     * Read one pixel using the nut-js fallback. ~250ms per call, so this exists
     * only for one-shot reads (the eyedropper), never for polling.
     */
    async readPixelSlow(x, y) {
      if (!input || !input.available) throw new Error(reason || 'No pixel source is available.');
      const rgb = await input.slowPixelRead(x, y);
      return { x, y, outside: false, colour: toHex(rgb), rgb, slow: true };
    },

    /**
     * Poll a pixel until it matches, then fire onMatch and carry on watching.
     *
     * @param {object} opts { x, y, colour, tolerance, pollMs, onSample, onMatch, onError }
     * @return {{stop: Function, isPolling: Function, pollMs: number, stats: Function}}
     */
    watch(opts) {
      const target = hexToRgb(opts.colour);
      const pollMs = Math.max(
        C.PIXEL.MIN_POLL_MS,
        Math.min(C.PIXEL.MAX_POLL_MS, Number(opts.pollMs) || C.PIXEL.DEFAULT_POLL_MS)
      );
      let stopped = false;
      let inFlight = false;
      let timer = null;
      const stats = { ticks: 0, captures: 0, lastCaptureMs: 0, lastIntervalMs: 0, totalMs: 0 };
      let lastTickAt = 0;

      if (!target) {
        opts.onError(new Error('The pixel trigger has an invalid colour "' + opts.colour + '".'));
        return { stop() {}, isPolling: () => false, pollMs, stats: () => stats };
      }
      if (!canRead) {
        opts.onError(new Error(reason));
        return { stop() {}, isPolling: () => false, pollMs, stats: () => stats };
      }
      if (Number(opts.pollMs) && Number(opts.pollMs) < C.PIXEL.MIN_POLL_MS) {
        log(
          'warn',
          'pixel poll interval raised from ' + opts.pollMs + 'ms to the ' + C.PIXEL.MIN_POLL_MS +
            'ms floor (a single screen capture already costs more than that)'
        );
      }

      function schedule() {
        if (stopped) return;
        timer = setTimeout(tick, pollMs);
        if (typeof timer.unref === 'function') timer.unref();
      }

      /**
       * ONE capture per tick, and the caller is told the answer every time -
       * match or not.
       *
       * `onSample` existing is the whole reason this poller is the only one.
       * Edge detection needs to see NON-matches too ("the pixel left the colour,
       * so the next match is a new edge"), and the caller used to get that by
       * running a SECOND poller over the same pixel. Two pollers racing to decide
       * whether the level changed is how a trigger ends up never firing: the
       * level-tracker reads "matching", then the watcher's own match arrives and
       * is suppressed as a duplicate. One read, one decision.
       */
      async function tick() {
        timer = null;
        if (stopped || inFlight) return;
        inFlight = true;
        const startedAt = Date.now();
        if (lastTickAt) stats.lastIntervalMs = startedAt - lastTickAt;
        lastTickAt = startedAt;
        try {
          // A fresh capture per tick is the entire point of polling.
          const res = await readPixel(opts.x, opts.y, { maxAgeMs: 0 });
          const took = Date.now() - startedAt;
          stats.ticks++;
          stats.captures++;
          stats.lastCaptureMs = took;
          stats.totalMs += took;
          if (stopped) return;

          const matched = !res.outside && matches(res.rgb, target, opts.tolerance);
          // Measured ~117ms per capture on the development machine, not the
          // 40-90ms this file used to claim. A poll interval below the capture
          // cost is not a faster poll - it is the same poll, later, plus wasted
          // CPU. So say so once, with the real number, instead of letting the
          // user wonder why "50ms" feels like 150ms.
          if (!stats.warned && stats.ticks >= 4 && stats.lastIntervalMs > pollMs * 1.4) {
            stats.warned = true;
            log(
              'info',
              'pixel watch at ' + opts.x + ',' + opts.y + ': a screen capture costs ' +
                Math.round(stats.totalMs / stats.captures) + 'ms here, so the real interval is about ' +
                stats.lastIntervalMs + 'ms rather than the requested ' + pollMs + 'ms. ' +
                'Polling faster cannot make it faster.'
            );
          }
          // Reported for EVERY tick, so the caller's edge detection sees the
          // pixel leaving the colour as well as reaching it.
          if (typeof opts.onSample === 'function') opts.onSample({ res, matched });
          if (matched) await opts.onMatch({ colour: res.colour, rgb: res.rgb });
        } catch (err) {
          if (!stopped) {
            stopped = true;
            opts.onError(err);
            return;
          }
        } finally {
          inFlight = false;
          schedule();
        }
      }

      // Read once immediately so a pixel that is ALREADY the right colour fires
      // without waiting a full interval.
      tick();

      return {
        stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
          timer = null;
        },
        isPolling: () => !stopped,
        pollMs,
        /**
         * The REAL interval, measured. A desktop capture costs 40-90ms, so a
         * requested 50ms can only ever be honoured as "50ms plus the capture".
         * Reporting the measured value is what stops the block's number from
         * being a lie.
         */
        stats: () => ({
          pollMs,
          requestedPollMs: Number(opts.pollMs) || C.PIXEL.DEFAULT_POLL_MS,
          ticks: stats.ticks,
          avgCaptureMs: stats.captures ? Math.round(stats.totalMs / stats.captures) : 0,
          lastCaptureMs: stats.lastCaptureMs,
          realIntervalMs: stats.lastIntervalMs,
        }),
      };
    },

    /**
     * Explanation for the UI and the logs: is the coordinate mapping sane on this
     * machine? Also returns the colour under the cursor so the user can sanity
     * check the eyedropper.
     */
    async diagnostics() {
      const out = { available, reason };
    if (!canRead) return out;
      try {
        const cap = await grab(0);
        out.capture = { width: cap.width, height: cap.height, sourceId: cap.sourceId };
        out.virtualBounds = cap.bounds;
        out.scaleX = out.capture.width / Math.max(1, cap.bounds.width);
        out.scaleY = out.capture.height / Math.max(1, cap.bounds.height);
        if (input && input.available) {
          const cursor = await input.getCursorPosition();
          const mapped = mapToImage(cursor.x, cursor.y, cap);
          out.cursor = cursor;
          out.cursorMapped = { x: mapped.px, y: mapped.py, inside: mapped.inside };
          if (mapped.inside) out.cursorColour = toHex(pixelAt(cap, mapped.px, mapped.py));
        }
      } catch (err) {
        out.error = err.message;
      }
      return out;
    },
  };
}

module.exports = { createPixelService };
