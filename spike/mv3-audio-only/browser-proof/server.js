#!/usr/bin/env node
// Part of the real-Firefox proof stand (see README, "Checking it in the browser"): serves the stub page
// and appends every report the page and the injected probe send as one NDJSON line. Started by run.sh;
// everything it writes lands in the work folder, never in the project folder.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 30 s of digital silence as a WAV: a real, decodable audio-only stream for the takeover step.
const WAV = (() => {
  const seconds = 30, rate = 8000, channels = 1, bits = 16;
  const dataLength = seconds * rate * channels * (bits / 8);
  const b = Buffer.alloc(44 + dataLength);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLength, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * (bits / 8), 28);
  b.writeUInt16LE(channels * (bits / 8), 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36); b.writeUInt32LE(dataLength, 40);
  return b;
})();
function wav() { return WAV; }

const WORK = path.join(os.tmpdir(), 'audio-only-browser-proof');
const PORT = Number(process.env.PORT || 8791);
const OUT = process.env.OUT || path.join(WORK, 'report.ndjson');
const PAGE = path.join(__dirname, 'stub-page.html');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, '');
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*',
      'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' }).end();
    return;
  }
  if (req.method === 'POST' && req.url.indexOf('/report') === 0) {
    let body = '';
    let bytes = 0;
    req.on('data', (c) => {
      bytes += c.length;
      if (bytes > 1024 * 1024) { res.writeHead(413).end(); req.destroy(); return; }
      body += c;
    });
    req.on('end', () => {
      if (bytes > 1024 * 1024) return;
      try { body = JSON.stringify(JSON.parse(body)); }
      catch (e) { res.writeHead(400).end('invalid JSON'); return; }
      fs.appendFileSync(OUT, body + '\n');
      console.log('REPORT ' + body.trim());
      res.writeHead(204, { 'access-control-allow-origin': '*',
        'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }).end();
    });
    return;
  }
  if (req.url.indexOf('/audio.wav') === 0) {
    // A real, playable audio-only file for the takeover step: 30 s of silence, 8 kHz mono, 16 bit.
    // Generated here so the proof needs no external media and no codec questions.
    const bytes = wav();
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = m && m[1] ? Number(m[1]) : 0;
      let end = m && m[2] ? Number(m[2]) : bytes.length - 1;
      if (m && !m[1] && m[2]) {
        start = Math.max(0, bytes.length - Number(m[2])); end = bytes.length - 1;
      }
      end = Math.min(end, bytes.length - 1);
      if (!m || (!m[1] && !m[2]) || start >= bytes.length || start > end || (!m[1] && m[2] === '0')) {
        res.writeHead(416, { 'content-range': 'bytes */' + bytes.length }).end(); return;
      }
      res.writeHead(206, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes',
        'content-range': 'bytes ' + start + '-' + end + '/' + bytes.length,
        'content-length': end - start + 1, 'access-control-allow-origin': '*' });
      res.end(bytes.slice(start, end + 1));
      return;
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes',
      'content-length': bytes.length, 'access-control-allow-origin': '*' });
    res.end(bytes);
    return;
  }
  if (req.url === '/' || req.url.indexOf('/stub-page.html') === 0) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(PAGE));
    return;
  }
  res.writeHead(404, { 'access-control-allow-origin': '*' }).end('no');
});
server.listen(PORT, '127.0.0.1', () => console.log('proof server on ' + server.address().port + ' -> ' + OUT));
