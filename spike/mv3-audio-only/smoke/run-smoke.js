#!/usr/bin/env node
/*!
 * Offline smoke test for spike/mv3-audio-only/content.js. Run: node smoke/run-smoke.js
 *
 * Covers: the position bug (switch-on started at 0), stale answers after fast track changes, the
 * error paths, the pause/volume/mute carry-over, the autoplay refusal, the page re-taking the
 * source, the redaction, (s13-s16) the resolver's bounded visitorData repetition plus the
 * bot-check/age-gate classification, (s17/s17b) the race between a track change and the watchdog's
 * re-apply of the old cached URL, and (s18-s24) the way back: no blob URL is ever written back, the
 * arguments of a call into page code are transferred into the page realm (cloneInto, and the report
 * names which of the two page-window forms carried), a refused cross-context call and every other
 * failed hand-back end in a visible restore-failed state, and switching off never loses to a takeover
 * that is still running. It proves the state machine, nothing
 * about the network or the real media element - the wording of the results stays that careful.
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const { createEnv, audioOnlyAnswer, noStreamsAnswer, botCheckAnswer, ageGateAnswer,
  wait, waitUntil, tightTimings, closeAll, makeVideo, BACKGROUND_PATH } = require('./harness');

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined || detail === null ? '' : String(detail) });
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log('  ' + mark + ' ' + name + (ok ? '' : '   -> ' + checks[checks.length - 1].detail));
}

async function scenario(name, fn) {
  console.log('\n== ' + name);
  try { await fn(); } catch (e) { check(name + ' (no exception)', false, (e && e.stack) || String(e)); }
}

const okResponder = (call) => ({ json: audioOnlyAnswer(call.videoId) });

// ------------------------------------------------------------------ scenarios
async function s1_switchOnKeepsPositionAndState() {
  const env = createEnv({ videoId: 'VID_A', pagePlaying: true, pageTime: 42.5 });
  tightTimings(env.api);
  env.responder = okResponder;
  env.video.volume = 0.42;
  env.video.muted = true;
  const result = await env.api.enable('smoke');
  const s = env.api.status();

  check('mode is active', s.mode === 'active', s.mode);
  check('playback verified by real progress', s.verified === true && s.playback.verdict === 'playing',
    JSON.stringify(s.playback && s.playback.verdict));
  check('position target came from the page clock (42.5)',
    Math.abs((s.position.target || -1) - 42.5) < 0.05, JSON.stringify(s.position));
  check('position really restored (the old bug: started at 0)', s.position.restored === true,
    JSON.stringify(s.position));
  check('element got the highest-bitrate audio format (itag 251)',
    env.video.src.indexOf('itag=251') > 0, env.video.src.slice(0, 60));
  check('video-only format was ignored', env.video.src.indexOf('sig=VIDEO') < 0);
  check('volume carried over', Math.abs(env.video.volume - 0.42) < 0.001, env.video.volume);
  check('mute state carried over', env.video.muted === true, env.video.muted);
  check('fetch used credentials omit and same-origin', env.fetches.length === 1 &&
    env.fetches[0].credentials === 'omit' && env.fetches[0].mode === 'same-origin',
    JSON.stringify(env.fetches[0] && { c: env.fetches[0].credentials, m: env.fetches[0].mode }));
  check('only one request was made', env.fetches.length === 1, env.fetches.length);
  check('result reports verified', result && result.verified === true);
  env.close();
}

async function s2_pageResetsPositionAfterSeek() {
  // This is the known bug: the page writes a position of its own right after the new load. The
  // bounded re-assert loop has to win.
  const env = createEnv({ videoId: 'VID_B', pagePlaying: true, pageTime: 30, resetToZeroAfterMs: 150 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  const s = env.api.status();
  check('position restored despite the page reset', s.position.restored === true, JSON.stringify(s.position));
  check('more than one seek write happened', s.position.asserts >= 2, JSON.stringify(s.position));
  check('element ends near the target', Math.abs(env.video.currentTime - 30) < 1.5, env.video.currentTime);
  env.close();
}

async function s3_staleAnswerAfterFastTrackChange() {
  const env = createEnv({ videoId: 'VID_SLOW', pagePlaying: true, pageTime: 15 });
  tightTimings(env.api);
  env.responder = (call) => (call.videoId === 'VID_SLOW'
    ? { delayMs: 1500, json: audioOnlyAnswer(call.videoId) }
    : { delayMs: 5, json: audioOnlyAnswer(call.videoId) });
  const pending = env.api.enable('smoke');
  await wait(40);
  env.videoId = 'VID_FAST';                     // the user clicked on: track change
  env.pageTime = 0;
  const applied = await waitUntil(() => {
    const s = env.api.status();
    return s.mode === 'active' && s.videoId === 'VID_FAST';
  }, 3000);
  await pending;
  const s = env.api.status();
  check('later track became active', !!applied, JSON.stringify({ mode: s.mode, videoId: s.videoId }));
  check('element carries the NEW track only', env.video.src.indexOf('VID_FAST') > 0,
    env.video.src.slice(0, 70));
  check('the stale answer was never applied',
    !env.media.loadedUrls.some((u) => u.indexOf('VID_SLOW') >= 0),
    JSON.stringify(env.media.loadedUrls.map((u) => u.slice(-40))));
  check('stale answer was counted as dropped', s.counters.staleDropped >= 1, JSON.stringify(s.counters));
  check('track change was seen', s.counters.trackChanges >= 1, JSON.stringify(s.counters));
  env.close();
}

async function s4_httpErrorTouchesNothing() {
  const env = createEnv({ videoId: 'VID_ERR', pagePlaying: true, pageTime: 12 });
  tightTimings(env.api);
  env.responder = () => ({ status: 403, json: { error: { code: 403 } } });
  await env.api.enable('smoke');
  const s = env.api.status();
  check('mode is error', s.mode === 'error', s.mode);
  check('error code names the HTTP status', s.lastError && s.lastError.code === 'http-403',
    JSON.stringify(s.lastError));
  check('the element was NOT touched', env.video.src === env.originalSrc, env.video.src);
  check('nothing was loaded', env.media.loadedUrls.length === 0, env.media.loadedUrls.length);
  check('no play() call was made', env.video.playCalls === 0, env.video.playCalls);
  check('the page keeps playing', env.video.paused === false && env.video.currentTime >= 12);
  check('error carries a user-readable message',
    typeof s.lastError.message === 'string' && s.lastError.message.length > 10, s.lastError.message);
  check('all three clients were tried', s.counters.resolves === 3, s.counters.resolves);
  env.close();
}

async function s5_disableHandsTheElementBack() {
  const env = createEnv({ videoId: 'VID_C', pagePlaying: true, pageTime: 61 });
  tightTimings(env.api);
  env.responder = okResponder;
  env.video.volume = 0.7;
  await env.api.enable('smoke');
  const back = await env.api.disable('smoke');
  const s = env.api.status();
  check('mode is off', s.mode === 'off', s.mode);
  check('no longer verified after switching off', s.verified === false);
  check('the page was asked to rebuild its playback', back && back.method === 'player.loadVideoById',
    JSON.stringify(back && back.method));
  check('the element carries a FRESH page source, not the old blob',
    env.video.src.startsWith('blob:') && env.video.src !== env.originalSrc, env.video.src);
  check('the old blob URL was never written or loaded again',
    env.media.loadedUrls.indexOf(env.originalSrc) < 0 && env.media.deadLoads.length === 0,
    JSON.stringify({ loads: env.media.loadedUrls.map((u) => u.slice(0, 42)), dead: env.media.deadLoads }));
  check('the call carried the videoId and current element position',
    env.playerCalls.length === 1 && env.playerCalls[0].videoId === 'VID_C' &&
    Math.abs(env.playerCalls[0].startSeconds - 61) < 0.5, JSON.stringify(env.playerCalls));
  check('the arguments crossed into the page realm (cloneInto)',
    back.argsBridge === 'cloneInto' && env.cloneIntoCount >= 1,
    JSON.stringify({ bridge: back.argsBridge, clones: env.cloneIntoCount }));
  check('position handed back near 61s', Math.abs(env.video.currentTime - 61) < 2, env.video.currentTime);
  check('volume handed back', Math.abs(env.video.volume - 0.7) < 0.001, env.video.volume);
  check('playback continues and that is what made it successful',
    env.video.paused === false && back.playheadAdvanced === true && back.ok === true,
    JSON.stringify({ paused: env.video.paused, advanced: back.playheadAdvanced, ok: back.ok }));
  check('no audio session left behind', s.switch === null);
  env.close();
}

async function s6_pageReclaimsSourceAndGetsOneReapply() {
  const env = createEnv({ videoId: 'VID_D', pagePlaying: true, pageTime: 5 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  env.video.writesByPage('blob:https://www.youtube.com/page-took-it-back');
  const reapplied = await waitUntil(() => env.api.status().counters.autoReapplies >= 1, 2000);
  await waitUntil(() => env.video.src.indexOf('itag=251') > 0, 2000);
  const s = env.api.status();
  check('page write was detected', s.switch && s.switch.pageSrcWrites >= 1,
    JSON.stringify(s.switch && s.switch.pageSrcWrites));
  check('source was re-applied automatically', !!reapplied, JSON.stringify(s.counters));
  check('element is on the audio URL again', env.video.src.indexOf('itag=251') > 0,
    env.video.src.slice(0, 50));
  check('our own writes are counted separately', s.switch.ownSrcWrites >= 2,
    JSON.stringify({ own: s.switch.ownSrcWrites, page: s.switch.pageSrcWrites }));
  env.close();
}

async function s7_pausedSwitchKeepsPositionAndStaysPaused() {
  const env = createEnv({ videoId: 'VID_E', pagePlaying: false, pageTime: 24 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  const s = env.api.status();
  check('mode is active although nothing plays', s.mode === 'active', s.mode);
  check('nothing is claimed as verified', s.verified === false && s.playback.verdict === 'not-started',
    JSON.stringify(s.playback && s.playback.verdict));
  check('play() was not called', env.video.playCalls === 0, env.video.playCalls);
  check('the element is still paused', env.video.paused === true);
  check('position was restored even while paused', s.position.restored === true, JSON.stringify(s.position));
  env.close();
}

async function s8_autoplayRefusalIsNotVerified() {
  const env = createEnv({
    videoId: 'VID_F', pagePlaying: true, pageTime: 8,
    playRejection: { name: 'NotAllowedError' },
  });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  const s = env.api.status();
  check('mode stays active (the source is usable)', s.mode === 'active', s.mode);
  check('refusal is its own verdict', s.playback.verdict === 'blocked-autoplay',
    JSON.stringify(s.playback && s.playback.verdict));
  check('refusal is flagged as an autoplay block', s.playback.autoplayBlocked === true);
  check('refusal is never verified', s.verified === false);
  check('the reason is explicit', s.playback.failure === 'autoplay-policy', s.playback.failure);
  env.close();
}

async function s9_mediaErrorRestoresThePage() {
  const env = createEnv({ videoId: 'VID_G', pagePlaying: true, pageTime: 33, failLoad: true });
  tightTimings(env.api);
  env.responder = okResponder;
  const result = await env.api.enable('smoke');
  const s = env.api.status();
  check('mode is error', s.mode === 'error', s.mode);
  check('error code names the media error', s.lastError && s.lastError.code === 'media-error',
    JSON.stringify(s.lastError));
  check('the element was touched before the failure', s.lastError.touched === true);
  check('normal playback was restored automatically', !!(result.restore && result.restore.ok === true),
    JSON.stringify(result.restore));
  check('the hand-back went through the player API', result.restore && result.restore.method === 'player.loadVideoById',
    JSON.stringify(result.restore && result.restore.method));
  check('the page built its OWN source again (no old blob written)',
    env.video.src.startsWith('blob:') && env.video.src !== env.originalSrc &&
    env.media.loadedUrls.indexOf(env.originalSrc) < 0,
    JSON.stringify({ src: env.video.src, loads: env.media.loadedUrls.length }));
  check('a successful hand-back does not overwrite the switch error',
    s.mode === 'error' && s.lastError.code === 'media-error' && s.counters.restoreFailures === 0,
    JSON.stringify({ mode: s.mode, code: s.lastError && s.lastError.code }));
  check('the pause intent came from the page state before the switch',
    result.restore && result.restore.pauseIntent === 'resume',
    JSON.stringify(result.restore && { i: result.restore.pauseIntent, s: result.restore.pauseIntentSource }));
  check('playback runs again', env.video.paused === false, env.video.paused);
  env.close();

  // The other way round: a page that was PAUSED before the switch must stay paused after a failure.
  const paused = createEnv({ videoId: 'VID_G2', pagePlaying: false, pageTime: 33, failLoad: true });
  tightTimings(paused.api);
  paused.responder = okResponder;
  const pausedResult = await paused.api.enable('smoke');
  check('a paused page stays paused after a failed switch',
    pausedResult.restore && pausedResult.restore.pauseIntent === 'stay-paused' &&
    paused.video.paused === true && paused.video.playCalls === 0,
    JSON.stringify({ i: pausedResult.restore && pausedResult.restore.pauseIntent, p: paused.video.paused }));
  paused.close();
}

async function s10_noVideoPageTouchesNothing() {
  const env = createEnv({ videoId: 'VID_H' });
  tightTimings(env.api);
  env.responder = okResponder;
  env.videoId = null;
  env.sandbox.location.href = 'https://www.youtube.com/';
  await env.api.enable('smoke');
  const s = env.api.status();
  check('mode is error', s.mode === 'error', s.mode);
  check('error code says there is no video', s.lastError && s.lastError.code === 'no-video',
    JSON.stringify(s.lastError));
  check('the element was not touched', env.video.src === env.originalSrc);
  check('no request was made', env.fetches.length === 0, env.fetches.length);
  env.close();
}

async function s11_formatPickAndRedaction() {
  const env = createEnv({ videoId: 'VID_I', pagePlaying: true, pageTime: 17 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  const internals = env.api._internals;
  const answer = audioOnlyAnswer('VID_I');
  check('only audio formats are candidates', internals.audioCandidates(answer).length === 2,
    internals.audioCandidates(answer).length);
  check('the video-only format is ignored',
    !internals.audioCandidates(answer).some((f) => f.itag === 137));
  check('highest bitrate wins', internals.pickAudio(answer).itag === 251);
  check('no audio format means no candidate', internals.pickAudio({ streamingData: { adaptiveFormats: [] } }) === null);

  const s = env.api.status();
  const redacted = env.api.redact.stringify({ status: s, events: env.api._state.log });
  const raw = JSON.stringify(s);
  check('no signature value in the redacted status',
    redacted.indexOf('SIG140') < 0 && redacted.indexOf('SIG251') < 0);
  check('no raw URL anywhere in the status', raw.indexOf('videoplayback') < 0 && raw.indexOf('&sig=') < 0);
  check('no signature value anywhere in the status',
    raw.indexOf('SIG140') < 0 && raw.indexOf('SIG251') < 0);
  check('host and param NAMES stay readable',
    redacted.indexOf('rr1---sn-x.googlevideo.com') > 0 && redacted.indexOf('"sig"') > 0);
  check('the status carries the fetch-level credential fact',
    s.switch.actualFetchLevelCredentials.indexOf("'omit'") > 0);
  check('the cookie question is answered explicitly',
    s.switch.cookieAccess.indexOf('none') === 0, s.switch.cookieAccess);
  check('the status keeps its honesty block',
    !!(s.claims && typeof s.claims.proven === 'string' && typeof s.claims.notProven === 'string'));
  check('the log keeps no signature either',
    env.api.redact.text(JSON.stringify(env.api._state.log), 100000).indexOf('SIG140') < 0);
  env.close();
}

async function s12_backgroundAndContentAgreeOnMessages() {
  const sentByContent = [];
  const contentListeners = {};
  const chromeStub = {
    runtime: {
      id: 'stub-extension',
      onMessage: { addListener: (fn) => { contentListeners.content = fn; } },
      sendMessage: (msg, cb) => { sentByContent.push(msg); if (typeof cb === 'function') cb(); },
      get lastError() { return undefined; },
    },
  };
  const env = createEnv({
    videoId: 'VID_J', pagePlaying: true, pageTime: 5, sandboxExtra: { chrome: chromeStub },
  });
  tightTimings(env.api);
  env.responder = okResponder;
  check('the content script announced its state on start',
    sentByContent.length >= 1 && sentByContent[0].type === 'audio-only.state',
    JSON.stringify(sentByContent.length ? sentByContent[0].type : null));
  check('the state message carries the field the background reads',
    !!(sentByContent[0] && sentByContent[0].state && typeof sentByContent[0].state.mode === 'string'));
  check('the content script registered a message listener', typeof contentListeners.content === 'function');

  // The real background file with a fake browser API.
  const sentByBackground = [];
  const badges = [];
  const bgListeners = {};
  const browserStub = {
    action: {
      onClicked: { addListener: (fn) => { bgListeners.click = fn; } },
      setBadgeText: async (arg) => { badges.push(arg); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    commands: { onCommand: { addListener: (fn) => { bgListeners.command = fn; } } },
    runtime: { onMessage: { addListener: (fn) => { bgListeners.status = fn; } } },
    tabs: {
      query: async () => [{ id: 7, url: 'https://www.youtube.com/watch?v=VID_J' }],
      sendMessage: async (tabId, msg) => { sentByBackground.push(msg); return { ok: true, status: { mode: 'active', verified: true } }; },
    },
  };
  const bgSandbox = { browser: browserStub, console: env.sandbox.console, setTimeout, clearTimeout };
  vm.createContext(bgSandbox);
  vm.runInContext(fs.readFileSync(BACKGROUND_PATH, 'utf8'), bgSandbox, { filename: 'background.js' });
  check('the background registered click, shortcut and status listeners',
    !!(bgListeners.click && bgListeners.command && bgListeners.status));

  bgListeners.click();                                 // toolbar button and shortcut use the same path
  await wait(40);
  check('the background reads the actual response envelope', badges.some((b) => b.text === 'ON'));
  const toggleType = sentByBackground[0] && sentByBackground[0].type;
  check('the background asks with the name the content script implements',
    toggleType === 'audio-only.toggle', String(toggleType));
  const answer = await new Promise((resolve) => {
    const isAsync = contentListeners.content({ type: toggleType }, {}, resolve);
    if (isAsync !== true) resolve(null);               // synchronous reply
  });
  check('the content script answers without an unknown-type error',
    !!(answer && answer.ok === true && answer.status), JSON.stringify(answer && (answer.error || answer.ok)));
  check('toggling through the background turned the mode on', env.api.status().mode === 'active',
    env.api.status().mode);

  // Badge path: the background has to read the field that the content script really sends. Only the
  // badge paints caused by these two state messages count - the click above painted one of its own.
  const mark = badges.length;
  bgListeners.status({ type: 'audio-only.state', state: { mode: 'active', verified: true } }, { tab: { id: 7 } });
  await wait(30);
  const fromState = badges.slice(mark);
  check('the background paints the ON badge from that state message',
    fromState.length === 1 && fromState[0].text === 'ON', JSON.stringify(fromState));
  bgListeners.status({ type: 'audio-only.state', state: { mode: 'error' } }, { tab: { id: 7 } });
  await wait(30);
  const fromError = badges.slice(mark + fromState.length);
  check('an error state paints the error badge',
    fromError.length === 1 && fromError[0].text === '!', JSON.stringify(fromError));
  // The hand-back has its own mode; it must not fall through to an empty badge.
  bgListeners.status({ type: 'audio-only.state', state: { mode: 'restore-failed' } }, { tab: { id: 7 } });
  await wait(30);
  const fromRestore = badges.slice(mark + fromState.length + fromError.length);
  check('a failed hand-back paints the warning badge, not an empty one',
    fromRestore.length === 1 && fromRestore[0].text === '!', JSON.stringify(fromRestore));
  const ignored = badges.length;
  bgListeners.status({ type: 'audio-only.state', state: { mode: 'active' } }, {});                    // no tab
  bgListeners.status({ type: 'something-else', state: { mode: 'active' } }, { tab: { id: 7 } });      // other
  await wait(30);
  check('a message without a tab or with a foreign name paints nothing',
    badges.length === ignored, JSON.stringify(badges.slice(ignored)));
  bgListeners.status({ type: 'audio-only.state', state: null }, { tab: { id: 7 } });
  await wait(30);
  check('a state without a mode clears the badge',
    badges.length === ignored + 1 && badges[ignored].text === '', JSON.stringify(badges.slice(ignored)));
  env.close();
}

// ------------------------------------------------------- resolver alignment
// s13-s16 pin the resolver to the path the console snippet proved: a bounded, single repetition with
// the visitorData YouTube itself handed out, and an honest classification. The value must never show
// up in any output - only the fact that it was sent or repeated may.
async function s13_visitorDataRepeatUsesTheServersOwnValue() {
  const sentByContent = [];
  const chromeStub = {
    runtime: {
      id: 'stub-extension',
      onMessage: { addListener: () => {} },
      sendMessage: (msg, cb) => { sentByContent.push(msg); if (typeof cb === 'function') cb(); },
      get lastError() { return undefined; },
    },
  };
  const MARK = 'VISITOR_MARKER_13';
  const env = createEnv({ videoId: 'VID_K', pagePlaying: true, pageTime: 20,
    sandboxExtra: { chrome: chromeStub } });
  tightTimings(env.api);
  // Exactly what the real endpoint did in the live run: no audio URL, but a visitorData in the
  // answer. Only a request that carries that value back gets streaming data.
  env.responder = (call) => ((call.clientContext && call.clientContext.visitorData)
    ? { json: audioOnlyAnswer(call.videoId) }
    : { json: noStreamsAnswer({ visitorData: MARK, videoId: call.videoId }) });
  await env.api.enable('smoke');
  const s = env.api.status();
  const internals = env.api._internals;

  check('the resolver repeated the request exactly once', env.fetches.length === 2, env.fetches.length);
  check('the first request carried no visitorData at all',
    !(env.fetches[0].clientContext && 'visitorData' in env.fetches[0].clientContext));
  check('the repeat carried exactly the value the server handed out',
    !!env.fetches[1].clientContext && env.fetches[1].clientContext.visitorData === MARK);
  check('the repeat used the same client and the same endpoint',
    env.fetches[1].clientName === env.fetches[0].clientName && env.fetches[1].url === env.fetches[0].url,
    env.fetches.map((f) => f.clientName).join(','));
  check('credentials stay omit on both requests',
    env.fetches.every((f) => f.credentials === 'omit' && f.mode === 'same-origin'));
  check('the round succeeded after the repeat', s.mode === 'active', s.mode);
  check('exactly one repetition is counted', s.counters.visitorDataRepeats === 1, s.counters.visitorDataRepeats);
  check('the status reports the repetition as booleans only',
    !!s.switch && !!s.switch.visitorData && s.switch.visitorData.sent === true &&
    s.switch.visitorData.repeats === 1 && s.switch.visitorData.valueRecorded === false,
    JSON.stringify(s.switch && s.switch.visitorData));
  const exported = JSON.stringify(s) + '|' + JSON.stringify(sentByContent) + '|' +
    env.api.redact.stringify(env.api._state.log);
  check('the visitorData value appears in no output at all', exported.indexOf(MARK) < 0);
  check('the value lives in the closure only - never in the report', env.api._state.visitorData === MARK);
  check('the answer line shows the repetition without the value',
    internals.answerFacts(s).indexOf('[+visitorData]') > 0 && internals.answerFacts(s).indexOf(MARK) < 0,
    internals.answerFacts(s));
  check('the report does not invent a prior client result',
    !!s.switch && Array.isArray(s.switch.priorClientOutcomes) && s.switch.priorClientOutcomes.length === 0,
    JSON.stringify(s.switch && s.switch.priorClientOutcomes));
  env.close();
}

async function s14_visitorDataRepeatIsBounded() {
  const MARK = 'VISITOR_MARKER_14';
  const env = createEnv({ videoId: 'VID_L', pagePlaying: true, pageTime: 8 });
  tightTimings(env.api);
  // Every answer hands out a visitorData and none ever carries usable audio - the worst case for a
  // retry loop. The resolver must stop after the first repetition instead of asking again. Note the
  // `withEmptyStreamingData` here: an answer CAN have streamingData and still contain no usable audio
  // format, and that case must repeat too (the snippet only repeats when streamingData is missing).
  env.responder = (call) => ({ json: noStreamsAnswer({
    visitorData: MARK, videoId: call.videoId, withEmptyStreamingData: true }) });
  await env.api.enable('smoke');
  const s = env.api.status();
  const byClient = (name) => env.fetches.filter((f) => f.clientName === name).length;

  check('three clients and exactly one repetition: no loop, no second try',
    env.fetches.length === 4, env.fetches.map((f) => f.clientName).join(','));
  check('the first client is the one that was repeated', byClient('101') === 2, byClient('101'));
  check('the later clients were not repeated', byClient('28') === 1 && byClient('5') === 1,
    JSON.stringify({ android_vr: byClient('28'), ios: byClient('5') }));
  check('the value the server handed out is reused for the later clients',
    !!env.fetches[2].clientContext && env.fetches[2].clientContext.visitorData === MARK);
  check('every request still used credentials omit',
    env.fetches.every((f) => f.credentials === 'omit'), env.fetches.length);
  check('the counter stops at one', s.counters.visitorDataRepeats === 1, s.counters.visitorDataRepeats);
  check('the failure keeps all three client results in order',
    s.lastError.clientOutcomes.length === 3 &&
    s.lastError.clientOutcomes.map((a) => a.client).join(',') === 'visionos,android_vr,ios',
    JSON.stringify(s.lastError.clientOutcomes.map((a) => a.client)));
  check('the repeated client is marked as such in the report',
    s.lastError.clientOutcomes[0].retriedWithVisitorData === true &&
    s.lastError.clientOutcomes[1].retriedWithVisitorData === false,
    JSON.stringify(s.lastError.clientOutcomes.map((a) => a.retriedWithVisitorData)));
  check('the code names the missing audio URL, not a bot check',
    s.lastError.code === 'no-audio-url', s.lastError.code);
  check('a uniform sweep is not reported as a mixed one', s.lastError.mixed === false, s.lastError.mixed);
  check('no visitorData value in the error report', JSON.stringify(s.lastError).indexOf(MARK) < 0);
  check('the element was never touched', env.video.src === env.originalSrc);
  env.close();
}

async function s15_botCheckIsNotAnAgeRestriction() {
  const env = createEnv({ videoId: 'VID_M', pagePlaying: true, pageTime: 30 });
  tightTimings(env.api);
  env.responder = () => ({ json: botCheckAnswer() });
  await env.api.enable('smoke');
  const s = env.api.status();

  check('the failure is reported as a bot check', s.lastError.code === 'bot-check', s.lastError.code);
  check('it is neither an age gate nor a plain sign-in',
    s.lastError.code !== 'age-restricted' && s.lastError.code !== 'login-required');
  check('the message names the bot check the user sees',
    s.lastError.message.indexOf('bot check') > 0, s.lastError.message);
  check('the hint denies the age/content reading explicitly',
    s.lastError.hint.indexOf('NOT a proven age or content restriction') > 0, s.lastError.hint);
  check('the bot suspicion is flagged as a suspicion',
    s.lastError.botCheckSuspected === true, s.lastError.botCheckSuspected);
  check('all three client answers are kept',
    s.lastError.clientOutcomes.length === 3, s.lastError.clientOutcomes.length);
  check('the server wording survives per client',
    s.lastError.clientOutcomes.every((a) => String(a.reason).indexOf('not a bot') > 0),
    JSON.stringify(s.lastError.clientOutcomes.map((a) => a.reason)));
  check('the answer line shows the bot reason for the first client',
    env.api._internals.answerFacts(s).indexOf('visionos=playability:LOGIN_REQUIRED') >= 0,
    env.api._internals.answerFacts(s));
  check('no visitorData was sent although none was needed',
    env.fetches.every((f) => !(f.clientContext && 'visitorData' in f.clientContext)));
  check('the element was not touched', env.video.src === env.originalSrc);
  env.close();
}

async function s15b_ageGateStaysItsOwnCode() {
  const gate = createEnv({ videoId: 'VID_M2', pagePlaying: true, pageTime: 4 });
  tightTimings(gate.api);
  gate.responder = () => ({ json: ageGateAnswer() });
  await gate.api.enable('smoke');
  const gs = gate.api.status();
  check('a real age gate is still reported as an age gate',
    gs.lastError.code === 'age-restricted', gs.lastError.code);
  check('the age gate is not called a bot check',
    gs.lastError.botCheckSuspected === false, gs.lastError.botCheckSuspected);
  gate.close();
}

async function s15c_mixedClientsBothStayInTheReport() {
  const mixed = createEnv({ videoId: 'VID_M3', pagePlaying: true, pageTime: 11 });
  tightTimings(mixed.api);
  mixed.responder = (call) => ({ json: call.clientName === '101'
    ? botCheckAnswer() : audioOnlyAnswer(call.videoId) });
  await mixed.api.enable('smoke');
  const ms = mixed.api.status();
  check('the switch still succeeds on a later client', ms.mode === 'active', ms.mode);
  check('the client that worked is named', !!ms.switch && ms.switch.client === 'android_vr',
    ms.switch && ms.switch.client);
  check('the bot-checked client is still in the report',
    !!ms.switch && ms.switch.priorClientOutcomes.length === 1 &&
    ms.switch.priorClientOutcomes[0].client === 'visionos' &&
    ms.switch.priorClientOutcomes[0].outcome === 'playability:LOGIN_REQUIRED',
    JSON.stringify(ms.switch && ms.switch.priorClientOutcomes));
  check('the answer line shows both answers side by side',
    mixed.api._internals.answerFacts(ms).indexOf('android_vr=audio') >= 0 &&
    mixed.api._internals.answerFacts(ms).indexOf('visionos=playability:LOGIN_REQUIRED') >= 0,
    mixed.api._internals.answerFacts(ms));
  mixed.close();
}

async function s16_noVisitorDataIsInvented() {
  const env = createEnv({ videoId: 'VID_N', pagePlaying: true, pageTime: 15 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  const s = env.api.status();

  check('one request, no repetition',
    env.fetches.length === 1 && s.counters.visitorDataRepeats === 0, env.fetches.length);
  check('no request carried a visitorData key at all',
    env.fetches.every((f) => !(f.clientContext && 'visitorData' in f.clientContext)));
  check('the status says no visitorData was sent',
    !!s.switch && !!s.switch.visitorData && s.switch.visitorData.sent === false &&
    s.switch.visitorData.repeats === 0,
    JSON.stringify(s.switch && s.switch.visitorData));
  check('the client context still carries name and version',
    env.fetches[0].clientContext.clientName === 'VISIONOS' &&
    !!env.fetches[0].clientContext.clientVersion,
    JSON.stringify({ n: env.fetches[0].clientContext.clientName,
                     v: env.fetches[0].clientContext.clientVersion }));
  check('credentials omit is still the fetch-level setting',
    env.fetches[0].credentials === 'omit' &&
    s.switch.actualFetchLevelCredentials.indexOf("'omit'") > 0,
    s.switch.actualFetchLevelCredentials);
  check('the answer line marks no repetition',
    env.api._internals.answerFacts(s).indexOf('[+visitorData]') < 0);
  env.close();
}

// ------------------------------------------------- track change vs. watchdog
// The race, in exactly this order: track A is active, the change to B is detected (videoId B is set,
// the settle timer is running), YouTube writes its OWN blob src for B before that timer expires, and
// the watchdog runs inside that window. If the watchdog re-applies A's cached URL now, it pairs the
// NEW videoId with the OLD URL AND opens a new generation - the pending track change then hits the
// epoch check and is logged as "debounced-away": A's audio keeps playing for B and B is never
// resolved. This scenario pins the corrected behaviour, including that the old URL is never set a
// second time and that the applied source and the status both belong to B.
async function s17_trackChangeOutrunsTheWatchdogReapply() {
  const pageBlobForB = 'blob:https://www.youtube.com/page-wrote-track-b';
  const env = createEnv({ videoId: 'VID_A', pagePlaying: true, pageTime: 42 });
  tightTimings(env.api);                       // settleAfterNavMs 60, watchdogMs 40, navPollMs 40
  env.responder = okResponder;
  await env.api.enable('smoke');
  const sA = env.api.status();
  const loadsOf = (id) => env.media.loadedUrls.filter((u) => u.indexOf(id) > 0).length;

  check('A is active and its URL is bound to A',
    sA.mode === 'active' && sA.videoId === 'VID_A' && sA.switch.videoId === 'VID_A' &&
    sA.switch.locked === false,
    JSON.stringify({ m: sA.mode, v: sA.videoId, sw: sA.switch && sA.switch.videoId }));
  check('A was loaded exactly once so far', loadsOf('VID_A') === 1,
    JSON.stringify(env.media.loadedUrls.map((u) => u.slice(-30))));

  // 1. the user clicks the next track: exactly what the event/poll does
  env.videoId = 'VID_B';
  env.pageTime = 0;
  env.api._internals.onPossibleTrackChange('yt-navigate-finish');
  const after = env.api.status();
  check('the track change was seen and the settle window is open',
    after.videoId === 'VID_B' && after.mode === 'resolving',
    JSON.stringify({ v: after.videoId, m: after.mode }));
  check('the cache of track A is locked for re-apply',
    after.switch.locked === true && after.switch.lockReason === 'track-change' &&
    env.api._state.audio.locked === true,
    JSON.stringify({ l: after.switch.locked, r: after.switch.lockReason }));
  check('the locked cache still names the track it was resolved for',
    after.switch.videoId === 'VID_A' && env.api._state.audio.videoId === 'VID_A',
    JSON.stringify({ sw: after.switch.videoId, st: env.api._state.audio.videoId }));
  check('the watchdog of the old track is switched off', env.api._state.watch === null,
    String(env.api._state.watch));
  check('the src observer of the old track is switched off',
    env.api._state.audio.observer === null);

  // 2. YouTube writes its own blob for B before the settle timer expires
  env.video.writesByPage(pageBlobForB);

  // 3. the watchdog runs inside that window
  const tick = await env.api._internals.watchdogTick();
  check('the watchdog ran but did not re-apply anything', tick === undefined, String(tick));
  check('the old URL (A) was not put back', env.video.src.indexOf('VID_A') < 0,
    env.video.src.slice(0, 60));
  check('the page keeps its own src', env.video.src === pageBlobForB, env.video.src);
  check('the skipped watchdog is counted', env.api.status().counters.watchdogSkips >= 1,
    JSON.stringify(env.api.status().counters.watchdogSkips));

  // a direct re-apply of the old track must be refused without ANY side effect (no generation bump)
  const epochBefore = env.api._state.epoch;
  const refused = await env.api._internals.reapply('page-reclaim');
  check('a re-apply of the old track is refused as stale',
    !!refused && refused.skipped === 'stale-track', JSON.stringify(refused));
  check('the refusal does not open a new generation', env.api._state.epoch === epochBefore,
    JSON.stringify({ before: epochBefore, now: env.api._state.epoch }));

  // 4. the settle window elapses: B is resolved and played
  const applied = await waitUntil(() => {
    const s = env.api.status();
    return s.mode === 'active' && s.videoId === 'VID_B' && s.verified === true;
  }, 3000);
  const sB = env.api.status();
  check('track B was resolved and is playing', !!applied,
    JSON.stringify({ m: sB.mode, v: sB.videoId, p: sB.playback && sB.playback.verdict }));
  check('the track change was NOT debounced away',
    env.api._state.log.filter((e) => e.event === 'track-change:debounced-away').length === 0,
    JSON.stringify(env.api._state.log.filter((e) => e.event === 'track-change:debounced-away')));
  check('status and applied source both belong to B',
    sB.videoId === 'VID_B' && sB.switch.videoId === 'VID_B' && sB.switch.locked === false &&
    env.video.src.indexOf('VID_B') > 0,
    JSON.stringify({ v: sB.videoId, sw: sB.switch.videoId, src: env.video.src.slice(0, 60) }));
  check('the new record is bound to B, unlocked and fresh',
    env.api._state.audio.videoId === 'VID_B' && env.api._state.audio.locked === false &&
    sB.switch.pageSrcWrites === 0,
    JSON.stringify({ v: env.api._state.audio.videoId, l: env.api._state.audio.locked,
                     page: sB.switch.pageSrcWrites }));
  check('the old URL (A) was never set a second time', loadsOf('VID_A') === 1,
    JSON.stringify(env.media.loadedUrls.map((u) => u.slice(-30))));
  check('the last load belongs to B',
    loadsOf('VID_B') === 1 && env.video.src.indexOf('VID_B') > 0,
    JSON.stringify(env.media.loadedUrls.map((u) => u.slice(-30))));
  check('B needed exactly one resolve, no extra request for A',
    env.fetches.length === 2 && env.fetches[1].videoId === 'VID_B',
    JSON.stringify(env.fetches.map((f) => f.videoId)));
  env.close();
}

// The layer underneath the lock: whatever code path asks for an application, the videoId inside the
// plan and the current generation decide - and that check sits immediately before the element is
// touched. Here a plan that was resolved for the track the page has just left is handed to the
// applier directly, with a generation number that is still current: only the videoId differs. It must
// be refused without touching the element.
async function s17b_applyRefusesPlanOfAnotherTrack() {
  const env = createEnv({ videoId: 'VID_X', pagePlaying: true, pageTime: 12 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  const srcBefore = env.video.src;
  const loadsBefore = env.video.loadCalls;
  const playsBefore = env.video.playCalls;

  env.videoId = 'VID_Y';
  env.api._internals.onPossibleTrackChange('yt-navigate-finish');   // the page has moved on
  const modeAfterChange = env.api.status().mode;
  // Stop the settle timer of the track change: this scenario is about the applier's own check, not
  // about the debounce (that is s17).
  clearTimeout(env.api._state.nav.timer);
  env.api._state.nav.timer = null;

  const plan = {
    ok: true, epoch: env.api._state.epoch, videoId: 'VID_X', client: 'visionos',
    audio: { url: 'https://rr1---sn-x.googlevideo.com/videoplayback?v=VID_X&itag=140&sig=OLD',
             itag: 140, mime: 'audio/mp4; codecs="mp4a.40.2"' },
    playabilityStatus: null,
  };
  const result = await env.api._internals.applyAudio(plan, {});
  const s = env.api.status();

  check('a plan for a track the page has left is refused',
    !!result && result.stale === true && result.reason === 'stale-plan:before-any-touch',
    JSON.stringify(result && { stale: result.stale, reason: result.reason }));
  check('the element was not touched at all',
    env.video.src === srcBefore && env.video.loadCalls === loadsBefore,
    JSON.stringify({ sameSrc: env.video.src === srcBefore, loads: env.video.loadCalls }));
  check('no play() was attempted either', env.video.playCalls === playsBefore, env.video.playCalls);
  check('the refusal is counted as a dropped stale answer', s.counters.staleDropped >= 1,
    JSON.stringify(s.counters.staleDropped));
  check('the refusal does not change the mode', s.mode === modeAfterChange,
    JSON.stringify({ before: modeAfterChange, after: s.mode }));
  check('the locked record was not applied and not re-bound',
    env.api._state.audio.applies === 1 && env.api._state.audio.assignedSrc === srcBefore &&
    env.api._state.audio.locked === true,
    JSON.stringify({ applies: env.api._state.audio.applies,
                     sameSrc: env.api._state.audio.assignedSrc === srcBefore,
                     locked: env.api._state.audio.locked }));
  env.close();
}

// ------------------------------------------------------------ switching back
// The hand-back (mode on -> off) is its own area with its own failure modes: the page's own source is
// dead by the time we want to give it back, the call into page code can be refused at the browser's
// context boundary, the player clock can be unreadable, and the user can switch off while the takeover
// is still running. s18-s24 nail those down.
function panelText(env) {
  env.api.showPanel();
  const p = env.api._state.panel;
  const walk = (node) => (node.children || []).map((c) => (c.textContent || '') + ' ' + walk(c)).join(' ');
  return (String(p.root.textContent || '') + ' ' + walk(p.root)).replace(/\s+/g, ' ');
}

// A track change, then switching off: the hand-back may only name the video that is running now, and
// it may not resurrect the source of the track that is gone.
async function s18_handBackAfterATrackChangeUsesTheRunningTrack() {
  const env = createEnv({ videoId: 'VID_A', pagePlaying: true, pageTime: 42 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  const loadsOf = (id) => env.media.loadedUrls.filter((u) => u.indexOf(id) > 0).length;

  env.videoId = 'VID_B';
  env.pageTime = 12;
  env.api._internals.onPossibleTrackChange('yt-navigate-finish');
  const applied = await waitUntil(() => {
    const s = env.api.status();
    return s.mode === 'active' && s.videoId === 'VID_B';
  }, 3000);
  check('track B is the running track', !!applied, JSON.stringify(env.api.status().mode));

  const back = await env.api.disable('smoke');
  const s = env.api.status();
  check('the hand-back names video B, not A',
    env.playerCalls.length === 1 && env.playerCalls[0].videoId === 'VID_B',
    JSON.stringify(env.playerCalls));
  check('it carries the current position of track B',
    Math.abs(env.playerCalls[0].startSeconds - 12) < 2, JSON.stringify(env.playerCalls[0]));
  check('the audio source of A was never set a second time', loadsOf('VID_A') === 1,
    JSON.stringify(env.media.loadedUrls.map((u) => u.slice(-30))));
  check('no page/blob URL was written back by us',
    env.media.loadedUrls.indexOf(env.originalSrc) < 0 && env.media.deadLoads.length === 0,
    JSON.stringify(env.media.deadLoads));
  check('the hand-back is reported as successful and the mode is off',
    back.ok === true && back.method === 'player.loadVideoById' && s.mode === 'off' &&
    s.counters.restoreFailures === 0,
    JSON.stringify({ ok: back.ok, m: back.method, mode: s.mode, rf: s.counters.restoreFailures }));
  check('the report says the page source was never rewritten',
    /never/.test(String(back.blobRewrite)), String(back.blobRewrite));
  env.close();
}

// The player clock is not readable (a player that is still rebuilding). The position must then come
// from the element - never from an invented 0, which is exactly how the old code restarted a track.
async function s19_missingPlayerClockUsesTheElementPosition() {
  const env = createEnv({ videoId: 'VID_CLK', pagePlaying: true, pageTime: 0, playerClockRefusal: true });
  tightTimings(env.api);
  env.responder = okResponder;
  env.video._time = 77;                          // the element's own position, the only readable one
  await env.api.enable('smoke');
  const sOn = env.api.status();
  check('the switch used the element position as its target',
    sOn.position.target === 77 && sOn.position.restored === true, JSON.stringify(sOn.position));

  const back = await env.api.disable('smoke');
  const s = env.api.status();
  check('the hand-back took the current element position',
    back.positionSource === 'live-element-position' && Math.abs(back.positionTarget - 77) < 2,
    JSON.stringify({ src: back.positionSource, t: back.positionTarget }));
  check('startSeconds stays near 77, not 0', Math.abs(back.startSeconds - 77) < 2,
    JSON.stringify({ startSeconds: back.startSeconds }));
  check('the call really carried it', env.playerCalls.length === 1 &&
    Math.abs(env.playerCalls[0].startSeconds - 77) < 2 && env.playerCalls[0].videoId === 'VID_CLK',
    JSON.stringify(env.playerCalls));
  check('the element is back near 77s', Math.abs(env.video.currentTime - 77) < 2, env.video.currentTime);
  check('the hand-back succeeded', back.ok === true && s.mode === 'off',
    JSON.stringify({ ok: back.ok, mode: s.mode }));
  env.close();
}

// A hand-back with no readable position must not pretend a start either: the call goes out without
// startSeconds instead of asking for 0.
async function s19b_noPositionAtAllSendsNoStartSeconds() {
  const env = createEnv({ videoId: 'VID_NS', pagePlaying: true, pageTime: 0, playerClockRefusal: true });
  tightTimings(env.api);
  env.responder = okResponder;
  env.video._time = 0;                            // the element has nothing to hand back either
  await env.api.enable('smoke');
  env.video._time = NaN;
  env.api._state.before.time = null;
  env.api._state.before.pageTime = null;
  env.api._state.audio.streamClock = null;
  const back = await env.api.disable('smoke');
  const call = env.playerCalls[0];
  check('the call goes out without startSeconds',
    !!call && !('startSeconds' in call) && back.startSeconds === null,
    JSON.stringify({ call, startSeconds: back.startSeconds }));
  check('the report names the element position as its source',
    back.positionSource === 'none' && back.positionTarget === null,
    JSON.stringify({ src: back.positionSource, t: back.positionTarget }));
  check('the report says why no start was sent',
    /no startSeconds/.test(String(back.startSecondsNote)), String(back.startSecondsNote));
  check('the hand-back still succeeded and the mode is off',
    back.ok === true && env.api.status().mode === 'off', JSON.stringify({ ok: back.ok }));
  env.close();
}

// The call into page code is refused at the browser's context boundary - the live failure. Two shapes:
// a build without cloneInto (the foreign array is what gets refused) and an explicit SecurityError.
// Both must end in the same visible state, and neither may hang or touch the element any further.
async function s20_refusedCrossContextCallIsVisible() {
  const env = createEnv({ videoId: 'VID_X1', pagePlaying: true, pageTime: 18, noCloneInto: true });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  const seeksBefore = env.video.seekWrites.length;
  const playsBefore = env.video.playCalls;
  const started = Date.now();
  const back = await env.api.disable('smoke');
  const took = Date.now() - started;
  const s = env.api.status();

  check('the build really had no cloneInto', env.cloneIntoCount === 0 && back.argsBridge === 'direct',
    JSON.stringify({ clones: env.cloneIntoCount, bridge: back.argsBridge }));
  check('the refusal is reported as a context refusal',
    back.playerCall && back.playerCall.error === 'cross-context-refused' &&
    back.playerCall.refusedBy === 'Error' &&
    /Permission denied/.test(String(back.playerCall.message)),
    JSON.stringify(back.playerCall));
  check('the second attempt is documented in the report', back.playerCall.retried === true,
    JSON.stringify({ retried: back.playerCall && back.playerCall.retried }));
  check('nothing is claimed as handed back',
    back.ok === false && back.method === null,
    JSON.stringify({ ok: back.ok, method: back.method }));
  check('the metadata wait was skipped, not burned through', /^skipped/.test(String(back.metaWait)),
    String(back.metaWait));
  check('the call returns instead of waiting for a source that never comes', took < 1200, took + ' ms');
  check('the element was not touched after the refusal',
    env.video.seekWrites.length === seeksBefore && env.video.playCalls === playsBefore,
    JSON.stringify({ seeks: [seeksBefore, env.video.seekWrites.length], plays: env.video.playCalls }));
  check('our source is still on the element (nothing was faked as restored)',
    env.video.src.indexOf('itag=251') > 0, env.video.src.slice(0, 60));
  check('the failed hand-back has its own visible mode',
    s.mode === 'restore-failed' && s.verified === false, JSON.stringify({ mode: s.mode }));
  check('the error record names the reason and offers a way out',
    !!s.lastError && s.lastError.code === 'restore-failed' &&
    s.lastError.reason === 'cross-context-refused' && /F5/.test(s.lastError.hint),
    JSON.stringify(s.lastError));
  check('the counter counts the failed hand-back', s.counters.restoreFailures === 1,
    JSON.stringify(s.counters));
  const panel = panelText(env);
  check('the panel shows the failed hand-back and its reason',
    panel.indexOf('Hand-back:') > 0 && panel.indexOf('FAILED') > 0 &&
    panel.indexOf('cross-context-refused') > 0 && panel.indexOf('restore-failed') > 0,
    panel.slice(Math.max(0, panel.indexOf('Hand-back:')), panel.indexOf('Hand-back:') + 200));
  env.close();

  // The same outcome when the boundary answers with its own error class.
  const sec = createEnv({ videoId: 'VID_X2', pagePlaying: true, pageTime: 18,
    playerRefusal: { name: 'SecurityError', message: 'Permission denied to access property "length"' } });
  tightTimings(sec.api);
  sec.responder = okResponder;
  await sec.api.enable('smoke');
  const back2 = await sec.api.disable('smoke');
  const s2 = sec.api.status();
  check('a SecurityError is classified the same way',
    back2.playerCall.error === 'cross-context-refused' && back2.playerCall.refusedBy === 'SecurityError',
    JSON.stringify(back2.playerCall));
  check('the arguments had been cloned before that refusal',
    back2.playerCall.argsBridge === 'cloneInto' && sec.cloneIntoCount >= 1,
    JSON.stringify({ bridge: back2.playerCall.argsBridge, clones: sec.cloneIntoCount }));
  check('the visible state is the same',
    s2.mode === 'restore-failed' && !!s2.lastError &&
    s2.lastError.reason === 'cross-context-refused' && s2.counters.restoreFailures === 1,
    JSON.stringify({ mode: s2.mode, reason: s2.lastError && s2.lastError.reason }));
  sec.close();
}

// Switching off while the takeover is still running: the late apply must lose, the page must get its
// element back, and no half-applied takeover may be reported as done.
async function s21_disableWhileTheApplyIsStillRunning() {
  const env = createEnv({ videoId: 'VID_MID', pagePlaying: true, pageTime: 12,
    readyAfterMs: 350, fullReadyAfterMs: 500 });
  tightTimings(env.api, { restoreSettleMs: 1200, metadataTimeoutMs: 2000 });
  env.responder = okResponder;
  const pending = env.api.enable('smoke');
  const started = await waitUntil(() => env.video.src.indexOf('itag=251') > 0, 800);
  check('the takeover really started (our URL is on the element)', !!started, env.video.src.slice(0, 50));
  check('the switch is still in flight', env.api.status().mode === 'resolving', env.api.status().mode);

  const back = await env.api.disable('mid-apply');
  const applied = await pending;
  const s = env.api.status();
  const log = env.api._state.log;
  check('the in-flight apply was abandoned, not completed',
    !!applied && applied.stale === true && /stale-plan/.test(String(applied.reason)) &&
    log.some((e) => e.event === 'apply:abandoned'),
    JSON.stringify({ applied: applied && { stale: applied.stale, reason: applied.reason } }));
  check('the late apply never reported a finished switch',
    log.filter((e) => e.event === 'switch:done').length === 0 &&
    s.playback === null && s.verified === false,
    JSON.stringify({ done: log.filter((e) => e.event === 'switch:done').length, p: s.playback }));
  check('the page got its element back', env.video.src.startsWith('blob:') &&
    env.video.src !== env.originalSrc, env.video.src.slice(0, 60));
  check('the hand-back is reported as successful', back.ok === true && back.method === 'player.loadVideoById',
    JSON.stringify({ ok: back.ok, m: back.method }));
  check('the mode is off: the late apply did not win', s.mode === 'off', s.mode);
  check('the audio source was applied exactly once',
    env.media.loadedUrls.filter((u) => u.indexOf('itag=251') > 0).length === 1,
    JSON.stringify(env.media.loadedUrls.map((u) => u.slice(-30))));
  check('the abandoned takeover is counted', s.counters.staleDropped >= 1, JSON.stringify(s.counters));
  check('no audio session is left behind', s.switch === null);
  env.close();
}

// A page that was paused before the switch stays paused - and the hand-back counts as successful
// without a moving playhead, because none is supposed to move. No play() may be attempted.
async function s22_handBackOfAPausedPageStaysPaused() {
  const env = createEnv({ videoId: 'VID_P', pagePlaying: false, pageTime: 24 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  const back = await env.api.disable('smoke');
  const s = env.api.status();
  check('the hand-back is successful although nothing plays', back.ok === true,
    JSON.stringify({ ok: back.ok, failReason: back.failReason }));
  check('it preserves the current pause intent',
    back.pauseIntent === 'stay-paused' && back.pauseIntentSource === 'element state at restore time',
    JSON.stringify({ i: back.pauseIntent, s: back.pauseIntentSource }));
  check('no playhead progress was required or claimed',
    back.playheadAdvanced === false && back.playCalled !== true &&
    /no playhead progress required/.test(String(back.handBack)),
    JSON.stringify({ adv: back.playheadAdvanced, called: back.playCalled, note: back.handBack }));
  check('play() was never called', env.video.playCalls === 0, env.video.playCalls);
  check('the element is still paused', env.video.paused === true, env.video.paused);
  check('the position was handed back near 24s', Math.abs(env.video.currentTime - 24) < 2,
    env.video.currentTime);
  check('the call carried the paused position (24)', env.playerCalls.length === 1 &&
    Math.abs(env.playerCalls[0].startSeconds - 24) < 0.01, JSON.stringify(env.playerCalls));
  check('mode is off and no failed hand-back is counted',
    s.mode === 'off' && s.counters.restoreFailures === 0,
    JSON.stringify({ m: s.mode, rf: s.counters.restoreFailures }));
  env.close();
}

// A hand-back that cannot work is never reported as successful: (a) the page rebuilds nothing and
// (b) the rebuild happens but the playhead stands still. Both end in the visible restore-failed state.
async function s23_aFailedHandBackIsVisibleAndTouchesNothing() {
  const dead = createEnv({ videoId: 'VID_DEAD', pagePlaying: true, pageTime: 30, deadPageSource: true });
  tightTimings(dead.api, { restoreSettleMs: 300 });
  dead.responder = okResponder;
  await dead.api.enable('smoke');
  const seeksBefore = dead.video.seekWrites.length;
  const playsBefore = dead.video.playCalls;
  const back = await dead.api.disable('smoke');
  const s = dead.api.status();
  check('the page was asked and accepted the call', back.method === 'player.loadVideoById' &&
    back.playerCall.ok === true, JSON.stringify(back.playerCall));
  check('but no metadata ever arrived', back.meta === null && back.failReason === 'no-metadata' &&
    /timed out/.test(String(back.metaWait)),
    JSON.stringify({ meta: back.meta, reason: back.failReason, wait: back.metaWait }));
  check('nothing was written or played after that failure',
    dead.video.seekWrites.length === seeksBefore && dead.video.playCalls === playsBefore,
    JSON.stringify({ seeks: [seeksBefore, dead.video.seekWrites.length], plays: dead.video.playCalls }));
  check('it is not reported as handed back', back.ok === false, String(back.ok));
  check('the visible state names the reason',
    s.mode === 'restore-failed' && !!s.lastError && s.lastError.code === 'restore-failed' &&
    s.lastError.reason === 'no-metadata' && /F5/.test(s.lastError.hint),
    JSON.stringify(s.lastError || { mode: s.mode, lastError: s.lastError }));
  check('the counter and the panel show it',
    s.counters.restoreFailures === 1 &&
    /Hand-back: FAILED/.test(panelText(dead)) &&
    /reason no-metadata/.test(panelText(dead)),
    JSON.stringify(s.counters));
  dead.close();

  const still = createEnv({ videoId: 'VID_STILL', pagePlaying: true, pageTime: 40, advancePerTick: 0 });
  tightTimings(still.api);
  still.responder = okResponder;
  await still.api.enable('smoke');
  const back2 = await still.api.disable('smoke');
  const s2 = still.api.status();
  check('the rebuild succeeded and was seen', back2.meta && back2.meta.ok === true,
    JSON.stringify(back2.meta));
  check('a standing playhead is not a successful hand-back',
    back2.ok === false && back2.playheadAdvanced === false && back2.failReason === 'no-progress',
    JSON.stringify({ ok: back2.ok, adv: back2.playheadAdvanced, reason: back2.failReason }));
  check('the visible state names that reason too',
    s2.mode === 'restore-failed' && !!s2.lastError && s2.lastError.reason === 'no-progress',
    JSON.stringify({ mode: s2.mode, reason: s2.lastError && s2.lastError.reason }));
  check('it says what the user can do',
    !!(s2.lastError && /One click on the player/.test(s2.lastError.hint)),
    s2.lastError ? s2.lastError.hint : 'no lastError (mode ' + s2.mode + ')');
  still.close();
}

// ------------------------------------------------------- the clone target (s24)
// Firefox content scripts reach the page through window.wrappedJSObject. Which form of the page window
// a build accepts as a *clone scope* cannot be checked from Node, so the code offers both and reports
// the one that carried. This scene pins the choice and the fallback.
async function s24_theCloneTargetIsReportedAndFallsBackOnce() {
  const uw = createEnv({ videoId: 'VID_UW', pagePlaying: true, pageTime: 20, unwrappedPageWindow: true });
  tightTimings(uw.api);
  uw.responder = okResponder;
  await uw.api.enable('smoke');
  const back = await uw.api.disable('smoke');
  const playerCall = uw.api.status().pageApi.calls.filter((c) => c.name === 'loadVideoById')[0] || {};
  check('the unwrapped page window is used when the build has one',
    back.ok === true && back.argsBridge === 'cloneInto' && back.cloneTarget === 'window.wrappedJSObject',
    JSON.stringify({ ok: back.ok, bridge: back.argsBridge, target: back.cloneTarget }));
  check('the report of the call names the same target',
    playerCall.cloneTarget === 'window.wrappedJSObject' && playerCall.ok === true,
    JSON.stringify({ target: playerCall.cloneTarget, ok: playerCall.ok }));
  uw.close();

  // The other variant: the unwrapped window exists, but this build's cloneInto only takes the window
  // itself - the second documented form, not a failure.
  const fb = createEnv({ videoId: 'VID_FB', pagePlaying: true, pageTime: 20, cloneIntoRejectsFirstScope: true });
  tightTimings(fb.api);
  fb.responder = okResponder;
  await fb.api.enable('smoke');
  const back2 = await fb.api.disable('smoke');
  const s2 = fb.api.status();
  check('a refused first scope falls back to the plain window',
    back2.ok === true && back2.cloneTarget === 'window' && back2.argsBridge === 'cloneInto' &&
    fb.playerCalls.length === 1 && fb.inPageRealm(fb.playerCalls[0]) === true,
    JSON.stringify({ ok: back2.ok, target: back2.cloneTarget, calls: fb.playerCalls.length }));
  check('the fallback is not reported as a failed hand-back',
    s2.counters.restoreFailures === 0 && s2.mode === 'off' && s2.lastError === null,
    JSON.stringify({ restoreFailures: s2.counters.restoreFailures, mode: s2.mode }));
  fb.close();
}

// ---------------------------- the page's own apply and parameterless calls (s25)
// The page's apply reads `length` off the argument LIST - and that list is an object of THIS realm as well,
// the empty one included. getCurrentTime and getVideoData take no arguments, and the whole extension leans
// on them (the video id of every tick, the position of every hand-back), so this scene pins them down:
// no list of ours may be handed over, and without cloneInto the call goes out without any list at all.
async function s25_parameterlessCallsHandOverNoForeignList() {
  const env = createEnv({ videoId: 'VID_P0', pagePlaying: true, pageTime: 33 });
  tightTimings(env.api);
  env.responder = okResponder;

  // The model itself first: it has to refuse a foreign list of length 0, otherwise the two checks below
  // would pass for the wrong reason.
  let refused = null;
  try { env.player.getCurrentTime.apply(env.player, []); } catch (e) { refused = e && e.message; }
  check('the page apply of this model refuses an empty foreign list', /length/.test(String(refused)),
    String(refused));
  let clonedOk = null;
  try { clonedOk = env.player.getCurrentTime.apply(env.player, env.cloneInto([], env.sandbox)); }
  catch (e) { clonedOk = 'threw: ' + (e && e.message); }
  check('and it accepts a cloned list', clonedOk === 33, JSON.stringify(clonedOk));

  const id = env.api._internals.pageCall('getVideoData');
  const clock = env.api._internals.pageCall('getCurrentTime');
  check('a parameterless call is not refused by the page apply', id.ok === true && !!id.value,
    JSON.stringify(id));
  check('the second parameterless call works too', clock.ok === true && clock.value === 33,
    JSON.stringify(clock));
  check('the empty argument list is cloned like any other argument',
    id.argsBridge === 'cloneInto' && id.argsCount === 0 && id.cloneTarget !== null,
    JSON.stringify({ bridge: id.argsBridge, count: id.argsCount, target: id.cloneTarget }));
  check('nothing was counted as refused', env.api.status().pageApi.counts.refused === 0,
    JSON.stringify(env.api.status().pageApi.counts));
  await env.api.enable('smoke');
  const back = await env.api.disable('smoke');
  check('the takeover and the hand-back work with the strict page apply',
    back.ok === true && env.api.status().mode === 'off',
    JSON.stringify({ ok: back.ok, mode: env.api.status().mode }));
  env.close();

  // No cloneInto in this build: a parameterless call carries no list at all, and the report says so.
  const nc = createEnv({ videoId: 'VID_P1', pagePlaying: true, pageTime: 7, noCloneInto: true });
  const id2 = nc.api._internals.pageCall('getVideoData');
  const clock2 = nc.api._internals.pageCall('getCurrentTime');
  check('without cloneInto the call goes out without any argument list',
    id2.ok === true && id2.argsBridge === 'no-args' && id2.argsCount === 0,
    JSON.stringify({ ok: id2.ok, bridge: id2.argsBridge, count: id2.argsCount }));
  check('and the report names the missing clone as the reason',
    id2.cloneError === 'cloneInto-missing' && nc.cloneIntoCount === 0,
    JSON.stringify({ cloneError: id2.cloneError, clones: nc.cloneIntoCount }));
  check('the second one takes the same way out', clock2.ok === true && clock2.value === 7,
    JSON.stringify(clock2));
  nc.close();

  // A refused boundary is polled (the watchdog asks once a second): identical refusals are counted on the
  // entry that is already there instead of filling the log and pushing the switching events out.
  const flood = createEnv({ videoId: 'VID_P2', pagePlaying: true, noCloneInto: true, pageTime: 5,
    playerRefusal: { name: 'SecurityError', message: 'Permission denied to access property "length"',
                     names: ['getVideoData'] } });
  for (let i = 0; i < 30; i += 1) flood.api._internals.pageCall('getVideoData');
  let s = flood.api.status();
  let entries = s.events.filter((e) => e.event === 'page-call:refused');
  const refusedCount = s.pageApi.counts.refused;
  check('30 identical refusals are one log entry with a counter',
    refusedCount > 30 && entries.length === 1 && entries[0].repeats === refusedCount,
    JSON.stringify({ refused: refusedCount, entries: entries.length,
                     repeats: entries[0] && entries[0].repeats }));
  check('the report says how many copies were only counted', s.logRepeats === refusedCount - 1,
    JSON.stringify({ logRepeats: s.logRepeats, refused: refusedCount }));
  check('the repeated refusal did not fill the log', s.logSize <= 3, String(s.logSize));
  // A refusal with a different reason stays its own entry - the limit must not swallow the second cause.
  flood.playerRefusal = { name: 'SecurityError', message: 'another boundary refusal',
                          names: ['getVideoData'] };
  flood.api._internals.pageCall('getVideoData');
  s = flood.api.status();
  entries = s.events.filter((e) => e.event === 'page-call:refused');
  check('a different reason is a second entry, not a repeat',
    entries.length === 2 && s.logRepeats === refusedCount - 1 &&
    s.pageApi.counts.refused === refusedCount + 1,
    JSON.stringify({ entries: entries.length, repeats: s.logRepeats, refused: s.pageApi.counts.refused }));
  flood.close();
}


// User regression: switch on near the start, seek later, change state, then switch off.
async function s26_currentPositionAndPicture() {
  const env = createEnv({ videoId: 'VID_NOW', pagePlaying: true, pageTime: 3 });
  tightTimings(env.api);
  env.responder = okResponder;
  env.video.style.setProperty('visibility', 'visible', 'important');
  const pending = env.api.enable('smoke');
  check('picture hidden immediately while resolving', env.video.style.visibility === 'hidden');
  await pending;
  check('picture stays hidden in audio-only', env.video.style.visibility === 'hidden');
  env.video.currentTime = 60;
  env.video.pause();
  env.video.volume = 0.23;
  env.video.muted = true;
  // A stale clock must never override the user's seek or advance during a pause.
  env.api._state.audio.streamClock = { videoId: 'VID_NOW', seconds: 3, at: Date.now() - 120000 };
  const back = await env.api.disable('smoke');
  check('hand-back uses current 60-second position, not snapshot/wall time',
    back.positionSource === 'live-element-position' && back.startSeconds === 60, JSON.stringify(back));
  check('paused hand-back really stays near 60', back.ok && env.video.paused && Math.abs(env.video.currentTime - 60) < 1);
  check('current mute and volume are kept', env.video.muted && env.video.volume === 0.23);
  check('original picture style restored immediately on success',
    env.video.style.visibility === 'visible' && env.video.style.getPropertyPriority('visibility') === 'important');
  env.close();
}

async function s27_seekToZeroAndFailurePicture() {
  const env = createEnv({ videoId: 'VID_ZERO', pagePlaying: false, pageTime: 60 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable('smoke');
  env.video.currentTime = 0;
  const back = await env.api.disable('smoke');
  check('a real user seek to zero is preserved', back.startSeconds === 0 && env.video.currentTime === 0);
  check('paused state remains paused', env.video.paused);
  env.close();
  const failEnv = createEnv({ videoId: 'VID_ERR', pagePlaying: true });
  tightTimings(failEnv.api);
  failEnv.responder = () => ({ status: 403, json: {} });
  await failEnv.api.enable('smoke');
  check('failed resolution restores picture', failEnv.video.style.visibility !== 'hidden');
  failEnv.close();
}


async function s28_handBackIsSingleAndNavigationCancelsIt() {
  const env = createEnv({ videoId: 'RACE_A', pagePlaying: true, pageTime: 30 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable();
  env.readyAfterMs = 180;
  const first = env.api.disable();
  const duplicate = env.api.disable();
  check('a hand-back has its own visible state', env.api.status().mode === 'restoring');
  check('duplicate disable does not call the player twice', env.playerCalls.length === 1);
  const enable = await env.api.enable();
  check('enabling during hand-back is refused without a source write',
    enable.skipped === 'restore-in-flight' && env.fetches.length === 1);
  env.videoId = 'RACE_B';
  env.pageTime = 0;
  env.video.writesByPage('blob:new-track-B');
  env.video._time = 0;
  env.video.volume = 0.25;
  const playCalls = env.video.playCalls;
  env.api._internals.onPossibleTrackChange('smoke');
  const results = await Promise.all([first, duplicate]);
  await wait(100);
  check('both callers see that navigation cancelled the old hand-back', results.every((r) => r.stale));
  check('navigation during hand-back does not enable audio-only again',
    env.api.status().mode === 'off' && env.fetches.length === 1 && env.api.status().switch === null);
  check('old hand-back cannot seek, play or change volume on the new track',
    env.video.currentTime < 1 && env.video.playCalls === playCalls && env.video.volume === 0.25);
  env.close();
}

async function s29_handBackNeedsNewSourceAndFollowsReplacement() {
  const env = createEnv({ videoId: 'NOOP', pagePlaying: true, pageTime: 12 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable();
  env.player.loadVideoById = () => undefined; // accepted call, but page does nothing
  const out = await env.api.disable();
  check('old audio metadata cannot prove a normal hand-back', !out.ok && out.failReason === 'no-metadata');
  check('no-op page API produces a visible failure', env.api.status().mode === 'restore-failed');
  env.close();

  const swapped = createEnv({ videoId: 'REPLACED', pagePlaying: true, pageTime: 22 });
  tightTimings(swapped.api);
  swapped.responder = okResponder;
  await swapped.api.enable();
  swapped.video.currentTime = 65;
  swapped.video.pause();
  swapped.video.volume = 0.2;
  const old = swapped.video;
  const original = swapped.player.loadVideoById;
  swapped.player.loadVideoById = function(arg) {
    swapped.video = makeVideo(swapped);
    return original(arg);
  };
  const restored = await swapped.api.disable();
  check('hand-back follows the replacement video element', restored.ok && swapped.video !== old);
  check('position, pause and volume are applied to the replacement',
    swapped.video.currentTime === 65 && swapped.video.paused && swapped.video.volume === 0.2);
  swapped.close();
}

async function s30_backwardSeekAndPauseAreNotStalls() {
  const env = createEnv({ videoId: 'STALL', pagePlaying: true, pageTime: 90 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable();
  const state = env.api._state;
  state.progress = { seconds: 90, stalledSince: Date.now() - 10000, warned: false };
  env.video.currentTime = 10;
  await env.api._internals.watchdogTick();
  check('backward seek resets the watchdog clock', state.progress.seconds === 10 && !state.warning);
  state.progress.stalledSince = Date.now() - 10000;
  state.warning = { code: 'buffering' };
  env.video.pause();
  await env.api._internals.watchdogTick();
  check('pause clears the old buffering interval and warning', !state.progress.stalledSince && !state.warning);
  env.video.paused = false;
  state.progress = { seconds: 10, stalledSince: Date.now() - 10000, warned: false };
  await env.api._internals.watchdogTick();
  check('a real stationary playing clock still reports a stall',
    state.warning && state.warning.code === 'no-progress-watch');
  env.close();
}

async function s31_retryActuallyResolvesAndHideCancelsPaint() {
  const env = createEnv({ videoId: 'RETRY', pagePlaying: false, pageTime: 10 });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable();
  const fetches = env.fetches.length;
  env.video.currentTime = 60;
  await env.api.retry();
  check('Try again resolves a fresh URL even in active mode', env.fetches.length === fetches + 1);
  check('retry uses the current audio position, not the stale page clock', env.api.status().position.target === 60);
  env.api.showPanel();
  env.api._internals.renderPanel();
  env.api.hidePanel();
  await wait(170);
  check('a queued repaint cannot reopen a hidden panel', env.api._state.panel === null);
  env.close();
}


async function s32_networkAndPlayHaveDeadlines() {
  const env = createEnv({ videoId: 'TIMEOUT', pagePlaying: true, pageTime: 5 });
  tightTimings(env.api, { resolveTimeoutMs: 25 });
  env.responder = (call) => ({ json: audioOnlyAnswer(call.videoId), delayMs: 1000 });
  await env.api.enable();
  check('a hanging resolver ends in an explicit timeout',
    env.api.status().mode === 'error' && env.api.status().lastError.code === 'resolve-timeout');
  check('timed-out resolution leaves the source and picture with the page',
    env.video.src === env.originalSrc && env.video.style.visibility !== 'hidden');
  check('the timed-out fetch was actually aborted', env.fetches[0].signal.aborted);
  env.close();

  const pending = createEnv({ videoId: 'PLAY_PENDING', pagePlaying: true, pageTime: 5 });
  tightTimings(pending.api, { playStartTimeoutMs: 25 });
  pending.responder = okResponder;
  pending.media.onPlay = () => new Promise(() => {});
  await pending.api.enable();
  const playback = pending.api.status().playback;
  check('an unsettled play promise has a deadline and is not an autoplay refusal',
    playback.playRejection === 'PlayTimeoutError' && !playback.autoplayBlocked && !pending.api.status().verified);
  pending.video.paused = false; // user requested playback; the hand-back must try to start it
  const out = await pending.api.disable();
  check('a pending play promise cannot hang hand-back either',
    !out.ok && out.playRejection === 'PlayTimeoutError' && pending.api.status().mode === 'restore-failed');
  pending.close();
}


async function s33_manualResumeIsVerifiedAndNewTrackResetsIt() {
  const messages = [];
  const env = createEnv({ videoId: 'VERIFY_A', pagePlaying: false, pageTime: 10,
    sandboxExtra: { chrome: { runtime: { id: 'test', sendMessage: (m, cb) => { messages.push(m); cb(); } } } } });
  tightTimings(env.api);
  env.responder = okResponder;
  await env.api.enable();
  check('a paused start remains unverified', !env.api.status().verified);
  env.video.paused = false;
  env.video._time += 1;
  await env.api._internals.watchdogTick();
  check('manual resume is verified only after observed progress', env.api.status().verified);
  check('watchdog progress updates the toolbar state', messages[messages.length - 1].state.verified === true);
  env.videoId = 'VERIFY_B';
  env.api._internals.onPossibleTrackChange('smoke');
  check('verification from the old track is cleared before resolving the next',
    !env.api.status().verified && env.api.status().mode === 'resolving');
  env.close();
}


async function s34_trackStartsWhilePositionChecksContinue() {
  const env = createEnv({ videoId: 'EARLY_A', pagePlaying: true, pageTime: 4 });
  tightTimings(env.api, { seekReassertMs: 175 });
  env.responder = okResponder;
  await env.api.enable();
  let correctionPending = false;
  const timer = env.sandbox.setTimeout;
  env.sandbox.setTimeout = (fn, ms) => {
    if (ms !== 175) return timer(fn, ms);
    correctionPending = true;
    return timer(() => { correctionPending = false; fn(); }, ms);
  };
  const starts = [];
  const onPlay = env.media.onPlay;
  env.media.onPlay = (el) => {
    starts.push({ correctionPending, time: el.currentTime, volume: el.volume, muted: el.muted });
    return onPlay(el);
  };
  env.videoId = 'EARLY_B';
  env.pageTime = 12;
  env.video.currentTime = 12;
  env.video.volume = 0.23;
  env.video.muted = true;
  env.video.writesByPage('blob:page-track-B');
  env.api._internals.onPossibleTrackChange('smoke');
  await waitUntil(() => env.api.status().mode === 'active', 3000);
  check('new title requests play before the position correction timer expires',
    starts.length === 1 && starts[0].correctionPending, JSON.stringify(starts));
  check('the first play request is already positioned and has the current volume/mute',
    starts.length === 1 && starts[0].time === 12 && starts[0].volume === 0.23 && starts[0].muted);
  check('the new track is playing and verified without an extra play request',
    env.api.status().videoId === 'EARLY_B' && env.api.status().verified && starts.length === 1);
  check('the report records that play overlapped position checking',
    env.api.status().playback.startedDuringPositionCheck === true);
  env.close();

  const refused = createEnv({ videoId: 'EARLY_REFUSED', pagePlaying: true, pageTime: 12,
    playRejection: { name: 'NotAllowedError' } });
  tightTimings(refused.api);
  refused.responder = okResponder;
  await refused.api.enable();
  check('an early autoplay refusal is retained and never retried automatically',
    refused.video.playCalls === 1 && refused.api.status().playback.playRejection === 'NotAllowedError');
  check('an early refused play cannot count as verified playback', !refused.api.status().verified);
  refused.close();
}

async function main() {
  await scenario('s1 switch on keeps position, volume and mute', s1_switchOnKeepsPositionAndState);
  await scenario('s2 the page resets the position after our seek', s2_pageResetsPositionAfterSeek);
  await scenario('s3 fast track change drops the stale answer', s3_staleAnswerAfterFastTrackChange);
  await scenario('s4 HTTP error leaves the page untouched', s4_httpErrorTouchesNothing);
  await scenario('s5 switch off hands the element back', s5_disableHandsTheElementBack);
  await scenario('s6 page takes its source back and gets one reapply', s6_pageReclaimsSourceAndGetsOneReapply);
  await scenario('s7 switching on while paused', s7_pausedSwitchKeepsPositionAndStaysPaused);
  await scenario('s8 autoplay refusal is not verified', s8_autoplayRefusalIsNotVerified);
  await scenario('s9 media error restores the page', s9_mediaErrorRestoresThePage);
  await scenario('s10 no video on the page', s10_noVideoPageTouchesNothing);
  await scenario('s11 format pick and redaction', s11_formatPickAndRedaction);
  await scenario('s12 background and content agree on the message names', s12_backgroundAndContentAgreeOnMessages);
  await scenario('s13 the visitorData repeat uses the server\'s own value', s13_visitorDataRepeatUsesTheServersOwnValue);
  await scenario('s14 the visitorData repeat is bounded', s14_visitorDataRepeatIsBounded);
  await scenario('s15 a bot check is not an age restriction', s15_botCheckIsNotAnAgeRestriction);
  await scenario('s15b an age gate keeps its own code', s15b_ageGateStaysItsOwnCode);
  await scenario('s15c mixed client results both stay in the report', s15c_mixedClientsBothStayInTheReport);
  await scenario('s16 no visitorData is ever invented', s16_noVisitorDataIsInvented);
  await scenario('s17 a track change outruns the watchdog re-apply', s17_trackChangeOutrunsTheWatchdogReapply);
  await scenario('s17b a plan of another track never reaches the element', s17b_applyRefusesPlanOfAnotherTrack);
  await scenario('s18 switching off after a track change hands back the running track',
    s18_handBackAfterATrackChangeUsesTheRunningTrack);
  await scenario('s19 an unreadable player clock uses the element position', s19_missingPlayerClockUsesTheElementPosition);
  await scenario('s19b without any readable position no startSeconds is sent',
    s19b_noPositionAtAllSendsNoStartSeconds);
  await scenario('s20 a refused cross-context call becomes a visible state', s20_refusedCrossContextCallIsVisible);
  await scenario('s21 switching off while the takeover still runs', s21_disableWhileTheApplyIsStillRunning);
  await scenario('s22 switching off while the page is paused', s22_handBackOfAPausedPageStaysPaused);
  await scenario('s23 a hand-back that cannot succeed is visible', s23_aFailedHandBackIsVisibleAndTouchesNothing);
  await scenario('s24 the clone target is reported and falls back once', s24_theCloneTargetIsReportedAndFallsBackOnce);
  await scenario('s25 parameterless page calls hand over no foreign list',
    s25_parameterlessCallsHandOverNoForeignList);

  await scenario('s26 current position, pause state and picture survive hand-back', s26_currentPositionAndPicture);
  await scenario('s27 zero seek and failure release the picture', s27_seekToZeroAndFailurePicture);

  await scenario('s28 duplicate hand-back and navigation cancellation', s28_handBackIsSingleAndNavigationCancelsIt);
  await scenario('s29 hand-back needs new metadata and follows replacement', s29_handBackNeedsNewSourceAndFollowsReplacement);
  await scenario('s30 seek and pause reset stall detection', s30_backwardSeekAndPauseAreNotStalls);
  await scenario('s31 retry works and hiding cancels repaint', s31_retryActuallyResolvesAndHideCancelsPaint);
  await scenario('s32 resolver and play promises have deadlines', s32_networkAndPlayHaveDeadlines);
  await scenario('s33 manual resume and per-track verification', s33_manualResumeIsVerifiedAndNewTrackResetsIt);
  await scenario('s34 track playback overlaps position checks', s34_trackStartsWhilePositionChecksContinue);
  await wait(400);                               // let late timers and rejections surface
}

// One place that prints the result: the normal end of the run and the crash path use the same one, so
// a runner that breaks half way through can never look like a run that passed.
function report() {
  // A scenario that failed before its own close() can leave an interval behind; that keeps the Node
  // process alive for ever even though every result is printed. Nothing is running any more at this
  // point, so the rest is closed explicitly - the exit code stays the deciding signal.
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
  process.exitCode = 1;                          // the summary may already be out - the code decides
});

main().then(report, (err) => {
  // A crash in the runner itself (not inside a scenario, which is caught above) must not look like a
  // run that passed: it becomes a failed check and the same report is printed.
  check('the runner itself did not crash', false, (err && err.stack) || String(err));
  report();
});
