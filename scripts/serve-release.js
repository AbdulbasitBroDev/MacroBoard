#!/usr/bin/env node
/**
 * serve-release.js
 *
 * Serves release/ over plain HTTP so the built installer can be downloaded
 * through a real browser before it is published anywhere.
 *
 * This matters: a file opened straight off disk has no Mark-of-the-Web, so
 * Windows treats it differently. Downloading it - even from localhost - is what
 * stamps it, and therefore what makes the SmartScreen prompt appear. Testing by
 * double-clicking the .exe directly will not reproduce it.
 *
 * Usage:  node scripts/serve-release.js [port]
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'release');
const PORT = Number(process.argv[2]) || 8000;

const TYPES = {
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.blockmap': 'application/octet-stream',
  '.yml': 'text/plain; charset=utf-8',
};

const HIDE = new Set(['builder-debug.yml', 'builder-effective-config.yaml']);

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function listing(entries, hashes) {
  const rows = entries
    .map((name) => {
      const size = fs.statSync(path.join(ROOT, name)).size;
      const sum = hashes.get(name) || 'computing...';
      return `<tr>
        <td><a href="/${encodeURIComponent(name)}" download>${escapeHtml(name)}</a></td>
        <td>${(size / 1048576).toFixed(1)} MB</td>
        <td class="sum"><code>${escapeHtml(sum)}</code></td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<meta charset="utf-8">
<title>MacroBlock downloads (local test)</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; color: #222; }
  h1 { font-size: 1.4rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: .5rem; border-bottom: 1px solid #ddd; }
  th { font-size: .8rem; text-transform: uppercase; color: #666; }
  .sum code { font-size: .7rem; word-break: break-all; color: #555; }
  .warn { background: #fff6e0; border-left: 4px solid #e8a33d; padding: .8rem; margin: 1.2rem 0; }
</style>
<h1>MacroBlock downloads <small>(local test server)</small></h1>
<div class="warn">
  Download one of these with the <strong>browser</strong>, then run it.
  Do not open the file straight off disk - only a downloaded copy carries the
  Mark-of-the-Web, and that is what produces the Windows SmartScreen prompt.
</div>
<table>
  <tr><th>File</th><th>Size</th><th>SHA-256</th></tr>
  ${rows}
</table>`;
}

if (!fs.existsSync(ROOT)) {
  console.error(`No release/ directory found at ${ROOT}`);
  console.error('Build it first:  npm.cmd run dist');
  process.exit(1);
}

// Files only. release/ also contains the win-unpacked/ directory, and handing
// that to readFileSync throws EISDIR and takes the whole server down.
const entries = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isFile() && !d.name.startsWith('.') && !HIDE.has(d.name))
  .map((d) => d.name);

async function main() {
  const hashes = new Map();
  await Promise.all(
    entries.map((name) => sha256(path.join(ROOT, name)).then((h) => hashes.set(name, h)))
  );

  http
    .createServer((req, res) => {
      const name = path.basename(decodeURIComponent(req.url.split('?')[0]));

      if (name === '/' || name === '') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(listing(entries, hashes));
      }

      const file = path.join(ROOT, name);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }

      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': fs.statSync(file).size,
      });

      // A HEAD response carries headers only; piping a body would corrupt the
      // next keep-alive request on the connection.
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    })
    .listen(PORT, '127.0.0.1', () => {
      console.log(`Serving ${entries.length} file(s) from ${ROOT}`);
      console.log(`Open  http://127.0.0.1:${PORT}/`);
    });
}

main();
