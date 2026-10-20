/*!
 * Offline smoke harness for spike/mv3-audio-only/content.js.
 *
 * It builds a small fake DOM (one <video>, one #movie_player, a tiny element class for the panel), a
 * fake MutationObserver and a fake fetch, then loads the REAL content.js into a vm context. Nothing
 * here is a browser: it validates the state machine, the epoch/stale logic, the position re-assert
 * loop and the redaction - not the network behavior of YouTube or of a media element.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CONTENT_PATH = path.join(__dirname, '..', 'content.js');
const BACKGROUND_PATH = path.join(__dirname, '..', 'background.js');

// Every env that was created and not closed yet. A scenario that throws before its own env.close()
// would leave its interval behind, and a live interval keeps the whole Node process alive long after
// the results are printed - the runner closes the rest explicitly (closeAll) instead of hanging.
const OPEN = [];
function closeAll() {
  OPEN.slice().forEach((env) => { try { env.close(); } catch (e) { /* ignore */ } });
  return OPEN.length;
}

// --------------------------------------------------------------- tiny DOM
// A CSSStyleDeclaration, reduced to what this suite needs: named properties with a value and a
// priority, a cssText view of them, and a write log. The extension hides the picture through
// `visibility` only, so a test has to be able to ask (a) what the inline declaration says now,
// (b) which properties were ever written - that is the proof that nothing else (no `display`, no
// `all`) was touched - and (c) what the page's own inline value was before. A real declaration parses
// cssText; this one does the same for the simple `name:value[ !important]` pairs the panel writes, and
// mirrors `visibility` and `display` as named properties the way a real style object exposes them.
const STYLE_PROPS = ['visibility', 'display'];

function makeStyle() {
  const props = new Map();                 // lower-case property name -> { value, priority }
  const writes = [];                       // every write, in order: { name, value, priority, via }
  const key = (name) => String(name).trim().toLowerCase();
  const render = () => Array.from(props, ([k, v]) =>
    k + ':' + v.value + (v.priority ? ' !' + v.priority : '')).join(';');
  const record = (name, value, priority, via) => {
    writes.push({ name: key(name), value: String(value), priority: priority || '', via });
  };
  const style = { _writes: writes, _props: props };
  style.setProperty = (name, value, priority) => {
    record(name, value, priority, 'setProperty');
    const k = key(name);
    if (value === null || value === undefined || value === '') { props.delete(k); return; }
    props.set(k, { value: String(value), priority: priority ? String(priority) : '' });
  };
  style.removeProperty = (name) => {
    const k = key(name);
    const had = props.get(k);
    record(name, '', '', 'removeProperty');
    props.delete(k);
    return had ? had.value : '';
  };
  style.getPropertyValue = (name) => { const p = props.get(key(name)); return p ? p.value : ''; };
  style.getPropertyPriority = (name) => { const p = props.get(key(name)); return p ? p.priority : ''; };
  Object.defineProperty(style, 'cssText', {
    get: render,
    set(text) {
      record('cssText', text, '', 'cssText');
      props.clear();
      String(text).split(';').forEach((part) => {
        const at = part.indexOf(':');
        if (at < 0) return;
        let value = part.slice(at + 1).trim();
        let priority = '';
        const bang = value.indexOf('!');
        if (bang >= 0) { priority = value.slice(bang + 1).trim(); value = value.slice(0, bang).trim(); }
        const name = key(part.slice(0, at));
        if (name && value) props.set(name, { value, priority });
      });
    },
    enumerable: true, configurable: true,
  });
  STYLE_PROPS.forEach((name) => {
    Object.defineProperty(style, name, {
      get() { return style.getPropertyValue(name); },
      set(v) { style.setProperty(name, v === undefined || v === null ? '' : v, ''); },
      enumerable: true, configurable: true,
    });
  });
  return style;
}

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', textContent: '', children: [], style: makeStyle(), _listeners: {},
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    addEventListener(name, handler) { (this._listeners[name] = this._listeners[name] || []).push(handler); },
    removeEventListener(name, handler) {
      this._listeners[name] = (this._listeners[name] || []).filter((h) => h !== handler);
    },
    click() { (this._listeners.click || []).forEach((h) => h()); },
    remove() { this.removed = true; },
  };
  return node;
}

