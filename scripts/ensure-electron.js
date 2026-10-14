#!/usr/bin/env node
/**
 * ensure-electron.js
 *
 * WHY THIS EXISTS
 * ---------------
 * npm 11 gates install scripts. When electron's postinstall is skipped, the npm
 * package is present but `node_modules/electron/dist/` is EMPTY, so `npm start`
 * fails with a confusing "Electron failed to install correctly" message even
 * though `npm install` reported success. (This actually happened while building
 * this app.)
 *
 * This script runs before `npm start`, detects that state, and repairs it - first
 * by re-running electron's own installer, then by extracting the binary out of
 * @electron/get's download cache if the network is unavailable but the zip was
 * already fetched.
 *
 * It never throws: if it cannot repair things it prints exactly what to do.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const electronDir = path.join(root, 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const pathTxt = path.join(electronDir, 'path.txt');

const EXE = process.platform === 'win32' ? 'electron.exe' : 'electron';

function log(msg) {
  console.log('[MacroBoard] ' + msg);
}

function installed() {
  if (!fs.existsSync(pathTxt)) return false;
  const rel = fs.readFileSync(pathTxt, 'utf8').trim();
  if (!rel) return false;
  return fs.existsSync(path.join(distDir, rel));
}

/** Newest cached electron zip matching the installed version, if any. */
function cachedZip() {
  try {
    const version = require(path.join(electronDir, 'package.json')).version;
    const cacheRoot = path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache');
    const fallback = path.join(os.homedir(), '.cache', 'electron');
    const roots = [cacheRoot, path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache'), fallback];
    const wanted = 'electron-v' + version + '-' + process.platform + '-' + process.arch + '.zip';
    for (const r of roots) {
      if (!r || !fs.existsSync(r)) continue;
      for (const entry of fs.readdirSync(r)) {
        const candidate = path.join(r, entry, wanted);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch (err) {
    /* fall through */
  }
  return null;
}

function extract(zip) {
  log('extracting the cached Electron binary (no download needed)...');
  fs.mkdirSync(distDir, { recursive: true });
  if (process.platform === 'win32') {
    // Expand-Archive is available on every supported Windows version.
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath "' + zip + '" -DestinationPath "' + distDir + '" -Force'],
      { stdio: 'inherit' }
    );
  } else {
    execFileSync('unzip', ['-o', '-q', zip, '-d', distDir], { stdio: 'inherit' });
  }
  fs.writeFileSync(pathTxt, EXE, 'ascii');
  return installed();
}

function main() {
  if (installed()) return 0;

  log('Electron is installed as an npm package but its binary is missing.');
  log('This happens when npm blocks install scripts (npm 11 "allowScripts").');

  // 1. Ask electron's own installer to fix it (needs network on first run).
  try {
    log('running electron\'s installer...');
    execFileSync(process.execPath, [path.join(electronDir, 'install.js')], { stdio: 'inherit' });
  } catch (err) {
    log('installer failed: ' + err.message);
  }
  if (installed()) {
    log('Electron binary repaired.');
    return 0;
  }

  // 2. Fall back to the local download cache.
  const zip = cachedZip();
  if (zip) {
    try {
      if (extract(zip)) {
        log('Electron binary repaired from the local cache.');
        return 0;
      }
    } catch (err) {
      log('extraction failed: ' + err.message);
    }
  }

  log('');
  log('Could not repair the Electron binary automatically. Try one of:');
  log('  1. npm install --foreground-scripts');
  log('  2. npm install-scripts approve electron   (then npm install)');
  log('  3. node node_modules/electron/install.js');
  log('');
  log('The app cannot start until this is resolved, but `npm test` still works.');
  return 1;
}

process.exit(main());
