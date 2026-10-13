'use strict';

/**
 * Preload for the eyedropper's floating chip only.
 *
 * Deliberately narrower than the main preload: the chip is a click-through
 * window that must never be able to do anything except receive two display
 * updates. It cannot read macros, run anything, or ask the main process to do
 * work - there is no invoke channel here at all, on purpose.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mbChip', {
  onPreview: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('mb:eyedropper:preview', wrapped);
  },
  onHint: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on('mb:eyedropper:hint', wrapped);
  },
});
