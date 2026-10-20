#!/usr/bin/env node
/*!
 * Loads the release directory extension/ as a TEMPORARY add-on in the real Firefox on this machine and
 * checks what only a real browser can show.
 *
 * Run: node tools/verify-temporary-load.js          (needs extension/ built, Firefox installed, network
 *                                                    only if npx has to fetch web-ext)
 *
 * Why it exists: addons-linter checks the manifest against its own schema and the offline suites run the
 * code in a vm with a fake DOM. Neither can tell whether the browser itself accepts this manifest -
 * including browser_specific_settings.gecko.strict_min_version (140.0), data_collection_permissions and
 * the action/command keys - or whether the directory really installs. This tool asks Firefox.
 *
 * What it proves: a real Firefox (version is printed and compared against strict_min_version) accepted
 * the untouched release directory as a temporary add-on under the manifest's own id, with no error line
 * from web-ext or the browser.
 *
 * What it does NOT prove - and the release report says so: nothing about YouTube. It cannot click the
 * toolbar button, cannot observe the panel and cannot check playback, because the only pages this
 * extension may touch are on youtube.com and no automated run here is allowed to drive a real account
 * page. That part stays in docs/release/test-plan.md and stays with a person.
 *
 * Side effects, deliberately limited: the browser runs headless with a throwaway profile that web-ext
 * creates under the system temp directory (never the user's profile, never inside the project), and every
 * process this tool starts is killed again before it exits. It never signs, uploads or contacts Mozilla.
 */
'use strict';

const { spawn, spawnSync } = require('child_process');
const { profileFromLog, stop: stopEverything, running: stillRunning } = require('./browser-processes');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const MANIFEST_FILE = path.join(EXT_DIR, 'manifest.json');
const WEB_EXT_SPEC = 'web-ext@10.8.0';
const START_URL = 'about:blank';
const WAIT_SECONDS = Number(process.env.RELEASE_LOAD_WAIT || 180);
const POLL_MS = 2000;

const FIREFOX_CANDIDATES = [
  process.env.FF,
  '/Applications/Firefox.app/Contents/MacOS/firefox',
].filter(Boolean);

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined || detail === null ? '' : String(detail) });
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + name + (ok ? '' : '   -> ' + checks[checks.length - 1].detail));
}

