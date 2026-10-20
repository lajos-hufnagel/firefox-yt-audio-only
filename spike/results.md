# Measurement log: audio-only in a signed-in YouTube session

Log of the live runs for the console snippet (`spike/README.md`) and for the MV3 prototype
(`spike/mv3-audio-only/`). New runs are **appended below**, never overwritten.

Evidence classes: **[M]** measured in this session · **[M-N]** reported by the user, not re-checked by
the assistant · **[V]** verified in specification/source code · **[A]** assumption, explicitly not
measured · **[U]** open, must be measured.

---

## 2026-10-15 — run 1: VISIONOS, manual `rehijack`, ~35 s

Environment [M-N]: Firefox 158, a normal **signed-in** profile, the watch page of a public video;
tool `spike/console-probe.js` (v0.1.0-phase0), executed by the user.

### Sequence

- Resolution through the three clients → **VISIONOS** (client ID 101, version 1.02) delivers audio-only
  **with a direct URL**. Whether ANDROID_VR or IOS were usable in this session too was not reported.
- Takeover of the page `<video>` (`hijack()`), then a **manual** `rehijack()` (resolution +
  element probe + renewed takeover). The **automatic** path after an SPA track change was **not**
  checked in this run.

### Result [M-N]

| Measurement point | Value |
|---|---|
| Client | VISIONOS (ID 101, v1.02) |
| Audio data decoded | yes |
| Playhead advanced | yes, stable for about **35 s** |
| `clock().drift` (page clock − element clock) | **0** |
| `videoWidth` | **0** |
| `totalVideoFrames` | **0** |
| Source taken back by the page | **none** |

### Interpretation

- For VISIONOS in a signed-in session this **confirms** what the research note
  (`docs/research/audio-only-logged-in.md`, section 2, steps 1–3) carried only as [A]: a non-web
  client delivers an audio-only URL, that URL **really plays in the page's element**, the page's
  player clock keeps running in sync and the page does not take the source back.
  → **Branch B1** (section 12) is reached for VISIONOS.
- `videoWidth = 0` and `totalVideoFrames = 0` prove: **this element** decoded or rendered no video
  track. That fits [V] the audio-only format (itags without a video track) and is a
  **render proof, not a byte balance**.

### What this run does NOT show (open)

- **"No video bytes" is not proven.** What was measured were video *frames* at the element, not the
  bytes on the wire: no byte counter, no network capture, no
  `PerformanceResourceTiming` evaluation. About the video data actually transferred, this run says
  **nothing**. (Only the code path is video-free: the element gets exactly one URL of an
  audio-only itag – [V], but no measurement.)
- **No resource saving measured.** No CPU, memory, network or energy measurement.
  "Audio-only needs fewer resources than video" stays [A] and is not claimed here.
- **One run, one video, ~35 s, one client.** No statement about long playback, several videos,
  ad breaks, chapters, resuming at positions, age restrictions, live, or
  `music.youtube.com`.
- **User gesture**: playback ran after manual operation. Whether a **silent** start or a start
  without a gesture is allowed is [U].
- **No PO token**: no `serviceIntegrityDimensions.poToken` was sent. Whether the URL stays stable
  without a PO token in the long run (expiry, binding to session/IP) is [U];
  `expiresInSeconds` was not recorded in this run.
- **ANDROID_VR / IOS** were not reported as usable in this run.
- **Position**: the snippet's `hijack()` sets **no** start position – that is where the well-known
  bug "switching on starts at 0" comes from. The prototype fixes it (position takeover when
  switching on, see `spike/mv3-audio-only/README.md`).

### Reproduction

`spike/README.md`, run sheet: step 3 (sweep), step 5 (confirmation), steps 8–10
(hijack, clock/control), step 11b (`rehijack`), step 13 (`restore`).

### Next measurement points

1. Several videos and ≥ 5 min straight through; automatic track change (prototype).
2. **Byte balance**: compare the network panel volume per minute **with** and **without** the audio
   mode – only after that may "no video bytes" stand as [M].
3. **Resources**: Firefox task manager (CPU/memory) under the same condition, ≥ 5 min – only after
   that may saving be spoken of.
4. Autoplay: start without a user gesture, behavior after a tab switch/system suspend.
5. Client drift: VISIONOS version, ANDROID_VR, URL lifetime / `expiresInSeconds`.
6. Provoke error paths deliberately: age restriction, unavailable video, offline.


---

## 2026-10-16 — owner confirmation of 0.1.1 [M-N]

After the current-position/picture repair, the owner reported that everything works in real Firefox.
No per-step output or new CPU/network/RAM numbers were supplied with this confirmation. It applies to
0.1.1, before the 0.1.2 code/project review; it is not a live test of that later version. Automated
0.1.2 evidence is recorded separately in `docs/release/0.1.2.md`.
