# Manual Firefox regression plan

Current target: **Audio-only for YouTube 0.1.3**, built `extension/` directory.
Firefox desktop 140+, public normal watch page, signed-in profile allowed. Do not log out or change
profile settings for this check. The UI must stay English.

## Evidence already available

- The owner reported 0.1.1 working on 2026-10-16 after the current-position/picture repair.
  No per-step log was supplied; do not expand that confirmation into a compatibility matrix.
- The historical 0.1.0 temporary-install bench passed 11/11 in Firefox 158. That is manifest-loading
  evidence for that version, not an automated YouTube run.
- The owner confirmed 0.1.2 working, but reported a short stutter at every new title.
- 0.1.3 has offline prototype/release and tooling checks; see the source and offline checks in this repository.
  **The owner subsequently confirmed 0.1.3 fixed.** This is a general user report rather than
  a captured per-step checklist. The steps below remain the regression procedure for later changes.

## Preparation

Build once with `node tools/build-extension.js`. In `about:debugging#/runtime/this-firefox`, reload
the temporary add-on (or load `extension/manifest.json`), then reload the YouTube tab. Confirm
`Audio-only for YouTube 0.1.3` in the panel after the first button press. A reload is needed to
replace the old content-script instance. Do not select a ZIP for the temporary load.

The optional `node tools/verify-temporary-load.js` uses a headless throwaway profile. It is separate,
can take minutes for the debugger handshake, opens no YouTube page and is not needed for every edit.
Do not start multiple browser benches together.

## Checklist

| Step | Expected |
|---|---|
| Play a public video and enable audio-only near 60 seconds | Picture hides while resolving, position stays near 60 s, audio continues; final badge ON after verified progress |
| Enable while paused | Position is kept; playback remains paused; the mode is active but unverified, not falsely playing |
| Resume that paused audio stream | After real progress the badge becomes ON |
| Seek forwards, then back to an earlier time | Playback follows the user, no false buffering warning caused solely by the backward seek |
| Change volume/mute, disable while playing | Video is visible and resumes at the current audio position with current volume/mute |
| Enable again, seek and pause, then disable | Video stays paused at that position; it does not restart at zero |
| Enable again, change tracks twice; compare the short interruption at each transition | The new track gets its own audio URL; no old-track replay; badge returns from resolving to the final state |
| Disable and change tracks immediately, or click off twice quickly | The old hand-back does not seek/start the new track or re-enable audio-only |
| Press Try again while active | A fresh resolution runs and keeps the current position, not an old player-clock position |
| Press Hide | Panel stays closed until a new explicit show/toggle action |
| Use toolbar on a non-YouTube tab or a tab loaded before add-on installation | No unhandled exception; no content-script receiver is handled quietly |

`restoring` is the short intermediate state while the page rebuilds normal video. A second off request
shares that hand-back. An enable/retry request during it is skipped; try again after it completes.
A failed restore remains visibly `restore-failed`, with the reason and a way to reload normally.

## Measurements, if repeated

Compare the same title, positions, duration and cache conditions. Record bytes and process CPU/memory
rather than deriving a percentage from unlike runs. The old network observations (39.08 MB with video,
20.58 MB audio-only) include prefetch/switching; the owner reported roughly half system CPU load.
Neither is a controlled Firefox-process benchmark or proof of zero video bytes.

## Record

```text
Date / Firefox version / machine:
Add-on version: 0.1.3 / audio-only-prototype@local.invalid
Video id / duration:
Steps passed:
Failures / panel Copy log:
Badge after track change:
```

Use the panel's **Copy log**. Do not share raw signed media URLs, unredacted HAR files or visitor
identifiers. This check does not test signing, Android, Premium, age gates, live streams or
music.youtube.com, and does not predict later YouTube changes.
