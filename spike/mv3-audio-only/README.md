# MV3 prototype: audio-only in the page's own `<video>` element

**Development source with a test API.** The release build in `extension/` removes that API.
Current runtime: 0.1.3. This repository contains source and offline checks, not signed installation packages.
Purpose: check whether what the console snippet (`spike/console-probe.js`) could show in a live run
works as a real WebExtension – with the **page's own `<video>` element** instead of an extra audio
element.

The evidence comes from the live run in `spike/results.md` **[M-N]**: 35 s of stable audio-only
playback, `videoWidth 0`, `totalVideoFrames 0`, clock drift 0, no source re-take, client VISIONOS.
**Not** proven and **not** claimed here: a byte balance for "no video bytes" and any resource saving –
neither was measured.

**Provenance correction to the live run.** The run in `results.md` (run 1) went through the
**console snippet**, and its resolver repeats the request **once with the `visitorData` that the
server's own answer carried** (`visitorDataSent: true`). That run therefore proves **no** path without
`visitorData`; run 1 does not record the field at all. This prototype claimed the opposite – that was
wrong and is fixed: `content.js` also repeats **exactly once** (the same shape as `console-probe.js`),
and the snippet README and its rules were aligned with that. A comparison of both routes under the same
title is still outstanding (see "Comparison with the console snippet").

## Files

