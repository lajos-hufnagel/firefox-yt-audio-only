/*!
 * Audio-only for YouTube - content script.
 *
 * What it does: resolves an audio-only adaptive format for the current watch page through a
 * non-web InnerTube client, points the page's OWN <video> element at that URL, and keeps the page
 * usable (position / pause / volume / mute preserved, automatic re-resolution on track change).
 *
 * Proven by the recorded live run: 35 s of stable audio-only playback through the page element
 * (videoWidth 0, totalVideoFrames 0, drift 0, no source re-take). NOT proven and never claimed
 * here: a byte-level "no video bytes" accounting and any resource saving - neither was
 * measured.
 *
 * Provenance note on that live run: the run went through a console snippet whose resolver repeats
 * the request once with the visitorData that the server's own answer carried (visitorDataSent:
 * true). The run therefore did NOT prove a path without visitorData. This file does the same
 * bounded repetition as the snippet.
 *
 * Hard rules enforced by this file:
 *   - no cookie access: no browser.cookies permission, no document.cookie read, no token read.
 *     Every fetch() passes credentials: 'omit' (this is the InnerTube POST; it is the only network
 *     request in the file - no telemetry, no analytics, no other endpoint).
 *   - visitorData is the ONE identifier this file may carry, and only under these rules: never
 *     invented, never read from a cookie or an account, taken solely from YouTube's own answer to
 *     that POST (responseContext.visitorData), kept in this closure, used to repeat the SAME request
 *     exactly once when that answer carried no audio URL, and never logged, exported or displayed.
 *     Same shape as the console snippet the recorded live run used.
 *   - the media ELEMENT is not a fetch(): its own crossorigin setting decides what the browser
 *     sends. That setting is RECORDED (mediaMode) and never changed, never assumed to be omit.
 *   - the mode is only "verified" when the playhead really advanced. An accepted play() without
 *     progress, a pause, an element error and an autoplay refusal are separate states.
 *   - only NotAllowedError counts as an autoplay block.
 *   - a src write done by this file is never counted as the page taking the source back.
 *   - an answer that belongs to an older track generation (epoch) is dropped, never applied.
 *   - the cached audio URL is bound to the videoId it was actually resolved for and is never applied
 *     to another track. A track change locks the old cache for re-apply and switches off its watchdog
 *     and its src observer in the very same tick, so a late re-apply of the old track can neither
 *     devalue the resolution that is running for the new track nor attach the old URL to the new id.
 *   - on any failure the page keeps working: resolve errors never touch the element, and after a
 *     failed switch there is an explicit way back to the page's own source.
 *   - the page's OWN source is never written back by this file. Its URL is only ever RECORDED
 *     (originalSrc): the page is asked through loadVideoById to build a fresh normal playback for the
 *     current videoId, because a stale MSE blob URL of a MediaSource we detached never reaches
 *     readyState 1 - it only hangs the element (that was the live symptom).
 *   - a call into page code carries page-realm arguments (cloneInto) instead of content-script objects,
 *     and a refusal by the browser's context boundary is its own, visible state (restore-failed) -
 *     never a silent failure.
 *
 * Provenance: the request shape and the client values are protocol facts taken from the console
 * probe used during development (protocol facts only, no copied third-party code).
 *
 * Language note: this project is English-only - code, comments, the panel, the badge and every
 * message the user reads are English.
 */
