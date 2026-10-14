'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMacroStore } = require('../src/main/services/macroStore');

test('macro shortcuts persist and invalid button ids are discarded', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'MacroBoard-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createMacroStore({ dir });
  const saved = store.save({
    name: 'Shortcut macro',
    start: { kind: 'manual' },
    steps: [{ type: 'typeText', text: 'saved body' }],
    shortcuts: {
      mode: 'separate',
      arm: ['key:LeftControl', 'key:W'],
      disarm: ['key:LeftControl', 'invalid'],
    },
  });

  const reopened = createMacroStore({ dir }).get(saved.id);
  assert.deepStrictEqual(reopened.shortcuts, {
    mode: 'separate',
    arm: ['key:LeftControl', 'key:W'],
    disarm: ['key:LeftControl'],
  });
  assert.deepStrictEqual(createMacroStore({ dir }).shortcutMacros(), [{
    id: saved.id,
    name: 'Shortcut macro',
    start: { kind: 'manual' },
    steps: [{ type: 'typeText', text: 'saved body' }],
    shortcuts: reopened.shortcuts,
  }]);
});
/**
 * Settings are the FIRST consumer of getSettings/setSettings, which shipped with
 * the store but had never been called by anything. The record mode is written
 * through them, so the merge behaviour matters: writing one key must not erase
 * another.
 */
test('settings persist and survive a reopen', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'MacroBoard-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createMacroStore({ dir });
  assert.deepStrictEqual(store.getSettings(), {}, 'settings start empty, not undefined');

  store.setSettings({ recordMode: 'keybind' });
  assert.deepStrictEqual(createMacroStore({ dir }).getSettings(), { recordMode: 'keybind' });
});

test('setSettings MERGES rather than replacing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'MacroBoard-settings2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createMacroStore({ dir });
  store.setSettings({ recordMode: 'text' });
  store.setSettings({ somethingElse: 42 });

  const settings = createMacroStore({ dir }).getSettings();
  assert.deepStrictEqual(settings, { recordMode: 'text', somethingElse: 42 },
    'writing one key must not clobber the others');
});

test('changing the record mode does not disturb the other one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'MacroBoard-settings3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createMacroStore({ dir });
  store.setSettings({ recordMode: 'text' });
  store.setSettings({ recordMode: 'keybind' });
  assert.strictEqual(createMacroStore({ dir }).getSettings().recordMode, 'keybind');
});

test('getSettings hands back a copy, so callers cannot mutate the store', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'MacroBoard-settings4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const store = createMacroStore({ dir });
  store.setSettings({ recordMode: 'text' });
  const grabbed = store.getSettings();
  grabbed.recordMode = 'keybind';
  assert.strictEqual(store.getSettings().recordMode, 'text', 'must not be a live reference');
});
