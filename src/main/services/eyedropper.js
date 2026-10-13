'use strict';

/**
 * Eyedropper - pick a colour off the screen.
 *
 * WHY THIS EXISTS RATHER THAN "WAIT FOR A CLICK, THEN READ THE PIXEL"
 * -----------------------------------------------------------------
 * That is how the old eyedropper worked, and it read the WRONG colour most of
 * the time. The sequence was: wait for a click, then capture the screen. But by
 * the time the capture happened the click had already been delivered to the app
 * underneath - a menu had opened, a page had navigated, a row had highlighted.
 * So the pixel that got read was frequently the thing the click CAUSED rather
 * than the thing that was clicked.
 *
 * The fix is to sample while HOVERING, before any click exists, and commit the
 * colour that was already on screen. There is no click in the sampling path at
 * all, so nothing can change underneath it.
 *
 * HOW YOU COMMIT
 * --------------
 *   Ctrl + left click   at the pixel. Convenient, but see the limitation below.
 *   Ctrl + Enter        at whatever the cursor is hovering. NO mouse click, so
 *                       the app underneath is never touched at all.
 *   Escape              cancel.
 *   A plain click       ignored. Deliberate: a stray click must not silently
 *                       pick a colour, and it must not quietly fire whatever
 *                       the user was reaching for.
 *
 * THE LIMITATION, STATED PLAINLY
 * ------------------------------
 * This app cannot block mouse buttons. The low-level hook addon can swallow
 * KEYBOARD events only (see hookService.js armSuppress), so there is no way to
 * stop a click reaching the app underneath. That is precisely why Ctrl is
 * required: the commit is always a deliberate act. If picking a pixel must have
 * zero effect on the app underneath, use Ctrl+Enter, which involves no click.
 *
 * Pure logic - no Electron, no screen access of its own. The `pixel` port does
 * the reading and the `hook` port delivers events; this file decides what they
 * mean. That is what makes the whole flow testable headlessly.
 */

const C = require('../../shared/constants');

/** Below this, two samples are considered "the same pixel". */
const SAME_PIXEL_PX = 2;

/**
 * A hover sample older than this is not trusted on commit: the user may have
 * moved since, and committing a colour for a position they are no longer on is
 * worse than taking a slightly late reading.
 */
const SAMPLE_MAX_AGE_MS = 500;

