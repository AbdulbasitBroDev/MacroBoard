#!/usr/bin/env node
/**
 * test-update-feed.js
 *
 * Serves a throwaway update feed so the update flow can be exercised WITHOUT
 * building and installing two real versions.
 *
 * What this does and does not prove:
 *
 *   - It DOES prove detection, the UI, the download, progress reporting and the
 *     "ready to install" state - because `latest.yml` advertises a version that
 *     does not exist on disk yet.
 *   - It does NOT prove `quitAndInstall`. Reinstalling would need a genuine
 *     higher-versioned installer. The `--fake` flag makes this explicit rather
 *     than letting a failed install look like a broken app.
 *
 * Usage:
 *   node scripts/test-update-feed.js <port> [--fake]
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const RELEASE = path.join(__dirname, '..', 'release');
const PORT = Number(process.argv[2]) || 8123;
const FAKE = process.argv.includes('--fake');

/** The real artifact set, or a fabricated next version derived from it. */
function buildFeed() {
  const installer = path.join(RELEASE, 'MacroBoard-Setup-1.0.0.exe');
  if (!fs.existsSync(installer)) return null;

  const bytes = fs.readFileSync(installer);
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  const version = FAKE ? '1.0.1' : '1.0.0';
  const name = 'MacroBoard-Setup-' + version + '.exe';

  // The .blockmap is normally shipped too; a fabricated feed points at a copy of
  // the real one so the download path resolves without a second build.
  const yml = [
    'version: ' + version,
    'files:',
    '  - url: ' + name,
    '    sha512: ' + sha512,
    '    size: ' + bytes.length,
    'path: ' + name,
    'sha512: ' + sha512,
    "releaseDate: '" + new Date().toISOString() + "'",
    '',
  ].join('\n');

  return { version, yml, name, bytes };
}

const feed = buildFeed();
if (!feed) {
  console.error('No installer in release/. Build one first:  npm.cmd run dist');
  process.exit(1);
}

http
  .createServer((req, res) => {
    const name = path.basename(req.url.split('?')[0]);

    if (name === '/' || name === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta charset="utf-8">
<title>MacroBoard test update feed</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:2rem auto;max-width:44rem;color:#222}
code{background:#f2f2f5;padding:2px 6px;border-radius:4px}</style>
<h1>Test update feed</h1>
<p>Advertising <strong>${feed.version}</strong>${FAKE ? ' (fabricated - no real installer behind it)' : ' (real build)'}.</p>
<p>Install version: ${'npm.cmd start'}</p>
<pre><code>$env:MB_UPDATE_FEED_URL = "http://127.0.0.1:${PORT}"
npm.cmd start</code></pre>
<p>Then click <em>Check for updates</em> in the top bar.</p>
<p>Files served: <a href="/latest.yml">latest.yml</a>, <a href="/${feed.name}">${feed.name}</a></p>`);
    }

    if (name === 'latest.yml') {
      res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'Content-Length': Buffer.byteLength(feed.yml) });
      return res.end(feed.yml);
    }

    if (name === feed.name) {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.microsoft.portable-executable',
        'Content-Length': feed.bytes.length,
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(feed.bytes);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Test update feed serving version ${feed.version}${FAKE ? ' (fabricated)' : ''}`);
    console.log(`  $env:MB_UPDATE_FEED_URL = "http://127.0.0.1:${PORT}"`);
    console.log(`  then: npm.cmd start`);
  });
