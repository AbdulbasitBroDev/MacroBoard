'use strict';

/**
 * MacroBlock - Electron main process.
 *
 * Responsibilities:
 *   - create the window
 *   - build the native services and the orchestrator
 *   - expose a narrow, explicit IPC surface to the renderer (see preload.js)
 *   - keep running normally even if a native module failed to load, telling the
 *     renderer exactly which features are degraded and why
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, nativeImage, shell } = require('electron');

const constants = require('../shared/constants');
const catalog = require('../shared/catalog');
const buttonMod = require('../shared/buttons');
const { createMacroStore } = require('./services/macroStore');
const { createInputService } = require('./services/inputService');
const { createHookService } = require('./services/hookService');
const { createPixelService } = require('./services/pixelService');
const { createWindowService } = require('./services/windowService');
const { createUpdateService } = require('./services/updateService');
const { createEyedropper } = require('./services/eyedropper');
const previewChip = require('./previewChip');
const { createOrchestrator } = require('./orchestrator');

let mainWindow = null;
let orchestrator = null;
let eyedropper = null;
let updater = null;
// Read by the startup check below, which is scheduled outside buildServices().
let updateFeedUrl = null;
let eyedropperSession = null;
let store = null;
let logFile = null;

/** --smoke runs a scripted self-check (screenshot + quit) and exits. */
const SMOKE = process.argv.indexOf('--smoke') !== -1;
/** --selftest runs the toolbox/block diagnostic harness in the renderer. */
const SELFTEST = process.argv.indexOf('--selftest') !== -1;

// ------------------------------------------------------------------ logging

function initLogging() {
  const dir = path.join(app.getPath('userData'), 'logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'macroblock.log');
  } catch (err) {
    logFile = null;
  }
}

/**
 * The single logging funnel. Every line goes to the file AND to the renderer's
 * log panel, so "here is the error I got" is always answerable from the UI.
 */
function log(level, message, meta) {
  const line = '[' + new Date().toISOString() + '] ' + level.toUpperCase() + ' ' + message +
    (meta ? ' ' + safeJson(meta) : '');
  const toConsole = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  toConsole(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line + '\n');
    } catch (err) {
      /* logging must never break the app */
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('mb:log', { level, message, meta: meta || null, at: Date.now() });
  }
}

function safeJson(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 2000 ? s.slice(0, 2000) + '...' : s;
  } catch (err) {
    return '[unserialisable]';
  }
}

// --------------------------------------------------------------- bootstrap

/**
 * Build the button catalog from whatever native enums actually loaded.
 * If a native module failed, its enum is empty and the catalog simply reports
 * those inputs as unavailable - the app still starts.
 */
function buildRuntimeCatalog() {
  let UiohookKey = {};
  let nutKey = {};
  let nutButton = {};
  try {
    // eslint-disable-next-line global-require
    UiohookKey = require('@fainthit/uiohook-napi-suppress').UiohookKey || {};
  } catch (err) {
    /* reported by HookService */
  }
  try {
    // eslint-disable-next-line global-require
    const nut = require('@nut-tree-fork/nut-js');
    nutKey = nut.Key || {};
    nutButton = nut.Button || {};
  } catch (err) {
    /* reported by InputService */
  }
  return buttonMod.createCatalog({ UiohookKey, nutKey, nutButton });
}

/**
 * The update URL electron-builder baked into this build, read from
 * app-update.yml next to the asar. Returns null when unpackaged or missing.
 */
function bakedUpdateUrl() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const match = yml.match(/^url:\s*(\S+)\s*$/m);
    return match ? match[1] : null;
  } catch (err) {
    return null;
  }
}

