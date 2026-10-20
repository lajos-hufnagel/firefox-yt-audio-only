#!/usr/bin/env node
/*!
 * The mutation probes behind the table in README.md ("Mutation probes"). Run:
 *   node smoke/run-mutations.js            # all probes
 *   node smoke/run-mutations.js empty-list-tail   # just one
 *
 * Each probe breaks a copy of the project at exactly ONE place and runs the offline suite on that copy.
 * The copies are built in the work folder (outside the project) and nothing here touches the project
 * files: content.js is only read. Results are valid only for the current baseline; every probe must produce explicit failed checks.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-only-mutations-'));
const content = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');

// The pre-fix tail of cloneArgsToPage: an empty argument list was handed over as a fresh array of the
// content-script realm. Reverting exactly this is the probe for the second live failure (see README).
const FIXED_CLONE = `    if (!plain.length) {
      // Nothing to hand over: call it without an argument list, so no array of this realm reaches the
      // page's apply. The report names this path (\`no-args\`) instead of pretending a clone happened.
      return { args: plain, bridge: 'no-args', noArgList: true, cloneError, cloneMessage };
    }
    return { args: plain, bridge: 'direct', cloneError, cloneMessage };`;
const OLD_CLONE = `    if (!plain.length) return { args: [], bridge: 'none' };
    return { args: plain, bridge: 'direct' };`;

const PROBES = [
  {
    name: 'empty-list-tail',
    desc: 'hand an empty list over as a foreign list again',
    subs: [[FIXED_CLONE, OLD_CLONE]],
  },
  {
    name: 'blob-rewrite',
    desc: 'write the old blob URL back again',
    subs: [[
      '    const liveElTime = num(el.currentTime);',
      "    if (a.originalSrc) { el.setAttribute('src', a.originalSrc); el.load(); }\n" +
      '    const liveElTime = num(el.currentTime);',
    ]],
  },
  {
    name: 'no-clone',
    desc: 'hand arguments over without cloning',
    subs: [[
      '          return { args: cloneInto(plain, entry.scope), bridge: \'cloneInto\', cloneTarget: entry.label };',
      '          return { args: plain, bridge: \'direct\', cloneError: \'mutation\' };',
    ]],
  },
  {
    name: 'no-refusal-classification',
    desc: 'no longer classify a refusal as a context refusal',
    subs: [['  function crossContextRefusal(e) {', '  function crossContextRefusal(e) { return null;']],
  },
  {
    name: 'success-without-progress',
    desc: 'report success without playhead progress',
    subs: [["    state.verified = playback.verdict === 'playing';", '    state.verified = true;  // mutation']],
  },
  {
    name: 'invent-zero',
    desc: 'invent startSeconds 0 when nothing is readable',
    subs: [[
      '    const startSeconds = target === null ? null : target;',
      '    const startSeconds = target === null ? 0 : target;',
    ]],
  },
  {
    name: 'silent-off',
    desc: 'do not set restore-failed (silent off)',
    subs: [["    state.mode = 'restore-failed';", "    state.mode = 'off';  // mutation"]],
  },
  {
    name: 'first-clone-target-only',
    desc: 'offer only the first clone target (no fallback to window)',
    subs: [[
      "    try { if (window) list.push({ scope: window, label: 'window' }); } catch (e) { /* ignore */ }",
      "    else try { if (window) list.push({ scope: window, label: 'window' }); } catch (e) { /* ignore */ }",
    ]],
  },
];

// Which scenarios a probe made fall, together with how many checks of that scenario failed.
function parse(out) {
  const scenes = new Map();
  let scene = '(before any scenario)';
  out.split('\n').forEach((line) => {
    const head = /^== (.+)$/.exec(line);
    if (head) { scene = head[1].split('_')[0]; if (!scenes.has(scene)) scenes.set(scene, 0); }
    if (/^  FAIL /.test(line)) scenes.set(scene, (scenes.get(scene) || 0) + 1);
  });
  const total = /(\d+)\/(\d+) checks passed/.exec(out);
  return { total: total ? total[0] : null, scenes };
}

const only = process.argv.slice(2);
const results = [];
const unknown = only.filter((name) => !PROBES.some((p) => p.name === name));
if (unknown.length) {
  fs.rmSync(WORK, { recursive: true, force: true });
  console.error('Unknown probe: ' + unknown.join(', '));
  process.exit(1);
}
process.on('exit', () => fs.rmSync(WORK, { recursive: true, force: true }));
PROBES.filter((p) => !only.length || only.indexOf(p.name) >= 0).forEach((probe) => {
  const dir = path.join(WORK, probe.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let js = content;
  probe.subs.forEach(([find, repl]) => {
    if (js.split(find).length !== 2) throw new Error('anchor not found or not unique in ' + probe.name);
    js = js.replace(find, repl);
  });
  fs.writeFileSync(path.join(dir, 'content.js'), js);
  fs.writeFileSync(path.join(dir, 'background.js'), fs.readFileSync(path.join(SRC, 'background.js')));
  fs.cpSync(path.join(SRC, 'smoke'), path.join(dir, 'smoke'), { recursive: true });

  let out = '';
  let exitCode = 0;
  try {
    out = execFileSync('node', ['smoke/run-smoke.js'], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  } catch (e) {
    exitCode = Number.isInteger(e.status) ? e.status : -1;
    out = (e.stdout || '') + (e.stderr || '');          // a failing run exits non-zero on purpose
  }
  const r = parse(out);
  const detected = exitCode > 0 && !!r.total && [...r.scenes.values()].some((n) => n > 0);
  results.push({ probe, r, detected });
  if (!detected) { process.exitCode = 1; console.error('Probe was NOT detected: ' + probe.name); }
  console.log('\n### ' + probe.name + '  (' + probe.desc + ')  ' + (r.total || 'NO REPORT'));
  const byScene = [...r.scenes.entries()].filter(([, n]) => n > 0).map(([s, n]) => s + '(' + n + ')');
  console.log('    failing scenarios: ' + (byScene.join(' ') || 'none'));
});

console.log('\n== Summary ==');
results.forEach((x) => console.log(x.probe.name.padEnd(26) + ' ' + (x.r.total || 'NO REPORT') +
  (x.detected ? ' DETECTED' : ' NOT DETECTED')));
