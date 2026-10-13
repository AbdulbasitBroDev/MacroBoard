#!/usr/bin/env node
'use strict';

/**
 * test-autoupdate.js
 *
 * Proves auto-update works, end to end, on this machine, with nothing published.
 *
 * The honest version of this question is "does an installed MacroBlock actually
 * replace itself with a newer one". Detecting a version is not that; it is the
 * easy half. So this script does the whole thing:
 *
 *   1. point the build at a loopback feed
 *   2. build v1.0.0 and install it silently
 *   3. bump to 1.0.1 and rebuild
 *   4. serve those artifacts on the loopback feed
 *   5. launch the INSTALLED v1.0.0 and let it find, download and install 1.0.1
 *   6. assert the installed exe's FileVersion is now 1.0.1
 *
 * Step 6 is the proof. Everything before it can look fine while the app never
 * really replaced itself.
 *
 * Uninstalls and restores package.json on the way out, including on failure.
 *
 * Usage: node scripts/test-autoupdate.js
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const RELEASE = path.join(ROOT, 'release');
const INSTALL_DIR_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'MacroBlock'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'MacroBlock'),
];
const PORT = Number(process.argv[2]) || 8124;
const FEED = 'http://127.0.0.1:' + PORT;
const LOG_DIR = path.join(process.env.APPDATA || '', 'MacroBlock', 'logs');

/**
 * Where the installer actually put things. electron-builder's default
 * RequestExecutionLevel is `highest`, so an administrator account silently gets a
 * per-machine install in Program Files while a standard user gets one under
 * LOCALAPPDATA. The script must not care which.
 */
function findInstallDir() {
  return INSTALL_DIR_CANDIDATES.find((d) => fs.existsSync(path.join(d, 'MacroBlock.exe'))) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const say = (m) => console.log('  ' + m);
const next = (m) => console.log('\n[' + String(++step).padStart(2, '0') + '] ' + m);

function fileVersion(exe) {
  // electron-builder stamps package.json's version into the exe's resources.
  const ps = '$v=(Get-Item "' + exe + '").VersionInfo; if ($v) { $v.FileVersion }';
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

/** electron-builder is a .cmd on Windows, so this one does need a shell. */
function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ cwd: ROOT, encoding: 'utf8', shell: true }, opts));
  if (r.status !== 0) throw new Error((cmd + ' failed:\n' + (r.stdout || '') + (r.stderr || '')).slice(-1500));
  return r;
}

/** Launch an NSIS installer. The path must NOT be quoted here: this runs with
 *  shell:false, where quotes become literal characters in the filename and the
 *  spawn fails with a confusing non-zero status instead of an ENOENT. */
