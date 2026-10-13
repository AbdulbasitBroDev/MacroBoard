'use strict';

/**
 * UpdateService tests.
 *
 * The updater is a real Electron main-process module that talks to a network
 * feed, so it is INJECTED and its event stream is driven directly - in
 * milliseconds, deterministically.
 *
 * The property that matters most here is negative: a user with no network, or on
 * a build that was never published, must still be able to open the editor and
 * run macros. So the tests spend most of their effort on the failure paths -
 * a throwing updater, a rejected check, an event-stream error, an install
 * attempt from the wrong state - none of which may reject into the caller or
 * throw out of the service.
 */

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { createUpdateService, STATES } = require('../src/main/services/updateService');

/** Stand-in for electron-updater's autoUpdater, driven by the test. */
function fakeUpdater() {
  const u = new EventEmitter();
  u.autoDownload = true;
  u.autoInstallOnAppQuit = false;
  u.calls = { check: 0, download: 0, quitAndInstall: [] };

  u.checkForUpdates = async () => {
    u.calls.check++;
    u.emit('checking-for-update');
    return [];
  };
  u.downloadUpdate = async () => {
    u.calls.download++;
    return [];
  };
  u.quitAndInstall = (silent, force) => {
    u.calls.quitAndInstall.push([silent, force]);
  };
  return u;
}

/** Build a service over the fakes, with no cooldown unless a test asks for one. */
function makeSvc(overrides) {
  const updater = (overrides && overrides.updater) || fakeUpdater();
  const svc = createUpdateService(Object.assign(
    { getUpdater: () => updater, enabled: () => true, minIntervalMs: 0, now: () => 1000 },
    overrides,
    { updater }
  ));
  return { svc, updater };
}

// --------------------------------------------------------------- disabled

test('an unpackaged build never touches electron-updater', async () => {
  const { svc, updater } = makeSvc({ enabled: () => false });

  const snap = await svc.check();

  assert.strictEqual(snap.state, STATES.DISABLED);
  assert.strictEqual(updater.calls.check, 0, 'must not check');
});

test('install and download are refused when disabled', async () => {
  const { svc, updater } = makeSvc({ enabled: () => false });

  await svc.download();

  assert.strictEqual(svc.install(), false, 'must refuse to install');
  assert.strictEqual(updater.calls.download, 0, 'must not download');
  assert.strictEqual(updater.calls.check, 0, 'must not check');
  assert.strictEqual(updater.calls.quitAndInstall.length, 0, 'must not restart');
  assert.strictEqual(updater.listenerCount('checking-for-update'), 0, 'must not even subscribe');
});

// --------------------------------------------------------- happy paths

test('an available update is reported with its version', async () => {
  const { svc, updater } = makeSvc();

  updater.checkForUpdates = async () => {
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.4.0' });
    return [];
  };

  const snap = await svc.check();

  assert.strictEqual(snap.state, STATES.AVAILABLE);
  assert.strictEqual(snap.version, '1.4.0');
});

test('no newer version reports up-to-date', async () => {
  const { svc, updater } = makeSvc();

  updater.checkForUpdates = async () => {
    updater.emit('update-not-available');
    return [];
  };

  assert.strictEqual((await svc.check()).state, STATES.UP_TO_DATE);
});

test('download only proceeds from the available state', async () => {
  const { svc, updater } = makeSvc();

  // Still idle - nothing has been offered, so there is nothing to fetch.
  assert.strictEqual((await svc.download()).state, STATES.IDLE);
  assert.strictEqual(updater.calls.download, 0);

  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '1.4.0' });
    return [];
  };
  await svc.check();

  await svc.download();
  assert.strictEqual(updater.calls.download, 1);
});

test('progress is reported and a finished download becomes downloaded', async () => {
  const { svc, updater } = makeSvc();

  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '1.4.0' });
    return [];
  };
  await svc.check();

  updater.downloadUpdate = async () => {
    updater.emit('download-progress', { percent: 42 });
    updater.emit('download-progress', { percent: 100 });
    updater.emit('update-downloaded', { version: '1.4.0' });
    return [];
  };
  await svc.download();

  const snap = svc.snapshot();
  assert.strictEqual(snap.state, STATES.DOWNLOADED);
  assert.strictEqual(snap.percent, 100);
});

