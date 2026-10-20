#!/usr/bin/env node
/*!
 * Message-driven test of the RELEASE copy in extension/. Run: node tools/smoke-release.js
 * (tools/build-extension.js has to have run before; this runner does not build anything itself.)
 *
 * Why a second runner exists: the offline suite in spike/mv3-audio-only/smoke/ drives the prototype
 * through its console API (AUDIO_ONLY) - and the release build deliberately has no such API. So this
 * runner drives the shipped file the only way anything can drive it: through chrome.runtime messages,
 * with the names the release really implements, and it reads the result out of the harness's fake page
 * (element source, fetches, player calls). It re-uses that harness, so the DOM/fetch model is the same
 * one the prototype suite is built on - only the script under test is the built one.
 *
 * What it can and cannot prove: it proves the shipped code runs, that the message wiring survived the
 * build, that the two build changes behave (no AUDIO_ONLY, the double-injection marker), and that the
 * state machine still switches on, keeps position, hands the element back and re-resolves on a track
 * change. It is still an offline harness: it says NOTHING about YouTube, the network or a real media
 * element. The temporary-load test in docs/release/test-plan.md is what covers the browser.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { createEnv, audioOnlyAnswer, noStreamsAnswer, wait, waitUntil, closeAll } =
  require('../spike/mv3-audio-only/smoke/harness');
const BUILD = require('./build-extension.js');

const RELEASE_CONTENT = path.join(BUILD.OUT_DIR, 'content.js');
const RELEASE_BACKGROUND = path.join(BUILD.OUT_DIR, 'background.js');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined || detail === null ? '' : String(detail) });
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log('  ' + mark + ' ' + name + (ok ? '' : '   -> ' + checks[checks.length - 1].detail));
}

async function scenario(name, fn) {
  console.log('\n== ' + name);
  try {
    await fn();
  } catch (e) {
    check(name + ' (no exception)', false, (e && e.stack) || String(e));
  }
}

// A release env: the built content.js, no AUDIO_ONLY, and the extension APIs a content script gets.
// The driver keeps every registered listener, so a second injection would be visible as a second one.
function releaseEnv(overrides) {
  const sentByContent = [];
  const listeners = [];
  const chromeStub = {
    runtime: {
      id: 'release-test-extension',
      onMessage: { addListener: (fn) => { listeners.push(fn); } },
      sendMessage: (msg, cb) => { sentByContent.push(msg); if (typeof cb === 'function') cb(); },
      get lastError() { return undefined; },
    },
  };
  const env = createEnv(Object.assign({
    contentPath: RELEASE_CONTENT, expectApi: false, sandboxExtra: { chrome: chromeStub },
  }, overrides || {}));
  env.release = {
    listeners,
    sentByContent,
    // The message a toolbar button or a keyboard shortcut really sends, answered by the release copy.
    ask(msg) {
      if (!listeners.length) return Promise.resolve(null);
      return new Promise((resolve) => { listeners[listeners.length - 1](msg, {}, resolve); });
    },
  };
  return env;
}

// Reading the state of a release build goes through the message the background uses for its badge.
async function waitForStatus(env, predicate, timeoutMs) {
  const started = Date.now();
  for (;;) {
    const answer = await env.release.ask({ type: 'audio-only.getStatus' });
    const status = answer && answer.status;
    if (status && predicate(status)) return status;
    if (Date.now() - started >= timeoutMs) return null;
    await wait(250);
  }
}

const okResponder = (call) => ({ json: audioOnlyAnswer(call.videoId) });

// ------------------------------------------------------------------ scenarios
async function r1_theToggleMessageSwitchesOn() {
  const env = releaseEnv({ videoId: 'REL_A', pagePlaying: true, pageTime: 42.5 });
  env.responder = okResponder;
  env.video.volume = 0.42;
  env.video.muted = true;
  const answer = await env.release.ask({ type: 'audio-only.toggle' });
  const s = answer && answer.status;

  check('the release answers the message the toolbar sends', !!(answer && answer.ok === true),
    JSON.stringify(answer && (answer.error || answer.ok)));
  check('mode is active', !!s && s.mode === 'active', s && s.mode);
  check('playback verified by real progress',
    !!s && s.verified === true && s.playback.verdict === 'playing',
    s && JSON.stringify(s.playback && s.playback.verdict));
  check('the element got the highest-bitrate audio format (itag 251)',
    env.video.src.indexOf('itag=251') > 0, env.video.src.slice(0, 60));
  check('the video-only format was never applied', env.video.src.indexOf('sig=VIDEO') < 0);
  check('the position target came from the page clock (42.5)',
    !!s && Math.abs((s.position.target || -1) - 42.5) < 0.05, s && JSON.stringify(s.position));
  check('the position really was restored (the old bug started at 0)',
    !!s && s.position.restored === true, s && JSON.stringify(s.position));
  check('volume and mute were carried over',
    Math.abs(env.video.volume - 0.42) < 0.001 && env.video.muted === true,
    JSON.stringify({ volume: env.video.volume, muted: env.video.muted }));
  check('the request carried the video id of the page',
    env.fetches.length === 1 && env.fetches[0].videoId === 'REL_A',
    JSON.stringify(env.fetches.map((f) => f.videoId)));
  check('the request used credentials omit and same-origin', env.fetches.length === 1 &&
    env.fetches[0].credentials === 'omit' && env.fetches[0].mode === 'same-origin',
    JSON.stringify(env.fetches[0] && { c: env.fetches[0].credentials, m: env.fetches[0].mode }));
  const stateMessages = env.release.sentByContent.filter((m) => m.type === 'audio-only.state');
  check('the release announced its state to the background', stateMessages.length >= 1,
    JSON.stringify(env.release.sentByContent.map((m) => m.type)));
  check('the background hears the final active state after resolving',
    stateMessages.some((m) => m.state && m.state.mode === 'resolving') &&
    stateMessages[stateMessages.length - 1].state.mode === 'active',
    JSON.stringify(stateMessages.map((m) => m.state && m.state.mode)));
  env.close();
}

async function r2_theToggleMessageHandsTheElementBack() {
  const env = releaseEnv({ videoId: 'REL_B', pagePlaying: true, pageTime: 61 });
  env.responder = okResponder;
  env.video.volume = 0.7;
  const on = await env.release.ask({ type: 'audio-only.toggle' });
  check('the first toggle switched the audio-only stream on',
    !!(on && on.ok === true && on.status && on.status.mode === 'active'),
    JSON.stringify(on && on.status && on.status.mode));

  const currentPositionAtDisable = env.video.currentTime;
  const off = await env.release.ask({ type: 'audio-only.toggle' });
  const s = off && off.status;
  check('the second toggle answered', !!(off && off.ok === true),
    JSON.stringify(off && (off.error || off.ok)));
  check('mode is off', !!s && s.mode === 'off', s && s.mode);
  check('the page was asked to rebuild its own playback',
    !!s && !!s.restore && s.restore.method === 'player.loadVideoById',
    s && JSON.stringify(s.restore && s.restore.method));
  check('the element carries a fresh page source, not the old blob',
    env.video.src.indexOf('blob:') === 0 && env.video.src !== env.originalSrc, env.video.src);
  check('the old blob URL was never written or loaded again',
    env.media.loadedUrls.indexOf(env.originalSrc) < 0 && env.media.deadLoads.length === 0,
    JSON.stringify({ dead: env.media.deadLoads }));
  check('the hand-back carried the video id and current element position',
    env.playerCalls.length === 1 && env.playerCalls[0].videoId === 'REL_B' &&
    Math.abs(env.playerCalls[0].startSeconds - currentPositionAtDisable) < 0.1, JSON.stringify(env.playerCalls));
  check('nothing of the audio session is left in the report', !!s && s.switch === null,
    s && JSON.stringify(s.switch));
  check('playback continued after the hand-back', env.video.paused === false);
  env.close();
}

async function r3_theBuildChangesBehave() {
  const env = releaseEnv({ videoId: 'REL_C', pagePlaying: false, pageTime: 20 });
  const descriptor = Object.getOwnPropertyDescriptor(env.sandbox, '__audioOnlyLoaded');
  check('the in-sandbox double-injection marker exists and is true',
    !!descriptor && descriptor.value === true, JSON.stringify(descriptor && descriptor.value));
  check('the marker is not enumerable (it is not a public surface)',
    !!descriptor && descriptor.enumerable === false, JSON.stringify(descriptor && descriptor.enumerable));
  check('the marker does not show up when the sandbox is enumerated',
    Object.keys(env.sandbox).indexOf('__audioOnlyLoaded') < 0,
    JSON.stringify(Object.keys(env.sandbox).filter((key) => key.indexOf('audio') >= 0)));
  check('there is no AUDIO_ONLY console API on the window', env.sandbox.AUDIO_ONLY === undefined);
  env.close();
}

async function r4_aSecondInjectionIsIgnored() {
  const env = releaseEnv({ videoId: 'REL_D', pagePlaying: true, pageTime: 12 });
  env.responder = okResponder;
  const announced = env.release.sentByContent.length;
  const intervals = env.intervals.length;
  check('the first injection registered exactly one message listener',
    env.release.listeners.length === 1, env.release.listeners.length);
  check('the first injection announced itself to the background', announced >= 1, announced);
  check('the first injection started a navigation timer', intervals >= 1, intervals);

  // Exactly what an add-on reload or update does to an open page: the same file runs a second time.
  const source = fs.readFileSync(RELEASE_CONTENT, 'utf8');
  vm.runInContext(source, env.sandbox, { filename: 'content.js (second injection)' });
  await wait(80);

  check('the second injection registered no second listener',
    env.release.listeners.length === 1, env.release.listeners.length);
  check('the second injection announced nothing', env.release.sentByContent.length === announced,
    env.release.sentByContent.length);
  check('the second injection started no second timer', env.intervals.length === intervals,
    JSON.stringify({ before: intervals, after: env.intervals.length }));
  const answer = await env.release.ask({ type: 'audio-only.ping' });
  check('the document is still answered by the first instance', !!(answer && answer.ok === true),
    JSON.stringify(answer && (answer.error || answer.ok)));
  env.close();
}

async function r5_aTrackChangeReResolves() {
  const env = releaseEnv({ videoId: 'REL_T1', pagePlaying: true, pageTime: 30 });
  env.responder = okResponder;
  const first = await env.release.ask({ type: 'audio-only.toggle' });
  check('the release is playing the first track',
    !!(first && first.status && first.status.mode === 'active' &&
      env.video.src.indexOf('REL_T1') > 0), env.video.src.slice(-60));

  // The page moves to the next video while the mode stays on. The release has no console API, so the
  // only driver is what the browser gives it: the watch URL and the player's own data.
  env.sandbox.location.href = 'https://www.youtube.com/watch?v=REL_T2';
  env.videoId = 'REL_T2';
  const s = await waitForStatus(env, (status) => status.mode === 'active' && status.switch &&
    status.switch.videoId === 'REL_T2' && status.counters.trackChanges >= 1, 20000);

  check('the track change was noticed and a new generation was opened',
    !!s && s.counters.trackChanges >= 1 && s.epoch >= 2,
    JSON.stringify({ trackChanges: s && s.counters.trackChanges, epoch: s && s.epoch }));
  check('the new track was resolved with its own video id',
    env.fetches.some((f) => f.videoId === 'REL_T2'),
    JSON.stringify(env.fetches.map((f) => f.videoId)));
  check('the element plays a URL of the new track, never the old one',
    env.video.src.indexOf('REL_T2') > 0 && env.video.src.indexOf('REL_T1') < 0,
    env.video.src.slice(-70));
  check('the report shows the new track as the applied one and does not call it locked',
    !!s && !!s.switch && s.switch.videoId === 'REL_T2' && s.switch.locked === false,
    s && JSON.stringify({ v: s.switch.videoId, locked: s.switch.locked }));
  check('the re-resolve was counted', !!s && s.counters.reResolves >= 1,
    s && JSON.stringify(s.counters.reResolves));
  check('the new track is verified as playing', !!s && s.verified === true,
    s && JSON.stringify({ verified: s.verified, verdict: s.playback && s.playback.verdict }));
  check('the position was kept for the new track',
    !!s && Math.abs((s.position.target || -1) - 30) < 1, s && JSON.stringify(s.position));
  const modes = env.release.sentByContent.filter((m) => m.type === 'audio-only.state')
    .map((m) => m.state && m.state.mode);
  check('the background hears active again after a track change',
    modes.filter((m) => m === 'active').length === 2 && modes[modes.length - 1] === 'active', JSON.stringify(modes));
  env.close();
}

async function r6_theToolbarPathWorksEndToEnd() {
  const env = releaseEnv({ videoId: 'REL_E', pagePlaying: true, pageTime: 15 });
  env.responder = okResponder;
  const asked = [];
  const badges = [];
  const listeners = {};
  const browserStub = {
    action: {
      onClicked: { addListener: (fn) => { listeners.click = fn; } },
      setBadgeText: async (arg) => { badges.push(arg); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    commands: { onCommand: { addListener: (fn) => { listeners.command = fn; } } },
    runtime: { onMessage: { addListener: (fn) => { listeners.status = fn; } } },
    tabs: {
      query: async () => [{ id: 3, url: 'https://www.youtube.com/watch?v=REL_E' }],
      sendMessage: async (tabId, msg) => {
        asked.push(msg);
        const answer = await env.release.ask(msg);
        return answer; // the browser delivers the envelope unchanged
      },
    },
  };
  const bgSandbox = { browser: browserStub, console: env.sandbox.console, setTimeout, clearTimeout };
  vm.createContext(bgSandbox);
  vm.runInContext(fs.readFileSync(RELEASE_BACKGROUND, 'utf8'), bgSandbox, { filename: 'background.js' });
  check('the built background registered the button, the shortcut and the status listener',
    !!(listeners.click && listeners.command && listeners.status));

  listeners.click();                        // the toolbar button and the shortcut use the same path
  const badge = await waitUntil(() => badges.filter((b) => b.text === 'ON')[0], 20000);
  check('the button asked with the message name the release implements',
    asked.length === 1 && asked[0].type === 'audio-only.toggle', JSON.stringify(asked.map((m) => m.type)));
  check('the click really switched the page to the audio-only stream',
    env.video.src.indexOf('itag=251') > 0, env.video.src.slice(-50));
  check('the badge shows ON from the status the release returned', !!badge, JSON.stringify(badges));
  await listeners.command('toggle-audio-only');
  check('the keyboard shortcut hands back and clears the badge', badges[badges.length - 1].text === '');
  browserStub.tabs.query = async () => { throw new Error('window closed'); };
  await listeners.click();
  check('a closing window does not reject the toolbar handler', true);
  env.close();
}

async function r7_theVisitorDataValueStaysInTheClosure() {
  const env = releaseEnv({ videoId: 'REL_V', pagePlaying: true, pageTime: 5 });
  const MARK = 'VISITOR_MARKER_RELEASE';
  // Exactly the shape the live endpoint answered with: no audio URL, but a visitorData of its own.
  // Only a repeat that carries that value back gets streaming data.
  env.responder = (call) => ((call.clientContext && call.clientContext.visitorData)
    ? { json: audioOnlyAnswer(call.videoId) }
    : { json: noStreamsAnswer({ visitorData: MARK, videoId: call.videoId }) });

  const answer = await env.release.ask({ type: 'audio-only.toggle' });
  const raw = JSON.stringify(answer);
  check('the resolver repeated the request exactly once',
    env.fetches.length === 2, String(env.fetches.length));
  check('the first request carried no visitorData, the repeat carried the server value',
    env.fetches[0].clientContext.visitorData === undefined &&
    env.fetches[1].clientContext.visitorData === MARK,
    JSON.stringify(env.fetches.map((f) => f.clientContext.visitorData)));
  check('the repeat used the same client and endpoint',
    env.fetches[1].clientName === env.fetches[0].clientName &&
    env.fetches[1].url === env.fetches[0].url);
  check('credentials stay omit on both requests',
    env.fetches.every((f) => f.credentials === 'omit' && f.mode === 'same-origin'));
  // The privacy claim of the release has to hold on the shipped file, not only in the prototype.
  check('the value never appears in the report the panel shows', raw.indexOf(MARK) < 0);
  check('only the facts about it appear, marked as not recorded',
    raw.indexOf('"valueRecorded":false') > 0 && raw.indexOf('"repeats":1') > 0 &&
    raw.indexOf('"sent":true') > 0,
    JSON.stringify({ recorded: raw.indexOf('"valueRecorded":false'), repeats: raw.indexOf('"repeats":1'),
      sent: raw.indexOf('"sent":true') }));
  check('the report states that no cookie or token was read',
    raw.indexOf('"cookieAccess":"none - no browser.cookies permission') > 0,
    raw.indexOf('"cookieAccess"'));
  check('the mode is active on the URL that came from the repeat',
    !!answer && answer.status.mode === 'active' && env.video.src.indexOf('itag=251') > 0);
  env.close();
}

// Drive the shipped build through messages; the user changes playback after enabling.
async function r8_currentStateAndPicture() {
  const env = releaseEnv({ videoId: 'REL_CURRENT', pagePlaying: true, pageTime: 3 });
  env.responder = okResponder;
  const enabling = env.release.ask({ type: 'audio-only.enable' });
  check('release hides the video before the resolver finishes', env.video.style.visibility === 'hidden');
  await enabling;
  env.video.currentTime = 60;
  env.video.pause();
  env.video.volume = 0.19;
  env.video.muted = true;
  const response = await env.release.ask({ type: 'audio-only.disable' });
  const restore = response.status.restore;
  check('release hands back at the current 60-second position',
    restore.ok && restore.startSeconds === 60 && env.playerCalls[0].startSeconds === 60, JSON.stringify(restore));
  check('release preserves pause, mute and current volume',
    env.video.paused && env.video.muted && env.video.volume === 0.19);
  check('release immediately returns the original visibility', env.video.style.visibility !== 'hidden');
  env.close();
}

// ------------------------------------------------------------------------ runner

async function r9_trackStartupDoesNotWaitForSeekTimer() {
  const env = releaseEnv({ videoId: 'REL_EARLY', pagePlaying: true, pageTime: 10 });
  env.responder = okResponder;
  let correctionPending = false;
  const timer = env.sandbox.setTimeout;
  env.sandbox.setTimeout = (fn, ms) => {
    if (ms !== 600) return timer(fn, ms);
    correctionPending = true;
    return timer(() => { correctionPending = false; fn(); }, ms);
  };
  const starts = [];
  const onPlay = env.media.onPlay;
  env.media.onPlay = (el) => {
    starts.push({ correctionPending, time: el.currentTime });
    return onPlay(el);
  };
  const answer = await env.release.ask({ type: 'audio-only.enable' });
  check('release starts play during position checking, not after a fixed silent wait',
    starts.length === 1 && starts[0].correctionPending && starts[0].time === 10, JSON.stringify(starts));
  check('release still verifies progress after the position checks',
    answer.status.verified && answer.status.position.restored);
  env.close();
}

async function main() {
  const built = fs.existsSync(RELEASE_CONTENT) && fs.existsSync(RELEASE_BACKGROUND);
  check('the release build exists (run: node tools/build-extension.js)', built, RELEASE_CONTENT);
  if (!built) return;

  await scenario('r1 the toggle message switches the audio-only stream on', r1_theToggleMessageSwitchesOn);
  await scenario('r2 the toggle message hands the element back', r2_theToggleMessageHandsTheElementBack);
  await scenario('r3 the build changed only what it says it changed', r3_theBuildChangesBehave);
  await scenario('r4 a second injection is ignored', r4_aSecondInjectionIsIgnored);
  await scenario('r5 a track change re-resolves for the new track', r5_aTrackChangeReResolves);
  await scenario('r6 the toolbar path works end to end', r6_theToolbarPathWorksEndToEnd);
  await scenario('r7 the visitorData value stays in the closure', r7_theVisitorDataValueStaysInTheClosure);

  await scenario('r8 release restores current state and picture', r8_currentStateAndPicture);

  await scenario('r9 startup does not wait for the seek timer', r9_trackStartupDoesNotWaitForSeekTimer);
  await wait(400);                          // let late timers and rejections surface
}

// One place that prints the result, exactly like the offline suite: the normal end and the crash path
// use the same report, so a runner that breaks half way through cannot look like a run that passed.
function report() {
  closeAll();
  const failed = checks.filter((c) => !c.ok);
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed');
  if (failed.length) {
    console.log('failed:');
    failed.forEach((f) => console.log('  - ' + f.name + (f.detail ? '  -> ' + f.detail : '')));
    process.exitCode = 1;
  }
  return failed.length;
}

process.on('unhandledRejection', (err) => {
  check('no unhandled rejection', false, (err && err.stack) || String(err));
  process.exitCode = 1;
});

main().then(report, (err) => {
  check('the runner itself did not crash', false, (err && err.stack) || String(err));
  report();
});
