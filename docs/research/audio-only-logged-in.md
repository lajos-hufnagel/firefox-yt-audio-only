> Historical research from 2026-10-15; source claims were checked on that date. Later observations are
> in `spike/results.md`, and the current release review is in `docs/release/0.1.2.md`. The preliminary
> status and open questions below describe the investigation at that time, not the current project state.

# Audio-only playback in a signed-in YouTube session — research note

Status: preliminary investigation before implementation, basis for a feasibility test.
Date: 2026-10-15. All third-party sources were re-checked on this date.
The test result was still pending when this note was written; the note contains no measurements of its
own. (The live run is recorded in `spike/results.md`, run 1.)

## 0. Evidence classes

- [V] verified in the source code or in the specification, quotation below, checked on 2026-10-15
- [R] reported by third parties (documented, not reproduced here)
- [A] assumption / conclusion, explicitly not measured
- [U] unknown, the test has to measure it (or it stays open)

## 1. Two axes that must stay separate

- **Client identity** = which InnerTube client the request claims to be
  (ANDROID_VR / VISIONOS / IOS / WEB). Decides format release and PO-token policy.
- **Account identity** = whether the HTTP request carries the browser's YouTube cookies
  (`credentials: 'omit' | 'same-origin' | 'include'`). Decides which account the request is
  attributed to.

`credentials: 'omit'` is **not** "signed out". The request still leaves a signed-in browser; chaining
through IP, TLS session, server-set `visitorData` and network-side session identifiers is possible.
`omit` is hygiene, not anonymity.
[V for the mechanics, the actual chaining is [A] and is not measured here.]

- **The credential axis applies to `fetch`, not to media elements.** A `credentials` option exists
  exclusively on `fetch`/`XHR`; `<audio>`/`<video>` are not `fetch`. What a media element sends along
  is decided by its own `crossorigin` setting – without the attribute, mode `no-cors` with credentials
  mode `include`, with `crossorigin`/`="anonymous"` mode `cors` with `same-origin`, with
  `="use-credentials"` mode `cors` with `include`. [V: documented behavior of fetch and element
  fetches.]

From that follow **three separate things** that must not be merged into one statement:
(1) the test's resolution `fetch` calls with `omit`,
(2) the loading of the media URL by the test element, whose credential mode the test does **not set but
only records** (and does not measure),
(3) playback through the page `<video>` with the `crossorigin` setting that YouTube itself chose.
A blanket statement such as "all media requests use `omit`" would simply be false for (2) and (3).

## 2. The mechanism

[A] Playback takeover without request interception:

1. page-context `POST /youtubei/v1/player` with a non-web client → `streamingData.adaptiveFormats[]`
   with direct `url` values for audio-only itags;
2. assign that URL to the page's `<video>` element (`video.src = url`);
3. the audio-only itag has no video track → `videoWidth` stays 0;
4. the page's player clock keeps running, because it is the same element;
5. return to the video through `#movie_player.loadVideoById({videoId, startSeconds})`.

Steps 1–5 were reported by the reference project [R]. This environment cannot reproduce a signed-in
session; [A] stays [A] until the test runs.

## 3. The sign-in status

- The reference project's statement "signed out only" is **policy, not measurement** [V via its own
  documentation]: the `omit` vs. `same-origin` comparison ran in a signed-out profile, so both arms
  sent no cookies at all – the test could not tell the two account states apart.
- Counter-example: `schdie/we_firefox_ytop_mv3` (MV3, listed on AMO and in the Chrome Store, last push
  2026-09-10) resolves VISIONOS streams with `credentials: 'include'` (`js/yt.js:138-141`) and plays
  them through the same `<video>.src` takeover [V, code read on 2026-10-15].

## 4. What third-party code proves — and what it does not

A code path that was read proves **only** that this project takes that route. It does **not** prove
that the route still works on the day of the check. Concretely:

- A `credentials: 'include'` call in the source code proves no current playback success.
- The reference project's last dated live evidence is 2026-08-01 [R] – that is **before** the change of
  2026-08-17 – and its canary is only designed, not executed.
- Conversely, a 403 in our tests does not prove that another client, another client version, a PO-token
  route or another fetch style fails as well.

## 5. Server-side limits (the real risk)

yt-dlp is the best maintained public source for InnerTube behavior (Unlicense).

