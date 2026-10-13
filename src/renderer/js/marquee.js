/**
 * MacroBlock - marquee (rubber-band) selection + the selection context menu.
 *
 * DESIGN NOTE
 * -----------
 * Blockly's own selection model is single-block. Rather than relying on an API
 * that has changed shape across versions, this module tracks its own selection
 * (a Set of block ids), marks blocks with an `mb-sel` class for the highlight,
 * and drives the context-menu actions from that list. Everything it needs is
 * public and stable: `workspace.getTopBlocks()`, `getSvgRoot()`,
 * `getBoundingClientRect()` and `Blockly.serialization`.
 *
 * A plain right-click on empty canvas with no selection also works: it selects
 * whatever block is under the cursor, so "right-click a block -> Run selected"
 * doubles as the "test this single block" feature.
 */
(function () {
  'use strict';
  const MB = window.MB;
  const Blockly = window.Blockly;
  const modals = MB.modals;

  const workspaceHost = document.getElementById('workspace');
  const menu = document.getElementById('ctx-menu');

  let selection = new Set(); // block ids
  let menuOpen = false;
  let drag = null;

  function clear() {
    selection.forEach((id) => {
      const b = currentWorkspace && currentWorkspace.getBlockById(id);
      if (b && b.getSvgRoot) b.getSvgRoot().classList.remove('mb-sel');
    });
    selection = new Set();
  }

  let currentWorkspace = null;

  function set(blocks) {
    clear();
    blocks.forEach((b) => {
      if (!b || !b.getSvgRoot) return;
      selection.add(b.id);
      b.getSvgRoot().classList.add('mb-sel');
    });
  }

  function blocks() {
    return Array.from(selection)
      .map((id) => currentWorkspace.getBlockById(id))
      .filter(Boolean);
  }

  function hideMenu() {
    menu.classList.add('hidden');
    menu.innerHTML = '';
    menuOpen = false;
  }

  // ------------------------------------------------------------ marquee box

  let box = null;

  function startMarquee(x, y) {
    box = document.createElement('div');
    box.style.cssText =
      'position:fixed;border:1px solid #9d86ff;background:rgba(124,92,255,0.16);' +
      'border-radius:2px;pointer-events:none;z-index:800;';
    document.body.appendChild(box);
    drag = { x0: x, y0: y, x1: x, y1: y, additive: false };
    updateMarquee();
  }

  function updateMarquee() {
    if (!box || !drag) return;
    const left = Math.min(drag.x0, drag.x1);
    const top = Math.min(drag.y0, drag.y1);
    const w = Math.abs(drag.x1 - drag.x0);
    const h = Math.abs(drag.y1 - drag.y0);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
  }

  function endMarquee() {
    if (!box) return;
    const rect = {
      left: Math.min(drag.x0, drag.x1),
      top: Math.min(drag.y0, drag.y1),
      right: Math.max(drag.x0, drag.x1),
      bottom: Math.max(drag.y0, drag.y1),
    };
    box.remove();
    box = null;
    drag = null;

    // A tiny drag is a click, not a selection.
    if (rect.right - rect.left < MB.constants.LIMITS.MARQUEE_THRESHOLD_PX &&
        rect.bottom - rect.top < MB.constants.LIMITS.MARQUEE_THRESHOLD_PX) {
      clear();
      return;
    }

    const hits = currentWorkspace.getTopBlocks(true).filter((b) => {
      if (!b.getSvgRoot) return false;
      const r = b.getSvgRoot().getBoundingClientRect();
      return r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top;
    });
    // Also catch blocks nested inside a selected stack's statement inputs.
    const all = [];
    hits.forEach((b) => {
      all.push(b);
      b.getDescendants(false).forEach((d) => {
        if (d.getSvgRoot) {
          const r = d.getSvgRoot().getBoundingClientRect();
          if (r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top) {
            all.push(d);
          }
        }
      });
    });
    set(all);
  }

  // ------------------------------------------------------- context menu

  function showMenu(clientX, clientY, onChanged) {
    const sel = blocks();
    if (!sel.length) return;

    menu.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ctx-head';
    head.textContent = sel.length + ' block' + (sel.length === 1 ? '' : 's') + ' selected';
    menu.appendChild(head);

    const item = (label, className, action) => {
      const b = document.createElement('button');
      if (className) b.className = className;
      b.textContent = label;
      b.addEventListener('click', () => {
        hideMenu();
        action();
      });
      menu.appendChild(b);
    };

    item('▶  Run selected', null, () => MB.app.runSelection(sel));
    item('⧉  Copy (duplicate) selected', null, () => duplicate(sel, onChanged));
    const sep = document.createElement('div');
    sep.className = 'sep';
    menu.appendChild(sep);
    item('✕  Delete selected', 'danger', () => remove(sel, onChanged));

    menu.classList.remove('hidden');
    menuOpen = true;
    // Keep the menu on screen.
    const r = menu.getBoundingClientRect();
    const x = Math.min(clientX, window.innerWidth - r.width - 8);
    const y = Math.min(clientY, window.innerHeight - r.height - 8);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  /** Duplicate each selected stack, offset so the copy is visible. */
  function duplicate(sel, onChanged) {
    const cx = currentWorkspace;
    const created = [];
    sel.forEach((b) => {
      try {
        const state = Blockly.serialization.blocks.save(b, { addCoordinates: true });
        // Nudge the copy so it does not land exactly on top of the original.
        if (state.x !== undefined) state.x += 28;
        if (state.y !== undefined) state.y += 28;
        const copy = Blockly.serialization.blocks.append(state, cx);
        created.push(copy);
      } catch (err) {
        MB.log('warn', 'could not duplicate a block: ' + err.message);
      }
    });
    set(created);
    if (onChanged) onChanged();
    modals.toast('Duplicated ' + created.length + ' block(s).', 'ok');
  }

  /** Delete each selected stack. The caller re-establishes the start block. */
  function remove(sel, onChanged) {
    const toDelete = sel.slice();
    toDelete.forEach((b) => {
      try {
        b.dispose(true);
      } catch (err) {
        MB.log('warn', 'could not delete a block: ' + err.message);
      }
    });
    clear();
    if (onChanged) onChanged();
  }

  // --------------------------------------------------------- installation

  function install(workspace, callbacks) {
    currentWorkspace = workspace;
    const onChanged = () => callbacks && callbacks.onChanged && callbacks.onChanged();

    // Rubber band: only start on the workspace background, never on a block.
    workspaceHost.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (menuOpen) hideMenu();
      const onBackground =
        e.target === workspaceHost ||
        (e.target.classList && e.target.classList.contains('blocklyMainBackground'));
      if (!onBackground) return;
      e.preventDefault();
      startMarquee(e.clientX, e.clientY);
    });

    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      drag.x1 = e.clientX;
      drag.y1 = e.clientY;
      updateMarquee();
    });

    window.addEventListener('pointerup', (e) => {
      if (!drag) return;
      drag.x1 = e.clientX;
      drag.y1 = e.clientY;
      endMarquee();
    });

    // Right-click: prefer the current marquee selection, otherwise the block
    // under the cursor.
    workspaceHost.addEventListener(
      'contextmenu',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (selection.size === 0) {
          const el = e.target.closest ? e.target.closest('.blocklyDraggable') : null;
          if (el && el.dataset && el.dataset.id) {
            const b = currentWorkspace.getBlockById(el.dataset.id);
            if (b) set([b]);
          }
        }
        showMenu(e.clientX, e.clientY, onChanged);
      },
      true // capture, so Blockly's own menu never appears
    );

    document.addEventListener('pointerdown', (e) => {
      if (menuOpen && !menu.contains(e.target)) hideMenu();
    });
    window.addEventListener('blur', hideMenu);
  }

  MB.marquee = {
    install,
    clear,
    blocks,
    set,
    hideMenu,
    isMenuOpen: () => menuOpen,
  };
})();
