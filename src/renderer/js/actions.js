/**
 * MacroBoard - UI action handlers for the custom field "pills".
 *
 * The Blockly fields (src/blockly/fields.js) cannot touch the DOM or IPC
 * themselves - they stay headless-safe - so they call through this port:
 *
 *   MB.fields.setUiPort({ runAction, openButtonPicker, openColourPicker, describe })
 *
 * `runAction(name, block)` is how the coordinate pickers, the eyedropper and the
 * chooser's arrows / + / x buttons work.
 */
(function () {
  'use strict';
  const MB = window.MB;
  const api = window.mb;
  const modals = MB.modals;

  /** Small helper: set a numeric field on a block if it exists. */
function setField(block, name, value) {
  const f = block && block.getField(name);
  if (f) f.setValue(value);
  }

  /**
   * Write a number into a SOCKET, replacing whatever was driving it.
   *
   * Coordinates and durations are sockets now, so the "pick" button has to
   * write INTO the socket - setField would find no field and silently do
   * nothing, which is exactly the bug where picking appeared to work but the
   * block never changed.
   *
   * An empty socket holds a plain number chip (its shadow), so the usual case
   * just edits that number in place and nothing shifts on screen. Any other
   * chip is REPLACED: the user just pointed at a specific spot, and that has to
   * beat whatever chip was feeding this axis.
   */
  /**
   * Put a picked number into a numeric SOCKET.
   *
   * This deliberately does NO block surgery - it never creates, connects or
   * disposes a block. That is not timidity, it is the whole bug:
   *
   *   - creating a replacement block and connecting it WITHOUT `initSvg()`
   *     leaves a block with no SVG group; Blockly parks it in the drag layer,
   *     so it follows the mouse until something drops it,
   *   - disposing the block that was in the socket leaves its fields'
   *     `fieldGroup_` cleared while a connection still points at them, and the
   *     next click throws "This field currently has no representative DOM
   *     element" - which aborts the gesture halfway and poisons every gesture
   *     after it with "the gesture had already been started".
   *
   * Both happened whenever a real chip (e.g. `between N1 and B1`) was in a
   * coordinate socket and the user pressed "pick".
   *
   * So: setting a FIELD's value is safe and is all this does. If the socket is
   * driven by a genuine chip, that chip is left exactly where the user put it
   * and they are told why - silently deleting someone's work to make a button
   * look like it worked would be worse than saying no.
   *
   * @return {boolean} true when the value was written.
   */
  function setNumInput(block, name, value) {
  const input = block && block.getInput(name);
  if (!input) {
    setField(block, name, value); // macro saved before these became sockets
    return true;
  }
  const conn = input.connection;
  const existing = conn && conn.targetBlock();
  if (!existing) return false; // genuinely empty socket
  if (existing.isShadow && existing.isShadow()) {
    setField(existing, 'NUM', value);
    return true;
  }
  return false;
  }

  /** Name of the chip type driving a socket, for the "can't pick that" message. */
  function socketDriver(block, name) {
  const input = block && block.getInput(name);
  const conn = input && input.connection;
  const existing = conn && conn.targetBlock();
  if (!existing || (existing.isShadow && existing.isShadow())) return null;
  return existing.type;
  }

/**
   * Pick TWO corners of a rectangle.
   *
   * First click is the first corner, second click is the second. The block
   * normalises the order at run time, so it does not matter which corner you
   * click first.
   *
   * Writes FIELDS only, for the same reason pickPoint does: creating or
   * disposing blocks here is what used to leave a block stuck to the cursor.
   */
  async function pickRect(block) {
  const names = ['X1', 'Y1', 'X2', 'Y2'];
  const blocked = names
      .map((n) => ({ name: n, driver: socketDriver(block, n) }))
      .filter((b) => b.driver);
  if (blocked.length) {
    modals.toast(
      'Cannot pick: ' + blocked.map((b) => b.name).join(' and ') +
        ' already have a chip in them. Take the chips out first.',
      'warn',
      6000
    );
    return;
  }
  try {
    modals.toast('Click the FIRST corner…', 'ok', 3200);
    const first = await api.capture.coordinate(20000);
    modals.toast('Captured ' + first.x + ', ' + first.y + ' — now click the OPPOSITE corner…', 'ok', 3200);
    const second = await api.capture.coordinate(20000);
    // Field writes only. Never newBlock / connect / dispose here.
    setNumInput(block, 'X1', first.x);
    setNumInput(block, 'Y1', first.y);
    setNumInput(block, 'X2', second.x);
    setNumInput(block, 'Y2', second.y);
    modals.toast('Area set: ' + first.x + ',' + first.y + ' to ' + second.x + ',' + second.y, 'ok', 2600);
  } catch (err) {
    modals.toast('Could not pick the area: ' + (err && err.message ? err.message : err), 'error');
  }
  }

  /** Shared "pick a point on screen" flow. */
  async function pickPoint(block, message) {
  // Work out what is in the way BEFORE hiding the app, so a refusal does not
  // make the window vanish for nothing.
  const blocked = ['X', 'Y']
      .map((n) => ({ name: n, driver: socketDriver(block, n) }))
      .filter((b) => b.driver);
    if (blocked.length) {
      modals.toast(
        'Cannot pick a point: ' +
          blocked.map((b) => b.name.toUpperCase() + ' is driven by a chip').join(' and ') +
          '. Take the chip out of the socket first.',
        'warn',
        6000
      );
      return;
    }
    try {
    modals.toast(message || 'Click the point you want on screen…', 'ok', 3200);
    const point = await api.capture.coordinate(20000);
    // Both axes come from this one screen click - hence a single pick button.
    setNumInput(block, 'X', point.x);
    setNumInput(block, 'Y', point.y);
      modals.toast('Captured ' + point.x + ', ' + point.y, 'ok', 2200);
    } catch (err) {
      modals.toast('Could not pick a coordinate: ' + (err && err.message ? err.message : err), 'error');
    }
  }

  /**
   * Run the eyedropper and swallow the outcome.
   *
   * The app hides itself, so there is nothing on screen to show a "cancelled"
   * message against - returning null for every non-pick is the honest result.
   * Errors that are NOT cancellations are worth saying out loud.
   */
  async function runEyedropper() {
    try {
      const res = await api.eyedropper.start();
      if (res && res.ok) return res;
      if (res && res.cancelled) return null;
      modals.toast('Eyedropper: ' + ((res && res.reason) || 'did not return a colour'), 'warn');
      return null;
    } catch (err) {
      modals.toast('Eyedropper failed: ' + (err && err.message ? err.message : err), 'error');
      return null;
    }
  }

const handlers = {
    /** "move mouse within" - pick the two corners of an area */
    pickRect(block) {
  return pickRect(block);
  },

  /** "click / move to" - pick x,y */
    pickXY(block) {
      return pickPoint(block, 'Click the point the macro should use…');
    },

    /** Pixel trigger - pick x,y */
    pickPixel(block) {
      return pickPoint(block, 'Click the pixel the trigger should watch…');
    },

    /**
     * Pixel trigger + `if pixel is` - read the colour under the cursor.
     *
     * The whole flow is in the main process now, because sampling has to happen
     * while the cursor HOVERS. The old version waited for a click and then read
     * the pixel, which photographed whatever the click had just caused.
     *
     * `applyColour` is shared with the eyedropper button in the colour modal, so
     * both paths end up doing exactly the same thing to the block.
     */
    async eyedropColour(block) {
      const res = await runEyedropper();
      if (!res || !res.ok) return;
      setField(block, 'COLOUR', res.colour);
      // Only overwrite x/y if the block actually has them: a block that only
      // wants a colour should not silently grow coordinates.
      if (block.getField('X')) setField(block, 'X', res.x);
      if (block.getField('Y')) setField(block, 'Y', res.y);
      modals.toast('Colour ' + res.colour + ' at ' + res.x + ',' + res.y, 'ok', 3000);
    },

    /**
     * "wait until window" - pick the title to look for from the open windows.
     *
     * The FIRST call in a session pays ~1s starting the PowerShell helper, so
     * the modal says so rather than appearing to hang. After that it is ~16ms.
     */
    async pickWindowTitle(block) {
      const field = block && block.getField('TITLE');
      if (!field) return;
      modals.toast('Reading open windows… (the first one takes about a second)', 'ok', 3000);
      let res;
      try {
        res = await api.windows.list();
      } catch (err) {
        modals.toast('Could not read window titles: ' + (err && err.message ? err.message : err), 'error');
        return;
      }
      if (!res || !res.ok) {
        modals.toast('Could not read window titles: ' + ((res && res.reason) || 'unknown error'), 'error');
        return;
      }
      const items = (res.windows || []).map((w) => ({
        value: w.title,
        label: w.title,
        hint: 'pid ' + w.pid,
      }));
      const picked = await modals.chooseList({
        title: 'Which window should it wait for?',
        subtitle: 'The match only needs to be PART of the title, and ignores case.',
        items,
        empty: 'No other windows are open right now. Type a title into the block instead.',
      });
      if (picked) {
        field.setValue(picked);
        modals.toast('Waiting for "' + picked + '"', 'ok', 2200);
      }
    },

    chooserPrev(block) {
      if (block.mbChooser) block.mbChooser.prev();
    },

    chooserNext(block) {
      if (block.mbChooser) block.mbChooser.next();
    },

    chooserAdd(block) {
      if (!block.mbChooser) return;
      const res = block.mbChooser.addPage();
      if (!res.ok) modals.toast(res.reason, 'warn');
    },

    /** Deleting a page is destructive, so it asks first. */
    async chooserDelete(block) {
      if (!block.mbChooser) return;
      const info = block.mbChooser.describe();
      const ok = await modals.confirm({
        title: 'Delete page ' + info.page + '?',
        subtitle: 'This chooser has ' + info.pages + ' pages.',
        note:
          info.empty >= info.pages - 1
            ? 'The page you are looking at appears to be empty.'
            : 'The blocks on this page will be removed. Blocks on the other pages are unaffected.',
        okLabel: 'Delete page',
      });
      if (!ok) return;
      const res = block.mbChooser.deletePage(info.page - 1);
      if (!res.ok) modals.toast(res.reason, 'warn');
    },

    /** Record-mode hotkey, configured from the toolbar. */
    async recordHotkey(block) {
      try {
        const res = await api.capture.press(15000);
        await api.record.setHotkey(res.buttonId);
        modals.toast('Record hotkey set to ' + res.label, 'ok');
      } catch (err) {
        modals.toast('Could not set the hotkey: ' + (err && err.message ? err.message : err), 'error');
      }
    },
  };

  function runAction(name, block) {
    const fn = handlers[name];
    if (!fn) {
      modals.toast('Unknown action "' + name + '"', 'warn');
      return;
    }
    try {
      const res = fn(block);
      if (res && res.catch) res.catch((err) => modals.toast(String(err && err.message ? err.message : err), 'error'));
    } catch (err) {
      modals.toast(String(err && err.message ? err.message : err), 'error');
    }
  }

  /** Install the UI port into the Blockly field layer. */
  function install(describeButton) {
    MB.fields.setUiPort({
      describe: describeButton,
      runAction,
      openButtonPicker(req) {
        return modals.buttonPicker({ value: req.value, mode: req.mode, kind: req.kind });
      },
      openColourPicker(req) {
        return modals.colourPicker({ value: req.value });
      },
    });
  }

  MB.actions = { install, runAction, handlers, runEyedropper };
})();
