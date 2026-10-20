> Historical console feasibility probe. For the current add-on, start with `README.md` at the project
> root and `docs/release/0.1.2.md`. This probe is not shipped in the release archive.

# Spike: feasibility test for audio-only (phase 0)

A console snippet, not an add-on, no build. It answers exactly one set of questions:
**Does a non-web InnerTube client deliver audio-only URLs in your signed-in YouTube session
(resolution via `fetch` with `credentials: 'omit'`), do those URLs really play in a media element, and
does the page player stay usable through a `<video>.src` takeover
(pause / seek / track change / return to the video)?**

On the reach of `omit`: it applies to **the `fetch` calls of this snippet**
(InnerTube POST, `HEAD`, ranged `GET`). **Playback** runs through `<audio>`/`<video>` elements, and a
media element is not a `fetch`: what it sends is decided by its own `crossorigin` setting. The test
**records** that setting (`mediaMode` fields) and documents it separately – it does not change it, does
not assume it to be `omit`, and reads no cookie values.

You run it. Cline does not touch your profile.

## Non-goals

- no extension/MV3 build, no `webRequest`/StreamFilter, no byte balance
- **no** claim "without `visitorData`": the resolver repeats a request when the answer carried no audio
  URL but a `visitorData` from the server – see `visitorDataSent` in the matrix.
  What it never does: invent a `visitorData`, read one from a cookie or account, repeat more than once,
  or output the value
- no access to cookie values, tokens or `ytcfg` (not even read-only); `omit` applies only to the
  snippet's own `fetch` calls – see the credential table below
- **no automatic fallback** to lower video quality and no HLS player
- no login automation; no Premium, members-only, age-restricted or live videos;
  `music.youtube.com` out of scope

## Credentials: what `omit` covers – and what it does not

| Request | triggered by | Credentials |
|---|---|---|
| `POST /youtubei/v1/player` | this test (`fetch`) | `omit` |
| `HEAD` + ranged `GET` on the media URL | this test (`fetch`) | `omit` |
| Loading the audio URL in the test element | the browser (element) | not a `fetch`: without `crossorigin` mode `no-cors`, credentials mode `include` – cookies for this host would be sent along if any exist; no CORS read access |
| Playback in the page `<video>` | the page | as above, but with the `crossorigin` setting that YouTube itself applies – only recorded (`clock().pageMediaMode`) |

The media element rows are **documented browser behavior**, not a measurement: what is measured is only
the setting itself (attribute present? which value?). Possible are
`no-cors`/`include` (no attribute), `cors`/`same-origin` (`crossorigin` or `="anonymous"`) and
`cors`/`include` (`crossorigin="use-credentials"`). The test never sets these attributes.

## Prerequisites

- Firefox 158 (checked 2026-10-15), a normal **signed-in** profile, a watch page open and
  **played once** (so the media element has user activation)
- the DevTools console in multiline mode; if Firefox asks for `allow pasting`, type it once
- the **network panel** open alongside: only there is a real HTTP status visible (see error
  interpretation)
- pick a short, public, not age-restricted video (2–5 minutes)

## Security and redaction rules (enforced in the code)

- signed URLs, cookies, tokens and internal identifiers are never logged or exported; signed URLs are
  reduced to `host + path + names of the query parameters`. **Exception, clearly bounded:** a
  `visitorData` that **the server's own answer** brings along (`responseContext.visitorData`) may be
  **sent back** – exactly once, only to the same endpoint, only from memory. What is reported about it
  is only the flag (`visitorDataSent` / `visitorDataReturned`), never the value.
- internal data (`state`, raw answers, resolved URLs, DOM nodes) stay in the closure;
  `AUDIO_PROBE` returns only redacted results
- the network panel still shows the signed URL of your own session – that is the browser UI, not test
  output; close the panel afterwards if you like
- for feedback, pass on **only** the text from `AUDIO_PROBE.report()`

## What counts as success

**Not** "the answer contains a direct audio URL", but: the media element has decoded audio data
(`canplay`, `readyState >= 2`) **and** the playhead has advanced (`currentTime > 0`). Only that
promotes a client.

During the sweep a **muted** test element runs (`el.muted = true`, no sound). A few hundred KB of
**audio** are loaded for that; the goal is 0 **video** bytes, not 0 bytes.

Exception, built that way on purpose: when the data decodes **and** the silent `play()` is refused
exclusively with `NotAllowedError` (autoplay policy), the verdict is `decodable-silent-blocked`. The
client is promoted – but as **unconfirmed** (`confirmed: false`, `confirmationPending: true`) and the
sweep is **stopped**; testing on would answer the wrong question.

