'use strict';

/**
 * The eyedropper's floating preview chip.
 *
 * A small always-on-top, click-through window that follows the cursor and shows
 * the colour currently under it. It exists because the main window has to be
 * HIDDEN while the eyedropper runs - otherwise the user is picking a pixel of
 * MacroBoard instead of the app they care about - so there is nowhere else to
 * show the preview.
 *
 * `setIgnoreMouseEvents(true)` is the important line: the chip must never
 * intercept the click that is picking the colour, nor block anything the user
 * is reaching for underneath it.
 *
 * The chip is deliberately tiny and dark. It sits at an offset from the cursor
 * rather than on it, so it never covers the pixel being sampled.
 */

const { BrowserWindow } = require('electron');
const path = require('path');

const WIDTH = 252;
const HEIGHT = 52;
/** Offset from the cursor, so the chip never covers the pixel being sampled. */
const OFFSET_X = 18;
const OFFSET_Y = 20;
/** Flip to the other side of the cursor near a screen edge. */
const MARGIN = 8;

let win = null;

/**
 * The last thing we wanted to display.
 *
 * The chip is created on first use, so its preload and document are not ready
 * when the very first `send` happens - the message is dropped and the chip sits
 * on its placeholder text. So the newest payload is remembered and replayed
 * once the document has actually loaded.
 */
let pending = null;
let ready = false;

function post(channel, body) {
  const w = ensure();
  if (!ready) {
    pending = { channel, body };
    return;
  }
  w.webContents.send(channel, body);
}

function ensure() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    // 'screen-saver' is the highest level available; the chip has to stay above
    // full-screen apps, which is often where a game or a video is being sampled.
    // The opacity nudges above 'pop-up-menu', which is what most tools use.
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preloadChip.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  // Never take focus, never appear in Alt+Tab, never be a task the user has to
  // dismiss. It is an instrument, not a window.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'eyedropper.html'));
  win.webContents.on('did-finish-load', () => {
    ready = true;
    if (pending && !win.isDestroyed()) {
      win.webContents.send(pending.channel, pending.body);
      pending = null;
    }
  });
  win.webContents.on('render-process-gone', () => {
    ready = false;
  });
  win.on('closed', () => {
    win = null;
    ready = false;
    pending = null;
  });
  return win;
}

/**
 * Move the chip next to the cursor and show the sampled colour.
 * @param {{x:number,y:number,colour:string}} sample
 * @param {{width:number,height:number}} screenSize of the display the cursor is on
 */
function show(sample, screenSize) {
  const w = ensure();
  const sw = (screenSize && screenSize.width) || 1920;
  const sh = (screenSize && screenSize.height) || 1080;
  const cursorX = (sample && sample.x) || 0;
  const cursorY = (sample && sample.y) || 0;

  // Coordinates from the hook are physical pixels; the window API wants DIPs.
  // On a scaled display those differ, so the chip would drift away from the
  // cursor without this. The scale is read from the display itself rather than
  // from the window, because a transparent un-resizable window gives us
  // nothing reliable to divide by.
  const scale = (screenSize && screenSize.scaleFactor) || 1;
  const dipX = Math.round(cursorX / scale);
  const dipY = Math.round(cursorY / scale);

  let px = dipX + OFFSET_X;
  let py = dipY + OFFSET_Y;
  if (px + WIDTH + MARGIN > sw) px = dipX - WIDTH - OFFSET_X;
  if (py + HEIGHT + MARGIN > sh) py = dipY - HEIGHT - OFFSET_Y;

  w.setPosition(Math.max(MARGIN, px), Math.max(MARGIN, py));
  if (!w.isVisible()) w.showInactive();
  if (sample && sample.colour) post('mb:eyedropper:preview', { colour: sample.colour });
}

/** Show a one-line instruction with no colour, e.g. "hold Ctrl". */
function hint(text) {
  post('mb:eyedropper:hint', { text });
}

function hide() {
  if (win && !win.isDestroyed()) win.hide();
}

function destroy() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  ready = false;
  pending = null;
}

module.exports = { show, hint, hide, destroy, WIDTH, HEIGHT };