function report() {
  const failed = checks.filter((c) => !c.ok);
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed');
  if (failed.length) {
    console.log('failed:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? '  -> ' + f.detail : '')));
    process.exitCode = 1;
  }
  return failed.length;
}

// ------------------------------------------------------------------ small helpers
function findFirefox() {
  for (const candidate of FIREFOX_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const which = spawnSync('which', ['firefox'], { encoding: 'utf8' });
  const found = (which.stdout || '').trim();
  return found && fs.existsSync(found) ? found : null;
}

function firefoxVersion(binary) {
  const run = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  const text = (run.stdout || '') + (run.stderr || '');
  const match = /Firefox\s+([0-9]+(?:\.[0-9]+)*)/.exec(text);
  return match ? match[1] : null;
}

function versionAtLeast(version, minimum) {
  const a = String(version).split('.').map(Number);
  const b = String(minimum).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left !== right) return left > right;
  }
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLog(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
}

// ------------------------------------------------------------------------ the run
async function main() {
  console.log('Real-Firefox temporary load of the release directory\n');

  if (!Number.isFinite(WAIT_SECONDS) || WAIT_SECONDS <= 0 || WAIT_SECONDS > 600) {
    throw new Error('RELEASE_LOAD_WAIT must be between 0 and 600 seconds.');
  }

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  } catch (e) {
    check('extension/' + path.basename(MANIFEST_FILE) + ' exists and parses', false, (e && e.message) || String(e));
    return;
  }
  check('extension/manifest.json exists and parses', true, MANIFEST_FILE);

  const settings = manifest.browser_specific_settings || {};
  const gecko = settings.gecko || {};
  const expectedId = gecko.id || '';
  const minVersion = gecko.strict_min_version || '';
  check('the manifest carries a Gecko id and a strict_min_version', !!expectedId && !!minVersion,
    'id ' + (expectedId || '(none)') + ', strict_min_version ' + (minVersion || '(none)'));

  const firefox = findFirefox();
  check('a Firefox binary was found', !!firefox, firefox || 'set FF=<path> to point at one');
  if (!firefox) return;

  const version = firefoxVersion(firefox);
  check('the installed Firefox reports a version', !!version, version || firefox + ' --version printed nothing');
  if (!version) return;
  check('the installed Firefox is at least strict_min_version', versionAtLeast(version, minVersion),
    'installed ' + version + ', required ' + minVersion);

  // A throwaway profile outside the project, like the browser-proof bench uses: web-ext copies it again
  // for the run, so the user's own profile is never touched.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-only-temp-load-'));
  const profileDir = path.join(work, 'profile');
  const logPath = path.join(work, 'web-ext.log');
  const installedMarker = 'Installed ' + EXT_DIR + ' as a temporary add-on';
  const logFd = fs.openSync(logPath, 'a');

  const args = [
    '--yes', WEB_EXT_SPEC, 'run',
    '--source-dir', EXT_DIR,
    '--firefox', firefox,
    '--firefox-profile', profileDir, '--profile-create-if-missing',
    '--no-reload', '--no-input', '--verbose',
    '--arg=--headless',
    '--start-url', START_URL,
  ];
  console.log('\nstarting: npx ' + args.join(' '));
  console.log('log:      ' + logPath + '\n');

  // detached: the browser and web-ext become one process group, which is what the teardown kills. It
  // never becomes a group the user's own Firefox is in.
  const child = spawn('npx', args, { cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd] });
  let spawnError = null;
  child.on('error', (error) => { spawnError = error; });
  let copiedProfile = null;
  let cleanupTask;
  const cleanup = () => {
    if (!cleanupTask) cleanupTask = stopEverything(child, profileFromLog(readLog(logPath)) || copiedProfile);
    return cleanupTask;
  };
  const interrupted = () => { cleanup().then(() => process.exit(130)); };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  let log = '';
  let installed = false;
  const deadline = Date.now() + WAIT_SECONDS * 1000;

  try {
    while (Date.now() < deadline) {
      log = readLog(logPath);
      copiedProfile = profileFromLog(log) || copiedProfile;
      if (log.indexOf(installedMarker) >= 0) { installed = true; break; }
      if (spawnError || child.exitCode !== null || child.signalCode) break;
      await sleep(POLL_MS);
    }
    if (installed) await sleep(3000);           // let Firefox settle before it is taken down
  } finally {
    await cleanup();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    try { fs.closeSync(logFd); } catch (e) { /* already closed */ }
  }
  if (spawnError) throw spawnError;
  log = readLog(logPath);

  check('the browser was started by web-ext', /Running Firefox with profile at/.test(log),
    'no "Running Firefox with profile at" line within ' + WAIT_SECONDS + 's');
  check('web-ext reached the browser debugger', /Connected to the remote Firefox debugger/.test(log),
    'the remote debugger never connected - raise RELEASE_LOAD_WAIT (now ' + WAIT_SECONDS + 's) and retry');
  check('Firefox installed the release directory as a temporary add-on', installed, installedMarker);
  check('the browser took the id from our manifest', log.indexOf('"id":"' + expectedId + '"') >= 0,
    'expected ' + expectedId + ' in the installTemporaryAddon answer');
  const errorLines = log.split('\n').filter((line) => line.indexOf('[error]') >= 0);
  check('web-ext reported no error line', errorLines.length === 0, errorLines.slice(0, 3).join(' | '));
  check('no browser process was left behind', stillRunning(copiedProfile) === '',
    stillRunning(copiedProfile).split('\n').slice(0, 3).join(' | '));

  console.log('\n  browser:           Firefox ' + version + ' (' + firefox + ')');
  console.log('  add-on id loaded:  ' + expectedId);
  console.log('  throwaway profile: ' + (copiedProfile || '(not seen)'));
  console.log('  work directory:    ' + work + ' (outside the project, safe to delete)');
  console.log('\nWhat this does not prove: anything about YouTube. No page was loaded, the toolbar button was');
  console.log('never pressed and the panel was never seen - the manifest only allows youtube.com, and no');
  console.log('automated run here drives a real account page. That is docs/release/test-plan.md, for a person.');
}

process.on('unhandledRejection', (err) => {
  check('the runner itself did not crash', false, (err && err.stack) || String(err));
  process.exitCode = 1;
});

main().then(report, (err) => {
  check('the runner itself did not crash', false, (err && err.stack) || String(err));
  report();
});
