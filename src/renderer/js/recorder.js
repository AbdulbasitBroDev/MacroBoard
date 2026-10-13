/**
 * MacroBlock - record mode.
 *
 * Turns a stream of real global input events into readable blocks appended live
 * to the current workspace.
 *
 * The heuristics are the whole feature, so they are explicit:
 *
 *   - Typing is COALESCED. Consecutive printable key presses build up a text
 *     buffer and become a single "type text" block, flushed when a non-typing
 *     event arrives or after `TEXT_IDLE_MS` of silence. Otherwise you would get
 *     one "press key" block per character.
 *   - Delays are recorded as "wait N seconds" blocks, but noise-level gaps are
 *     snapped away (`MIN_RECORDED_GAP_MS`). Typing gaps are never recorded - they
 *     are an artefact of how fast a human types, not part of the macro's intent.
 *   - Mouse MOVES are not recorded. Only clicks. Recording every pixel of mouse
 *     travel would produce unusable macros.
 *   - Repeated identical clicks at almost the same spot within a short window are
 *     upgraded to "press ... N times" so a double-click stays one block.
 *   - Key presses that are modifiers (Shift/Ctrl/Alt) are folded into the text
 *     buffer, not emitted as their own blocks.
 *
 * FLAG FOR THE USER: these thresholds are judgement calls. If recorded macros
 * feel wrong, MIN_RECORDED_GAP_MS and TEXT_IDLE_MS are the two knobs to change.
 */
