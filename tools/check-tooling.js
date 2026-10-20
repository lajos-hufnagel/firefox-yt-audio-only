#!/usr/bin/env node
'use strict';
// Local HTTP and process-scope regressions. Never starts a browser or contacts an external server.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { profileFromLog, profilePattern } = require('./browser-processes');
const { crc32 } = require('./package');
const root = path.join(__dirname, '..');
let checks = 0;
function check(name, ok) { assert.ok(ok, name); checks += 1; console.log('  ok ' + name); }
function request(port, pathname, headers = {}, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, headers, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('HTTP test timed out')));
    req.end(body);
  });
}
async function main() {
  check('CRC-32 matches the published check value', crc32(Buffer.from('123456789')) === 0xcbf43926);
  check('quoted copied profile is parsed without dropping path characters',
    profileFromLog('Running Firefox with profile at "/tmp/copy-a.b[1]"\n') === '/tmp/copy-a.b[1]');
  check('unquoted copied profile is parsed unchanged',
    profileFromLog('Running Firefox with profile at /tmp/copy-final\n') === '/tmp/copy-final');
  check('no cleanup pattern without a known profile', profilePattern(null) === null);
  const pattern = profilePattern('/tmp/copy-a.b[1]');
  // POSIX ERE is what pkill uses. Verify its literal path and end boundary using the same regex engine.
  const matches = (text) => spawnSync('/usr/bin/grep', ['-Eq', pattern], { input: text }).status === 0;
  check('cleanup matches only the exact profile argument', matches('firefox -profile /tmp/copy-a.b[1] -headless'));
  check('cleanup does not match a similar profile or a different path',
    !matches('firefox -profile /tmp/copy-a.b[1]-other') && !matches('firefox -profile /tmp/copy-axb1'));
  const unknown = spawnSync(process.execPath, ['spike/mv3-audio-only/smoke/run-mutations.js', 'missing-probe'],
    { cwd: root, encoding: 'utf8', timeout: 2000 });
  check('an unknown mutation name cannot silently pass', unknown.status === 1 && unknown.stderr.includes('Unknown probe'));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-only-http-test-'));
  const server = spawn(process.execPath, ['spike/mv3-audio-only/browser-proof/server.js'], {
    cwd: root, env: { ...process.env, PORT: '0', OUT: path.join(work, 'nested/report.ndjson') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Collector did not start')), 3000);
      const fail = (error) => { clearTimeout(timer); reject(error); };
      server.once('error', fail);
      server.once('exit', (code) => fail(new Error('Collector exited: ' + code)));
      server.stdout.on('data', (chunk) => {
        const m = /proof server on (\d+)/.exec(String(chunk));
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
    });
    const audio = await request(port, '/audio.wav');
    check('the standalone collector serves a valid-sized WAV', audio.status === 200 && audio.body.length === 480044);
    const partial = await request(port, '/audio.wav', { Range: 'bytes=0-3' });
    check('byte ranges have matching headers and body', partial.status === 206 &&
      partial.body.toString() === 'RIFF' && partial.headers['content-range'] === 'bytes 0-3/480044');
    const suffix = await request(port, '/audio.wav', { Range: 'bytes=-8' });
    check('suffix ranges are handled', suffix.status === 206 && suffix.body.length === 8);
    for (const range of ['garbage', 'bytes=20-10', 'bytes=999999-', 'bytes=-0', 'bytes=-']) {
      const bad = await request(port, '/audio.wav', { Range: range });
      check('invalid range is refused without crashing: ' + range, bad.status === 416);
    }
    const oversized = await request(port, '/audio.wav', { Range: 'bytes=480040-999999' });
    check('range end is clamped to the resource', oversized.status === 206 && oversized.body.length === 4);
    const invalid = await request(port, '/report', {}, 'POST', 'broken JSON');
    check('malformed reports cannot corrupt the NDJSON log', invalid.status === 400);
    const valid = await request(port, '/report', {}, 'POST', '{\n"phase":"test"\n}');
    check('reports are normalized to one JSON line', valid.status === 204 &&
      fs.readFileSync(path.join(work, 'nested/report.ndjson'), 'utf8') === '{"phase":"test"}\n');
    const options = await request(port, '/report', {}, 'OPTIONS');
    check('collector answers the preflight', options.status === 204);
    const missing = await request(port, '/missing');
    check('unknown resource stays a 404', missing.status === 404);
  } finally {
    if (server.exitCode === null) {
      await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
    }
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('\n' + checks + '/' + checks + ' checks passed');
}
main().catch((error) => { console.error(error.stack); process.exitCode = 1; });
