/**
 * The eyedropper chip's renderer script.
 *
 * An EXTERNAL file rather than an inline <script>, because the chip's
 * Content-Security-Policy is `script-src 'self'` - the same strict policy the
 * main window uses. An inline script is blocked by it, and weakening the policy
 * for the sake of three lines would be a poor trade in the one window that is
 * click-through and always on top of everything else.
 *
 * It can only display what it is sent. There is no invoke channel here, so the
 * chip cannot ask the main process to do anything even in principle.
 */
(function () {
  'use strict';
  const swatch = document.getElementById('swatch');
  const text = document.getElementById('text');

  function preview(payload) {
    if (!payload || !payload.colour) return;
    swatch.style.background = payload.colour;
    text.textContent = payload.colour;
    text.classList.remove('hint');
  }

  function showHint(payload) {
    if (!payload || !payload.text) return;
    text.textContent = payload.text;
    text.classList.add('hint');
  }

  if (window.mbChip) {
    window.mbChip.onPreview(preview);
    window.mbChip.onHint(showHint);
  } else {
    text.textContent = 'Eyedropper unavailable';
  }
})();