## Verdicts: what means what

| Verdict | Meaning | promoted? |
|---|---|---|
| `playing` | data decoded **and** playhead advanced | yes, **confirmed** |
| `decodable-silent-blocked` | data decoded, `play()` refused only with `NotAllowedError` (autoplay policy) | yes, but **unconfirmed** |
| `play-rejected` | `play()` refused with an **other** error (`NotSupportedError`, `AbortError`, …) | no |
| `media-error` | the element reports a media error (`error.code`) | no |
| `no-progress` | `play()` accepted, the playhead does not move | no |
| `timeout-no-data` / `timeout-after-data` | no usable data within the time window | no |
| `no-direct-url` | no direct URL for this client in the answer | no |
| Hijack/rehijack: `playing` | the playhead really advanced after the source change | yes (`rehijack().ok = true`) |
| Hijack/rehijack: `blocked-autoplay`, `paused`, `play-rejected`, `media-error`, `no-progress` | hand-over **not** verified – each its own class | no |
| Rehijack: `resolve-failed`, `probe-*`, `hijack-failed` | a stage failed; the page source was **not** touched | no |

- **Only `NotAllowedError` is an autoplay block.** Every other `play()` error is reported as its own
  class and is never treated as "almost works".
- **Unconfirmed stays unconfirmed.** Only real progress confirms: `timeupdate` on a non-paused element
  in step 5, or a hijack check with an advancing playhead. The verdict name alone confirms nothing;
  until then the report says `[UNCONFIRMED - manual confirmation pending]` (fields:
  `confirmation: 'unconfirmed'`, `confirmationPending: true`, `manualConfirmationRequired: true`).
- **After the source change it is verified.** `hijack()` verifies itself (`verdict`, `playback`:
  `advanced`, `deltaSeconds`, `paused`, `autoplayBlocked`, `error`) – it does not return a blanket
  `ok`. `rehijack()` is `ok: true` only when exactly that check saw progress; errors, pause and
  autoplay block are listed separately in `blocked` / `paused` / `error` / `verdict`.
- **Our own `src` assignment does not count as the page interfering.** The MutationObserver marks it
  with `own: true`; `clock().srcReassignedByPage` only becomes `true` when the page sets a different
  source (`srcChangesByPage`, `ownSrcWrites`).

**Always at most one audio stream.** Never run `playbackProbe()` and `hijack()` at the same time.
`hijack()` does stop the test element itself (`stopAudio()` as its first step), but the intended path
is: first `stopAudio()` (step 7), then `hijack()` (step 8). While a hijack is active, do not start a
new `playbackProbe()`.

**Itag choice.** The test takes the **highest** offered audio bitrate (on a tie, the largest file) – so
no silent quality fallback downwards. A specific itag can be forced:

```js
AUDIO_PROBE.playbackProbe('android_vr', { itag: 251 });
AUDIO_PROBE.sweep({ itag: 251 });
AUDIO_PROBE.hijack('android_vr', { itag: 251 });
```

The verification windows are preset and recorded in the report: `hijack()`/`rehijack()` observe for
2.5 s after the source change (`{ verifyMs: 2500 }`); the silent check waits 1.5 s for progress after
an accepted `play()` and gives up at `probeTimeoutMs` (default 15000) at the latest.

## Run sheet

