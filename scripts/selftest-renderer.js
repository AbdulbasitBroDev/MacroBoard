/* eslint-disable */
/**
 * Self-test script, executed INSIDE the renderer by `electron . --selftest`.
 *
 * It answers the question "why is the toolbox doing nothing?" by:
 *   1. listing every registered mb_* block type,
 *   2. actually selecting each toolbox category and counting the blocks that end
 *      up in the flyout,
 *   3. capturing any exception thrown while doing so,
 *   4. dumping the renderer error log.
 *
 * Must evaluate to a JSON string (executeJavaScript returns it).
 */
(function () {
  var out = {
    blockTypes: [],
    toolboxKinds: [],
    categories: {},
    flyoutAfterClick: {},
    errors: [],
    notes: [],
  };

  try {
    out.blockTypes = Object.keys(Blockly.Blocks)
      .filter(function (t) {
        return t.indexOf('mb_') === 0;
      })
      .sort();

    var ws = MB.app && MB.app.state ? MB.app.state.workspace : null;
    if (!ws) {
      out.notes.push('workspace not available');
      return JSON.stringify(out, null, 2);
    }

    out.toolboxClass = ws.getToolbox ? String(ws.getToolbox()) : 'no getToolbox';
    var toolbox = ws.getToolbox && ws.getToolbox();
    if (!toolbox) {
      out.notes.push('no toolbox instance');
      return JSON.stringify(out, null, 2);
    }

    var items = toolbox.getToolboxItems ? toolbox.getToolboxItems() : [];
    out.toolboxKinds = items.map(function (i) {
      return i.constructor ? i.constructor.name : '?';
    });

    // --- 1. Ask the flyout workspace to create each block directly. --------
    // This separates "block definition is broken" from "toolbox wiring is broken".
    var flyout = ws.getFlyout ? ws.getFlyout() : null;
    out.flyoutExists = !!flyout;
    if (flyout) {
      var fws = flyout.getWorkspace ? flyout.getWorkspace() : null;
      out.flyoutWorkspace = !!fws;
      out.perType = {};
      if (fws) {
        out.blockTypes.forEach(function (type) {
          try {
            var b = fws.newBlock(type);
            b.initSvg && b.initSvg();
            b.render && b.render();
            b.dispose(false);
            out.perType[type] = 'ok';
          } catch (e) {
            out.perType[type] = 'THREW: ' + e.message + ' :: ' +
              String(e.stack || '').split('\n').slice(0, 3).join(' | ');
          }
        });
      }
    }

    // --- 2. Actually click each category and inspect the flyout. ----------
    items.forEach(function (item, i) {
      var name = item.getName ? item.getName() : 'item' + i;
      var info = { kind: item.constructor ? item.constructor.name : '?' };
      try {
        // Selecting via the toolbox is exactly what a user click does.
        if (item.setSelected) item.setSelected(item);
        if (toolbox.setSelectedItem) toolbox.setSelectedItem(item);
      } catch (e) {
        info.selectThrew = e.message + ' :: ' + String(e.stack || '').split('\n').slice(0, 3).join(' | ');
      }
      try {
        var fl = ws.getFlyout ? ws.getFlyout() : null;
        var fw = fl && fl.getWorkspace ? fl.getWorkspace() : null;
        var blocks = fw ? fw.getAllBlocks(false) : [];
        info.flyoutBlockCount = blocks.length;
        info.flyoutTypes = blocks.map(function (b) {
          return b.type;
        });
        info.flyoutIsVisible = fl && fl.isVisible ? fl.isVisible() : 'n/a';
      } catch (e) {
        info.flyoutThrew = e.message;
      }
      out.categories[name] = info;
    });

    // --- 3. Drag path: does the workspace survive a move? ----------------
    //
    // Creating a block is NOT enough. "Unable to find connection in
    // connectionDB" only fires later, inside updateConnectionLocations, which is
    // the first thing a real drag does. So: count what is actually on the
    // workspace, then move every block on it and report exactly which ones
    // threw. This is the one check that sees a user's real macro.
    out.live = { before: 0, moved: 0, failures: [] };
    try {
var live = (ws.getAllBlocks(false) || []).filter(function (b) {
      // Only TOP-LEVEL blocks. Moving a child directly throws "Block has
      // parent" - a user never does that, they grab the stack by its hat.
      return !b.getParent();
    });
      out.live.before = live.length;
      live.forEach(function (b) {
        try {
          b.moveBy(7, 5);
          b.moveBy(7, 5);
          b.moveBy(7, 5);
          out.live.moved++;
        } catch (e) {
          out.live.failures.push(b.type + '#' + b.id + ' :: ' + e.message);
        }
      });
      ws.resizeContents && ws.resizeContents();
    } catch (e) {
      out.live.failures.push('sweep threw: ' + e.message);
    }

    // --- 4. Every block type must survive creation AND a move. ----------
    out.dragCheck = {};
    if (ws && ws.newBlock) {
      out.blockTypes.forEach(function (type) {
        var b = null;
        try {
          b = ws.newBlock(type);
          b.initSvg && b.initSvg();
          b.render && b.render();
          b.moveBy(12, 8);
          b.moveBy(12, 8);
          ws.resizeContents && ws.resizeContents();
          var at = b.getRelativeToSurfaceXY ? b.getRelativeToSurfaceXY() : null;
          if (!at || at.x !== 24) throw new Error('did not move to 24, got ' + (at && at.x));
          out.dragCheck[type] = 'ok';
        } catch (e) {
          out.dragCheck[type] = 'THREW: ' + e.message;
        } finally {
          try { if (b) b.dispose(false); } catch (e2) { /* ignore */ }
        }
      });
    }
out.dragFailures = Object.keys(out.dragCheck).filter(function (k) {
      return out.dragCheck[k] !== 'ok';
    });

    // --- 5. Does the compiler read REAL serialized state? -----------------
    //
    // The compiler looks inputs up as an OBJECT (`state.inputs[name]`). Blockly
    // has moved inputs between object-map and ARRAY form across versions. If
    // this build serializes them as an array, that lookup silently returns
    // undefined, every socket falls back to its default, and coordinates become
    // 0 - with no error anywhere. Assert on real state, not a fixture.
    out.realState = {};
    try {
      var probeBlock = ws.newBlock('mb_mouse_click');
      probeBlock.getField('BUTTON').setValue('mouse:1');
      var realJson = Blockly.serialization.blocks.save(probeBlock, { addCoordinates: false });
      probeBlock.dispose(false);
      out.realState.inputsIsArray = Array.isArray(realJson.inputs);
      out.realState.inputsType = typeof realJson.inputs;
      out.realState.inputsKeys = realJson.inputs
        ? (Array.isArray(realJson.inputs)
            ? realJson.inputs.map(function (i) { return i && i.name; })
            : Object.keys(realJson.inputs))
        : 'none';
      var comp = MB.app && MB.app.state && MB.app.state.compiler;
      if (comp && comp.compileState) {
        var r = comp.compileState(realJson);
        out.realState.compiledX = r.steps[0] && r.steps[0].x;
        out.realState.errors = r.errors.slice(0, 3);
      }
    } catch (e) {
      out.realState.threw = e.message;
    }

// --- 6. Replacing the chip in a socket must not corrupt the workspace. -
    //
    // The "pick" button swaps whatever chip is in a socket for a plain number.
    // Doing that in the wrong order (dispose while still connected) leaves a
    // connection in Blockly's database with no owner, and the very next drag
    // throws "Unable to find connection in connectionDB" every frame. Creating
    // and moving blocks never touches that path, so it needs its own check.
    out.chipSwap = { diagnostics: [] };
    try {
      var swapBlock = ws.newBlock('mb_mouse_click');
      swapBlock.getField('BUTTON').setValue('mouse:1');
      swapBlock.initSvg && swapBlock.initSvg();
      swapBlock.render && swapBlock.render();
      var swapConn = swapBlock.getInput('X').connection;
      var decoy = ws.newBlock('mb_value_range');
      decoy.initSvg && decoy.initSvg();
      decoy.render && decoy.render();

      var D = out.chipSwap.diagnostics;
      D.push('isBlockSvg(swapBlock): ' + (typeof Blockly.BlockSvg === 'function' && swapBlock instanceof Blockly.BlockSvg));
      D.push('isBlockSvg(decoy)    : ' + (typeof Blockly.BlockSvg === 'function' && decoy instanceof Blockly.BlockSvg));
      D.push('typeof decoy.getSourceBlock: ' + typeof decoy.getSourceBlock);
      D.push('typeof decoy.sourceBlock    : ' + typeof decoy.sourceBlock);
      D.push('socket type: ' + swapConn.type);

      // THE question: can a user actually plug a chip into this socket?
      var chip = ws.newBlock('mb_value_number');
      chip.initSvg && chip.initSvg();
      chip.render && chip.render();
      chip.setFieldValue('640', 'NUM');
      try {
        var ok = swapConn.connect(chip.outputConnection);
        D.push('connect(number chip) returned: ' + ok);
        D.push('socket now holds: ' + ((swapConn.targetBlock() || {}).type));
      } catch (e1) {
        D.push('connect(number chip) THREW: ' + e1.message);
      }

      // Then the exact swap the pick button performs.
      try {
        var other = ws.newBlock('mb_value_number');
        other.initSvg && other.initSvg();
        other.render && other.render();
        var cur = swapConn.targetBlock();
        if (cur) swapConn.disconnect();
        swapConn.connect(other.outputConnection);
        if (cur) cur.dispose(false);
        D.push('disconnect/connect/dispose: ok');
      } catch (e2) {
        D.push('disconnect/connect/dispose THREW: ' + e2.message);
      }

      swapBlock.moveBy(9, 9);
      swapBlock.moveBy(9, 9);
      ws.resizeContents && ws.resizeContents();
      out.chipSwap.result = 'ok';
    } catch (e) {
      out.chipSwap.result = 'THREW: ' + e.message;
    }


    // --- 7. Every field must survive a focus lookup. ---------------------
    //
    // Clicking any pill runs Blockly's focus lookup, which calls
    // getFocusableElement() on EVERY field of the block. The base class throws
    // when fieldGroup_ is unset, and a throw there aborts the gesture halfway,
    // which then poisons every gesture after it. Check every field of every
    // block type, rendered.
    out.focusLookup = { checked: 0, typesSeen: 0, unresolved: [], failures: [] };
    try {
      out.blockTypes.forEach(function (type) {
        var b = null;
        try {
          b = ws.newBlock(type);
          b.initSvg && b.initSvg();
          b.render && b.render();
          out.focusLookup.typesSeen++;
          // Walk the field OBJECTS rather than looking them up by name.
          // Blockly 13 exposes no reliable key: Field.name is gone, getName()
          // returns nothing usable, and fields live in inputList[i].fieldRow.
          // Iterating objects directly avoids every one of those traps.
          var seen = 0;
          (b.inputList || []).forEach(function (input) {
            (input.fieldRow || []).forEach(function (f) {
              if (!f) return;
              seen++;
              try {
                out.focusLookup.checked++;
                if (typeof f.getFocusableElement === 'function') f.getFocusableElement();
              } catch (e) {
                out.focusLookup.failures.push(
                  type + '.' + seen + '(' + (f.constructor ? f.constructor.name : '?') + ') :: ' + e.message
                );
              }
            });
          });
          if (!seen) out.focusLookup.failures.push(type + ' :: NO FIELDS FOUND');
        } catch (e) {
          out.focusLookup.failures.push(type + ' :: ' + e.message);
        } finally {
          try { if (b) b.dispose(false); } catch (e2) { /* ignore */ }
        }
      });
    } catch (e) {
      out.focusLookup.failures.push('sweep threw: ' + e.message);
    }
    out.errors = (window.__mbErrors || []).slice(0, 40);
  } catch (e) {
    out.notes.push('harness threw: ' + e.message + ' :: ' + String(e.stack || '').split('\n').slice(0, 4).join(' | '));
    out.errors = (window.__mbErrors || []).slice(0, 40);
  }

  return JSON.stringify(out, null, 2);
})();