(() => {
  'use strict';

  // Double injection would mean two scripts fight over the same element.
  if (typeof window !== 'undefined' && window.__audioOnlyLoaded === true) {
    console.debug('[audio-only] already loaded - second injection ignored');
    return;
  }

  const VERSION = '0.1.3';
  const ENDPOINT = '/youtubei/v1/player?prettyPrint=false';
  const MAX_LOG = 200;

  // VISIONOS first: it is the client whose audio URL the recorded live run played (that run;
  // that run reached the URL WITH a visitorData repetition - see the resolver note below). The other
  // two stay as fallbacks for the day VISIONOS drifts - nothing else in the pipeline is
  // client-specific.
  const CLIENT_ORDER = ['visionos', 'android_vr', 'ios'];
  const CLIENTS = {
    visionos: {
      id: 101,
      client: {
        clientName: 'VISIONOS', clientVersion: '1.02',
        deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
        osName: 'visionOS', osVersion: '26.5.23O471',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      },
    },
    android_vr: {
      id: 28,
      client: {
        clientName: 'ANDROID_VR', clientVersion: '1.65.10',
        deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32,
        osName: 'Android', osVersion: '12L',
        userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      },
    },
    ios: {
      id: 5,
      client: {
        clientName: 'IOS', clientVersion: '21.26.4',
        deviceMake: 'Apple', deviceModel: 'iPhone16,2',
        osName: 'iPhone', osVersion: '18.3.2.22D82',
        userAgent: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
      },
    },
  };

  // Production timings. The offline suite of the development tree overrides them through its own
  // hook, so that a whole state machine run does not have to take half a minute.
  const TIMINGS = {
    settleAfterNavMs: 1200,          // let the SPA finish its own track change before we switch
    resolveTimeoutMs: 30000,        // bound the whole resolver sweep, including response bodies
    playStartTimeoutMs: 8000,       // a pending play() must not hold an action forever
    metadataTimeoutMs: 8000,         // the element must deliver metadata for the new URL
    verifyMs: 2500,                  // observation window for "did the playhead really move"
    minAdvanceSeconds: 0.15,
    seekReassertMs: 600,
    seekReassertAttempts: 8,         // budget for the position re-assert loop (the known bug fix)
    seekToleranceSeconds: 1.0,
    minRestoreSeconds: 0.5,          // below this the page is simply at the start - nothing to restore
    watchdogMs: 1000,
    stalledWarnSeconds: 6,
    restoreSettleMs: 2500,           // the page must deliver metadata for the source it rebuilds
    restoreProgressMs: 3000,         // and, when playback was wanted, the playhead must really run again
    maxAutoReapplyPerTrack: 2,       // the page may take its source back; retry twice, then ask
    maxResolveHideMs: 30000,         // a resolve that never ends must not hold the picture hidden forever
    navPollMs: 1000,
    maxLogEntries: MAX_LOG,
  };

  // --------------------------------------------------------------- redaction
  // Signed URLs, cookies, tokens and visitor ids never leave this closure, not even in a log line.
  const urlFacts = (value) => {
    try {
      const u = new URL(String(value), location.origin);
      const names = [...u.searchParams.keys()];
      return { host: u.host, path: u.pathname, paramCount: names.length, paramNames: names };
    } catch (e) {
      return { host: '<unparseable>', error: (e && e.name) || 'Error' };
    }
  };

  const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
  const redactText = (value, max = 300) =>
    String(value === undefined || value === null ? '' : value)
      .replace(URL_RE, (m) => '<url:' + urlFacts(m).host + '>')
      .slice(0, max);

  const kindOf = (src) => !src ? 'none'
    : String(src).startsWith('blob:') ? 'blob'
    : String(src).startsWith('data:') ? 'data'
    : 'http:' + urlFacts(src).host;

  const num = (v) => (Number.isFinite(v) ? Number(Number(v).toFixed(3)) : null);
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // A refused play() is not automatically an autoplay block: only NotAllowedError means "policy
  // refused". Anything else is its own failure and never promoted to "almost playing".
  const AUTOPLAY_BLOCK = 'NotAllowedError';
  const playFailure = (e) => {
    const name = (e && e.name) || 'Error';
    return {
      name,
      autoplayBlocked: name === AUTOPLAY_BLOCK,
      classification: name === AUTOPLAY_BLOCK ? 'autoplay-policy'
        : name === 'NotSupportedError' ? 'media-not-supported'
        : name === 'AbortError' ? 'aborted-before-playback'
        : 'play-rejected:' + name,
    };
  };

  // -------------------------------------------------- private state (closure)
  // Never exported: the resolved (signed) URL's full text stays in `state.audio.url`, and every
  // status object handed out or sent to the background goes through redact().status().
  const state = {
    version: VERSION,
    mode: 'off',                 // off | resolving | active | restoring | error | restore-failed
    verified: false,             // true only after observed progress
    verifyMethod: null,
    epoch: 0,                    // track generation: bumped on every video change and every toggle
    videoId: null,
    visitorData: null,           // only ever from YouTube's own responseContext; memory only, never exported
    audio: null,                 // { url, client, itag, mime, host, videoId, locked, originalSrc, ... }
                                 // `videoId` is the binding: the URL is only ever applied to it
    before: null,                // pre-write page snapshot for failure recovery; normal hand-back
                                 // reads CURRENT state of the owned audio element
    restoreTask: null,           // one hand-back at a time; duplicate disable actions share it
    lastRestore: null,           // last hand-back result (redacted) - what the panel row "Hand-back" shows
    pageApi: {                   // how the calls into page code really went (see pageCall)
      calls: [],                 // bounded tail: { name, at, argsBridge, ok, error }
      counts: { cloneInto: 0, direct: 0, 'no-args': 0, 'own-realm-apply': 0, refused: 0 },
    },
    playback: null,              // last playback observation (redacted shape)
    position: null,              // { target, observed, asserts, restored, late, skipped, reason }
    applied: null,               // what was actually re-applied (paused / muted / volume)
    lastError: null,             // { code, message, hint, at, videoId }
    counters: {
      resolves: 0, staleDropped: 0, trackChanges: 0, applies: 0, reResolves: 0,
      pageReclaims: 0, autoReapplies: 0, failures: 0, retries: 0, visitorDataRepeats: 0,
      watchdogSkips: 0,          // ticks that saw a resolution/locked cache and did NOT re-apply
      restoreFailures: 0,        // hand-backs that did not reach the user's playing page again
      pictureHides: 0,           // times the element's picture was hidden for this mode
      pictureShows: 0,           // times it was given back to the page
      pictureRestores: 0,        // of those, how often the previous inline value really came back
    },
    log: [],
    logRepeats: new Map(),       // repeatable entries already in the log: signature -> entry
    logRepeatCount: 0,           // how many copies were counted instead of written (see log)
    panel: null,                 // { host, root, timer }
    nav: { started: false, timer: null, poll: null, lastVideoId: null, lastNavAt: null,
           offNavFinish: null, offNavStart: null },
    watch: null,                 // watchdog interval id
    picture: null,               // { el, reason, hiddenAt, epoch, previous } while the picture is hidden
    picturePhase: { mode: null, since: 0 },   // since when the mode has been in its current value
    pictureRelease: null,        // set when a hide was released again because a resolve did not finish
    progress: { at: null, seconds: null, stalledSince: null, warned: false },
    warning: null,               // soft, non-fatal observation (stall, repeated page re-take)
    abort: null,                 // AbortController of the running resolve
    tickBusy: false,             // watchdog re-entrancy guard
    startedAt: Date.now(),
  };

  // A boundary that refuses a call refuses it again on the next poll (the watchdog asks for the video id
  // once a second). Writing every copy would fill the log buffer and the console with the same line and
  // push the actual switching events out - so an entry marked `repeatable` is COUNTED on the entry that
  // is already in the log instead of being written again, and only the first occurrence is a new entry.
  const LOG_REPEAT_KEYS = 32;      // how many distinct repeatable entries are watched at once
  function repeatKey(data) {
    try { return JSON.stringify(data === undefined ? null : data) || 'undefined'; }
    catch (e) { return String(data); }             // a cycle must not break logging
  }

  const log = (event, data, options) => {
    const entry = { t: new Date().toISOString(), event, data };
    if (options && options.repeatable) {
      const sig = event + ' ' + repeatKey(data);
      const seen = state.logRepeats.get(sig);
      if (seen && state.log.indexOf(seen) >= 0) {
        seen.repeats = (seen.repeats || 1) + 1;    // same reason, same place: one entry, one counter
        seen.lastT = entry.t;
        state.logRepeatCount += 1;
        // Repeats are counted in the bounded report; do not flood DevTools every second.
        return seen;
      }
      if (state.logRepeats.size >= LOG_REPEAT_KEYS) {
        const oldest = state.logRepeats.keys().next();
        if (!oldest.done) state.logRepeats.delete(oldest.value);
      }
      state.logRepeats.set(sig, entry);
    }
    state.log.push(entry);
    while (state.log.length > TIMINGS.maxLogEntries) state.log.shift();
    console.debug('[audio-only]', event, data);
    return entry;
  };

  // What a media ELEMENT does about credentials is decided by the element, not by any fetch()
  // option in this file. Recorded, never changed, never measured.
  const CROSSORIGIN_MEANS = {
    'no-cors': 'documented element behavior: without a crossorigin attribute the media request runs ' +
      'in no-cors mode with credentials mode include - cookies for that host would be attached if ' +
      'any exist. No CORS read access. Recorded, not changed, not measured here.',
    'cors': 'documented element behavior: with crossorigin="anonymous" the media request is CORS ' +
      'with credentials mode same-origin (no cookies cross-origin). Recorded, not changed.',
    'cors-credentials': 'documented element behavior: with crossorigin="use-credentials" the media ' +
      'request is CORS with credentials mode include. Recorded, not changed.',
  };

  function mediaMode(el) {
    if (!el || !el.getAttribute) return null;
    const attr = el.getAttribute('crossorigin');
    const prop = el.crossOrigin === undefined ? null : el.crossOrigin;
    const hasAttr = attr !== null;
    const useCreds = hasAttr && attr === 'use-credentials';
    const key = !hasAttr ? 'no-cors' : useCreds ? 'cors-credentials' : 'cors';
    return {
      tagName: el.tagName || null,
      hasCrossOriginAttribute: hasAttr,
      crossOriginAttribute: !hasAttr ? null : (attr === '' ? '"" (= anonymous)' : attr),
      crossOriginProperty: prop,
      requestMode: key === 'no-cors' ? 'no-cors' : 'cors',
      credentialsMode: key === 'no-cors' ? 'include' : useCreds ? 'include' : 'same-origin',
      meaning: CROSSORIGIN_MEANS[key],
      fetchOptionsDoNotApply: 'credentials: "omit" in this file applies to fetch() calls only, not to this element.',
    };
  }

  // ------------------------------------------------------------- DOM access
  function player() { return document.getElementById('movie_player'); }
  function videoEl() { return document.querySelector('#movie_player video, video.video-stream, video'); }

  function currentVideoId() {
    const viaPage = pageCall('getVideoData');
    if (viaPage.ok && viaPage.value && viaPage.value.video_id) return String(viaPage.value.video_id);
    try { return new URL(location.href).searchParams.get('v'); } catch (e) { return null; }
  }

  // -------------------------------------- crossing into the page context (a call, not a read)
  // Reading a page object works, calling into page code does not come for free. The live failure was
  // "Permission denied to access property \"length\"": the page's own Function.prototype.apply reads
  // `length` off the argument LIST in the page's compartment, and a list that is still a content-script
  // array is denied there - with an EMPTY list too, so even a parameterless call (getCurrentTime,
  // getVideoData) fails that way. page code cannot read a foreign argument object either.
  // wrappedJSObject only unwraps the object we call ON - the arguments stay foreign. The list and every
  // value are therefore rebuilt as plain data and handed over with cloneInto(), the documented way for a
  // Firefox content script to pass an object to page code (Window.cloneInto, in content scripts since
  // Firefox 49); the scope is the page's own window. A build without cloneInto gets one honest second
  // attempt with this realm's own apply - and a parameterless call is made without any list at all,
  // which needs nothing from this realm. Anything the boundary refuses is reported as its own result
  // instead of a silent failure.
  const ARGS_BRIDGE = {
    cloneInto: 'cloneInto (every value and the argument list are page-realm clones)',
    direct: 'direct (no cloneInto in this context: plain values, the browser decides)',
    'own-realm-apply': 'own-realm apply (cloneInto missing/unusable: this realm applied the call)',
    'no-args': 'no-args (a parameterless call: no argument list crosses the boundary at all)',
  };

  // No content-script object and no function may survive into the page realm: only plain data.
  function plainValue(v) {
    if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v !== 'object') return null;                     // undefined and functions are dropped
    if (Array.isArray(v)) return v.map(plainValue);
    const out = {};
    Object.keys(v).forEach((k) => { out[k] = plainValue(v[k]); });
    return out;
  }

  // The page's own window is the documented clone target for a content script. Which of the two forms
  // a Firefox build accepts cannot be decided from here, so both are offered in this order - and the
  // report names the one that carried (`cloneTarget` in `status().pageApi` and in `lastError`).
  function pageScopes() {
    const list = [];
    let unwrapped = null;
    try { unwrapped = (window && window.wrappedJSObject) ? window.wrappedJSObject : null; } catch (e) { unwrapped = null; }
    if (unwrapped) list.push({ scope: unwrapped, label: 'window.wrappedJSObject' });
    try { if (window) list.push({ scope: window, label: 'window' }); } catch (e) { /* ignore */ }
    return list;
  }

  // The argument LIST is an object of this realm as well - the page's apply has to read `length` off it,
  // so it is cloned like every single argument (the empty list included: a parameterless call with an
  // empty foreign array was refused live). Only when no clone is possible does the call go out WITHOUT a
  // list at all - a parameterless call needs none, and then nothing of ours crosses the boundary.
  function cloneArgsToPage(plain) {
    let lastError = null;
    if (typeof cloneInto === 'function') {
      for (const entry of pageScopes()) {
        try {
          return { args: cloneInto(plain, entry.scope), bridge: 'cloneInto', cloneTarget: entry.label };
        } catch (e) { lastError = e; }
      }
    }
    const cloneError = lastError ? ((lastError && lastError.name) || 'Error') : 'cloneInto-missing';
    const cloneMessage = lastError ? redactText(lastError.message, 120) : null;
    if (!plain.length) {
      // Nothing to hand over: call it without an argument list, so no array of this realm reaches the
      // page's apply. The report names this path (`no-args`) instead of pretending a clone happened.
      return { args: plain, bridge: 'no-args', noArgList: true, cloneError, cloneMessage };
    }
    return { args: plain, bridge: 'direct', cloneError, cloneMessage };
  }

  // The browser's context boundary has its own errors; mixing them up with "no method" or with a
  // generic failure would hide the real reason from the user. Matched on the message as well, because
  // Firefox reports the Xray refusal as a plain Error whose NAME is not distinctive.
  const CROSS_CONTEXT_PATTERN = /SecurityError|Permission denied|denied to access|not permitted|cross-compartment|Xray|denied for insecure|unsafe call/i;
  function crossContextRefusal(e) {
    const name = (e && e.name) || 'Error';
    const message = String((e && e.message) || '');
    if (!CROSS_CONTEXT_PATTERN.test(name + ': ' + message)) return null;
    return { name, message: redactText(message, 140) || 'refused' };
  }

  // Page API access stays defensive on purpose: through an Xray wrapper a call can fail, and a
  // failed read must never take the mode down. The result carries the facts of the attempt
  // (argsBridge, error), so a live run can prove which path the browser really accepted.
  function pageCall(name, args) {
    const p = player();
    if (!p) return { ok: false, error: 'no-player' };
    let target = p;
    try {
      if (p.wrappedJSObject && typeof p.wrappedJSObject[name] === 'function') target = p.wrappedJSObject;
    } catch (e) { target = p; }
    if (!target || typeof target[name] !== 'function') return { ok: false, error: 'no-method' };
    const plain = (Array.isArray(args) ? args : []).map(plainValue);
    const bridged = cloneArgsToPage(plain);
    // Both `direct` and `no-args` hand this realm's objects over; the retry below keeps the list in this
    // realm on purpose (that is the difference the boundary accepts). `cloneInto` lists are page-realm
    // clones, so retrying with our own apply would only make that worse.
    const ownRealm = bridged.bridge === 'direct' || bridged.noArgList === true;
    const record = (out) => {
      const facts = Object.assign({ argsBridge: bridged.bridge, argsCount: plain.length,
        cloneTarget: bridged.cloneTarget || null, cloneError: bridged.cloneError || null }, out);
      state.pageApi.calls.push(Object.assign({ name, at: Date.now() }, facts));
      while (state.pageApi.calls.length > 12) state.pageApi.calls.shift();
      const key = facts.argsBridge;
      state.pageApi.counts[key] = (state.pageApi.counts[key] || 0) + 1;
      if (facts.error === 'cross-context-refused') state.pageApi.counts.refused += 1;
      return facts;
    };
    try {
      // A parameterless call is made WITHOUT an argument list: the page's own apply would have to read
      // `length` off the empty array of this realm, and that read is denied at the boundary too.
      const value = bridged.noArgList ? target[name].call(target) : target[name].apply(target, bridged.args);
      return record({ ok: true, value });
    } catch (e) {
      let err = e;
      if (crossContextRefusal(err) && ownRealm) {
        // One retry that keeps the argument list in THIS realm: a content script may read its own array,
        // so `length` is readable this way. It can only work for primitive arguments - an object argument
        // would still be unreadable for the page - and the outcome is reported either way.
        try {
          const value = Function.prototype.apply.call(target[name], target, bridged.args);
          return record({ ok: true, value, argsBridge: 'own-realm-apply', retried: true });
        } catch (e2) { err = e2; }
      }
      const refusal = crossContextRefusal(err);
      if (refusal) {
        // A repeatedly refused boundary is counted, not written again (see log): a page call that is
        // polled every tick would otherwise push the actual switching events out of the log.
        log('page-call:refused', { name, argsBridge: bridged.bridge, name2: refusal.name,
                                   message: refusal.message, retried: ownRealm },
            { repeatable: true });
        return record({ ok: false, error: 'cross-context-refused', refusedBy: refusal.name,
                        message: refusal.message, retried: ownRealm,
                        argsBridge: bridged.bridge });
      }
      return record({ ok: false, error: (err && err.name) || 'Error',
                      message: redactText(err && err.message, 120) });
    }
  }

  function pageClockSeconds(expectedVideoId) {
    const r = pageCall('getCurrentTime');
    if (!r.ok || !Number.isFinite(r.value)) return null;
    // Only trust the page clock when the player is already on the video we are about to switch to;
    // during an SPA swap it can still report the previous track.
    if (expectedVideoId) {
      const d = pageCall('getVideoData');
      const id = d.ok && d.value ? d.value.video_id : null;
      if (id && String(id) !== String(expectedVideoId)) return null;
    }
    return num(r.value);
  }

  function elementState(el) {
    return {
      videoId: currentVideoId(),
      time: el ? num(el.currentTime) : null,
      pageTime: pageClockSeconds(null),
      paused: el ? !!el.paused : null,
      muted: el ? !!el.muted : null,
      volume: el ? num(el.volume) : null,
      readyState: el ? el.readyState : null,
      srcKind: el ? kindOf(el.getAttribute('src')) : null,
      mediaMode: el ? mediaMode(el) : null,
    };
  }

  // Poll-based wait: works with real events and stays usable in the offline harness, where the
  // fake element only flips its own fields.
  async function waitFor(check, timeoutMs, stepMs) {
    const started = Date.now();
    for (;;) {
      const r = check();
      if (r) return r;
      if (Date.now() - started >= timeoutMs) return null;
      await delay(stepMs || 120);
    }
  }

  // ------------------------------------------------------------ resolution
  // The ONLY network request in this file. credentials: 'omit' is set explicitly and it is the
  // fetch()-level setting; what the media ELEMENT does on its own is recorded by mediaMode().
  // visitorData (optional) is never invented and never read from anywhere: the only value that can
  // ever end up here is one a previous answer of this same endpoint returned. poToken is NOT sent.
  async function postPlayer(clientKey, videoId, signal, visitorData) {
    const def = CLIENTS[clientKey];
    const client = Object.assign({}, def.client);
    if (visitorData) client.visitorData = visitorData;      // value stays local, never logged
    const body = {
      context: { client },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
    };
    const started = Date.now();
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'omit',
        mode: 'same-origin',
        signal: signal || undefined,     // aborts an in-flight resolve as soon as the track changes
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': String(def.id),
          'X-YouTube-Client-Version': def.client.clientVersion,
        },
        body: JSON.stringify(body),
      });
      const elapsedMs = Date.now() - started;
      let json = null, parseError = null;
      try { json = await res.json(); } catch (e) { parseError = (e && e.name) || 'parse-error'; }
      // Only booleans are recorded about visitorData; the value itself never leaves `client`.
      return {
        clientKey, videoId, http: { status: res.status, ok: res.ok }, json, parseError, elapsedMs,
        visitorDataSent: !!visitorData,
        visitorDataReturned: !!(json && json.responseContext && json.responseContext.visitorData),
      };
    } catch (e) {
      return { clientKey, videoId, http: null, json: null, elapsedMs: Date.now() - started,
               visitorDataSent: !!visitorData, visitorDataReturned: false,
               requestError: { name: (e && e.name) || 'Error', message: redactText(e && e.message, 160) } };
    }
  }

  function audioCandidates(json) {
    const sd = json && json.streamingData;
    if (!sd || !Array.isArray(sd.adaptiveFormats)) return [];
    return sd.adaptiveFormats
      .filter((f) => f && typeof f.mimeType === 'string' && f.mimeType.startsWith('audio/') &&
                     typeof f.url === 'string' && f.url.length > 0)
      .map((f) => ({
        url: f.url,
        itag: f.itag === undefined ? null : f.itag,
        mime: f.mimeType.split(';')[0],
        bitrate: f.bitrate || 0,
        contentLength: f.contentLength === undefined ? null : Number(f.contentLength),
      }));
  }

  // Highest bitrate first, then largest file - never a silent downgrade to worse audio quality.
  function pickAudio(json) {
    const list = audioCandidates(json);
    if (!list.length) return null;
    return list.slice().sort((a, b) =>
      ((b.bitrate || 0) * 1e9 + (b.contentLength || 0)) - ((a.bitrate || 0) * 1e9 + (a.contentLength || 0)))[0];
  }

  // Reason-based classification. The status code alone is not enough: YouTube answers a suspicion of
  // automation with LOGIN_REQUIRED plus a reason like "Sign in to confirm you're not a bot." - that is
  // a BOT CHECK and must not be reported as a proven age or content restriction. A real age gate is a
  // separate status (AGE_CHECK_REQUIRED). Both can show up in the same sweep, so the per-client
  // outcomes are kept exactly as they came (clientOutcomes, mixed) instead of being collapsed.
  const BOT_CHECK_RE = /not a bot|unusual traffic|confirm you'?re not/i;
  const AGE_HINT_RE = /age[- ]?restrict|older than|age verification|age gate|confirm your age|inappropriate for some users|birth ?date/i;
  // Bounded repetition, like the console snippet: ONE repeat per resolve - never a loop, never a timer.
  const MAX_VISITOR_DATA_REPEATS = 1;

  function classifyResolveFailure(attempts) {
    const outcomes = attempts.map((a) => String(a.outcome || ''));
    const ps = outcomes.filter((s) => s.startsWith('playability:')).map((s) => s.slice(12));
    const reasons = attempts.map((a) => String(a.reason || '')).filter(Boolean);
    const botCheckSignal = reasons.some((r) => BOT_CHECK_RE.test(r));
    const ageSignal = ps.includes('AGE_CHECK_REQUIRED') || reasons.some((r) => AGE_HINT_RE.test(r));
    const base = {
      clientOutcomes: attempts.slice(),       // every client result stays in the report, mixed or not
      clientsTried: attempts.length,
      outcomeSummary: outcomes,
      mixed: new Set(outcomes).size > 1,
      botCheckSuspected: botCheckSignal,
    };
    if (attempts.some((a) => a.error === 'AbortError')) {
      return Object.assign(base, {
        code: 'aborted', message: 'The request was aborted (track change or mode switched off).',
        hint: 'A new resolution is already running for the current track.' });
    }
    if (outcomes.includes('network')) {
      return Object.assign(base, {
        code: 'network', message: 'The request to YouTube did not go through (network or blocked).',
        hint: 'Normal playback continues - nothing on the page was changed.' });
    }
    const http = attempts.find((a) => a.outcome === 'http');
    if (http) {
      return Object.assign(base, {
        code: 'http-' + http.status, message: 'YouTube answered with HTTP ' + http.status + '.',
        hint: 'Normal playback continues - nothing on the page was changed.' });
    }
    if (botCheckSignal) {
      return Object.assign(base, {
        code: 'bot-check',
        message: 'YouTube demands a bot check ("Sign in to confirm you\'re not a bot").',
        hint: 'This is an automation check, NOT a proven age or content restriction' +
          (ageSignal ? ' - the answer also carried an age signal, and both signals are listed in the panel under "Answers".'
                     : ' - the answer per client is listed in the panel under "Answers".') });
    }
    if (ageSignal) {
      return Object.assign(base, {
        code: 'age-restricted', message: 'This video requires age confirmation.',
        hint: 'The answer per client is listed in the panel under "Answers".' });
    }
    if (ps.includes('LOGIN_REQUIRED')) {
      return Object.assign(base, {
        code: 'login-required', message: 'This video requires signing in (without a bot notice).',
        hint: 'The answer per client is listed in the panel under "Answers".' });
    }
    if (ps.includes('CONTENT_CHECK_REQUIRED')) {
      return Object.assign(base, {
        code: 'content-check', message: 'This video cannot be retrieved with this client.',
        hint: 'Nothing on the page was changed.' });
    }
    if (ps.includes('LIVE_STREAM_OFFLINE')) {
      return Object.assign(base, { code: 'live-offline', message: 'The livestream is offline.', hint: '' });
    }
    if (ps.includes('UNPLAYABLE') || ps.includes('ERROR')) {
      return Object.assign(base, {
        code: 'unplayable', message: 'YouTube refuses playback for this client.',
        hint: 'The reason - if any - is listed in the panel under "Answers".' });
    }
    if (outcomes.some((s) => s.startsWith('playability:') || s === 'no-audio-url' || s === 'no-streaming-data')) {
      return Object.assign(base, {
        code: 'no-audio-url', message: 'No answer contained a direct audio URL.',
        hint: 'No client delivered usable audio formats - details are listed in the panel under "Answers".' });
    }
    return Object.assign(base, {
      code: 'no-usable-client', message: 'No client delivered a usable audio URL.', hint: '' });
  }

  // Walks the clients in order and stops at the first usable audio URL. Two independent guards kill
  // stale work: the epoch check before and after every await, plus the videoId the caller asked for.
  // Bounded repetition, exactly like the console snippet: when an answer carries no audio URL but brings
  // a visitorData of its own, the SAME client is asked once more with that value. At most ONE such
  // repetition per resolve (MAX_VISITOR_DATA_REPEATS) - no loop, no timer, no endless retrying.
  // One deliberate difference to the snippet: it repeats when the answer had no streamingData at all,
  // this file repeats when pickAudio() found nothing - so it also covers "streamingData with no usable
  // audio format". Same bound, same source for the value, same one-shot rule.
  async function resolveAudio(videoId, epoch, signal) {
    const attempts = [];
    let visitorDataRepeats = 0;
    for (const key of CLIENT_ORDER) {
      if (signal && signal.aborted) { attempts.push({ outcome: 'network', error: 'AbortError' }); break; }
      if (epoch !== state.epoch) { state.counters.staleDropped += 1; return { stale: true, epoch, videoId }; }
      state.counters.resolves += 1;
      let repeatedThisClient = false;
      let r = await postPlayer(key, videoId, signal, state.visitorData);
      const dropStale = () => {
        state.counters.staleDropped += 1;
        log('resolve:stale-dropped', { client: key, videoId, epoch, currentEpoch: state.epoch });
        return { stale: true, epoch, videoId };
      };
      if (epoch !== state.epoch) return dropStale();   // A newer track asked first: never apply this answer.
      if (r.requestError) {
        attempts.push({ client: key, outcome: 'network', error: r.requestError.name,
                        visitorDataSent: r.visitorDataSent === true });
        break;                                      // a network problem hits every client the same way
      }
      if (r.http && !r.http.ok) {
        attempts.push({ client: key, outcome: 'http', status: r.http.status,
                        visitorDataSent: r.visitorDataSent === true });
        continue;
      }
      const handed = r.json && r.json.responseContext ? r.json.responseContext.visitorData : null;
      if (!pickAudio(r.json) && handed && visitorDataRepeats < MAX_VISITOR_DATA_REPEATS) {
        // Memory only. The value is stored, counted and logged as a fact - never printed anywhere.
        state.visitorData = handed;
        visitorDataRepeats += 1;
        state.counters.visitorDataRepeats += 1;
        repeatedThisClient = true;
        log('resolve:visitor-data-repeat', { client: key, videoId, because: 'answer carried no audio URL' });
        r = await postPlayer(key, videoId, signal, state.visitorData);
        if (epoch !== state.epoch) return dropStale();
        if (r.requestError) {
          attempts.push({ client: key, outcome: 'network', error: r.requestError.name,
                          visitorDataSent: true, retriedWithVisitorData: true });
          break;
        }
        if (r.http && !r.http.ok) {
          attempts.push({ client: key, outcome: 'http', status: r.http.status,
                          visitorDataSent: true, retriedWithVisitorData: true });
          continue;
        }
      }
      const ps = r.json && r.json.playabilityStatus ? r.json.playabilityStatus.status : null;
      const audio = pickAudio(r.json);
      if (audio) {
        const sd = r.json.streamingData || {};
        const expires = Number(sd.expiresInSeconds);
        return {
          ok: true, epoch, videoId, client: key, audio, playabilityStatus: ps,
          expiresInSeconds: Number.isFinite(expires) ? expires : null,
          audioCount: audioCandidates(r.json).length, attempts, elapsedMs: r.elapsedMs,
          visitorDataSent: r.visitorDataSent === true, visitorDataRepeats,
        };
      }
      attempts.push({
        client: key,
        outcome: ps ? 'playability:' + ps
          : (r.json && r.json.streamingData ? 'no-audio-url' : 'no-streaming-data'),
        audioWithUrl: audioCandidates(r.json).length,
        reason: r.json && r.json.playabilityStatus ? redactText(r.json.playabilityStatus.reason, 160) : null,
        visitorDataSent: r.visitorDataSent === true,
        retriedWithVisitorData: repeatedThisClient,
      });
    }
    const failure = classifyResolveFailure(attempts);
    return Object.assign({ ok: false, epoch, videoId, attempts, visitorDataRepeats }, failure);
  }

  // ------------------------------------------------- playback verification
  // Verified means: the playhead REALLY moved. An accepted play() without progress, a pause, an
  // element error and an autoplay refusal stay separate verdicts - none of them is "verified".
  async function requestPlay(el) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => el.play()),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error('Playback start did not settle before the deadline.');
            error.name = 'PlayTimeoutError';
            reject(error);
          }, TIMINGS.playStartTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function observePlayback(el, opts) {
    const rec = {
      playOutcome: null, playRejection: null, failure: null, autoplayBlocked: false,
      verdict: null, note: null, advanced: false, deltaSeconds: null,
      startSeconds: null, currentTime: null, paused: null, readyState: null,
      startedDuringPositionCheck: !!opts.playStart,
      error: null, timeupdateCount: 0, observeMs: opts.verifyMs, events: [],
    };
    const names = ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled',
                   'error', 'pause', 'ended', 'emptied', 'timeupdate'];
    const handlers = names.map((n) => [n, () => { rec.events.push(n); }]);
    handlers.forEach(([n, h]) => el.addEventListener(n, h));
    // Read the clock BEFORE play(): an element can already advance while the play() promise is
    // still pending, and that progress belongs to this window.
    const t0 = num(el.currentTime);
    rec.startSeconds = t0;
    if (opts.play) {
      try {
        if (opts.playStart) {
          const start = await opts.playStart;
          if (!start.ok) throw start.error;
        } else {
          await requestPlay(el);
        }
        rec.playOutcome = 'resolved';
      } catch (e) {
        const fail = playFailure(e);
        rec.playOutcome = 'rejected:' + fail.name;
        rec.playRejection = fail.name;
        rec.autoplayBlocked = fail.autoplayBlocked;
        rec.failure = fail.classification;
      }
    } else {
      rec.playOutcome = 'not-requested';
    }
    await delay(rec.observeMs);
    const t1 = num(el.currentTime);
    rec.deltaSeconds = num((t1 === null ? 0 : t1) - (t0 === null ? 0 : t0));
    rec.advanced = !!rec.deltaSeconds && rec.deltaSeconds > TIMINGS.minAdvanceSeconds;
    rec.timeupdateCount = rec.events.filter((e) => e === 'timeupdate').length;
    rec.currentTime = t1;
    rec.paused = !!el.paused;
    rec.readyState = el.readyState;
    rec.error = el.error ? { code: el.error.code } : null;
    rec.events = rec.events.slice(-20);
    handlers.forEach(([n, h]) => el.removeEventListener(n, h));
    // Order matters: a refused play() leaves the element paused, so the pause state must not mask
    // the refusal. 'paused' only means something when play() itself was accepted.
    rec.verdict = rec.advanced ? 'playing'
      : rec.error ? 'media-error'
      : rec.autoplayBlocked ? 'blocked-autoplay'
      : rec.playRejection ? 'play-rejected'
      : !opts.play ? 'not-started'
      : rec.paused ? 'paused'
      : 'no-progress';
    rec.note = rec.verdict === 'playing'
      ? 'playhead advanced by ' + rec.deltaSeconds + 's - playback verified'
      : rec.verdict === 'media-error'
        ? 'the element reports a media error (code ' + (rec.error ? rec.error.code : '?') + ')'
        : rec.verdict === 'blocked-autoplay'
          ? 'play() was refused with NotAllowedError (autoplay policy) - one click on the page fixes it'
          : rec.verdict === 'play-rejected'
            ? 'play() was refused with ' + rec.playRejection + ' (' + rec.failure + ') - not an autoplay block'
            : rec.verdict === 'not-started'
              ? 'playback was paused when the mode was switched on - position and state were kept'
              : rec.verdict === 'paused'
                ? 'the element is paused after an accepted play()'
                : 'play() resolved (or was never called) but the playhead did not advance';
    return rec;
  }

  // ----------------------------------------------------------- source switch
  // A src write done by this file is never counted as the page taking the source back: the exact
  // string we assigned is compared, not a timing guess.
  function disconnectObserver(a) {
    if (a && a.observer) {
      try { a.observer.disconnect(); } catch (e) { /* ignore */ }
      a.observer = null;
    }
  }

  function observeSrc(el) {
    if (!state.audio || state.audio.observer) return;
    const observer = new MutationObserver((muts) => {
      const a = state.audio;
      if (!a) return;
      for (const m of muts) {
        if (m.attributeName !== 'src') continue;
        const raw = el.getAttribute('src');
        const own = raw === a.assignedSrc || el.src === a.assignedSrc;
        a.srcChanges.push({ t: Date.now(), newKind: kindOf(raw), own });
        while (a.srcChanges.length > 60) a.srcChanges.shift();
        if (own) a.ownWrites += 1;
        else {
          a.pageReclaims += 1;
          state.counters.pageReclaims += 1;
          log('src:page-write', { newKind: kindOf(raw) });
        }
      }
    });
    observer.observe(el, { attributes: true, attributeFilter: ['src'] });
    state.audio.observer = observer;
    state.audio.el = el;
  }

  // The known bug was "switching on starts at 0 instead of the current position". This is the fix:
  // seek after metadata and re-assert (bounded) until the element is really at the target. The
  // re-assert matters because the page can write a position of its own while we load.
  async function applyPosition(el, target, epoch, onPositionReady) {
    const out = {
      target, observed: null, asserts: 0, restored: false, skipped: false, late: false,
      userIntervened: false, seesaw: [], writeError: null, offsetSeconds: null,
    };
    const positionReady = () => {
      if (typeof onPositionReady === 'function') onPositionReady();
    };
    if (target === null) {
      positionReady();
      out.skipped = true;
      out.observed = num(el.currentTime);
      out.reason = 'the page is at the start - nothing to restore';
      return out;
    }
    let intervened = false;
    const onUser = () => { intervened = true; };
    const userEvents = ['pointerdown', 'keydown'];
    userEvents.forEach((n) => document.addEventListener(n, onUser, true));
    try {
      while (out.asserts < TIMINGS.seekReassertAttempts) {
        if (epoch !== state.epoch) { out.stale = true; break; }
        const now = num(el.currentTime);
        out.seesaw.push(now);
        if (now !== null && now >= target - TIMINGS.seekToleranceSeconds) { positionReady(); break; }
        if (intervened) break;
        if (el.seeking) { await delay(TIMINGS.seekReassertMs); out.asserts += 1; continue; }
        try { el.currentTime = target; } catch (e) { out.writeError = (e && e.name) || 'Error'; break; }
        out.asserts += 1;
        // The first seek has been issued. Playback may buffer/start while the same bounded
        // position checks continue; do not add a fixed silent seek interval before play().
        positionReady();
        await delay(TIMINGS.seekReassertMs);
      }
    } finally {
      userEvents.forEach((n) => document.removeEventListener(n, onUser, true));
    }
    const final = num(el.currentTime);
    out.observed = final;
    out.userIntervened = intervened;
    out.restored = final !== null && final >= target - TIMINGS.seekToleranceSeconds;
    out.offsetSeconds = final === null ? null : num(final - target);
    log('position', { target, observed: out.observed, asserts: out.asserts,
                      restored: out.restored, userIntervened: intervened, writeError: out.writeError });
    return out;
  }

  function failApply(code, message, hint, extra) {
    state.mode = 'error';
    state.verified = false;
    state.verifyMethod = null;
    state.counters.failures += 1;
    state.lastError = Object.assign({
      code, message, hint: hint || '', at: new Date().toISOString(),
      videoId: state.videoId, epoch: state.epoch,
    }, extra || {});
    log('error', { code, message, hint: state.lastError.hint, touched: state.lastError.touched === true });
    syncPicture('error');            // an error leaves the mode: the page gets its picture again
    notifyBackground();
    renderPanel();
    return { ok: false, code, message, hint: state.lastError.hint, stale: false, epoch: state.epoch };
  }

  // The switch itself. Order: remember what the page had, point the element at the audio URL, wait
  // for real metadata, restore the position, re-apply volume/mute and the pause intent, then verify
  // that the playhead moves. Anything that fails after the element was touched is followed by
  // restoreNormal(), so the page never stays broken.
  async function applyAudio(plan, opts) {
    opts = opts || {};
    const epoch = plan.epoch;
    // Immediately before anything is applied, the plan has to belong to the track that is current
    // right now (same videoId) and to the current generation (same epoch). A plan for a track that is
    // gone never touches the element at all - no partial apply, no "almost right" state.
    const abandon = (where) => {
      state.counters.staleDropped += 1;
      log('apply:abandoned', { where, planVideoId: plan.videoId || null, planEpoch: epoch,
                               videoId: state.videoId, epoch: state.epoch });
      return { ok: false, stale: true, epoch, reason: 'stale-plan:' + where };
    };
    const stillCurrent = () => epoch === state.epoch &&
      (!plan.videoId || plan.videoId === state.videoId);
    if (!stillCurrent()) return abandon('before-any-touch');
    const el = videoEl();
    if (!el) {
      return failApply('no-element', 'No <video> element found.',
        'The page is not a watch page, or the player is not loaded yet.',
        { touched: false, videoId: plan.videoId });
    }
    if (!state.audio || state.audio.locked) {
      // A locked record belongs to a track that is gone: the new track gets a fresh record, so the
      // page's own src (and the src history) of THIS track is captured, not the old track's.
      const original = el.getAttribute('src');
      state.audio = {
        url: null, client: null, itag: null, mime: null, host: null, resolvedAt: null,
        videoId: null, locked: false, lockReason: null, lockedAt: null, lockedFor: null,
        originalSrc: original, originalSrcKind: kindOf(original),
        assignedSrc: null, assignedKind: null, mediaModeAtSwitch: null,
        urlParams: [], srcChanges: [], ownWrites: 0, pageReclaims: 0, applies: 0,
        observer: null, el, expiresInSeconds: null,
      };
    }
    const a = state.audio;
    // The binding, set once per application: this URL now belongs to exactly this videoId until a
    // track change locks the record. Nothing in this file may pair it with another id.
    a.videoId = plan.videoId || state.videoId;
    a.locked = false;
    a.lockReason = null;
    a.lockedAt = null;
    a.lockedFrom = null;
    a.lockedFor = null;
    // Position target from the PAGE clock for THIS video, read right before the switch. If the
    // player is still on another video (SPA swap) the read is refused and nothing is restored.
    const before = elementState(el);
    const pageTime = pageClockSeconds(plan.videoId);
    const ownsCurrentAudio = a.assignedSrc &&
      (el.getAttribute('src') === a.assignedSrc || el.src === a.assignedSrc);
    const rawTarget = ownsCurrentAudio && before.time !== null ? before.time
      : pageTime !== null ? pageTime : before.time;
    const target = (opts.restorePosition !== false && rawTarget !== null &&
                    rawTarget > TIMINGS.minRestoreSeconds) ? rawTarget : null;

    const facts = urlFacts(plan.audio.url);
    a.url = plan.audio.url;                    // closure only: the signed URL text never leaves
    a.host = facts.host;
    a.urlParams = facts.paramNames;
    a.client = plan.client;
    a.itag = plan.audio.itag;
    a.mime = plan.audio.mime;
    // What the resolver did about visitorData: booleans only, the value itself is never recorded.
    a.visitorData = {
      sent: plan.visitorDataSent === true,
      repeats: plan.visitorDataRepeats || 0,
      source: "only YouTube's own responseContext.visitorData of this same POST",
      valueRecorded: false,
    };
    a.attempts = plan.attempts || [];          // earlier client results stay visible, mixed or not
    a.resolvedAt = new Date().toISOString();
    a.expiresInSeconds = plan.expiresInSeconds === undefined ? null : plan.expiresInSeconds;
    a.assignedSrc = plan.audio.url;
    a.assignedKind = kindOf(plan.audio.url);
    a.mediaModeAtSwitch = mediaMode(el);
    a.applies += 1;
    state.mode = 'resolving';
    observeSrc(el);
    // The one check that matters, right before the URL is handed to the element: same track, same
    // generation. Whatever happened between the plan and this line, the write does not happen.
    if (!stillCurrent()) { disconnectObserver(a); return abandon('before-src-write'); }
    // Snapshot for failed/incomplete takeover recovery: a fresh failed load may already have
    // reset the element to paused/zero. Normal hand-back reads current user changes instead.
    state.before = Object.assign({}, before, { videoId: plan.videoId || state.videoId,
                                              at: new Date().toISOString() });
    try {
      el.src = plan.audio.url;
      el.load();
    } catch (e) {
      return failApply('src-write-failed', 'The source could not be assigned to the element.',
        redactText(e && e.message, 120), { touched: false });
    }
    log('switch', { videoId: plan.videoId, epoch, client: plan.client, itag: plan.audio.itag,
                    mime: plan.audio.mime, host: facts.host, urlParams: facts.paramNames,
                    target, before, playabilityStatus: plan.playabilityStatus || null });
    const meta = await waitFor(() => {
      if (el.error) return { ok: false, reason: 'media-error', code: el.error.code };
      if (el.readyState >= 1) return { ok: true, readyState: el.readyState };
      return null;
    }, TIMINGS.metadataTimeoutMs);
    if (!stillCurrent()) return abandon('after-metadata');
    // The pause intent of the page BEFORE this switch decides how it is handed back on a failure.
    const playIntent = before.paused === false ? 'resume' : 'stay-paused';
    if (!meta) {
      const err = failApply('no-metadata',
        'The audio stream delivered no playable data within ' + Math.round(TIMINGS.metadataTimeoutMs / 1000) +
        ' s.',
        'The source is not usable for this element - normal playback was restored.',
        { touched: true, readyState: el.readyState });
      err.restore = await restoreNormal({ reason: 'switch-failed', keepError: true, playIntent });
      return err;
    }
    if (!meta.ok) {
      const err = failApply('media-error', 'The element reports a media error (code ' + meta.code + ').',
        'The source is not usable for this element - normal playback was restored.',
        { touched: true, mediaErrorCode: meta.code });
      err.restore = await restoreNormal({ reason: 'switch-failed', keepError: true, playIntent });
      return err;
    }

    // Restore volume/mute before any early play request: no burst at the wrong level.
    if (Number.isFinite(before.volume)) {
      try { el.volume = Math.min(1, Math.max(0, before.volume)); } catch (e) { /* ignore */ }
    }
    if (before.muted !== null) {
      try { el.muted = before.muted; } catch (e) { /* ignore */ }
    }
    const shouldPlay = before.paused === false;
    let playStart = null;
    const startWhenPositioned = () => {
      if (!shouldPlay || playStart || !stillCurrent()) return;
      // Handle rejection immediately even while position correction is still awaiting its timer.
      playStart = requestPlay(el).then(() => ({ ok: true }), (error) => ({ ok: false, error }));
    };
    const position = await applyPosition(el, target, epoch, startWhenPositioned);
    if (!stillCurrent()) return abandon('after-position');
    // Verification starts after position correction, so seek jumps cannot masquerade as progress.
    // Reuse the first play result; a refused start must not trigger a second automatic play().
    const playback = await observePlayback(el, { play: shouldPlay, playStart, verifyMs: TIMINGS.verifyMs });
    if (!stillCurrent()) return abandon('after-playback');
    // One last correction, only when playback really runs, the target is still missed and the user
    // did not seek in the meantime. Bounded: a single extra write.
    const nowSeconds = num(el.currentTime);
    if (position.target !== null && !position.restored && !position.userIntervened &&
        playback.verdict === 'playing' && nowSeconds !== null &&
        nowSeconds < position.target - TIMINGS.seekToleranceSeconds) {
      try {
        el.currentTime = position.target;
        position.late = true;
        position.lateTarget = position.target;
      } catch (e) { position.lateError = (e && e.name) || 'Error'; }
    }
    state.position = position;
    state.playback = playback;
    state.applied = {
      paused: !!el.paused, muted: !!el.muted, volume: num(el.volume),
      time: num(el.currentTime), readyState: el.readyState, pausedRequested: before.paused,
    };
    state.verified = playback.verdict === 'playing';
    state.verifyMethod = state.verified ? 'playhead-advanced-after-switch' : null;
    state.mode = 'active';
    state.lastError = null;
    state.counters.applies += 1;
    // What the user really hears from here on is OUR stream, and its position is the one to hand back
    // later: the player clock is only re-read by the page when the user seeks, so at hand-back time it
    // can be minutes behind - the live failure where turning audio-only off restarted the track. The
    // stream clock records observed seconds and their track as a fallback when the live element is
    // unreadable. Never extrapolate by wall time, and never use a clock belonging to another track.
    a.streamClock = { videoId: a.videoId || state.videoId, seconds: num(el.currentTime), at: Date.now() };
    state.progress = { at: Date.now(), seconds: num(el.currentTime), stalledSince: null, warned: false };
    syncPicture('switch');
    startWatchdog();
    log('switch:done', { verdict: playback.verdict, verified: state.verified, position,
                         applied: state.applied, autoplayBlocked: playback.autoplayBlocked });
    renderPanel();
    notifyBackground();
    return { ok: true, stale: false, epoch, playback, position, before, applied: state.applied,
             verified: state.verified };
  }

  // ------------------------------------------------- back into the page's hands
  // What a hand-back still needs, and what it must not do:
  //   - it never writes the page's OWN source. A blob URL the page created belongs to the page's
  //     MediaSource, and our src write detached that MediaSource: an old blob URL never reaches
  //     readyState 1 again and the element hangs on it (exactly the live symptom). The URL stays
  //     RECORDED (a.originalSrc) for the report; the page rebuilds its own playback through
  //     loadVideoById - the path the console probe verified in page context.
  //   - normal hand-back reads current element state before reloading; failure recovery uses the
  //     explicit pre-switch intent and snapshot because our failed load may have reset the element.
  //   - the position target is never invented as 0: when the player clock is unreadable the element's
  //     own position decides, and when nothing is readable no startSeconds is sent at all.
  //   - the hand-back counts as successful only when new video metadata really arrived and, if playback
  //     was wanted, the playhead runs again. Otherwise a visible restore-failed state is set.
  const RESTORE_FAIL = {
    'no-metadata': {
      message: 'The page did not make its own playback usable within the deadline (no new video metadata).',
      hint: 'Reload the page (F5) - normal playback is back immediately afterwards.',
    },
    'cross-context-refused': {
      message: 'The call to the player was refused at the security boundary between the content script and the page context.',
      hint: 'Reload the page (F5) - normal playback is back immediately afterwards.',
    },
    'no-player-api': {
      message: 'The player API (loadVideoById) is not reachable on this page.',
      hint: 'Reload the page (F5) - normal playback is back immediately afterwards.',
    },
    'no-video-id': {
      message: 'No video ID could be read that could have been handed to the page.',
      hint: 'Reload the page (F5) - normal playback is back immediately afterwards.',
    },
    'play-rejected': {
      message: 'The page owns the element again, but playback could not be started.',
      hint: 'One click on the player starts playback - nothing else was changed.',
    },
    'no-progress': {
      message: 'The page owns the element again, but the playhead does not move on.',
      hint: 'One click on the player starts playback; otherwise reload the page (F5).',
    },
    'player-call-failed': {
      message: 'The call to the player was aborted with an error.',
      hint: 'Reload the page (F5) - normal playback is back immediately afterwards.',
    },
  };

  // A failed hand-back is its own, visible state: the page is NOT back to normal, so reporting 'off'
  // would be a lie. It gets its own mode, its own error record and its own counter.
  function failRestore(out) {
    const reason = out.failReason || (out.playerCall && out.playerCall.error) || 'unknown';
    const mediaCode = /^media-error:(\d+)$/.exec(reason);
    const text = mediaCode
      ? { message: 'The element reports a media error after the hand-back (code ' + mediaCode[1] + ').',
          hint: 'Reload the page (F5) - normal playback is back immediately afterwards.' }
      : (RESTORE_FAIL[reason] || RESTORE_FAIL['player-call-failed']);
    const priorCode = state.lastError ? state.lastError.code : null;
    state.mode = 'restore-failed';
    state.verified = false;
    state.verifyMethod = null;
    state.counters.failures += 1;
    state.counters.restoreFailures += 1;
    state.lastError = {
      code: 'restore-failed', reason,
      message: text.message, hint: text.hint,
      at: new Date().toISOString(), videoId: state.videoId, epoch: state.epoch,
      touched: out.hadAudio === true,
      method: out.method || null,
      playerCallError: out.playerCall ? out.playerCall.error : null,
      argsBridge: out.playerCall ? out.playerCall.argsBridge : null,
      cloneTarget: out.playerCall ? (out.playerCall.cloneTarget || null) : null,
      priorErrorCode: priorCode,
    };
    out.hint = text.hint;
    out.failure = { code: 'restore-failed', reason, message: text.message };
    log('restore:failed', { reason, message: text.message, method: out.method || null,
                            playerCallError: state.lastError.playerCallError,
                            startSeconds: out.startSeconds, positionSource: out.positionSource,
                            priorErrorCode: priorCode });
    renderPanel();
    return state.lastError;
  }

  function teardown() {
    if (state.watch) { clearInterval(state.watch); state.watch = null; }
    disconnectObserver(state.audio);
  }

  // The hand-back itself. Order: ask the PAGE to rebuild its own playback for the current videoId,
  // wait for new metadata, restore the current position/volume/mute, then re-apply the pause
  // intent - and only then decide whether it counts as successful.
  async function restoreNormal(opts) {
    if (state.restoreTask) return state.restoreTask;
    const task = performRestore(opts);
    state.restoreTask = task;
    try { return await task; }
    finally { if (state.restoreTask === task) state.restoreTask = null; }
  }

  async function performRestore(opts) {
    opts = opts || {};
    const a = state.audio;
    let el = videoEl();
    const out = {
      reason: opts.reason || 'user', hadAudio: !!a, method: null, ok: false,
      hint: '', videoId: state.videoId, error: null,
      blobRewrite: 'never (the page source URL is recorded, not written back)',
      blobRewriteWhy: 'an MSE blob URL of the MediaSource our src write detached never reaches ' +
        'readyState 1 - the page builds a fresh one through loadVideoById instead',
    };
    teardown();
    state.epoch += 1;                              // anything still in flight is stale now
    const epoch = state.epoch;
    const stillCurrent = () => state.epoch === epoch && state.videoId === out.videoId;
    const abandon = () => {
      log('restore:abandoned', { epoch, currentEpoch: state.epoch, videoId: out.videoId });
      return Object.assign(out, { ok: false, stale: true });
    };
    if (!a || !el) {
      out.ok = true;
      out.method = 'nothing-to-undo';
      state.audio = null;
      state.before = null;
      if (!opts.keepError) { state.mode = 'off'; state.verified = false; }
      state.lastRestore = out;
      log('restore', out);
      syncPicture('hand-back');
      notifyBackground();
      renderPanel();
      return out;
    }
    // The page's own blob URL belongs to the track it was created for - and it is never written back
    // (see blobRewriteWhy). After a track change the record is locked and the page owns the element
    // again by then: what remains is the player API for the video that is really running, or the
    // honest report that there is nothing to undo.
    const ownRecord = !a.locked && (!a.videoId || a.videoId === state.videoId);
    const holdsOurSrc = !!a.assignedSrc &&
      (el.getAttribute('src') === a.assignedSrc || el.src === a.assignedSrc);
    if (!ownRecord && !holdsOurSrc) {
      out.ok = true;
      out.method = 'page-owns-element';
      out.hint = 'The page already took the element over itself (different track) - there was nothing to hand back.';
      out.after = elementState(el);
      out.pageHasSource = out.after.srcKind === 'blob';
      state.audio = null;
      state.before = null;
      if (!opts.keepError) { state.mode = 'off'; state.verified = false; state.verifyMethod = null; }
      state.lastRestore = out;
      log('restore', out);
      syncPicture('hand-back');
      notifyBackground();
      renderPanel();
      return out;
    }
    state.mode = 'restoring';
    state.verified = false;
    state.verifyMethod = null;
    syncPicture('hand-back-start');
    notifyBackground();
    renderPanel();
    // Read the stream BEFORE loadVideoById replaces it. Live element state wins over the
    // switch-on snapshot: the user may have sought, paused, muted or changed volume since then.
    // Failed/incomplete takeovers use the caller's explicit pre-switch intent instead.
    const snap = state.before && state.before.videoId === state.videoId ? state.before : null;
    const liveElTime = num(el.currentTime);
    const livePageTime = pageClockSeconds(state.videoId);
    const usable = (v) => Number.isFinite(v) && v >= 0;
    const liveStream = ownRecord && holdsOurSrc && el.readyState >= 1 && usable(liveElTime);
    const sc = a.streamClock;
    const recordedTime = sc && sc.videoId === state.videoId && usable(sc.seconds) ? sc.seconds : null;
    let target = null;
    let positionSource = 'none';
    if (liveStream && !opts.playIntent) {
      target = liveElTime; positionSource = 'live-element-position';
    } else if (opts.playIntent && snap && usable(snap.time)) {
      target = snap.time; positionSource = 'snapshot-element-position';
    } else if (usable(recordedTime)) {
      target = recordedTime; positionSource = 'audio-only-stream-clock';
    } else if (snap && usable(snap.time)) {
      target = snap.time; positionSource = 'snapshot-element-position';
    } else if (usable(livePageTime)) {
      target = livePageTime; positionSource = 'live-page-clock';
    }
    // Recorded observations are never extrapolated using wall time: paused/buffering media
    // does not advance just because time passes. A real observed zero is a valid seek target.
    const startSeconds = target === null ? null : target;
    out.positionSource = positionSource;
    out.positionTarget = target;
    out.startSeconds = startSeconds;
    out.startSecondsNote = target === null ? 'no startSeconds sent: no readable position'
      : 'current observed position before rebuilding normal playback';
    const wasPaused = opts.playIntent === 'resume' ? false
      : opts.playIntent === 'stay-paused' ? true : !!el.paused;
    const volume = num(el.volume);
    const muted = !!el.muted;
    out.pauseIntent = wasPaused ? 'stay-paused' : 'resume';
    out.pauseIntentSource = opts.playIntent ? 'caller (page state before the switch)'
      : 'element state at restore time';
    out.volumeSource = 'element state at restore time';
    // The ONLY writer of the page's own source is the page. We ask it, through the player API, to build
    // its normal playback again for the video that is really running - the path the console probe
    // verified in page context. No blob URL of ours or of the page is written
    // here: a stale MSE blob URL would leave the element waiting for metadata that never comes.
    const targetVideoId = state.videoId || currentVideoId();
    if (!targetVideoId) {
      out.failReason = 'no-video-id';
      out.metaWait = 'skipped (nothing to hand over)';
    } else {
      const arg = { videoId: targetVideoId };
      if (startSeconds !== null) arg.startSeconds = startSeconds;
      const call = pageCall('loadVideoById', [arg]);
      out.playerCall = {
        ok: call.ok, error: call.error || null, refusedBy: call.refusedBy || null,
        message: call.message || null, argsBridge: call.argsBridge || null, retried: call.retried === true,
        cloneTarget: call.cloneTarget || null,
        args: arg, startSecondsOmitted: startSeconds === null,
      };
      out.method = call.ok ? 'player.loadVideoById' : null;
      // Also at the top level: the message API, the panel and the status all read the outcome there.
      out.argsBridge = call.argsBridge || null;
      out.cloneTarget = call.cloneTarget || null;    // which page-window form carried the arguments
      if (call.ok) {
        const meta = await waitFor(() => {
          if (!stillCurrent()) return { stale: true };
          // The player may replace the element. Old audio metadata is not a hand-back proof.
          const current = videoEl();
          if (!current || (current.getAttribute('src') === a.assignedSrc || current.src === a.assignedSrc)) return null;
          if (current.error) return { ok: false, code: current.error.code };
          return current.readyState >= 1 ? { ok: true, readyState: current.readyState, el: current } : null;
        }, TIMINGS.restoreSettleMs);
        if (!stillCurrent()) return abandon();
        if (meta && meta.el) el = meta.el;
        out.meta = meta ? { ok: meta.ok, readyState: meta.readyState, code: meta.code } : null;
        out.metaWait = meta ? 'new video metadata arrived' : 'timed out (' + TIMINGS.restoreSettleMs + ' ms)';
        if (!meta) out.failReason = 'no-metadata';
        else if (!meta.ok) out.failReason = 'media-error:' + meta.code;
      } else {
        // Nothing was written, so nothing is corrected either: no position write, no volume write, no
        // play(). The refusal is reported instead of being papered over.
        out.failReason = call.error === 'cross-context-refused' ? 'cross-context-refused'
          : call.error === 'no-method' || call.error === 'no-player' ? 'no-player-api'
          : 'player-call-failed';
        out.metaWait = 'skipped (the call never reached the page)';
      }
    }
    // Only when the page's playback really stands again: a position write, a volume write or a play()
    // on an element whose own source never became usable would be a lie on top of the failure.
    if (out.method && !out.failReason) {
      if (target !== null && target > TIMINGS.minRestoreSeconds) {
        try { el.currentTime = target; } catch (e) { out.seekError = (e && e.name) || 'Error'; }
      }
      if (volume !== null) { try { el.volume = Math.min(1, Math.max(0, volume)); } catch (e) { /* ignore */ } }
      try { el.muted = muted; } catch (e) { /* ignore */ }
      if (wasPaused) {
        try { el.pause(); } catch (e) { /* ignore */ }
        // A page that was paused stays paused: metadata is the whole proof here, because no playhead
        // is supposed to move. That is not a weaker claim, it is the correct one for this intent.
        out.ok = true;
        out.playheadAdvanced = false;
        out.playCalled = false;
        out.handBack = 'metadata + pause intent (no playhead progress required)';
      } else {
        try {
          await requestPlay(el);
          if (!stillCurrent()) return abandon();
          out.playCalled = true;
        } catch (e) {
          if (!stillCurrent()) return abandon();
          out.playRejection = (e && e.name) || 'Error';
          out.failReason = out.failReason || 'play-rejected';
        }
        if (!out.playRejection && !out.failReason) {
          // "Handed back" only means something when the page really plays again: an accepted play()
          // without progress (or a playhead that stands still) is not a successful hand-back.
          const base = num(el.currentTime);
          const moved = await waitFor(() => {
            if (!stillCurrent()) return { stale: true };
            const t = num(el.currentTime);
            return t !== null && base !== null && t > base + TIMINGS.minAdvanceSeconds
              ? { advanced: true, from: base, to: t } : null;
          }, TIMINGS.restoreProgressMs, 60);
          if (!stillCurrent()) return abandon();
          out.playhead = moved || null;
          out.playheadAdvanced = !!moved;
          if (moved) {
            out.ok = true;
            out.handBack = 'metadata + playhead runs again';
          } else {
            out.failReason = 'no-progress';
            out.handBack = 'metadata, but the playhead did not move';
          }
        }
      }
      out.after = elementState(el);
      out.pageHasSource = out.after.srcKind === 'blob';
    }
    if (out.ok) {
      out.hint = out.pageHasSource
        ? 'The page owns the element again (it rebuilt its own source) and playback is running.'
        : 'The source belongs to the page again; if playback stutters, reload the page (F5).';
    } else {
      // No silent 'off': the user has to see that the page is NOT back to normal.
      failRestore(out);
    }
    state.audio = null;
    state.before = null;
    state.lastRestore = out;
    state.verified = false;
    state.verifyMethod = null;
    if (out.ok) state.mode = opts.keepError ? 'error' : 'off';
    syncPicture('hand-back-complete');
    notifyBackground();
    log('restore', out);
    renderPanel();
    return out;
  }

  // ------------------------------------------------------------- watchdog
  // Watches the running mode. It never changes the source on a whim: page re-takes are re-applied a
  // bounded number of times, everything else is only surfaced.
  function startWatchdog() {
    if (state.watch) return;
    state.watch = setInterval(watchdogTick, TIMINGS.watchdogMs);
  }

  function stopWatchdog() {
    if (state.watch) { clearInterval(state.watch); state.watch = null; }
  }

  async function watchdogTick() {
    // Safety net first, so it is reached even on the tick that ends the mode: hidden while the mode owns
    // the element, the page's own picture everywhere else. Idempotent - a tick that changes nothing only
    // costs this one call.
    syncPicture('watchdog');
    const a = state.audio;
    if (!a || state.mode === 'off') { stopWatchdog(); return; }
    if (state.tickBusy) return;
    // While a track is being resolved (and while its settle window is still open) the watchdog stays
    // quiet, and a cache that a track change locked (it belongs to a track that is gone) is never
    // touched again: a re-apply here would either devalue the answer that is on its way or point the
    // element at the old track. Counted instead of logged, so the log does not fill up with ticks.
    if (a.locked || state.mode === 'resolving') {
      state.counters.watchdogSkips += 1;
      return;
    }
    state.tickBusy = true;
    try {
      const el = videoEl();
      if (!el) return;
      if (a.el !== el) {                       // the page can replace its own element
        a.el = el;
        disconnectObserver(a);
        observeSrc(el);
        log('watch:element-replaced', { videoId: state.videoId });
      }
      if (el.error) {
        const code = el.error.code;
        const err = failApply('media-error-watch', 'The element reports a media error (code ' + code + ').',
          'Normal playback was restored.', { touched: true, mediaErrorCode: code });
        err.restore = await restoreNormal({ reason: 'element-error', keepError: true });
        return;
      }
      // The page took its own source back (non-own src write seen by the observer).
      if (a.pageReclaims > (a.reapplyHandled || 0)) {
        a.reapplyHandled = a.pageReclaims;
        if ((a.reapplyCount || 0) < TIMINGS.maxAutoReapplyPerTrack) {
          a.reapplyCount = (a.reapplyCount || 0) + 1;
          state.counters.autoReapplies += 1;
          log('watch:page-reclaim', { count: a.reapplyCount, pageReclaims: a.pageReclaims });
          await reapply('page-reclaim');
          return;
        }
        state.warning = {
          code: 'page-reclaimed',
          message: 'The page took the source back ' + a.pageReclaims + ' times.',
          hint: '"Try again" fetches the audio-only source once more; "Back to video" ends the mode.',
        };
        renderPanel();
        return;
      }
      // Stall detection: surfaced, never auto-corrected.
      const seconds = num(el.currentTime);
      if (seconds !== null && el.readyState >= 1 &&
          (el.getAttribute('src') === a.assignedSrc || el.src === a.assignedSrc)) {
        a.streamClock = { videoId: a.videoId, seconds, at: Date.now() };
      }
      const p = state.progress;
      const ownsSource = el.getAttribute('src') === a.assignedSrc || el.src === a.assignedSrc;
      if (!ownsSource) return;
      // Pause, end and backward seeks reset the baseline; they are not buffering.
      if (el.paused || el.ended || (seconds !== null && p.seconds !== null && seconds < p.seconds)) {
        state.progress = { at: Date.now(), seconds, stalledSince: null, warned: false };
        if (state.warning) { state.warning = null; renderPanel(); }
        return;
      }
      if (seconds !== null && p.seconds !== null && seconds > p.seconds + 0.05) {
        state.progress = { at: Date.now(), seconds, stalledSince: null, warned: false };
        // The observation that matters for a later hand-back: where OUR stream really is right now.
        a.streamClock = { videoId: a.videoId || state.videoId, seconds, at: Date.now() };
        if (!state.verified) {
          state.verified = true;
          state.verifyMethod = 'playhead-advanced-in-watchdog';
          notifyBackground();
          renderPanel();
        }
        if (state.warning) { state.warning = null; renderPanel(); }
      } else if (!el.paused) {
        if (!state.progress.stalledSince) state.progress.stalledSince = Date.now();
        const stalledFor = (Date.now() - state.progress.stalledSince) / 1000;
        if (stalledFor >= TIMINGS.stalledWarnSeconds && !state.progress.warned) {
          state.progress.warned = true;
          state.warning = {
            code: el.readyState < 3 ? 'buffering' : 'no-progress-watch',
            message: el.readyState < 3
              ? 'Playback has been buffering for about ' + Math.round(stalledFor) + ' s.'
              : 'Playback has been stalled for about ' + Math.round(stalledFor) + ' s without being paused.',
            hint: 'Nothing was changed automatically - "Try again" or "Back to video" are ready.',
          };
          log('watch:stalled', state.warning);
          renderPanel();
        }
      }
    } finally {
      state.tickBusy = false;
    }
  }

  // Re-applies the cached URL after the page reclaimed the element. A fresh generation makes every
  // in-flight answer stale; no new resolution is needed while the cached URL is still valid.
  // Two refusals matter here, both without any side effect:
  //   - a locked cache (or one that belongs to another videoId) is never applied again - and it must
  //     not bump the epoch either, otherwise a re-apply of the OLD track would invalidate the
  //     resolution that is running for the NEW one;
  //   - while a resolution for the current track is in flight (or its settle window is open) nothing
  //     is re-applied: that answer would be dropped by the generation bump.
  async function reapply(reason) {
    const a = state.audio;
    if (!a || !a.url) return null;
    if (a.locked || (a.videoId && a.videoId !== state.videoId)) {
      a.locked = true;
      a.lockReason = a.lockReason || 'track-change';
      log('reapply:refused', { reason, cacheVideoId: a.videoId || null, videoId: state.videoId });
      return { ok: false, skipped: 'stale-track', reason, videoId: state.videoId,
               cacheVideoId: a.videoId || null };
    }
    if (state.mode === 'resolving' || state.nav.timer) {
      log('reapply:deferred', { reason, videoId: state.videoId });
      return { ok: false, skipped: 'resolve-in-flight', reason, videoId: state.videoId };
    }
    const epoch = ++state.epoch;
    if (state.abort) { try { state.abort.abort(); } catch (e) { /* ignore */ } }
    state.mode = 'resolving';
    state.verified = false;
    state.verifyMethod = null;
    syncPicture('reapply');
    notifyBackground();
    renderPanel();
    log('reapply', { reason, epoch, videoId: state.videoId });
    return applyAudio({
      ok: true, epoch, videoId: state.videoId, client: a.client,
      audio: { url: a.url, itag: a.itag, mime: a.mime },
      playabilityStatus: null, expiresInSeconds: a.expiresInSeconds,
    }, {});
  }

  // ---------------------------------------------------------- track change
  // Two independent triggers: the SPA event and a poll (the event alone is not a guarantee).
  function watchNavigation() {
    if (state.nav.started) return;
    state.nav.started = true;
    state.nav.lastVideoId = currentVideoId();
    // The page's own start event fires before it replaces the old video, so this shortens the window a
    // track change would otherwise open. It is best effort and never required: the hide is idempotent
    // and the finish event, the poll and the watchdog all re-establish the same state a tick later.
    const onNavStart = () => { if (state.mode !== 'off') syncPicture('nav-start'); };
    document.addEventListener('yt-navigate-start', onNavStart, true);
    state.nav.offNavStart = () => document.removeEventListener('yt-navigate-start', onNavStart, true);
    const onNavFinish = () => onPossibleTrackChange('yt-navigate-finish');
    document.addEventListener('yt-navigate-finish', onNavFinish, true);
    state.nav.offNavFinish = () => document.removeEventListener('yt-navigate-finish', onNavFinish, true);
    state.nav.poll = setInterval(() => { syncPicture('poll'); onPossibleTrackChange('poll'); },
                               TIMINGS.navPollMs);
  }

  // A track change invalidates the cached URL: it is bound to the videoId it was resolved for (see
  // applyAudio) and that track is gone. The record is LOCKED instead of deleted, so the report can
  // still say what was applied before - and so no later re-apply can resurrect it. Watchdog and src
  // observer of the old track are switched off in the same tick as the track change.
  function lockAudioForTrackChange(from, to) {
    const a = state.audio;
    if (a) {
      a.locked = true;
      a.lockReason = 'track-change';
      a.lockedAt = new Date().toISOString();
      a.lockedFrom = from || null;
      a.lockedFor = to || null;
      disconnectObserver(a);
      log('audio-locked', { reason: 'track-change', from: from || null, to: to || null,
                            cacheVideoId: a.videoId || null });
    }
    stopWatchdog();
    state.before = null;              // the snapshot belongs to the track that just ended
    state.progress = { at: null, seconds: null, stalledSince: null, warned: false };
    return !!a;
  }

  function onPossibleTrackChange(source) {
    const id = currentVideoId();
    if (!id || id === state.nav.lastVideoId) return;
    const from = state.nav.lastVideoId;
    state.nav.lastVideoId = id;
    state.videoId = id;
    state.counters.trackChanges += 1;
    // The old cache may no longer be applied to anything, and nothing may watch it any more. This
    // happens before the new generation is opened, so a re-apply of the old track cannot reach the
    // resolution below.
    lockAudioForTrackChange(from, id);
    // New generation: every answer and every switch still in flight for the old track is stale now.
    state.epoch += 1;
    if (state.abort) { try { state.abort.abort(); } catch (e) { /* ignore */ } }
    log('track-change', { from, to: id, source, epoch: state.epoch, mode: state.mode });
    if (state.mode === 'off' || state.mode === 'restoring') {
      // A navigation during hand-back cancels that generation; it must not turn the mode on again.
      state.mode = 'off';
      state.audio = null;
      state.verified = false;
      state.verifyMethod = null;
      syncPicture('navigation-while-off');
      notifyBackground();
      renderPanel();
      return;
    }
    state.warning = null;
    if (state.nav.timer) clearTimeout(state.nav.timer);
    state.mode = 'resolving';
    state.verified = false;
    state.verifyMethod = null;
    // The mode is on and the new track is not applied yet: from here the page's own video is a picture
    // this mode does not want to show, so the hide it started with has to hold across the whole window.
    syncPicture('track-change');
    state.counters.reResolves += 1;
    renderPanel();
    notifyBackground();
    const epoch = state.epoch;
    // Debounce: in a fast clicking session only the LAST track is resolved. Any answer that still
    // arrives for an earlier track hits the epoch check and is dropped.
    state.nav.timer = setTimeout(async () => {
      state.nav.timer = null;
      if (epoch !== state.epoch) {
        state.counters.staleDropped += 1;
        log('track-change:debounced-away', { epoch, currentEpoch: state.epoch, videoId: id });
        return;
      }
      await runSwitch('track-change');
    }, TIMINGS.settleAfterNavMs);
  }

  // ---------------------------------------------------------------- picture
  // Audio-only means: no picture. Two windows show one anyway, and they are exactly the two the
  // reported flash comes from:
  //   - switching on: the page's own video keeps being displayed until the audio-only URL reaches the
  //     element, and that URL costs a network round trip;
  //   - a track change: the page plays its own video for the whole settle window, until the new track
  //     is resolved and applied.
  // The element is therefore hidden as soon as this mode owns it (and on a navigation that is likely to
  // be followed by a switch, so the window is as short as the page makes it possible) and shown again on
  // every route back to the page's own playback.
  //
  // What this is NOT: it does not stop a media request, does not change what the element loads and does
  // not claim that no video frame was ever decoded. It is `visibility`, not `display`, so the element
  // keeps its box and the page's own layout and measurements stay untouched - and the inline value the
  // page had is put back exactly (or the property we added is removed again).
  //
  // One rule, one place: the picture is hidden exactly while this mode is resolving or active on a page
  // kind that serves a running video. Everything else shows the page again, so a hidden element cannot
  // be left behind - the navigation poll and the watchdog call syncPicture() as a safety net too.
  const WATCH_PATHS = /^\/(watch|live)\b/;

  function pictureShouldBeHidden() {
    if (state.mode !== 'resolving' && state.mode !== 'active') return false;
    if (!WATCH_PATHS.test(String(location.pathname || ''))) return false;
    // A resolve that never ends must not hold the picture hidden forever (a request that never settles
    // has no deadline of its own): after maxResolveHideMs the page's own video comes back, the panel
    // keeps saying "resolving" and its buttons keep working. The deadline is measured from the start of
    // the current mode phase (see syncPicture), so it releases once and does not flicker.
    if (state.mode === 'resolving' &&
        Date.now() - state.picturePhase.since > TIMINGS.maxResolveHideMs) {
      if (!state.pictureRelease) {
        state.pictureRelease = {
          code: 'resolve-timeout', epoch: state.epoch,
          holdMs: num(Date.now() - state.picturePhase.since),
          message: 'The picture was given back: this resolve is taking longer than ' +
            Math.round(TIMINGS.maxResolveHideMs / 1000) + ' s.',
        };
        log('picture:released', state.pictureRelease);
      }
      return false;
    }
    return !!(state.videoId || currentVideoId());
  }

  function inlineVisibility(el) {
    const style = el && el.style;
    if (!style) return null;
    try {
      if (typeof style.getPropertyValue === 'function') {
        return {
          value: style.getPropertyValue('visibility') || '',
          priority: typeof style.getPropertyPriority === 'function'
            ? (style.getPropertyPriority('visibility') || '') : '',
        };
      }
      return { value: style.visibility === undefined ? '' : String(style.visibility), priority: '' };
    } catch (e) { return null; }
  }

  // The reported value: what the element's inline style says about visibility right now.
  function inlineVisibilityValue(el) {
    const v = inlineVisibility(el);
    return v === null ? null : v.value;
  }

  function writeVisibility(el, value, priority) {
    const style = el && el.style;
    if (!style) return false;
    try {
      if (typeof style.setProperty === 'function') {
        if (!value) {
          if (typeof style.removeProperty === 'function') style.removeProperty('visibility');
          return true;
        }
        style.setProperty('visibility', value, priority || '');
        return true;
      }
      style.visibility = value || '';
      return true;
    } catch (e) { return false; }
  }

  // The picture is given back exactly as it was found: the inline value we replaced (if the page had
  // one) is written back, otherwise the property this file added is removed again.
  function showPicture(why) {
    const rec = state.picture;
    state.picture = null;
    if (!rec) return null;
    const restored = writeVisibility(rec.el, rec.previous ? rec.previous.value : '',
      rec.previous ? rec.previous.priority : '');
    state.counters.pictureShows += 1;
    if (restored && rec.previous && rec.previous.value) state.counters.pictureRestores += 1;
    const out = {
      shown: true, reason: why, restored,
      previousInline: rec.previous ? rec.previous.value : '',
      hiddenForMs: rec.hiddenAt ? num(Date.now() - rec.hiddenAt) : null,
    };
    log('picture:shown', out);
    renderPanel();
    return out;
  }

  function hidePicture(why) {
    const el = videoEl();
    if (!el) return null;
    if (state.picture && state.picture.el === el) {         // already hidden: only the reason moves on
      state.picture.reason = why;
      return state.picture;
    }
    if (state.picture) showPicture('element-replaced');     // the page swapped its own element
    const previous = inlineVisibility(el);
    if (previous === null || !writeVisibility(el, 'hidden', 'important')) {
      log('picture:not-hidden', { reason: why,
        note: 'the element offers no writable style - nothing else was changed' });
      return null;
    }
    state.picture = {
      el, reason: why, hiddenAt: Date.now(), epoch: state.epoch,
      previous, previousValue: previous.value || '', previousPriority: previous.priority || '',
    };
    state.pictureRelease = null;      // a fresh hide is a fresh hold, the old release no longer applies
    state.counters.pictureHides += 1;
    log('picture:hidden', { reason: why, epoch: state.epoch,
                            previousInline: previous.value || '(none)' });
    renderPanel();
    return state.picture;
  }

  // The single place that decides - and it is idempotent, so every caller can simply ask for the right
  // state instead of tracking hide/show pairs. It also records since when the mode has been in its
  // current value: the one clock the resolve deadline above is measured against.
  function syncPicture(why) {
    const ph = state.picturePhase;
    if (ph.mode !== state.mode) { ph.mode = state.mode; ph.since = Date.now(); state.pictureRelease = null; }
    if (pictureShouldBeHidden()) {
      if (!state.picture || state.picture.el !== videoEl()) hidePicture(why);
      return state.picture;
    }
    if (state.picture) showPicture(why);
    return null;
  }

  // ------------------------------------------------------- mode on and off
  async function runSwitch(reason) {
    const videoId = currentVideoId();
    if (!videoId) {
      return failApply('no-video', 'No video is running on this page.',
        'Audio-only needs a watch page with a running video.', { touched: false });
    }
    state.videoId = videoId;
    const epoch = ++state.epoch;
    if (state.abort) { try { state.abort.abort(); } catch (e) { /* ignore */ } }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    state.abort = controller;
    state.mode = 'resolving';
    state.verified = false;
    state.verifyMethod = null;
    state.warning = null;
    state.lastRestore = null;        // a new switch makes the old hand-back report stale
    // From this moment the mode owns the element as far as the user is concerned: the page's own
    // picture goes away now, not when the URL finally arrives (that round trip is the reported flash).
    syncPicture('switch-start');
    renderPanel();
    notifyBackground();
    let plan;
    let timedOut = false;
    const timer = controller ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, TIMINGS.resolveTimeoutMs) : null;
    try { plan = await resolveAudio(videoId, epoch, controller ? controller.signal : null); }
    finally { if (timer !== null) clearTimeout(timer); }
    if (timedOut && epoch === state.epoch) {
      return failApply('resolve-timeout', 'The audio resolver exceeded its deadline.',
        'Normal playback continues. Try again when the connection is ready.', { touched: false });
    }
    if (plan.stale || epoch !== state.epoch) { log('switch:aborted-stale', { videoId, epoch }); return { ok: false, stale: true }; }
    // Belt and braces: the track may have changed between resolution and application.
    if (currentVideoId() !== videoId) {
      state.counters.staleDropped += 1;
      log('switch:aborted-video-changed', { videoId, now: currentVideoId() });
      return { ok: false, stale: true };
    }
    if (!plan.ok) {
      return failApply(plan.code, plan.message, plan.hint, {
        touched: false, attempts: plan.attempts,
        clientOutcomes: plan.clientOutcomes || plan.attempts, mixed: plan.mixed === true,
        botCheckSuspected: plan.botCheckSuspected === true,
        visitorDataRepeats: plan.visitorDataRepeats || 0,
      });
    }
    return applyAudio(plan, {});
  }

  async function enable(reason) {
    if (state.restoreTask) return { ok: false, skipped: 'restore-in-flight' };
    log('enable', { reason: reason || 'user', videoId: currentVideoId(), state: elementState(videoEl()) });
    if (state.mode === 'active' || state.mode === 'resolving') return status();
    state.lastError = null;
    state.verified = false;
    state.counters.retries = reason === 'retry' ? state.counters.retries + 1 : state.counters.retries;
    return runSwitch(reason || 'user');
  }

  async function disable(reason) {
    log('disable', { reason: reason || 'user' });
    if (state.abort) { try { state.abort.abort(); } catch (e) { /* ignore */ } }
    state.warning = null;
    return restoreNormal({ reason: reason || 'user' });
  }

  async function toggle() {
    if (state.mode === 'active' || state.mode === 'resolving' || state.mode === 'restoring') await disable('toggle');
    else await enable('toggle');
    return status();
  }

  async function retry() {
    state.lastError = null;
    state.warning = null;
    if (state.restoreTask) return { ok: false, skipped: 'restore-in-flight' };
    state.counters.retries += 1;
    return runSwitch('retry');
  }

  // --------------------------------------------------------- redacted status
  function switchFacts(a, el) {
    if (!a) return null;
    const mm = a.mediaModeAtSwitch || (el ? mediaMode(el) : null);
    return {
      client: a.client, itag: a.itag, mime: a.mime,
      videoId: a.videoId || null,      // the track this URL was resolved for - never reassigned
      locked: a.locked === true,       // true: the URL may no longer be applied (track gone)
      lockReason: a.lockReason || null,
      lockedAt: a.lockedAt || null,
      bindingNote: 'the cached URL is only ever applied to the videoId it was resolved for; a track ' +
        'change locks the cache for re-apply and stops its watchdog and its src observer',
      urlHost: a.host,
      urlParamNames: a.urlParams,
      urlParamFacts: 'names only - query values, signature and token are never read out',
      expiresInSeconds: a.expiresInSeconds,
      resolvedAt: a.resolvedAt,
      lifetimeSeconds: a.resolvedAt ? num((Date.now() - Date.parse(a.resolvedAt)) / 1000) : null,
      contentTypeNote: 'the protocol answer left the content-type of the URL empty; the client decides by ' +
        'itag/mimeType (the development notes record why this client has to decide by itag/mimeType)',
      actualFetchLevelCredentials: "credentials: 'omit' (fetch only, decided in this file)",
      applies: a.applies,
      ownSrcWrites: a.ownWrites,
      pageSrcWrites: a.pageReclaims,
      pageSrcShare: (a.ownWrites + a.pageReclaims) > 0
        ? num(a.pageReclaims / (a.ownWrites + a.pageReclaims)) : null,
      originalSrcKind: a.originalSrcKind || null,
      pageSourceNote: 'the URL the page had before the switch is only ever RECORDED (kind above). ' +
        'This file never writes it back: an MSE blob URL of a detached MediaSource never reaches ' +
        'readyState 1 - the page rebuilds its own playback through loadVideoById instead',
      reapplyCount: a.reapplyCount || 0,
      srcChangesTail: a.srcChanges.slice(-5),
      modeSwitch: 'like for like: the element was already cross-origin, only the URL is ours',
      elementMode: mm,
      visitorData: a.visitorData || null,
      visitorDataNote: 'never read from a cookie or an account, never invented, never logged or ' +
        'exported - it is only ever handed back to the same endpoint that handed it out',
      priorClientOutcomes: a.attempts || [],   // clients that failed before this one - kept, not hidden
      cookieAccess: 'none - no browser.cookies permission in the manifest, no document.cookie, no token ' +
        'read. The only identifier that can be carried is the visitorData YouTube itself returned to ' +
        'this POST (memory only, see visitorData)',
    };
  }

  function liveElementFacts(el) {
    if (!el) return null;
    return {
      tagName: el.tagName || null,
      observedTime: num(el.currentTime),
      observedDuration: Number.isFinite(el.duration) ? num(el.duration) : null,
      paused: !!el.paused,
      muted: !!el.muted,
      volume: num(el.volume),
      readyState: el.readyState,
      networkState: el.networkState,
      srcKind: kindOf(el.getAttribute('src')),
      observedWidth: el.videoWidth === undefined ? null : el.videoWidth,
      observedHeight: el.videoHeight === undefined ? null : el.videoHeight,
      inlineVisibility: inlineVisibilityValue(el),
      note: 'observed values of the page element, not a measurement of transferred bytes',
    };
  }

  // What the element's picture is doing right now, as the report shows it: `hidden` is this file's
  // record (with the reason and since when), and `elementInlineVisibility` is what the element itself
  // says - both are reported, so a hidden element that was not put back cannot hide in the panel.
  function pictureFacts(el) {
    const rec = state.picture;
    return {
      hidden: !!rec,
      reason: rec ? rec.reason : null,
      epoch: rec ? rec.epoch : null,
      hiddenSinceMs: rec && rec.hiddenAt ? num(Date.now() - rec.hiddenAt) : null,
      previousInline: rec ? rec.previousValue : null,
      previousInlinePriority: rec ? rec.previousPriority : null,
      elementInlineVisibility: inlineVisibilityValue(el),
      watchedPaths: 'watch and live pages are the only ones where the picture is hidden at all',
      counters: {
        hides: state.counters.pictureHides, shows: state.counters.pictureShows,
        restores: state.counters.pictureRestores,
      },
      holdRelease: state.pictureRelease,
      limits: 'visibility only: no media request is stopped, no video frame is claimed to be undecoded, ' +
        'the element keeps its box, and the inline value the page had is put back - otherwise the ' +
        'property this file added is removed again. Never display:none.',
    };
  }

  function status() {
    const el = videoEl();
    const a = state.audio;
    return {
      version: state.version,
      mode: state.mode,
      verified: state.verified,
      verifyMethod: state.verifyMethod,
      videoId: state.videoId,
      epoch: state.epoch,
      host: location.host,
      watchUrlPath: location.pathname,
      switch: switchFacts(a, el),
      playback: state.playback,
      position: state.position,
      applied: state.applied,
      restore: state.lastRestore,
      picture: pictureFacts(el),
      pageApi: {
        counts: Object.assign({}, state.pageApi.counts),
        calls: state.pageApi.calls.slice(-5),
        bridges: ARGS_BRIDGE,
        note: 'how the calls into page code really went: what the browser boundary accepted, and ' +
          'whether a refusal was reported instead of hidden',
      },
      element: liveElementFacts(el),
      lastError: state.lastError,
      warning: state.warning,
      counters: Object.assign({}, state.counters),
      events: state.log.slice(-40),
      logSize: state.log.length,
      logSizeMax: TIMINGS.maxLogEntries,
      logRepeats: state.logRepeatCount,       // copies of a repeatable entry that were only counted
      upSeconds: num((Date.now() - state.startedAt) / 1000),
      startedAt: new Date(state.startedAt).toISOString(),
      privacy: 'no cookies, no tokens, no telemetry; resolver requests use only the InnerTube POST with ' +
        'credentials omit. A visitorData is never read from a cookie or an account - it can only come ' +
        'from that POST\'s own answer and stays in memory',
      claims: {
        proven: 'audio-only playback through the page element (videoWidth 0, totalVideoFrames 0, drift 0, ' +
          'no source re-take over 35 s) - the recorded live run',
        notProven: 'a byte-level "no video bytes" proof and any resource saving - neither was measured, ' +
          'so neither is claimed',
        liveRunProvenance: 'the recorded live run went through a console snippet whose resolver repeats ' +
          'the request once with the visitorData of the server\'s own answer (visitorDataSent: true). ' +
          'That run is NO proof of a path without visitorData.',
      },
      timings: TIMINGS,
    };
  }

  const brief = () => {
    const s = status();
    return {
      version: s.version, mode: s.mode, verified: s.verified, videoId: s.videoId, epoch: s.epoch,
      client: s.switch ? s.switch.client : null, itag: s.switch ? s.switch.itag : null,
      error: s.lastError ? s.lastError.code : null,
      counters: s.counters,
    };
  };

  const redact = {
    text: redactText,
    urlFacts,
    kindOf,
    status,
    stringify: (value) => JSON.stringify(value, (k, v) => (typeof v === 'string' ? redactText(v, 400) : v), 2),
  };

  // Sync to the background page. Missing receiver is normal (MV3 background may be asleep) - the
  // lastError read is what keeps it quiet, nothing else happens here.
  function notifyBackground() {
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage({ type: 'audio-only.state', state: brief() }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ panel
  // Minimal status UI: small, dark, bottom right, only text and buttons. It is the "understandable
  // status" requirement - the panel is created on the first user action.
  const PANEL_ID = 'audio-only-panel';

  function panelParts(create) {
    let p = state.panel;
    if (create && (!p || !p.root || !document.documentElement.contains(p.root))) {
      const host = document.createElement('div');
      host.id = PANEL_ID;
      host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;' +
        'max-width:440px;max-height:60vh;overflow:auto;' +
        'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;' +
        'background:rgba(17,17,17,.94);color:#eaeaea;padding:10px 12px;border-radius:8px;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.45)';
      const root = document.createElement('div');
      host.appendChild(root);
      (document.body || document.documentElement).appendChild(host);
      p = state.panel = { host, root, off: false, timer: null, note: null };
    }
    return p;
  }

  function renderPanel() {
    const p = state.panel;
    if (!p || p.off || !p.root) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => { p.timer = null; paintPanel(); }, 120);   // coalesce bursts
  }

  // Per-client answers for the panel. Mixed results must stay visible: a sweep where one client hits a
  // bot check while another still delivers audio is exactly what a report has to keep apart - the
  // single error code above it must never swallow that.
  function answerFacts(s) {
    const rows = (s.lastError && s.lastError.clientOutcomes) ||
      (s.switch && s.switch.priorClientOutcomes) || [];
    const used = (s.mode === 'active' && s.switch)
      ? s.switch.client + '=audio (itag ' + s.switch.itag + ')' +
        (s.switch.visitorData && s.switch.visitorData.sent ? ' [+visitorData]' : '')
      : null;
    const others = rows.map((a) => a.client + '=' + a.outcome +
      (a.reason ? ' ("' + String(a.reason).slice(0, 80) + '")' : '') +
      (a.retriedWithVisitorData ? ' [+visitorData]' : ''));
    const all = (used ? [used] : []).concat(others);
    return all.length ? all.join(' · ') : 'no answer recorded';
  }

  // The panel row for the last hand-back: what the page was asked, what it answered and whether the
  // user really has a working page again.
  function restoreLine(rs) {
    if (!rs) return 'no hand-back yet';
    if (!rs.ok) {
      return 'FAILED · ' + (rs.method || 'no call to the player') +
        ' · reason ' + (rs.failReason || '?') +
        (rs.playerCall && rs.playerCall.error ? ' (' + rs.playerCall.error + ')' : '') +
        (typeof rs.metaWait === 'string' ? ' · ' + rs.metaWait : '') +
        ' · ' + (rs.startSeconds === null ? 'without startSeconds' : rs.startSeconds + 's') +
        ' · message: ' + restoreFailureCode(rs);
    }
    return rs.method + ' · start ' + (rs.startSeconds === null ? 'without startSeconds (no readable position)'
      : rs.startSeconds + 's from ' + rs.positionSource) +
      ' · ' + (rs.playheadAdvanced ? 'playhead is running again'
        : rs.pauseIntent === 'stay-paused' ? 'deliberately left paused'
        : 'checked without progress') +
      ' · ' + (rs.pageHasSource ? 'the page owns the element' : 'the page has not set its own blob yet');
  }

  function restoreFailureCode(rs) {
    return rs.failure ? rs.failure.code + '/' + (rs.failure.reason || '?') : 'restore-failed';
  }

  // The panel row for the picture: hidden while this mode owns the element, the page's own picture
  // everywhere else - and, when it is shown again, what happened to the element on the way back.
  function pictureLine(p) {
    if (!p) return '-';
    if (p.hidden) {
      return 'hidden (audio-only) since ' +
        (p.hiddenSinceMs === null ? '?' : Math.round(p.hiddenSinceMs / 1000) + ' s') +
        ' · reason ' + p.reason +
        (p.previousInline ? ' · the page had inline "' + p.previousInline + '"'
          : ' · the page had no inline value');
    }
    return 'shown (the page owns the picture)' +
      (p.holdRelease ? ' · hold released: ' + p.holdRelease.message : '') +
      ' · hides ' + p.counters.hides + ' / restores ' + p.counters.restores;
  }

  function panelLines(s) {
    const sw = s.switch;
    const mm = sw && sw.elementMode;
    const pos = s.position;
    return [
      ['Mode', s.mode + (s.verified ? ' · verified (' + s.verifyMethod + ')' : ' · not verified')],
      ['Video', (s.videoId || '-') + ' · generation ' + s.epoch],
      ['Source', sw ? sw.client + ' · itag ' + sw.itag + ' · ' + sw.mime + ' · host ' + sw.urlHost +
        ' · resolved for ' + (sw.videoId || '?') +
        (sw.locked ? ' · LOCKED (no longer applicable: ' + sw.lockReason + ')' : '') : '-'],
      ['Takeover', sw ? sw.applies + 'x · own src writes ' + sw.ownSrcWrites +
        ' · page src writes ' + sw.pageSrcWrites + ' · re-applied ' + sw.reapplyCount : '-'],
      ['Position', !pos ? '-' : pos.skipped ? 'nothing to take (' + pos.reason + ')'
        : 'target ' + pos.target + 's · reached ' + pos.observed + 's · attempts ' + pos.asserts +
          (pos.restored ? ' · restored' : ' · NOT restored') +
          (pos.userIntervened ? ' · user intervened' : '') +
          (pos.late ? ' · corrected late to ' + pos.lateTarget + 's' : '')],
      ['Playback', s.playback ? s.playback.verdict + ' - ' + s.playback.note : '-'],
      ['Hand-back', restoreLine(s.restore)],
      ['Picture', pictureLine(s.picture)],
      ['Element', s.element ? 't=' + s.element.observedTime + 's · paused=' + s.element.paused +
        ' · muted=' + s.element.muted + ' · volume=' + s.element.volume +
        ' · readyState=' + s.element.readyState + ' · videoWidth=' + s.element.observedWidth : '-'],
      ['Media mode', mm ? mm.requestMode + ' / credentials ' + mm.credentialsMode + ' (unchanged)' : '-'],
      ['Answers', answerFacts(s)],
      ['Error', s.lastError ? s.lastError.code + ': ' + s.lastError.message +
        (s.lastError.hint ? ' | ' + s.lastError.hint : '') : 'none'],
      ['Notice', s.warning ? s.warning.message + ' | ' + s.warning.hint : 'none'],
      ['Counters', 'resolutions ' + s.counters.resolves + ' · dropped ' + s.counters.staleDropped +
        ' · track changes ' + s.counters.trackChanges + ' · re-resolved ' + s.counters.reResolves +
        ' · failures ' + s.counters.failures + ' · hand-back failures ' + s.counters.restoreFailures +
        ' · auto re-applied ' + s.counters.autoReapplies +
        ' · watchdog skips ' + s.counters.watchdogSkips +
        ' · picture hidden ' + s.counters.pictureHides + 'x / given back ' + s.counters.pictureShows + 'x' +
        ' · visitorData repeats ' + s.counters.visitorDataRepeats],
      ['Privacy', 'no cookies, no tokens, no telemetry · resolver endpoint (InnerTube POST, ' +
        'credentials omit) · ' + (sw && sw.visitorData && sw.visitorData.sent
          ? 'visitorData only from YouTube\'s own answer, memory only, never logged'
          : 'no visitorData sent')],
      ['Not proven', '"no video bytes" and resource savings were not measured and are not claimed'],
    ];
  }

  function panelButton(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'all:unset;display:inline-block;cursor:pointer;margin:6px 6px 0 0;padding:3px 8px;' +
      'border:1px solid #666;border-radius:5px;background:#2a2a2a;color:#eee;font:inherit';
    b.addEventListener('click', onClick);
    return b;
  }

  async function afterAction(promise) {
    try { await promise; } catch (e) { log('panel:action-error', { name: (e && e.name) || 'Error' }); }
    paintPanel();
  }

  function paintPanel() {
    const p = panelParts(true);
    const s = status();
    const root = p.root;
    root.textContent = '';
    const title = document.createElement('div');
    title.textContent = 'Audio-only for YouTube ' + s.version;
    title.style.cssText = 'font-weight:700;margin-bottom:6px';
    root.appendChild(title);
    panelLines(s).forEach(([k, v]) => {
      const row = document.createElement('div');
      row.style.cssText = 'margin:1px 0';
      const key = document.createElement('span');
      key.textContent = k + ': ';
      key.style.cssText = 'color:#9cdcfe';
      const val = document.createElement('span');
      val.textContent = String(v);
      row.appendChild(key);
      row.appendChild(val);
      root.appendChild(row);
    });
    const on = s.mode === 'active' || s.mode === 'resolving' || s.mode === 'restoring';
    const bar = document.createElement('div');
    bar.appendChild(panelButton(on ? 'Audio-only off' : 'Audio-only on',
      () => { afterAction(on ? disable('panel') : enable('panel')); }));
    bar.appendChild(panelButton('Try again', () => { afterAction(retry()); }));
    bar.appendChild(panelButton('Back to video', () => { afterAction(disable('panel-restore')); }));
    bar.appendChild(panelButton('Copy log', () => { copyLog(); }));
    bar.appendChild(panelButton('Hide', () => { hidePanel(); }));
    root.appendChild(bar);
    if (p.note) {
      const n = document.createElement('div');
      n.textContent = p.note;
      n.style.cssText = 'margin-top:6px;color:#ffd479';
      root.appendChild(n);
    }
  }

  // The copied text goes through redact.stringify: URLs and anything URL-like are replaced, and the
  // values of query parameters were never read out in the first place.
  function copyLog() {
    const p = panelParts(true);
    const text = redact.stringify({ status: status(), events: state.log });
    const fail = () => {
      p.note = 'Copying was not allowed - the log without URLs is in the console (F12)';
      console.log('[audio-only] log (redacted)', text);
      paintPanel();
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => { p.note = 'Log copied (without URLs)'; paintPanel(); }, fail);
        return;
      }
    } catch (e) { /* fall through */ }
    fail();
  }

  function showPanel() {
    const p = panelParts(true);
    p.off = false;
    paintPanel();
    return true;
  }

  function hidePanel() {
    const p = state.panel;
    if (p && p.timer) clearTimeout(p.timer);
    if (p && p.host && p.host.remove) { try { p.host.remove(); } catch (e) { /* ignore */ } }
    state.panel = null;
    return true;
  }

  // ---------------------------------------------- message API for background
  function summarize(result) {
    if (!result) return null;
    const pos = result.position || null;
    return {
      ok: result.ok === true,
      stale: result.stale === true,
      code: result.code || null,
      verified: result.verified === undefined ? null : result.verified === true,
      verdict: result.playback ? result.playback.verdict : null,
      note: result.playback ? result.playback.note : null,
      position: pos ? {
        target: pos.target, observed: pos.observed, asserts: pos.asserts,
        restored: pos.restored, skipped: pos.skipped, late: pos.late,
        userIntervened: pos.userIntervened,
      } : null,
      method: result.method || null,
      restoreReason: result.reason || null,
      argsBridge: result.playerCall ? result.playerCall.argsBridge : null,
      cloneTarget: result.playerCall ? (result.playerCall.cloneTarget || null) : null,
      startSeconds: result.startSeconds === undefined ? null : result.startSeconds,
      positionSource: result.positionSource || null,
      playheadAdvanced: result.playheadAdvanced === undefined ? null : result.playheadAdvanced === true,
      hint: result.hint || null,
      sessionEpoch: state.epoch,
    };
  }

  async function respond(promise, sendResponse) {
    try {
      const result = await promise;
      sendResponse({ ok: true, result: summarize(result), status: status() });
    } catch (e) {
      sendResponse({
        ok: false, error: (e && e.name) || 'Error',
        message: redactText(e && e.message, 160), status: status(),
      });
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return false;
      switch (msg.type) {
        case 'audio-only.ping':
        case 'audio-only.getStatus':
          sendResponse({ ok: true, status: status() });
          return false;
        case 'audio-only.showPanel':
          showPanel();
          sendResponse({ ok: true, status: status() });
          return false;
        case 'audio-only.hidePanel':
          hidePanel();
          sendResponse({ ok: true, status: status() });
          return false;
        case 'audio-only.enable':
          showPanel();
          respond(enable(msg.reason || 'background'), sendResponse);
          return true;
        case 'audio-only.disable':
          showPanel();
          respond(disable(msg.reason || 'background'), sendResponse);
          return true;
        case 'audio-only.toggle':
          showPanel();
          respond(toggle(), sendResponse);
          return true;
        case 'audio-only.retry':
          showPanel();
          respond(retry(), sendResponse);
          return true;
        default:
          sendResponse({ ok: false, error: 'unknown-message:' + msg.type });
          return false;
      }
    });
  }

  // ----------------------------------------------------- double-injection marker
  // The release build has no console test surface. This non-enumerable marker is what the guard at
  // the top of this file reads: a second injection of the same script into the same document (after
  // an add-on reload or an update) must not start a second instance. It lives on the content
  // script's own sandbox window, which page scripts cannot see.
  try {
    Object.defineProperty(window, '__audioOnlyLoaded', {
      value: true, configurable: true, enumerable: false,
    });
  } catch (e) {
    try { window.__audioOnlyLoaded = true; } catch (e2) { /* ignore */ }
  }

  // -------------------------------------------------------------- lifecycle
  function start() {
    log('start', {
      version: VERSION, host: location.host, videoId: currentVideoId(),
      hasPlayer: !!player(), state: elementState(videoEl()),
    });
    watchNavigation();
    notifyBackground();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
