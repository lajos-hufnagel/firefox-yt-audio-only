/*!
 * Audio-only feasibility probe (phase 0) - YouTube/InnerTube, DevTools console only.
 *
 * Purpose : measure whether a non-web InnerTube client returns audio-only URLs that actually
 *           PLAY inside a logged-in YouTube page, and whether a <video>.src hijack keeps the
 *           page player usable (pause / seek / title change / return to video).
 * Not     : an add-on, a build step, a cookie/token reader, a network interceptor, a downloader.
 *
 * Hard rules enforced by this file:
 *   - never logs a signed URL, cookie, token or visitor id (signed URLs are reduced to
 *     host + path + query PARAMETER NAMES); no code path reads document.cookie or the cookie
 *     store, so no cookie VALUE ever enters this closure
 *   - credential scope, stated exactly: every fetch() call in this file passes
 *     credentials: 'omit' (InnerTube POST, HEAD, ranged GET). A media ELEMENT is not a fetch():
 *     <audio>/<video> load by URL and the element's own crossorigin setting decides what the
 *     browser sends. That setting is RECORDED (see mediaFetchMode) and documented separately -
 *     it is never changed here and never assumed to be omit.
 *   - internal state (raw responses, resolved URLs, DOM nodes) stays inside this closure;
 *     the exported object only yields redacted results
 *   - success means playback (data decoded AND the playhead advances), never "a URL exists";
 *     a client that still needs a manual confirmation stays UNCONFIRMED until the playhead
 *     really moves
 *   - only NotAllowedError counts as an autoplay block; any other play() rejection is reported
 *     as its own failure and never promoted
 *   - a src change written by this file is never counted as the page taking the source back
 *   - one audio stream at a time: the hijack stops the probe element first
 *   - restore() returns to the CURRENT video at the CURRENT position, preserving
 *     pause / volume / mute state
 *   - runs only on a *.youtube.com origin
 *
 * Provenance (protocol facts only, no copied code):
 *   yt-dlp (Unlicense), yt_dlp/extractor/youtube/{_base.py,_video.py}, checked 2026-10-15
 *   schdie/we_firefox_ytop_mv3 (GPL-3.0), js/yt.js - read for the VISIONOS request shape
 *     and for the visitorData retry; nothing is copied from it.
 *
 * Usage: see spike/README.md (you run it; Cline never touches your profile).
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ guard
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) {
    console.error('[probe] Refusing to run: needs a *.youtube.com origin (this probe posts to ' +
      '/youtubei/v1/player on the current origin).');
    return;
  }

  const VERSION = '0.1.0-phase0';
  const ENDPOINT = '/youtubei/v1/player?prettyPrint=false';
  const MAX_LOG = 400;

  // Client definitions: clientName/clientVersion/device* from yt-dlp 2026-10-15.
  // pot = yt-dlp's GVS PO-token policy for HTTPS (recorded for interpretation only).
  const CLIENTS = {
    android_vr: {
      id: 28,
      pot: 'HTTPS required=True (yt-dlp _base.py:245-261); ALL formats 403 with 1.65.10 since 2026.08.17 (_base.py:229)',
      client: {
        clientName: 'ANDROID_VR', clientVersion: '1.65.10',
        deviceMake: 'Oculus', deviceModel: 'Quest 3', androidSdkVersion: 32,
        osName: 'Android', osVersion: '12L',
        userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      },
    },
    visionos: {
      id: 101,
      pot: 'no GVS policy declared (yt-dlp _base.py:296-310) -> treated as required=False',
      client: {
        clientName: 'VISIONOS', clientVersion: '1.02',
        deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
        osName: 'visionOS', osVersion: '26.5.23O471',
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      },
    },
    ios: {
      id: 5,
      pot: 'HTTPS required=True (yt-dlp _base.py:279-291); ytop ships clientVersion 21.02.3, yt-dlp 21.26.4',
      client: {
        clientName: 'IOS', clientVersion: '21.26.4',
        deviceMake: 'Apple', deviceModel: 'iPhone16,2',
        osName: 'iPhone', osVersion: '18.3.2.22D82',
        userAgent: 'com.google.ios.youtube/21.26.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)',
      },
    },
  };
  const ORDER = ['android_vr', 'visionos', 'ios'];

  // -------------------------------------------------------------- redaction
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

  // Failure classification. fetch() cannot separate a CORS read-block from an HTTP error,
  // so anything without a readable response is reported as exactly that - no 403 claim.
  const classifyError = (e) => {
    const name = (e && e.name) || 'Error';
    if (name === 'AbortError') return 'abort-or-timeout';
    if (name === 'TypeError') return 'no-http-result (CORS/preflight/network/blocker - NOT an HTTP verdict)';
    return 'js-error:' + name;
  };

  // A refused play() is NOT automatically an autoplay block. Only NotAllowedError means
  // "policy refused"; everything else (unsupported source, aborted load, decoder problem) is a
  // different failure and must be reported as such instead of being promoted as "almost working".
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

  // What a media ELEMENT does with credentials is decided by the element, not by any fetch()
  // option in this file. This probe only RECORDS that setting; it never changes it, never reads
  // a cookie value, and does not measure the request that the element then performs.
  const CROSSORIGIN_MEANS = {
    'no-cors': 'documented element behavior: without a crossorigin attribute the media request is ' +
      'made in no-cors mode with credentials mode include - cookies for that host would be ' +
      'attached if any exist. No CORS read access. Recorded, not changed, not measured here.',
    'cors': 'documented element behavior: with crossorigin="anonymous" the media request is CORS ' +
      'with credentials mode same-origin (no cookies cross-origin). Recorded, not changed.',
    'cors-credentials': 'documented element behavior: with crossorigin="use-credentials" the media ' +
      'request is CORS with credentials mode include. Recorded, not changed.',
  };

  function mediaFetchMode(el) {
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

  // -------------------------------------------------- private state (closure)
  // Never exported: raw responses, resolved URLs (signed), visitorData, DOM nodes.
  const state = {
    visitorData: null,
    log: [],
    responses: {},
    urls: {},
    summary: {},
    sweep: null,
    winner: null,
    range: null,
    audio: null,     // { el, ... } probe <audio> element, internal only
    hijack: null,
    restore: null,
    nav: null,
    navOff: null,
  };

  const log = (event, data) => {
    const entry = { t: new Date().toISOString(), event, data };
    state.log.push(entry);
    if (state.log.length > MAX_LOG) state.log.shift();
    console.debug('[probe]', event, data);
    return entry;
  };

  // --------------------------------------------------------------- DOM utils
  function player() { return document.getElementById('movie_player'); }
  function videoEl() { return document.querySelector('#movie_player video, video.video-stream, video'); }

  function currentVideoId() {
    try {
      const d = player() && player().getVideoData && player().getVideoData();
      if (d && d.video_id) return d.video_id;
    } catch (e) { /* ignore */ }
    try { return new URL(location.href).searchParams.get('v'); } catch (e) { return null; }
  }

  // DOM-based login hint only (no ytcfg, no cookie read).
  function loggedInHint() {
    return !!(document.querySelector('ytd-topbar-menu-button-renderer #avatar-btn, #avatar-btn, ' +
      'yt-img-shadow#avatar img'));
  }

  // Player/element playback state, read right now (not a snapshot taken earlier).
  function playbackState() {
    const pl = player(), el = videoEl();
    return {
      videoId: currentVideoId(),
      time: pl && pl.getCurrentTime ? num(pl.getCurrentTime()) : (el ? num(el.currentTime) : null),
      paused: pl && pl.getPaused ? !!pl.getPaused() : (el ? el.paused : null),
      muted: pl && pl.isMuted ? !!pl.isMuted() : (el ? el.muted : null),
      volume: pl && pl.getVolume ? pl.getVolume() / 100 : (el ? el.volume : null),
      srcKind: el ? kindOf(el.getAttribute('src')) : null,
    };
  }

  function clients() {
    return Object.entries(CLIENTS).map(([key, c]) => ({
      key, id: c.id, clientVersion: c.client.clientVersion, pot: c.pot,
    }));
  }

  function env() {
    const el = videoEl();
    const info = {
      probeVersion: VERSION,
      host: location.hostname,
      pageKind: /\/watch/.test(location.pathname) ? 'watch' : location.pathname,
      loggedInHint: loggedInHint(),
      playback: playbackState(),
      pageMediaElementMode: mediaFetchMode(el),
      credentialsScope: {
        fetchCalls: "credentials: 'omit' (InnerTube POST, HEAD, ranged GET)",
        mediaElements: 'NOT controlled by this file - see pageMediaElementMode; recorded, not changed',
        cookieValuesRead: false,
        loginCheck: 'DOM only (avatar button), no ytcfg, no cookie read',
      },
      playerPresent: !!player(),
      videoElementPresent: !!el,
      browser: navigator.userAgent,
      clients: clients(),
    };
    log('env', info);
    return info;
  }

  // --------------------------------------------------------------- resolver
  async function post(clientKey, videoId, visitorData) {
    const def = CLIENTS[clientKey];
    if (!def) throw new Error('unknown client: ' + clientKey);
    const client = Object.assign({
      hl: (navigator.language || 'en').split('-')[0] || 'en',
      timeZone: 'UTC',
      utcOffsetMinutes: 0,
    }, def.client);
    if (visitorData) client.visitorData = visitorData;

    const body = {
      context: { client },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
    };

    const started = performance.now();
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'omit',            // <-- fetch-level: this call attaches no cookies and reads none.
                                        //     A media ELEMENT is separate - see mediaFetchMode().
        mode: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': String(def.id),
          'X-YouTube-Client-Version': def.client.clientVersion,
        },
        body: JSON.stringify(body),
      });
      const elapsedMs = Math.round(performance.now() - started);
      let json = null, parseError = null;
      try { json = await res.json(); } catch (e) { parseError = (e && e.name) || 'parse-error'; }
      return {
        request: { clientKey, clientId: def.id, clientVersion: def.client.clientVersion,
                   videoId, visitorDataSent: !!visitorData, elapsedMs },
        http: { status: res.status, statusText: res.statusText, ok: res.ok, type: res.type },
        json, parseError,
      };
    } catch (e) {
      return {
        request: { clientKey, clientId: def.id, clientVersion: def.client.clientVersion,
                   videoId, visitorDataSent: !!visitorData,
                   elapsedMs: Math.round(performance.now() - started) },
        http: null,
        json: null,
        requestError: { name: (e && e.name) || 'Error',
                        message: redactText(e && e.message, 160),
                        classification: classifyError(e) },
      };
    }
  }

  function describeFormat(f) {
    const mime = String(f.mimeType || '');
    const hasUrl = typeof f.url === 'string' && f.url.length > 0;
    const facts = hasUrl ? urlFacts(f.url) : null;
    return {
      itag: f.itag === undefined ? null : f.itag,
      mime: mime.split(';')[0] || null,
      kind: mime.startsWith('audio/') ? 'audio' : mime.startsWith('video/') ? 'video' : 'other',
      contentLength: f.contentLength === undefined ? null : Number(f.contentLength),
      bitrate: f.bitrate === undefined ? null : f.bitrate,
      audioQuality: f.audioQuality === undefined ? null : f.audioQuality,
      qualityLabel: f.qualityLabel === undefined ? null : f.qualityLabel,
      url: hasUrl,
      urlParams: facts ? facts.paramNames : [],
      host: facts ? facts.host : null,
      signatureCipher: typeof f.signatureCipher === 'string',
      serverAbrStreamingUrl: typeof f.serverAbrStreamingUrl === 'string',
    };
  }

  function bucket(rows) {
    return {
      count: rows.length,
      withUrl: rows.filter((r) => r.url).length,
      withSignatureCipher: rows.filter((r) => r.signatureCipher).length,
      withNeither: rows.filter((r) => !r.url && !r.signatureCipher).length,
      itags: rows.map((r) => r.itag),
      hosts: [...new Set(rows.map((r) => r.host).filter(Boolean))],
    };
  }

  function summarize(clientKey, r) {
    const json = r.json;
    const sd = json && json.streamingData ? json.streamingData : null;
    const rows = sd && Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats.map(describeFormat) : null;
    const progress = json && Array.isArray(json.adaptiveFormats) ? json.adaptiveFormats.map(describeFormat) : null;
    const s = {
      client: clientKey,
      clientId: r.request.clientId,
      clientVersion: r.request.clientVersion,
      http: r.http ? r.http.status : null,
      httpOk: r.http ? r.http.ok : null,
      httpClass: r.http ? 'http-status' : 'no-http-result',
      requestError: r.requestError || null,
      parseError: r.parseError,
      elapsedMs: r.request.elapsedMs,
      visitorDataSent: r.request.visitorDataSent,
      visitorDataReturned: !!(json && json.responseContext && json.responseContext.visitorData),
      playabilityStatus: json && json.playabilityStatus ? json.playabilityStatus.status : null,
      playabilityReason: json && json.playabilityStatus ? redactText(json.playabilityStatus.reason, 200) : null,
      lengthSeconds: json && json.videoDetails ? Number(json.videoDetails.lengthSeconds) : null,
      isLiveContent: json && json.videoDetails ? !!json.videoDetails.isLiveContent : null,
      streamingDataPresent: !!sd,
      expiresInSeconds: (sd && sd.expiresInSeconds !== undefined)
        ? (Number.isFinite(Number(sd.expiresInSeconds)) ? Number(sd.expiresInSeconds) : null)
        : null,
      hlsManifestUrl: !!(sd && sd.hlsManifestUrl),
      dashManifestUrl: !!(sd && sd.dashManifestUrl),
      serverAbrStreamingUrl: !!(sd && sd.serverAbrStreamingUrl),
    };
    if (rows) {
      s.adaptiveAudio = bucket(rows.filter((x) => x.kind === 'audio'));
      s.adaptiveVideo = bucket(rows.filter((x) => x.kind === 'video'));
    }
    if (progress) s.progressive = bucket(progress);
    return s;
  }

  // Resolved media URLs stay here (closure). Never returned, never logged.
  function storeUrls(clientKey, videoId, json) {
    const out = { videoId, audio: [], video: [], hls: null };
    const sd = json && json.streamingData;
    if (sd) {
      out.hls = typeof sd.hlsManifestUrl === 'string' ? sd.hlsManifestUrl : null;
      for (const f of (sd.adaptiveFormats || [])) {
        const d = describeFormat(f);
        if (!d.url) continue;
        (d.kind === 'audio' ? out.audio : out.video).push({
          itag: d.itag, mime: d.mime, contentLength: d.contentLength, bitrate: d.bitrate, url: f.url,
        });
      }
    }
    state.urls[clientKey] = out;
    return out;
  }

  function urlsFor(clientKey, videoId) {
    const u = state.urls[clientKey];
    if (!u) return null;
    return (!videoId || u.videoId === videoId) ? u : null;
  }

  async function resolve(clientKey, opts = {}) {
    const videoId = opts.videoId || currentVideoId();
    if (!videoId) throw new Error('No videoId - open a watch page first.');
    let r = await post(clientKey, videoId, state.visitorData);
    let retried = false;
    const noStreams = !r.requestError && r.json && !r.json.streamingData;
    if (noStreams && !state.visitorData && r.json.responseContext && r.json.responseContext.visitorData) {
      state.visitorData = r.json.responseContext.visitorData;   // memory only, never logged
      retried = true;
      r = await post(clientKey, videoId, state.visitorData);
    }
    const summary = summarize(clientKey, r);
    summary.retriedWithVisitorData = retried;
    state.responses[clientKey] = r;
    state.summary[clientKey] = summary;
    storeUrls(clientKey, videoId, r.json);
    log('resolve:' + clientKey, summary);
    return summary;
  }

  // --------------------------------------------------- silent playback probe
  // Success criterion: the browser decoded audio data AND the playhead advanced.
  // The element is muted here, so Firefox's autoplay policy normally allows play(). A refused
  // play() counts as an autoplay block ONLY when it is a NotAllowedError; every other rejection
  // gets its own verdict and is never promoted. A verdict that still needs a manual confirmation
  // stays confirmation: 'unconfirmed' until real progress is observed elsewhere.
  function probePlaybackSilent(clientKey, opts = {}) {
    const f = pickAudio(clientKey, opts.itag, opts.videoId);
    if (!f) return Promise.resolve({ client: clientKey, verdict: 'no-direct-url' });
    return new Promise((resolve) => {
      const el = document.createElement('audio');
      el.preload = 'auto';
      el.muted = true;
      el.style.display = 'none';
      document.body.appendChild(el);
      const rec = {
        client: clientKey, itag: f.itag, mime: f.mime, host: urlFacts(f.url).host,
        verdict: null, readyState: null, currentTime: null, error: null,
        events: [], elapsedMs: null, note: null,
        playOutcome: null, playRejection: null, autoplayBlocked: false, failure: null,
        advanced: false, confirmation: 'not-required',
        mediaMode: mediaFetchMode(el),
      };
      let done = false, playStarted = false;
      const started = performance.now();
      const finish = (verdict, note, extra) => {
        if (done) return;
        done = true;
        clearTimeout(guard);
        rec.verdict = verdict;
        if (note) rec.note = note;
        if (extra) Object.assign(rec, extra);
        rec.elapsedMs = Math.round(performance.now() - started);
        rec.readyState = el.readyState;
        rec.currentTime = num(el.currentTime);
        rec.error = el.error ? { code: el.error.code, message: redactText(el.error.message, 120) } : null;
        rec.events = rec.events.slice(-20);
        try { el.pause(); el.removeAttribute('src'); el.load(); } catch (e) { /* ignore */ }
        el.remove();
        resolve(rec);
      };
      const guard = setTimeout(
        () => finish(el.readyState >= 2 ? 'timeout-after-data' : 'timeout-no-data',
          el.readyState >= 2
            ? 'data decoded, but neither playback nor a play() rejection happened before the timeout'
            : 'no usable data before the timeout'),
        opts.probeTimeoutMs || 15000);
      el.addEventListener('error', () => finish('media-error',
        'the element reported a media error - the source was not playable'));
      el.addEventListener('canplay', () => {
        if (playStarted) return;
        playStarted = true;
        rec.events.push('canplay');
        el.play().then(() => {
          rec.events.push('play-resolved');
          rec.playOutcome = 'resolved';
          setTimeout(() => {
            if (el.currentTime > 0.05 && el.readyState >= 2) {
              rec.advanced = true;
              finish('playing');
            } else {
              finish('no-progress', 'play() resolved but the playhead did not advance');
            }
          }, 1500);
        }).catch((e) => {
          const fail = playFailure(e);
          rec.playOutcome = 'rejected:' + fail.name;
          rec.playRejection = fail.name;
          rec.autoplayBlocked = fail.autoplayBlocked;
          rec.failure = fail.classification;
          rec.events.push('play-rejected:' + fail.name);
          if (fail.autoplayBlocked) {
            finish('decodable-silent-blocked',
              'audio data decoded, but the muted play() was refused by the autoplay policy ' +
              '(NotAllowedError) - needs one manual confirmation, and stays UNCONFIRMED until ' +
              'that playback really runs',
              { confirmation: 'unconfirmed' });
          } else {
            finish('play-rejected',
              'audio data decoded, but play() was refused with ' + fail.name + ' (' +
              fail.classification + ') - not an autoplay block, and not proof of a working URL',
              { confirmation: 'not-required' });
          }
        });
      });
      el.src = f.url;
      el.load();
    });
  }

  // ----------------------------------------------------------------- sweep
  // Promotion records HOW a client was promoted, not just that it was. Only real playback is
  // confirmed; decodable-silent-blocked is promoted as PENDING and is upgraded only by evidence
  // (markWinnerConfirmed), never by the verdict name.
  function promote(clientKey, rec) {
    const confirmed = rec.verdict === 'playing';
    state.winner = {
      client: clientKey,
      itag: rec.itag === undefined ? null : rec.itag,
      mime: rec.mime || null,
      host: rec.host || null,
      verdict: rec.verdict || null,
      confirmed,                                   // true only after observed progress
      confirmationPending: !confirmed,
      confirmedAt: null,
      confirmedBy: null,
      at: new Date().toISOString(),
    };
    log('promote', state.winner);
    return state.winner;
  }

  // The ONLY way an unconfirmed promotion becomes confirmed: observed playback progress
  // (probe element, manual playback or a hijack that really advanced).
  function markWinnerConfirmed(evidence, clientKey) {
    const w = state.winner;
    if (!w || w.confirmed) return w;
    if (clientKey && w.client !== clientKey) {
      // Another client played, but a different one is promoted as pending - do not transfer credit.
      log('winner:confirm-mismatch', { winner: w.client, observed: clientKey });
      return w;
    }
    w.confirmed = true;
    w.confirmationPending = false;
    w.confirmedAt = new Date().toISOString();
    w.confirmedBy = evidence;
    log('winner:confirmed', { client: w.client, verifiedBy: evidence });
    return w;
  }

  async function sweep(opts = {}) {
    const order = opts.order || ORDER;
    const rows = [];
    for (const key of order) {
      const summary = await resolve(key, opts);
      const row = Object.assign({}, summary);
      if (summary.adaptiveAudio && summary.adaptiveAudio.withUrl > 0) {
        row.playbackSilent = await probePlaybackSilent(key, opts);
      } else {
        row.playbackSilent = { client: key, verdict: 'no-direct-url' };
      }
      rows.push(row);
      log('sweep:' + key, {
        http: row.http, playabilityStatus: row.playabilityStatus,
        audioWithUrl: row.adaptiveAudio ? row.adaptiveAudio.withUrl : 0,
        verdict: row.playbackSilent.verdict,
      });
      if (row.playbackSilent.verdict === 'playing') {
        if (!state.winner) promote(key, row.playbackSilent);            // confirmed: true
        else if (state.winner.client === key) markWinnerConfirmed('silent probe advanced', key);
        if (opts.stopOnSuccess !== false) break;   // first PLAYING client wins, then stop
      } else if (row.playbackSilent.verdict === 'decodable-silent-blocked') {
        // Deliberate stop, and deliberately UNCONFIRMED: the data decoded and the ONLY refusal was
        // NotAllowedError (autoplay policy). Continuing would answer the wrong question, but this
        // is not evidence of a working URL until the playback is confirmed in step 5.
        if (!state.winner) promote(key, row.playbackSilent);
        row.manualConfirmationRequired = true;
        row.confirmationPending = true;
        break;
      }
      // anything else (no url / media-error / timeout-no-data / timeout-after-data / no-progress /
      // play-rejected) -> try the next client
    }
    state.sweep = rows;
    if (!state.winner) log('sweep:no-winner', { tried: rows.map((r) => r.client) });
    return rows;
  }

  function winner() {
    if (!state.winner) return { winner: null, hint: 'run AUDIO_PROBE.sweep() first' };
    const out = Object.assign({}, state.winner);
    if (!out.confirmed) {
      out.hint = 'promoted but NOT confirmed. It becomes confirmed only when playback really runs: ' +
        'press play on the probe element (step 5) or let a hijack that advances play.';
    }
    return out;
  }

  function pickAudio(clientKey, itag, videoId) {
    const u = urlsFor(clientKey, videoId || currentVideoId());
    if (!u || !u.audio.length) return null;
    if (itag !== undefined && itag !== null) return u.audio.find((f) => f.itag === itag) || null;
    // Highest bitrate first, then largest file: never a silent downgrade.
    // Pass opts.itag to probe one specific format instead.
    const score = (f) => (f.bitrate || 0) * 1e9 + (f.contentLength || 0);
    return u.audio.slice().sort((a, b) => score(b) - score(a))[0];
  }

  // ---------------------------------------------------------------- media
  // Cross-origin check against the signed media URL - SECONDARY evidence only:
  // a failure here says nothing about playability (media playback needs no CORS).
  async function ranged(url, headers, timeoutMs, label) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { credentials: 'omit', mode: 'cors', headers, signal: ac.signal });
      const info = {
        label, outcome: 'http-status', status: res.status, type: res.type,
        contentRange: res.headers.get('content-range'),
        contentLength: res.headers.get('content-length'),
        acceptRanges: res.headers.get('accept-ranges'),
      };
      if (res.body) {
        try { await res.body.cancel(); info.bodyCancelled = true; } catch (e) { info.bodyCancelled = false; }
      }
      return info;
    } catch (e) {
      return { label, outcome: classifyError(e), errorName: (e && e.name) || 'Error',
               errorMessage: redactText(e && e.message, 160) };
    } finally { clearTimeout(timer); }
  }

  async function headOnly(url, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'HEAD', credentials: 'omit', mode: 'cors', signal: ac.signal });
      return { label: 'HEAD (0 body bytes)', outcome: 'http-status', status: res.status, type: res.type,
               contentLength: res.headers.get('content-length'),
               acceptRanges: res.headers.get('accept-ranges') };
    } catch (e) {
      return { label: 'HEAD (0 body bytes)', outcome: classifyError(e), errorName: (e && e.name) || 'Error',
               errorMessage: redactText(e && e.message, 160) };
    } finally { clearTimeout(timer); }
  }

  async function rangeProbe(clientKey, opts = {}) {
    const key = clientKey || (state.winner && state.winner.client);
    if (!key) return { error: 'no client given and none promoted - run AUDIO_PROBE.sweep() first' };
    if (!urlsFor(key, currentVideoId())) await resolve(key, opts);
    const f = pickAudio(key, opts.itag);
    if (!f) return { client: key, error: 'no direct audio URL resolved for this client' };
    const out = { client: key, itag: f.itag, mime: f.mime, url: urlFacts(f.url), attempts: [] };
    out.fetchCredentials = "omit (this is fetch(), not the media element - see the other field)";
    out.probeElementMediaModeDefault = mediaFetchMode(document.createElement('audio'));
    out.attempts.push(await headOnly(f.url, 8000));
    out.attempts.push(await ranged(f.url, { Range: 'bytes=0-1' }, 8000, 'GET + Range: bytes=0-1'));
    out.attempts.push(await ranged(f.url, {}, 8000, 'GET (no Range)'));
    out.interpretation =
      'An outcome of "no-http-result" is NOT a 403: fetch() cannot distinguish a CORS read-block ' +
      'from an HTTP error (PerformanceResourceTiming.responseStatus is 0 when the CORS check ' +
      'fails). Read the real status in the DevTools Network panel. A failure here also does not ' +
      'mean the URL is unplayable - media playback does not need CORS.';
    state.range = out;
    log('rangeProbe:' + key, out);
    return out;
  }

  // ------------------------------------------------------------- DOM panel
  let panel = null;
  function ensurePanel() {
    if (panel && panel.root.isConnected) return panel;
    const root = document.createElement('div');
    root.setAttribute('data-probe-ui', '1');
    root.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#111;color:#eee;' +
      'font:12px/1.4 monospace;padding:8px;border-radius:6px;max-width:360px;box-shadow:0 2px 12px rgba(0,0,0,.5)';
    const title = document.createElement('div');
    title.textContent = 'audio-only probe (phase 0)';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    const note = document.createElement('div');
    note.textContent = 'Press play here if autoplay is blocked, then call AUDIO_PROBE.snapshot().';
    const out = document.createElement('textarea');
    out.readOnly = true;
    out.style.cssText = 'width:340px;height:150px;margin-top:6px';
    const close = document.createElement('button');
    close.textContent = 'remove';
    close.onclick = () => root.remove();
    root.append(title, audio, note, out, close);
    document.body.appendChild(root);
    panel = { root, audio, out };
    return panel;
  }

  function renderReport(text) {
    ensurePanel();
    panel.out.value = text;
    panel.out.focus();
    panel.out.select();
    return text;
  }

  // -------------------------------------------------------- playback probe
  // Returns a redacted record only - the media element itself stays in the closure.
  function audioRec() {
    const a = state.audio;
    if (!a) return null;
    const el = a.el;
    return {
      client: a.client, itag: a.itag, mime: a.mime, host: a.host,
      readyState: el.readyState,
      duration: Number.isFinite(el.duration) ? num(el.duration) : null,
      currentTime: num(el.currentTime),
      paused: el.paused,
      muted: el.muted,
      volume: num(el.volume),
      networkState: el.networkState,
      error: el.error ? { code: el.error.code, message: redactText(el.error.message, 120) } : null,
      playOutcome: a.playOutcome,
      playRejection: a.playRejection || null,
      autoplayBlocked: !!a.autoplayBlocked,
      failure: a.failure || null,
      confirmed: !!a.confirmed,
      confirmedAt: a.confirmedAt || null,
      mediaMode: mediaFetchMode(el),
      events: a.events.slice(-20),
      timeupdateCount: a.timeupdateCount,
      buffered: (() => {
        try {
          return [...Array(el.buffered.length)].map((_, i) => [num(el.buffered.start(i)), num(el.buffered.end(i))]);
        } catch (e) { return null; }
      })(),
    };
  }

  function playbackProbe(clientKey, opts = {}) {
    const key = clientKey || (state.winner && state.winner.client);
    if (!key) throw new Error('no client given and none promoted - run AUDIO_PROBE.sweep() first');
    const f = pickAudio(key, opts.itag);
    if (!f) throw new Error('No direct audio URL for client ' + key +
      ' - run AUDIO_PROBE.rangeProbe("' + key + '") first or try another client.');
    stopAudio();                                   // one audio stream at a time
    const p = ensurePanel();
    const el = p.audio;
    state.audio = {
      el, client: key, itag: f.itag, mime: f.mime, host: urlFacts(f.url).host,
      playOutcome: null, playRejection: null, autoplayBlocked: false, failure: null,
      confirmed: false, confirmedAt: null, events: [], timeupdateCount: 0,
    };
    if (!el.dataset.probeWired) {                  // wire once; the listeners follow state.audio
      el.dataset.probeWired = '1';
      ['loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'pause', 'seeking',
       'seeked', 'waiting', 'stalled', 'ended', 'error'].forEach((name) => {
        el.addEventListener(name, () => state.audio && state.audio.events.push(name));
      });
      el.addEventListener('timeupdate', () => {
        const a = state.audio;
        if (!a) return;
        a.timeupdateCount += 1;
        // A manual confirmation counts ONLY as real progress: not paused, playhead moved.
        // This is what upgrades a decodable-silent-blocked promotion out of 'unconfirmed'.
        if (!a.confirmed && !el.paused && el.currentTime > 0.05) {
          a.confirmed = true;
          a.confirmedAt = new Date().toISOString();
          markWinnerConfirmed('probe <audio> advanced to ' + num(el.currentTime) + 's (manual playback)', a.client);
        }
      });
    }
    el.src = f.url;
    el.load();
    el.play().then(() => {
      if (state.audio) state.audio.playOutcome = 'resolved';
    }).catch((e) => {
      const a = state.audio;
      if (!a) return;
      const fail = playFailure(e);
      a.playOutcome = 'rejected:' + fail.name;
      a.playRejection = fail.name;
      a.autoplayBlocked = fail.autoplayBlocked;
      a.failure = fail.classification;
      log('playbackProbe:play-rejected', {
        client: key, name: fail.name, classification: fail.classification,
        hint: fail.autoplayBlocked
          ? 'autoplay policy (NotAllowedError) - press play in the probe panel; not a URL problem'
          : 'not an autoplay block - read the classification and the element error state',
      });
    });
    log('playbackProbe:' + key, { client: key, itag: f.itag, host: state.audio.host });
    return snapshot();
  }

  function snapshot() {
    return audioRec();
  }

  function seekAudio(seconds) {
    if (!state.audio) return { error: 'no probe audio element - run AUDIO_PROBE.playbackProbe() first' };
    state.audio.el.currentTime = Number(seconds) || 0;
    return snapshot();
  }

  function pauseAudio() {
    if (!state.audio) return { error: 'no probe audio element' };
    state.audio.el.pause();
    return snapshot();
  }

  function resumeAudio() {
    if (!state.audio) return { error: 'no probe audio element' };
    const a = state.audio;
    a.el.play().then(() => { a.playOutcome = 'resolved'; })
      .catch((e) => {
        const fail = playFailure(e);
        a.playOutcome = 'rejected:' + fail.name;
        a.playRejection = fail.name;
        a.autoplayBlocked = fail.autoplayBlocked;
        a.failure = fail.classification;
      });
    return snapshot();
  }

  function stopAudio() {
    const a = state.audio;
    if (a) {
      try { a.el.pause(); a.el.removeAttribute('src'); a.el.load(); } catch (e) { /* ignore */ }
      state.audio = null;
    }
    return { stopped: !!a };
  }

  // ------------------------------------------------------------- hijack
  function quality(el) {
    try { return el.getVideoPlaybackQuality ? el.getVideoPlaybackQuality() : null; } catch (e) { return null; }
  }

  function sample() {
    const h = state.hijack;
    if (!h) return null;
    const el = videoEl() || h.el;                  // the page may have replaced the element
    h.el = el;
    const pl = player();
    const q = quality(el);
    const row = {
      t: Date.now() - h.t0,
      page: pl && pl.getCurrentTime ? num(pl.getCurrentTime()) : null,
      el: num(el.currentTime),
      readyState: el.readyState,
      paused: el.paused,
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      totalVideoFrames: q ? q.totalVideoFrames : null,
      srcKind: kindOf(el.getAttribute('src')),
    };
    h.samples.push(row);
    if (h.samples.length > 240) h.samples.shift();
    return row;
  }

  function destroyHijackWatchers() {
    const h = state.hijack;
    if (!h) return;
    if (h.timer) clearInterval(h.timer);
    if (h.observer) h.observer.disconnect();
    h.timer = null;
    h.observer = null;
    h.active = false;
  }

  // The only question that matters after a source switch: does the playhead really move?
  // Errors, pause and an autoplay refusal stay separate - none of them is "ok".
  async function attemptPlay(el, opts = {}) {
    const rec = {
      playOutcome: null, playRejection: null, failure: null, autoplayBlocked: false,
      verdict: null, note: null, advanced: false, deltaSeconds: null,
      readyState: null, currentTime: null, paused: null, error: null,
      events: [], elapsedMs: null,
      observeMs: opts.verifyMs || 2500,
      minAdvanceSeconds: opts.minAdvanceSeconds || 0.15,
      mediaMode: mediaFetchMode(el),
    };
    const started = performance.now();
    const wired = ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'stalled',
                   'error', 'pause', 'ended', 'emptied', 'timeupdate'];
    const handlers = wired.map((name) => [name, () => { rec.events.push(name); }]);
    handlers.forEach(([name, h]) => el.addEventListener(name, h));
    // Read the clock BEFORE play(): an element may already advance while the play() promise is
    // still pending, and that progress belongs to the same observation window.
    const t0 = num(el.currentTime);
    try {
      await el.play();
      rec.playOutcome = 'resolved';
    } catch (e) {
      const fail = playFailure(e);
      rec.playOutcome = 'rejected:' + fail.name;
      rec.playRejection = fail.name;
      rec.autoplayBlocked = fail.autoplayBlocked;
      rec.failure = fail.classification;
    }
    await delay(rec.observeMs);
    const t1 = num(el.currentTime);
    rec.deltaSeconds = num((t1 === null ? 0 : t1) - (t0 === null ? 0 : t0));
    rec.advanced = !!rec.deltaSeconds && rec.deltaSeconds > rec.minAdvanceSeconds;
    rec.progressEvents = rec.events.filter((e) => e === 'timeupdate').length;
    rec.readyState = el.readyState;
    rec.currentTime = t1;
    rec.paused = el.paused;
    rec.error = el.error ? { code: el.error.code, message: redactText(el.error.message, 120) } : null;
    rec.elapsedMs = Math.round(performance.now() - started);
    rec.events = rec.events.slice(-20);
    handlers.forEach(([name, h]) => el.removeEventListener(name, h));

    // Order matters: a rejected play() leaves the element paused, so the pause state must NOT
    // mask the actual refusal. 'paused' only applies when play() itself was accepted.
    rec.verdict = rec.advanced ? 'playing'
      : rec.error ? 'media-error'
      : rec.autoplayBlocked ? 'blocked-autoplay'
      : rec.playRejection ? 'play-rejected'
      : rec.paused === true ? 'paused'
      : 'no-progress';
    rec.note = rec.verdict === 'playing'
      ? 'the playhead advanced by ' + rec.deltaSeconds + 's - playback verified'
      : rec.verdict === 'blocked-autoplay'
        ? 'play() refused with NotAllowedError (autoplay policy) - not a source problem; click the page once and repeat'
        : rec.verdict === 'media-error'
          ? 'the element reports a media error (code ' + (rec.error ? rec.error.code : '?') + ') - the source was not usable'
          : rec.verdict === 'paused'
            ? 'the element is paused after an accepted play() - playback was NOT verified'
            : rec.verdict === 'play-rejected'
              ? 'play() was refused with ' + rec.playRejection + ' (' + rec.failure + ') - not an autoplay block'
              : 'play() resolved (or was never called) but the playhead did not advance';
    return rec;
  }

  async function hijack(clientKey, opts = {}) {
    const key = clientKey || (state.winner && state.winner.client);
    if (!key) throw new Error('no client given and none promoted - run AUDIO_PROBE.sweep() first');
    const pl = player();
    const el = videoEl();
    if (!pl || !el) throw new Error('No YouTube player/video element - open a watch page.');

    stopAudio();                                   // never two audio streams at once
    destroyHijackWatchers();                       // and never two sample timers

    const videoId = opts.videoId || currentVideoId();
    if (!urlsFor(key, videoId)) await resolve(key, Object.assign({}, opts, { videoId }));
    const f = pickAudio(key, opts.itag, videoId);
    if (!f) throw new Error('client ' + key + ' has no direct audio URL for ' + videoId);

    state.hijack = {
      active: true, client: key, itag: f.itag, el, player: pl, t0: Date.now(),
      assignedKind: kindOf(f.url),                 // what we set; used to detect page reassignment
      assignedSrc: f.url,                          // CLOSURE ONLY: recognises our own src write
      pageMediaMode: mediaFetchMode(el),           // recorded, never changed
      playback: null, verdict: null,
      samples: [], srcChanges: [], ownSrcWrites: 0,
      saved: playbackState(),                      // taken at hijack time, for the report
      observer: new MutationObserver((muts) => {
        const h = state.hijack;
        if (!h) return;
        for (const m of muts) {
          if (m.attributeName !== 'src') continue;
          const raw = el.getAttribute('src');
          // A src change written by THIS file must never look like the page taking the source
          // back. Compared against the exact string we assigned (no timing guesswork).
          const own = raw === h.assignedSrc || el.src === h.assignedSrc;
          h.srcChanges.push({ t: Date.now() - h.t0, newKind: kindOf(raw), own });
          if (own) h.ownSrcWrites += 1;
        }
      }),
    };
    state.hijack.observer.observe(el, { attributes: true, attributeFilter: ['src'] });
    state.hijack.timer = setInterval(sample, 500);
    el.src = f.url;                                // the observer above records this as own: true
    const playback = await attemptPlay(el, opts);   // does the playhead really move now?
    state.hijack.playback = playback;
    state.hijack.verdict = playback.verdict;
    if (playback.verdict === 'playing') {
      markWinnerConfirmed('hijacked page element advanced to ' + playback.currentTime + 's', key);
    } else {
      log('hijack:not-playing', {
        verdict: playback.verdict, note: playback.note, playOutcome: playback.playOutcome,
        autoplayBlocked: playback.autoplayBlocked, paused: playback.paused, error: playback.error,
      });
    }
    log('hijack', { client: key, itag: f.itag, verdict: playback.verdict, saved: state.hijack.saved });
    return { verdict: playback.verdict, playback, firstSample: sample() };
  }

  // Re-resolution for the CURRENT video. Observations from track() are not this.
  // ok is true ONLY when the playhead really advanced after the source switch. Errors, pause and
  // an autoplay block are reported separately and are never collapsed into "ok: true".
  async function rehijack(clientKey, opts = {}) {
    const key = clientKey || (state.winner && state.winner.client) || ORDER[0];
    const out = {
      client: key, videoId: currentVideoId(), steps: [],
      ok: false,                    // nothing but observed progress sets this to true
      verdict: null,                // decisive verdict of the last stage that ran
      blocked: false, paused: false, error: null,
      playback: null, hints: [],
    };
    try {
      const s = await resolve(key, opts);
      out.steps.push({ step: 'resolve', ok: true, http: s.http, playabilityStatus: s.playabilityStatus,
                       expiresInSeconds: s.expiresInSeconds,
                       audioWithUrl: s.adaptiveAudio ? s.adaptiveAudio.withUrl : 0,
                       requestError: s.requestError, retriedWithVisitorData: !!s.retriedWithVisitorData });
    } catch (e) {
      out.steps.push({ step: 'resolve', ok: false, error: (e && e.name) || 'Error',
                       message: redactText(e && e.message, 160) });
      out.verdict = 'resolve-failed';
      out.error = { step: 'resolve', name: (e && e.name) || 'Error',
                    message: redactText(e && e.message, 160) };
      out.hints.push('No new URL was resolved, so the page source was NOT switched.');
      log('rehijack', out);
      return out;
    }
    const rec = await probePlaybackSilent(key, opts);
    out.steps.push({ step: 'probePlaybackSilent', ok: rec.verdict === 'playing',
                     verdict: rec.verdict, note: rec.note || null, readyState: rec.readyState,
                     currentTime: rec.currentTime, error: rec.error,
                     autoplayBlocked: !!rec.autoplayBlocked, playRejection: rec.playRejection || null });
    if (rec.verdict !== 'playing' && rec.verdict !== 'decodable-silent-blocked') {
      out.verdict = 'probe-' + rec.verdict;
      out.hints.push('The fresh element did not play this URL, so the page source was NOT switched - ' +
        'switching a dead URL would only break the page player.');
      log('rehijack', out);
      return out;
    }
    if (rec.verdict === 'decodable-silent-blocked') {
      out.hints.push('The probe decoded, but its play() was refused by the autoplay policy; the ' +
        'switch below can be refused for exactly the same reason.');
    }
    try {
      const h = await hijack(key, opts);
      out.playback = h.playback;
      out.verdict = h.playback.verdict;
      out.blocked = !!h.playback.autoplayBlocked;
      out.paused = h.playback.paused === true;
      out.error = h.playback.error;
      out.steps.push({ step: 'hijack', ok: h.playback.verdict === 'playing', verdict: h.playback.verdict,
                       note: h.playback.note, playback: h.playback, firstSample: h.firstSample,
                       srcKindNow: h.firstSample ? h.firstSample.srcKind : null });
      out.ok = h.playback.verdict === 'playing';         // only real progress, nothing else
      if (!out.ok) {
        out.hints.push('The source WAS switched, but playback is unverified: ' + h.playback.note +
          ' - read .playback and clock(); steps 9/10 still decide.');
      }
    } catch (e) {
      out.steps.push({ step: 'hijack', ok: false, error: (e && e.name) || 'Error',
                       message: redactText(e && e.message, 160) });
      out.verdict = 'hijack-failed';
      out.error = { step: 'hijack', name: (e && e.name) || 'Error',
                    message: redactText(e && e.message, 160) };
      out.hints.push('The switch itself failed - the page element was not (re)pointed at the URL.');
    }
    log('rehijack', { client: out.client, videoId: out.videoId, ok: out.ok, verdict: out.verdict,
                      blocked: out.blocked, paused: out.paused });
    return out;
  }

  function clock() {
    const h = state.hijack;
    if (!h) return { error: 'no hijack active - run AUDIO_PROBE.hijack() first' };
    const now = sample();
    const first = h.samples[0] || now;
    const last = h.samples[h.samples.length - 1] || now;
    const drift = (first.page !== null && last.page !== null && first.el !== null && last.el !== null)
      ? num((last.page - first.page) - (last.el - first.el)) : null;
    // Our own src write is flagged 'own' by the MutationObserver and stays OUT of the
    // page-interference count: pointing the element at our URL is not the page taking it back.
    const ownWrites = h.srcChanges.filter((c) => c.own);
    const pageWrites = h.srcChanges.filter((c) => !c.own);
    const out = {
      client: h.client, itag: h.itag, active: h.active,
      sampleCount: h.samples.length,
      now,
      windowSeconds: first && last ? num((last.t - first.t) / 1000) : null,
      drift: drift,
      videoWidth: last.videoWidth,
      videoHeight: last.videoHeight,
      framesTotal: last.totalVideoFrames,
      pageClock: last.page,
      elClock: last.el,
      playbackVerdict: h.verdict,                  // from the post-switch verification
      playback: h.playback,
      srcReassignedByPage: pageWrites.length > 0,  // only NON-own writes count
      srcChangesByPage: pageWrites.slice(-6),
      ownSrcWrites: ownWrites.length,
      assignedKind: h.assignedKind,
      pageMediaMode: h.pageMediaMode,
      pageMediaModeNow: mediaFetchMode(videoEl()),
      firstSample: first,
    };
    log('clock', { drift: out.drift, videoWidth: out.videoWidth, framesTotal: out.framesTotal,
                   playbackVerdict: out.playbackVerdict,
                   srcChangesByPage: out.srcChangesByPage.length, ownSrcWrites: out.ownSrcWrites });
    return out;
  }

  // -------------------------------------------------------------- restore
  async function restore(opts = {}) {
    const pl = player();
    const el = videoEl();
    if (!pl || !el) return { error: 'No YouTube player/video element' };

    const before = playbackState();                // read NOW, not at hijack time
    const target = {
      videoId: before.videoId,
      startSeconds: before.time === null ? 0 : Math.max(0, before.time - 0.5),
      paused: before.paused,
      muted: before.muted,
      volume: before.volume,
    };
    destroyHijackWatchers();
    stopAudio();

    try {
      if (!target.videoId) throw new Error('no videoId readable');
      pl.loadVideoById({ videoId: target.videoId, startSeconds: target.startSeconds });
      await delay(opts.settleMs || 2500);
      const cur = videoEl();
      if (target.muted !== null && target.muted !== undefined) {
        if (target.muted) { if (pl.mute) pl.mute(); } else if (pl.unMute) pl.unMute();
        cur.muted = !!target.muted;
      }
      if (Number.isFinite(target.volume)) {
        if (pl.setVolume) pl.setVolume(target.volume * 100);
        cur.volume = Math.min(1, Math.max(0, target.volume));
      }
      if (target.paused === true) {
        try { pl.pauseVideo(); } catch (e) { /* ignore */ }
        cur.pause();
      } else if (target.paused === false) {
        try { await cur.play(); } catch (e) {
          log('restore:play-rejected', { name: (e && e.name) || 'Error' });
        }
      }
    } catch (e) {
      state.restore = { target, error: (e && e.name) || 'Error',
                        message: redactText(e && e.message, 160) };
      log('restore:error', state.restore);
      return state.restore;
    }

    const after = playbackState();
    state.restore = {
      target,
      after,
      playerReturned: after.srcKind === 'blob',
      reapplied: { paused: after.paused === target.paused, muted: after.muted === target.muted,
                   volume: after.volume === target.volume },
      hint: after.srcKind === 'blob'
        ? 'ok - the page owns the element again'
        : 'the page did not take the element back; location.reload() is the fallback',
    };
    log('restore', state.restore);
    return state.restore;
  }

  // ----------------------------------------------------------------- track
  // Observation ONLY: watches the SPA. It never resolves, probes or hijacks by itself.
  function track() {
    if (state.navOff) state.navOff();              // re-arm cleanly
    state.nav = {
      armedAt: new Date().toISOString(),
      videoId: currentVideoId(),
      events: [],
      reportedKind: null,
    };
    const record = (type, extra) => {
      if (!state.nav) return;
      const el = videoEl();
      const row = Object.assign({
        t: new Date().toISOString(),
        type,
        videoId: currentVideoId(),
        srcKind: el ? kindOf(el.getAttribute('src')) : null,
      }, extra || {});
      state.nav.events.push(row);
      if (state.nav.events.length > 100) state.nav.events.shift();
      console.debug('[probe] nav', row);
    };
    const onNavFinish = () => {
      if (!state.nav) return;
      const from = state.nav.videoId;
      state.nav.videoId = currentVideoId();
      record('yt-navigate-finish', {
        from,
        note: 'observation only - rehijack() is what resolves a new URL for this video',
      });
    };
    const onNavStart = () => record('yt-navigate-start');
    const observer = new MutationObserver(() => {
      if (!state.nav) return;
      const el = videoEl();
      const kind = el ? kindOf(el.getAttribute('src')) : null;
      if (kind && kind !== state.nav.reportedKind) {
        state.nav.reportedKind = kind;
        record('src-changed');
      }
    });
    document.addEventListener('yt-navigate-finish', onNavFinish, true);
    document.addEventListener('yt-navigate-start', onNavStart, true);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    state.navOff = () => {
      document.removeEventListener('yt-navigate-finish', onNavFinish, true);
      document.removeEventListener('yt-navigate-start', onNavStart, true);
      observer.disconnect();
    };
    log('track:armed', { videoId: state.nav.videoId });
    return {
      armed: true,
      videoId: state.nav.videoId,
      note: 'observation only: records navigation and src changes; call rehijack() to re-resolve',
    };
  }

  function navLog() {
    if (!state.nav) return { error: 'track() is not armed - call AUDIO_PROBE.track() before navigating' };
    const cur = currentVideoId();
    const srcKinds = [...new Set(state.nav.events.map((e) => e.srcKind).filter(Boolean))];
    const assignedKind = state.hijack ? state.hijack.assignedKind : null;
    return {
      armedAt: state.nav.armedAt,
      videoIdAtArm: state.nav.videoId,
      videoIdNow: cur,
      videoChanged: state.nav.videoId !== cur,
      eventCount: state.nav.events.length,
      events: state.nav.events.slice(-25),
      hijackedSrcKind: assignedKind,
      srcKindsSeen: srcKinds,
      pageTookSourceBack: assignedKind ? srcKinds.some((k) => k !== assignedKind) : null,
      ownHijackKindExcluded: !!assignedKind,
      interpretation:
        'This only says WHAT HAPPENED (did the SPA navigate, did the page reassign src). ' +
        'The src kind written by hijack() itself is excluded - only a DIFFERENT kind counts as the ' +
        'page taking the source back. It does not resolve a new URL - that is rehijack().',
    };
  }

  // ----------------------------------------------------------------- report
  function cleanup() {
    destroyHijackWatchers();
    stopAudio();
    if (state.navOff) { state.navOff(); state.navOff = null; }
    if (panel && panel.root) panel.root.remove();
    panel = null;
    log('cleanup');
    return { cleaned: true };
  }

  function report() {
    const redacted = {
      device: {
        probeVersion: VERSION,
        generatedAt: new Date().toISOString(),
        host: location.hostname,
        loggedInHint: loggedInHint(),
        browser: navigator.userAgent,
        credentialScope: {
          fetchCalls: "credentials: 'omit' (InnerTube POST, HEAD, ranged GET)",
          mediaElements: 'a media element is NOT a fetch(): its own crossorigin setting decides ' +
            'what the browser sends. Recorded in mediaMode fields, never changed, never assumed.',
          cookieValuesRead: false,
          loginCheck: 'DOM only (avatar button), no ytcfg, no cookie read',
        },
      },
      clients: clients(),
      sweep: state.sweep ? state.sweep.map((row) => ({
        client: row.client,
        clientId: row.clientId,
        clientVersion: row.clientVersion,
        visitorDataSent: row.visitorDataSent,
        visitorDataReturned: row.visitorDataReturned,
        retriedWithVisitorData: !!row.retriedWithVisitorData,
        http: row.http,
        httpClass: row.httpClass,
        requestError: row.requestError,
        parseError: row.parseError,
        playabilityStatus: row.playabilityStatus,
        playabilityReason: row.playabilityReason,
        lengthSeconds: row.lengthSeconds,
        isLiveContent: row.isLiveContent,
        streamingDataPresent: row.streamingDataPresent,
        expiresInSeconds: row.expiresInSeconds,
        hlsManifestUrl: row.hlsManifestUrl,
        dashManifestUrl: row.dashManifestUrl,
        serverAbrStreamingUrl: row.serverAbrStreamingUrl,
        adaptiveAudio: row.adaptiveAudio || null,
        adaptiveVideoCount: row.adaptiveVideo ? row.adaptiveVideo.count : null,
        progressiveCount: row.progressive ? row.progressive.count : null,
        playbackSilent: row.playbackSilent || null,
        manualConfirmationRequired: !!row.manualConfirmationRequired,
        confirmationPending: !!row.confirmationPending,
      })) : null,
      winner: state.winner,
      rangeProbe: state.range,
      audio: audioRec(),
      hijack: state.hijack ? {
        client: state.hijack.client,
        itag: state.hijack.itag,
        saved: state.hijack.saved,
        verdict: state.hijack.verdict,
        playback: state.hijack.playback,
        pageMediaMode: state.hijack.pageMediaMode,
        clock: clock(),
        srcChangesByPage: state.hijack.srcChanges.filter((c) => !c.own).slice(-10),
        ownSrcWrites: state.hijack.ownSrcWrites,
      } : null,
      restore: state.restore,
      nav: navLog(),
      note: 'No signed URLs, cookies, tokens or visitor ids are included. Query parameter NAMES ' +
            'appear only to document which URL shapes the server returned.',
    };

    const sweepLines = (redacted.sweep || []).map((row) =>
      '  ' + row.client + ' v' + row.clientVersion + ' http=' + row.http +
      ' playability=' + row.playabilityStatus +
      ' audioWithUrl=' + (row.adaptiveAudio ? row.adaptiveAudio.withUrl : 0) + '/' +
      (row.adaptiveAudio ? row.adaptiveAudio.count : 0) +
      ' sigCipher=' + (row.adaptiveAudio ? row.adaptiveAudio.withSignatureCipher : 0) +
      ' itags=' + JSON.stringify(row.adaptiveAudio ? row.adaptiveAudio.itags : []) +
      ' silentPlayback=' + (row.playbackSilent ? row.playbackSilent.verdict : null) +
      (row.playbackSilent && row.playbackSilent.note ? ' (' + row.playbackSilent.note + ')' : '') +
      (row.confirmationPending ? ' [UNCONFIRMED - manual confirmation pending]' : '') +
      (row.requestError ? ' error=' + row.requestError.classification : ''));

    const text = [
      '=== audio-only probe (phase 0) ===',
      'version=' + redacted.device.probeVersion + '  host=' + redacted.device.host +
        '  loggedInHint=' + redacted.device.loggedInHint,
      'generatedAt=' + redacted.device.generatedAt,
      '',
      '--- sweep ---',
      ...(sweepLines.length ? sweepLines : ['  (not run)']),
      '',
      '--- winner ---',
      JSON.stringify(redacted.winner),
      redacted.winner
        ? '  confirmed=' + redacted.winner.confirmed +
          '  confirmationPending=' + redacted.winner.confirmationPending +
          (redacted.winner.confirmedBy ? '  confirmedBy=' + redacted.winner.confirmedBy : '')
        : '  (no winner)',
      '',
      '--- credentials ---',
      '  fetch(): ' + redacted.device.credentialScope.fetchCalls,
      '  media elements: ' + redacted.device.credentialScope.mediaElements,
      '  cookie values read: ' + redacted.device.credentialScope.cookieValuesRead,
      '  page <video> now: ' + JSON.stringify(mediaFetchMode(videoEl())),
      '',
      '--- rangeProbe (secondary evidence only) ---',
      JSON.stringify(redacted.rangeProbe),
      '',
      '--- audio element ---',
      JSON.stringify(redacted.audio),
      '',
      '--- hijack ---',
      JSON.stringify(redacted.hijack),
      '',
      '--- restore ---',
      JSON.stringify(redacted.restore),
      '',
      '--- nav (observation only) ---',
      JSON.stringify(redacted.nav),
      '',
      '--- full JSON ---',
      JSON.stringify(redacted, null, 2),
    ].join('\n');

    log('report', { chars: text.length });
    console.log(text);
    renderReport(text);
    return { text, redacted };
  }

  // ------------------------------------------------------------------- help
  function help() {
    const text = [
      'AUDIO_PROBE ' + VERSION + ' - available commands:',
      '  env()                    environment + current page playback state',
      '  sweep()                  resolve every client in order, silently probe each, promote the first',
      '                           that really PLAYS; decodable-silent-blocked stops the sweep too, but',
      '                           that promotion stays UNCONFIRMED until a real playback is seen',
      '  winner()                 which client got promoted, and whether it is confirmed',
      '  rangeProbe([client])     HEAD + ranged GET - SECONDARY evidence; read the Network panel for status',
      '  playbackProbe([client])  audible <audio> in the small panel; returns a redacted snapshot',
      '  snapshot() seekAudio(s) pauseAudio() resumeAudio() stopAudio()',
      '  hijack([client])         point the PAGE <video> at the audio-only URL, then verify that the',
      '                           playhead really advances (playing / blocked-autoplay / paused /',
      '                           media-error / play-rejected / no-progress)',
      '  clock()                  drift / videoWidth / frames / page src writes (own writes excluded)',
      '  rehijack([client])       re-resolve + probe + hijack; ok=true only if playback was verified',
      '  track() / navLog()       OBSERVATION ONLY: did the SPA navigate, did the page take src back',
      '  restore()                return to the current video at the current position, state reapplied',
      '  report()                 redacted text + JSON (safe to copy out)',
      '  cleanup()                stop watchers and remove the small panel',
      '',
      'Credentials: fetch() calls use credentials: "omit" (InnerTube POST, HEAD, ranged GET). Media',
      'elements are not fetch() - their own crossorigin setting is only RECORDED (mediaMode fields).',
      'Never returned by any command: signed URLs, cookies, tokens, visitor ids, DOM nodes.',
      'Full run sheet: spike/README.md',
    ].join('\n');
    console.log(text);
    return text;
  }

  const api = {
    version: VERSION,
    env, sweep, winner, rangeProbe, playbackProbe, snapshot,
    seekAudio, pauseAudio, resumeAudio, stopAudio,
    hijack, clock, rehijack, restore, track, navLog, report, cleanup, help,
  };
  globalThis.AUDIO_PROBE = api;
  log('ready', {
    version: VERSION, endpoint: ENDPOINT, order: ORDER,
    host: location.hostname, page: location.pathname + location.search.replace(/\?v=.*/, '?v=<id>'),
  });
  console.info('[probe] ready - run AUDIO_PROBE.help() for the command list.');
  return api;
})();
