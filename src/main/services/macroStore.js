'use strict';

/**
 * MacroStore - persistence for saved macros and small bits of app state.
 *
 * Layout under Electron's userData directory:
 *
 *   macros.json   { version, macros: { id: {...} }, order: [id, ...] }
 *   state.json    { chooser: {...}, settings: {...}, recordHotkey: '...' }
 *
 * Each macro stores BOTH the Blockly workspace state (so it can be re-edited)
 * and the compiled step list (so it can be executed, or called by "run another
 * macro", without re-parsing blocks every time).
 *
 * Writes are temp-file + rename so a crash mid-save cannot leave a half-written
 * file that stops the app from starting. Every read is defensive: a corrupt file
 * degrades to "no macros" plus a warning, never a crash.
 */

const fs = require('fs');
const path = require('path');
const C = require('../../shared/constants');

function createMacroStore(deps) {
  deps = deps || {};
  const log = deps.log || (() => {});
  const dir = deps.dir;

  const files = {
    macros: path.join(dir, 'macros.json'),
    state: path.join(dir, 'state.json'),
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log('error', 'could not create the data directory ' + dir + ': ' + err.message);
  }

  function readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      log('error', 'could not read ' + path.basename(file) + ': ' + err.message + ' (using defaults)');
      return fallback;
    }
  }

  function writeJson(file, value) {
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      log('error', 'could not write ' + path.basename(file) + ': ' + err.message);
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (e) {
        /* ignore */
      }
      return false;
    }
  }

  // ------------------------------------------------------------- macros

  const emptyDb = () => ({ version: C.MACRO_FORMAT_VERSION, macros: {}, order: [] });

  function normalizeShortcuts(value) {
    if (!value || typeof value !== 'object') return null;
    const keys = (items) => (Array.isArray(items) ? items : [])
      .filter((id) => typeof id === 'string' && /^key:[A-Za-z0-9:_-]+$/.test(id))
      .slice(0, 8);
    const arm = keys(value.arm);
    if (!arm.length) return null;
    return {
      mode: value.mode === 'separate' ? 'separate' : 'toggle',
      arm,
      disarm: keys(value.disarm),
    };
  }

  function normalize(raw) {
    const out = emptyDb();
    if (!raw || typeof raw !== 'object') return out;
    if (raw.version) out.version = raw.version;
    const macros = raw.macros && typeof raw.macros === 'object' ? raw.macros : {};
    Object.keys(macros).forEach((id) => {
      const m = macros[id];
      if (!m || typeof m !== 'object') return;
      out.macros[id] = {
        id: String(m.id || id),
        name: String(m.name || 'Untitled'),
        createdAt: m.createdAt || new Date().toISOString(),
        updatedAt: m.updatedAt || new Date().toISOString(),
        workspace: m.workspace || null,
        compiled: m.compiled || null,
        steps: Array.isArray(m.steps) ? m.steps : null,
        start: m.start || null,
        shortcuts: normalizeShortcuts(m.shortcuts),
      };
    });
    out.order = Array.isArray(raw.order) ? raw.order.filter((id) => out.macros[id]) : [];
    Object.keys(out.macros).forEach((id, i) => {
      if (out.order.indexOf(id) === -1) out.order.push(id);
      if (!out.macros[id].name) out.macros[id].name = 'Untitled ' + (i + 1);
    });
    return out;
  }

  let db = normalize(readJson(files.macros, emptyDb()));
  const persistMacros = () => writeJson(files.macros, db);

  function newId() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function names() {
    return db.order.map((id) => db.macros[id].name);
  }

  /** A name that is not already taken, e.g. "Macro 2". */
  function uniqueName(base) {
    const taken = new Set(names().map((n) => n.toLowerCase()));
    if (!taken.has(String(base).toLowerCase())) return base;
    let i = 2;
    while (taken.has((base + ' ' + i).toLowerCase())) i++;
    return base + ' ' + i;
  }

  function list() {
    return db.order.map((id) => {
      const m = db.macros[id];
      return {
        id: m.id,
        name: m.name,
        updatedAt: m.updatedAt,
        createdAt: m.createdAt,
        hasCompiled: Boolean(m.steps),
        stepCount: m.steps ? m.steps.length : 0,
      };
    });
  }

  function get(id) {
    return db.macros[id] || null;
  }

  function shortcutMacros() {
    return db.order.map((id) => db.macros[id]).filter((macro) =>
      macro && macro.shortcuts && Array.isArray(macro.steps)
    ).map((macro) => ({
      id: macro.id,
      name: macro.name,
      start: macro.start,
      steps: macro.steps,
      shortcuts: macro.shortcuts,
    }));
  }

  function getByName(name) {
    const lower = String(name || '').toLowerCase();
    const id = db.order.find((i) => db.macros[i].name.toLowerCase() === lower);
    return id ? db.macros[id] : null;
  }

  /**
   * Registry adapter for the engine's "run another macro" step.
   * Returns null (never throws) when the macro is missing, so the engine can
   * produce its own clear error message.
   */
  function getMacroSteps(name) {
    const macro = getByName(name);
    if (!macro || !Array.isArray(macro.steps)) return null;
    return { name: macro.name, steps: macro.steps };
  }

  function save(input) {
    const now = new Date().toISOString();
    const id = input.id && db.macros[input.id] ? input.id : newId();
    const existing = db.macros[id];
    const macro = {
      id,
      name: input.name || (existing ? existing.name : uniqueName('Untitled macro')),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      workspace: input.workspace === undefined ? (existing ? existing.workspace : null) : input.workspace,
      compiled: input.compiled === undefined ? (existing ? existing.compiled : null) : input.compiled,
      steps: input.steps === undefined ? (existing ? existing.steps : null) : input.steps,
      start: input.start === undefined ? (existing ? existing.start : null) : input.start,
      shortcuts: input.shortcuts === undefined
        ? (existing ? existing.shortcuts : null)
        : normalizeShortcuts(input.shortcuts),
    };
    db.macros[id] = macro;
    if (db.order.indexOf(id) === -1) db.order.push(id);
    persistMacros();
    log('info', 'saved macro "' + macro.name + '"', { id, steps: macro.steps ? macro.steps.length : 0 });
    return { ok: true, id, name: macro.name };
  }

  function remove(id) {
    if (!db.macros[id]) return { ok: false, reason: 'No such macro.' };
    const name = db.macros[id].name;
    delete db.macros[id];
    db.order = db.order.filter((x) => x !== id);
    persistMacros();
    return { ok: true, name };
  }

  function rename(id, newName) {
    const macro = db.macros[id];
    if (!macro) return { ok: false, reason: 'No such macro.' };
    const clean = String(newName || '').trim();
    if (!clean) return { ok: false, reason: 'A macro needs a name.' };
    const clash = db.order.find(
      (i) => i !== id && db.macros[i].name.toLowerCase() === clean.toLowerCase()
    );
    if (clash) return { ok: false, reason: 'Another macro is already called "' + clean + '".' };
    const oldName = macro.name;
    macro.name = clean;
    macro.updatedAt = new Date().toISOString();
    persistMacros();
    return { ok: true, id, oldName, name: clean };
  }

  function duplicate(id) {
    const macro = db.macros[id];
    if (!macro) return { ok: false, reason: 'No such macro.' };
    const copy = JSON.parse(JSON.stringify(macro));
    copy.id = newId();
    copy.name = uniqueName(macro.name + ' copy');
    copy.createdAt = new Date().toISOString();
    copy.updatedAt = copy.createdAt;
    db.macros[copy.id] = copy;
    db.order.push(copy.id);
    persistMacros();
    return { ok: true, id: copy.id, name: copy.name };
  }

  // -------------------------------------------------------------- state

  let state = readJson(files.state, { chooser: {}, settings: {}, recordHotkey: null });
  if (!state.chooser || typeof state.chooser !== 'object') state.chooser = {};
  if (!state.settings || typeof state.settings !== 'object') state.settings = {};

  const persistState = () => writeJson(files.state, state);
  const getSettings = () => Object.assign({}, state.settings);

  return {
    dir,
    files,
    list,
    names,
    get,
    shortcutMacros,
    getByName,
    getMacroSteps,
    save,
    remove,
    rename,
    duplicate,
    uniqueName,

    /** Small persistent key/value store. The engine's chooser cursor uses this. */
    store: {
      get(key, fallback) {
        return Object.prototype.hasOwnProperty.call(state.chooser, key) ? state.chooser[key] : fallback;
      },
      set(key, value) {
        state.chooser[key] = value;
        persistState();
      },
      all() {
        return Object.assign({}, state.chooser);
      },
    },

    getSettings,
    setSettings(patch) {
      state.settings = Object.assign({}, state.settings, patch);
      persistState();
      return getSettings();
    },

    getRecordHotkey() {
      return state.recordHotkey || null;
    },
    setRecordHotkey(buttonId) {
      state.recordHotkey = buttonId || null;
      persistState();
      return state.recordHotkey;
    },

    /** Diagnostic snapshot for the status / help panel. */
    info() {
      return { dir, macroCount: db.order.length, file: files.macros };
    },
  };
}

module.exports = { createMacroStore };