Verbatim from `yt_dlp/extractor/youtube/_base.py:226-229`, comment above `'android_vr'`:

```
# "Made for kids" videos aren't available with this client
# Using a clientVersion>1.65 may return SABR streams only
# Since 2026.07, intermittent/selective POT enforcement has been observed for non-HLS formats
# Since 2026.08.17, ALL formats (including live HLS and itag 18) are 403'd with version 1.65.10
```

- `_base.py:245-261` GVS PO-token policy for `android_vr`: HTTPS `required=True`,
  DASH `required=True`, HLS `required=False`.
- `_base.py:279-291` `ios` (ID 5): HTTPS `required=True`, HLS `required=True`.
- `_base.py:296-310` `visionos` (ID 101): **no** `GVS_PO_TOKEN_POLICY` declared;
  `build_innertube_clients()` (`_base.py:432-443`) then fills every protocol with
  `GvsPoTokenPolicy()` → `required=False`. In addition `REQUIRE_JS_PLAYER: False`.
  → Of the three planned clients, VISIONOS is the only one that yt-dlp currently models as
  not requiring a POT.
- `_base.py:441` `ytcfg.setdefault('SUPPORTS_COOKIES', False)` and `_video.py:3013-3018`
  ("Skipping client … since it does not support cookies"): yt-dlp skips `android_vr`,
  `visionos` and `ios` as soon as it is authenticated. That is a **yt-dlp CLI limitation**,
  not a statement about what YouTube accepts.

## 6. Protocol facts the test reproduces (all [V], quoted)

- Endpoint: `POST https://www.youtube.com/youtubei/v1/player?prettyPrint=false` (`_base.py:857-865`).
  The query parameter `key` is sent **only** when it is configured; `_extract_response`
  (`_base.py:1312-1316`) passes none → **no API key needed today**.
- Headers (`_base.py:975-994`): `X-YouTube-Client-Name: <id>`, `X-YouTube-Client-Version: <ver>`,
  `Origin`, `X-Goog-Visitor-Id`, `User-Agent`, `content-type: application/json`.
  In the page context, `User-Agent`/`Origin` are forbidden headers; the JSON fields
  `context.client.userAgent`/`hl`/`timeZone` can still be set.
- Body (`_video.py:2956-2967`, `2687-2712`, `_base.py:752-758`):
  `{ context:{ client:{ clientName, clientVersion, deviceMake, deviceModel, osName, osVersion,
  androidSdkVersion, userAgent, hl, timeZone, utcOffsetMinutes, visitorData? } }, videoId,
  playbackContext:{ contentPlaybackContext:{ html5Preference:'HTML5_PREF_WANTS' } },
  contentCheckOk:true, racyCheckOk:true }`. `serviceIntegrityDimensions.poToken` is **not**
  sent – precisely that is the subject of the test.
- Client values of the test: `android_vr` (ID 28, 1.65.10), `visionos` (ID 101, 1.02),
  `ios` (ID 5, yt-dlp 21.26.4 / ytop 21.02.3 – version drift is recorded in the report).
- `visitorData`: ytop repeats once without cookies using the `visitorData` from the first
  `responseContext` (`js/yt.js:177-181`). The test does the same and keeps the value **in memory only**.

## 7. CORS and the media element (important for interpreting errors)

[V] Playback through `<video>`/`<audio>` **without** the `crossorigin` attribute is not subject to a
CORS read restriction: the browser may play foreign media; CORS is only needed for *reading it out*
(content via canvas/WebAudio, headers). From that follows:

- A failed `fetch()` against a `googlevideo.com` URL does **not** mean that the URL cannot be played.
- `PerformanceResourceTiming.responseStatus` is `0` when the CORS check fails, and needs
  `Access-Control-Allow-Origin` for a cross-origin status (MDN) → `fetch()` cannot tell "CORS" apart
  from "403". That is why the `fetch` route is only supporting evidence in the test; the **decisive
  part is the media element** (`readyState`, `play()`, `currentTime`), and the HTTP truth is read by
  the user in the network panel.

[V] `crossorigin` is the element's only control: if it is missing, the media fetch runs in mode
`no-cors` with credentials mode `include` (cookies for that host would be sent along if any exist) and
without CORS read access; `crossorigin=""`/`"anonymous"` forces `cors` with `same-origin`,
`"use-credentials"` `cors` with `include`. The test **sets none of these attributes**; it only logs the
current state (`mediaMode` fields, `env().pageMediaElementMode`, `clock().pageMediaMode`); it reads no
cookie values and cannot say anything about the request the element actually sends.