function createEyedropper(deps) {
  deps = deps || {};
  const log = deps.log || (() => {});
  const hook = deps.hook;
  const pixel = deps.pixel;
  const pollMs = deps.pollMs || C.PIXEL.DEFAULT_POLL_MS;
  const now = deps.now || Date.now;

  /** The live session, or null. One at a time, by construction. */
  let session = null;

  /**
   * Begin a session.
   *
   * @return {{promise: Promise<object>, cancel: Function}} The promise resolves
   *   exactly once, with `{ok:true, x, y, colour}` or `{ok:false, cancelled:true}`
   *   or `{ok:false, reason}`. `cancel` lets the host tear the session down if
   *   something else ends it first (the app closing, a second request arriving).
   */
  function start(opts) {
    opts = opts || {};
    if (!hook || typeof hook.retain !== 'function') {
      return {
        promise: Promise.reject(new Error('The global input hook is unavailable.')),
        cancel() {},
      };
    }
    if (!pixel || typeof pixel.readPixel !== 'function') {
      return {
        promise: Promise.reject(new Error('Screen pixel reading is unavailable, so the eyedropper cannot work.')),
        cancel() {},
      };
    }
    if (session) {
      return { promise: Promise.reject(new Error('An eyedropper is already running.')), cancel() {} };
    }

    let resolve = null;
    const promise = new Promise((r) => {
      resolve = r;
    });

    session = {
      active: true,
      last: null, // {x, y, colour, at}
      inFlight: null, // {x, y, promise} while a capture is running
      hintedCtrl: false,
      release: null,
      resolve,
    };

    const end = (result) => {
      if (!session || !session.active) return;
      session.active = false;
      if (session.release) session.release();
      const done = session;
      session = null;
      done.resolve(result);
      if (typeof opts.onDone === 'function') opts.onDone(result);
    };
    session.end = end;

    const onPreview = typeof opts.onPreview === 'function' ? opts.onPreview : () => {};
    const onHint = typeof opts.onHint === 'function' ? opts.onHint : () => {};

    /**
     * Sample the pixel under (x, y).
     *
     * One capture in flight at a time. A capture costs 40-90ms, so a fast mouse
     * would otherwise queue captures that all answer about a position the cursor
     * has already left - and burn CPU doing it. The position sampled is the one
     * the cursor is at when the capture STARTS, so a preview is never a lie
     * about where the cursor is, only slightly behind it.
     */
    function sample(x, y) {
      if (!session || !session.active) return Promise.resolve(null);
      if (session.inFlight) return session.inFlight.promise;
      const promise = (async () => {
        try {
          const res = await pixel.readPixel(x, y);
          if (!session || !session.active) return null;
          if (res && !res.outside && res.colour) {
            session.last = { x, y, colour: res.colour, at: now() };
            onPreview({ x, y, colour: res.colour });
          }
          return res;
        } catch (err) {
          // Displays sleep, UAC prompts appear, screens lock. A failed sample is
          // no reason to end the eyedropper - the user is probably still moving
          // towards a target.
          log('warn', 'eyedropper sample failed: ' + err.message);
          return null;
        }
      })();
      session.inFlight = { x, y, promise };
      // Cleared in a `then`, not after an `await` on this frame, so a failure
      // cannot leave the slot permanently occupied.
      promise.then(() => {
        if (session && session.inFlight && session.inFlight.promise === promise) session.inFlight = null;
      });
      return promise;
    }

    /** Is (x,y) close enough to (px,py) to reuse that reading? */
    function near(px, py, x, y) {
      return Math.abs(px - x) <= SAME_PIXEL_PX && Math.abs(py - y) <= SAME_PIXEL_PX;
    }

    /**
     * Commit at (x, y), preferring the HOVER sample over a fresh capture.
     *
     * This is the accuracy fix. By commit time the click has already changed the
     * screen, so a fresh read would report whatever the click caused. The hover
     * sample was taken while nothing was being clicked.
     *
     * The in-flight case matters and is easy to get wrong: a capture takes
     * 40-90ms, so a user who moves and clicks quickly has a sample STARTING but
     * not yet RESOLVED. Falling through to a fresh read there would be exactly
     * the old bug. So an in-flight sample for the same pixel is awaited instead.
     */
    async function commit(x, y) {
      const last = session ? session.last : null;
      const trustworthy = last && near(last.x, last.y, x, y) && now() - last.at <= SAMPLE_MAX_AGE_MS;
      if (trustworthy) return finish(x, y, last.colour);

      const pending = session ? session.inFlight : null;
      if (pending && near(pending.x, pending.y, x, y)) {
        await pending.promise;
        if (!session) return; // the session ended while we waited
        const now2 = session.last;
        if (now2 && near(now2.x, now2.y, x, y)) return finish(x, y, now2.colour);
      } else if (pending) {
        // Something unrelated is in flight. Let it finish first so we do not
        // stack a second capture on top of it.
        await pending.promise;
        if (!session) return;
      }

      const res = await sample(x, y);
      if (!session) return;
      const got = session.last;
      // `outside` is checked here as well as in sample(): an off-screen
      // coordinate still returns a #000000 "colour", and picking black because
      // the cursor was past the edge of the desktop is never the right answer.
      const colour =
        (res && !res.outside && res.colour) || (got && near(got.x, got.y, x, y) ? got.colour : null) || null;
      if (!colour) {
        onHint('Could not read that pixel. Move the mouse and try again.');
        session.end({ ok: false, reason: 'unreadable' });
        return;
      }
      finish(x, y, colour);
    }

    function finish(x, y, colour) {
      if (typeof opts.onPicked === 'function') opts.onPicked({ x, y, colour });
      session.end({ ok: true, x, y, colour });
    }

    function onEvent(kind, payload) {
      if (!session || !session.active) return false;
      const raw = payload.raw || {};

      if (kind === 'mousemove') {
        sample(payload.x, payload.y);
        return false; // keep listening
      }

      if (kind === 'mousedown') {
        if (!raw.ctrlKey) {
          // Ignored on purpose, and explained once rather than every time.
          if (!session.hintedCtrl) {
            session.hintedCtrl = true;
            onHint('Hold Ctrl and click. Or Ctrl+Enter for no click at all.');
          }
          return false;
        }
        commit(payload.x, payload.y);
        return true;
      }

      if (kind === 'keydown') {
        const code = payload.button ? String(payload.button).replace(/^key:/, '').toLowerCase() : '';
        if (code === 'escape') {
          end({ ok: false, cancelled: true });
          return true;
        }
        if (code === 'enter' || code === 'return' || code === 'kpenter') {
          if (!raw.ctrlKey) {
            onHint('Hold Ctrl and press Enter to pick.');
            return false;
          }
          // "The pixel I am pointing at". A resolved sample is the best answer,
          // but an IN-FLIGHT one is still the right position - the capture was
          // started for where the cursor was, which is where it still is.
          const at = session.last || (session.inFlight && { x: session.inFlight.x, y: session.inFlight.y });
          if (!at) {
            onHint('Move the mouse over the pixel first, then press Ctrl+Enter.');
            return false;
          }
          // No mouse click is involved, so the app underneath is untouched.
          commit(at.x, at.y);
          return true;
        }
      }
      return false;
    }

    session.release = hook.retain((kind, payload) => onEvent(kind, payload));
    // A first sample straight away, so the preview is not blank until the user
    // happens to move the mouse. Guarded: the cursor port is a driver call and
    // a failure there must not stop the eyedropper from starting.
    let pos = null;
    try {
      if (typeof deps.cursorPosition === 'function') pos = deps.cursorPosition();
    } catch (err) {
      log('warn', 'eyedropper could not read the cursor position: ' + err.message);
    }
    if (pos && isFinite(pos.x) && isFinite(pos.y)) sample(pos.x, pos.y);
    log('info', 'eyedropper started (Ctrl+click or Ctrl+Enter to pick, Escape to cancel)');

    return { promise, cancel: () => end({ ok: false, cancelled: true }) };
  }

  /** Test/diagnostic helper: is a session running right now? */
  function isActive() {
    return Boolean(session && session.active);
  }

  return { start, isActive, cancel: () => session && session.end({ ok: false, cancelled: true }), SAME_PIXEL_PX, SAMPLE_MAX_AGE_MS };
}

module.exports = { createEyedropper, SAME_PIXEL_PX, SAMPLE_MAX_AGE_MS };
