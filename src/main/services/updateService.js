'use strict';

/**
 * updateService
 *
 * Checks for a newer MacroBoard and reports progress to the UI.
 *
 * Design rules, in priority order:
 *
 *   1. **An update problem must never become an app problem.** Every failure is
 *      absorbed into the `error` state. No check, download or install path is
 *      allowed to reject into the caller, because a user with no network must
 *      still be able to open the editor and run macros.
 *
 *   2. **Never download or install without being asked.** `autoDownload` is off,
 *      so the app only ever *offers* an update. Restarts are the user's choice.
 *
 *   3. **Never run unpackaged.** electron-updater throws when `app.isPackaged`
 *      is false, which would turn `npm start` into a broken dev experience. The
 *      `enabled` gate makes every call a clean no-op instead.
 *
 * The updater is injected rather than required at module load so the whole
 * state machine can be tested without booting Electron.
 */

const { EventEmitter } = require('events');

/** Cooldown between checks, so several triggers cannot pile up. */
const MIN_CHECK_INTERVAL_MS = 60 * 1000;

const STATES = Object.freeze({
  DISABLED: 'disabled',
  IDLE: 'idle',
  CHECKING: 'checking',
  UP_TO_DATE: 'up-to-date',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  DOWNLOADED: 'downloaded',
  ERROR: 'error',
});

function createUpdateService(deps) {
  const log = deps.log || (() => {});
  const getUpdater = deps.getUpdater;
  const enabled = typeof deps.enabled === 'function' ? deps.enabled : () => true;
  const minIntervalMs = deps.minIntervalMs === undefined ? MIN_CHECK_INTERVAL_MS : deps.minIntervalMs;
  const now = deps.now || (() => Date.now());

  const bus = new EventEmitter();

  let state = STATES.IDLE;
  let version = '';
  let percent = 0;
  let message = '';
  let lastCheckAt = 0;
  let inFlight = false;
  let attached = false;

  function snapshot() {
    return { state, version, percent, message };
  }

  function set(patch) {
    const before = state;
    state = patch.state === undefined ? state : patch.state;
    version = patch.version === undefined ? version : patch.version;
    percent = patch.percent === undefined ? 0 : patch.percent;
    message = patch.message === undefined ? '' : patch.message;
    if (before !== state || patch.force) {
      // Logged on every transition, not just failures: "nothing appeared in the
      // log" and "the check silently did nothing" look identical otherwise, and
      // the first one is the harder bug to notice.
      log('info', 'update: ' + state + (version ? ' ' + version : '') + (message ? ' - ' + message : ''));
      bus.emit('state', snapshot());
    }
  }

  /** Translate electron-updater's event stream into our state machine. */
  function attach(updater) {
    if (attached) return;
    attached = true;

    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;

    updater.on('checking-for-update', () => set({ state: STATES.CHECKING, message: '' }));
    updater.on('update-available', (info) => set({ state: STATES.AVAILABLE, version: info && info.version, percent: 0 }));
    updater.on('update-not-available', () => set({ state: STATES.UP_TO_DATE, percent: 0 }));
    updater.on('download-progress', (p) => set({ state: STATES.DOWNLOADING, percent: p && p.percent }));
    updater.on('update-downloaded', (info) => set({ state: STATES.DOWNLOADED, version: info && info.version, percent: 100 }));

    updater.on('error', (err) => {
      const text = err && err.message ? err.message : String(err);
      log('warn', 'update error: ' + text);
      set({ state: STATES.ERROR, message: text, percent: 0 });
    });
  }

  /**
   * Ask the feed whether a newer version exists.
   * Resolves to a snapshot; never rejects.
   */
  async function check(opts) {
    const force = Boolean(opts && opts.force);

    if (!enabled()) {
      set({ state: STATES.DISABLED });
      return snapshot();
    }
    if (inFlight) return snapshot();
    if (!force && lastCheckAt && now() - lastCheckAt < minIntervalMs) return snapshot();

    let updater;
    try {
      updater = getUpdater();
      if (!updater) throw new Error('electron-updater is unavailable');
    } catch (err) {
      log('warn', 'update check unavailable: ' + err.message);
      set({ state: STATES.ERROR, message: err.message });
      return snapshot();
    }

    attach(updater);
    inFlight = true;
    lastCheckAt = now();
    set({ state: STATES.CHECKING, message: '' });

    try {
      await updater.checkForUpdates();
    } catch (err) {
      log('warn', 'checkForUpdates threw: ' + err.message);
      set({ state: STATES.ERROR, message: err.message });
    } finally {
      inFlight = false;
    }
    return snapshot();
  }

  /** Fetch the offered update. Only valid once `check()` reported `available`. */
  async function download() {
    if (state !== STATES.AVAILABLE && state !== STATES.ERROR) return snapshot();
    if (!enabled()) return snapshot();

    let updater;
    try {
      updater = getUpdater();
      if (!updater) throw new Error('electron-updater is unavailable');
      set({ state: STATES.DOWNLOADING, percent: 0, message: '' });
      await updater.downloadUpdate();
    } catch (err) {
      log('warn', 'downloadUpdate failed: ' + err.message);
      set({ state: STATES.ERROR, message: err.message });
    }
    return snapshot();
  }

  /**
   * Quit and install. Returns true only if the handoff was actually started, so
   * the caller knows whether it may keep running.
   */
  function install() {
    if (state !== STATES.DOWNLOADED) return false;
    if (!enabled()) return false;

    try {
      const updater = getUpdater();
      if (!updater) throw new Error('electron-updater is unavailable');
      // isSilent MUST be true. Our NSIS build is an assisted installer
      // (oneClick:false), so without /S the update pops an interactive wizard
      // after the user has already asked to restart - it downloads perfectly and
      // then sits there waiting for a click nobody is there to give.
      updater.quitAndInstall(true, true);
      return true;
    } catch (err) {
      log('error', 'quitAndInstall failed: ' + err.message);
      set({ state: STATES.ERROR, message: err.message });
      return false;
    }
  }

  return {
    STATES,
    check,
    download,
    install,
    snapshot,
    on: (event, fn) => bus.on(event, fn),
  };
}

module.exports = { createUpdateService, STATES, MIN_CHECK_INTERVAL_MS };