function runInstaller(exe) {
  const r = spawnSync(exe, ['/S'], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
  if (r.error) throw r.error;
  // NSIS /S does not always propagate a meaningful exit code, so success is
  // judged by whether the app appeared, not by this number.
  return r.status;
}

function build() {
  const started = Date.now();
  // nsis only: the portable build cannot self-update and only costs time here.
  run('npx', ['electron-builder', '--win', 'nsis', '--publish', 'never'], { timeout: 30 * 60 * 1000 });
  say('built in ' + Math.round((Date.now() - started) / 1000) + 's');
}

function setPkg(mutate) {
  const raw = fs.readFileSync(PKG, 'utf8');
  const json = JSON.parse(raw);
  mutate(json);
  fs.writeFileSync(PKG, JSON.stringify(json, null, 2) + '\n');
  return json;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function readLog() {
  try {
    return fs.readFileSync(path.join(LOG_DIR, 'macroblock.log'), 'utf8');
  } catch (e) {
    return '';
  }
}

/** Start a static server over release/ and return a stop function. */
function serveRelease() {
  const TYPES = { '.exe': 'application/vnd.microsoft.portable-executable', '.blockmap': 'application/octet-stream', '.yml': 'text/yaml' };
  const server = http.createServer((req, res) => {
    const name = path.basename(req.url.split('?')[0]);
    const file = path.join(RELEASE, name);
    if (!file.startsWith(RELEASE) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end('not found');
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });
  server.listen(PORT, '127.0.0.1');
  return () => server.close();
}

function killApp() {
  spawnSync('powershell', ['-NoProfile', '-Command',
    "Get-Process -Name MacroBlock,electron -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue"], { encoding: 'utf8' });
}

function uninstall() {
  const dir = findInstallDir();
  if (!dir) { say('no install found, nothing to uninstall'); return; }
  const uninstaller = path.join(dir, 'Uninstall MacroBlock.exe');
  if (!fs.existsSync(uninstaller)) { say('no uninstaller in ' + dir); return; }
  runInstaller(uninstaller);
  say('uninstalled from ' + dir);
  killApp();
}

async function main() {
  const original = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const results = [];
  let stopServer = null;

  try {
    killApp();

    next('Aim the build at the loopback feed, at version 1.0.0');
    setPkg((j) => {
      j.version = '1.0.0';
      j.build.publish.url = FEED;
    });
    say('publish.url = ' + FEED);

    next('Build v1.0.0');
    build();

    next('Install v1.0.0 silently (this is the app that will update itself)');
    const installer = path.join(RELEASE, 'MacroBlock-Setup-1.0.0.exe');
    if (!fs.existsSync(installer)) throw new Error('installer missing: ' + installer);
    runInstaller(installer);
    // The installer launches the app when it finishes; that instance would
    // pre-empt the real test, so it goes before anything else happens.
    await sleep(4000);
    killApp();

    let dir = null;
    for (let i = 0; i < 60 && !dir; i++) { dir = findInstallDir(); if (!dir) await sleep(1000); }
    if (!dir) throw new Error('install did not produce MacroBlock.exe in ' + INSTALL_DIR_CANDIDATES.join(' or '));
    const installedExe = path.join(dir, 'MacroBlock.exe');
    say('installed to ' + dir);
    const v0 = fileVersion(installedExe);
    say('installed exe FileVersion = ' + v0);
    results.push(['installed v1.0.0', v0 === '1.0.0', v0]);

    next('Bump to 1.0.1 and rebuild');
    setPkg((j) => { j.version = '1.0.1'; });
    build();
    if (!fs.existsSync(path.join(RELEASE, 'latest.yml'))) throw new Error('latest.yml not produced');
    const yml = fs.readFileSync(path.join(RELEASE, 'latest.yml'), 'utf8');
    say('feed advertises ' + (yml.match(/^version:\s*(.+)$/m) || [])[1]);

    next('Serve the feed on ' + FEED);
    stopServer = serveRelease();
    await sleep(800);
    const served = await fetchText(FEED + '/latest.yml');
    if (!/version:\s*1\.0\.1/.test(served)) throw new Error('feed does not advertise 1.0.1');
    say('latest.yml served, advertises 1.0.1');

    next('Launch the INSTALLED 1.0.0 and let it update itself');
    try { fs.unlinkSync(path.join(LOG_DIR, 'macroblock.log')); } catch (e) { /* no prior log */ }
    const child = spawn(installedExe, [], { detached: true, stdio: 'ignore' });
    // Without a listener a failed spawn throws as an unhandled 'error' event and
    // kills the process instead of reaching the catch below.
    child.on('error', (err) => { say('launch failed: ' + err.message); });
    child.unref();
    let sawDownloading = false, sawDownloaded = false;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const log = readLog();
      if (!/update: checking/.test(log)) continue;
      if (/update: downloading/.test(log)) sawDownloading = true;
      if (/update: downloaded/.test(log)) { sawDownloaded = true; break; }
    }
    say('log: ' + (readLog().match(/update:[^\n]*/g) || ['<nothing>']).join(' | '));
    results.push(['updater reported a download', sawDownloading, String(sawDownloading)]);
    results.push(['updater reported update downloaded', sawDownloaded, String(sawDownloaded)]);

    next('Wait for the silent install to finish and relaunch');
    let v1 = null;
    const installDeadline = Date.now() + 180000;
    while (Date.now() < installDeadline) {
      await sleep(3000);
      v1 = fileVersion(installedExe);
      if (v1 === '1.0.1') break;
    }
    say('installed exe FileVersion = ' + v1);
    results.push(['installed exe is now 1.0.1', v1 === '1.0.1', v1]);
    results.push(['app relaunched after installing', /MacroBlock starting/.test(readLog()), '']);

    console.log('\n--------------------------------------------------------------');
    let allPass = true;
    for (const [name, pass, detail] of results) {
      if (!pass) allPass = false;
      console.log('  ' + (pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  (' + detail + ')' : ''));
    }
    console.log('--------------------------------------------------------------');
    console.log(allPass ? '\nAUTO-UPDATE WORKS END TO END.\n' : '\nAUTO-UPDATE DID NOT COMPLETE.\n');
    process.exitCode = allPass ? 0 : 1;
  } catch (err) {
    console.error('\nFAILED: ' + err.message);
    console.error('\n--- app log ---\n' + readLog().split('\n').slice(-25).join('\n'));
    process.exitCode = 1;
  } finally {
    killApp();
    if (stopServer) stopServer();
    fs.writeFileSync(PKG, JSON.stringify(original, null, 2) + '\n');
    console.log('package.json restored (version ' + original.version + ')');
    try { uninstall(); } catch (e) { console.log('uninstall skipped: ' + e.message); }
    await sleep(2000);
    killApp();
  }
}

main();
