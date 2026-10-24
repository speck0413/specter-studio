// A stand-in for GitHub's release API (the default firmware release source), so the UI tests never reach the
// internet: the bridge runs with SPECTER_GITHUB_API pointing here (the repository is specter-proptroller; its old
// name spectre-proptroller answers with a redirect, as GitHub does after a rename). One published release, 0.1.9, with an update image
// for ESP32 boards only (practice boards are not offered an update by it) and USB images for ESP32 and Pico W.
import http from 'node:http';
import { createHash } from 'node:crypto';

const port = Number(process.argv[2] || 18793);
const base = `http://127.0.0.1:${port}`;
const img = Buffer.from('stand-in firmware image');
const first = Buffer.from('stand-in first-flash image');
const sha = (b) => createHash('sha256').update(b).digest('hex');
// first-flash (USB) images are listed too, after the update image, as a real release does (never downloaded here)
const manifest = { version: '0.1.9', images: [{ fw: 'generic', impl: 'cpp', mcu: 'esp32-devkit', file: 'generic-esp32-0.1.9.bin', bytes: img.length, sha256: sha(img) },
  { fw: 'generic', impl: 'cpp', mcu: 'esp32-devkit', file: 'first-flash-esp32-devkit-0.1.9.bin', bytes: first.length, sha256: sha(first), first_flash: true },
  { fw: 'generic', impl: 'cpp', mcu: 'pico-w', file: 'first-flash-pico-w-0.1.9.uf2', bytes: first.length, sha256: sha(first), first_flash: true }] };
const releases = [{ tag_name: 'v0.1.9', draft: false, prerelease: false, html_url: 'https://github.com/speck0413/specter-proptroller/releases/tag/v0.1.9', assets: [
  { name: 'proptroller-firmware.json', browser_download_url: `${base}/dl/v0.1.9/proptroller-firmware.json` },
  { name: 'generic-esp32-0.1.9.bin', browser_download_url: `${base}/dl/v0.1.9/generic-esp32-0.1.9.bin` }] }];

http.createServer((req, res) => {
  const path = (req.url || '').split('?')[0];
  const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
  if (path === '/repos/speck0413/specter-proptroller/releases') return send(200, JSON.stringify(releases));
  // the repository's old name: GitHub answers with a permanent redirect to the renamed one
  if (path === '/repos/speck0413/spectre-proptroller/releases') { res.writeHead(301, { Location: `${base}/repos/speck0413/specter-proptroller/releases${(req.url || '').includes('?') ? '?' + req.url.split('?')[1] : ''}` }); return res.end(); }
  if (path === '/dl/v0.1.9/proptroller-firmware.json') return send(200, JSON.stringify(manifest));
  if (path === '/dl/v0.1.9/generic-esp32-0.1.9.bin') return send(200, img, 'application/octet-stream');
  send(404, '{"message":"Not Found"}');
}).listen(port, '127.0.0.1');