function notify(el) {
  el._observers.forEach((o) => o.cb([{ attributeName: 'src', target: el }], o));
}

function makeVideo(env) {
  const el = makeNode('video');
  el._attrs = {}; el._observers = []; el.seekWrites = [];
  el.readyState = 0; el._time = 0; el.paused = true; el.muted = false; el.volume = 1;
  el.error = null; el.seeking = false; el.networkState = 3; el.videoWidth = 0; el.videoHeight = 0;
  el.duration = NaN; el.loadCalls = 0; el.playCalls = 0; el.pauseCalls = 0;
  Object.defineProperty(el, 'currentTime', {
    get() { return el._time; },
    set(v) { el._time = Number(v); el.seekWrites.push(Number(v)); },
  });
  Object.defineProperty(el, 'src', {
    get() { return el._attrs.src === undefined ? '' : el._attrs.src; },
    set(v) { el._attrs.src = String(v); notify(el); },
  });
  Object.defineProperty(el, 'crossOrigin', {
    get() { return el._attrs.crossorigin === undefined ? null : el._attrs.crossorigin; },
  });
  el.getAttribute = (name) => (el._attrs[name] === undefined ? null : el._attrs[name]);
  el.setAttribute = (name, value) => { el._attrs[name] = String(value); if (name === 'src') notify(el); };
  el.fire = (name) => { (el._listeners[name] || []).forEach((h) => h()); };
  el.load = () => {
    el.loadCalls += 1;
    el.paused = true;
    el._time = 0;              // like the real element: a new resource starts at 0
    el.readyState = 0;
    el.duration = NaN;
    el.error = null;
    env.media.onLoad(el);
  };
  el.play = () => { el.playCalls += 1; return env.media.onPlay(el); };
  el.pause = () => { el.pauseCalls += 1; el.paused = true; };
  el.writesByPage = (url) => { el._attrs.src = url; notify(el); };
  return el;
}

// ------------------------------------------------------------------- env
const DEFAULTS = {
  videoId: 'VIDEO_A',
  pageTime: 0,
  pagePlaying: false,
  readyAfterMs: 5,
  fullReadyAfterMs: 25,
  resetToZeroAfterMs: 0,          // the page writes a position of its own once after load
  failLoad: false,
  playRejection: null,            // e.g. { name: 'NotAllowedError' }
  tickMs: 20,
  advancePerTick: 0.02,
  originalSrc: 'blob:https://www.youtube.com/11111111-2222-3333-4444-555555555555',
  // The page's own blob URL belongs to a MediaSource we detached with our src write: loading it again
  // never yields metadata (the live symptom). null = [originalSrc]; an array can add more dead URLs.
  deadBlobs: null,
  // Firefox exposes cloneInto in a content script; a build without it is modelled by removing the
  // global. The fake page then refuses the call exactly like the browser boundary does.
  noCloneInto: false,
  // Firefox exposes window.wrappedJSObject in a content script. Which form a real build accepts as a
  // clone scope cannot be checked here, so both variants are modelled: a build that has the unwrapped
  // window at all (unwrappedPageWindow) and one whose cloneInto only takes the plain window
  // (cloneIntoRejectsFirstScope) - the code has to fall back and say which form carried.
  unwrappedPageWindow: false,
  cloneIntoRejectsFirstScope: false,
  playerRequiresPageRealm: true,  // page code cannot read a foreign (content-script) argument object
  // ... and the page's own apply cannot read `length` off a foreign argument LIST - for the EMPTY list
  // too, which is why even a parameterless call (getCurrentTime/getVideoData) failed live. Node's apply
  // accepts it happily, so the page's apply is modelled explicitly here; false models a build that is
  // lenient about it (no such build is documented - it exists to show what the check would catch).
  playerRejectsForeignArgList: true,
  playerRefusal: null,            // force a refusal: { name, message }
                                  // ... optionally only for named methods: { ..., names: ['getVideoData'] }
                                  //     (a boundary does not have to refuse the whole player - a refusal
                                  //     that is polled must be one the page actually answers this way)
  playerClockRefusal: false,      // getCurrentTime throws (the player clock is not readable)
  deadPageSource: false,          // the source the player rebuilds never becomes usable either
  // Which content.js the scenario loads. null = this folder's prototype file, the default for every
  // scenario of the offline suite. A scenario that tests ANOTHER build (the release copy in extension/,
  // see ../../tools/smoke-release.js) names its path here - and then it must set expectApi: false,
  // because a release build strips the AUDIO_ONLY test surface.
  contentPath: null,
  expectApi: true,
};