function buildServices() {
  const dir = app.getPath('userData');
  store = createMacroStore({ dir, log });

  const buttons = buildRuntimeCatalog();
  const input = createInputService({ log, buttons });
  const hook = createHookService({ log, buttons });
  const pixel = createPixelService({ log, input, electron: { desktopCapturer, nativeImage, screen } });
  // Started LAZILY inside the service, not here: a session that never waits for
  // a window must never spawn PowerShell at all.
  const window = createWindowService({ log, ownPid: process.pid });

  orchestrator = createOrchestrator({ log, input, hook, pixel, window, store });

  eyedropper = createEyedropper({
    log,
    hook,
    pixel,
    // Sampled live rather than after the click - see eyedropper.js.
    cursorPosition: () => input.getCursorPosition(),
  });

  orchestrator.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mb:status', status);
  });
  orchestrator.on('error', (message) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mb:error', { message });
  });

  // Updates are offered, never applied behind the user's back. Only meaningful in
  // a packaged build - `enabled` makes every call a clean no-op otherwise, so
  // `npm start` cannot reach the updater at all.
  //
  // The escape hatch below exists purely so the update flow can be TESTED without
  // installing two builds. Setting MB_UPDATE_FEED_URL while running from source
  // flips electron-updater's forceDevUpdateConfig, which is what the isPackaged
  // guard normally blocks. It never fires unless the variable is set, and it is
  // ignored entirely in a packaged build.
  const devFeedUrl = app.isPackaged ? null : process.env.MB_UPDATE_FEED_URL;
  updateFeedUrl = devFeedUrl;

  updater = createUpdateService({
    log,
    enabled: () => app.isPackaged || Boolean(devFeedUrl),
    getUpdater: () => {
      const autoUpdater = require('electron-updater').autoUpdater;
      // electron-updater's logger is a NoOpLogger unless something replaces it,
      // so by default the download and the quitAndInstall handoff are completely
      // silent. That made an update that downloaded but never installed look
      // identical to one that worked. Route it into the app log.
      autoUpdater.logger = {
        info: (m) => log('info', '[updater] ' + m),
        warn: (m) => log('warn', '[updater] ' + m),
        error: (m) => log('error', '[updater] ' + m),
        debug: (m) => log('debug', '[updater] ' + m),
      };
      if (devFeedUrl) {
        autoUpdater.forceDevUpdateConfig = true;
        autoUpdater.setFeedURL({ provider: 'generic', url: devFeedUrl });
      }
      return autoUpdater;
    },
  });
  updater.on('state', (state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mb:update:state', state);
  });

  // Unattended download+install, for the end-to-end test in
  // scripts/test-autoupdate.js. Guarded on the feed being LOOPBACK, so this is
  // inert against any real host: a shipped build pointed at a real update URL can
  // never auto-download or auto-restart, whatever the environment says.
  //
  // A packaged app takes its feed from app-update.yml, which electron-builder
  // writes next to the asar - not from an environment variable - so the baked
  // URL is what has to be checked.
  const feedUrlForAutoflow = app.isPackaged ? bakedUpdateUrl() : updateFeedUrl;
  if (feedUrlForAutoflow && /127\.0\.0\.1|localhost/i.test(feedUrlForAutoflow)) {
    log('info', 'update: loopback feed detected, autoflow enabled');
    updater.on('state', (state) => {
      if (state.state === 'available') updater.download();
      else if (state.state === 'downloaded') updater.install();
    });
  }

  return { input, hook, pixel, window, buttons, updater };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: constants.COLOURS.background,
    title: 'MacroBlock',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Never let the renderer navigate away or pop new windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // --selftest: drive the toolbox from inside the renderer and dump what
  // happens, so a broken flyout comes with its real exception text.
  if (SELFTEST) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        let payload = '{}';
        try {
          const harness = fs.readFileSync(
            path.join(__dirname, '..', '..', 'scripts', 'selftest-renderer.js'),
            'utf8'
          );
          payload = await mainWindow.webContents.executeJavaScript(harness, true);
        } catch (err) {
          payload = JSON.stringify({ harnessFailed: err.message }, null, 2);
        }
        try {
          fs.writeFileSync(path.join(process.cwd(), '_selftest.json'), payload);
          log('info', 'selftest written to _selftest.json');
        } catch (err) {
          log('error', 'could not write _selftest.json: ' + err.message);
        }
        setTimeout(() => app.quit(), 300);
      }, 5000);
    });
  }

  // --smoke: wait for the UI to settle, save a screenshot, then quit. This is
  // how the app is verified without a human at the keyboard.
  if (SMOKE) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          const file = path.join(process.cwd(), '_screenshot.png');
          fs.writeFileSync(file, image.toPNG());
          log('info', 'smoke screenshot written to ' + file);
        } catch (err) {
          log('error', 'smoke screenshot failed: ' + err.message);
        }
        setTimeout(() => app.quit(), 400);
      }, 6000);
    });
  }

  return mainWindow;
}

// ------------------------------------------------------------------- IPC