| File | Job |
|---|---|
| `manifest.json` | MV3 manifest. `permissions: []` (in particular **no** `cookies`), `host_permissions` only `https://www.youtube.com/*`, background as `background.scripts` (event page), toolbar button, shortcut `Alt+Shift+A` |
| `background.js` | Only the switch: a click/shortcut toggles the mode in the active YouTube tab, the badge mirrors the status. No network, no cookie, no storage |
| `content.js` | The actual work: resolve a format, take over the page's element, carry over position/pause/volume/mute, detect a track change and hand back through `loadVideoById` (never through an old `blob` URL) |
| `smoke/harness.js` | Offline harness: fake DOM (one `<video>`, `#movie_player`), fake `fetch`, fake `MutationObserver`, `vm` context – loads the **real** `content.js`. New for switching back: the fake player rebuilds a **new** source through `loadVideoById` just like YouTube, the old `blob` URL is **dead** (no `readyState` any more), and a `cloneInto` stub models the context boundary (page code may not read a foreign object) – with both forms of the clone target (`window.wrappedJSObject` present, or refused by `cloneInto`) |
| `smoke/run-smoke.js` | The scenarios s1–s34 (with s15b/s15c/s17b/s19b) and the runner |
| `smoke/run-mutations.js` | The mutation probes of the table below: breaks one copy of the project at exactly one place (in the working folder) and runs the smoke test against it |
| `browser-proof/` | The test bench for real Firefox: `stub-page.html` (a deliberately **bare** page with `#movie_player` and a `<video>`, without its own `apply` implementation – Firefox's own boundary is what is tested there), `probe.js` (injected into the throwaway copy and calls the real internals), `server.js` (serves the page + reports, plus a real 30-s WAV as an audio-only source), `build.js` (builds the variants outside the project), `run.sh` (`web-ext run` in headless mode), `summarize.js` (boundary crossing per variant), `switching.js` (the switch-on/switch-back page of a run). None of it is loaded with the extension: it only runs when started |

## Loading (Firefox, temporary)

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → pick `manifest.json` in
   this folder.
2. Open a YouTube watch page, click the toolbar button or press **Alt+Shift+A**.
3. The small panel at the bottom right is created on the first user action (deliberately simple: text
   and buttons only) and shows mode, format, client, the position and, in the **Answers** row, what
   each client really answered (including a `visitorData` repeat as `[+visitorData]`).

After closing Firefox the extension is gone again (temporary install); a reload of the watch page only
reloads the content script.

## Console caveat

`window.AUDIO_ONLY` lives in the **isolated world** of the content script. The page's normal F12 console
does **not** see it – there `AUDIO_ONLY` stays `undefined`. To look at it in DevTools, switch the context
selector next to the input prompt to the extension's context. The second route is the panel: it shows
mode, format, client, position and the **Answers** per client and has the buttons **Try again**,
**Back to video**, **Copy log**, **Hide** (if the clipboard is not allowed, the log without URLs is
printed to the console). The historical pasted console snippet instead exposes `AUDIO_PROBE` in the page world,
so its console access differs; see `spike/README.md`.

## Message contract content ↔ background

The names are **dot-separated** and only these:

- Content → background: `audio-only.state` with the field `state` (brief status). The background paints
  the badge from it (`ON`, `?`, `...`, `!`, empty). The mode `restore-failed` (hand-back to the page
  failed) deliberately paints **`!`** and not empty – the page is then **not** back to normal (s12).
- Background → content: `audio-only.toggle`. The content answers with `{ok, result, status}`; from that the
  background also paints the badge. A missing receiver (sleeping event page, no content script in the
  tab) is normal and is caught silently.
- Further commands the content understands: `audio-only.ping`, `audio-only.getStatus`,
  `audio-only.enable`, `audio-only.disable`, `audio-only.retry`, `audio-only.showPanel`,
  `audio-only.hidePanel`. Unknown names answer with `unknown-message:<name>`.

**These names used to be mixed up** (the background asked `audio-only:toggle` with a colon and listened
for `audio-only:status` with the field `status`): the click simply did nothing, the badge stayed empty.
Fixed in `background.js`; covered by scenario **s12**.

## Offline smoke test (without network)

```
cd spike/mv3-audio-only
node smoke/run-smoke.js
```

Expected output at the end: `281/281 checks passed`, exit code 0. The test needs no Firefox, no YouTube
and no network: `fetch` is a stand-in that logs every request (`credentials`, `mode`, `videoId`, client,
`signal` and the **client context of the body**, i.e. whether a `visitorData` went along). It loads
`content.js` and `background.js` through `vm` and works against the documented test surface:

- `window.AUDIO_ONLY.status()` (among others `mode`, `verified`, `position.asserts/.restored/.target`,
  `counters`, `switch`, `claims`, `timings`)
- `window.AUDIO_ONLY._timings` to shorten the waiting times
- `window.AUDIO_ONLY._internals` (`applyAudio`, `restoreNormal`, `pickAudio`, …) and
  `window.AUDIO_ONLY.redact` – explicitly **not** a public API, only for `smoke/`.

| Scenario | What it pins down |
|---|---|
| s1 | Switching on keeps position (42.5 s), volume and mute; only **one** request, `credentials: 'omit'` |
| s2 | The page resets its clock to 0 after our jump → the position is asserted again |
| s3 | Fast track change: the answer of the old epoch is dropped, not applied |
| s4 | HTTP error: the element is **not** touched, no `load()`, no `play()`, no second request |
| s5 | Switching off hands the element back to the page – through `loadVideoById` (the page rebuilds its own source), the old `blob` URL is **never** written back, `startSeconds` comes from the element position, the arguments go into the page context as a `cloneInto` clone |
| s6 | If the page takes the source back, there is exactly **one** renewed takeover (no afterglow) |
| s7 | Switching on while paused: position still correct, playback stays paused |
| s8 | `NotAllowedError` is an autoplay refusal → `verified` stays false, its own state |
| s9 | A media error (`MEDIA_ERR_SRC_NOT_SUPPORTED`) restores the page – in both intents (continue playing, or stay paused); a **successful** hand-back does **not** overwrite the switch error |
| s10 | Page without video: clear error code, element untouched, no request |
| s11 | Format choice (video-only itag 137 is ignored, 251 wins) and redaction (no signature, no raw URL in status, panel or log) |
| s12 | Message contract content ↔ background: names, field names and badge painting fit together |
| s13 | There is exactly **one** repeat – with the `visitorData` that the server itself delivered; the value appears in **no** output (status, message to the background, log, panel row) |
| s14 | The repeat is **bounded**: three clients, a single extra attempt, no second one; the three client results stay separate |
| s15 | A bot check (`LOGIN_REQUIRED` + "not a bot") is reported as `bot-check` – **not** as an age gate; the bot suspicion is in the report as a suspicion |
| s15b | A real age gate (`AGE_CHECK_REQUIRED`) keeps its own code `age-restricted` |
| s15c | Mixed sweep: one client is checked-blocked, a later one delivers audio – **both** answers stay in the report, the switch succeeds |
| s16 | Without cause **no** `visitorData` is sent: a single request, no field in the body, status says `sent: false` |
| s17 | The race between track change and watchdog: A runs → change to B detected → YouTube writes its `blob` **before** the navigation timer expires → the watchdog tick runs. Asserts: A's cache is locked (watchdog and observer off), a re-apply of the old track is refused as `stale-track` **without** a generation bump, the old A URL is **never** set a second time, B is resolved and runs, status **and** applied source belong to B, no `track-change:debounced-away` |
| s17b | The check immediately before the application itself: a plan for the abandoned track (current generation, wrong video ID) is refused before the element is touched – no `src` write, no `load()`, no `play()`, no new application on the old record |
| s18 | Switching back **after** a track change: the call names the running video ID (B) and B's position, A's audio URL is **never** set a second time, no `blob` URL is written back, mode `off`, no hand-back error |
| s19 | Player clock unreadable (`getCurrentTime` throws): the position comes from the **element position** of the snapshot – `startSeconds 76.5` instead of 0 |
| s19b | No readable position at all: the call goes out **without** `startSeconds` instead of with 0; the report says so |
| s20 | The call into the page context is refused at the security boundary (a build **without** `cloneInto`, plus an explicit `SecurityError`): its own error code `cross-context-refused`, **no** position, volume or `play()` writes, no waiting for metadata, mode `restore-failed`, panel row **Hand-back** shows `FAILED` with a reason |
| s21 | Switching off **while** the takeover is still running: the late apply is dropped as `stale-plan:…` (no `switch:done`), the page gets its element back, mode `off`, the audio URL was loaded exactly once |
| s22 | Switching off while paused: the hand-back counts as successful **without** a running playhead, the "stay paused" expectation comes from current element state, `play()` is never called, the position stays |
| s23 | A hand-back that cannot succeed becomes visible: (a) the page rebuilds nothing usable → `no-metadata`, (b) it rebuilds, but the playhead stands → `no-progress`; both `mode: restore-failed` with reason, hint and counter, without further writes |
| s24 | The clone target: if the build has a `window.wrappedJSObject`, it is used and reported as `cloneTarget`; if its `cloneInto` only takes the window itself, the second documented route applies (fallback instead of giving up, no hand-back error) |
| s25 | Parameterless calls (`getVideoData`, `getCurrentTime`) pass **no** argument list: with `cloneInto` the (empty) list is cloned, without `cloneInto` the call goes out as `no-args` through `call()` – never an empty list from this world. Plus the log: 30 identical refusals produce **one** entry with `repeats`, only the first is a new line (`logRepeats` counts the counted copies), a different reason is a **second** entry |
| s26 | Current position/pause/volume and original inline visibility survive hand-back |
| s27 | A deliberate seek to zero survives; failed resolution releases the picture |
| s28 | Duplicate disable is serialized; navigation cancels the old hand-back without affecting the next track |
| s29 | Old audio metadata is insufficient; a replacement element receives current position and state |
| s30 | Backward seeking and pause reset stall detection, while a real stall remains visible |
| s31 | Try again resolves a fresh URL at the current position; Hide cancels pending panel paint |
| s32 | Resolver and play-start deadlines return explicit failures without leaving an action pending forever |
| s33 | Resume is verified after progress, and a new track clears verification of the old track |
| s34 | New-track play starts after the first seek but before the correction timer expires; volume/mute are already restored and a rejected early play is not retried |


The scenarios are deliberately **not** on the network: they prove the state machine, nothing about
YouTube. That also holds for s13–s17b: that the repeat happens **once**, that the value shows up nowhere,
how a bot check is interpreted and that a track change overtakes the watchdog is pinned down that way –
**not** that YouTube sends a bot check or that the repeat really delivers a URL there.

The same caveat applies to s18–s25 in a form of its own: the harness **models** the browser security
boundary (the fake `cloneInto` stamps clones, the fake player refuses to read a non-cloned object – an
empty foreign list too, s25) and it **models** the dead old `blob` URL (it never delivers `readyState`).
That pins down that `content.js` clones the arguments, makes parameterless calls **without** a list,
never writes the old `blob` URL back and reports a failed hand-back visibly. It does **not** prove how
Firefox behaves with real Xray wrappers, real `MediaSource` objects and a real YouTube registry – for
that there is now the `browser-proof/` bench and the section "Checking it in the browser (Firefox)".

## What the smoke test does **not** prove

- **No network behavior.** Whether YouTube delivers an audio-only URL, whether it expires, whether a PO
  token becomes necessary, whether the page takes the source back: all of it **[U]** or **[M-N]** from
  `results.md` – nothing about it is stated here. The scenarios check the state machine against a
  stand-in.
- **No real media element.** A 403 on playback, a codec problem or a DRM case looks different in the
  stand-in than in Firefox; that has to be checked in a live run.
- **No byte balance.** The sentence from `results.md` still holds: about the video data transferred, the
  prototype says **nothing** either.
- **No real browser boundary in the harness.** The Xray boundary between content script and page
  context does not exist in Node; the harness only models its **consequence** (page code may not read a
  non-cloned object, `cloneInto` stamps clones). That the same arguments get through in Firefox is
  **not** proven by it – for that there is now the `browser-proof/` bench with a bare page and a real
  Firefox boundary (see "Checking it in the browser (Firefox)"); what stays open there is only the real
  YouTube player.
- **No real `MediaSource`.** That an old `blob` URL really is dead after our `src` write is **modeled**
  in the harness (it never delivers `readyState`), not measured. The live run delivered the symptom; the
  proof in the media panel comes only from the browser step.

### Historical 0.1.0 mutation probes (evidence that the scenarios bite)

For every new guard, a copy of the extension was broken at exactly one place and the smoke test was run
against it (the copies live in a working folder outside the project; **nothing** in the project is
changed). The numbers come from a run at the state of this document (`240/240` unbroken) and can be
reproduced on that old source tree. The current `node smoke/run-mutations.js` uses updated anchors and fails if any probe is undetected; current output is in the 0.1.2 report. An optional probe name selects one case; the runner prints failed scenario names and counts.

| Manipulation | Result |
|---|---|
| Hand an empty list over as a foreign list again (`cloneArgsToPage` fallback to `{ args: [], bridge: 'none' }`) | 235/240 – **s25** fails five times (without `cloneInto` an empty list from this world went out instead of none at all) |
| Write the old `blob` URL back again | 236/240 – **s5** (dead URL loaded), **s9** (the page no longer rebuilds its own source), **s18** (source set twice) and **s20** (our own source was left behind instead of the page's) fail |
| Hand arguments over without cloning | 203/240 – all switch-back scenarios fail at the boundary (`s5` "mode is off", `s9`, `s18`–`s25`), because the page may not read a foreign object |
| No longer classify a refusal as a context refusal | 231/240 – **s20** fails six times (the reason is disguised as `player-call-failed`, no own state, wrong panel row), **s25** three times (the repeat/report paths of the new scenarios) |
| Report success without playhead progress (`state.verified = true`) | 238/240 – **s7** (a paused start counts as verified) and **s8** (an autoplay refusal counts as verified) fail |
| Invent `startSeconds 0` when nothing is readable | 238/240 – **s19b** fails twice (0 instead of "no `startSeconds`") |
| Do not set `restore-failed` (silent `off`) | 236/240 – **s20** and **s23** fail (no visible state, no hint) |
| Offer only the first clone target (no fallback to `window`) | 238/240 – **s24** fails twice (the hand-back fails instead of falling back) |

A note on the pair of rows "arguments without cloning" and "empty list": the live fault consisted of
**two** parts, and both probes hit only one of them. Whoever **has** `cloneInto` could already clone the
empty list before (the live error came from the fallback without `cloneInto`, see below); whoever does
not have `cloneInto` failed earlier on the empty list **and** on the argument object. That is why the
combination "no `cloneInto`" is additionally a browser run of its own (variant `old-no-clone`).

A note on the manipulation "write the old `blob` URL back again", because it mirrors the live fault: in
an earlier run the test run with this manipulation **stopped** in s20 and delivered no report at all –
the broken build therefore hangs not only the user but the run itself. The number above comes from a run
that went through.

## The bug that showed up during testing (and is fixed)

`restoreNormal` read `el.paused` **after** its own `load()`. When a switch failed while the page was
playing, the page ended up "paused": our own side effect was misread as the page's state. Fixed: the
intent is captured **before** the element is touched as `before.paused` and passed through both failure
paths as `opts.playIntent` (`'resume'` / `'stay-paused'`); the result now reports `pauseIntent` and
`pauseIntentSource`. Covered by **s9**.

## The bug that showed up afterwards: race between track change and watchdog

**Symptom.** After a track change, A could keep running while the status already reported B: the watchdog
takeover combined the **new** video ID with the **old** audio URL – and discarded the real change in the
process.

**Sequence (covered exactly like this in s17).** `onPossibleTrackChange()` set `state.videoId` to the new
track and opened a new generation, but left `state.audio` active with the old URL; the actual switch was
delayed by `settleAfterNavMs`. If YouTube writes its own `blob` as `src` in that window, the running
watchdog saw exactly that as "the page took the source back", called `reapply()` – and that bumped
`epoch`. The delayed switch then met a newer generation and was dropped as `track-change:debounced-away`.

**Fixed in four layers** (`content.js`):

1. **Immutable binding.** Every audio record now carries `videoId` – the ID the URL was actually resolved
   for. It is set anew on every application and never reinterpreted afterwards; a re-apply never again
   combines a new ID with an old URL.
2. **Lock instead of delete.** `lockAudioForTrackChange()` locks the old record in the same tick as the
   detected change (`locked`, `lockReason: 'track-change'`), switches off its `src` observer and stops
   the watchdog. The old record is kept for the report (`switch.videoId`, `switch.locked`) but is no
   longer applicable.
3. **No re-apply while resolving.** `watchdogTick()` skips when `mode === 'resolving'` or the cache is
   locked (counter `counters.watchdogSkips`) – and `reapply()` refuses in that case **without** a side
   effect: no generation bump, no abort, `{ skipped: 'stale-track' }` or
   `{ skipped: 'resolve-in-flight' }`. A re-apply of the old track therefore cannot devalue the new
   resolution.
4. **A check immediately before every application.** `applyAudio()` checks video ID **and** generation
   directly before setting `el.src` (and again after metadata, position and playback). If the plan does
   not fit, nothing is touched: no writes, no `play()`, no state change – reported as
   `stale-plan:<place>`.
**More honest along the way:** `restoreNormal()` hands the page's `blob` back only for the record of the
**current** track (`method: 'page-owns-element'` when the page has already taken the element over
itself), and the panel now shows `resolved for <video ID>` in the **Source** row and – if locked –
`LOCKED (no longer applicable: track-change)`. (After the live test more came out of this – see the next
section: the `blob` URL is now **not** written back at all.)

**No extended waiting times.** The test does not wait longer, it establishes the order
(`onPossibleTrackChange` → `writesByPage` → `watchdogTick` → `reapply`) and then checks the state; the
short waiting times of the harness (`settleAfterNavMs 60 ms`, `watchdogMs 40 ms`) stay as in all other
scenarios. Covered by **s17** and **s17b**.

## The bug that showed up live: switching back hangs

**Symptom.** When switching back (mode off / "Back to video") the normal playback did not come back: the
element stalled, and the hand-back still reported success or silently vanished into `off`. On top of that
a console error in the call to the player: `Permission denied to access property "length"`.

**Causes (all five fixed).**

1. **The old `blob` URL was assigned again.** That URL belonged to a `MediaSource` that our own `src`
   write had long since detached. Another `el.src = <old blob>` + `load()` never gets metadata again –
   the element hangs. Now the extension does **not** write the page's source back **at all** (the URL is
   only **recorded**, `switch.originalSrcKind`): **the page** rebuilds a fresh normal playback through
   `loadVideoById` – exactly the route the console snippet proved in the page world
   (`spike/console-probe.js`, `restore()`).
2. **The arguments of the page call were foreign objects.** `target[name].apply(target, args)` handed an
   array and an options object **from the content-script context** to page code. The page's own `apply`
   implementation cannot read `length` on a foreign array (hence the live error), and page code cannot
   read a foreign argument object either. `wrappedJSObject` does not help here – it unwraps only the
   object it is **called on**, not the arguments. Now all values are first reduced to plain data
   (`plainValue`) and cloned into the page world with Firefox's
   **`cloneInto(..., window.wrappedJSObject)`** (the documented route for content scripts, available
   since Firefox 49); if a build does not accept that form, the window itself is offered as a second
   option (`cloneInto(..., window)`), and the report names the form that carried (`cloneTarget`, covered
   in **s24**). If `cloneInto` is missing, there is exactly one second attempt with
   `Function.prototype.apply` from **our** world; if that fails too, that is its own result
   (`cross-context-refused`) instead of a silent failure. `status().pageApi` says which route was really
   used (`argsBridge`, `cloneTarget`, `counts`, last calls). **Parameterless** calls are a fault of their
   own – see "The second live finding" further down.
3. **The position did not come from reality.** The page's snapshot is now captured **before** the element
   is touched (`state.before`: video ID, element position, player clock, pause, volume, mute) and used
   for the hand-back – not the state of the element that we ourselves just changed. If the **player
   clock** is unreadable, the **element position** of the snapshot decides; if no position is readable at
   all, the call goes out **without** `startSeconds`. A **0** is never invented (exactly that had
   previously restarted every such track at 0).
4. **Success was not verified.** The hand-back now counts as successful only when **new video metadata**
   is present **and** – if the page was playing before – the **playhead really runs again** (for "stay
   paused" the proof is the pause itself). If it fails, there is a **visible** state:
   `mode: 'restore-failed'`, `lastError.code: 'restore-failed'` with a reason (`no-metadata`,
   `no-progress`, `play-rejected`, `cross-context-refused`, `no-player-api`, `no-video-id`,
   `player-call-failed`), a hint ("Reload the page (F5)" or "One click on the player"), the counter
   `counters.restoreFailures`, badge **`!`** and the new panel row **Hand-back**. If a switch failed and
   the hand-back works, the switch error stays – it is not overwritten.
5. **Nothing is touched "just in case".** If the call does not touch the page (refusal, no player API),
   **no** position, volume, mute or `play()` is pushed afterwards, and the metadata wait is skipped
   instead of burned. The same rule applies when the page accepts its source but never makes it usable.

Covered by **s18**, **s19**, **s19b**, **s20**, **s21**, **s22**, **s23** and **s24** (s5/s9 were
rewritten for the new route). The tests are sharpened with mutation probes: put the blob write-back back
in, hand arguments over without cloning, hand the empty list over as a foreign list, stop classifying the
refusal, report success without progress, invent `startSeconds 0`, leave out the visible state, leave out
the second clone route – every one of these manipulations makes scenarios fail.

### Checking it in the browser (Firefox): bench run, watch page still open

The Node harness cannot reproduce the Xray boundary (it only models its consequence). For that there is
now the `browser-proof/` bench: `node build.js` builds variants of the extension **outside** the project
(working folder), `./run.sh <variant>` starts a local collector server and Firefox **headless** through
`web-ext run` with the temporary extension on `stub-page.html`. That page is deliberately **bare**: a
`#movie_player` with a `<video>` and methods (`getVideoData`, `getCurrentTime`, `loadVideoById`) that
bring **no `apply` implementation** of their own – so what is tested there is Firefox's own boundary, not
a stand-in. An injected `probe.js` calls the real internals and sends every finding to the server; in
addition the **page itself** reports in its own world which calls it really received and whether it could
read the argument.

Measured on 2026-10-15 with Firefox 158 (headless, macOS), `RUN_SECONDS=45`:

| Run | What it shows | Finding |
|---|---|---|
| `fixed` | the two parameterless calls | `getVideoData`/`getCurrentTime`: `ok: true`, `argsBridge: 'cloneInto'`, `argsCount 0`, `cloneTarget: 'window.wrappedJSObject'`; `loadVideoById` with `[{videoId, startSeconds}]` likewise `ok` – and the **page** confirms `read: {videoId: 'dQw4w9WgXcQ', startSeconds: 3}`, `error: null`. `counts.refused: 0`; the log stays at **one** entry (`start`) although the watchdog asks every second |
| `no-clone` | the same code **without** `cloneInto` | parameterless calls: `ok: true`, `argsBridge: 'no-args'`, `cloneError: 'cloneInto-missing'` – the page body runs, so **no** list crosses the boundary; `loadVideoById` goes out `direct`, is refused and repeated with `own-realm-apply`: content view `ok`, but the page reports `Permission denied to access property "videoId"` – the documented limit of that repetition, confirmed live |
| `old-no-clone` | the old code (empty list as a foreign list) in exactly the situation where the live error occurred | `getVideoData`/`getCurrentTime`: `ok: false`, `error: 'cross-context-refused'`, `refusedBy: 'Error'`, message `Permission denied to access property "length"` – **the same message as live**; the page bodies did not run. 60 identical calls in a row: `logSize` 3 → 3, `logRepeats` 66, **one** entry with `repeats: 63` (plus one with `repeats: 5` from the preceding clock queries) |
| `old-no-clone-nobound` | the same break **without** the counted repetition | the same 60 calls: `logSize` 9 → **69** entries – that is the state that clogs the log |
| `resolver-stub ?full=1` | **switching on and switching back** | Only the InnerTube answer is replaced (`postPlayer` returns a can whose audio URL is a real 30-s WAV from the collector server); everything else is the real code. Switching on: `ok: true`, `mode: 'active'`, **`verified: true`** (`verifyMethod: 'playhead-advanced-after-switch'`, "playhead advanced by 2.506s"), position 3 s asserted (`asserts: 1`), `applies: 1`, `refused: 0`. Switching back: `ok: true`, `method: 'player.loadVideoById'`, `startSeconds: 2.5` (not 0), `pauseIntent: 'resume'`, `argsBridge: 'cloneInto'`, afterwards `mode: 'off'` with a `restore` event and `restoreFailures: 0` |
| `fixed ?full=1` | the same route **without** the can, i.e. with the real network | The request really leaves the browser, and YouTube answers **HTTP 404** for all three clients (`visionos`, `android_vr`, `ios`, each `visitorDataSent: false`); the extension reports `mode: 'error'`, `touched: false`, `counters.applies: 0` and does not touch the page; switching back afterwards `nothing-to-undo`, `mode: 'off'`. That is a **network** finding (classic clients, headless run), not a boundary finding |

What the bench does **not** show: the stub page is not YouTube – no MSE/DASH, no PO token, no real player
registry; and in the `resolver-stub` run exactly the server's answer is replaced. That proves the
boundary crossing, the element behavior, the position assertion, the check at the playhead and the way
back in a real Firefox environment – **not** proven is how the real YouTube player behaves in the
process. For that the manual run stays – and the open point "source loss while `resolving`".

Every run can be repeated like this (writes only into the working folder, never into the project):

```
cd spike/mv3-audio-only/browser-proof
node build.js
RUN_SECONDS=45 ./run.sh fixed                 # the two parameterless calls
RUN_SECONDS=45 ./run.sh old-no-clone          # the live error, reproduced
EXTRA_PREFS='--pref media.autoplay.default=0' RUN_SECONDS=100 ./run.sh resolver-stub '?full=1'
node summarize.js                             # reports side by side
```

**Manual run on a real watch page (historical checklist; owner confirmed 0.1.1 working** – that needs a real track in the real player):

1. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `manifest.json` in
   this folder. Open a watch page, start the video, press **Alt+Shift+A** (mode on).
2. Open DevTools and switch the context selector to the context **of the extension** (the page console
   does not see `AUDIO_ONLY`, see "Console caveat").
3. **Argument passing:** `AUDIO_ONLY._internals.pageCall('getVideoData')` → expect `{ ok: true, value:
   { video_id: '…' }, argsBridge: 'cloneInto', argsCount: 0 }` (without `cloneInto` in the build it
   would be `argsBridge: 'no-args'`; **`none`** no longer exists since the second live fault). Then
   `AUDIO_ONLY._internals.pageCall('loadVideoById', [{ videoId: AUDIO_ONLY.status().videoId, startSeconds: 5 }])`
   → expect `{ ok: true, argsBridge: 'cloneInto', cloneTarget: 'window.wrappedJSObject' }` (the fallback
   would be `cloneTarget: 'window'` – the report names the route that really carried). If instead
   `{ ok: false, error: 'cross-context-refused', … }` comes back, argument passing does not carry in this
   Firefox; on the bare test page that did **not** occur (`counts.refused: 0`), on a real watch page it
   remains to be confirmed.
4. **Switching back:** **Alt+Shift+A** (mode off). The panel row **Hand-back** must show
   `player.loadVideoById · start … · playhead is running again`, "Mode" must be `off` and the video must
   continue normally. If it says `FAILED` with a reason, the mode stays visibly `restore-failed` – then
   the reason is the finding, not the mode.
5. **Look at what the page really did:** in the network/media panel a **new** `blob:` stream must appear
   (not the old `blob` URL), and `AUDIO_ONLY.status().pageApi` must report `counts.cloneInto >= 1`.

## The second live finding: parameterless calls and a clogged log

**Symptom.** In the live log, `page-call:refused` with `Permission denied to access property "length"`
repeated every second: the **parameterless** calls (`getCurrentTime`, `getVideoData`) failed, and the
repetition pushed the actual switch events out of the log (`maxLogEntries: 200`).

**Cause.** Without a usable `cloneInto`, `cloneArgsToPage` fell back to `{ args: [], bridge: 'none' }` –
and **an empty list from this world is a foreign list too**: the page's `apply` implementation reads
`length` on it, and that read access is refused at the boundary exactly like it is for a full list. So a
call with no data at all failed on its (empty) argument list. That is why the error did not occur in
every build: whoever has `cloneInto` could clone the empty list as well.

**Fix (two parts, covered in s25).**

1. A parameterless call passes **no** list at all: `noArgList: true` → `target[name].call(target)`.
   The report names the route honestly as `no-args` instead of pretending a clone, and `cloneError` says
   why (`cloneInto-missing` or the name of the error). The repetition through our own `apply` stays
   unchanged – it is the **exception**, `no-args` the rule.
2. The log counts instead of repeating: `log(event, data, { repeatable: true })` increases `repeats` on
   an identical entry and writes `lastT`; `LOG_REPEAT_KEYS = 32` signatures are watched at the same time,
   `status().logRepeats` reports the counted copies. A **different** reason is a new entry – nothing is
   swallowed, only identical entries are not repeated.

**Evidence.** In the Node harness **s25** (30 identical refusals → **one** entry with a counter, a
different reason → a second entry); as a mutation probe the old `cloneArgsToPage` tail
(`node smoke/run-mutations.js empty-list-tail` → 235/240, **s25** fails five times); in real Firefox the
bench runs `fixed`, `no-clone`, `old-no-clone` and `old-no-clone-nobound` – there the measured
comparison is **3 entries with `repeats`** against **69 entries without**.

**What stays open here:**

- a real YouTube track in the real player (manual run in the section "Checking it in the browser
  (Firefox)"): the stub page proves the boundary, not YouTube.
- "source loss while `resolving`": whether switching on can lose the page's source **while** the
  resolution runs is not investigated. The runs only show: if the resolution fails (`http-404`), the page
  is **not** touched (`touched: false`), and a change after a track change is dropped instead of applied
  (s3, s17/s17b).

## Redaction and security rules (enforced in the code)
- **No cookie access**: no `cookies` permission, no `document.cookie`, no token. Every
  `fetch()` uses `credentials: 'omit'`.
- **`visitorData` – the one exception, clearly bounded**: it is never invented, never read from a cookie
  or account, never logged and never exported. It can come exclusively from the answer to **this POST**
  (`responseContext.visitorData`), stays in the closure, is used for **one** repeat of the same request
  to the same endpoint and appears in the report only as yes/no (`switch.visitorData.sent`, `repeats`,
  `valueRecorded: false`). The panel button **Copy log** still redacts everything URL- and value-like.
- The **media fetch of the element** is not a `fetch()` of this extension: its `crossorigin` value
  decides what the browser sends. It is **recorded** (`mediaMode`) and never changed, never **assumed**
  to be `omit`.
- Status, panel and log **never** contain the raw URL: `urlFacts` stores only host, path and the **names**
  of the query parameters (plus their count) – signature **values** never get in there in the first place
  (s11 checks that). Where a URL does end up in text (log line, panel, error message), `redactText`
  replaces it with `<url:host>`.
- `mode: 'active'` only becomes `verified: true` on a **really advanced playhead**.
- **A URL belongs to exactly one track**: the resolved URL is stored together with the `videoId` it was
  resolved for and is applied only for that one. A track change locks the cache (`switch.locked`,
  `switch.lockReason: 'track-change'`) and switches off its watchdog **and** its `src` observer; a
  re-apply of the old track has no effect afterwards (no generation bump, no abort). The check sits
  immediately before every write to the element and reports `stale-plan:<place>` when video ID or
  generation no longer fit (s17/s17b).
- **The page's source is written back only by the page itself.** The previous `src` is recorded
  (`switch.originalSrcKind`) but never set again: a `blob` URL of a detached `MediaSource` gets no
  metadata any more (s5, s18, s23a).
- **Arguments into the page context are cloned** (`plainValue` + `cloneInto`, otherwise exactly one
  second attempt with this world's `apply`) and **a refusal by the browser boundary is its own result**
  (`cross-context-refused`) – never a silent failure. If a call aborts, no position, volume, mute or
  `play()` is pushed afterwards (s20, s23a).
- **A failed hand-back is visible**: `mode: 'restore-failed'` with reason, hint, counter and badge **`!`**
  – instead of a silent `off` (s20, s23).

## Comparison with the console snippet

The live evidence comes from the snippet. Both resolvers should therefore have the **same** shape – this
section states what is the same, what is deliberately different, and how the same track is compared on
both routes.

### What is the same now

| Point | `spike/console-probe.js` | `content.js` |
|---|---|---|
| Request | `POST /youtubei/v1/player`, `credentials: 'omit'`, the same three client definitions | identical |
| `visitorData` | only from `responseContext` of its **own** answer, in memory, **one** repeat | identical (`MAX_VISITOR_DATA_REPEATS = 1`), never invented, never read, never output |
| When it repeats | when the answer had **no `streamingData`** | when `pickAudio()` found **nothing usable** – so also on `streamingData` without a usable audio format (same bound, same source of the value) |
| Report | `visitorDataSent` / `visitorDataReturned` as yes/no per answer | `switch.visitorData.{sent,repeats,valueRecorded}`, or per answer in **Answers** |
| Error interpretation | by `playabilityStatus.reason`, not only by status code | likewise: `bot-check` ≠ `age-restricted` ≠ `login-required`, results stay separate per client |
| Call to the player | runs **in** the page world: `pl.loadVideoById({ videoId, startSeconds })`, free objects are normal there | comes from the isolated world: first `plainValue`, then `cloneInto` into the page world (first `window.wrappedJSObject`, then `window` – `status()` and `lastError` name as `cloneTarget` what carried), called through `wrappedJSObject`. A refusal by the browser boundary is reported as `cross-context-refused` (the snippet does not know that case) |
| Switching back | `loadVideoById` with the **element position** (`before.time - 0.5`), then `settleMs` and pause/volume/mute | the same route, but with a proven success check (new metadata **and** a running playhead) and with a visible `restore-failed` instead of a silent `off` |

### What stays deliberately different

- **Context.** The snippet runs in the **page world**, the extension in the **isolated world** of the
  content script (resolution) and in the background event page (switch/badge only). A different origin
  means a different origin and CSP chain – that **can** lead to different answers, but it is **not
  proven** as long as the same title has not been measured on both routes. Until then it counts as a
  **possible** cause, not as a result.
- **Scope.** The snippet additionally checks `HEAD`/ranged `GET` and measures playback; the extension
  only shows status and panel – the byte question is still not asked by it.

### Procedure for the comparison (once per track)

Both runs: **the same track** (same `v=` ID), the same signed-in profile, network panel open, extension
loaded temporarily, result **not** written into `spike/results.md` – that log stays the live run of the
snippet and is not rewritten here.

1. Run the snippet: `AUDIO_PROBE.run()`, then copy `AUDIO_PROBE.report()`.
2. Load the extension, open the same track, press **Alt+Shift+A**, read the **Answers** row in the panel.
3. Enter both side by side in the table below – including the cases where nothing was playable.
4. Only then talk about causes: same client first? same HTTP answer? did the repeat happen on both
   routes? Is the difference in the answer or only in playback?

| Field | Snippet | Extension |
|---|---|---|
| Video ID, date | | |
| First client with a usable audio URL | | |
| Client, itag | | |
| `visitorDataSent` / `visitorDataReturned` | | |
| HTTP + `playabilityStatus` of the other clients | | |
| Repeat needed? (yes/no) | | |
| Result (`playing` / error code) | | |
| Deviation between the two routes | | |



- `spike/results.md` – the measurement log (live runs, including the position bug that this prototype
  fixes). **Unchanged**: the provenance correction lives here and in the snippet README, not in the log.
- `spike/README.md` – run sheet and result sheet for the console snippet (also the
  `visitorDataSent`/`visitorDataReturned` column of the matrix).
- `spike/mv3-audio-only/README.md`, section "Comparison with the console snippet" – the comparison table
  for the same track on both routes.
- `spike/console-probe.js` – where the request shape and the client values come from (protocol facts
  only, no third-party code taken over).
