'use strict';

/**
 * Preload - the ONLY bridge between the renderer and Node/Electron.
 *
 * The renderer runs with contextIsolation on and nodeIntegration off, so this
 * file exposes a small, explicit, promise-based API instead of leaking ipcRenderer.
 * Nothing here executes a macro; it only forwards requests.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload || {});

/** Subscribe helpers return an unsubscribe function. */
function subscribe(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('mb', {
  // ---- bootstrap ---------------------------------------------------
  bootstrap: () => invoke('mb:bootstrap'),
  bootstrapButtons: () => invoke('mb:bootstrapButtons'),
  describeButton: (buttonId) => invoke('mb:describeButton', { buttonId }),

  // ---- macros ------------------------------------------------------
  macros: {
    list: () => invoke('mb:macros:list'),
    get: (id) => invoke('mb:macros:get', { id }),
    save: (payload) => invoke('mb:macros:save', payload),
    rename: (id, name) => invoke('mb:macros:rename', { id, name }),
    duplicate: (id) => invoke('mb:macros:duplicate', { id }),
    remove: (id) => invoke('mb:macros:delete', { id }),
    names: () => invoke('mb:macros:names'),
  },

  // ---- running -----------------------------------------------------
  run: {
    arm: (payload) => invoke('mb:run:arm', payload),  // payload.triggerId distinguishes sibling start blocks
    /** Pass a macroId to disarm just that macro; omit it to disarm everything. */
    disarm: (macroId) => invoke('mb:run:disarm', { macroId }),
    now: (payload) => invoke('mb:run:now', payload),
    selected: (steps) => invoke('mb:run:selected', { steps }),
    stop: () => invoke('mb:run:stop'),
    shortcuts: (payload) => invoke('mb:run:shortcuts', payload),
    status: () => invoke('mb:status'),
  },

  // ---- capture + pixels -------------------------------------------
  capture: {
    press: (timeoutMs) => invoke('mb:capture:press', { timeoutMs }),
    chord: (timeoutMs) => invoke('mb:capture:chord', { timeoutMs }),
    coordinate: (timeoutMs) => invoke('mb:capture:coordinate', { timeoutMs }),
  },
  pixel: {
    read: (x, y) => invoke('mb:pixel:read', { x, y }),
    diagnostics: () => invoke('mb:pixel:diagnostics'),
  },
  eyedropper: {
    /**
     * Hides the app, samples the colour under the cursor live, and resolves
     * with the picked colour. Ctrl+click or Ctrl+Enter commits, Escape cancels.
     * See src/main/services/eyedropper.js for why the click is not in the
     * sampling path.
     */
    start: () => invoke('mb:eyedropper:start'),
    cancel: () => invoke('mb:eyedropper:cancel'),
  },
  windows: {
    /** Currently open window titles, for the "wait until window" dropdown. */
    list: () => invoke('mb:window:list'),
  },

  // ---- updates ------------------------------------------------------
  /**
   * Updates are only ever offered. `download` spends the user's bandwidth and
   * `install` restarts the app, so both are explicit user actions - nothing here
   * happens automatically beyond a check that already ran at startup.
   */
  update: {
    check: (opts) => invoke('mb:update:check', opts),
    download: () => invoke('mb:update:download'),
    install: () => invoke('mb:update:install'),
    state: () => invoke('mb:update:state'),
  },

  // ---- settings ---------------------------------------------------------
  /**
   * Small persisted preferences (currently the record mode). Writes MERGE, so
   * setting one key cannot erase another.
   */
  settings: {
    get: () => invoke('mb:settings:get'),
    set: (patch) => invoke('mb:settings:set', { patch }),
  },

  // ---- record mode -------------------------------------------------
  record: {
    start: () => invoke('mb:record:start'),
    stop: () => invoke('mb:record:stop'),
    setHotkey: (buttonId) => invoke('mb:record:hotkey', { buttonId }),
    getHotkey: () => invoke('mb:record:hotkey:get'),
  },

  // ---- diagnostics / window ---------------------------------------
  diagnostics: () => invoke('mb:diagnostics'),
  minimize: () => invoke('mb:window:minimize'),
  openLogFolder: () => invoke('mb:shell:openLogFolder'),
  log: (level, message, meta) => ipcRenderer.send('mb:log', { level, message, meta }),

  // ---- pushed events ----------------------------------------------
  onStatus: (handler) => subscribe('mb:status', handler),
  onLog: (handler) => subscribe('mb:log', handler),
  onError: (handler) => subscribe('mb:error', handler),
  onRecordEvent: (handler) => subscribe('mb:record:event', handler),
  onUpdateState: (handler) => subscribe('mb:update:state', handler),
});

