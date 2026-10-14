/**
 * MacroBoard - shared pixel colour matching
 *
 * ONE colour comparison, used by three callers that must agree exactly:
 *
 *   - pixelService's `matches`, which drives the pixel TRIGGER,
 *   - the engine's `if pixel is <colour>` step, and
 *   - the `if pixel is` block's own tooling.
 *
 * If these ever diverged you would get the maddening bug where the trigger
 * fires on a colour that the inline `if` says is not a match - same pixel, same
 * tolerance, different answer. So the rule lives here and nowhere else.
 *
 * Tolerance is PER CHANNEL, not a distance in RGB space. That is the same rule
 * the existing pixel trigger has always used, deliberately: a per-channel bound
 * is what "within N of this grey" means to a person reading a colour picker,
 * whereas a euclidean distance is neither predictable nor explainable.
 *
 * UMD: main, renderer and tests all require()/load the same file.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MB = root.MB || {};
    root.MB.pixels = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** Clamp a tolerance into the range the UI offers (0-255 per channel). */
  function clampTolerance(t) {
    var n = Math.floor(Number(t));
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(255, n);
  }

  /**
   * Parse `#rrggbb` (or `rrggbb`) into channel values.
   * @return {{r:number,g:number,b:number}|null} null when the string is not a
   *   full 6-digit hex colour, which the UI prevents but a hand-edited saved
   *   macro can still contain.
   */
  function hexToRgb(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex == null ? '' : hex));
    if (!m) return null;
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
  }

  /** Render channel values back to `#rrggbb`. */
  function toHex(rgb) {
    if (!rgb) return '#000000';
    return (
      '#' +
      [rgb.r, rgb.g, rgb.b]
        .map(function (v) {
          var n = Math.max(0, Math.min(255, Math.round(Number(v) || 0)));
          return n.toString(16).padStart(2, '0');
        })
        .join('')
    );
  }

  /**
   * Do two colours match within `tolerance`?
   *
   * @param {object} a       {r,g,b} - the pixel that was actually read
   * @param {object|string} target  {r,g,b} or a `#rrggbb` string
   * @param {number} [tolerance]    per-channel 0-255, default 0 = exact
   * @return {boolean} false for a null/unparseable target, so a corrupt colour
   *   is "does not match" rather than a thrown error mid-run.
   */
  function matches(a, target, tolerance) {
    if (!a) return false;
    var t = typeof target === 'string' ? hexToRgb(target) : target;
    if (!t) return false;
    var tol = clampTolerance(tolerance);
    return (
      Math.abs(Number(a.r) - t.r) <= tol &&
      Math.abs(Number(a.g) - t.g) <= tol &&
      Math.abs(Number(a.b) - t.b) <= tol
    );
  }

  /**
   * How far off a colour is, as the largest per-channel difference.
   *
   * Exposed for the diagnostics dump so a user staring at a pixel block can see
   * *why* it is not matching ("off by 60 on blue") instead of guessing at the
   * tolerance value.
   */
  function maxChannelDelta(a, target) {
    var t = typeof target === 'string' ? hexToRgb(target) : target;
    if (!a || !t) return null;
    return Math.max(Math.abs(Number(a.r) - t.r), Math.abs(Number(a.g) - t.g), Math.abs(Number(a.b) - t.b));
  }

  return {
    clampTolerance: clampTolerance,
    hexToRgb: hexToRgb,
    toHex: toHex,
    matches: matches,
    maxChannelDelta: maxChannelDelta,
  };
});