| # | Command | What to record |
|---|---|---|
| 0 | paste `spike/console-probe.js` into the console | the line `[probe] ready` |
| 1 | `AUDIO_PROBE.env()` | `playback.videoId`, `loggedInHint`, `playback.srcKind` (expect `blob`), `playback.{paused,muted,volume}`, **`pageMediaElementMode`** (credential setting of the page element) |
| 2 | `AUDIO_PROBE.sweep()` | per client: `http`, `playabilityStatus`, `adaptiveAudio.{withUrl,withSignatureCipher,withNeither}`, itags, **`playbackSilent.verdict`**, `autoplayBlocked`, `confirmation` |
| 3 | optional: `AUDIO_PROBE.sweep({stopOnSuccess:false})` | the same line for **all** clients (the default is: stop after the first promotion; `decodable-silent-blocked` always stops the sweep) |
| 4 | `AUDIO_PROBE.rangeProbe()` | the three attempts **and** the status code in the network panel |
| 5 | `AUDIO_PROBE.playbackProbe()` → if autoplay is blocked, press "play" in the panel → `AUDIO_PROBE.snapshot()` | `readyState`, `duration`, `error.code`, `buffered`, `playOutcome`, `playRejection`, **`confirmed`**; only real progress sets `confirmed: true` |
| 6 | listen + `AUDIO_PROBE.pauseAudio()`, `AUDIO_PROBE.seekAudio(30)`, `AUDIO_PROBE.snapshot()` | audible start? pause? seek? |
| 7 | `AUDIO_PROBE.stopAudio()` | the test element is stopped (no second audio stream any more) |
| 8 | `AUDIO_PROBE.hijack()` | **`verdict`** + `playback.{advanced,deltaSeconds,readyState,currentTime,paused,autoplayBlocked,error}` + `firstSample` (`videoWidth`, `totalVideoFrames`, `srcKind`, `saved.{paused,muted,volume,time,videoId}`) |
| 9 | let it run ~15 s: `AUDIO_PROBE.clock()` | `drift`, `playbackVerdict`, `videoWidth`, `framesTotal`, `srcReassignedByPage`, `srcChangesByPage`, `ownSrcWrites` |
| 10 | pause (bar and space bar), seek ±30 s, `AUDIO_PROBE.clock()` | do both work? does the slider move? |
| 11a | activate `AUDIO_PROBE.track()` **beforehand**, then switch the video by clicking → `AUDIO_PROBE.navLog()` | **observation only**: new `videoId`, did the page replace the `src` itself (`srcKind`)? |
| 11b | afterwards `AUDIO_PROBE.rehijack()` | **re-resolution**: `ok` (only on verified playback), `verdict`, `blocked`, `paused`, `error`, `hints`, `step`/`ok` per stage, `expiresInSeconds` |
| 12 | `AUDIO_PROBE.restore()` | `target.{videoId,startSeconds}` = **current** video/position, `after.srcKind` = `blob`, `reapplied.{paused,muted,volume}` |
| 13 | `AUDIO_PROBE.report()` → copy the text from the panel | the report you send back |
| 14 | `AUDIO_PROBE.cleanup()` | the panel is gone |

Time budget: ~15 minutes per client. After the first promotion, continue with 4–13 for exactly that
client.

**Important – observing is not re-resolving:** `track()`/`navLog()` only log that the SPA navigated and
whether the page took its own `src` back. A new URL for the new video is fetched exclusively by
`rehijack()`. In the result sheet those are two separate rows.

**Signed-out comparison (arm A)** is **not** part of the standard run and has no fixed expectation
about the number of direct URLs. Add it only when an error cannot be attributed otherwise (for example
to rule out "this video/network is broken for everyone") – and then in a **separate** Firefox profile,
never by signing out of the main profile.

## Error interpretation (separate the causes)

| Symptom | Meaning |
|---|---|
| `resolve` throws `TypeError` (`no-http-result`) on a **same-origin** request | network/offline/blocker – a CORS problem is impossible here. No HTTP judgement. |
| `http: 400/403/410` with a readable body | a real HTTP judgement; note the status and `playabilityStatus.reason` |
| `playabilityStatus` = `ERROR`/`UNPLAYABLE`/`LOGIN_REQUIRED`, no `streamingData` | request accepted, content refused (or POT/DRM gate); compare clients |
| `adaptiveAudio.withUrl = 0`, everything `withSignatureCipher` | resolution would need the JS signature/challenge route – outside this phase |
| `rangeProbe` says `no-http-result`, but `playbackProbe` plays | a CORS read block, **not** a dead URL |
| `rangeProbe` `no-http-result` **and** element `error.code = 4` | URL very likely refused – confirm the status in the network panel |
| `playbackSilent.verdict = media-error` / `timeout-no-data` / `timeout-after-data` | not playable → check the next client |
| `playbackSilent.verdict = decodable-silent-blocked` | data decoded, `play()` refused **only** with `NotAllowedError` (autoplay policy) → promoted unconfirmed, sweep stopped, confirmation in step 5 |
| `play()` refused with `NotAllowedError` | autoplay policy, not a URL problem – press "play" in the panel |
| `playbackSilent.verdict = play-rejected` with `failure = media-not-supported` / `aborted-before-playback` | data decoded, but `play()` failed for a reason other than the autoplay policy → **not** promoted, next client |
| `playbackSilent.verdict = no-progress` | `play()` accepted, the playhead does not move → **not** promoted |
| `hijack().verdict = blocked-autoplay` | the `play()` of the page `<video>` was refused by the policy – click the page once, repeat `hijack()` |
| `hijack().verdict = no-progress` / `paused` | playback after the source change **not** verified – check `clock()`, measure again if needed |
| `hijack().verdict = play-rejected` / `media-error` | source not usable for the page element – note `playback.error.code` (4 = `MEDIA_ERR_SRC_NOT_SUPPORTED`) |
| `rehijack().ok = false`, `verdict = probe-*` | the fresh URL did not play in the test element → the page source was deliberately **not** touched |
| `rehijack().ok = false`, `verdict = resolve-failed` | no URL was resolved for the new video → nothing was switched |
| `clock().srcReassignedByPage = true` with `ownSrcWrites >= 1` | the page set a different source **after** our assignment; our own assignment is exempt from that |
| `videoWidth > 0` after the hijack | a video stream was chosen; check again with an explicit audio itag |
| after `restore()` `after.srcKind != blob` | the page keeps delivering our source; `location.reload()` as a fallback |

