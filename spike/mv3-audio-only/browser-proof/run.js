#!/usr/bin/env node
'use strict';
// Optional real-browser bench; no user profile or YouTube account page is opened.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { profileFromLog, stop } = require('../../../tools/browser-processes');
const work = process.env.WORK || path.join(os.tmpdir(), 'audio-only-browser-proof');
const variants = ['fixed', 'old', 'no-clone', 'old-no-clone', 'old-no-clone-nobound', 'resolver-stub'];
const variant = process.argv[2];
const query = process.argv[3] || '';
const seconds = Number(process.env.RUN_SECONDS || 90);
const port = Number(process.env.PORT || 8791);
const firefox = process.env.FF || '/Applications/Firefox.app/Contents/MacOS/firefox';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; } }
async function main() {
  if (!variants.includes(variant)) throw new Error('Choose a known variant: ' + variants.join(', '));
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) throw new Error('RUN_SECONDS must be 1..600.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  const source = path.join(work, 'ext-' + variant);
  if (!fs.existsSync(path.join(source, 'manifest.json'))) throw new Error('Build variants first: node build.js');
  const report = path.join(work, 'report-' + variant + '.ndjson');
  const serverLog = path.join(work, 'server-' + variant + '.log');
  const browserLog = path.join(work, 'web-ext-' + variant + '.log');
  const handles = [fs.openSync(serverLog, 'w'), fs.openSync(browserLog, 'w')];
  let server, browser, spawnError;
  let cleanupTask;
  const cleanup = () => {
    if (!cleanupTask) cleanupTask = (async () => {
      await stop(browser, profileFromLog(read(browserLog)));
      await stop(server, null);
      handles.forEach((fd) => { try { fs.closeSync(fd); } catch (e) { /* gone */ } });
    })();
    return cleanupTask;
  };
  const interrupted = () => { cleanup().then(() => process.exit(130)); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      detached: true, env: { ...process.env, PORT: String(port), OUT: report },
      stdio: ['ignore', handles[0], handles[0]],
    });
    server.on('error', (error) => { spawnError = error; });
    await delay(500);
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error('Collector failed to start: ' + read(serverLog));
    // Only whitespace-separated --pref key=value pairs are accepted; no shell evaluation.
    const prefs = (process.env.EXTRA_PREFS || '').trim().split(/\s+/).filter(Boolean);
    if (prefs.some((arg, i) => i % 2 === 0 ? arg !== '--pref' : !arg.includes('=')) || prefs.length % 2) {
      throw new Error('EXTRA_PREFS accepts --pref key=value pairs only.');
    }
    const args = ['--yes', 'web-ext@10.8.0', 'run', '--source-dir', source, '--firefox', firefox,
      '--firefox-profile', path.join(work, 'profile-' + variant), '--profile-create-if-missing',
      '--start-url', 'http://127.0.0.1:' + port + '/stub-page.html' + query,
      '--no-reload', '--no-input', '--verbose', '--arg=--headless', ...prefs];
    browser = spawn('npx', args, { detached: true, stdio: ['ignore', handles[1], handles[1]] });
    browser.on('error', (error) => { spawnError = error; });
    console.log('variant ' + variant + ': running for up to ' + seconds + 's');
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (browser.exitCode !== null) throw new Error('web-ext exited before the observation ended.');
      if (read(report).includes('"phase":"done"')) break;
      await delay(500);
    }
  } finally {
    await cleanup();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
  console.log('reports: ' + report);
  console.log(read(report));
  if (!read(report).includes('"phase":"done"')) throw new Error('Probe did not finish; inspect ' + browserLog);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
