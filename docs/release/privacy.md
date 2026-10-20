# Privacy description

Date: 2026-10-16. Applies to `Audio-only for YouTube` 0.1.3, Gecko id
`audio-only-prototype@local.invalid`, as shipped in `extension/` (see the source and offline checks in this repository).

This describes the data flow of the submitted add-on. Version 0.1.3 was signed for self-distribution
and installed on 2026-10-16; there is no public AMO listing. This file can also serve as the source
for a future listing's privacy text. Signed installation packages are not included in this repository.

## One sentence

The add-on asks YouTube, from the page the user already has open, for the audio-only stream of the video
being watched and hands that stream to the page's own player. It reads no cookies, stores no extension state persistently, contacts only YouTube/Googlevideo and has no telemetry.

## What leaves the browser, and where to

The resolver uses one endpoint. A resolution tries up to three clients and at most one extra
request with server-returned visitorData: at most four POSTs. Track changes and retries start another
bounded resolution. The whole sweep is aborted after 30 seconds.

| | |
|---|---|
| Where | `https://www.youtube.com/youtubei/v1/player?prettyPrint=false` (same origin as the page, `mode: 'same-origin'`) |
| Method | `POST`, JSON body |
| Credentials | `credentials: 'omit'` - set in the code, so no cookie and no account session of the user is attached to this request |
| Body | the video id of the page the user is watching (`videoId`), plus a fixed client description (`clientName`, `clientVersion`, `deviceMake`, `deviceModel`, `osName`, `osVersion`, `userAgent`), two protocol flags (`contentCheckOk`, `racyCheckOk`), `playbackContext`, and optional server-returned `visitorData` |
| Headers | `Content-Type: application/json`, `X-YouTube-Client-Name`, `X-YouTube-Client-Version` |
| Why | to obtain a playable audio-only format URL (an audio codec without a video stream) from the service that is already serving the page |
| Receiver | YouTube (the same site the page belongs to). No other server, no proxy, no analytics endpoint, no crash reporter |

The client description is **hard-coded in the file** - it describes a device family, not the user's
device, and none of the values is read from the browser, the profile or the system.

## The one identifier that can be carried: `visitorData`

`visitorData` is a value YouTube itself puts into the answer of that same request
(`responseContext.visitorData`). The add-on's rules for it:

1. It is taken **only** from YouTube's own answer to that POST.
2. It is **never** read from a cookie, from an account, from storage or from the page, and it is
   **never** invented.
3. If the first answer carried no usable audio URL, the **same** request is repeated **exactly once**,
   to the **same** endpoint, with that value attached. There is no loop and no other destination.
4. It is kept in the content script's closure for the lifetime of the page - **memory only**.
   Later resolutions in that document can send the remembered value on their first request;
   the one-extra-attempt limit applies separately to each resolution.
5. It is **never** logged, never displayed, never exported, never persisted and never part of a report.
   The status object that the panel and the toolbar button can see carries booleans and provenance text
   only (`sent`, `repeats`, `source`, `valueRecorded: false`), never the value. This is asserted on the
   built file by `tools/smoke-release.js` check r7.

## The media download

The resolved URL points at `*.googlevideo.com` (host and parameter **names** are recorded; the signed
URL text itself is redacted everywhere and never logged). The URL is handed to the page's **own**
`<video>` element, which then downloads the media directly from Googlevideo. The add-on does not proxy,
read, re-upload or persist media; Firefox manages its own media buffering and cache, and it has no host permission for `googlevideo.com` - it does not
need one, because the element performs that request itself.

## Fetch credentials are not media-element credentials

The two are different and this document does not blur them:

- **`fetch()`** - the InnerTube POST above runs with `credentials: 'omit'` and `mode: 'same-origin'`.
  No cookies, no account session, and no cross-origin read.
- **The media element** - the page's `<video>` is not a `fetch()`. On `youtube.com` it has no
  `crossorigin` attribute, so the browser runs its media request in `no-cors` mode with credentials mode
  `include`: cookies for the media host would be attached **if any exist**. The add-on neither reads nor
  changes this setting; it is the same behavior the page has without the add-on. The panel shows it
  verbatim in the `Media mode` row (`no-cors / credentials include (unchanged)`), and the code records it
  through `mediaMode()` instead of assuming the fetch setting applies.

## What the add-on never does

- No `cookies` permission in the manifest, no `document.cookie` read, no token read.
- No `storage` permission and no storage API use: no extension state is written through storage APIs or
  `localStorage`; state dies with the page. Firefox can independently cache network/media resources.
- No telemetry, no analytics, no error reporting, no remote configuration, no update check of its own.
- No access to any site other than `https://www.youtube.com/*` (`host_permissions` and the content script
  match pattern are both exactly that).
- No request to another origin from the content script (`mode: 'same-origin'` makes that structural, not
  a promise).
- No reading of other tabs, history, bookmarks, downloads or the clipboard.

## What the user sees

- The panel's `Privacy` row states the resolver endpoint, `credentials omit`, and whether `visitorData` was
  used, in the same words as above.
- The panel's `Not proven` row states that "no video bytes" and resource savings were not measured and
  are not claimed.
- Firefox itself asks for consent on install (see the data collection document) because the manifest
  declares `websiteContent` as required.

## What is still missing before this can be a listed add-on

1. **Public privacy presentation.** The unlisted workflow did not request a public privacy URL.
   A future public listing must provide its privacy disclosure in the form Mozilla then requests.
   The source ZIP already contains the privacy text; reviewer notes summarize it.
2. **The listing's privacy fields.** They must agree with the manifest: websiteContent required,
   nothing optional. No public listing has been created.
3. **Rights already selected:** Lajos Hufnagel; All Rights Reserved. See LICENSE and the provenance document.
4. **Owner review for a future public listing.** The owner authorized the completed unlisted submission;
   publishing a public listing or hosting the privacy text is a separate step.
