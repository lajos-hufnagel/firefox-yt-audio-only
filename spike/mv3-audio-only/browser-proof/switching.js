#!/usr/bin/env node
// Prints the SWITCHING part of a proof run: what enable/disable reported and what the extension says
// afterwards. This is the part behind the README table rows for `resolver-stub ?full=1` and
// `fixed ?full=1`. Run: node switching.js resolver-stub   (or: node switching.js fixed ?full=1)
const fs = require('fs');
const os = require('os');
const path = require('path');
const WORK = process.env.WORK || path.join(os.tmpdir(), 'audio-only-browser-proof');
const variant = process.argv[2] || 'resolver-stub';
const file = path.join(WORK, 'report-' + variant + '.ndjson');
if (!fs.existsSync(file)) {
  console.error('no report at ' + file + ' - run ./run.sh ' + variant + ' "?full=1" first');
  process.exit(1);
}
const L = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

function brief(s) {
  if (!s) return null;
  const e = s.element || {};
  return {
    mode: s.mode, verified: s.verified, verifyMethod: s.verifyMethod, epoch: s.epoch,
    position: s.position,
    applied: s.applied && { itag: s.applied.itag, mime: s.applied.mime,
      assignedSrcKind: s.applied.assignedSrcKind, url: String(s.applied.url || '').slice(0, 48) },
    restore: s.restore && { ok: s.restore.ok, method: s.restore.method,
      positionSource: s.restore.positionSource, startSeconds: s.restore.startSeconds,
      pauseIntent: s.restore.pauseIntent, failure: s.restore.failure || null,
      playerCall: s.restore.playerCall || null },
    element: { srcKind: e.srcKind, readyState: e.readyState, time: e.time, paused: e.paused },
    counters: s.counters, pageApiCounts: s.pageApiCounts, logSize: s.logSize,
    lastError: s.lastError ? { code: s.lastError.code, reason: s.lastError.reason } : null,
    events: (s.events || []).map((x) => x.event + (x.repeats ? '(x' + x.repeats + ')' : '')),
  };
}

L.filter((l) => ['probe', 'page-state', 'enable', 'disable', 'done'].indexOf(l.phase) >= 0).forEach((l) => {
  console.log('\n=== ' + l.phase.toUpperCase() + ' ===');
  if (l.phase === 'probe' || l.phase === 'page-state' || l.phase === 'done') {
    console.log(JSON.stringify(l.data));
    return;
  }
  console.log('result: ' + JSON.stringify(l.data.result).slice(0, 1000));
  console.log('status: ' + JSON.stringify(brief(l.data.status), null, 1));
});

const page = L.filter((l) => l.phase === 'page').reduce((acc, l) => {
  const k = l.entry.call + (l.entry.error ? ' ERROR' : '');
  acc[k] = (acc[k] || 0) + 1;
  return acc;
}, {});
console.log('\npage side (calls that really reached page code): ' + JSON.stringify(page));
L.filter((l) => l.phase === 'page' && l.entry.call === 'loadVideoById')
  .forEach((r) => console.log('page loadVideoById: ' + JSON.stringify(r.entry)));
L.filter((l) => l.phase === 'page' && ['rebuilt', 'page-playing', 'page-play-refused', 'resume']
  .indexOf(l.entry.call) >= 0).forEach((r) => console.log('page ' + r.entry.call + ': ' + JSON.stringify(r.entry)));
