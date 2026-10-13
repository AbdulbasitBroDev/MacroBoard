'use strict';

/**
 * updateBanner
 *
 * Surfaces update state to the user. The main process pushes `mb:update:state`;
 * this renders it into a small bar in the bottom-left corner.
 *
 * Deliberate choices:
 *
 *   - **Never on launch paths that matter.** The bar only appears once the main
 *     process has *reported a state*. A failed check is a quiet toast, not a bar,
 *     because a user who is offline should never be nagged about a version they
 *     cannot install.
 *
 *   - **Never auto-install.** A restart destroys whatever the user was doing, so
 *     "Restart now" is always a click.
 *
 *   - **"Later" sticks until the version changes.** Dismissing v1.4.0 must not
 *     make the same offer reappear every launch; seeing v1.5.0 re-opens it.
 */

const MB = window.MB;
const api = window.mb;

let dismissedFor = '';
let current = { state: 'idle', version: '', percent: 0, message: '' };

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

let root = null;
let textNode = null;
let actions = null;

function ensureRoot() {
  if (root) return;
  root = el('div', 'update-bar');
  root.hidden = true;
  textNode = el('span', 'update-text');
  actions = el('div', 'update-actions');
  root.appendChild(textNode);
  root.appendChild(actions);
  document.body.appendChild(root);
}

function button(label, className, onClick) {
  const b = el('button', className, label);
  b.addEventListener('click', onClick);
  return b;
}

function hide() {
  if (root) root.hidden = true;
}

/** Render whatever the current state means, if it is worth saying out loud. */
function render() {
  ensureRoot();
  actions.replaceChildren();
  root.hidden = true;

  if (current.state === 'available' && current.version !== dismissedFor) {
    textNode.textContent = 'MacroBlock ' + current.version + ' is available.';
    actions.appendChild(button('Download', 'primary', async () => {
      await api.update.download();
    }));
    actions.appendChild(button('Later', '', () => {
      dismissedFor = current.version;
      hide();
    }));
    root.hidden = false;
    return;
  }

  if (current.state === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(current.percent || 0)));
    textNode.textContent = 'Downloading update - ' + pct + '%';
    root.hidden = false;
    return;
  }

  if (current.state === 'downloaded') {
    if (current.version === dismissedFor) return;
    textNode.textContent = 'MacroBlock ' + current.version + ' is ready to install.';
    actions.appendChild(button('Restart now', 'primary', async () => {
      const res = await api.update.install();
      if (!res || !res.starting) {
        MB.modals.toast('Could not start the installer. Restart MacroBlock and try again.', 'error');
      }
    }));
    actions.appendChild(button('Later', '', () => {
      dismissedFor = current.version;
      hide();
    }));
    root.hidden = false;
    return;
  }

  // A failed check is not the user's problem, so it is a passing message only.
  if (current.state === 'error' && current.message) {
    MB.modals.toast('Could not check for updates: ' + current.message, 'warn', 6000);
  }
}

/** Manual check, used by the Help menu. Reports up-to-date out loud. */
async function checkNow() {
  const res = await api.update.check({ force: true });
  current = {
    state: res && res.state ? res.state : 'idle',
    version: res && res.version ? res.version : '',
    percent: res && res.percent ? res.percent : 0,
    message: res && res.message ? res.message : '',
  };
  if (current.state === 'up-to-date') MB.modals.toast('MacroBlock is up to date.', 'ok');
  if (current.state === 'disabled') MB.modals.toast('Automatic updates only apply to the installed app.', 'warn');
  render();
  return current;
}

function init() {
  ensureRoot();
  api.onUpdateState((state) => {
    current = state || current;
    render();
  });
  // Re-render on load in case a check finished before this listener attached.
  api.update.state().then((res) => {
    if (res && res.state) {
      current = { state: res.state, version: res.version || '', percent: res.percent || 0, message: res.message || '' };
      render();
    }
  });
}

MB.updates = { checkNow };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
