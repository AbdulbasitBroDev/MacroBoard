/**
 * MacroBlock - renderer bootstrap and UI wiring.
 *
 * Responsibilities:
 *   - inject Blockly with the dark theme + custom toolbox
 *   - keep the "a start block must always exist" invariant
 *   - live-compile on every change and show the result in the top bar
 *   - drive Run/Arm/Stop, Record, and the macro sidebar
 */
(function () {
  'use strict';
  const MB = window.MB;
  const Blockly = window.Blockly;
  const api = window.mb;
  const modals = MB.modals;

  /**
   * Seconds between clicking Record and recording actually starting.
   *
   * Not cosmetic: recording captures input globally, so without a delay the arming
   * click and every click spent alt-tabbing to the target window would end up in
   * the macro.
   */
  const RECORD_DELAY_SECONDS = 2;

  const dom = {
    workspace: document.getElementById('workspace'),
    statusPill: document.getElementById('status-pill'),
    statusText: document.getElementById('status-text'),
    startDesc: document.getElementById('start-desc'),
    compileBadge: document.getElementById('compile-badge'),
    compileText: document.getElementById('compile-text'),
    btnRun: document.getElementById('btn-run'),
    btnStop: document.getElementById('btn-stop'),
    btnRecord: document.getElementById('btn-record'),
    recMenu: document.getElementById('rec-menu'),
    btnRecordStop: document.getElementById('btn-record-stop'),
    recordBanner: document.getElementById('record-banner'),
    recordHotkeyHint: document.getElementById('record-hotkey-hint'),
    macroList: document.getElementById('macro-list'),
    logPanel: document.getElementById('log-panel'),
    degradations: document.getElementById('degradations'),
    btnNew: document.getElementById('btn-new'),
    btnSave: document.getElementById('btn-save'),
    btnShortcuts: document.getElementById('btn-shortcuts'),
    btnRename: document.getElementById('btn-rename'),
    btnDuplicate: document.getElementById('btn-duplicate'),
    btnDelete: document.getElementById('btn-delete'),
    btnOpenLogs: document.getElementById('btn-open-logs'),
    btnPauseLog: document.getElementById('btn-pause-log'),
    btnCheckUpdates: document.getElementById('btn-check-updates'),
  };

  const state = {
    boot: null,
    workspace: null,
    compiler: null,
    macros: [],
    activeId: null,
    activeName: null,
    shortcuts: null,
    dirty: false,
    lastCompile: null,
    armedStart: null,
    status: null,
    logPaused: false,
    logBuffer: [],
    recordCountdown: null,
    lastTouchedStartId: null,
    autoSaveTimer: null,
  };

  function log(level, message, meta) {
    api.log(level || 'info', message, meta);
    pushLog(level, message);
  }

  /**
   * Append one line to the activity log.
   *
   * A fast macro can emit hundreds of lines a second, and every one of them was
   * building a DOM node and forcing a scroll - which is exactly when the UI can
   * least afford it. While paused nothing touches the DOM; entries are buffered
   * and flushed on resume, so pausing costs nothing and loses nothing.
   */
  function renderLogLine(level, message) {
    const line = document.createElement('div');
    line.className = 'log-line ' + (level || 'info');
    const t = new Date();
    line.textContent =
      String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' +
      String(t.getSeconds()).padStart(2, '0') + '  ' + message;
    dom.logPanel.appendChild(line);
  }

  function trimLogPanel() {
    while (dom.logPanel.childElementCount > 300) dom.logPanel.removeChild(dom.logPanel.firstChild);
    dom.logPanel.scrollTop = dom.logPanel.scrollHeight;
  }

  function pushLog(level, message) {
    if (state.logPaused) {
      state.logBuffer.push({ level: level, message: message });
      return;
    }
    renderLogLine(level, message);
    trimLogPanel();
  }

  function setLogPaused(paused) {
    state.logPaused = paused;
    dom.btnPauseLog.classList.toggle('active', paused);
    dom.btnPauseLog.textContent = paused ? '>' : 'II';
    dom.btnPauseLog.title = paused
      ? 'Resume the activity log (' + state.logBuffer.length + ' entry/entries waiting)'
      : 'Pause the activity log (entries are still captured while paused)';

    if (paused) {
      modals.toast('Activity log paused. Nothing is being lost - click ' + String.fromCharCode(9654) + ' to resume.', 'ok');
      return;
    }
    const pending = state.logBuffer.splice(0, state.logBuffer.length);
    pending.forEach((entry) => renderLogLine(entry.level, entry.message));
    trimLogPanel();
    if (pending.length) {
      modals.toast('Activity log resumed - ' + pending.length + ' new line' + (pending.length === 1 ? '' : 's') + '.', 'ok');
    }
  }

  // --------------------------------------------------------- start-block invariant

  /**
   * A macro must always have a start block, one of which is armed. If the user
   * deletes every hat (or it was never there), a default "when Run is pressed"
   * is recreated so the workspace is never in an unusable state.
   */
  function ensureStartBlock() {
    const starts = state.compiler.findStartBlocks(state.workspace);
    if (starts.length > 0) return starts;
    try {
      const block = state.workspace.newBlock(MB.catalog.START.RUN);
      block.initSvg();
      block.render();
      block.moveBy(60, 60);
      log('info', 'no start block was present, so a default "when Run is pressed" block was added back');
      modals.toast('A default start block was added back - a macro always needs one.', 'warn');
    } catch (err) {
      log('error', 'could not recreate the default start block: ' + err.message);
    }
    return state.compiler.findStartBlocks(state.workspace);
  }

  // ------------------------------------------------------------- compilation

  /** Compile the workspace + update the badge, Run label and start description. */
  /**
 * The start block recording should attach to: the one the user touched most
 * recently.
 *
 * A workspace can hold several start blocks, and "top-most" is a poor guess once
 * there is more than one - it has nothing to do with which macro you are working
 * on. So every workspace change is walked back up to its owning start block and
 * that one is remembered. Editing or dropping a block into macro Y's body makes Y
 * the target, exactly as you would expect.
 *
 * Falls back to the top-most hat, which is the right answer whenever there is
 * only one.
 */
function recordTargetStart() {
  const all = state.compiler.findStartBlocks(state.workspace);
  if (!all.length) return null;
  if (all.length === 1) return all[0];
  const touched = all.find((b) => String(b.id) === state.lastTouchedStartId);
  return touched || all[0];
}

/** Walk up from a changed block to the start block whose body contains it. */
function noteTouchedStart(event) {
  const id = event && (event.blockId || (event.targetBlockId));
  if (!id) return;
  let block;
  try {
    block = state.workspace.getBlockById(id);
  } catch (err) {
    return;
  }
  if (!block) return;
  // A start block that was itself created/deleted counts as touched.
  if (state.compiler.isStartType && state.compiler.isStartType(block.type)) {
    state.lastTouchedStartId = String(block.id);
    return;
  }
  let node = block;
  while (node) {
    const parent = node.getParent && node.getParent();
    if (parent && state.compiler.isStartType && state.compiler.isStartType(parent.type)) {
      state.lastTouchedStartId = String(parent.id);
      return;
    }
    node = parent;
  }
}

function recompile(opts) {
    opts = opts || {};
    ensureStartBlock();
    const result = state.compiler.compileWorkspace(state.workspace);
    state.lastCompile = result;
    state.armedStart = result.start;

    if (!activeIsArmed()) dom.btnRun.textContent = state.compiler.runButtonLabel(result.start);
    dom.btnRun.title =
      result.start && result.start.kind !== MB.constants.START.MANUAL
        ? 'Arm this trigger (' + state.compiler.describeStart(result.start) + ')'
        : 'Run the macro';
    dom.startDesc.textContent = result.start ? state.compiler.describeStart(result.start) : 'no start block';

    if (!result.ok) {
      dom.compileBadge.dataset.kind = 'error';
      dom.compileText.textContent = result.errors[0];
      dom.compileBadge.title = result.errors.join('\n');
    } else if (result.warnings.length) {
      dom.compileBadge.dataset.kind = 'warn';
      dom.compileText.textContent = result.warnings[0];
      dom.compileBadge.title =
        result.warnings.join('\n') + '\n\n' + result.steps.length + ' step(s) compiled.';
    } else {
      dom.compileBadge.dataset.kind = 'ok';
      dom.compileText.textContent = result.steps.length + ' step' + (result.steps.length === 1 ? '' : 's');
      dom.compileBadge.title = 'Compiled cleanly.';
    }

    if (!opts.silent) {
      state.dirty = true;
      scheduleAutoSave();
    }
    return result;
  }

  function scheduleAutoSave() {
    if (state.autoSaveTimer) clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(() => {
      state.autoSaveTimer = null;
      if (state.dirty && state.activeId) saveMacro({ quiet: true });
    }, 2500);
  }

  // ---------------------------------------------------------------- macros

  function renderMacroList() {
    dom.macroList.innerHTML = '';
    if (!state.macros.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No saved macros yet — press Save.';
      dom.macroList.appendChild(li);
      return;
    }
    const armedIds = (state.status && state.status.armedIds) || [];
    state.macros.forEach((m) => {
      const li = document.createElement('li');
      if (m.id === state.activeId) li.classList.add('active');
      if (macroArmedIn(armedIds, m.id)) {
        li.classList.add('armed');
        li.title = 'Armed — this macro listens for its trigger right now';
      }
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = m.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = m.hasCompiled ? m.stepCount + ' steps' : 'unsaved';
      li.appendChild(name);
      li.appendChild(meta);
      li.addEventListener('click', () => openMacro(m.id));
      dom.macroList.appendChild(li);
    });
  }

  async function refreshMacroList(macros) {
    if (macros) state.macros = macros;
    else {
      const res = await api.macros.list();
      state.macros = (res && res.macros) || [];
    }
    renderMacroList();
  }

  async function saveMacro(opts) {
    opts = opts || {};
    const result = recompile({ silent: true });
    const payload = {
      id: state.activeId || undefined,
      name: state.activeName || undefined,
      workspace: Blockly.serialization.workspaces.save(state.workspace),
      compiled: { steps: result.steps, start: result.start, warnings: result.warnings },
      // Stored separately from the workspace so "run another macro" can execute
      // this macro without re-parsing any blocks.
      steps: result.steps,
      start: result.start,
      shortcuts: state.shortcuts,
    };
    const res = await api.macros.save(payload);
    if (!res || !res.ok) {
      modals.toast('Save failed: ' + ((res && res.reason) || 'unknown error'), 'error');
      return;
    }
    state.activeId = res.id;
    state.activeName = res.name;
    state.dirty = false;
    await refreshMacroList(res.macros);
    if (!opts.quiet) modals.toast('Saved "' + res.name + '"', 'ok', 2200);
    log('info', 'saved macro "' + res.name + '"');
  }

  async function openMacro(id) {
    if (state.dirty) await saveMacro({ quiet: true });
    await api.run.shortcuts({ macroId: '__unsaved__', shortcuts: null });
    const res = await api.macros.get(id);
    if (!res || !res.ok || !res.macro) {
      modals.toast('Could not open that macro.', 'error');
      return;
    }
    state.activeId = res.macro.id;
    state.activeName = res.macro.name;
    state.shortcuts = res.macro.shortcuts || null;
    state.dirty = false;

    state.workspace.clear();
    if (res.macro.workspace) {
      try {
        Blockly.serialization.workspaces.load(res.macro.workspace, state.workspace);
      } catch (err) {
        modals.toast('That macro could not be loaded: ' + err.message, 'error');
      }
    }
    Blockly.svgResize(state.workspace);
    recompile({ silent: true });
    renderMacroList();
    log('info', 'opened macro "' + state.activeName + '"');
  }

  async function newMacro() {
    if (state.dirty) await saveMacro({ quiet: true });
    const shortcuts = await modals.shortcutSettings({ title: 'Set up macro shortcuts' });
    if (!shortcuts) return;
    state.activeId = null;
    state.activeName = null;
    state.shortcuts = shortcuts;
    state.workspace.clear();
    Blockly.serialization.workspaces.load(MB.catalog.defaultWorkspaceState(), state.workspace);
    Blockly.svgResize(state.workspace);
    recompile({ silent: true });
    await api.run.shortcuts({
      shortcuts: state.shortcuts,
      start: state.lastCompile.start,
      steps: state.lastCompile.steps,
      macroName: 'unsaved macro',
      macroId: '__unsaved__',
    });
    renderMacroList();
    modals.toast('New macro created — remember to Save it.', 'ok', 2600);
  }

  async function editShortcuts() {
    const shortcuts = await modals.shortcutSettings({
      title: 'Edit macro shortcuts',
      value: state.shortcuts,
    });
    if (!shortcuts) return;
    state.shortcuts = shortcuts;
    state.dirty = true;
    const result = recompile({ silent: true });
    if (state.activeId) await saveMacro({ quiet: true });
    else {
      await api.run.shortcuts({
        shortcuts,
        start: result.start,
        steps: result.steps,
        macroName: 'unsaved macro',
        macroId: '__unsaved__',
      });
      scheduleAutoSave();
    }
    modals.toast('Macro shortcuts updated.', 'ok', 2200);
  }

  async function renameMacro() {
    if (!state.activeId) {
      modals.toast('Save the macro before renaming it.', 'warn');
      return;
    }
    const name = await modals.prompt({
      title: 'Rename macro',
      subtitle: 'The "run another macro" dropdown picks this up straight away.',
      value: state.activeName,
      note:
        'Any other macro that called this one by name will warn that the old name is missing, and the ' +
        'engine reports it clearly at run time.',
    });
    if (!name) return;
    const res = await api.macros.rename(state.activeId, name);
    if (!res || !res.ok) {
      modals.toast((res && res.reason) || 'Rename failed.', 'error');
      return;
    }
    state.activeName = res.name;
    await refreshMacroList(res.macros);
  }

  async function duplicateMacro() {
    if (!state.activeId) {
      modals.toast('Save the macro before duplicating it.', 'warn');
      return;
    }
    const res = await api.macros.duplicate(state.activeId);
    if (!res || !res.ok) {
      modals.toast((res && res.reason) || 'Duplicate failed.', 'error');
      return;
    }
    await refreshMacroList(res.macros);
    await openMacro(res.id);
    modals.toast('Duplicated as "' + res.name + '"', 'ok');
  }

  async function deleteMacro() {
    if (!state.activeId) {
      modals.toast('Nothing to delete.', 'warn');
      return;
    }
    const ok = await modals.confirm({
      title: 'Delete "' + state.activeName + '"?',
      subtitle: 'This removes the macro from disk.',
      okLabel: 'Delete',
      note: 'This cannot be undone. The blocks on screen stay until you switch macros.',
    });
    if (!ok) return;
    const res = await api.macros.remove(state.activeId);
    if (!res || !res.ok) {
      modals.toast((res && res.reason) || 'Delete failed.', 'error');
      return;
    }
    state.activeId = null;
    state.activeName = null;
    await refreshMacroList(res.macros);
    modals.toast('Deleted "' + res.name + '"', 'ok');
  }

  // ------------------------------------------------------- run / arm / stop

  /** The id the main process knows this editor buffer by. */
  function activeKey() {
    return state.activeId || '__unsaved__';
  }

  /**
   * Is a macro armed, given the status's armedIds?
   *
   * A macro with several start blocks is armed under one key PER TRIGGER
   * ("m1#tA", "m1#tB") and never under the bare macro id. An exact match
   * therefore never found it - which made the sidebar badge vanish and the
   * Run/Arm button arm again instead of disarming, forever.
   */
  function macroArmedIn(armedIds, macroId) {
    const base = String(macroId);
    return armedIds.some((id) => id === base || String(id).indexOf(base + '#') === 0);
  }

  /** Is THIS macro armed? Arming is per macro, so other macros can be armed too. */
  function activeIsArmed() {
    const status = state.status;
    if (!status) return false;
    return macroArmedIn(status.armedIds || [], activeKey());
  }

  async function onRunClicked() {
    const result = recompile({ silent: true });
    if (!result.ok) {
      modals.toast(result.errors.join('\n'), 'error');
      return;
    }
    const start = result.start;
    const triggers = (result.triggers && result.triggers.length ? result.triggers : [{ start, steps: result.steps }]);

    // Every start block in the workspace is armed, not just the top-most one. A
    // MANUAL hat has nothing to listen for, so it is skipped here and handled by
    // the plain Run path below.
    const armable = triggers.filter((t) => t.start && t.start.kind !== MB.constants.START.MANUAL);

    if (armable.length) {
      // Trigger modes replace the Run button with an Arm button. Only this
      // macro is toggled - other macros stay armed.
      if (activeIsArmed()) {
        await api.run.disarm(activeKey());
        modals.toast('Disarmed.', 'ok', 1800);
        return;
      }
      const armed = [];
      for (const t of armable) {
        const res = await api.run.arm({
          start: t.start,
          steps: t.steps,
          macroName: state.activeName || 'unsaved macro',
          macroId: activeKey(),
          triggerId: t.id,
        });
        if (res && res.ok === false) {
          modals.toast((res && res.reason) || 'Could not arm a trigger.', 'error');
          return;
        }
        armed.push(t);
      }
      const extra = armable.length > 1 ? ' (' + armable.length + ' triggers armed)' : '';
      const poll = armed.find((t) => t.start.pollMs);
      const pollNote = poll ? ' (polling every ' + poll.start.pollMs + 'ms)' : '';
      modals.toast(
        'Armed: ' + armed.map((t) => state.compiler.describeStart(t.start)).join(' + ') + extra + pollNote,
        'ok',
        3200
      );
      return;
    }

    const res = await api.run.now({ steps: result.steps, macroName: state.activeName || 'unsaved macro' });
    if (res && res.ok === false && res.error) modals.toast(res.error.message, 'error');
  }

  async function onStopClicked() {
    await api.run.stop();
    if (MB.recorder.isActive()) await MB.recorder.stop();
    modals.toast('Stopped.', 'ok', 1400);
  }

  /** Used by the marquee context menu: run just the selected blocks. */
  async function runSelection(blocks) {
    const result = state.compiler.compileSelection(state.workspace, { blocks });
    if (!result.ok) {
      modals.toast(result.errors.join('\n'), 'error');
      return;
    }
    result.warnings.forEach((w) => log('warn', w));
    const res = await api.run.selected(result.steps);
    if (res && res.ok === false && res.error) modals.toast(res.error.message, 'error');
    else modals.toast('Ran ' + result.steps.length + ' step(s) from the selection.', 'ok', 2200);
  }

  // ----------------------------------------------------------- record mode

  /** Locate the chain tail of the armed start block's DO input. */
  function chainTail() {
    const start = recordTargetStart();
    if (!start) return null;
    let b = start.getInputTargetBlock('DO');
    if (!b) return null;
    while (b.getNextBlock()) b = b.getNextBlock();
    return b;
  }

  function attachToStart(block) {
    const start = recordTargetStart();
    if (!start) return;
    start.getInput('DO').connection.connect(block.previousConnection);
  }

  // ------------------------------------------------------- record mode menu

  /**
   * Hovering the Record button reveals how keys will be recorded. Clicking an
   * option sets the mode AND persists it, so pressing Record later needs no
   * further ceremony.
   *
   * The menu opens on hover only (plus Escape / outside-click to dismiss), so the
   * button's own click keeps starting and stopping recording - the two gestures
   * must not fight over the same event.
   */
  function setRecordMenuOpen(open) {
    dom.recMenu.classList.toggle('hidden', !open);
  }

  function renderRecordMode() {
    const current = MB.recorder.getMode();
    Array.prototype.forEach.call(dom.recMenu.querySelectorAll('[data-rec-mode]'), (b) => {
      const on = b.getAttribute('data-rec-mode') === current;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.querySelector('.rec-check').textContent = on ? '✓' : '';
    });
    dom.btnRecord.title =
      'Record real input into blocks (keys recorded as ' + (current === MB.recorder.MODE_KEYBIND ? 'separate presses' : 'text') + ')';
  }

  async function setRecordMode(next) {
    MB.recorder.setMode(next);
    renderRecordMode();
    setRecordMenuOpen(false);
    // Persisted so the choice survives a restart. A failure here must not stop the
    // user recording, so it is logged rather than surfaced.
    try {
      await api.settings.set({ recordMode: MB.recorder.getMode() });
    } catch (err) {
      MB.log('warn', 'could not save the record mode: ' + (err && err.message));
    }
  }

  function wireRecordMenu() {
    const wrap = dom.btnRecord.parentElement;
    let hideTimer = null;

    const openSoon = () => {
      if (hideTimer) clearTimeout(hideTimer);
      setRecordMenuOpen(true);
    };
    // A small delay so sweeping the pointer across the toolbar does not flicker
    // every menu open on the way to somewhere else.
    const closeSoon = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setRecordMenuOpen(false), 180);
    };

    wrap.addEventListener('mouseenter', openSoon);
    wrap.addEventListener('mouseleave', closeSoon);
    dom.recMenu.addEventListener('mouseenter', openSoon);
    dom.recMenu.addEventListener('mouseleave', closeSoon);

    dom.recMenu.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-rec-mode]');
      if (btn) setRecordMode(btn.getAttribute('data-rec-mode'));
    });

    // Escape and outside clicks dismiss, so the menu can never be left stranded
    // over the workspace.
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') setRecordMenuOpen(false);
    });
    document.addEventListener('click', (ev) => {
      if (!dom.recMenu.classList.contains('hidden') && !wrap.contains(ev.target)) {
        setRecordMenuOpen(false);
      }
    });
  }

  /** Load the remembered record mode before the user can press Record. */
  async function loadRecordMode() {
    try {
      const res = await api.settings.get();
      const saved = res && res.settings ? res.settings.recordMode : null;
      if (saved) MB.recorder.setMode(saved);
    } catch (err) {
      MB.log('warn', 'could not read settings: ' + (err && err.message));
    }
    renderRecordMode();
  }

  /**
   * Count down RECORD_DELAY_SECONDS before recording actually starts.
   *
   * Returns false if the user cancelled by clicking Record again. Cancellation
   * matters: a fixed wait with no way out strands anyone who clicked Record by
   * accident.
   */
  async function countdownToRecord() {
    if (!state.recordCountdown) {
      state.recordCountdown = { cancelled: false, seconds: RECORD_DELAY_SECONDS };
    }
    const job = state.recordCountdown;
    job.cancelled = false;
    job.seconds = RECORD_DELAY_SECONDS;
    modals.toast('Recording starts in ' + RECORD_DELAY_SECONDS + 's - switch to the window you want. Click Record again to cancel.', 'ok', RECORD_DELAY_SECONDS * 1000 + 400);
    while (job.seconds > 0 && !job.cancelled) {
      await new Promise((r) => setTimeout(r, 1000));
      job.seconds -= 1;
    }
    if (job.cancelled) {
      state.recordCountdown = null;
      modals.toast('Recording cancelled.', 'warn', 2200);
      return false;
    }
    state.recordCountdown = null;
    return true;
  }

  async function toggleRecording() {
    // A click during the countdown means "cancel", not "start".
    if (state.recordCountdown && !MB.recorder.isActive()) {
      state.recordCountdown.cancelled = true;
      return;
    }
    if (MB.recorder.isActive()) {
      await MB.recorder.stop();
      return;
    }
    const result = recompile({ silent: true });
    if (!result.ok) {
      modals.toast(result.errors.join('\n'), 'error');
      return;
    }
    if (!recordTargetStart()) {
      modals.toast('Add a start block before recording.', 'error');
      return;
    }

    // Recording captures input globally, so the click that arms it would be
    // recorded too - and so would every click spent switching to the window you
    // want recorded. Waiting gives you time to alt-tab first. Clicking Record
    // again during the countdown cancels it.
    if (!(await countdownToRecord())) return;

    const started = await MB.recorder.start({
      mode: MB.recorder.getMode(),
      workspace: state.workspace,
      getChainTail: chainTail,
      attachToStart,
      onChange: () => {
        state.dirty = true;
        scheduleAutoSave();
      },
    });
    if (started) {
      modals.toast(
        'Recording. Click, type and move for real — everything is captured globally. ' +
          'Stop with the toolbar button' +
          (state.status && state.status.recordHotkey
            ? ' or ' + state.status.recordHotkey.replace(/^(key|mouse):/, '')
            : '') +
          '.',
        'ok',
        5200
      );
    }
  }

  async function setRecordHotkey() {
    modals.toast('Press the key or mouse button you want to use to start/stop recording…', 'ok', 3200);
    try {
      const res = await api.capture.press(15000);
      const saved = await api.record.setHotkey(res.buttonId);
      updateRecordHotkeyHint(saved && saved.button);
      modals.toast('Record hotkey set to ' + res.label, 'ok');
    } catch (err) {
      modals.toast('Could not capture that input: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  function updateRecordHotkeyHint(buttonId) {
    const id = buttonId !== undefined ? buttonId : state.status && state.status.recordHotkey;
    dom.recordHotkeyHint.textContent = id ? 'Stop hotkey: ' + String(id).replace(/^(key|mouse):/, '') : '';
  }

  // ------------------------------------------------------------------ status

  function applyStatus(status) {
    if (!status) return;
    state.status = status;

    const armedCount = status.armedCount || 0;
    const armedHere = activeIsArmed();
    const armedNames = (status.armedMacros || [])
      .filter((m) => m.id !== activeKey())
      .map((m) => m.name);

    let mode = 'idle';
    let text = 'Idle';
    if (status.recording) {
      mode = 'recording';
      text = 'Recording';
    } else if (status.running) {
      mode = 'running';
      text = 'Running';
    } else if (armedCount) {
      mode = 'armed';
      const mine = armedHere && status.start ? state.compiler.describeStart(status.start) : null;
      const parts = [];
      if (mine) parts.push('Armed — ' + mine);
      if (armedNames.length) parts.push(armedNames.length + ' other macro armed');
      text = parts.length > 1 ? parts[0] + ' (+' + armedNames.length + ' more)' : parts[0] || 'Armed';
    } else if (status.degradations && (status.degradations.input || status.degradations.hook)) {
      mode = 'error';
      text = 'Limited functionality';
    }
    dom.statusPill.title = armedCount > 1 ? 'Also armed: ' + armedNames.join(', ') : '';

    dom.statusPill.dataset.state = mode;
    dom.statusText.textContent = text;
    dom.btnRecord.classList.toggle('btn-primary', Boolean(status.recording));
    dom.btnRecord.querySelector('.rec-dot').style.background = status.recording ? '#fff' : '';
    dom.recordBanner.classList.toggle('hidden', !status.recording);
    // "Disarm" only when THIS macro is armed; otherwise keep its own Arm label.
    dom.btnRun.textContent = armedHere
      ? 'Disarm'
      : state.compiler.runButtonLabel(state.lastCompile ? state.lastCompile.start : null);
    updateRecordHotkeyHint();
    renderMacroList();
  }

  function showDegradations(degradations) {
    if (!degradations) return;
    const items = Object.keys(degradations)
      .filter((k) => degradations[k])
      .map((k) => '<p><strong>' + k.toUpperCase() + '</strong>: ' + escapeHtml(degradations[k]) + '</p>');
    if (!items.length) {
      dom.degradations.classList.add('hidden');
      return;
    }
    dom.degradations.innerHTML = items.join('');
    dom.degradations.classList.remove('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function refreshStatus() {
    const res = await api.run.status();
    if (res && res.ok) applyStatus(res.status);
  }

  // --------------------------------------------------------- diagnostics

  async function showDiagnostics() {
    const [diag, pix] = await Promise.all([api.diagnostics(), api.pixel.diagnostics()]);
    const armed = (state.status && state.status.armedMacros) || [];
    // The MEASURED pixel interval, per armed macro. This is the number that
    // settles "why is my 50ms poll slow": a screen capture costs real time, so
    // the real interval is the requested one plus a capture.
    const pixelLines = armed
      .filter((a) => a.pixel)
      .map((a) => {
        const p = a.pixel;
        return (
          '  ' + a.name + '\n' +
          '    requested every  ' + p.requestedPollMs + 'ms\n' +
          '    measured every   ' + (p.realIntervalMs || 0) + 'ms\n' +
          '    avg capture      ' + p.avgCaptureMs + 'ms  (' + p.ticks + ' samples)'
        );
      });
    const body = [
      'MacroBlock',
      '  electron      ' + (state.boot.app.electron || '?'),
      '  node          ' + (state.boot.app.node || '?'),
      '  data dir      ' + (state.boot.store.dir || '?'),
      '',
      'Input simulation (nut-js)',
      JSON.stringify(diag && diag.diagnostics ? diag.diagnostics.input : {}, null, 2),
      '',
      'Pixel reader',
      JSON.stringify(pix && pix.diagnostics ? pix.diagnostics : {}, null, 2),
      '',
      'Armed pixel watches',
      pixelLines.length ? pixelLines.join('\n') : '  (none)',
      '',
      'Press window: ' + (state.status ? state.status.pressWindowMs : '?') + 'ms',
      'Global stop key: ' + MB.constants.GLOBAL_STOP_KEY,
      'Min gap between actions: ' + MB.constants.LIMITS.MIN_ACTION_GAP_MS + 'ms',
    ].join('\n');
    modals.info({ title: 'Diagnostics', subtitle: 'Copy this into a bug report.', body });
  }

  // ---------------------------------------------------------------- boot

  function buildWorkspace(theme, toolbox) {
    return Blockly.inject(dom.workspace, {
      theme,
      toolbox,
      // Blockly defaults this to https://static.blockly.com/media/, which both
      // breaks offline and trips our Content-Security-Policy. The package ships
      // its own media folder, so point the renderer at that.
      media: '../../node_modules/blockly/media/',
      renderer: 'zelos',
      trashcan: true,
      zoom: {
        controls: true,
        wheel: true,
        startScale: 0.9,
        maxScale: 2.4,
        minScale: 0.35,
        scaleSpeed: 1.12,
      },
      grid: { spacing: 26, length: 3, colour: '#1a1f2e', snap: false },
      move: { scrollbars: true, drag: true, wheel: true },
      scrollbars: true,
      sounds: false,
      readOnly: false,
    });
  }

  function wireUi() {
    dom.btnRun.addEventListener('click', onRunClicked);
    dom.btnStop.addEventListener('click', onStopClicked);
    dom.btnRecord.addEventListener('click', toggleRecording);
    wireRecordMenu();
    dom.btnRecord.addEventListener('dblclick', setRecordHotkey);
    dom.btnRecordStop.addEventListener('click', () => MB.recorder.stop());
    dom.btnNew.addEventListener('click', newMacro);
    dom.btnSave.addEventListener('click', () => saveMacro({}));
    dom.btnShortcuts.addEventListener('click', editShortcuts);
    dom.btnRename.addEventListener('click', renameMacro);
    dom.btnDuplicate.addEventListener('click', duplicateMacro);
    dom.btnDelete.addEventListener('click', deleteMacro);
    dom.btnOpenLogs.addEventListener('click', () => api.openLogFolder());
    dom.btnPauseLog.addEventListener('click', () => setLogPaused(!state.logPaused));
    // Manual check is forced so the 60s cooldown cannot make the button feel dead.
    dom.btnCheckUpdates.addEventListener('click', () => MB.updates.checkNow());
    dom.statusPill.addEventListener('click', showDiagnostics);

    dom.compileBadge.addEventListener('click', () => {
      const r = state.lastCompile;
      if (!r) return;
      modals.info({
        title: r.ok ? 'Compiled step list' : 'Compile errors',
        subtitle: r.ok
          ? r.steps.length + ' step(s) compiled' + (r.warnings.length ? ' with warnings' : '') + '.'
          : 'Fix these before running.',
        body: JSON.stringify({ errors: r.errors, warnings: r.warnings, start: r.start, steps: r.steps }, null, 2),
      });
    });

    window.addEventListener('keydown', (e) => {
      if (!document.getElementById('modal-root').classList.contains('hidden')) return;
      if (e.key === 'F8') {
        e.preventDefault();
        onStopClicked();
        return;
      }
      if (e.key === 'Escape' && MB.recorder.isActive()) {
        MB.recorder.stop();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveMacro({});
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        onRunClicked();
      }
    });

    window.addEventListener('resize', () => {
      if (state.workspace) Blockly.svgResize(state.workspace);
    });
  }

  async function boot() {
    const boot = await api.bootstrap();
    if (!boot || !boot.ok) {
      dom.statusText.textContent = 'Failed to start';
      modals.toast('MacroBlock could not start: ' + ((boot && boot.reason) || 'unknown error'), 'error', 60000);
      return;
    }
    state.boot = boot;
    MB.constants = Object.assign({}, MB.constants, boot.constants);

    // Before Record can be pressed, so the first recording already uses the
    // remembered mode instead of silently falling back to the default.
    await loadRecordMode();

    const buttonData = await api.bootstrapButtons();
    if (buttonData && buttonData.ok) {
      MB.grids = {
        keyboardGrid: buttonData.keyboardGrid,
        numpadGrid: buttonData.numpadGrid,
        mouseButtons: buttonData.mouseButtons,
      };
      MB.buttonTable = buttonData.buttonTable || {};
    }

    // The renderer needs a SYNCHRONOUS way to validate/describe buttons because
    // the compiler runs on every workspace change.
    const rendererCatalog = MB.buttons.createRemoteCatalog(MB.buttonTable || {});
    MB.rendererCatalog = rendererCatalog;

    const fieldClasses = MB.fields.register(Blockly);
    MB.blocks.register(Blockly, {
      catalog: MB.catalog,
      constants: MB.constants,
      fieldClasses,
      describeButton: rendererCatalog.describe,
      getMacroNames: () => state.macros.map((m) => m.name),
    });
    MB.actions.install(rendererCatalog.describe);

    state.compiler = MB.compiler.createCompiler({
      Blockly,
      constants: MB.constants,
      catalog: MB.catalog,
      buttons: rendererCatalog,
      expressions: MB.expressions,
      getMacroNames: () => state.macros.map((m) => m.name),
    });

    state.workspace = buildWorkspace(MB.theme.defineTheme(), MB.theme.defineToolbox());

    MB.marquee.install(state.workspace, { onChanged: () => recompile({}) });

    // Live compile on every structural change.
    state.workspace.addChangeListener((event) => {
      if (event.isUiEvent) return;
      if (event.type === Blockly.Events.VIEWPORT_CHANGE) return;
      if (event.type === Blockly.Events.SELECTED) return;
      if (MB.marquee.isMenuOpen()) return;
      noteTouchedStart(event);
      recompile({});
    });

    showDegradations(boot.degradations);
    wireUi();
    applyStatus(boot.status);
    await refreshMacroList();

    if (state.macros.length) {
      await openMacro(state.macros[0].id);
    } else {
      Blockly.serialization.workspaces.load(MB.catalog.defaultWorkspaceState(), state.workspace);
      recompile({ silent: true });
    }
    Blockly.svgResize(state.workspace);

    api.onStatus(applyStatus);
    api.onLog((entry) => pushLog(entry.level, entry.message));
    api.onError((err) => modals.toast(err.message, 'error'));

    log('info', 'MacroBlock ready');
    if (boot.degradations) {
      Object.keys(boot.degradations).forEach((k) => {
        if (boot.degradations[k]) log('warn', boot.degradations[k]);
      });
    }
  }

  MB.app = { runSelection, recompile, saveMacro, showDiagnostics, state, onRunClicked, onStopClicked };

  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      modals.toast('Startup failed: ' + (err && err.message ? err.message : err), 'error', 60000);
      // eslint-disable-next-line no-console
      console.error(err);
    });
  });
})();