function registerIpc(services) {
  const { input, hook, pixel, window, buttons } = services;
  const refreshShortcutMacros = () => orchestrator.configureShortcutMacros(store.shortcutMacros());
  refreshShortcutMacros();
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  /** Wrap a handler so a thrown error becomes { ok:false, reason } for the UI. */
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        const value = await fn(payload || {});
        return value === undefined ? { ok: true } : value;
      } catch (err) {
        log('error', channel + ' failed: ' + err.message);
        send('mb:error', { message: err.message, channel });
        return { ok: false, reason: err.message };
      }
    });
  };

  // ---- bootstrap -----------------------------------------------------
  /**
   * NOTE: everything returned here must be structured-cloneable. That is why the
   * shared `catalog` is NOT sent - it contains helper functions. The renderer has
   * its own copy of it already (loaded as a plain script), so it only needs data.
   */
  handle('mb:bootstrap', async () => ({
    ok: true,
    app: {
      name: 'MacroBlock',
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
    constants: {
      LIMITS: constants.LIMITS,
      PIXEL: constants.PIXEL,
      COLOURS: constants.COLOURS,
      CATEGORIES: constants.CATEGORIES,
      SLOT: constants.SLOT,
      STEP: constants.STEP,
      RUN_STATE: constants.RUN_STATE,
      START: constants.START,
      GLOBAL_STOP_KEY: constants.GLOBAL_STOP_KEY,
      MACRO_FORMAT_VERSION: constants.MACRO_FORMAT_VERSION,
    },
    catalog: {
      START: catalog.START,
      MOUSE: catalog.MOUSE,
      KEYBOARD: catalog.KEYBOARD,
      CONTROL: catalog.CONTROL,
      VALUE: catalog.VALUE,
      START_TYPES: catalog.START_TYPES,
      BUTTON_FIELDS: catalog.BUTTON_FIELDS,
      START_META: catalog.START_META,
    },
    degradations: {
      input: input.available ? null : input.reason,
      hook: hook.available ? null : hook.reason,
      pixel: pixel.available ? null : pixel.reason,
    },
    store: store.info(),
    status: orchestrator.status(),
  }));

  handle('mb:bootstrapButtons', async () => {
    // A synchronous snapshot for the renderer: id -> { label, sim }. The UI needs
    // to validate/describe buttons while compiling on every keystroke, and IPC is
    // async, so this table is sent once at startup.
    const table = {};
    buttons.gridKeys().forEach((k) => {
      if (table[k.id]) return;
      table[k.id] = { label: k.label, sim: k.sim, note: k.note };
    });
    buttons.mouseButtons().forEach((m) => {
      table[m.id] = { label: m.label, sim: m.sim, note: m.note };
    });
    return {
      ok: true,
      buttonTable: table,
      keyboardGrid: buttons.KEYBOARD_GRID,
      numpadGrid: buttons.NUMPAD_GRID,
      mouseButtons: buttons.mouseButtons(),
    };
  });

  handle('mb:describeButton', async ({ buttonId }) => ({
    ok: true,
    description: buttons.describe(buttonId),
    validation: buttons.validate(buttonId),
  }));

  // ---- macros --------------------------------------------------------
  handle('mb:macros:list', async () => ({ ok: true, macros: store.list() }));
  handle('mb:macros:get', async ({ id }) => ({ ok: true, macro: store.get(id) }));
  handle('mb:macros:save', async (payload) => {
    const result = store.save(payload);
    refreshShortcutMacros();
    return Object.assign({ ok: true, macros: store.list() }, result);
  });
  handle('mb:macros:rename', async ({ id, name }) =>
    Object.assign(store.rename(id, name), { macros: store.list() })
  );
  handle('mb:macros:duplicate', async ({ id }) => {
    const result = store.duplicate(id);
    refreshShortcutMacros();
    return Object.assign(result, { macros: store.list() });
  });
  handle('mb:macros:delete', async ({ id }) => {
    // A deleted macro must not stay armed.
    orchestrator.disarm(id, 'macro deleted');
    const result = store.remove(id);
    refreshShortcutMacros();
    return Object.assign(result, { macros: store.list() });
  });
  handle('mb:macros:names', async () => ({ ok: true, names: store.names() }));

  // ---- running -------------------------------------------------------
  handle('mb:run:arm', async ({ start, steps, macroName, macroId, triggerId }) =>
    orchestrator.arm(start, steps, macroName, macroId, triggerId)
  );
  handle('mb:run:shortcuts', async ({ shortcuts, start, steps, macroName, macroId }) =>
    orchestrator.configureShortcuts(shortcuts, start, steps, macroName, macroId)
  );
  handle('mb:run:disarm', async ({ macroId } = {}) =>
    // No macroId = disarm everything (used by shutdown-style UI actions).
    macroId ? orchestrator.disarm(macroId, 'requested') : orchestrator.disarmAll('requested')
  );
  handle('mb:run:now', async ({ steps, macroName }) => orchestrator.runSteps(steps || [], macroName || 'run'));
  handle('mb:run:selected', async ({ steps }) => orchestrator.runSteps(steps || [], 'selection'));
  handle('mb:run:stop', async () => orchestrator.stop('stopped by user'));
  handle('mb:status', async () => ({ ok: true, status: orchestrator.status() }));
  handle('mb:diagnostics', async () => ({ ok: true, diagnostics: orchestrator.diagnostics() }));
  handle('mb:pixel:diagnostics', async () => ({
    ok: true,
    diagnostics: await orchestrator.pixelDiagnostics(),
  }));
  handle('mb:window:list', async () => {
    // Powers the title dropdown on "wait until window" and the diagnostics
    // dump. Reports the service's own error rather than throwing, so a broken
    // helper shows as readable text instead of an unhandled rejection.
    try {
      return { ok: true, windows: await orchestrator.listWindows() };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  // ---- capture (button picker, coordinate picker, eyedropper) ---------
  handle('mb:capture:press', async ({ timeoutMs }) => {
    const res = await orchestrator.capturePress(timeoutMs);
    return Object.assign({ ok: true }, res);
  });
  handle('mb:capture:chord', async ({ timeoutMs }) => ({
    ok: true,
    buttonIds: await orchestrator.captureChord(timeoutMs),
  }));
  handle('mb:capture:coordinate', async ({ timeoutMs }) => {
    // Move the app out of the way, arm a one-shot global click listener, then
    // restore. Coordinates come straight from the hook, so there is NO DPI
    // conversion between the picker and the macro's coordinate space.
    const win = mainWindow;
    const minimised = Boolean(win && !win.isDestroyed());
    if (minimised) win.minimize();
    try {
      await new Promise((r) => setTimeout(r, 260));
      const point = await orchestrator.captureCoordinate(timeoutMs);
      return { ok: true, x: point.x, y: point.y };
    } finally {
      if (minimised && win && !win.isDestroyed()) {
        win.restore();
        win.show();
        win.focus();
      }
    }
  });
  handle('mb:pixel:read', async ({ x, y }) => {
    const res = await orchestrator.readPixel(x, y);
    return { ok: true, pixel: res };
  });

  // ---- eyedropper ---------------------------------------------------
  // The main window is hidden for the WHOLE session, not just around the
  // click. Hiding it per-click was the old behaviour and it read the wrong
  // colour: the click landed, the app underneath reacted, and the capture then
  // photographed the reaction. Sampling on hover removes the click from the
  // sampling path entirely.

  handle('mb:eyedropper:start', async () => {
    if (eyedropper.isActive()) return { ok: false, reason: 'An eyedropper is already running.' };

    const win = mainWindow;
    const wasVisible = Boolean(win && !win.isDestroyed() && win.isVisible());
    let result;
    try {
      // hide() rather than minimize(): a minimized window still shows in the
      // taskbar and flashes on the way, and stealing focus is what we are
      // trying to avoid.
      if (wasVisible) win.hide();
      const session = eyedropper.start({
        onPreview: (sample) => {
          // The chip follows the cursor, so it needs the display the cursor is
          // ON, not the primary one - on a multi-monitor setup the primary
          // bounds would put it on the wrong screen entirely.
          const display =
            screen.getDisplayNearestPoint({ x: Math.round(sample.x), y: Math.round(sample.y) }) ||
            screen.getPrimaryDisplay();
          // workArea for the bounds (so the chip avoids the taskbar), and
          // scaleFactor for the physical->DIP conversion the chip needs to stay
          // under the cursor on a scaled display.
          previewChip.show(sample, {
            width: (display.workArea || display.bounds).width,
            height: (display.workArea || display.bounds).height,
            scaleFactor: display.scaleFactor || 1,
          });
        },
        onHint: (text) => previewChip.hint(text),
      });
      eyedropperSession = session;
      result = await session.promise;
    } catch (err) {
      result = { ok: false, reason: err.message };
    } finally {
      eyedropperSession = null;
      previewChip.hide();
      if (wasVisible && win && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
    }
    if (result && result.ok) return { ok: true, x: result.x, y: result.y, colour: result.colour };
    return { ok: false, cancelled: Boolean(result && result.cancelled), reason: (result && result.reason) || 'cancelled' };
  });

  handle('mb:eyedropper:cancel', async () => {
    if (eyedropperSession) eyedropperSession.cancel();
    return { ok: true };
  });

  // ---- record mode ---------------------------------------------------
  handle('mb:record:start', async () =>
    orchestrator.startRecording((event) => send('mb:record:event', event))
  );
  handle('mb:record:stop', async () => orchestrator.stopRecording('requested'));
  handle('mb:record:hotkey', async ({ buttonId }) => orchestrator.setRecordHotkey(buttonId));
  handle('mb:record:hotkey:get', async () => ({
    ok: true,
    buttonId: store.getRecordHotkey(),
    description: store.getRecordHotkey() ? buttons.describe(store.getRecordHotkey()) : null,
  }));

  // ---- window --------------------------------------------------------
  handle('mb:window:minimize', async () => {
    if (mainWindow) mainWindow.minimize();
    return { ok: true };
  });
  handle('mb:shell:openLogFolder', async () => {
    shell.openPath(path.join(app.getPath('userData'), 'logs'));
    return { ok: true };
  });

  // ---- updates -------------------------------------------------------
  // `mb:update:install` is the one handler allowed to end the process: the
  // service returns true only once quitAndInstall has actually taken over, so a
  // refusal leaves the app running and the UI can say why.
  handle('mb:update:check', async (payload) => Object.assign({ ok: true }, await updater.check(payload)));
  handle('mb:update:download', async () => Object.assign({ ok: true }, await updater.download()));
  handle('mb:update:install', async () => ({ ok: true, starting: updater.install() }));
  handle('mb:update:state', async () => Object.assign({ ok: true }, updater.snapshot()));

  // ---- settings ---------------------------------------------------------
  // The first consumer of macroStore.getSettings/setSettings, which shipped with
  // the store but had never been called by anything. setSettings MERGES its patch,
  // so writing one key cannot clobber another.
  handle('mb:settings:get', async () => ({ ok: true, settings: store.getSettings() }));
  handle('mb:settings:set', async (payload) => ({
    ok: true,
    settings: store.setSettings(payload && payload.patch ? payload.patch : {}),
  }));

  // ---- logging straight from the renderer ---------------------------
  ipcMain.on('mb:log', (_event, payload) => {
    if (payload && payload.message) {
      log(payload.level || 'info', '[renderer] ' + payload.message, payload.meta);
    }
  });
}

// ------------------------------------------------------------- lifecycle

// A second copy of MacroBlock would fight over the global hook and the same
// macro file, so only one instance is allowed.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    initLogging();
    log('info', 'MacroBlock starting', {
      electron: process.versions.electron,
      node: process.versions.node,
      userData: app.getPath('userData'),
    });
    const services = buildServices();
    registerIpc(services);
    createWindow();

    // Checked once, well after launch, and only when packaged. A slow or absent
    // network must not delay the window appearing, so this is deliberately not
    // awaited and not on the critical path. An explicit test feed checks almost
    // immediately, because you are waiting for it.
    setTimeout(() => {
      updater.check().catch((err) => log('warn', 'update check failed: ' + err.message));
    }, updateFeedUrl ? 1500 : 8000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Tear the eyedropper down first. Its chip is a hidden click-through window
    // and its hook listener is long-lived, so neither goes away on its own.
    if (eyedropperSession) eyedropperSession.cancel();
    previewChip.destroy();
    if (orchestrator) orchestrator.shutdown();
    app.quit();
  });
  app.on('before-quit', () => {
    // Make sure nothing is left held down when the app goes away.
    if (orchestrator) orchestrator.shutdown();
  });

  process.on('uncaughtException', (err) => {
    log('error', 'uncaught exception in main: ' + (err && err.stack ? err.stack : err));
  });
  process.on('unhandledRejection', (reason) => {
    log('error', 'unhandled rejection in main: ' + (reason && reason.message ? reason.message : reason));
  });
}