## 8. Measurement criterion

Success does **not** mean "the answer contains a direct audio URL", but: the media element has decoded
audio tracks (`canplay`, `readyState >= 2`) **and** the playhead moves (`play()` + `currentTime > 0`).
Only that decides the promotion of a client.

What is checked is the **highest** offered audio bitrate (on a tie, the largest file) – so there is no
silent quality fallback downwards. A different itag has to be passed explicitly.

Two clarifications that are enforced in the test:

- **Only `NotAllowedError` is an autoplay block.** If `play()` refuses with another error
  (`NotSupportedError`, `AbortError`, …), that is its own error class (`play-rejected`) and **not** a
  promotion – "the data did decode" is not a success.
- **Unconfirmed stays unconfirmed.** If the data decodes and only the policy refuses the silent
  `play()`, the client is promoted, but with `confirmed: false` / `confirmationPending: true`. It is
  confirmed exclusively by observed progress (`timeupdate` on a non-paused element, or a hijack check
  with an advancing playhead). After a source change the same applies to `rehijack()`: `ok: true` only
  if the playhead really advanced; errors, pause and autoplay block are reported separately
  (`blocked`, `paused`, `error`, `verdict`).

## 9. What this note does not claim

- no measured statement about the CORS behavior of `googlevideo.com` (see section 7)
- no measured statement about **what the media element actually sends**: what is logged is only its
  `crossorigin` setting, not the request (no cookie reading, no `webRequest`/StreamFilter)
- no byte balance (no `webRequest`/StreamFilter in phase 0); "no video bytes" is argued only through
  proxies: `videoWidth === 0`, `getVideoPlaybackQuality().totalVideoFrames === 0`,
  no new media requests in the network panel
- no statement about `music.youtube.com`, Premium, memberships, age restrictions, live
- **no statement "audio-only does not work" if the three tested clients fail.** In that case only this
  matrix failed first (these three client definitions, these versions, this network path, this client
  fetch style without a PO token). Other client families, other client versions, SABR/UMP, PO-token
  routes or authentication variants are **not** disproved by it; they are simply not part of this
  phase.

## 10. License and provenance hygiene

- `animeshkundu/youtube-audio`: GPL-3.0 (GitHub API, 2026-10-15) — read as a design reference only,
  **no code taken over**.
- `schdie/we_firefox_ytop_mv3`: GPL-3.0 (GitHub API, 2026-10-15) — read for the VISIONOS request shape
  and as a signed-in counter-example, **no code taken over**; if code from it were taken over later,
  this project would have to be GPL-3.0-compatible.
- `yt-dlp/yt-dlp`: Unlicense — protocol facts and verbatim comment quotations.
- The test code contains no third-party code.

## 11. Open questions for the test

1. Does one of the three clients deliver a direct, actually playable audio URL on a **signed-in** page
   when only the **resolution** runs as `fetch` with `omit` (playback itself runs through a media
   element whose credential behavior the test does not control)?
2. If not: which error class does the failure belong to (HTTP status, `playabilityStatus`,
   media element error, CORS, network)?
3. Does the page's player clock stay in sync during the takeover, do pause and seek work?
4. Does the takeover survive an SPA track change, and does `loadVideoById` restore the video?

## 12. Decision rule after the test

- **B1** at least one client delivers audio-only that is decodable and audibly playable (resolution via
  `fetch` with `omit`), i.e. `verdict = playing` **or** a playback really confirmed in step 5
  (`confirmed: true`) → minimal MV3 prototype as the next step.
- **B2** none of the three clients delivers a playable URL → **only this matrix failed**; decide
  whether client definitions/version drift are investigated, whether another client type is checked, or
  whether the goal is reassessed. No silent switch to HLS or lower video quality.
- **B3** URLs exist but are not playable → the error class from the report decides
  (`play-rejected`/`media-error` = source or format refused; `blocked-autoplay` = policy;
  `paused` = the page paused; `no-progress` = accepted but standing). Credentialed requests stay
  excluded unless explicitly decided otherwise.
- **B4** playback works but the page hangs its own source back → measure the frequency before
  evaluating.