`fetch()` cannot tell CORS and `403` apart: `PerformanceResourceTiming.responseStatus` is `0` when the
CORS check fails, and it needs `Access-Control-Allow-Origin` for a cross-origin status (MDN). That is
why the test sends `HEAD` first (no body) and aborts every response body immediately – and why the
network panel stays authoritative.

## Result sheet (fill in and send back)

### Matrix (one row per client)

| Client | clientVersion | `visitorDataSent` / `visitorDataReturned` | HTTP | playabilityStatus | Audio withUrl | Audio withSignatureCipher | Audio withNeither | Audio itags | hlsManifestUrl | serverAbrStreamingUrl | `playbackSilent.verdict` | `autoplayBlocked` | `confirmation` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  |  |  |  |
|  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Promotion and confirmation

| Question | Answer |
|---|---|
| `winner.client` / `winner.itag` | |
| `winner.confirmed` (only `true` on real progress) | |
| `winner.confirmationPending` | |
| `winner.confirmedBy` (which observation confirmed it?) | |
| `playbackSilent.playRejection` (if any) | |

### Media checks (promoted client)

| Check | Result |
|---|---|
| HEAD status | |
| GET + `Range: bytes=0-1` | |
| GET (without range) | |
| Status in the network panel (authoritative) | |
| `<audio>` `readyState` / `duration` | |
| `<audio>` `error.code` | |
| `play()` result (`playOutcome`) / `playRejection` | |
| Autoplay block (`autoplayBlocked`) – `NotAllowedError`? | |
| `confirmed` (only `true` on progress) | |
| `crossorigin` setting of the test element (`mediaMode`) | |
| audible start (yes/no) | |
| pause works | |
| seeking +30 s works | |

### Hijack checks

| Check | Result |
|---|---|
| `verdict` after the source change | |
| `playback.advanced` / `deltaSeconds` | |
| `playback.{paused,autoplayBlocked,error}` | |
| `videoWidth` after the hijack | |
| `totalVideoFrames` after the hijack | |
| drift page clock vs. element clock (15 s) | |
| did the page replace the `src` itself? (`srcReassignedByPage`; `ownSrcWrites` = our own) | |
| `crossorigin` of the page element (`clock().pageMediaMode`) | |
| pause (bar + space bar) | |
| seek ±30 s + slider | |
| track change **observed** (`navLog`) | |
| track change **re-resolved** (`rehijack`: `ok`/`verdict`, `step`/`ok` per stage) | |
| `restore()` → `after.srcKind = blob`, position/video correct | |
| audible start after "return to the video" | |
| `reapplied.{paused,muted,volume}` matching | |

### Report text

```
(paste the output of AUDIO_PROBE.report() here - it is already redacted)
```

## Branches after the run

- **B1** at least one client delivers playable audio-only with `omit` → minimal MV3 prototype.
  "Playable" here means **`verdict = playing`** or a client promoted with `decodable-silent-blocked`
  whose playback was really confirmed in step 5 (`confirmed: true`).
- **B2** none of the three clients delivers a playable URL → **only this matrix failed**
  (these three client definitions, these versions, this network path, without a PO token).
  Other client types, versions, SABR/UMP or PO-token routes are **not** disproved by it.
  Decide together which route is investigated next.
- **B3** URLs exist but are not playable → the error class from the report decides:
  `play-rejected`/`media-error` (source refused or format/context unsupported) is something else than
  `blocked-autoplay` (autoplay policy) or `paused` (the page paused). Credentialed requests stay
  excluded unless explicitly decided otherwise.
- **B4** playback works but the page hangs its own source back → measure the frequency
  (`srcReassignedByPage` / `srcChangesByPage`) before evaluating.

## Provenance

The test code was rewritten from protocol facts; it contains no code from
`animeshkundu/youtube-audio` (GPL-3.0), `schdie/we_firefox_ytop_mv3` (GPL-3.0) or `yt-dlp`
(Unlicense). Background and quotations: `docs/research/audio-only-logged-in.md`.
