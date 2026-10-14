#!/usr/bin/env node
/**
 * verify-native.js
 *
 * Runs after `npm install` to tell the user *up front* whether the native
 * pieces of MacroBoard actually loaded in this environment. Native-binding
 * failures are the single most common install problem for this app, so we
 * report them loudly and clearly instead of letting them surface as a
 * mysterious crash on first launch.
 *
 * This script is intentionally non-fatal: it never exits non-zero, because a
 * partially-native install still lets you edit macros and run the pure-logic
 * test suite.
 */

'use strict';

const path = require('path');

const checks = [
  {
    name: 'blockly',
    probe: () => require.resolve('blockly'),
    fatal: true,
    hint: 'The visual editor cannot be rendered without Blockly.',
  },
  {
    name: '@fainthit/uiohook-napi-suppress (global input detection + key blocking)',
    probe: () => {
      const mod = require('@fainthit/uiohook-napi-suppress');
      if (!mod || typeof mod.uIOhook === 'undefined') {
        throw new Error('module loaded but uIOhook export is missing');
      }
      if (typeof mod.uIOhook.registerSuppress !== 'function') {
        throw new Error('module loaded but registerSuppress is missing');
      }
      console.log('           -> the "sleep" switch can block KEYS (not mouse buttons).');
      return require.resolve('@fainthit/uiohook-napi-suppress');
    },
    fatal: false,
    hint:
      'Global triggers (hold-to-run, press-N-times, pixel trigger listen,' +
      ' record mode) will be disabled, and the "sleep" switch cannot block a' +
      ' key. Mouse/keyboard *actions* still work.',
  },
  {
    name: '@nut-tree-fork/nut-js (input simulation)',
    probe: () => {
      const mod = require('@nut-tree-fork/nut-js');
      if (!mod || !mod.mouse || !mod.keyboard) {
        throw new Error('module loaded but mouse/keyboard exports are missing');
      }
      return require.resolve('@nut-tree-fork/nut-js');
    },
    fatal: false,
    hint:
      'Macros will compile and validate but cannot actually press keys or' +
      ' move the mouse. Re-run `npm install` after installing the' +
      ' "Desktop development with C++" workload from Visual Studio Build Tools.',
  },
];

console.log('\n[MacroBoard] Verifying native / runtime dependencies...\n');

let fatal = 0;
let degraded = 0;

for (const check of checks) {
  try {
    check.probe();
    console.log(`  [ OK ]   ${check.name}`);
  } catch (err) {
    if (check.fatal) {
      fatal++;
      console.log(`  [FAIL]   ${check.name}`);
    } else {
      degraded++;
      console.log(`  [WARN]   ${check.name}`);
    }
    console.log(`           -> ${err.message}`);
    console.log(`           -> ${check.hint}`);
  }
}

const line = '-'.repeat(64);
console.log(`\n${line}`);

if (fatal > 0) {
  console.log('BLOCKING PROBLEMS: the app cannot start in this state.');
} else if (degraded > 0) {
  console.log(
    'Install completed in REDUCED FUNCTIONALITY mode.\n' +
      'MacroBoard will still launch. The main process catches these failures\n' +
      'individually, so any feature that depends on a missing binding is\n' +
      'disabled at runtime and its blocks report a clear error instead of\n' +
      'crashing the app.'
  );
} else {
  console.log('All dependencies verified. Run `npm.cmd start` to launch.');
}

console.log(
  '\nNOTE (Windows): PowerShell blocks `npm.ps1` when the execution policy is\n' +
    'Restricted. If `npm start` refuses to run, use `npm.cmd start`, or run\n' +
    '`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.\n'
);

process.exit(0);