function createEnv(overrides) {
  const env = Object.assign({}, DEFAULTS, overrides || {});
  env.fetches = [];
  env.playerCalls = [];
  env.timers = [];
  env.intervals = [];
  env.paused = env.pagePlaying !== true;
  if (!env.deadBlobs) env.deadBlobs = env.originalSrc ? [env.originalSrc] : [];
  env.media = {
    loadedUrls: [],
    deadLoads: [],
    onLoad(el) {
      const url = el.src;
      env.media.loadedUrls.push(url);
      // A URL whose MediaSource is gone (the page's own blob after our src write) never becomes
      // playable: the element waits for metadata that will not come. That is the hang the live test hit.
      if (env.deadBlobs.indexOf(url) >= 0) {
        env.media.deadLoads.push(url);
        return;
      }
      // The page can write a position of its own while we load - the re-assert loop has to win
      // against exactly that. The delay is measured from the load, like a real element's own seek.
      if (env.resetToZeroAfterMs > 0) {
        env.later(env.resetToZeroAfterMs, () => { if (el.src === url) el._time = 0; });
      }
      env.later(env.readyAfterMs, () => {
        if (env.failLoad) { env.failLoad = false; el.error = { code: 4 }; el.fire('error'); return; }
        if (el.src !== url) return;                    // superseded by a newer load
        el.readyState = 1;
        env.later(env.fullReadyAfterMs, () => {
          if (el.src !== url) return;
          el.readyState = 4;
          el.duration = 212;
          el.networkState = 1;
        });
      });
    },
    onPlay() {
      if (env.playRejection) {
        const err = new Error('refused');
        err.name = env.playRejection.name;
        return Promise.reject(err);
      }
      env.video.paused = false;
      return Promise.resolve();
    },
  };
  env.later = (ms, fn) => { const id = setTimeout(fn, ms); env.timers.push(id); return id; };
  env.video = makeVideo(env);
  env.video._attrs.src = env.originalSrc;            // the page had its own source, like the real page
  if (env.pageTime > 0) env.video._time = env.pageTime;
  env.video.readyState = 4;
  env.video.duration = 212;
  env.video.paused = env.paused;

  // ------------------------------------------------- the page's own window/player
  // cloneInto() hands an object from the content script's world into the page's. The stub marks what it
  // cloned, and the fake player refuses to READ anything that was not cloned - which is the rule the
  // live failure came from ("Permission denied to access property \"length\""). Node has no Xray
  // wrappers, so this models the consequence, not the mechanism; the real boundary must be checked in
  // Firefox (see README, "Checking it in the browser").
  env.pageRealmToken = { page: 'page world' };
  const cloneToPage = (value) => {
    if (value === null || typeof value !== 'object') return value;
    const copy = Array.isArray(value)
      ? value.map(cloneToPage)
      : Object.keys(value).reduce((o, k) => { o[k] = cloneToPage(value[k]); return o; }, {});
    Object.defineProperty(copy, '__pageRealm', { value: env.pageRealmToken, enumerable: false });
    return copy;
  };
  env.cloneIntoCount = 0;
  env.cloneIntoScope = null;
  env.cloneInto = (value, scope) => {
    env.cloneIntoCount += 1;
    env.cloneIntoScope = scope === env.sandbox ? 'content window (wrappedJSObject absent in the stub)'
      : (scope && scope.wrappedJSObject === scope ? 'page window' : 'other');
    // A build whose cloneInto will not take the unwrapped page window as a scope: the caller has to
    // offer the second documented form instead of giving up.
    if (env.cloneIntoRejectsFirstScope && scope === env.unwrappedWindow) {
      throw new TypeError('cloneInto: the unwrapped page window cannot be used as a scope here');
    }
    return cloneToPage(value);
  };
  env.inPageRealm = (v) => !!v && typeof v === 'object' && v.__pageRealm === env.pageRealmToken;

  // The page's own apply has to read `length` off the argument LIST, in the page's compartment - denied
  // for a list from the content script's world, and denied for the EMPTY list as well. Node's apply never
  // refuses anything, so the page's apply is attached to every page method here.
  const pageApply = (fn) => function (thisArg, argList) {
    if (env.playerRejectsForeignArgList !== false && argList !== undefined && argList !== null &&
        !env.inPageRealm(argList)) {
      throw new Error('Permission denied to access property "length"');
    }
    return Reflect.apply(fn, thisArg, argList === undefined || argList === null ? [] : argList);
  };

  env.playerBlobCount = 0;
  env.pageBlobFor = (videoId) =>
    'blob:https://www.youtube.com/page-fresh-' + (env.playerBlobCount += 1) +
    (videoId ? '-' + videoId : '');
  env.player = {
    getVideoData: () => ({ video_id: env.videoId, author: 'x', title: 'y' }),
    getCurrentTime: () => {
      if (env.playerClockRefusal) throw new Error('the player clock is not readable right now');
      return env.pageTime;
    },
    // Like the real player: it rebuilds its OWN playback for the video it is told about - a NEW
    // MediaSource with a NEW blob URL, loaded by the page, positioned at startSeconds. That is the
    // whole point of the hand-back (and the reason no blob URL is ever written by the extension).
    loadVideoById: (arg) => {
      env.playerCalls.push(arg);
      if (env.playerRequiresPageRealm !== false && !env.inPageRealm(arg)) {
        // Exactly the live failure: page code cannot read a property of a content-script object. A
        // plain Error, because that is how Firefox reports the Xray refusal.
        throw new Error('Permission denied to access property "length"');
      }
      if (env.playerRefusal) {
        const err = new Error(env.playerRefusal.message || 'refused');
        err.name = env.playerRefusal.name || 'Error';
        throw err;
      }
      const id = (arg && arg.videoId) || null;
      const url = env.pageBlobFor(id);
      if (env.deadPageSource) env.deadBlobs.push(url);  // its own new source stays unusable
      env.video.writesByPage(url);                    // the page owns the element again
      env.video.load();                               // the page loads its own source ...
      if (arg && Number.isFinite(arg.startSeconds)) env.video._time = arg.startSeconds; // ... at the position
      return undefined;
    },
  };
  // Every callable the page offers is wrapped: a refusal that names this method (DEFAULTS.playerRefusal)
  // has to hit every call style - `call` and a bare call as much as `apply`, because the argument list is
  // only one way a page call can be refused. And each one carries the page's own apply, which is the shape
  // the extension meets in the browser (`fn.apply(this, argList)`).
  Object.keys(env.player).forEach((name) => {
    const fn = env.player[name];
    const wrapped = function (...args) {
      if (env.playerRefusal && Array.isArray(env.playerRefusal.names) &&
          env.playerRefusal.names.indexOf(name) >= 0) {
        const err = new Error(env.playerRefusal.message || 'refused');
        err.name = env.playerRefusal.name || 'Error';
        throw err;
      }
      return Reflect.apply(fn, this, args);
    };
    Object.defineProperty(wrapped, 'apply', { value: pageApply(wrapped), configurable: true });
    env.player[name] = wrapped;
  });

  env.document = {
    readyState: 'complete',
    documentElement: { contains: (node) => !node.removed },
    body: { appendChild: (node) => { node.attached = true; return node; } },
    getElementById: (id) => (id === 'movie_player' ? env.player : null),
    querySelector: (sel) => (String(sel).indexOf('video') >= 0 ? env.video : null),
    createElement: (tag) => makeNode(tag),
    // The document's own listeners are kept, not swallowed: the page's SPA events (`yt-navigate-start`)
    // are one of the triggers the extension hangs its work on, so a scenario has to be able to fire them
    // - env.document.fire('yt-navigate-start') - instead of only being able to wait for the poll.
    _listeners: {},
    addEventListener(name, handler) {
      const key = String(name);
      env.document._listeners[key] = (env.document._listeners[key] || []).concat([handler]);
    },
    removeEventListener(name, handler) {
      const key = String(name);
      env.document._listeners[key] = (env.document._listeners[key] || [])
        .filter((h) => h !== handler);
    },
    fire(name) {
      const key = String(name);
      (env.document._listeners[key] || []).slice().forEach((h) => h({ type: key }));
      return (env.document._listeners[key] || []).length;
    },
  };

  env.tick = setInterval(() => {
    const el = env.video;
    if (!el.paused && el.readyState >= 1 && !el.error) el._time += env.advancePerTick;
  }, env.tickMs);

  env.fetchResponse = (url, options) => {
    let videoId = null;
    // The request's client context is recorded so a test can check what the resolver really sent
    // (e.g. whether a visitorData was carried) - the harness is test code, not product output.
    let clientContext = null;
    try {
      const body = JSON.parse(options.body);
      videoId = body.videoId;
      clientContext = (body.context && body.context.client) ? body.context.client : null;
    } catch (e) { /* keep null */ }
    const call = {
      url, method: options.method, credentials: options.credentials, mode: options.mode,
      signal: options.signal || null, videoId, clientContext,
      clientName: options.headers['X-YouTube-Client-Name'],
      clientVersion: options.headers['X-YouTube-Client-Version'],
      at: Date.now(),
    };
    env.fetches.push(call);
    const handler = env.responder
      ? env.responder(call, env)
      : { json: { streamingData: { adaptiveFormats: [] } }, status: 200 };
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
      const abortError = () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        return err;
      };
      if ((options.signal && options.signal.aborted) === true) {
        finish(reject, abortError());
        return;
      }
      if (options.signal && typeof options.signal.addEventListener === 'function') {
        options.signal.addEventListener('abort', () => finish(reject, abortError()));
      }
      env.later(handler.delayMs || 1, () => {
        if (handler.networkError) {
          const err = new Error('network down');
          err.name = handler.networkError;
          finish(reject, err);
          return;
        }
        const status = handler.status === undefined ? 200 : handler.status;
        finish(resolve, {
          status,
          ok: status >= 200 && status < 300,
          json: async () => (handler.json === undefined ? {} : handler.json),
        });
      });
    });
  };

  env.sandbox = {
    window: null,
    document: env.document,
    location: {
      href: env.videoId ? 'https://www.youtube.com/watch?v=' + env.videoId : 'https://www.youtube.com/',
      host: 'www.youtube.com', pathname: '/watch',
    },
    console: { debug() {}, log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms) => env.later(ms || 0, fn),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => { const id = setInterval(fn, ms); env.intervals.push(id); return id; },
    clearInterval: (id) => clearInterval(id),
    URL, AbortController,
    navigator: {},
    MutationObserver: class {
      constructor(cb) { this.cb = cb; this.target = null; }
      observe(target) { this.target = target; target._observers.push(this); }
      disconnect() { if (this.target) this.target._observers = this.target._observers.filter((o) => o !== this); }
    },
  };
  env.sandbox.window = env.sandbox;
  // The unwrapped page window, when the modelled build has one: the same window (the player API is
  // reachable through the prototype chain), but a scope object of its own - exactly the two forms the
  // clone scope can take.
  if (env.unwrappedPageWindow || env.cloneIntoRejectsFirstScope) {
    const unwrapped = Object.create(env.sandbox);
    Object.defineProperty(unwrapped, 'wrappedJSObject', { value: unwrapped, enumerable: false });
    env.sandbox.wrappedJSObject = unwrapped;
    env.unwrappedWindow = unwrapped;
  }
  env.sandbox.fetch = (url, options) => env.fetchResponse(url, options);
  // Firefox's content scripts have cloneInto; removing it models a build that does not (s20).
  if (!env.noCloneInto) env.sandbox.cloneInto = env.cloneInto;
  // Extension APIs (chrome.*) are injected by the test, so the message wiring can be exercised.
  if (env.sandboxExtra) Object.assign(env.sandbox, env.sandboxExtra);

  env.close = () => {
    clearInterval(env.tick);
    env.timers.forEach((id) => clearTimeout(id));
    env.intervals.forEach((id) => clearInterval(id));
    const at = OPEN.indexOf(env);
    if (at >= 0) OPEN.splice(at, 1);
  };
  OPEN.push(env);

  vm.createContext(env.sandbox);
  const sourcePath = env.contentPath || CONTENT_PATH;
  const source = fs.readFileSync(sourcePath, 'utf8');
  vm.runInContext(source, env.sandbox, { filename: path.basename(sourcePath) });
  env.api = env.sandbox.AUDIO_ONLY;
  // The prototype exports AUDIO_ONLY; a release build does not (the test surface is stripped). A
  // scenario that loads such a build drives it through chrome.runtime messages and says expectApi:false.
  if (!env.api && env.expectApi !== false) throw new Error('content.js did not export AUDIO_ONLY');
  return env;
}