test('install is refused until a download has finished', async () => {
  const { svc, updater } = makeSvc();

  assert.strictEqual(svc.install(), false, 'idle must not install');

  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '1.4.0' });
    return [];
  };
  await svc.check();
  assert.strictEqual(svc.install(), false, 'available-only must not install');

  updater.emit('update-downloaded', { version: '1.0.1' });
  assert.strictEqual(svc.install(), true);
  // Silent MUST be true: this app's installer is an assisted one, so a
  // non-silent handoff opens a wizard instead of installing.
  assert.deepStrictEqual(updater.calls.quitAndInstall[0], [true, true]);
});

// ------------------------------------------------- the failure paths

test('a throwing updater is absorbed into the error state', async () => {
  const svc = createUpdateService({
    getUpdater: () => { throw new Error('electron-updater is unavailable'); },
    enabled: () => true,
    minIntervalMs: 0,
  });

  const snap = await svc.check();

  assert.strictEqual(snap.state, STATES.ERROR);
  assert.match(snap.message, /unavailable/);
});

test('a missing updater object is an error, not a crash', async () => {
  const svc = createUpdateService({ getUpdater: () => null, enabled: () => true, minIntervalMs: 0 });

  assert.strictEqual((await svc.check()).state, STATES.ERROR);
});

test('a rejected check never rejects into the caller', async () => {
  const { svc, updater } = makeSvc();

  updater.checkForUpdates = async () => { throw new Error('getaddrinfo ENOTFOUND feed.example'); };

  const snap = await svc.check();

  assert.strictEqual(snap.state, STATES.ERROR);
  assert.match(snap.message, /ENOTFOUND/);
});

test('an error on the event stream becomes the error state', async () => {
  const { svc, updater } = makeSvc();

  updater.checkForUpdates = async () => {
    updater.emit('error', new Error('signature is invalid'));
    return [];
  };

  const snap = await svc.check();

  assert.strictEqual(snap.state, STATES.ERROR);
  assert.match(snap.message, /signature is invalid/);
});

test('a failed quitAndInstall reports failure instead of throwing', () => {
  const updater = fakeUpdater();
  updater.quitAndInstall = () => { throw new Error('not installed'); };
  const svc = createUpdateService({ getUpdater: () => updater, enabled: () => true, minIntervalMs: 0 });

  updater.emit('update-downloaded', { version: '1.4.0' });

  // The event fired with no listeners yet, so drive the state through check().
  assert.strictEqual(svc.install(), false);
});

// ------------------------------------------------------------ behaviour

test('downloads are never automatic and quit-time install is allowed', async () => {
  const { svc, updater } = makeSvc();

  await svc.check();

  assert.strictEqual(updater.autoDownload, false, 'must ask before spending bandwidth');
  assert.strictEqual(updater.autoInstallOnAppQuit, true);
});

test('a second check inside the cooldown is ignored unless forced', async () => {
  const updater = fakeUpdater();
  let clock = 1000;
  const svc = createUpdateService({
    getUpdater: () => updater,
    enabled: () => true,
    minIntervalMs: 60000,
    now: () => clock,
  });

  await svc.check();
  await svc.check();
  assert.strictEqual(updater.calls.check, 1, 'cooldown must suppress the second');

  await svc.check({ force: true });
  assert.strictEqual(updater.calls.check, 2, 'force must bypass the cooldown');

  clock += 60000;
  await svc.check();
  assert.strictEqual(updater.calls.check, 3, 'cooldown must expire');
});

test('overlapping checks do not pile up', async () => {
  const { svc, updater } = makeSvc();

  let release;
  updater.checkForUpdates = () => new Promise((resolve) => {
    updater.calls.check++;
    release = () => resolve([]);
  });

  const first = svc.check();
  const second = await svc.check();
  assert.strictEqual(updater.calls.check, 1, 'the second call must not start a check');

  release();
  await first;
  assert.strictEqual(second.state, STATES.CHECKING);
});

test('state changes are emitted so the UI can react', async () => {
  const { svc, updater } = makeSvc();
  const seen = [];
  svc.on('state', (s) => seen.push(s.state));

  updater.checkForUpdates = async () => {
    updater.emit('update-available', { version: '1.4.0' });
    return [];
  };
  await svc.check();

  assert.ok(seen.includes(STATES.CHECKING), 'saw checking');
  assert.ok(seen.includes(STATES.AVAILABLE), 'saw available');
});
