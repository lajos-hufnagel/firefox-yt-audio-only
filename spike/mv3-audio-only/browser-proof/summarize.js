#!/usr/bin/env node
// Prints the proof runs, side by side (work folder: report-<variant>.ndjson).
// Run: node summarize.js [variant ...]
const fs = require('fs');
const os = require('os');
const path = require('path');
const WORK = process.env.WORK || path.join(os.tmpdir(), 'audio-only-browser-proof');
const VARIANTS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['fixed', 'old', 'no-clone', 'old-no-clone', 'old-no-clone-nobound', 'resolver-stub'];
const CALLS = ['getVideoData', 'getCurrentTime', 'loadVideoById'];

VARIANTS.forEach((v) => {
  const file = path.join(WORK, 'report-' + v + '.ndjson');
  if (!fs.existsSync(file)) { console.log('\n### ' + v + ': no report'); return; }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rounds = lines.filter((l) => l.phase === 'round');
  const page = lines.filter((l) => l.phase === 'page');
  const flood = lines.filter((l) => l.phase === 'flood');
  console.log('\n############################################################');
  console.log('### ' + v);
  rounds.forEach((r) => {
    console.log('  ROUND ' + r.data.label + '  (cloneInto: ' + r.data.cloneInto + ')');
    CALLS.forEach((c) => {
      const x = r.data[c];
      if (!x) return;
      console.log('    ' + c.padEnd(15) + ' ok=' + x.ok + ' bridge=' + x.argsBridge +
        ' argsCount=' + x.argsCount + ' cloneError=' + x.cloneError +
        (x.retried ? ' retried=' + x.retried : '') +
        (x.threw ? ' THREW=' + x.threw : '') +
        (x.valueType ? ' valueType=' + x.valueType : '') +
        (x.value !== undefined ? ' value=' + JSON.stringify(x.value) : ''));
    });
    console.log('    counts: ' + JSON.stringify(r.data.status.pageApiCounts) +
      '  logSize=' + r.data.status.logSize + ' repeats=' + r.data.status.logRepeats);
  });
  // What the PAGE really saw: the calls whose body ran, and whether it could read the argument.
  const seen = {};
  page.forEach((p) => { seen[p.entry.call] = (seen[p.entry.call] || 0) + 1; });
  console.log('  page side, calls that reached page code: ' + JSON.stringify(seen));
  page.filter((p) => p.entry.call === 'loadVideoById').slice(0, 1).forEach((p) => {
    console.log('  page side, loadVideoById argument: ' + JSON.stringify(p.entry));
  });
  flood.forEach((f) => {
    console.log('  FLOOD ' + f.data.calls + ' identical calls: logSize ' + f.data.logSizeBefore + ' -> ' +
      f.data.logSize + ', logRepeats=' + f.data.logRepeats + ', counts=' + JSON.stringify(f.data.counts));
    console.log('    refused entries: ' + JSON.stringify(f.data.refusedEntries));
  });
  const errs = lines.filter((l) => l.phase === 'enable' || l.phase === 'disable');
  errs.forEach((e) => console.log('  ' + e.phase.toUpperCase() + ': ' + JSON.stringify(e.data.result) +
    '\n    status: ' + JSON.stringify(e.data.status)));
});