// --------------------------------------------------------------- fixtures
function audioOnlyAnswer(videoId) {
  return {
    playabilityStatus: { status: 'OK' },
    streamingData: {
      expiresInSeconds: 21600,
      adaptiveFormats: [
        { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"',
          url: 'https://rr1---sn-x.googlevideo.com/videoplayback?v=' + videoId + '&sig=VIDEO', bitrate: 4000000 },
        { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"',
          url: 'https://rr1---sn-x.googlevideo.com/videoplayback?v=' + videoId + '&itag=140&sig=SIG140',
          bitrate: 129000, contentLength: 3400000 },
        { itag: 251, mimeType: 'audio/webm; codecs="opus"',
          url: 'https://rr1---sn-x.googlevideo.com/videoplayback?v=' + videoId + '&itag=251&sig=SIG251',
          bitrate: 160000, contentLength: 4200000 },
      ],
    },
    videoDetails: { videoId },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// An HTTP 200 answer with no streaming data. `visitorData` models what the real server does: it can
// hand out a visitorData in responseContext even when it sends no usable format - exactly the shape
// the resolver repeats once.
function noStreamsAnswer(opts) {
  const o = opts || {};
  const json = { playabilityStatus: { status: o.status || 'OK' }, videoDetails: { videoId: o.videoId || null } };
  if (o.reason) json.playabilityStatus.reason = o.reason;
  if (o.visitorData) json.responseContext = { visitorData: o.visitorData };
  if (o.withEmptyStreamingData) json.streamingData = { adaptiveFormats: [] };
  return json;
}

// The real wording YouTube uses when it suspects a robot. This is a BOT CHECK - it says nothing about
// an age gate or a content restriction, and the classification must not pretend otherwise.
const BOT_CHECK_REASON = "Sign in to confirm you're not a bot. This helps protect our community.";
function botCheckAnswer(reason) {
  return { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: reason || BOT_CHECK_REASON } };
}

// A genuine age gate carries its own status and no bot wording.
function ageGateAnswer() {
  return { playabilityStatus: { status: 'AGE_CHECK_REQUIRED',
    reason: 'This video may be inappropriate for some users. Sign in to confirm your age.' } };
}

async function waitUntil(fn, timeoutMs, stepMs) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - started >= timeoutMs) return null;
    await wait(stepMs || 20);
  }
}

function tightTimings(api, overrides) {
  Object.assign(api._timings, {
    settleAfterNavMs: 60,
    metadataTimeoutMs: 600,
    verifyMs: 300,
    seekReassertMs: 60,
    seekReassertAttempts: 8,
    watchdogMs: 40,
    stalledWarnSeconds: 1,
    restoreSettleMs: 250,
    restoreProgressMs: 400,
    navPollMs: 40,
  }, overrides || {});
  return api._timings;
}

module.exports = {
  CONTENT_PATH, BACKGROUND_PATH, makeNode, makeVideo, DEFAULTS, createEnv, closeAll,
  audioOnlyAnswer, noStreamsAnswer, botCheckAnswer, ageGateAnswer, BOT_CHECK_REASON,
  wait, waitUntil, tightTimings,
};
