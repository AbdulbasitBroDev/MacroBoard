/**
 * MacroBoard - modal dialogs.
 *
 * Contains the button picker (US keyboard grid + mouse buttons + "listen for a
 * press"), the colour picker (palette + hex + screen eyedropper), and the small
 * prompt / confirm / toast helpers the rest of the UI uses.
 *
 * The picker grids are filled from data the main process sends at bootstrap, so
 * what you see is derived from the enum values that ACTUALLY loaded - not from a
 * hard-coded list that might disagree with the runtime.
 */
(function () {
  'use strict';
  const MB = window.MB;
  const api = window.mb;

  const root = document.getElementById('modal-root');
  const win = document.getElementById('modal-window');
  const backdrop = document.getElementById('modal-backdrop');
  const toastRoot = document.getElementById('toast-root');

  let closeCurrent = null;
  let interactionLocked = false;

  function isOpen() {
    return !root.classList.contains('hidden');
  }

  function open(node, onClose) {
    win.innerHTML = '';
    win.appendChild(node);
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    closeCurrent = onClose || null;
    // Focus the first focusable control so Escape/Enter behave predictably.
    const first = win.querySelector('input, button');
    if (first) setTimeout(() => first.focus(), 10);
  }

  function close() {
    if (interactionLocked) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    win.innerHTML = '';
    const cb = closeCurrent;
    closeCurrent = null;
    if (cb) cb();
  }

  backdrop.addEventListener('click', () => { if (!interactionLocked) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && !interactionLocked) {
      e.stopPropagation();
      close();
    }
  });

  function el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function header(title, subtitle) {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('h2', null, title));
    if (subtitle) frag.appendChild(el('div', 'modal-sub', subtitle));
    return frag;
  }

  function actions(buttons) {
    const row = el('div', 'modal-actions');
    buttons.forEach((b) => {
      const btn = el('button', 'btn ' + (b.className || ''), b.label);
      btn.addEventListener('click', () => b.onClick());
      row.appendChild(btn);
    });
    return row;
  }

  // ------------------------------------------------------------------ toast

  function toast(message, kind, ms) {
    const node = el('div', 'toast ' + (kind || ''), message);
    toastRoot.appendChild(node);
    const life = ms || (kind === 'error' ? 9000 : 4200);
    setTimeout(() => {
      node.style.transition = 'opacity .2s';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 220);
    }, life);
    return node;
  }

  // -------------------------------------------------------------- prompts

  function prompt(opts) {
    return new Promise((resolve) => {
      const frag = document.createDocumentFragment();
      frag.appendChild(header(opts.title, opts.subtitle));
      const row = el('div', 'field-row');
      row.appendChild(el('label', null, opts.label || 'Name'));
      const input = el('input', null);
      input.type = 'text';
      input.value = opts.value || '';
      input.placeholder = opts.placeholder || '';
      row.appendChild(input);
      frag.appendChild(row);
      if (opts.note) frag.appendChild(el('div', 'modal-note', opts.note));

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
        close();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(input.value.trim());
      });
      frag.appendChild(
        actions([
          { label: 'Cancel', onClick: () => finish(null) },
          { label: opts.okLabel || 'OK', className: 'btn-primary', onClick: () => finish(input.value.trim()) },
        ])
      );
      open(frag, () => { if (!done) { done = true; resolve(null); } });
    });
  }

  function confirm(opts) {
    return new Promise((resolve) => {
      const frag = document.createDocumentFragment();
      frag.appendChild(header(opts.title, opts.subtitle));
      if (opts.note) frag.appendChild(el('div', 'modal-note ' + (opts.noteKind || ''), opts.note));

      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
        close();
      };
      frag.appendChild(
        actions([
          { label: opts.cancelLabel || 'Cancel', onClick: () => finish(false) },
          {
            label: opts.okLabel || 'Confirm',
            className: opts.danger === false ? 'btn-primary' : 'btn-danger',
            onClick: () => finish(true),
          },
        ])
      );
      open(frag, () => { if (!done) { done = true; resolve(false); } });
    });
  }

  function info(opts) {
    return new Promise((resolve) => {
      const frag = document.createDocumentFragment();
      frag.appendChild(header(opts.title, opts.subtitle));
      if (opts.body) {
        const pre = el('div', 'modal-note');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.fontFamily = 'var(--mono)';
        pre.style.maxHeight = '46vh';
        pre.style.overflow = 'auto';
        pre.textContent = opts.body;
        frag.appendChild(pre);
      }
      frag.appendChild(actions([{ label: 'Close', className: 'btn-primary', onClick: () => { resolve(true); close(); } }]));
      open(frag, () => resolve(false));
    });
  }

  /**
   * Pick one value from a list.
   *
   * Used by the "wait until window" title picker. Deliberately a MODAL list
   * rather than a Blockly dropdown: the match is a substring, so the useful
   * entry is often a short fragment of a long title, and a dropdown that can
   * only contain whole titles would fight the user.
   *
   * @param {object} opts
   * @param {string} [opts.title] @param {string} [opts.subtitle]
   * @param {Array<{value:string,label:string,hint?:string}>} opts.items
   * @param {string} [opts.empty] shown when there are no items
   * @return {Promise<string|null>}
   */
  function chooseList(opts) {
    return new Promise((resolve) => {
      const items = Array.isArray(opts.items) ? opts.items : [];
      const frag = document.createDocumentFragment();
      frag.appendChild(
        header(opts.title || 'Choose one', opts.subtitle || 'Pick an entry, or cancel and type your own.')
      );

      if (!items.length) {
        const note = el('div', 'modal-note');
        note.textContent = opts.empty || 'Nothing to choose from.';
        frag.appendChild(note);
      } else {
        const list = el('div', 'mbList');
        items.forEach((item) => {
          const b = el('button', 'mbListRow');
          b.appendChild(el('span', 'mbListLabel', item.label));
          if (item.hint) b.appendChild(el('span', 'mbListHint', item.hint));
          b.addEventListener('click', () => {
            resolve(item.value);
            close();
          });
          list.appendChild(b);
        });
        frag.appendChild(list);
      }

      frag.appendChild(actions([{ label: 'Cancel', onClick: () => { resolve(null); close(); } }]));
      open(frag, () => resolve(null));
    });
  }

  // ------------------------------------------------------- button picker

  /**
   * @param {object} opts
   * @param {string} opts.value current button id
   * @param {'action'|'trigger'} opts.mode action = must be simulatable
   * @param {'key'|'mouse'|null} [opts.kind] restrict to one kind of input
   * @return {Promise<string|null>}
   */
  function buttonPicker(opts) {
    return new Promise((resolve) => {
      const gridData = MB.grids || { keyboardGrid: [], numpadGrid: [], mouseButtons: [] };
      const table = MB.buttonTable || {};
      let chosen = opts.value || '';
      let done = false;
      // A mouse-only block hides the keyboard grids (and vice versa) so an
      // incompatible input cannot be chosen in the first place.
      const kind = opts.kind || null;
      const wantMouse = kind === 'mouse';
      const wantKey = kind === 'key';

      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
        close();
      };

      const frag = document.createDocumentFragment();
      const heading = wantMouse
        ? 'Choose a mouse button'
        : wantKey
          ? 'Choose a key'
          : opts.mode === 'action'
            ? 'Choose a key or mouse button to press'
            : 'Choose a trigger';
      const subheading = wantMouse
        ? 'Clicking is a mouse action, so only mouse buttons can be used here.'
        : opts.mode === 'action'
          ? 'This is an ACTION, so only inputs the simulation library can actually perform are selectable.'
          : 'Any input this machine can report works as a trigger, including mouse side buttons.';
      frag.appendChild(header(heading, subheading));

      const simulatable = (id) => (table[id] ? table[id].sim : false);

      // The "record" button is the first thing rendered and spans the full width.
      // It used to sit at the bottom in a `field-row`, which made it small and
      // easy to miss - yet it is the quickest and most reliable way to pick an
      // input, so it should not be the hardest control in the dialog to reach.
      const listenRow = el('div', 'field-row picker-record-row');
      const listenBtn = el('button', 'btn btn-primary picker-record-btn', 'Record key / mouse button');
      const listenOut = el('span', 'picker-record-out', '');
      listenOut.style.color = 'var(--text-dim)';
      listenBtn.addEventListener('click', async () => {
        listenBtn.disabled = true;
        listenOut.textContent = 'Waiting for a real key or mouse button...';
        try {
          const res = await api.capture.press(15000);
          chosen = res.buttonId;
          const isMouse = String(res.buttonId).indexOf('mouse:') === 0;
          if (wantMouse && !isMouse) {
            listenOut.textContent = 'Saw ' + res.label + ' - that is a key, and this block needs a mouse button.';
            return;
          }
          if (wantKey && isMouse) {
            listenOut.textContent = 'Saw ' + res.label + ' - that is a mouse button, and this block needs a key.';
            return;
          }
          if (opts.mode === 'trigger' || res.sim) {
            listenOut.textContent = 'Saw ' + res.label + ' (raw code ' + res.raw + ')';
            setTimeout(() => finish(res.buttonId), 320);
          } else {
            listenOut.textContent =
              'Saw ' + res.label + ' (raw code ' + res.raw +
              ') - that input cannot be simulated, so it cannot be used as an action.';
          }
        } catch (err) {
          listenOut.textContent = 'Failed: ' + (err && err.message ? err.message : err);
        } finally {
          listenBtn.disabled = false;
        }
      });
      listenRow.appendChild(listenBtn);
      listenRow.appendChild(listenOut);
      frag.appendChild(listenRow);

      frag.appendChild(el('div', 'grid-section-title', 'Or pick from the grid'));

      function renderGrid(title, rows) {
        frag.appendChild(el('div', 'grid-section-title', title));
        const grid = el('div', 'key-grid');
        rows.forEach((row) => {
          const r = el('div', 'key-row');
          row.forEach((cell) => {
            const id = 'key:' + cell.id;
            const canUse = opts.mode === 'trigger' || simulatable(id);
            const btn = el(
              'button',
              'key-cell' + (cell.wide ? ' wide' : '') + (cell.xwide ? ' xwide' : '') +
                (canUse ? '' : ' unsupported') + (chosen === id ? ' selected' : ''),
              cell.label
            );
            if (canUse) btn.addEventListener('click', () => finish(id));
            else {
              btn.title =
                'Not available as an action: the input library cannot simulate this input. ' +
                'Mouse side buttons can still be used as triggers.';
            }
            r.appendChild(btn);
          });
          grid.appendChild(r);
        });
        frag.appendChild(grid);
      }

      if (!wantMouse) {
        renderGrid('Keyboard', gridData.keyboardGrid || []);
        renderGrid('Numpad + navigation', gridData.numpadGrid || []);
      }

      if (!wantKey) {
        frag.appendChild(el('div', 'grid-section-title', 'Mouse buttons'));
        const mouseGrid = el('div', 'key-grid');
        const mouseRow = el('div', 'key-row');
        (gridData.mouseButtons || []).forEach((m) => {
          const canUse = opts.mode === 'trigger' || m.sim;
          const btn = el(
            'button',
            'key-cell mouse' + (canUse ? '' : ' unsupported') + (chosen === m.id ? ' selected' : ''),
            m.label
          );
          btn.title = m.note || '';
          if (canUse) btn.addEventListener('click', () => finish(m.id));
          mouseRow.appendChild(btn);
        });
        mouseGrid.appendChild(mouseRow);
        frag.appendChild(mouseGrid);
      }

      frag.appendChild(
        el(
          'div',
          'modal-note',
          'Mouse button numbering is whatever YOUR machine reports - raw conventions can differ from the ' +
            'best-guess labels above. Use "Listen for a press" when it matters.'
        )
      );


      frag.appendChild(
        actions([
          { label: 'Cancel', onClick: () => finish(null) },
          { label: 'Clear', onClick: () => finish('') },
        ])
      );
      open(frag, () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      });
    });
  }

  function shortcutSettings(opts) {
    opts = opts || {};
    const initial = opts.value || {};
    let mode = initial.mode === 'separate' ? 'separate' : 'toggle';
    let arm = Array.isArray(initial.arm) ? initial.arm.slice() : [];
    let disarm = Array.isArray(initial.disarm) ? initial.disarm.slice() : [];
    let done = false;

    return new Promise((resolve) => {
      const frag = document.createDocumentFragment();
      frag.appendChild(header(opts.title || 'Macro shortcuts', 'Choose a toggle chord or separate arm and disarm chords.'));

      const modeRow = el('div', 'field-row');
      modeRow.appendChild(el('label', null, 'Shortcut mode'));
      const select = el('select');
      [['toggle', 'One chord toggles'], ['separate', 'Separate arm and disarm']].forEach(([value, label]) => {
        const option = el('option', null, label);
        option.value = value;
        select.appendChild(option);
      });
      select.value = mode;
      modeRow.appendChild(select);
      frag.appendChild(modeRow);

      const armRow = el('div', 'shortcut-row');
      const armLabel = el('label', null, 'Arm chord');
      const armValue = el('span', 'shortcut-value');
      const armButton = el('button', 'btn btn-small', 'Record arm');
      armRow.append(armLabel, armValue, armButton);
      frag.appendChild(armRow);

      const disarmRow = el('div', 'shortcut-row');
      const disarmLabel = el('label', null, 'Disarm chord');
      const disarmValue = el('span', 'shortcut-value');
      const disarmButton = el('button', 'btn btn-small', 'Record disarm');
      disarmRow.append(disarmLabel, disarmValue, disarmButton);
      frag.appendChild(disarmRow);

      let editing = 'arm';
      const targetRow = el('div', 'shortcut-row');
      targetRow.appendChild(el('label', null, 'Select keys'));
      const chooseArm = el('button', 'btn btn-small btn-primary', 'Arm chord');
      const chooseDisarm = el('button', 'btn btn-small', 'Disarm chord');
      targetRow.append(chooseArm, chooseDisarm);
      frag.appendChild(targetRow);
      const keyboard = el('div', 'shortcut-keyboard');
      frag.appendChild(keyboard);

      const note = el('div', 'modal-note', 'Global keyboard chords work while MacroBoard is in the background.');
      frag.appendChild(note);

      const cancelButton = el('button', 'btn', 'Cancel');
      const saveButton = el('button', 'btn btn-primary', 'Save shortcuts');
      const footer = el('div', 'modal-actions');
      footer.append(cancelButton, saveButton);
      frag.appendChild(footer);

      const formatChord = (ids) => ids.map((id) => {
        const entry = tableLabel(id);
        return entry || id.replace(/^key:/, '');
      }).join(' + ');
      const reservedChordKey = 'key:' + MB.constants.GLOBAL_STOP_KEY;
      const hasReservedKey = (ids) => ids.includes(reservedChordKey);
      const renderKeyboard = () => {
        keyboard.innerHTML = '';
        const grids = MB.grids || {};
        const drawGrid = (title, rows) => {
          if (!rows || !rows.length) return;
          keyboard.appendChild(el('div', 'grid-section-title', title));
          const grid = el('div', 'key-grid');
          rows.forEach((row) => {
            const keyRow = el('div', 'key-row');
            row.forEach((cell) => {
              const id = 'key:' + cell.id;
              const selected = (editing === 'arm' ? arm : disarm).includes(id);
              const reserved = id === reservedChordKey;
              const key = el('button', 'key-cell' + (cell.wide ? ' wide' : '') + (cell.xwide ? ' xwide' : '') +
                (selected ? ' selected' : '') + (reserved ? ' unsupported' : ''), cell.label);
              key.type = 'button';
              if (reserved) {
                key.disabled = true;
                key.title = 'Reserved for the global Stop shortcut.';
              }
              key.addEventListener('click', () => {
                const chord = editing === 'arm' ? arm : disarm;
                const index = chord.indexOf(id);
                if (index === -1) chord.push(id);
                else chord.splice(index, 1);
                render();
              });
              keyRow.appendChild(key);
            });
            grid.appendChild(keyRow);
          });
          keyboard.appendChild(grid);
        };
        drawGrid('Keyboard', grids.keyboardGrid || []);
        drawGrid('Numpad + navigation', grids.numpadGrid || []);
      };
      const render = () => {
        select.value = mode;
        disarmRow.hidden = mode !== 'separate';
        chooseDisarm.hidden = mode !== 'separate';
        armValue.textContent = formatChord(arm) || 'Not recorded';
        disarmValue.textContent = formatChord(disarm) || 'Not recorded';
        armValue.classList.toggle('empty', !arm.length);
        disarmValue.classList.toggle('empty', !disarm.length);
        saveButton.disabled = !arm.length || hasReservedKey(arm) ||
          (mode === 'separate' && (!disarm.length || hasReservedKey(disarm)));
        chooseArm.classList.toggle('btn-primary', editing === 'arm');
        chooseDisarm.classList.toggle('btn-primary', editing === 'disarm');
        renderKeyboard();
      };
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
        close();
      };
      const record = async (button, value) => {
        interactionLocked = true;
        cancelButton.disabled = true;
        saveButton.disabled = true;
        button.disabled = true;
        button.textContent = 'Press and release chord…';
        note.textContent = 'Waiting for a keyboard chord…';
        try {
          const result = await api.capture.chord(15000);
          if (!result || !result.ok || !Array.isArray(result.buttonIds) || !result.buttonIds.length) {
            throw new Error((result && result.reason) || 'No chord was captured.');
          }
          if (hasReservedKey(result.buttonIds)) throw new Error('F8 is reserved for the global Stop shortcut.');
          if (value === 'arm') arm = result.buttonIds;
          else disarm = result.buttonIds;
          note.textContent = 'Recorded ' + formatChord(result.buttonIds) + '.';
          render();
        } catch (err) {
          note.textContent = 'Could not record chord: ' + (err && err.message ? err.message : err);
        } finally {
          interactionLocked = false;
          cancelButton.disabled = false;
          saveButton.disabled = false;
          button.disabled = false;
          button.textContent = value === 'arm' ? 'Record arm' : 'Record disarm';
          render();
        }
      };

      select.addEventListener('change', () => {
        mode = select.value;
        if (mode !== 'separate') editing = 'arm';
        render();
      });
      chooseArm.addEventListener('click', () => { editing = 'arm'; render(); });
      chooseDisarm.addEventListener('click', () => { editing = 'disarm'; render(); });
      armButton.addEventListener('click', () => record(armButton, 'arm'));
      disarmButton.addEventListener('click', () => record(disarmButton, 'disarm'));
      cancelButton.addEventListener('click', () => finish(null));
      saveButton.addEventListener('click', () => {
        if (saveButton.disabled) return;
        finish({ mode, arm, disarm: mode === 'separate' ? disarm : arm });
      });
      render();
      open(frag, () => { if (!done) { done = true; resolve(null); } });
    });
  }

  function tableLabel(id) {
    const table = MB.buttonTable || {};
    return table[id] && table[id].label;
  }

  // ------------------------------------------------------- colour picker

  const PALETTE = [
    '#ffffff', '#c8cddb', '#8f97ad', '#4a5165', '#1c2030', '#000000',
    '#ff5d6c', '#ff8b6b', '#ffb340', '#ffe066', '#2fd07f', '#38d9a9',
    '#4dabf7', '#7c5cff', '#b197fc', '#ff6b9d', '#f783ac', '#63e6be',
  ];

  function colourPicker(opts) {
    return new Promise((resolve) => {
      let chosen = opts.value || '#ffffff';
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        resolve(value);
        close();
      };

      const frag = document.createDocumentFragment();
      frag.appendChild(
        header(
          'Choose the target colour',
          'Type a hex value, click a swatch, or use the eyedropper to read a colour straight off the screen.'
        )
      );
      const row = el('div', 'field-row');
      const swatch = el('div', 'swatch');
      swatch.style.background = chosen;
      const input = el('input', null);
      input.type = 'text';
      input.value = chosen;
      const native = el('input', null);
      native.type = 'color';
      native.value = chosen;
      native.style.width = '42px';
      native.style.height = '32px';
      native.style.padding = '0';
      native.style.cursor = 'pointer';

      const sync = (value, from) => {
        if (!/^#[0-9a-fA-F]{6}$/.test(value)) return;
        chosen = value.toLowerCase();
        swatch.style.background = chosen;
        if (from !== 'input') input.value = chosen;
        if (from !== 'native') native.value = chosen;
      };
      input.addEventListener('input', () => sync(input.value.trim(), 'input'));
      native.addEventListener('input', () => sync(native.value, 'native'));

      row.appendChild(swatch);
      row.appendChild(input);
      row.appendChild(native);
      frag.appendChild(row);

      const pal = el('div', 'palette');
      PALETTE.forEach((c) => {
        const b = el('button', 'swatch');
        b.style.background = c;
        b.title = c;
        b.addEventListener('click', () => sync(c));
        pal.appendChild(b);
      });
      frag.appendChild(pal);

      const dropRow = el('div', 'field-row');
      const dropBtn = el('button', 'btn', '⧉  Eyedropper');
      dropBtn.title = 'Hide this app, move the mouse over the colour, then Ctrl+click to pick it. '
        + 'Or press Ctrl+Enter to pick without clicking at all. Escape to cancel.';
      const dropOut = el('span', null, '');
      dropOut.style.color = 'var(--text-dim)';
      dropBtn.addEventListener('click', async () => {
        // The app hides itself for the whole eyedropper, and the main process
        // samples the colour live while the cursor moves - so there is nothing
        // useful to show here until it comes back with an answer.
        dropBtn.disabled = true;
        dropOut.textContent = '';
        try {
          const res = await MB.actions.runEyedropper();
          if (res && res.ok) {
            sync(res.colour);
            dropOut.textContent = 'Read ' + res.colour + ' at ' + res.x + ',' + res.y;
          } else {
            dropOut.textContent = 'Cancelled.';
          }
        } finally {
          dropBtn.disabled = false;
        }
      });
      dropRow.appendChild(dropBtn);
      dropRow.appendChild(dropOut);
      frag.appendChild(dropRow);

      frag.appendChild(
        actions([
          { label: 'Cancel', onClick: () => finish(null) },
          { label: 'Use colour', className: 'btn-primary', onClick: () => finish(chosen) },
        ])
      );
      open(frag, () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      });
    });
  }

  MB.modals = { open, close, prompt, confirm, info, toast, buttonPicker, shortcutSettings, colourPicker, chooseList };
})();
