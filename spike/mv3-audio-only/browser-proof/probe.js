// Proof probe - part of the proof stand in this folder. It is injected into the throw-away extension copy
// next to content.js (see build.js) and never into the project's own manifest.
//
// It runs in the same isolated world as content.js (same extension, so the same sandbox) and calls the
// real internals against the real stub page. Everything it learns is POSTed to the local collector, so
// the result does not depend on web-ext streaming content-script console output.
(function () {
  var PORT = 8791;
  var VIDEO = 'dQw4w9WgXcQ';

  function post(phase, data) {
    var body = JSON.stringify({ phase: phase, data: data, t: Date.now() });
    try {
      return fetch('http://127.0.0.1:' + PORT + '/report', {
        method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: body,
      }).catch(function () {});
    } catch (e) {
      try { navigator.sendBeacon('http://127.0.0.1:' + PORT + '/report', body); } catch (e2) { /* gone */ }
      return Promise.resolve();
    }
  }
  function later(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function api() { return window.AUDIO_ONLY; }
  function cloneIntoFacts() {
    try { return typeof window.cloneInto; } catch (e) { return 'denied:' + e.name; }
  }
  // Everything is flattened to primitives: a page-realm object must not survive into JSON.stringify.
  function summarize(r) {
    var out = {};
    if (!r || typeof r !== 'object') return { odd: String(r) };
    ['ok', 'argsBridge', 'argsCount', 'cloneTarget', 'cloneError', 'error', 'refusedBy', 'retried',
      'threw', 'message'].forEach(function (k) { if (r[k] !== undefined) out[k] = String(r[k]); });
    out.valueType = typeof r.value;
    if (r.value && typeof r.value === 'object') {
      try { out.value = { videoId: String(r.value.video_id), title: String(r.value.title) }; }
      catch (e) { out.valueReadError = e.name + ': ' + e.message; }
    } else if (r.value !== undefined) { out.value = r.value; }
    return out;
  }
  function call(name, args) {
    try { return summarize(api()._internals.pageCall(name, args)); }
    catch (e) { return { threw: (e && e.name) + ': ' + (e && e.message) }; }
  }
  function brief(s) {
    var e = s.element || {};
    return {
      mode: s.mode, verified: s.verified, verifyMethod: s.verifyMethod, videoId: s.videoId, epoch: s.epoch,
      pageApiCounts: s.pageApi.counts, pageApiCalls: s.pageApi.calls.map(function (c) {
        return { name: c.name, ok: c.ok, argsBridge: c.argsBridge, argsCount: c.argsCount,
                 cloneError: c.cloneError, error: c.error, message: c.message };
      }),
      position: s.position, applied: s.applied, restore: s.restore, switch: s.switch,
      logSize: s.logSize, logRepeats: s.logRepeats, lastError: s.lastError, warning: s.warning,
      counters: s.counters,
      srcKind: e.srcKind, mediaMode: e.mediaMode, readyState: e.readyState,
      paused: e.paused, time: e.time, events: s.events.slice(-12),
    };
  }
  function round(label) {
    return {
      label: label, cloneInto: cloneIntoFacts(), wrappedJSObjectType: typeof window.wrappedJSObject,
      getVideoData: call('getVideoData'),
      getCurrentTime: call('getCurrentTime'),
      loadVideoById: call('loadVideoById', [{ videoId: VIDEO, startSeconds: 3 }]),
      status: brief(api().status()),
    };
  }
  function safeStringify(x) {
    try { return JSON.parse(JSON.stringify(x, function (k, v) { return typeof v === 'function' ? undefined : v; })); }
    catch (e) { return { unserializable: e.name + ': ' + e.message, keys: x && typeof x === 'object' ? Object.keys(x) : null }; }
  }

  (async function main() {
    var i;
    for (i = 0; i < 60; i++) {
      if (api() && document.getElementById('movie_player')) break;
      await later(100);
    }
    if (!api()) { post('probe', { fatal: 'no AUDIO_ONLY in this sandbox' }); return; }
    post('probe', { started: true, version: api().VERSION, cloneInto: cloneIntoFacts(),
                    playerFound: !!document.getElementById('movie_player'), url: location.href });
    await later(500);

    // Round 1: the real page call path, with cloneInto available (the normal Firefox situation).
    post('round', round('with-cloneInto'));

    // Round 2: the same calls without cloneInto, which must fall back to "no list at all".
    var deleted = false, deleteError = null;
    try { delete window.cloneInto; deleted = (typeof window.cloneInto === 'undefined'); }
    catch (e) { deleteError = e.name + ': ' + e.message; }
    await later(200);
    post('round', round('after-delete-cloneInto'));
    post('probe', { cloneIntoDeleted: deleted, deleteError: deleteError, cloneInto: cloneIntoFacts() });

    // Round 3: 60 identical parameterless calls in a row - the log must stay small, the copies counted.
    var before = api().status();
    for (i = 0; i < 60; i++) api()._internals.pageCall('getCurrentTime');
    var after = api().status();
    post('flood', {
      calls: 60, logSizeBefore: before.logSize, logSize: after.logSize, logRepeats: after.logRepeats,
      counts: after.pageApi.counts, refusedEntries: after.events.filter(function (e) {
        return e.event === 'page-call:refused';
      }).map(function (e) { return { repeats: e.repeats || 1, message: e.data && e.data.message,
                                     name2: e.data && e.data.name2 }; }).slice(-3),
      tail: after.events.slice(-3).map(function (e) { return { event: e.event, repeats: e.repeats || 1 }; }),
    });

    // Round 4 (only with ?full=1): the switching itself, on this stub page. The page must be PLAYING
    // before the switch - a paused page has nothing to carry over and no progress to verify - so wait for
    // the page's own playback first (muted autoplay, so no gesture is needed).
    if (/full=1/.test(location.search)) {
      var env = api()._internals.elementState(document.getElementById('probe-video'));
      for (i = 0; i < 150; i++) {
        env = api()._internals.elementState(document.getElementById('probe-video'));
        if (env && env.paused === false && env.time > 1) break;
        await later(100);
      }
      post('page-state', env);
      var en = null, dis = null;
      try { en = safeStringify(await api().enable('probe')); } catch (e) { en = { threw: String(e) }; }
      post('enable', { result: en, status: brief(api().status()) });
      await later(500);
      try { dis = safeStringify(await api().disable('probe')); } catch (e) { dis = { threw: String(e) }; }
      post('disable', { result: dis, status: brief(api().status()) });
    }
    await later(200);
    post('done', { rounds: 4 });
  })();
})();