(function () {
  'use strict';
  const MB = window.MB;
  const Blockly = window.Blockly;
  const modals = MB.modals;

  /** Ignore gaps shorter than this; humans are noisier than the clock. */
  const MIN_RECORDED_GAP_MS = 60;
  /** Flush the typing buffer after this much silence. */
  const TEXT_IDLE_MS = 900;

  /**
   * How a key press is turned into blocks.
   *
   *   TEXT    - consecutive printable presses coalesce into one "write GTL",
   *             which is what you want when transcribing a word.
   *   KEYBIND - every press becomes its own "press key" block, so G,T,L gives
   *             three blocks instead of one. Chosen from the Record menu and
   *             remembered between sessions.
   */
  const MODE_TEXT = 'text';
  const MODE_KEYBIND = 'keybind';
  const MODES = [MODE_TEXT, MODE_KEYBIND];
  const DEFAULT_MODE = MODE_TEXT;

  let mode = DEFAULT_MODE;
  /** Two clicks closer than this are treated as the same spot. */
  const SAME_POINT_PX = 6;

  let active = false;
  let unsubscribe = null;
  let flushTimer = null;

  let textBuffer = '';
  let lastEventAt = 0;
  let lastClick = null; // { x, y, button, at, count }
  let pendingSteps = 0;
  let ctx = null; // { workspace, getChainTail, onChange }

  /** Characters a key id produces, for coalescing into "type text". */
  const SHIFT_MAP = {
    '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
    Minus: '_', Equal: '+', LeftBracket: '{', RightBracket: '}', Backslash: '|',
    Semicolon: ':', Quote: '"', Comma: '<', Period: '>', Slash: '?', Grave: '~',
  };

  const NAME_TO_CHAR = {
    Space: ' ', Return: '\n', Enter: '\n', Tab: '\t',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    LeftBracket: '[', RightBracket: ']', Minus: '-', Equal: '=', Grave: '`',
    NumPad0: '0', NumPad1: '1', NumPad2: '2', NumPad3: '3', NumPad4: '4',
    NumPad5: '5', NumPad6: '6', NumPad7: '7', NumPad8: '8', NumPad9: '9',
    Multiply: '*', Add: '+', Subtract: '-', Decimal: '.', Divide: '/',
  };

  const MODIFIER_KEYS = [
    'LeftShift', 'RightShift', 'LeftControl', 'RightControl', 'LeftAlt', 'RightAlt',
    'LeftMeta', 'RightMeta', 'LeftSuper', 'RightSuper', 'LeftWin', 'RightWin', 'CapsLock',
  ];

  let shiftDown = false;

  /** @return {string|null} the character this key produces, or null if not textual. */
  function keyToChar(buttonId) {
    const name = String(buttonId || '').replace(/^key:/, '');
    if (/^Num[0-9]$/.test(name)) return shiftDown ? SHIFT_MAP[name[3]] : name[3];
    if (/^[A-Z]$/.test(name)) return shiftDown ? name : name.toLowerCase();
    if (NAME_TO_CHAR[name] !== undefined) {
      const c = NAME_TO_CHAR[name];
      if (shiftDown && SHIFT_MAP[name]) return SHIFT_MAP[name];
      return c;
    }
    return null;
  }

  function isModifier(buttonId) {
    return MODIFIER_KEYS.indexOf(String(buttonId || '').replace(/^key:/, '')) !== -1;
  }

  // -------------------------------------------------------- block emission

  /**
   * Append one block to the end of the chain attached to the start block's DO
   * input. Blocks are created directly (not via serialization) so the recorded
   * macro stays immediately editable.
   */
  function appendBlock(type, configure) {
    if (!ctx || !ctx.workspace) return null;
    let block;
    try {
      block = ctx.workspace.newBlock(type);
      if (configure) configure(block);
      block.initSvg();
      block.render();
    } catch (err) {
      MB.log('error', 'could not create a recorded block: ' + err.message);
      return null;
    }

    const tail = ctx.getChainTail ? ctx.getChainTail() : null;
    try {
      if (tail) tail.nextConnection.connect(block.previousConnection);
      else ctx.attachToStart(block);
    } catch (err) {
      MB.log('error', 'could not attach a recorded block: ' + err.message);
      return null;
    }
    pendingSteps++;
    if (ctx.onChange) ctx.onChange();
    return block;
  }

  /** Emit a "wait" block if a meaningful gap has passed since the last action. */
  function emitGap(now) {
    if (!lastEventAt) return;
    const gap = now - lastEventAt;
    if (gap < MIN_RECORDED_GAP_MS) return;
    // Seconds, to match the wait block's unit (one decimal place).
    const seconds = Math.round(gap / 100) / 10;
    appendBlock(MB.catalog.CONTROL.WAIT, (b) => {
      const target = b.getInputTargetBlock('MS');
      if (target && target.type === MB.catalog.VALUE.NUMBER) target.getField('NUM').setValue(seconds);
    });
  }

  function flushText() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!textBuffer) return;
    const text = textBuffer;
    textBuffer = '';
    appendBlock(MB.catalog.KEYBOARD.TYPE, (b) => b.getField('TEXT').setValue(text));
  }

  function scheduleFlush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (active) flushText();
    }, TEXT_IDLE_MS);
  }

  // --------------------------------------------------------------- handling

  function onEvent(ev) {
    if (!active || !ev) return;
    const now = Date.now();
    const kind = ev.kind;
    const buttonId = ev.button ? ev.button.id : null;

    // ---- keyboard ------------------------------------------------------
    if (kind === 'keydown') {
      if (buttonId === 'key:LeftShift' || buttonId === 'key:RightShift') {
        shiftDown = true;
        return;
      }
      if (isModifier(buttonId)) return; // folded into whatever follows

      // KEYBIND mode: never coalesce. Every press is its own "press key" block, so
      // G,T,L is three blocks rather than one "write GTL". Modifiers are still
      // folded (they return above), which is the documented behaviour of this mode.
      if (mode === MODE_KEYBIND) {
        flushText();
        emitGap(now);
        lastClick = null;
        appendBlock(MB.catalog.KEYBOARD.PRESS, (b) => b.getField('BUTTON').setValue(buttonId));
        lastEventAt = now;
        return;
      }

      const ch = keyToChar(buttonId);
      if (ch !== null && ch !== '\n' && ch !== '\t') {
        textBuffer += ch;
        lastEventAt = now;
        scheduleFlush();
        return;
      }

      // Anything else ends the current text run and becomes its own block.
      flushText();
      emitGap(now);
      lastClick = null;
      if (ch === '\n') {
        textBuffer = '\n';
        flushText();
      } else {
        appendBlock(MB.catalog.KEYBOARD.PRESS, (b) => b.getField('BUTTON').setValue(buttonId));
      }
      lastEventAt = now;
      return;
    }

    if (kind === 'keyup') {
      if (buttonId === 'key:LeftShift' || buttonId === 'key:RightShift') shiftDown = false;
      return;
    }

    // ---- mouse ---------------------------------------------------------
    if (kind === 'mousedown') {
      flushText();
      emitGap(now);

      const x = Math.round(ev.x);
      const y = Math.round(ev.y);
      const same =
        lastClick &&
        lastClick.button === buttonId &&
        Math.abs(lastClick.x - x) <= SAME_POINT_PX &&
        Math.abs(lastClick.y - y) <= SAME_POINT_PX &&
        now - lastClick.at < 600;

      if (same) {
        // Fold a rapid repeat into "press ... N times" on the previous block
        // (upgrade it from the bare single-click shape).
        const block = lastClick.block;
        const count = lastClick.count + 1;
        lastClick = { x, y, button: buttonId, at: now, block, count };
        try {
          const target = block.getInputTargetBlock('COUNT');
          if (target && target.type === MB.catalog.VALUE.NUMBER) target.getField('NUM').setValue(count);
        } catch (err) {
          /* shape changed underneath us; keep the single click */
        }
        lastEventAt = now;
        return;
      }

      // The click block can only simulate left/middle/right.
      const sim = ev.button ? ev.button.sim : false;
      if (!sim) {
        modals.toast(
          'Recorded input "' + (ev.button ? ev.button.label : '?') +
            '" cannot be replayed because the input library cannot simulate it. It was skipped.',
          'warn'
        );
        return;
      }

      const block = appendBlock(MB.catalog.MOUSE.CLICK, (b) => {
        b.getField('BUTTON').setValue(buttonId);
        b.getField('X').setValue(x);
        b.getField('Y').setValue(y);
      });
      lastClick = { x, y, button: buttonId, at: now, block, count: 1 };
      lastEventAt = now;
    }
  }

  // ------------------------------------------------------------ public API

  /**
   * Choose how key presses are recorded. An unrecognised value falls back to the
   * default rather than leaving `mode` as something no branch matches.
   */
  function setMode(next) {
    mode = MODES.indexOf(next) === -1 ? DEFAULT_MODE : next;
    // Switching mid-run must not strand a half-built text run in the buffer.
    if (mode === MODE_KEYBIND) flushText();
    return mode;
  }

  async function start(options) {
    ctx = options;
    if (options && options.mode) setMode(options.mode);
    const res = await window.mb.record.start();
    if (!res || !res.ok) {
      modals.toast((res && res.reason) || 'Could not start recording.', 'error');
      return false;
    }
    active = true;
    textBuffer = '';
    lastClick = null;
    lastEventAt = 0;
    shiftDown = false;
    pendingSteps = 0;
    unsubscribe = window.mb.onRecordEvent(onEvent);
    return true;
  }

  async function stop() {
    if (!active) return;
    flushText();
    active = false;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    await window.mb.record.stop();
    if (pendingSteps === 0) {
      modals.toast('Recording stopped - nothing was captured.', 'warn');
    } else {
      modals.toast('Recording stopped: ' + pendingSteps + ' block(s) added.', 'ok');
    }
    pendingSteps = 0;
  }

  MB.recorder = {
    start,
    stop,
    isActive: () => active,
    /** The mode new recordings use. Persisted by the caller via mb.settings. */
    getMode: () => mode,
    setMode,
    MODES,
    MODE_TEXT,
    MODE_KEYBIND,
    DEFAULT_MODE,
    constants: { MIN_RECORDED_GAP_MS, TEXT_IDLE_MS, SAME_POINT_PX },
  };
})();
